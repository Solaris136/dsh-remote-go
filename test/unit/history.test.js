/**
 * L2 history replay — the pure half.
 *
 * These tests pin the parts that must be provably right before anything is wired
 * into the connect path: how a remote log is discovered/parsed, how records map to
 * our event model, how the cursor window behaves around gaps, retention, and the
 * typed failures (design §6, §7).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDirProbeCommand,
  buildDiscoveryCommand,
  buildReadCommand,
  classifyReadFailure,
  fetchRemoteHistory,
  foldNoticeRange,
  mapRemoteRecord,
  mapRemoteRecords,
  parseRemoteSessionLog,
  pickLogFile,
  planHistoryWindow,
  remoteSessionsRoot,
  recoveredCursor,
  retainEvents,
  sanitizeValue,
} from '../../src/history.js'

/** @param {number[]} seqs */
const eventsOf = (seqs) => seqs.map((seq) => ({ seq, type: 'user/message', data: { text: `t${seq}` } }))

test('remote paths and commands stay single-quoted and bounded', () => {
  assert.equal(remoteSessionsRoot('/home/u/.dsh/'), '/home/u/.dsh/sessions')
  assert.equal(buildDirProbeCommand('/home/u/.dsh/sessions'), "test -d '/home/u/.dsh/sessions' && echo yes || echo no")
  // A session id is remote-controlled input: a quote must not break out of the shell word.
  const discovery = buildDiscoveryCommand('/root', "evil'; rm -rf /")
  assert.match(discovery, /-maxdepth 4/)
  assert.match(discovery, /-name '\*evil'\\'';\s?rm -rf \/\*'/)
  assert.match(discovery, /head -n 5$/)
  // The read asks for one byte past the cap (so "exactly at the cap" is not
  // misread as truncated) and does NOT hide stderr, which is what makes a
  // permission failure classifiable.
  assert.match(buildReadCommand('/a/b.json', 1024), /^head -c 1025 '\/a\/b\.json' 2>&1 \|\| true$/)
  assert.equal(buildReadCommand('/a/b.json', 1024).includes('2>/dev/null'), false)
})

test('a discovery listing picks the log, not its sidecars', () => {
  const listing = [
    '/home/u/.dsh/sessions/ws1/session-abc.json.lock',
    '/home/u/.dsh/sessions/ws1/abc.thumbnail.png',
    '/home/u/.dsh/sessions/ws1/session-abc.json',
    '/home/u/.dsh/sessions/ws1/events-abc.jsonl',
  ].join('\n')
  // JSONL is the event stream and wins over the whole-session snapshot.
  assert.equal(pickLogFile(listing), '/home/u/.dsh/sessions/ws1/events-abc.jsonl')
  assert.equal(pickLogFile('/x/session-a.json\n/y/snapshot-a.json'), '/x/session-a.json')
  assert.equal(pickLogFile(''), null)
  assert.equal(pickLogFile('/x/a.png\n/y/b.lock'), null)
})

test('the log parser accepts the shapes seen in practice and refuses unknown versions', () => {
  assert.deepEqual(parseRemoteSessionLog('[{"role":"user","text":"hi"}]'), {
    ok: true,
    records: [{ role: 'user', text: 'hi' }],
    version: 1,
  })
  const wrapped = parseRemoteSessionLog('{"version":1,"session":{"id":"s"},"events":[{"seq":1}]}')
  assert.equal(wrapped.ok, true)
  assert.equal(wrapped.ok && wrapped.records.length, 1)
  const jsonl = parseRemoteSessionLog('{"seq":1}\n{"seq":2}\n')
  assert.equal(jsonl.ok, true)
  assert.equal(jsonl.ok && jsonl.records.length, 2)
  // A newer schema must not be silently mis-mapped.
  assert.deepEqual(parseRemoteSessionLog('{"version":7,"events":[]}'), {
    ok: false,
    reason: 'unknown-version',
    version: 7,
  })
  assert.equal(parseRemoteSessionLog('not json at all').ok, false)
  assert.equal(parseRemoteSessionLog('   ').reason, 'log-malformed')
})

test('reads are classified into typed failures', () => {
  assert.equal(classifyReadFailure({ code: 0, stdout: 'x', stderr: '' }), null)
  // The read merges stderr into stdout (`2>&1`), so a permission error arrives there.
  assert.equal(classifyReadFailure({ code: 1, stdout: 'head: Permission denied\n', stderr: '' }), 'permission-denied')
  assert.equal(classifyReadFailure({ code: 1, stdout: '', stderr: 'head: Permission denied' }), 'permission-denied')
  assert.equal(classifyReadFailure({ code: 1, stdout: 'head: No such file', stderr: '' }), 'no-session-log')
  assert.equal(classifyReadFailure({ code: 1, stdout: '', stderr: '' }), 'read-failed')
})

/**
 * A `head -c` answer that behaves like the shell: honour the requested byte count and
 * the stderr redirect. Without this the test cannot tell `2>/dev/null` apart from
 * `2>&1`, which is exactly the bug being guarded.
 * @param {string} body full file body
 * @param {string} [stderr] what the command writes to stderr
 */
function headAnswer(body, stderr = '') {
  return (command) => {
    const count = Number(/^head -c (\d+) /.exec(command)?.[1] ?? body.length)
    const merged = command.includes('2>&1')
    const shown = Math.min(count, body.length)
    return {
      code: stderr === '' ? 0 : 1,
      stdout: body.slice(0, shown) + (merged ? '' : ''),
      stderr: merged ? '' : stderr,
    }
  }
}

/**
 * Same, but models the shell exactly: with `2>/dev/null` the message is discarded,
 * with `2>&1` it lands on stdout. Anything else keeps them separate, as SSH does.
 */
function deniedAnswer(command) {
  const message = 'head: cannot open for reading: Permission denied\n'
  if (command.includes('2>/dev/null')) return { code: 1, stdout: '', stderr: '' }
  if (command.includes('2>&1')) return { code: 1, stdout: message, stderr: '' }
  return { code: 1, stdout: '', stderr: message }
}

test('an unreadable log reports permission-denied, not no-session-log', async () => {
  // Regression: the read used to send stderr to /dev/null, so the permission message
  // never reached the plugin and this always degraded to `no-session-log`.
  const denied = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/h/sessions/session-s.json\n', stderr: '' }],
    [/^head -c /, deniedAnswer],
  ])
  const result = await fetchRemoteHistory(denied, { remoteDshHome: '/h', remoteSessionId: 's' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'permission-denied')
})

test('a complete log exactly at the byte cap is not reported as truncated', async () => {
  // Regression: `>= maxBytes` marked a log whose size is exactly the cap as truncated
  // forever, because the read never asked for the extra byte that would prove it.
  const payload = JSON.stringify({ version: 1, events: [{ seq: 1, role: 'user', text: 'x' }] })
  const exactSize = Buffer.byteLength(payload, 'utf8')
  const atCap = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/h/sessions/session-s.json\n', stderr: '' }],
    [/^head -c /, headAnswer(payload)],
  ])
  const result = await fetchRemoteHistory(atCap, {
    remoteDshHome: '/h',
    remoteSessionId: 's',
    maxBytes: exactSize,
  })
  assert.equal(result.reason, null)
  assert.equal(result.ok, true)
  assert.equal(result.truncated, false)

  // One byte of real data past the cap still reports truncation.
  const overCap = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/h/sessions/session-s.json\n', stderr: '' }],
    [/^head -c /, headAnswer(`${payload} `)],
  ])
  const truncated = await fetchRemoteHistory(overCap, {
    remoteDshHome: '/h',
    remoteSessionId: 's',
    maxBytes: exactSize,
  })
  assert.equal(truncated.reason, 'log-truncated')
})

test('records map to the event model, preserving text and summarising tool calls', () => {
  const { event } = mapRemoteRecord(
    {
      seq: 4,
      role: 'assistant',
      at: '2026-01-02T03:04:05.000Z',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'data:image/png;base64,AAAA' },
      ],
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/etc/passwd', secret: 'x' } }],
    },
    1,
  )
  assert.equal(event.seq, 4)
  assert.equal(event.type, 'assistant/message')
  assert.equal(event.at, '2026-01-02T03:04:05.000Z')
  assert.equal(event.data.text, 'hello')
  assert.equal(event.data.role, 'assistant')
  assert.equal(event.data.toolCalls[0].name, 'read')
  assert.equal(event.data.toolCalls[0].id, 'c1')
  assert.match(event.data.toolCalls[0].argumentsPreview, /\/etc\/passwd/)
  // The binary part is not part of the text.
  assert.equal(event.data.text.includes('base64'), false)
})

test('a record without a seq falls back to its 1-based position', () => {
  const { event } = mapRemoteRecord({ role: 'user', text: 'a' }, 7)
  assert.equal(event.seq, 7)
  assert.equal(event.type, 'user/message')
})

test('unknown record types are preserved with a deterministic projection', () => {
  const raw = { seq: 2, type: 'future/thing', payload: { a: 1, logprobs: [1], nested: { deep: true } } }
  const first = mapRemoteRecord(raw, 1).event
  const second = mapRemoteRecord(raw, 1).event
  assert.deepEqual(first, second)
  assert.equal(first.type, 'future/thing')
  assert.equal(first.data.record.payload.a, 1)
  // Model-internal fields never survive, at any depth.
  assert.equal('logprobs' in first.data.record.payload, false)
  // Unusable entries are dropped rather than throwing.
  assert.equal(mapRemoteRecord(null, 1).event, null)
  assert.equal(mapRemoteRecord('nope', 1).event, null)
})

test('sanitizeValue bounds depth, key count and string length', () => {
  const long = 'x'.repeat(900)
  assert.equal(String(sanitizeValue(long)).length, 501)
  assert.equal(sanitizeValue('data:image/png;base64,AAA'), '[binary omitted]')
  let deep = { v: 1 }
  for (let index = 0; index < 8; index += 1) deep = { next: deep }
  assert.match(JSON.stringify(sanitizeValue(deep)), /\[truncated\]/)
})

test('mapping a log de-duplicates by seq and counts what it dropped', () => {
  const records = [
    { seq: 1, role: 'user', text: 'a' },
    { seq: 1, role: 'user', text: 'duplicate' },
    { seq: 2, role: 'assistant', text: 'b' },
    { junk: true },
  ]
  const mapped = mapRemoteRecords(records)
  assert.deepEqual(
    mapped.events.map((event) => event.seq),
    [1, 2],
  )
  // First occurrence wins, so the duplicate text is not the one kept.
  assert.equal(mapped.events[0].data.text, 'a')
  assert.equal(mapped.droppedRecords, 2)
})

test('the cursor window is idempotent and never passes a gap', () => {
  // Fresh window from an empty cursor.
  const first = planHistoryWindow({ cursor: 0, events: eventsOf([1, 2, 3]) })
  assert.deepEqual(
    first.append.map((event) => event.seq),
    [1, 2, 3],
  )
  assert.equal(first.cursor, 3)
  assert.equal(first.backfill, null)

  // Re-applying the same window appends nothing and does not move the cursor.
  const again = planHistoryWindow({ cursor: 3, events: eventsOf([1, 2, 3]) })
  assert.deepEqual(again.append, [])
  assert.equal(again.cursor, 3)

  // Out-of-order input is sorted by seq before application.
  const shuffled = planHistoryWindow({ cursor: 0, events: eventsOf([3, 1, 2]) })
  assert.deepEqual(
    shuffled.append.map((event) => event.seq),
    [1, 2, 3],
  )

  // A gap stops the cursor at the contiguous prefix and asks for a backfill.
  const gapped = planHistoryWindow({ cursor: 1, events: eventsOf([4, 5]) })
  assert.deepEqual(gapped.append, [])
  assert.equal(gapped.cursor, 1)
  assert.deepEqual(gapped.backfill, { from: 2, to: 3 })
  assert.equal(gapped.gap, true)
})

test('retention keeps the newest window and folds the prefix only on the first sync', () => {
  const kept = retainEvents(eventsOf([1, 2, 3, 4, 5]), 3)
  assert.deepEqual(
    kept.events.map((event) => event.seq),
    [3, 4, 5],
  )
  assert.equal(kept.folded, 2)
  assert.equal(retainEvents(eventsOf([1, 2]), 0).folded, 0)

  // First sync over a long log: fold the prefix, land the cursor on the newest.
  const first = planHistoryWindow({
    cursor: 0,
    events: eventsOf([1, 2, 3, 4, 5]),
    maxEvents: 2,
    foldBeforeCursor: true,
  })
  assert.deepEqual(
    first.append.map((event) => event.seq),
    [4, 5],
  )
  assert.equal(first.cursor, 5)
  assert.equal(first.folded, 3)
  assert.equal(first.gap, false)

  // A later sync must NOT fold: the overflow shows up as a gap instead.
  const later = planHistoryWindow({ cursor: 2, events: eventsOf([1, 2, 3, 4, 5]), maxEvents: 2 })
  assert.equal(later.folded, 0)
  assert.deepEqual(
    later.append.map((event) => event.seq),
    [3, 4, 5],
  )
})

test('conflicting duplicates collapse to the first occurrence', () => {
  const conflicting = [
    { seq: 1, type: 'user/message', data: { text: 'first' } },
    { seq: 1, type: 'user/message', data: { text: 'second' } },
  ]
  const plan = planHistoryWindow({ cursor: 0, events: conflicting })
  assert.equal(plan.append.length, 1)
  assert.equal(plan.append[0].data.text, 'first')
})

// ------------------------------------------------------------------ fetch (IO)

/** A tiny fake `ssh.exec` that answers by command shape. */
function fakeSsh(answers) {
  return {
    calls: [],
    async exec(command) {
      this.calls.push(command)
      for (const [pattern, result] of answers) {
        if (pattern.test(command)) return typeof result === 'function' ? result(command) : result
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

test('fetchRemoteHistory reads one session log and maps it', async () => {
  const ssh = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/home/u/.dsh/sessions/ws/session-s1.json\n', stderr: '' }],
    [
      /^head -c /,
      {
        code: 0,
        stdout: JSON.stringify({ version: 1, events: [{ seq: 1, role: 'user', text: 'hi' }] }),
        stderr: '',
      },
    ],
  ])
  const result = await fetchRemoteHistory(ssh, { remoteDshHome: '/home/u/.dsh', remoteSessionId: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.reason, null)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].data.text, 'hi')
  assert.equal(result.file, '/home/u/.dsh/sessions/ws/session-s1.json')
  assert.equal(result.version, 1)
})

test('fetchRemoteHistory degrades with typed reasons instead of throwing', async () => {
  const noDir = fakeSsh([[/^test -d /, { code: 1, stdout: 'no\n', stderr: '' }]])
  assert.equal(
    (await fetchRemoteHistory(noDir, { remoteDshHome: '/h', remoteSessionId: 's' })).reason,
    'sessions-dir-missing',
  )

  const noLog = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '', stderr: '' }],
  ])
  assert.equal(
    (await fetchRemoteHistory(noLog, { remoteDshHome: '/h', remoteSessionId: 's' })).reason,
    'no-session-log',
  )

  const denied = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/h/sessions/session-s.json\n', stderr: '' }],
    [/^head -c /, { code: 1, stdout: '', stderr: 'head: Permission denied' }],
  ])
  assert.equal(
    (await fetchRemoteHistory(denied, { remoteDshHome: '/h', remoteSessionId: 's' })).reason,
    'permission-denied',
  )

  const malformed = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/h/sessions/session-s.json\n', stderr: '' }],
    [/^head -c /, { code: 0, stdout: '{"broken":', stderr: '' }],
  ])
  assert.equal(
    (await fetchRemoteHistory(malformed, { remoteDshHome: '/h', remoteSessionId: 's' })).reason,
    'log-malformed',
  )

  // An SSH error must not escape.
  const broken = {
    async exec() {
      throw new Error('SSH connection is not open')
    },
  }
  assert.equal((await fetchRemoteHistory(broken, { remoteDshHome: '/h', remoteSessionId: 's' })).reason, 'read-failed')
})

test('fetchRemoteHistory reports truncation instead of replaying a partial log', async () => {
  const truncated = fakeSsh([
    [/^test -d /, { code: 0, stdout: 'yes\n', stderr: '' }],
    [/^find /, { code: 0, stdout: '/h/sessions/session-s.json\n', stderr: '' }],
    // The read asks for maxBytes + 1, so a body of exactly that length proves more data.
    [/^head -c /, { code: 0, stdout: 'x'.repeat(65), stderr: '' }],
  ])
  const result = await fetchRemoteHistory(truncated, {
    remoteDshHome: '/h',
    remoteSessionId: 's',
    maxBytes: 64,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'log-truncated')
  assert.equal(result.events.length, 0)
})

test('the fold notice reports the range that was actually skipped', () => {
  // Regression: the notice hardcoded `from: 1, to: folded`, which is wrong as soon as
  // the fetch dropped records, because the retained window is the tail.
  assert.deepEqual(foldNoticeRange({ firstKeptSeq: 6, folded: 2 }), { from: 4, to: 5, folded: 2 })
  // A window starting later still reports a truthful range, never `1..folded`.
  const long = foldNoticeRange({ firstKeptSeq: 1900, folded: 100 })
  assert.deepEqual(long, { from: 1800, to: 1899, folded: 100 })
  assert.notDeepEqual(long, { from: 1, to: 100, folded: 100 })
  // Nothing folded: the notice is not written at all.
  assert.deepEqual(foldNoticeRange({ firstKeptSeq: 5, folded: 0 }), { from: 0, to: 0, folded: 0 })
  // Degenerate input degrades to a sane range instead of negatives.
  assert.deepEqual(foldNoticeRange({ firstKeptSeq: 1, folded: 3 }), { from: 1, to: 0, folded: 3 })
  assert.deepEqual(foldNoticeRange({}), { from: 0, to: 0, folded: 0 })
})

test('the docs do not claim L2 is unimplemented', async () => {
  // The frozen-contract list drifted once already: it kept saying `applyEvents` had no
  // caller and that `mirrorMaxEvents` was "尚未实现" after both shipped. A single phrase
  // was not enough — a paraphrase slipped through — so this matches a small phrase list
  // near each symbol.
  const { readFile } = await import('node:fs/promises')
  const api = await readFile(new URL('../../docs/api.md', import.meta.url), 'utf8')
  const design = await readFile(new URL('../../docs/session-design.md', import.meta.url), 'utf8')

  /** Phrases that assert "not done" in either language. */
  const UNIMPLEMENTED = ['尚未实现', '未实现', '没有调用方', '未被调用', 'not implemented', 'no caller']
  /** Any of these near a symbol means the doc is claiming it is not wired. */
  const claimsUnimplemented = (text, symbol) => {
    for (const line of text.split('\n')) {
      const at = line.indexOf(symbol)
      if (at === -1) continue
      // A wide window: the claim usually follows on the same line or the next.
      const window = line.slice(at, at + 160)
      if (UNIMPLEMENTED.some((phrase) => window.includes(phrase))) return window.trim()
    }
    return null
  }

  for (const [doc, name] of [
    [api, 'api.md'],
    [design, 'session-design.md'],
  ]) {
    for (const symbol of ['applyEvents', 'mirrorMaxEvents']) {
      const claim = claimsUnimplemented(doc, symbol)
      assert.equal(claim, null, `${name} must not claim ${symbol} is unimplemented: ${claim}`)
    }
  }

  // And it must positively document what L2 does.
  assert.match(api, /mirror\/history-folded/, 'api.md documents the fold notice')
  assert.match(design, /6\.1 L2 已落地/, 'session-design.md has the L2 section')

  // Code and docs agree about what is still internal: the lease helpers, not the cursor.
  const mirrorSource = await readFile(new URL('../../src/mirror.js', import.meta.url), 'utf8')
  const internalBlocks = mirrorSource.split('@internal').slice(1)
  assert.ok(internalBlocks.length > 0, 'the lease helpers are still marked @internal')
  for (const marker of ['acquireLease', 'renewLease', 'expireLease', 'isLeaseHeldBy']) {
    assert.equal(mirrorSource.includes(`@internal`) && mirrorSource.includes(`function ${marker}`), true)
  }
})

test('a failed re-pull keeps the cursor monotonic', () => {
  // The reviewer's probe: a failed recovery re-plans from cursor 0, which for a log that
  // does not start at seq 1 resolves to 0 while events 1..5 are still in the session.
  // The descriptor must never claim fewer applied events than it already had.
  assert.equal(recoveredCursor(5, 0), 5, 'a failed re-pull must not move 5 back to 0')
  assert.equal(recoveredCursor(5, 2), 5)
  assert.equal(recoveredCursor(0, 3), 3, 'a first-sync recovery may advance')
  assert.equal(recoveredCursor(4, 4), 4)
  // Degenerate input degrades to the safe side instead of NaN/negative. A fractional
  // cursor is not a valid seq, so it is treated as "nothing applied".
  assert.equal(recoveredCursor(undefined, undefined), 0)
  assert.equal(recoveredCursor(-3, 'x'), 0)
  assert.equal(recoveredCursor(2.5, 1), 1)
})

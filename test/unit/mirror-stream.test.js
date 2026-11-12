import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FrameBuffer,
  logVisible,
  buildFollowCommand,
  ingestStreamEvents,
  nextOffset,
  parseFrame,
  remoteStreamScript,
  remoteStreamScriptSource,
  streamAllowed,
  streamGuard,
} from '../../src/mirror-stream.js'

// The polled follower (design §6.4). These pin the properties the retry depends on, in particular
// the asymmetric offset rule, whose violation is permanent data loss rather than a re-read.

test('parseFrame reads a frame and maps a remote refusal to the existing fenced reason', () => {
  const ok = parseFrame(JSON.stringify({ ok: true, offset: 42, bytes: 99, events: [{ seq: 1 }], truncated: false }))
  assert.equal(ok.ok, true)
  assert.equal(ok.offset, 42)
  assert.deepEqual(ok.events, [{ seq: 1 }])

  // A remote-side refusal reuses the plugin's existing vocabulary rather than inventing a second
  // set: `stale-epoch` is what the rest of the system calls `fenced`.
  const fenced = parseFrame(JSON.stringify({ ok: false, reason: 'stale-epoch', remoteEpoch: 7 }))
  assert.equal(fenced.ok, false)
  assert.equal(fenced.reason, 'fenced')
  assert.equal(fenced.remoteEpoch, 7)
})

test('parseFrame never throws on garbage, and does not invent a containing reason', () => {
  for (const bad of ['', 'not json', '{"ok":true}', '{"ok":true,"offset":-1}', '[]']) {
    const parsed = parseFrame(bad)
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} is not a frame`)
    assert.equal(typeof parsed.reason, 'string')
  }
})

test('the offset is monotonic: a re-delivered frame never moves it backwards', () => {
  assert.equal(nextOffset(0, 10), 10, 'forwards')
  assert.equal(nextOffset(10, 10), 10, 'idempotent')
  assert.equal(nextOffset(10, 4), 10, 'a stale frame cannot rewind it')
  assert.equal(nextOffset(-5, 2), 2, 'garbage in, sane out')
})

test('streamAllowed reuses the typed reasons instead of adding a parallel set', () => {
  assert.equal(streamAllowed({ writable: true, reason: null }).ok, true)
  assert.equal(streamAllowed({ writable: true, reason: { code: 'fenced' } }).ok, false)
  assert.equal(streamAllowed({ writable: true, reason: { code: 'fenced' } }).reason, 'fenced')
  assert.equal(streamAllowed({ writable: false, reason: null }).ok, false)
})

test('the start guard names the condition that fired instead of returning bare', () => {
  // The first attempt returned early with no reason, which is why "setting off" and "helper
  // missing" were indistinguishable in the field.
  const base = { runtime: { ssh: { connected: true } }, settings: { mirrorStream: true }, hasAdapter: true }
  assert.equal(streamGuard(base).ok, true)
  assert.equal(streamGuard({ ...base, settings: { mirrorStream: false } }).guard, 'setting-off')
  assert.equal(streamGuard({ ...base, settings: { mirrorStream: true, mirrorHistory: false } }).guard, 'history-off')
  assert.equal(streamGuard({ ...base, hasAdapter: false }).guard, 'no-session-adapter')
  assert.equal(streamGuard({ ...base, runtime: { ssh: { connected: false } } }).guard, 'ssh-down')
  assert.equal(streamGuard({ ...base, runtime: { ssh: { connected: true }, closing: true } }).guard, 'host-closing')
})

test('a slow consumer stays bounded and reports exactly what it dropped', () => {
  const buffer = new FrameBuffer(4)
  for (let index = 0; index < 100; index += 1) {
    buffer.push({ offset: index, events: [{ seq: index + 1 }] })
  }
  assert.equal(buffer.size, 4, 'the buffer never exceeds its cap')
  const drained = buffer.drain()
  assert.deepEqual(
    drained.frames.map((frame) => frame.offset),
    [96, 97, 98, 99],
    'the newest frames are kept — they are what a watcher is looking at',
  )
  assert.equal(drained.dropped, 96, 'every dropped frame is counted')
  assert.equal(drained.droppedEvents, 96, 'with the event mass it lost')
  assert.equal(buffer.size, 0, 'drain empties it')
  assert.equal(buffer.dropped, 0, 'and the counters reset with the frames')
})

test('ingestStreamEvents reuses the L2 pipeline, so streamed state equals log-read state', () => {
  const events = [1, 2, 3].map((seq) => ({
    seq,
    at: `2026-11-12T00:00:0${seq}Z`,
    type: 'message',
    data: { text: `m${seq}` },
  }))
  const fromZero = ingestStreamEvents({ cursor: 0 }, events)
  assert.equal(fromZero.cursor, 3, 'it advances to the last applied seq')
  assert.deepEqual(
    fromZero.append.map((event) => event.seq),
    [1, 2, 3],
  )

  // Re-delivering applied records is a no-op: this is what makes at-least-once delivery safe.
  const again = ingestStreamEvents({ cursor: 3 }, events)
  assert.deepEqual(again.append, [], 'already-applied records are not applied twice')
  assert.equal(again.cursor, 3)
})

test('the remote helper performs the epoch check and imports nothing but node:fs', () => {
  const source = remoteStreamScriptSource()
  assert.match(source, /stale-epoch/, 'the refusal happens on the far side of the boundary')
  const imports = source
    .split('\n')
    .filter((line) => line.startsWith('import '))
    .map((line) => line.match(/from ['"]([^'"]+)['"]/)?.[1])
  assert.deepEqual(imports, ['node:fs'], 'it must run on an unmodified remote')
  assert.equal(remoteStreamScript('/home/sim/.dsh'), '/home/sim/.dsh/remote-go/follow.mjs')
})

test('the follow command quotes its arguments so a path cannot break out', () => {
  const command = buildFollowCommand('/h/follow.mjs', {
    logPath: "/tmp/it's a log.jsonl",
    leasePath: '/h/lease.json',
    offset: 12,
    epoch: 3,
  })
  assert.match(command, /^node '/)
  // The single quote in the path must be escaped, not left to terminate the argument.
  const parts = command.split(' ')
  assert.equal(parts.length, 3, 'node, the script, and one base64 argument')
  // The arguments are base64-encoded, so a quote in the path never reaches the shell at all —
  // stronger than escaping, and the reason a hostile path cannot break out of the word.
  assert.equal(command.includes("it's"), false, 'no raw path text is interpolated')
  const payload = JSON.parse(Buffer.from(parts[2].replaceAll("'", ''), 'base64').toString('utf8'))
  assert.equal(payload.logPath, "/tmp/it's a log.jsonl", 'the path survives the round trip intact')
})

test('the poll trace is visible at the default level when a poll does not advance', async () => {
  // The lesson from two failed attempts (design §6.4): the first instrument was emitted at `debug`,
  // which the default `logLevel: info` filters out, so the failure was undiagnosable. These assert
  // the *visibility* rule directly rather than trusting that someone will enable debugging.
  assert.equal(logVisible('info', 'info'), true, 'the no-advance trace reaches a default logger')
  assert.equal(logVisible('debug', 'info'), false, 'healthy chatter stays quiet by default')
  assert.equal(logVisible('debug', 'debug'), true, 'an operator can raise verbosity')
  assert.equal(logVisible('warn', 'info'), true)
  assert.equal(logVisible('info', 'warn'), false)
})

test('every failure-case trace names the six fields and is emitted at info', async () => {
  // Structural, because the trace is built inline in the poll loop: assert the *shape* an operator
  // will read, and that the non-advancing branch is not left at debug again.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../src/service.js', import.meta.url), 'utf8')
  const fields = ['sessionId', 'offsetBefore', 'rawBytes', 'parsedEvents', 'planCursor', 'persistedCursor', 'guard']
  for (const field of fields) {
    assert.equal(source.includes(`${field}:`), true, `the trace must report ${field}`)
  }
  // The decisive branch — records parsed but the cursor did not move — must be info, not debug.
  assert.match(
    source,
    /advanced \? 'debug' : 'info'/,
    'a non-advancing poll must log at info so it is visible by default',
  )
  assert.match(source, /guard: \$\{advanced \? 'advanced' : 'no-advance'\}/, 'the trace names the outcome')
})

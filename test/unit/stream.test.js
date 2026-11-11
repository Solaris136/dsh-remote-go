import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FrameBuffer,
  STREAM_LIMITS,
  buildFollowCommand,
  buildInstallStreamScriptCommand,
  ingestStreamEvents,
  mergeFrames,
  nextStreamOffset,
  parseFollowFrame,
  remoteStreamScript,
  remoteStreamScriptSource,
  streamAllowed,
} from '../../src/stream.js'
import { planHistoryWindow } from '../../src/history.js'

/** Five well-formed remote records, in log order. */
function records() {
  return [1, 2, 3, 4, 5].map((seq) => ({
    seq,
    role: seq % 2 === 0 ? 'assistant' : 'user',
    text: `message ${seq}`,
    at: `2026-11-12T00:00:0${seq}Z`,
  }))
}

test('a streamed record and the same record from the log produce identical state', () => {
  // The whole point of reusing the pipeline: these two paths must not be able to diverge.
  const all = records()
  // Path A: L2 log read (the existing production path).
  const fromLog = planHistoryWindow({ cursor: 0, events: all, maxEvents: 0, foldBeforeCursor: false })
  // Path B: the same records arriving as stream frames.
  const frames = [
    { offset: 0, events: all.slice(0, 2) },
    { offset: 1, events: all.slice(2) },
  ]
  const fromStream = ingestStreamEvents({ cursor: 0 }, mergeFrames(frames))

  assert.deepEqual(
    fromStream.append.map((e) => e.seq),
    fromLog.append.map((e) => e.seq),
  )
  assert.equal(fromStream.cursor, fromLog.cursor)
  assert.equal(fromStream.applied, fromLog.applied)
  assert.equal(fromStream.gap, fromLog.gap)
  assert.equal(fromStream.conflicts.length, fromLog.conflicts.length)
})

test('duplicate and out-of-order frames collapse without duplication', () => {
  const all = records()
  // A retried poll re-sends an overlapping range, and one frame arrives out of order.
  const frames = [
    { offset: 0, events: all.slice(2, 5) },
    { offset: 0, events: all.slice(0, 3) },
    { offset: 0, events: all.slice(0, 3) },
  ]
  const plan = ingestStreamEvents({ cursor: 0 }, mergeFrames(frames))
  assert.deepEqual(
    plan.append.map((event) => event.seq),
    [1, 2, 3, 4, 5],
    'every seq exactly once, in order',
  )
  assert.equal(plan.cursor, 5)
  assert.equal(plan.gap, false)
})

test('a missing seq surfaces as the existing typed gap, not silence', () => {
  // seq 3 never arrives: the cursor must stop at 2 and the gap must be reported.
  const plan = ingestStreamEvents({ cursor: 0 }, [records()[0], records()[1], records()[3]])
  assert.equal(plan.cursor, 2, 'the cursor stops before the hole')
  assert.equal(plan.gap, true)
  assert.deepEqual(plan.backfill, { from: 3, to: 3 })
  assert.equal(plan.append.length, 2)
})

test('a host that may not write never streams', () => {
  // §7 read-only stays read-only: a fenced or version-mismatched host keeps its history and
  // must not stream or advance a cursor.
  assert.deepEqual(streamAllowed({ reason: { code: 'fenced' } }), { ok: false, reason: 'fenced' })
  assert.deepEqual(streamAllowed({ reason: { code: 'version-mismatch' } }), {
    ok: false,
    reason: 'version-mismatch',
  })
  assert.deepEqual(streamAllowed({ reason: { code: 'version-unknown' } }), { ok: false, reason: 'version-unknown' })
  assert.deepEqual(streamAllowed({ writable: false }), { ok: false, reason: 'fenced' })
  // A healthy mirror, and an L1 mirror with no lease information, may stream.
  assert.deepEqual(streamAllowed({ level: 'L2', reason: null, writable: true }), { ok: true })
})

test('the frame buffer is bounded and reports what it dropped', () => {
  const buffer = new FrameBuffer(3)
  for (let index = 0; index < 10; index += 1) {
    buffer.push({ offset: index, events: [{ seq: index + 1 }, { seq: index + 100 }] })
  }
  assert.equal(buffer.size, 3, 'the buffer never exceeds its cap')
  const drained = buffer.drain()
  assert.equal(drained.frames.length, 3)
  assert.equal(drained.dropped, 7, 'the dropped frames are counted, not hidden')
  assert.equal(drained.droppedEvents, 14)
  // Draining resets the counters, so a second drain does not re-report the same loss.
  const again = buffer.drain()
  assert.equal(again.dropped, 0)
  assert.equal(buffer.size, 0)
})

test('the stream offset is monotonic so a reconnect cannot re-read', () => {
  assert.equal(nextStreamOffset(10, 4), 10, 'a stale frame must not move the offset back')
  assert.equal(nextStreamOffset(4, 10), 10)
  assert.equal(nextStreamOffset(0, 0), 0)
  assert.equal(nextStreamOffset(undefined, 7), 7)
})

test('follow frames are parsed and classified', () => {
  const ok = parseFollowFrame(
    JSON.stringify({ ok: true, offset: 42, events: [{ seq: 1 }], truncated: false, bytes: 100 }),
  )
  assert.deepEqual(ok, { ok: true, offset: 42, events: [{ seq: 1 }], truncated: false, bytes: 100 })

  // A stale epoch from the remote is our existing `fenced` reason, not a parallel vocabulary.
  const fenced = parseFollowFrame(JSON.stringify({ ok: false, reason: 'stale-epoch', remoteEpoch: 9 }))
  assert.equal(fenced.ok, false)
  assert.equal(fenced.reason, 'stream-fenced')
  assert.equal(fenced.remoteEpoch, 9)

  assert.equal(parseFollowFrame('').reason, 'read-failed')
  assert.equal(parseFollowFrame('not json').reason, 'log-malformed')
  assert.equal(parseFollowFrame(JSON.stringify({ ok: false, reason: 'no-session-log' })).reason, 'no-session-log')
  assert.equal(parseFollowFrame(JSON.stringify({ ok: false, reason: 'weird' })).reason, 'log-malformed')
})

test('the remote helper is installed atomically and invoked with quoted args', () => {
  const script = remoteStreamScript('/home/u/.dsh')
  assert.equal(script, '/home/u/.dsh/remote-go/follow.mjs')

  const install = buildInstallStreamScriptCommand("/h/it's/follow.mjs")
  // Base64 payload, sibling temp file, rename: a reader never sees a half-written script.
  assert.match(install, /^mkdir -p '/)
  assert.match(install, /\) > '.*follow\.mjs\.tmp' && mv '.*follow\.mjs\.tmp' '.*follow\.mjs'$/)
  assert.ok(install.includes(`it'\\''s`), 'an embedded quote is escaped')

  const follow = buildFollowCommand('/h/follow.mjs', {
    logPath: '/h/sessions/a.jsonl',
    leasePath: '/h/remote-go/lease-s.json',
    offset: 12,
    epoch: 3,
  })
  assert.match(follow, /^node '\/h\/follow\.mjs' '[A-Za-z0-9+/=]+'$/)
  const args = JSON.parse(Buffer.from(/node '[^']*' '([A-Za-z0-9+/=]+)'$/.exec(follow)[1], 'base64').toString('utf8'))
  assert.deepEqual(args, {
    logPath: '/h/sessions/a.jsonl',
    leasePath: '/h/remote-go/lease-s.json',
    offset: 12,
    epoch: 3,
    maxBytes: STREAM_LIMITS.maxBytes,
  })
})

test('the remote helper really performs the stale-epoch check', () => {
  // §11 #12 said remote-side rejection lived only in the simulator. The script we install runs on
  // the remote and refuses a stale caller, so the check is on the far side of the boundary.
  const source = remoteStreamScriptSource()
  assert.match(source, /stale-epoch/, 'it emits the typed refusal')
  assert.match(source, /args\.epoch/, 'and it compares the caller epoch')
  assert.match(source, /Number\(lease\.expiresAt\) > Date\.now\(\)/, 'only while the record is live')
  // It must not depend on anything but node builtins, or it cannot run on an unmodified remote.
  const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['node:fs'], 'a zero-install remote helper')
})

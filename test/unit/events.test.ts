import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { beginConnectLog } from '../../dist/src/connect-log.js'
import { createApi } from '../../dist/src/api.js'
import { createEventHub, formatEventId, MAX_LOG_FRAME_ENTRIES, parseEventId } from '../../dist/src/events.js'
import { createHost, makeTestService } from '../helpers/fake-remote.ts'
/**
 * The two SSE channels (docs/api.md v2.12): `GET /events` carries the state model only, and `GET /events/logs` carries
 * the connect log rows with a `(instance, hostId, attempt, seq)` cursor. These cases pin the split at its seams: what
 * each channel may carry, what a cursor does, what the caps do, and what teardown leaves behind. */

async function startApi(service, options = {}) {
  let server
  const api = createApi({
    service,
    getOrigin: () => `http://127.0.0.1:${server.address().port}`,
    admit: options.admit,
    logger: { warn() {}, error() {} },
  })
  server = http.createServer(api.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/dsh-remote-go/api`
  return {
    base,
    dispose: () => api.dispose(),
    async close() {
      api.dispose()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}
/** One service with one API on a real port, torn down in the right order whatever the test does. */
async function withApi(run) {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    return await run({ service, base: api.base })
  } finally {
    await api.close()
    await service.shutdown()
  }
}
/** Every complete frame the stream has delivered so far. */
function framesOf(text) {
  const blocks = text.split('\n\n')
  // The last block is whatever arrived after the newest terminator: not a frame yet.
  blocks.pop()
  const frames = []
  for (const block of blocks) {
    const frame = { event: 'message', id: null, data: null }
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) frame.event = line.slice(7)
      else if (line.startsWith('id: ')) frame.id = line.slice(4)
      else if (line.startsWith('data: ')) frame.data = line.slice(6)
    }
    frames.push(frame)
  }
  return frames
}
/** One open SSE stream with its collected text, parsed frames and an end promise. */
function openStream(base, ssePath, headers = {}) {
  const url = new URL(`${base}${ssePath}`)
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        resolve({
          request,
          response,
          text: () => text,
          frames: () => framesOf(text),
          ended: new Promise((endResolve) => {
            response.once('end', () => endResolve('end'))
            response.once('close', () => endResolve('close'))
          }),
          close() {
            request.destroy()
            response.destroy()
          },
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}
const openLogs = (base, headers) => openStream(base, '/events/logs', headers)
const logFrames = (stream) => stream.frames().filter((frame) => frame.event === 'log')
/** Wait until `predicate()` holds; a broken stream fails this instead of hanging the suite. */
async function until(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const untilLogFrame = (stream, label = 'the first log frame') =>
  until(() => logFrames(stream).length > 0, label).then(() => logFrames(stream)[0])
/** A host whose connect window is open: the log ring is what the channel publishes. */
async function connectingHost(service, lines = 0) {
  const host = await createHost(service)
  const runtime = service.ctx.state.runtimes.get(host.id)
  // The runtime writer guard covers `src/`; a test may stage the presentation state directly.
  runtime.status = 'connecting'
  runtime.phase = 'ssh'
  for (let index = 0; index < lines; index += 1) {
    service.ctx.progress.log(runtime, 'info', `line ${index + 1}`)
  }
  return { host, runtime }
}

test('E1: the log channel passes the same admission and Origin fence as the state channel', async () => {
  const { service } = await makeTestService()
  const unauth = await startApi(service, { admit: () => 401 })
  const fenced = await startApi(service)
  try {
    for (const path of ['/events', '/events/logs']) {
      // DSH's own admission refuses before the route runs — both paths alike.
      const refused = await fetch(`${unauth.base}${path}`)
      assert.equal(refused.status, 401, `${path} must answer the kernel's rejection`)
      // A cross-site origin is refused by this plugin's fence on both channels.
      const response = await fetch(`${fenced.base}${path}`, { headers: { origin: 'http://evil.example' } })
      assert.equal(response.status, 403, `${path} must refuse a cross-site caller`)
    }
    // EventSource cannot set the marker header: the log channel must not require it.
    const stream = await openLogs(fenced.base)
    assert.equal(stream.response.statusCode, 200)
    assert.match(stream.response.headers['content-type'], /text\/event-stream/)
    stream.close()
  } finally {
    await unauth.close()
    await fenced.close()
    await service.shutdown()
  }
})

test('E2: the first log frame is a reset aligned with the /state cursor', async () => {
  await withApi(async ({ service, base }) => {
    const { host } = await connectingHost(service, 3)
    const snapshot = service.snapshot().hosts[0]
    assert.equal(snapshot.logAttempt, 0, 'no attempt has begun yet')
    assert.equal(snapshot.logSeq, 3)
    assert.equal(snapshot.logs.length, 3, 'GET /state still carries the tail')
    const stream = await openLogs(base)
    const frame = await untilLogFrame(stream)
    const payload = JSON.parse(frame.data)
    assert.equal(payload.reset, true, 'the first frame must rebuild, not append')
    assert.equal(payload.hostId, host.id)
    assert.equal(payload.attempt, snapshot.logAttempt)
    assert.equal(payload.seq, snapshot.logSeq)
    assert.equal(payload.visible, true)
    assert.ok(payload.entries.length <= MAX_LOG_FRAME_ENTRIES)
    assert.deepEqual(
      payload.entries.map((entry) => entry.seq),
      [1, 2, 3],
    )
    assert.equal(frame.id, formatEventId({ instance: payload.instance, hostId: host.id, attempt: 0, seq: 3 }))
    stream.close()
  })
})

test('E3: a log row publishes a log frame and never moves the state revision', async () => {
  await withApi(async ({ service, base }) => {
    const { runtime } = await connectingHost(service, 1)
    const state = await openStream(base, '/events')
    const logs = await openLogs(base)
    await untilLogFrame(logs)
    const revBefore = service.snapshot().rev
    const stateFramesBefore = state.frames().length
    const textBefore = state.text()
    service.ctx.progress.log(runtime, 'info', 'a line that only the log channel may carry')
    await until(() => logs.frames().some((frame) => (frame.data ?? '').includes('only the log channel')), 'the row')
    await sleep(250)
    assert.equal(service.snapshot().rev, revBefore, 'a log row is not a state change')
    assert.equal(state.frames().length, stateFramesBefore, 'the state channel must stay silent')
    assert.equal(state.text(), textBefore, 'not one byte of the state channel changed')
    logs.close()
    state.close()
  })
})

test('E4: a state change publishes a frame whose hosts[].logs are empty', async () => {
  await withApi(async ({ service, base }) => {
    const { host } = await connectingHost(service, 3)
    const state = await openStream(base, '/events')
    await until(() => state.frames().some((frame) => frame.event === 'state'), 'the first state frame')
    const revBefore = service.snapshot().rev
    const payloads = () =>
      state
        .frames()
        .filter((frame) => frame.event === 'state')
        .map((frame) => JSON.parse(frame.data))
    service.setActiveHost(host.id)
    await until(() => payloads().some((payload) => payload.rev > revBefore), 'the newer state frame')
    const newer = payloads().find((payload) => payload.rev > revBefore)
    assert.equal(newer.rev, service.snapshot().rev)
    assert.equal(newer.hosts[0].logs.length, 0, 'the state frame never inlines log rows')
    assert.equal(newer.hosts[0].logSeq, 3, 'but its cursor is contract: the Client aligns with it')
    assert.equal(newer.hosts[0].logAttempt, 0)
    state.close()
  })
})

test('E5: Last-Event-ID resumes exactly once and never manufactures an empty frame', async () => {
  await withApi(async ({ service, base }) => {
    const { host, runtime } = await connectingHost(service, 2)
    const first = await openLogs(base)
    const reset = await untilLogFrame(first, 'the reset frame')
    first.close()
    // Two more rows arrive while nobody is listening.
    service.ctx.progress.log(runtime, 'info', 'row three')
    service.ctx.progress.log(runtime, 'info', 'row four')
    await sleep(300)
    // Reconnect from the reset frame's id: only rows 3 and 4 come back, without a reset.
    const resumed = await openLogs(base, { 'last-event-id': reset.id })
    await untilLogFrame(resumed, 'the resumed frame')
    const increments = logFrames(resumed)
    assert.equal(increments.length, 1, 'one frame carries the two missing rows')
    const payload = JSON.parse(increments[0].data)
    assert.equal(payload.reset, undefined, 'a resumable cursor never resets')
    assert.deepEqual(
      payload.entries.map((entry) => entry.seq),
      [3, 4],
    )
    assert.equal(payload.seq, 4)
    assert.equal(payload.instance, service.snapshot().instance)
    // Same id from a fresh stream: nothing is owed, so nothing is sent (the row appended next proves the stream alive).
    const idle = await openLogs(base, { 'last-event-id': increments[0].id })
    await sleep(300)
    assert.equal(idle.frames().length, 0, 'a caught-up cursor produces no log frame at all')
    service.ctx.progress.log(runtime, 'info', 'row five')
    await untilLogFrame(idle, 'the new row')
    const next = logFrames(idle)
    assert.equal(next.length, 1)
    assert.deepEqual(
      JSON.parse(next[0].data).entries.map((entry) => entry.seq),
      [5],
    )
    assert.equal(JSON.parse(next[0].data).hostId, host.id)
    resumed.close()
    idle.close()
  })
})

test('E6: a cursor that cannot be continued answers with a full reset', async () => {
  await withApi(async ({ service, base }) => {
    const { host, runtime } = await connectingHost(service, 3)
    const instance = service.snapshot().instance
    // A new attempt invalidates the cursor: its `seq` restarts at 1.
    const staleAttempt = await openLogs(base, {
      'last-event-id': formatEventId({ instance, hostId: host.id, attempt: 0, seq: 3 }),
    })
    beginConnectLog(runtime) // attempt 1, row 1
    service.emitLogs(host.id)
    const afterAttempt = JSON.parse((await untilLogFrame(staleAttempt, 'the attempt reset')).data)
    assert.equal(afterAttempt.reset, true, 'a new attempt always resets')
    assert.equal(afterAttempt.attempt, 1)
    assert.equal(afterAttempt.entries[0].boundary, true)
    staleAttempt.close()
    // Another publish generation invalidates the cursor too.
    const staleInstance = await openLogs(base, {
      'last-event-id': formatEventId({ instance: 'host-from-before', hostId: host.id, attempt: 1, seq: 1 }),
    })
    await untilLogFrame(staleInstance, 'the instance reset')
    assert.equal(JSON.parse(staleInstance.frames()[0].data).reset, true)
    staleInstance.close()
    // A cursor older than the 200-row ring has a gap: reset instead of replaying part of it.
    for (let index = 0; index < 220; index += 1) {
      service.ctx.progress.log(runtime, 'info', `filler ${index}`)
    }
    await sleep(300)
    const outside = await openLogs(base, {
      'last-event-id': formatEventId({ instance, hostId: host.id, attempt: 1, seq: 0 }),
    })
    const afterWindow = JSON.parse((await untilLogFrame(outside, 'the window reset')).data)
    assert.equal(afterWindow.reset, true)
    assert.ok(afterWindow.entries.length <= MAX_LOG_FRAME_ENTRIES)
    assert.ok(afterWindow.entries.length > 0)
    outside.close()
  })
})

test('E7: the two channel caps are independent sets', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  const stateStreams = []
  const logStreams = []
  try {
    const { runtime } = await connectingHost(service)
    for (let index = 0; index < 8; index += 1) logStreams.push(await openLogs(api.base))
    // A ninth log stream evicts the oldest log stream, and touches no state stream.
    logStreams.push(await openLogs(api.base))
    assert.equal(await Promise.race([logStreams[0].ended, sleep(400).then(() => 'still-open')]), 'end')
    for (let index = 0; index < 9; index += 1) stateStreams.push(await openStream(api.base, '/events'))
    // A ninth state stream evicts the oldest state stream, and the log channel keeps working.
    assert.equal(await Promise.race([stateStreams[0].ended, sleep(400).then(() => 'still-open')]), 'end')
    service.ctx.progress.log(runtime, 'info', 'the log channel survived the state eviction')
    await until(
      () =>
        logStreams
          .at(-1)
          .frames()
          .some((frame) => (frame.data ?? '').includes('survived the state')),
      'the surviving log stream',
    )
    assert.equal(stateStreams[8].response.destroyed, false, 'the newest state stream is live')
  } finally {
    for (const stream of [...stateStreams, ...logStreams]) stream.close()
    await api.close()
    await service.shutdown()
  }
})

test('E8: a slow log subscriber is dropped instead of buffered', () => {
  const listeners = new Map()
  const service = {
    stateInstance: 'gen-1',
    snapshot: () => ({ rev: 1, instance: 'gen-1', hosts: [] }),
    logView: () => ({
      hostId: 'h_slow',
      attempt: 1,
      visible: true,
      firstSeq: 1,
      seq: 1,
      entries: [{ seq: 1, at: '', level: 'info', phase: null, message: 'row' }],
    }),
    logHostIds: () => [],
    on: (event, listener) => listeners.set(event, listener),
    removeListener() {},
  }
  class FakeResponse {
    constructor(backlog) {
      Object.assign(this, {
        status: 0,
        destroyed: false,
        writableEnded: false,
        writableLength: backlog,
        written: [],
        ended: false,
      })
    }
    writeHead(status) {
      this.status = status
    }
    flushHeaders() {}
    write(frame) {
      this.written.push(frame)
    }
    end() {
      this.ended = true
    }
    on() {}
  }
  const hub = createEventHub({ service, logger: { warn() {}, error() {} } })
  const request = { headers: {}, on() {} }
  const slow = new FakeResponse(2 * 1024 * 1024)
  const healthy = new FakeResponse(0)
  hub.handleLogs(request, slow)
  hub.handleLogs(request, healthy)
  listeners.get('logs')({ hostId: 'h_slow' })
  // The coalescing window is 150 ms; nothing is written before it fires.
  return sleep(320).then(() => {
    assert.equal(slow.ended, true, 'a subscriber past the backlog cap is ended')
    assert.equal(slow.written.length, 0, 'nothing was queued for it')
    assert.equal(healthy.ended, false)
    assert.ok(
      healthy.written.some((frame) => frame.includes('event: log')),
      'the healthy subscriber got the frame',
    )
    hub.dispose()
  })
})

test('E9: leaving the log-visible set ends the host stream after its last frame', async () => {
  await withApi(async ({ service, base }) => {
    const { host, runtime } = await connectingHost(service, 2)
    const stream = await openLogs(base)
    await untilLogFrame(stream, 'the first frame')
    service.ctx.progress.log(runtime, 'info', 'the last row of this attempt')
    await until(() => stream.frames().some((frame) => (frame.data ?? '').includes('last row')), 'the row')
    runtime.status = 'connected'
    service.emitState()
    await until(() => stream.frames().some((frame) => frame.event === 'log-end'), 'the log-end frame')
    const last = JSON.parse(logFrames(stream).at(-1).data)
    assert.equal(last.visible, false, 'the closing frame says the host left the set')
    assert.equal(JSON.parse(stream.frames().find((frame) => frame.event === 'log-end').data).hostId, host.id)
    stream.close()
  })
})

test('E10: a burst is split into frames of at most 120 rows, in order, without losing any', async () => {
  await withApi(async ({ service, base }) => {
    const { runtime } = await connectingHost(service, 200)
    const stream = await openLogs(base)
    await untilLogFrame(stream)
    // The initial frame is a reset carrying the 120-row tail; one more row adds a small increment.
    service.ctx.progress.log(runtime, 'info', 'tail row')
    await until(() => stream.frames().length >= 2, 'the increment')
    const logRows = logFrames(stream)
    const rows = []
    for (const frame of logRows) {
      const payload = JSON.parse(frame.data)
      assert.ok(payload.entries.length <= MAX_LOG_FRAME_ENTRIES, 'no frame exceeds the row cap')
      rows.push(...payload.entries.map((entry) => entry.seq))
      assert.ok(frame.id.endsWith(`:${payload.seq}`), 'the id names the frame cursor')
    }
    assert.ok(logRows.length >= 2, 'the burst did not fit one frame')
    for (let index = 1; index < rows.length; index += 1) {
      assert.ok(rows[index] > rows[index - 1], `row ${index} is out of order`)
    }
    assert.equal(rows.length, 121, 'every row of the reset window plus the increment arrived once')
    stream.close()
  })
})

test('E11: dispose ends both channels, drops both listener sets and is idempotent', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  let state = null
  let logs = null
  try {
    const { runtime } = await connectingHost(service, 1)
    state = await openStream(api.base, '/events')
    logs = await openLogs(api.base)
    await untilLogFrame(logs)
    assert.equal(service.listenerCount('logs'), 1)
    api.dispose()
    assert.equal(await Promise.race([state.ended, sleep(400).then(() => 'still-open')]), 'end')
    assert.equal(await Promise.race([logs.ended, sleep(400).then(() => 'still-open')]), 'end')
    assert.equal(service.listenerCount('logs'), 0, 'the hub unsubscribed')
    assert.equal(service.listenerCount('state'), 0)
    assert.doesNotThrow(() => api.dispose(), 'a second dispose is a no-op')
    // The ring is still readable after teardown: nothing was disposed with it.
    assert.ok(service.logView(runtime.id).entries.length > 0)
  } finally {
    if (state !== null) state.close()
    if (logs !== null) logs.close()
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10)
      timer.unref?.()
    })
    await api.close()
    await service.shutdown()
  }
})

test('E12: the event id round-trips and refuses anything that is not a cursor', () => {
  const cursor = { instance: 'x8k-1k2j-1', hostId: 'h_a', attempt: 2, seq: 17 }
  assert.equal(formatEventId(cursor), 'x8k-1k2j-1:h_a:2:17')
  assert.deepEqual(parseEventId(formatEventId(cursor)), cursor)
  const malformed = [
    undefined,
    '',
    'x8k:h_a:2',
    'x8k:h_a:2:17:9',
    ':h_a:2:17',
    'x8k::2:17',
    'x8k:h_a:a:17',
    'x8k:h_a:2:b',
  ]
  for (const value of malformed) {
    assert.equal(parseEventId(value), null, `refused: ${String(value)}`)
  }
})

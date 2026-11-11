import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SURFACE_EVENT_TYPES, createSessionAdapter } from '../../src/session-adapter.js'
import { decideResync, l1Capabilities, mirrorSessionId } from '../../src/mirror.js'
import { createFakeSessions } from '../helpers/fake-sessions.js'

const quiet = { warn() {} }

function descriptor(overrides = {}) {
  return {
    localSessionId: mirrorSessionId('h_1', 'r1'),
    hostId: 'h_1',
    remoteSessionId: 'r1',
    workspaceId: 'ws-a',
    title: 'Project A · r1',
    cursor: 0,
    capabilities: l1Capabilities(),
    mirroredAt: null,
    status: 'active',
    ...overrides,
  }
}

// (c) restart without a writer ---------------------------------------------

test('ensureMirrorSession creates the local session and flags the restart re-pull', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  assert.equal(adapter.available(), true)

  const mirror = descriptor({ cursor: 42 })
  const first = adapter.ensureMirrorSession(mirror)
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  assert.equal(first.localSessionId, mirror.localSessionId)
  // The local session persists nothing, so the mirror restarts from the remote.
  assert.equal(first.cursor, 0)
  assert.deepEqual(first.resync, decideResync({ cursor: 42, live: false }))
  assert.equal(first.resync.reason, 'local-session-missing')
  assert.match(first.notice.en, /re-pull/i)

  const createCall = sessions.calls.find((call) => call.op === 'create')
  assert.equal(createCall.id, mirror.localSessionId)
  // Lineage marker: a leftover mirror session is identifiable as a projection.
  // The seed is explicit (empty) because the host rejects `isSeeded` without one.
  assert.deepEqual(createCall.options, { seed: [], inheritedEventCount: 0, meta: { isSeeded: true } })

  // A live session is found, not re-created, and needs no resync.
  const second = adapter.ensureMirrorSession(mirror)
  assert.equal(second.ok, true)
  assert.equal(second.created, false)
  assert.equal(second.resync, null)
  assert.equal(sessions.calls.filter((call) => call.op === 'create').length, 1)
})

test('each host gets its own mirror cwd under the mirror root', () => {
  const sessions = createFakeSessions()
  const mirrorRoot = path.join(path.sep === '\\' ? 'C:\\dsh\\remote-go' : '/dsh/remote-go', 'mirrors')
  const adapter = createSessionAdapter({ sessions, logger: quiet, mirrorRoot })
  adapter.ensureMirrorSession(descriptor({ hostId: 'h_1' }))
  const createCall = sessions.calls.find((call) => call.op === 'create')
  assert.deepEqual(createCall.options, {
    seed: [],
    inheritedEventCount: 0,
    meta: { cwd: path.join(mirrorRoot, 'h_1'), isSeeded: true },
  })
  // The remote workspace path is never leaked into the local session.
  assert.notEqual(createCall.options.meta.cwd, '/home/u/project-a')

  // Host ids are sanitized into a single path segment.
  const hostile = createFakeSessions()
  const hostileAdapter = createSessionAdapter({ sessions: hostile, logger: quiet, mirrorRoot })
  hostileAdapter.ensureMirrorSession(descriptor({ hostId: '../evil/host' }))
  const hostileCall = hostile.calls.find((call) => call.op === 'create')
  assert.equal(hostileCall.options.meta.cwd, path.join(mirrorRoot, '.._evil_host'))
  assert.equal(hostileCall.options.meta.cwd.includes('..' + path.sep), false)
})

test('ensureMirrorCwd creates the per-host directory the host keys storage off', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-mirror-cwd-'))
  const adapter = createSessionAdapter({ sessions: createFakeSessions(), logger: quiet, mirrorRoot: root })
  const created = await adapter.ensureMirrorCwd(descriptor())
  assert.equal(created, path.join(root, 'h_1'))
  assert.equal((await stat(created)).isDirectory(), true)
  assert.equal(await adapter.ensureMirrorCwd(descriptor({ hostId: 'unknown host' })), path.join(root, 'unknown_host'))
  // Without a mirror root there is no directory to create.
  const plain = createSessionAdapter({ sessions: createFakeSessions(), logger: quiet })
  assert.equal(await plain.ensureMirrorCwd(descriptor()), null)
})

test('a relative mirror root is ignored so the host default cwd is used', async () => {
  // A relative root would produce a relative meta.cwd, which the DSH host
  // rejects; the adapter must fall back to the host default instead of failing
  // every mirror session with create-failed.
  const relative = createSessionAdapter({
    sessions: createFakeSessions(),
    logger: quiet,
    mirrorRoot: 'relative/not/absolute',
  })
  assert.equal(await relative.ensureMirrorCwd(descriptor()), null)

  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({
    sessions,
    logger: quiet,
    mirrorRoot: 'relative/not/absolute',
    cwd: path.join(path.sep, 'home', 'u', 'dsh'),
  })
  adapter.ensureMirrorSession(descriptor())
  assert.deepEqual(sessions.calls.find((call) => call.op === 'create').options, {
    seed: [],
    inheritedEventCount: 0,
    meta: { isSeeded: true },
  })
})

test('meta.cwd falls back to an absolute cwd and is omitted when relative', () => {
  const absolute = createFakeSessions()
  const absoluteAdapter = createSessionAdapter({
    sessions: absolute,
    logger: quiet,
    cwd: path.join(path.sep, 'home', 'u', 'project'),
  })
  absoluteAdapter.ensureMirrorSession(descriptor())
  assert.deepEqual(absolute.calls.find((call) => call.op === 'create').options, {
    seed: [],
    inheritedEventCount: 0,
    meta: { cwd: path.join(path.sep, 'home', 'u', 'project'), isSeeded: true },
  })

  const relative = createFakeSessions()
  const relativeAdapter = createSessionAdapter({ sessions: relative, logger: quiet, cwd: 'relative/dir' })
  relativeAdapter.ensureMirrorSession(descriptor())
  assert.deepEqual(relative.calls.find((call) => call.op === 'create').options, {
    seed: [],
    inheritedEventCount: 0,
    meta: { isSeeded: true },
  })
})

// (g) surface intents -------------------------------------------------------

test('a persisted localSessionId is never trusted over the derived one', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  const derived = mirrorSessionId('h_1', 'r1')

  const hostile = descriptor({ localSessionId: 'session-123' })
  const result = adapter.ensureMirrorSession(hostile)
  assert.equal(result.ok, true)
  assert.equal(result.localSessionId, derived)
  assert.equal(sessions.calls.find((call) => call.op === 'create').id, derived)
  assert.equal(sessions.live.has('session-123'), false)

  const otherMirror = descriptor({ localSessionId: mirrorSessionId('h_2', 'r1') })
  const second = adapter.ensureMirrorSession(otherMirror)
  assert.equal(second.localSessionId, derived)
})

test('surface events are appended with a surfaceOp intent, other events with two arguments', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  const mirror = descriptor()
  adapter.ensureMirrorSession(mirror)

  const data = { role: 'user', content: [] }
  const appended = adapter.appendEvent(mirror.localSessionId, { type: 'user/message', data })
  assert.equal(appended.ok, true)
  assert.equal(appended.surface, true)
  const firstCall = sessions.calls.filter((call) => call.op === 'append').pop()
  assert.deepEqual(firstCall.args, ['user/message', data, { surfaceOp: 'append' }])
  assert.equal(firstCall.args.length, 3)

  // Every surface type carries the intent (the two-argument form would be wrong).
  for (const type of SURFACE_EVENT_TYPES) {
    const result = adapter.appendEvent(mirror.localSessionId, { type, data: {} })
    assert.equal(result.ok, true)
    const call = sessions.calls.filter((entry) => entry.op === 'append').pop()
    assert.equal(call.args.length, 3)
    assert.deepEqual(call.args[2], { surfaceOp: 'append' })
    assert.equal(call.args[0], type)
  }

  // Non-surface events take exactly two arguments, as the host signature requires.
  const nonSurface = adapter.appendEvent(mirror.localSessionId, {
    type: 'request/header',
    data: { reason: 'initial' },
  })
  assert.equal(nonSurface.ok, true)
  assert.equal(nonSurface.surface, false)
  const lastCall = sessions.calls.filter((call) => call.op === 'append').pop()
  assert.equal(lastCall.args.length, 2)
  assert.deepEqual(lastCall.args, ['request/header', { reason: 'initial' }])
})

test('appendEvent refuses malformed events, non-mirror ids and unknown sessions without throwing', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })

  // Only `mirror_` ids may be written to: never an unrelated local session.
  assert.equal(adapter.appendEvent('', { type: 'user/message' }).reason, 'invalid-session-id')
  assert.equal(adapter.appendEvent('session-123', { type: 'user/message' }).reason, 'invalid-session-id')
  assert.equal(adapter.appendEvent('mirror_x', { data: {} }).reason, 'invalid-event')
  assert.equal(adapter.appendEvent('mirror_x', null).reason, 'invalid-event')

  const missing = adapter.appendEvent(mirrorSessionId('h_1', 'r1'), { type: 'user/message', data: {} })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'session-unavailable')
  assert.equal(sessions.calls.filter((call) => call.op === 'append').length, 0)

  assert.equal(adapter.ensureMirrorSession({}).reason, 'invalid-descriptor')
  assert.equal(adapter.ensureMirrorSession(null).reason, 'invalid-descriptor')
})

// optional service ----------------------------------------------------------

test('a missing sessions service yields typed sessions-unavailable results', () => {
  const adapter = createSessionAdapter({})
  assert.equal(adapter.available(), false)
  assert.deepEqual(adapter.ensureMirrorSession({ hostId: 'h_1', remoteSessionId: 'r1' }), {
    ok: false,
    reason: 'sessions-unavailable',
    localSessionId: mirrorSessionId('h_1', 'r1'),
  })
  assert.equal(adapter.appendEvent('mirror_x', { type: 'user/message', data: {} }).reason, 'sessions-unavailable')
  assert.equal(adapter.removeMirrorSession('mirror_x').reason, 'sessions-unavailable')

  // A host that publishes no `create` is treated the same way.
  const inert = createSessionAdapter({ sessions: { get() {} }, logger: quiet })
  assert.equal(inert.available(), false)
  assert.equal(inert.ensureMirrorSession({ hostId: 'h_1', remoteSessionId: 'r1' }).reason, 'sessions-unavailable')

  // Resolving the service must never take the plugin down.
  const broken = createSessionAdapter({
    ctx: {
      get() {
        throw new Error('no service')
      },
    },
    logger: quiet,
  })
  assert.equal(broken.available(), false)
  assert.equal(broken.ensureMirrorSession({ hostId: 'h_1', remoteSessionId: 'r1' }).reason, 'sessions-unavailable')
})

test('the adapter resolves the optional service lazily through ctx.get', () => {
  const sessions = createFakeSessions()
  /** @type {any} */
  let current = null
  const ctx = {
    get(name) {
      return name === 'sessions' ? current : undefined
    },
  }
  const adapter = createSessionAdapter({ ctx, logger: quiet })
  assert.equal(adapter.available(), false)
  current = sessions
  assert.equal(adapter.available(), true)
  assert.equal(adapter.ensureMirrorSession(descriptor()).ok, true)
})

test('a throwing sessions.create becomes a typed create-failed result', () => {
  const sessions = createFakeSessions()
  sessions.create = () => {
    throw new Error('nope')
  }
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  const result = adapter.ensureMirrorSession(descriptor())
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'create-failed')
  assert.match(result.error, /nope/)
})

// removal -------------------------------------------------------------------

test('hasMirrorSession reports only live mirror_ sessions', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  const mirror = descriptor()
  assert.equal(adapter.hasMirrorSession(mirror.localSessionId), false)
  adapter.ensureMirrorSession(mirror)
  assert.equal(adapter.hasMirrorSession(mirror.localSessionId), true)
  // Ids that are not mirror sessions are refused even if the store has them.
  assert.equal(adapter.hasMirrorSession('session-123'), false)
  assert.equal(adapter.hasMirrorSession(''), false)
  assert.equal(createSessionAdapter({}).hasMirrorSession(mirror.localSessionId), false)
})

test('removeMirrorSession reports the fiber-owned caveat instead of pretending to delete', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  const ensured = adapter.ensureMirrorSession(descriptor())

  const live = adapter.removeMirrorSession(ensured.localSessionId)
  assert.equal(live.ok, true)
  assert.equal(live.removed, false)
  assert.equal(live.reason, 'fiber-owned')
  // Only disposing the plugin fiber removes it (v1 `sessions` has no delete).
  assert.equal(sessions.live.has(ensured.localSessionId), true)

  const unknown = adapter.removeMirrorSession('mirror_missing')
  assert.equal(unknown.ok, true)
  assert.equal(unknown.removed, false)
  assert.equal(unknown.reason, 'not-found')

  // A host that later adds a removal hook is used through that escape hatch.
  const deletable = createFakeSessions()
  deletable.remove = (id) => {
    deletable.live.delete(id)
  }
  const deletableAdapter = createSessionAdapter({ sessions: deletable, logger: quiet })
  const created = deletableAdapter.ensureMirrorSession(descriptor({ remoteSessionId: 'r2' }))
  const removal = deletableAdapter.removeMirrorSession(created.localSessionId)
  assert.equal(removal.ok, true)
  assert.equal(removal.removed, true)
  assert.equal(deletable.live.has(created.localSessionId), false)
})

test('mirrorEventSeqs reads the real Session surface, not a fake events array', () => {
  const sessions = createFakeSessions()
  const adapter = createSessionAdapter({ sessions, logger: quiet })
  const mirror = adapter.ensureMirrorSession(descriptor({ remoteSessionId: 'real-shape' }))
  assert.equal(mirror.ok, true)

  // Empty until something is appended.
  assert.deepEqual([...adapter.mirrorEventSeqs(mirror.localSessionId)], [])

  const session = sessions.get(mirror.localSessionId)
  // The real host Session has no `events` property at all; the fake must agree,
  // otherwise this guard could pass here while being dead in production.
  assert.equal('events' in session, false, 'the fake must not expose an events array')
  assert.equal(typeof session.snapshotEvents, 'function')

  adapter.appendEvent(mirror.localSessionId, { type: 'user/message', data: { text: 'a', mirrorSeq: 1 } })
  adapter.appendEvent(mirror.localSessionId, { type: 'assistant/message', data: { text: 'b', mirrorSeq: 2 } })
  // A non-mirrored event carries no mirrorSeq and must not enter the set.
  adapter.appendEvent(mirror.localSessionId, { type: 'mirror/notice', data: { note: 'x' } })

  assert.deepEqual(
    [...adapter.mirrorEventSeqs(mirror.localSessionId)].sort((a, b) => a - b),
    [1, 2],
  )
})

test('mirrorEventSeqs prefers snapshotEvents and falls back without throwing', () => {
  const id = 'mirror_fallbackprobe0000000000'
  const events = [
    { type: 'user/message', seq: 0, data: { mirrorSeq: 3 } },
    { type: 'user/message', seq: 1, data: { mirrorSeq: 4 } },
  ]
  /** @param {any} session */
  const adapterFor = (session) =>
    createSessionAdapter({
      sessions: { get: () => session },
      logger: quiet,
    })

  // snapshotEvents wins over ownEvents when both exist.
  const both = adapterFor({ snapshotEvents: () => events, ownEvents: () => [{ data: { mirrorSeq: 9 } }] })
  assert.deepEqual(
    [...both.mirrorEventSeqs(id)].sort((a, b) => a - b),
    [3, 4],
  )

  // ownEvents is used when snapshotEvents is absent.
  const own = adapterFor({ ownEvents: () => events })
  assert.deepEqual(
    [...own.mirrorEventSeqs(id)].sort((a, b) => a - b),
    [3, 4],
  )

  // A richer snapshot object is tolerated: only `data.mirrorSeq` matters.
  const wrapped = adapterFor({ snapshotEvents: () => events.map((event) => ({ ...event, meta: { rev: 1 } })) })
  assert.deepEqual(
    [...wrapped.mirrorEventSeqs(id)].sort((a, b) => a - b),
    [3, 4],
  )

  // A legacy `events` array is not read: the real Session has no such property, so
  // supporting it would only keep a fake alive (see the shared double's docs).
  assert.deepEqual([...adapterFor({ events }).mirrorEventSeqs(id)], [])

  // Nothing readable / a throwing host degrades to an empty set instead of raising.
  assert.deepEqual([...adapterFor({}).mirrorEventSeqs(id)], [])
  const throwing = adapterFor({
    snapshotEvents() {
      throw new Error('boom')
    },
  })
  assert.deepEqual([...throwing.mirrorEventSeqs(id)], [])

  // A non-mirror id is refused outright.
  assert.deepEqual([...both.mirrorEventSeqs('session-123')], [])
})

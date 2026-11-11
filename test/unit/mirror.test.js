import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  acquireLease,
  applyEvents,
  decideLevel,
  decideResync,
  expireLease,
  isLeaseHeldBy,
  l1Capabilities,
  mirrorSessionId,
  nextCursor,
  normalizeCapabilities,
  normalizeMirrorDescriptor,
  planMirror,
  reconcileMirrors,
  renewLease,
  summarize,
} from '../../src/mirror.js'
import { MIRROR_STORE_VERSION, MirrorStore, sanitizeMirrorStore } from '../../src/mirror-store.js'

const quiet = { warn() {} }
const HOST = { id: 'h_test', name: 'Test host' }
const NOW = '2026-11-11T00:00:00.000Z'

function workspace(overrides = {}) {
  return { id: 'ws-a', title: 'Project A', path: '/home/u/project-a', sessionIds: ['r1', 'r2'], ...overrides }
}

function registry(workspaces = [workspace()]) {
  return { ok: true, initialized: true, defaultWorkspaceId: null, workspaces }
}

/** Build a contiguous batch of remote events. */
function events(from, to) {
  const batch = []
  for (let seq = from; seq <= to; seq += 1) batch.push({ seq, type: 'assistant/message', data: { seq } })
  return batch
}

// (a) idempotent merge ------------------------------------------------------

test('applyEvents is idempotent: the same batch twice leaves the state unchanged', () => {
  const batch = events(10, 20)
  const input = { cursor: 9, events: [] }

  const first = applyEvents(input, batch)
  assert.equal(first.applied, 11)
  assert.equal(first.backfill, null)
  assert.equal(first.state.cursor, 20)
  assert.deepEqual(
    first.state.events.map((event) => event.seq),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  )

  const second = applyEvents(first.state, batch)
  assert.equal(second.applied, 0)
  assert.equal(second.backfill, null)
  assert.deepEqual(second.state, first.state)
  assert.equal(second.state.cursor, 20)

  // The input state and events are never mutated.
  assert.deepEqual(input, { cursor: 9, events: [] })
  assert.equal(batch.length, 11)
  assert.deepEqual(nextCursor(first.state), 21)
  assert.deepEqual(summarize(first.state), {
    cursor: 20,
    nextSeq: 21,
    eventCount: 11,
    remoteDeleted: false,
    leasedBy: null,
    leaseExpiresAt: null,
  })
})

// (b) ordering and gaps -----------------------------------------------------

test('applyEvents sorts out-of-order input and stops at a gap without advancing past it', () => {
  const shuffled = [events(12, 12)[0], events(10, 10)[0], events(11, 11)[0]]
  const sorted = applyEvents({ cursor: 9, events: [] }, shuffled)
  assert.equal(sorted.applied, 3)
  assert.deepEqual(
    sorted.state.events.map((event) => event.seq),
    [10, 11, 12],
  )

  // A batch that starts beyond cursor + 1 reports the exact backfill range and
  // must not move the cursor.
  const gap = applyEvents({ cursor: 10 }, events(15, 16))
  assert.equal(gap.applied, 0)
  assert.deepEqual(gap.backfill, { from: 11, to: 14 })
  assert.equal(gap.state.cursor, 10)

  // Contiguous events before the gap apply; the ones after it stay unapplied.
  const partial = applyEvents({ cursor: 10, events: [] }, [...events(11, 12), ...events(15, 16)])
  assert.equal(partial.applied, 2)
  assert.equal(partial.state.cursor, 12)
  assert.deepEqual(partial.backfill, { from: 13, to: 14 })
  assert.deepEqual(
    partial.state.events.map((event) => event.seq),
    [11, 12],
  )

  // Duplicates collapse and stale sequence numbers are ignored.
  const duplicates = applyEvents({ cursor: 10 }, [events(11, 11)[0], events(11, 11)[0], events(9, 9)[0]])
  assert.equal(duplicates.applied, 1)
  assert.equal(duplicates.backfill, null)

  // Malformed input degrades to a typed result instead of throwing.
  const malformed = applyEvents(null, [null, 'x', { seq: 'nope' }, { seq: -1 }, { seq: 1.5 }, { seq: 0 }])
  assert.equal(malformed.applied, 0)
  assert.equal(malformed.state.cursor, 0)
  assert.equal(malformed.backfill, null)
  assert.deepEqual(applyEvents(undefined, undefined), {
    state: { cursor: 0 },
    backfill: null,
    applied: 0,
  })
})

// (c) restart without a writer ---------------------------------------------

test('a restart without a writer re-syncs from 0 and surfaces the re-pull notice', () => {
  const resync = decideResync({ cursor: 42, live: false })
  assert.equal(resync.needed, true)
  assert.equal(resync.from, 0)
  assert.equal(resync.reason, 'local-session-missing')
  assert.equal(typeof resync.notice.zh, 'string')
  assert.match(resync.notice.en, /re-pull/i)

  const live = decideResync({ cursor: 42, live: true })
  assert.equal(live.needed, false)
  assert.equal(live.from, 42)
  assert.equal(live.reason, null)
  assert.equal(live.notice, null)
})

// (d) single-writer lease ---------------------------------------------------

test('a second writer is refused as read-only; heartbeat expiry does the same', () => {
  const initial = { cursor: 5 }
  const taken = acquireLease(initial, { owner: 'local-a', now: 1_000, ttlMs: 5_000 })
  assert.equal(taken.ok, true)
  assert.equal(taken.state.lease.owner, 'local-a')
  assert.equal(taken.state.lease.expiresAt, 6_000)
  assert.equal(taken.readOnly, false)
  assert.deepEqual(initial, { cursor: 5 })

  const refused = acquireLease(taken.state, { owner: 'local-b', now: 2_000, ttlMs: 5_000 })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'lease-held-by-other')
  assert.equal(refused.holder, 'local-a')
  assert.equal(refused.expiresAt, 6_000)
  assert.equal(refused.readOnly, true)
  assert.deepEqual(refused.state, taken.state)

  // The holder re-acquiring is a renewal, not a takeover.
  const renewed = acquireLease(taken.state, { owner: 'local-a', now: 2_000, ttlMs: 5_000 })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.renewed, true)
  assert.equal(renewed.tookOver, false)
  assert.equal(renewed.lease.expiresAt, 7_000)

  // A heartbeat after expiry is refused: the holder must re-acquire, and the
  // mirror is reported read-only (never silently revived).
  const lateBeat = renewLease(taken.state, { owner: 'local-a', now: 6_000, ttlMs: 5_000 })
  assert.equal(lateBeat.ok, false)
  assert.equal(lateBeat.reason, 'lease-expired')
  assert.equal(lateBeat.readOnly, true)

  const expired = expireLease(taken.state, { now: 6_000 })
  assert.equal(expired.expired, true)
  assert.equal(expired.readOnly, true)
  assert.equal(expired.state.lease, null)
  assert.ok(expired.lease)

  assert.equal(isLeaseHeldBy(taken.state, 'local-a', 5_999), true)
  assert.equal(isLeaseHeldBy(taken.state, 'local-a', 6_000), false)
  assert.equal(isLeaseHeldBy(taken.state, 'local-b', 1_000), false)

  // An expired lease is taken over explicitly, and reported as such.
  const takeover = acquireLease(taken.state, { owner: 'local-b', now: 6_000, ttlMs: 5_000 })
  assert.equal(takeover.ok, true)
  assert.equal(takeover.tookOver, true)
  assert.equal(takeover.lease.owner, 'local-b')

  // Malformed requests are typed, not thrown.
  const invalid = acquireLease(taken.state, { owner: '', now: 1, ttlMs: 0 })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.reason, 'invalid-lease')
  assert.equal(invalid.readOnly, true)
  assert.equal(renewLease({ cursor: 0 }, { owner: 'local-a', now: 1, ttlMs: 10 }).reason, 'no-lease')
  assert.equal(renewLease(taken.state, { owner: 'local-b', now: 1, ttlMs: 10 }).reason, 'lease-held-by-other')
})

// (e) remote deletion -------------------------------------------------------

test('remote deletion keeps the local record and marks it without any remote delete', () => {
  const existing = planMirror({
    host: HOST,
    remoteWorkspaces: registry(),
    capabilities: l1Capabilities(),
    now: NOW,
  })
  assert.equal(existing.length, 2)

  // The remote registry lost r2: reconcile keeps the snapshot and marks it.
  const planned = planMirror({
    host: HOST,
    remoteWorkspaces: registry([workspace({ sessionIds: ['r1'] })]),
    capabilities: l1Capabilities(),
    existing,
    now: NOW,
  })
  const reconciled = reconcileMirrors({ existing, planned })
  assert.equal(reconciled.mirrors.length, 2)
  assert.deepEqual(reconciled.markedDeleted, ['r2'])
  assert.deepEqual(reconciled.revived, [])
  const deleted = reconciled.mirrors.find((descriptor) => descriptor.remoteSessionId === 'r2')
  assert.equal(deleted.status, 'remote-deleted')
  assert.equal(deleted.title, existing.find((descriptor) => descriptor.remoteSessionId === 'r2').title)

  // Re-reconciling is idempotent: the record is kept and not re-reported.
  const again = reconcileMirrors({ existing: reconciled.mirrors, planned })
  assert.equal(again.mirrors.length, 2)
  assert.deepEqual(again.markedDeleted, [])
  assert.equal(again.mirrors.find((descriptor) => descriptor.remoteSessionId === 'r2').status, 'remote-deleted')

  // A session that reappears is revived, not duplicated.
  const reappeared = planMirror({
    host: HOST,
    remoteWorkspaces: registry(),
    capabilities: l1Capabilities(),
    existing: reconciled.mirrors,
    now: NOW,
  })
  const revived = reconcileMirrors({ existing: reconciled.mirrors, planned: reappeared })
  assert.deepEqual(revived.revived, ['r2'])
  assert.equal(revived.mirrors.length, 2)
  assert.equal(revived.mirrors.find((descriptor) => descriptor.remoteSessionId === 'r2').status, 'active')
})

// (e2) determinism and stable ids -------------------------------------------

test('planMirror is deterministic and the stable-id derivation is stable', () => {
  const forward = planMirror({
    host: HOST,
    remoteWorkspaces: {
      workspaces: [workspace(), { id: 'ws-b', title: 'Project B', path: '/p/b', sessionIds: ['r3'] }],
    },
    capabilities: l1Capabilities(),
    now: NOW,
  })
  // Same set, different workspace/session order: the plan must be identical.
  const backward = planMirror({
    host: HOST,
    remoteWorkspaces: {
      workspaces: [
        { id: 'ws-b', title: 'Project B', path: '/p/b', sessionIds: ['r3'] },
        workspace({ sessionIds: ['r2', 'r1'] }),
      ],
    },
    capabilities: l1Capabilities(),
    now: NOW,
  })
  assert.deepEqual(forward, backward)
  assert.deepEqual(
    forward.map((descriptor) => descriptor.workspaceId),
    ['ws-a', 'ws-a', 'ws-b'],
  )

  const [first] = forward
  assert.match(first.localSessionId, /^mirror_[a-z0-9]{14}$/)
  assert.equal(first.localSessionId.length, 'mirror_'.length + 14)
  assert.equal(first.localSessionId, mirrorSessionId(HOST.id, first.remoteSessionId))
  // Stable across calls, distinct per host and per remote session.
  assert.equal(mirrorSessionId('h_1', 'r1'), mirrorSessionId('h_1', 'r1'))
  assert.notEqual(mirrorSessionId('h_1', 'r1'), mirrorSessionId('h_2', 'r1'))
  assert.notEqual(mirrorSessionId('h_1', 'r1'), mirrorSessionId('h_1', 'r2'))
  assert.notEqual(mirrorSessionId('a', 'b:c'), mirrorSessionId('a:b', 'c'))
  assert.equal(mirrorSessionId('', 'r1'), null)
  assert.equal(mirrorSessionId('h_1', '  '), null)

  // Deterministic ids survive a plan/read cycle.
  assert.equal(normalizeMirrorDescriptor(first).localSessionId, first.localSessionId)
})

test('planMirror degrades on malformed input and preserves an existing cursor', () => {
  assert.deepEqual(planMirror(), [])
  assert.deepEqual(planMirror({ host: null }), [])
  assert.deepEqual(planMirror({ host: HOST, remoteWorkspaces: null }), [])
  assert.deepEqual(planMirror({ host: HOST, remoteWorkspaces: { workspaces: 'nope' } }), [])

  const listed = planMirror({
    host: HOST,
    remoteWorkspaces: registry(),
    capabilities: ['list', 'history'],
    now: NOW,
  })
  assert.deepEqual(listed[0].capabilities, { list: true, history: true, stream: false, input: false, approve: false })

  const moved = listed.map((descriptor) =>
    descriptor.remoteSessionId === 'r1'
      ? { ...descriptor, cursor: 42, mirroredAt: '2026-11-10T00:00:00.000Z' }
      : descriptor,
  )
  const replanned = planMirror({
    host: HOST,
    remoteWorkspaces: registry(),
    capabilities: l1Capabilities(),
    existing: moved,
    now: NOW,
  })
  const kept = replanned.find((descriptor) => descriptor.remoteSessionId === 'r1')
  assert.equal(kept.cursor, 42)
  assert.equal(kept.mirroredAt, '2026-11-10T00:00:00.000Z')
  const fresh = replanned.find((descriptor) => descriptor.remoteSessionId === 'r2')
  assert.equal(fresh.cursor, 0)
  assert.equal(fresh.mirroredAt, NOW)

  // A duplicate session id across workspaces yields exactly one mirror.
  const duplicated = planMirror({
    host: HOST,
    remoteWorkspaces: {
      workspaces: [workspace({ id: 'ws-a' }), workspace({ id: 'ws-b', sessionIds: ['r1'] })],
    },
    capabilities: l1Capabilities(),
    now: NOW,
  })
  assert.equal(duplicated.length, 2)

  // The raw DSH registry (`tables.workspaces`) is accepted directly too.
  const raw = planMirror({
    host: HOST,
    remoteWorkspaces: {
      tables: { workspaces: { 'ws-a': { title: 'Project A', path: '/p/a', sessionIds: ['r1'] } } },
    },
    capabilities: l1Capabilities(),
    now: NOW,
  })
  assert.equal(raw.length, 1)
  assert.equal(raw[0].remoteSessionId, 'r1')
  assert.equal(raw[0].workspaceId, 'ws-a')
})

test('capability and descriptor normalization drop unknown data', () => {
  assert.deepEqual(normalizeCapabilities(null), l1Capabilities())
  assert.deepEqual(normalizeCapabilities('nope'), l1Capabilities())
  assert.deepEqual(normalizeCapabilities({ stream: true, input: 1 }), {
    list: true,
    history: false,
    stream: true,
    input: true,
    approve: false,
  })
  assert.equal(normalizeCapabilities(['history']).list, false)

  assert.equal(normalizeMirrorDescriptor(null), null)
  assert.equal(normalizeMirrorDescriptor({ hostId: 'h' }), null)
  const migrated = normalizeMirrorDescriptor({
    hostId: 'h_1',
    remoteSessionId: 'r1',
    cursor: '12',
    mirroredAt: '2026-11-11T00:00:00.000Z',
    unknown: 'dropped',
    capabilities: ['list', 'stream'],
  })
  assert.equal(migrated.localSessionId, mirrorSessionId('h_1', 'r1'))
  assert.equal(migrated.cursor, 12)
  assert.equal(migrated.title, 'r1')
  assert.equal(migrated.workspaceId, null)
  assert.equal(migrated.status, 'active')
  assert.equal('unknown' in migrated, false)
  assert.equal(normalizeMirrorDescriptor({ hostId: 'h', remoteSessionId: 'r', status: 'gone' }).status, 'active')
})

// (f) capability level ------------------------------------------------------

test('decideLevel downgrades with the reason codes the design names', () => {
  const full = { list: true, history: true, stream: true, input: true, approve: true }
  const versions = { hostVersion: '0.2.2-rc.1', localVersion: '0.2.2-rc.1' }

  const mismatch = decideLevel({ hostVersion: '0.2.1', localVersion: '0.2.2-rc.1', probe: full })
  assert.equal(mismatch.level, 'L1')
  assert.equal(mismatch.reason.code, 'version-mismatch')
  assert.equal(mismatch.downgraded, true)
  assert.equal(mismatch.versionParity.same, false)

  const complete = decideLevel({ ...versions, probe: full })
  assert.equal(complete.level, 'L3')
  assert.equal(complete.reason, null)
  assert.equal(complete.downgraded, false)
  assert.deepEqual(complete.capabilities, full)

  const noStream = decideLevel({ ...versions, probe: { ...full, stream: false } })
  assert.equal(noStream.level, 'L2')
  assert.equal(noStream.reason.code, 'stream-unavailable')
  assert.equal(decideLevel({ ...versions, probe: { ...full, input: false } }).reason.code, 'input-unavailable')
  assert.equal(decideLevel({ ...versions, probe: { ...full, approve: false } }).reason.code, 'approve-unavailable')

  const noHistory = decideLevel({ ...versions, probe: { ...full, history: false } })
  assert.equal(noHistory.level, 'L1')
  assert.equal(noHistory.reason.code, 'history-unavailable')
  assert.equal(decideLevel({ ...versions, probe: null }).reason.code, 'probe-missing')
  assert.equal(
    decideLevel({ hostVersion: null, localVersion: '0.2.2-rc.1', probe: full }).reason.code,
    'version-unknown',
  )
  // The directory-only probe the P0 service uses stays at L1.
  assert.equal(decideLevel({ ...versions, probe: l1Capabilities() }).reason.code, 'history-unavailable')
})

// mirror-store: permissions, round-trip, tolerant read ----------------------

test('MirrorStore round-trips descriptors and writes 0700/0600 files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-mirror-'))
  const store = new MirrorStore({ dir, logger: quiet })
  await store.load()
  const planned = planMirror({ host: HOST, remoteWorkspaces: registry(), capabilities: l1Capabilities(), now: NOW })
  const saved = await store.upsertMirrors(planned)
  assert.equal(saved.length, 2)

  const file = path.join(dir, 'mirrors.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, MIRROR_STORE_VERSION)
  assert.equal(raw.mirrors.length, 2)
  assert.equal(
    raw.mirrors.some((mirror) => mirror.hostId === HOST.id),
    true,
  )

  const reloaded = new MirrorStore({ dir, logger: quiet })
  await reloaded.load()
  assert.deepEqual(reloaded.listMirrors(), saved)
  assert.equal(reloaded.listMirrors({ hostId: HOST.id }).length, 2)
  assert.deepEqual(reloaded.listMirrors({ hostId: 'other' }), [])
  assert.equal(reloaded.getMirror(saved[0].localSessionId).remoteSessionId, saved[0].remoteSessionId)

  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  // The atomic write leaves no temporary file behind.
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('MirrorStore asks for 0600 files inside a 0700 directory and writes atomically', async () => {
  /** @type {any[]} */
  const writes = []
  /** @type {any[]} */
  const renames = []
  /** @type {any[]} */
  const mkdirs = []
  const fakeFs = {
    async mkdir(target, options) {
      mkdirs.push({ target, options })
    },
    async writeFile(target, text, options) {
      writes.push({ target, text, options })
    },
    async rename(from, to) {
      renames.push({ from, to })
    },
    async readFile() {
      throw new Error('the fake store never reads an existing file')
    },
  }
  const dir = path.join(tmpdir(), `dsh-remote-go-mirror-mode-${process.pid}-${Date.now()}`)
  const store = new MirrorStore({ dir, fsImpl: fakeFs, logger: quiet })
  await store.load()
  await store.upsertMirrors([{ hostId: 'h_1', remoteSessionId: 'r1', title: 'one' }])

  assert.equal(mkdirs[0].options.mode, 0o700)
  assert.equal(mkdirs[0].options.recursive, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].options.mode, 0o600)
  assert.equal(writes[0].options.encoding, 'utf8')
  assert.match(writes[0].text, /"version": 1/)
  assert.equal(renames.length, 1)
  assert.equal(renames[0].to, path.join(dir, 'mirrors.json'))
  assert.match(renames[0].from, /\.tmp$/)
  assert.notEqual(renames[0].from, renames[0].to)
})

test('MirrorStore tolerates a corrupt file and migrates unknown fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-mirror-bad-'))
  const file = path.join(dir, 'mirrors.json')
  await writeFile(file, '{broken', 'utf8')
  /** @type {unknown[][]} */
  const warnings = []
  const corrupted = new MirrorStore({ dir, logger: { warn: (...args) => warnings.push(args) } })
  assert.deepEqual(await corrupted.load(), { version: MIRROR_STORE_VERSION, mirrors: [] })
  assert.equal(warnings.length > 0, true)

  // Legacy bare-array envelope, unknown fields dropped, missing fields
  // defaulted, unusable records skipped.
  const legacy = [
    { hostId: 'h_1', remoteSessionId: 'r1', extra: 'must be dropped', capabilities: ['list', 'history'], cursor: '12' },
    { hostId: 'h_1' },
    { junk: true },
  ]
  await writeFile(file, JSON.stringify(legacy), 'utf8')
  const migrated = new MirrorStore({ dir, logger: quiet })
  await migrated.load()
  const descriptors = migrated.listMirrors()
  assert.equal(descriptors.length, 1)
  const [descriptor] = descriptors
  assert.equal(descriptor.localSessionId, mirrorSessionId('h_1', 'r1'))
  assert.equal(descriptor.cursor, 12)
  assert.equal(descriptor.title, 'r1')
  assert.equal(descriptor.mirroredAt, null)
  assert.equal(descriptor.status, 'active')
  assert.deepEqual(descriptor.capabilities, { list: true, history: true, stream: false, input: false, approve: false })
  assert.equal('extra' in descriptor, false)

  assert.deepEqual(sanitizeMirrorStore('nope'), { version: MIRROR_STORE_VERSION, mirrors: [] })
  assert.deepEqual(sanitizeMirrorStore(null), { version: MIRROR_STORE_VERSION, mirrors: [] })
})

test('MirrorStore replaces one host, removes records and survives a reload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-mirror-crud-'))
  const store = new MirrorStore({ dir, logger: quiet })
  const a1 = { hostId: 'h_a', remoteSessionId: 'r1', title: 'a1' }
  const a2 = { hostId: 'h_a', remoteSessionId: 'r2', title: 'a2' }
  const b1 = { hostId: 'h_b', remoteSessionId: 'r1', title: 'b1' }
  await store.upsertMirrors([a1, b1])
  assert.equal(store.listMirrors().length, 2)

  const replaced = await store.replaceHostMirrors('h_a', [a1, a2])
  assert.equal(replaced.length, 2)
  assert.equal(store.listMirrors().length, 3)
  assert.equal(store.listMirrors({ hostId: 'h_b' }).length, 1)

  assert.equal(await store.removeMirror(mirrorSessionId('h_a', 'r1')), true)
  assert.equal(await store.removeMirror(mirrorSessionId('h_a', 'r1')), false)
  assert.equal(await store.removeHostMirrors('h_a'), true)
  assert.equal(store.listMirrors({ hostId: 'h_a' }).length, 0)
  assert.equal(await store.removeHostMirrors('missing'), false)

  const reloaded = new MirrorStore({ dir, logger: quiet })
  await reloaded.load()
  assert.deepEqual(
    reloaded.listMirrors().map((descriptor) => descriptor.remoteSessionId),
    ['r1'],
  )
})

/**
 * Pure mirror-session logic for "complete remote sessions"
 * (docs/session-design.md §3 data model, §4 capability levels, §6 event
 * stream/cursor, §7 failure modes).
 *
 * This module has **no I/O and no DSH imports**: every function takes plain data
 * and returns fresh values, so the whole P0 contract is unit-testable. The
 * sibling `./version.js` is pure as well and is reused for version parity.
 *
 * P0 scope was the L1 directory mirror: the remote workspace registry becomes one
 * mirror descriptor per remote session. L2 (history replay, this release) layers
 * on the same descriptor/state shapes and **wires the §6 cursor merge for real**:
 * `applyEvents` / `nextCursor` / `summarize` are called by `./history.js` and
 * `./service.js`, and `./history.js` owns retention (`mirrorMaxEvents`). L3
 * (stream, input, approvals) is still unimplemented, and the write-lease helpers
 * below remain `@internal` because no local writer exists yet.
 *
 * Every exported function degrades to a typed result instead of throwing, per
 * design §4: "any level that fails must degrade explicitly, never silently
 * pretend to be a complete session".
 */
import { createHash } from 'node:crypto'
import { normalizeVersion, versionsEqual } from './version.js'

/**
 * @typedef {{ list: boolean, history: boolean, stream: boolean, input: boolean, approve: boolean }} MirrorCapabilities
 * @typedef {'active' | 'remote-deleted'} MirrorStatus
 * @typedef {'L1' | 'L2' | 'L3'} MirrorLevel
 * @typedef {{ code: string, message: { zh: string, en: string } }} MirrorDescriptorReason
 * @typedef {{
 *   localSessionId: string,
 *   hostId: string,
 *   remoteSessionId: string,
 *   workspaceId: string | null,
 *   title: string,
 *   cursor: number,
 *   capabilities: MirrorCapabilities,
 *   level: MirrorLevel,
 *   reason: MirrorDescriptorReason | null,
 *   mirroredAt: string | null,
 *   status: MirrorStatus,
 * }} MirrorDescriptor
 * @typedef {{ owner: string, acquiredAt: number, renewedAt: number, expiresAt: number, epoch: number }} MirrorLease
 * @typedef {{ seq: number, kept: string, lost: string }} MirrorConflict
 * @typedef {{ seq: number } & Record<string, any>} MirrorEvent
 * @typedef {{
 *   cursor: number,
 *   events?: MirrorEvent[],
 *   lease?: MirrorLease | null,
 *   status?: MirrorStatus,
 *   epoch?: number,
 *   fencedWriter?: string,
 *   conflicts?: MirrorConflict[],
 *   conflictCount?: number,
 * }} MirrorState
 * @typedef {{ code: string, detail: { zh: string, en: string } }} MirrorReason
 */

/**
 * The five capability names a mirror can carry (design §3 `capabilities`).
 * @type {readonly string[]}
 */
export const MIRROR_CAPABILITIES = Object.freeze(['list', 'history', 'stream', 'input', 'approve'])

/** Capability levels, ordered from the directory baseline to a full session. */
export const MIRROR_LEVELS = Object.freeze({ L1: 'L1', L2: 'L2', L3: 'L3' })

/**
 * Prefix of the derived local session id.
 * Exported so the session adapter can gate ids that come from persisted data.
 */
export const MIRROR_ID_PREFIX = 'mirror_'

/** Remote event sequence numbers are 1-based (see `applyEvents`). */
const FIRST_EVENT_SEQ = 1

/**
 * How many conflict reports one mirror keeps.
 *
 * Deliberately small: conflicts are an anomaly, not a log. The *count* is unbounded (a
 * single number) so "how many were seen" is still answerable after the list is trimmed.
 */
export const MIRROR_CONFLICT_LIMIT = 20

/** Characters of each side kept in a conflict summary. */
const CONFLICT_TEXT_LIMIT = 120

/** Default lease lifetime; the heartbeat renews well inside it. */
export const MIRROR_LEASE_TTL_MS = 30_000

// ---------------------------------------------------------------- descriptor

/**
 * Derive the stable local session id of one remote session.
 *
 * The id is the primary key of the persisted mirror record and the id DSH sees
 * for the local session, so it must be stable across restarts and machines. It
 * is therefore a pure function of `hostId` + `remoteSessionId`:
 *
 * ```text
 * key            = `${hostId}\u0000${remoteSessionId}`
 * digest         = sha256(key)                      // first 16 bytes = 128 bits
 * localSessionId = "mirror_" + base36(digest).padStart(25, "0")
 * ```
 *
 * SHA-256 is used because the remote session id is remote-controlled input: a
 * non-cryptographic hash would let a remote host mine collisions and collide two
 * mirror records. The 128-bit truncation keeps the id short (32 characters) while
 * staying far out of birthday-collision range for realistic session counts. The
 * NUL separator keeps `("a", "b:c")` and `("a:b", "c")` distinct. The result is
 * always `mirror_` + 25 lowercase base36 characters (32 characters total).
 *
 * @param {string} hostId
 * @param {string} remoteSessionId
 * @returns {string | null} `null` when either input is empty (nothing to key on)
 */
export function mirrorSessionId(hostId, remoteSessionId) {
  const host = typeof hostId === 'string' ? hostId.trim() : ''
  const remote = typeof remoteSessionId === 'string' ? remoteSessionId.trim() : ''
  if (host === '' || remote === '') return null
  const digest = createHash('sha256').update(`${host}\u0000${remote}`).digest()
  const truncated = digest.subarray(0, 16)
  const encoded = BigInt(`0x${truncated.toString('hex')}`)
    .toString(36)
    .padStart(25, '0')
  return `${MIRROR_ID_PREFIX}${encoded}`
}

/**
 * Normalize a capability probe into the five booleans of design §3.
 *
 * Accepts an object (`{ stream: true, ... }`), an array of supported capability
 * names (`['list', 'history']`), or anything else. A capability is ON only when
 * the probe says the literal `true`: `{ input: 1 }` or `{ stream: 'yes' }` are
 * not confirmations and must not become `true` (design §4: never claim a
 * capability the probe did not confirm). Unknown or malformed input degrades to
 * the L1 baseline instead of throwing.
 *
 * @param {unknown} value
 * @returns {MirrorCapabilities}
 */
export function normalizeCapabilities(value) {
  const capabilities = l1Capabilities()
  if (Array.isArray(value)) {
    for (const name of MIRROR_CAPABILITIES) capabilities[name] = value.includes(name)
    return capabilities
  }
  if (!value || typeof value !== 'object') return capabilities
  for (const name of MIRROR_CAPABILITIES) {
    const raw = /** @type {Record<string, unknown>} */ (value)[name]
    if (raw === undefined) continue
    capabilities[name] = raw === true
  }
  return capabilities
}

/**
 * The directory-only capability set (L1): the remote workspace registry was read,
 * but no history/stream/input/approve channel has been verified.
 * @returns {MirrorCapabilities}
 */
export function l1Capabilities() {
  return { list: true, history: false, stream: false, input: false, approve: false }
}

/**
 * Plan the mirror descriptors a directory read implies (design §4 L1, §7).
 *
 * One descriptor per remote session id, keyed by `hostId` + `remoteSessionId`.
 * Because L1 only carries workspace-level data, `title` is a placeholder
 * (`<workspace title> · <remote session id prefix>`) and L2 replaces it with the
 * remote session title. A previous descriptor keeps its `cursor` so an update
 * never resets the sync position; `mirroredAt` always advances to the caller's
 * `now` because a plan is only derived after a successful registry read. When the
 * caller passes no `now` (failure/partial path) the previous `mirroredAt` is
 * preserved.
 *
 * `level` and `reason` are stamped on **every** descriptor from the caller's
 * `decideLevel()` result (design §7 requires a version mismatch to be annotated
 * on the session, not only on the host). Without a decision the descriptor is the
 * conservative directory baseline: `level: 'L1', reason: null`.
 *
 * Ordering is deterministic and independent of the input order: descriptors sort
 * by `hostId`, then `workspaceId` (nulls last), then `remoteSessionId`.
 *
 * @param {{
 *   host?: { id?: string, name?: string } | null,
 *   remoteWorkspaces?: unknown,
 *   capabilities?: unknown,
 *   existing?: readonly unknown[] | null,
 *   now?: string | number | Date | null,
 *   decision?: { level?: unknown, reason?: unknown } | null,
 * }} [input]
 * @returns {MirrorDescriptor[]}
 */
export function planMirror(input = {}) {
  const hostId = textOrNull(input.host?.id)
  if (hostId === null) return []
  const capabilities = normalizeCapabilities(input.capabilities)
  // The caller just read the remote directory, so `list` is a verified fact.
  capabilities.list = true
  const mirroredAt = toIsoTime(input.now)
  const level = levelOrNull(input.decision?.level) ?? MIRROR_LEVELS.L1
  const reason = descriptorReason(input.decision?.reason)
  const existingById = indexDescriptors(input.existing)
  /** @type {MirrorDescriptor[]} */
  const planned = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const workspace of workspaceList(input.remoteWorkspaces)) {
    const workspaceId = textOrNull(workspace.id)
    const baseTitle = workspaceTitle(workspace)
    for (const remoteSessionId of sessionIdsOf(workspace)) {
      // One mirror per remote session; a duplicate across workspaces keeps the first.
      if (seen.has(remoteSessionId)) continue
      seen.add(remoteSessionId)
      const localSessionId = mirrorSessionId(hostId, remoteSessionId)
      if (localSessionId === null) continue
      const previous = existingById.get(localSessionId) ?? null
      planned.push({
        localSessionId,
        hostId,
        remoteSessionId,
        workspaceId,
        title: mirrorTitle(baseTitle, remoteSessionId),
        cursor: previous ? previous.cursor : 0,
        capabilities: { ...capabilities },
        level,
        reason: reason === null ? null : { code: reason.code, message: { ...reason.message } },
        // Last successful sync time: advance on every planned (successful) read.
        mirroredAt: mirroredAt ?? previous?.mirroredAt ?? null,
        status: 'active',
        // Carried forward: `planMirror` only knows the directory, so the read-only
        // flag set by the L2 replay must not be cleared on the next sync.
        readOnly: previous ? previous.readOnly === true : false,
        // L3 prerequisite (§6.2): the fencing state belongs to the previous sync, not to the
        // directory read. Carrying it forward is what makes the epoch survive a re-plan and
        // keeps a fenced mirror fenced until it legitimately re-acquires.
        epoch: previous?.epoch ?? 0,
        lease: previous?.lease ?? null,
        writable: previous?.writable === true,
        fencedEpoch: previous?.fencedEpoch ?? null,
        fencedWriter: previous?.fencedWriter ?? null,
        conflicts: previous?.conflicts ?? [],
        conflictCount: previous?.conflictCount ?? 0,
      })
    }
  }
  return planned.sort(compareMirrors)
}

/**
 * Normalize one persisted/seeded descriptor (tolerant read + migration).
 *
 * Unknown fields are dropped, missing fields are defaulted. A persisted
 * `localSessionId` is only trusted when it carries the `mirror_` prefix **and**
 * equals the value derived from `hostId` + `remoteSessionId`; anything else is
 * re-derived, so a corrupted or hand-edited file cannot point a mirror at an
 * unrelated local session. A record without a usable `hostId`/`remoteSessionId`
 * cannot be keyed and is reported as `null` so the caller can drop it instead of
 * writing a broken mirror.
 *
 * @param {unknown} raw
 * @returns {MirrorDescriptor | null}
 */
export function normalizeMirrorDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = /** @type {Record<string, any>} */ (raw)
  const hostId = textOrNull(record.hostId)
  const remoteSessionId = textOrNull(record.remoteSessionId)
  if (hostId === null || remoteSessionId === null) return null
  const derived = mirrorSessionId(hostId, remoteSessionId)
  if (derived === null) return null
  const candidate = textOrNull(record.localSessionId)
  const localSessionId =
    candidate !== null && candidate.startsWith(MIRROR_ID_PREFIX) && candidate === derived ? candidate : derived
  const title = textOrNull(record.title) ?? remoteSessionId
  return {
    localSessionId,
    hostId,
    remoteSessionId,
    workspaceId: textOrNull(record.workspaceId),
    title: title.length > 120 ? title.slice(0, 120) : title,
    cursor: nonNegativeInteger(record.cursor) ?? 0,
    capabilities: normalizeCapabilities(record.capabilities),
    level: levelOrNull(record.level) ?? MIRROR_LEVELS.L1,
    reason: descriptorReason(record.reason),
    mirroredAt: toIsoTime(record.mirroredAt),
    status: record.status === 'remote-deleted' ? 'remote-deleted' : 'active',
    // L2: a replayed mirror is a read-only projection until L3 forwards input
    // (design §10 P1 asks for the marker; the client renders it from this flag).
    readOnly: record.readOnly === true,
    // L3 prerequisite (design §6.2): the fencing state must survive a restart, otherwise a
    // restarted writer would come back with a stale epoch and believe it may write.
    epoch: nonNegativeInteger(record.epoch) ?? 0,
    lease: normalizeLease(record.lease),
    writable: record.writable === true,
    fencedEpoch: nonNegativeInteger(record.fencedEpoch) ?? null,
    fencedWriter: textOrNull(record.fencedWriter),
    conflicts: Array.isArray(record.conflicts)
      ? capConflicts(
          record.conflicts.filter(isMirrorConflict).map((/** @type {MirrorConflict} */ conflict) => ({ ...conflict })),
        )
      : [],
    conflictCount: nonNegativeInteger(record.conflictCount) ?? 0,
  }
}

/**
 * Compare two descriptors in the canonical (deterministic) order.
 * @param {MirrorDescriptor} left
 * @param {MirrorDescriptor} right
 * @returns {number}
 */
export function compareMirrors(left, right) {
  return (
    compareText(left.hostId, right.hostId) ||
    compareNullableText(left.workspaceId, right.workspaceId) ||
    compareText(left.remoteSessionId, right.remoteSessionId)
  )
}

/**
 * Reconcile a fresh plan with what is persisted (design §7 "remote session
 * deleted").
 *
 * Remote deletion never deletes the local record: the descriptor is kept
 * read-only and marked `remote-deleted` so the last known snapshot stays
 * readable. A session that reappears is revived to `active`. This function makes
 * **no remote call** and takes no remote action; P0 has no delete path at all.
 *
 * @param {{
 *   existing?: readonly unknown[] | null,
 *   planned?: readonly unknown[] | null,
 * }} [input]
 * @returns {{
 *   mirrors: MirrorDescriptor[],
 *   markedDeleted: string[],
 *   revived: string[],
 * }}
 */
export function reconcileMirrors(input = {}) {
  const planned = normalizeDescriptorList(input.planned)
  const existing = normalizeDescriptorList(input.existing)
  const plannedIds = new Set(planned.map((descriptor) => descriptor.localSessionId))
  const mirrors = planned.slice()
  /** @type {string[]} */
  const markedDeleted = []
  /** @type {string[]} */
  const revived = []
  for (const previous of existing) {
    if (plannedIds.has(previous.localSessionId)) {
      if (previous.status === 'remote-deleted') revived.push(previous.remoteSessionId)
      continue
    }
    // Keep the snapshot (cursor/title) but mark it: never delete local data.
    if (previous.status !== 'remote-deleted') markedDeleted.push(previous.remoteSessionId)
    mirrors.push({ ...previous, status: 'remote-deleted' })
  }
  return { mirrors: mirrors.sort(compareMirrors), markedDeleted, revived }
}

// --------------------------------------------------------------- event merge

/**
 * The seq the next remote event must carry (`cursor + 1`).
 *
 * @param {unknown} state
 * @returns {number}
 */
export function nextCursor(state) {
  return normalizeMirrorState(state).cursor + 1
}

/**
 * Merge a batch of remote events into a mirror state (design §6).
 *
 *
 * Rules:
 * - only `seq > cursor` is applied, so replaying a batch twice is idempotent;
 * - input order does not matter and duplicate `seq` values are collapsed (first
 *   occurrence wins);
 * - a gap (`first fresh seq > cursor + 1`) is reported as `backfill` and the
 *   cursor stops at the last contiguous event: events beyond a gap are NOT
 *   applied, so the caller backfills `[from, to]` and replays the rest;
 * - malformed input never throws: non-object entries and non-integer/negative
 *   `seq` values are dropped.
 *
 * Remote sequence numbers are 1-based (matching DSH `SessionSeq`); `cursor: 0`
 * means "nothing applied yet". The input state and events are never mutated.
 *
 * @param {unknown} state
 * @param {unknown} events
 * @returns {{
 *   state: MirrorState,
 *   backfill: { from: number, to: number } | null,
 *   applied: number,
 * }}
 */
export function applyEvents(state, events) {
  const base = normalizeMirrorState(state)
  const normalized = normalizeEventsDetailed(events)
  const fresh = normalized.events.filter((event) => event.seq > base.cursor)
  /** @type {MirrorEvent[]} */
  const applied = []
  let cursor = base.cursor
  let index = 0
  while (index < fresh.length && fresh[index].seq === cursor + 1) {
    applied.push(fresh[index])
    cursor = fresh[index].seq
    index += 1
  }
  const next = fresh[index] ?? null
  const backfill = next !== null && next.seq > cursor + 1 ? { from: cursor + 1, to: next.seq - 1 } : null
  /** @type {MirrorState} */
  const out = { ...base, cursor }
  if (Array.isArray(base.events)) {
    out.events = applied.length > 0 ? [...base.events, ...applied.map((event) => ({ ...event }))] : [...base.events]
  }
  // Conflict reporting (design §6.2): a same-`seq` record whose payload differs from the one
  // applied used to be swallowed silently. Keep-first is still the default *policy*, but the
  // loss is now reported so a caller/test can prove it happened.
  //
  // Only conflicts for records **this call actually applied** are reported. That is what
  // makes the count idempotent: L2 re-reads the whole remote log every sync (§11 #7), so a
  // conflict on a `seq` already behind the cursor was already reported when that record was
  // applied — counting it again would inflate `conflictCount` on every sync.
  const appliedSeqs = new Set(applied.map((event) => event.seq))
  const freshConflicts = normalized.conflicts.filter((conflict) => appliedSeqs.has(conflict.seq))
  if (freshConflicts.length > 0) {
    // Merge by digest, not by position: a re-read after a failed append (cursor did not
    // advance) legitimately re-applies the same seq, and the same conflict must not be
    // counted twice just because it came back.
    const seen = new Set((base.conflicts ?? []).map(conflictDigest))
    const added = freshConflicts.filter((conflict) => !seen.has(conflictDigest(conflict)))
    if (added.length > 0) {
      out.conflicts = capConflicts([...(base.conflicts ?? []), ...added])
      out.conflictCount = (base.conflictCount ?? 0) + added.length
    }
  }
  return {
    state: out,
    backfill,
    applied: applied.length,
    // The caller-facing list is capped (it ends up in the summary), while the *count* above
    // stays exact so "how many were there" never tracks the visible window instead of reality.
    conflicts: capConflicts(freshConflicts),
    conflictCount: out.conflictCount ?? 0,
  }
}

/**
 * A conflict's identity for de-duplication: the two sides plus the seq.
 * @param {MirrorConflict} conflict
 * @returns {string}
 */
function conflictDigest(conflict) {
  return `${conflict.seq}\u0000${conflict.kept}\u0000${conflict.lost}`
}

/**
 * Compact, client-safe view of a mirror state.
 *
 * @param {unknown} state
 * @returns {{
 *   cursor: number,
 *   nextSeq: number,
 *   eventCount: number,
 *   remoteDeleted: boolean,
 *   leasedBy: string | null,
 *   leaseExpiresAt: number | null,
 * }}
 */
export function summarize(state) {
  const normalized = normalizeMirrorState(state)
  const lease = normalized.lease ?? null
  return {
    cursor: normalized.cursor,
    nextSeq: normalized.cursor + 1,
    eventCount: Array.isArray(normalized.events) ? normalized.events.length : 0,
    remoteDeleted: normalized.status === 'remote-deleted',
    leasedBy: lease ? lease.owner : null,
    leaseExpiresAt: lease ? lease.expiresAt : null,
  }
}

// --------------------------------------------------------------------- lease

/**
 * Acquire the single-writer lease (design §6: heartbeat renewal, never
 * concurrent writers).
 *
 * @internal P0 does not wire this: no local writer exists yet, so the lease is a
 * pure helper. L3 input forwarding will call it.
 *
 * A live lease held by another owner is refused with a typed result instead of
 * being overwritten; the returned `readOnly: true` is what the mirror reports to
 * the user. An expired lease or no lease at all is granted, and a grant that
 * replaces an expired lease of another owner reports `tookOver: true`. Releasing
 * a lease that is still live for the same owner is a renewal.
 *
 * @param {unknown} state
 * @param {{ owner?: string, now?: number, ttlMs?: number }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason?: 'invalid-lease' | 'lease-held-by-other',
 *   holder?: string,
 *   expiresAt?: number,
 *   renewed?: boolean,
 *   tookOver?: boolean,
 *   lease?: MirrorLease | null,
 *   state: MirrorState,
 *   readOnly: boolean,
 * }}
 */
export function acquireLease(state, options = {}) {
  const base = normalizeMirrorState(state)
  const owner = textOrNull(options.owner)
  const now = finiteNumber(options.now)
  const ttlMs = finiteNumber(options.ttlMs)
  if (owner === null || now === null || ttlMs === null || ttlMs <= 0) {
    return { ok: false, reason: 'invalid-lease', state: base, lease: base.lease ?? null, readOnly: true }
  }
  const current = base.lease ?? null
  if (current !== null && current.owner !== owner && current.expiresAt > now) {
    return {
      ok: false,
      reason: 'lease-held-by-other',
      holder: current.owner,
      expiresAt: current.expiresAt,
      epoch: current.epoch,
      state: base,
      lease: current,
      readOnly: true,
    }
  }
  const renewed = current !== null && current.owner === owner && current.expiresAt > now
  const tookOver = current !== null && current.owner !== owner && !renewed
  // Fencing token (design §6.2): every *grant* advances the epoch, but a renewal of the
  // same live lease keeps it — the writer's authority did not change, so its outstanding
  // writes must stay valid. The high-water mark lives on the state, not on the lease, so
  // an expired/released lease can never let the epoch regress (see `nextEpoch`).
  const epoch = renewed ? current.epoch : nextEpoch(base, current)
  const lease = {
    owner,
    acquiredAt: renewed ? current.acquiredAt : now,
    renewedAt: now,
    expiresAt: now + ttlMs,
    epoch,
  }
  return {
    ok: true,
    renewed,
    tookOver,
    epoch,
    lease,
    state: { ...base, lease, epoch: Math.max(base.epoch ?? 0, epoch) },
    readOnly: false,
  }
}

/**
 * Renew a held lease (heartbeat). An expired lease cannot be renewed silently:
 *
 * @internal P0 does not wire this: L3 input forwarding will call it.
 * the holder must re-acquire, so this returns `lease-expired` and `readOnly`.
 *
 * @param {unknown} state
 * @param {{ owner?: string, now?: number, ttlMs?: number }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason?: 'invalid-lease' | 'no-lease' | 'lease-held-by-other' | 'lease-expired',
 *   holder?: string,
 *   expiresAt?: number,
 *   lease?: MirrorLease | null,
 *   state: MirrorState,
 *   readOnly: boolean,
 * }}
 */
export function renewLease(state, options = {}) {
  const base = normalizeMirrorState(state)
  const owner = textOrNull(options.owner)
  const now = finiteNumber(options.now)
  const ttlMs = finiteNumber(options.ttlMs)
  if (owner === null || now === null || ttlMs === null || ttlMs <= 0) {
    return { ok: false, reason: 'invalid-lease', state: base, lease: base.lease ?? null, readOnly: true }
  }
  const current = base.lease ?? null
  if (current === null) return { ok: false, reason: 'no-lease', state: base, lease: null, readOnly: true }
  if (current.owner !== owner) {
    return {
      ok: false,
      reason: 'lease-held-by-other',
      holder: current.owner,
      expiresAt: current.expiresAt,
      state: base,
      lease: current,
      readOnly: true,
    }
  }
  if (current.expiresAt <= now) {
    return {
      ok: false,
      reason: 'lease-expired',
      holder: current.owner,
      expiresAt: current.expiresAt,
      state: base,
      lease: current,
      readOnly: true,
    }
  }
  const lease = { ...current, renewedAt: now, expiresAt: now + ttlMs }
  return {
    ok: true,
    // A renewal is the same lease, so the fencing token does not move.
    epoch: lease.epoch,
    lease,
    state: { ...base, lease, epoch: Math.max(base.epoch ?? 0, lease.epoch) },
    readOnly: false,
  }
}

/**
 * Whether `owner` may write right now.
 *
 * @internal P0 does not wire this: L3 input forwarding will call it.
 * @param {unknown} state
 * @param {string} owner
 * @param {number} now epoch milliseconds
 * @returns {boolean}
 */
export function isLeaseHeldBy(state, owner, now) {
  const wanted = textOrNull(owner)
  const at = finiteNumber(now)
  if (wanted === null || at === null) return false
  const lease = normalizeMirrorState(state).lease ?? null
  return lease !== null && lease.owner === wanted && lease.expiresAt > at
}

/**
 * Drop an expired lease. `readOnly: true` means "the mirror has no writer and
 * must be presented as read-only" (design §6/§7); a live lease is left alone.
 *
 * @internal P0 does not wire this: L3 input forwarding will call it.
 *
 * @param {unknown} state
 * @param {{ now?: number }} [options]
 * @returns {{
 *   state: MirrorState,
 *   expired: boolean,
 *   lease: MirrorLease | null,
 *   readOnly: boolean,
 * }}
 */
export function expireLease(state, options = {}) {
  const base = normalizeMirrorState(state)
  const now = finiteNumber(options.now)
  const current = base.lease ?? null
  if (current === null) return { state: base, expired: false, lease: null, readOnly: true }
  if (now === null || current.expiresAt > now) {
    return { state: base, expired: false, lease: current, readOnly: false }
  }
  return { state: { ...base, lease: null }, expired: true, lease: current, readOnly: true }
}

// -------------------------------------------------------------------- fencing

/**
 * The next fencing token: strictly greater than anything this mirror has ever seen.
 *
 * The high-water mark is `state.epoch`, which outlives the lease itself. That is what
 * makes a *stale* writer unable to come back: releasing, expiring or taking over a lease
 * never reuses a number, so a writer holding epoch N stays fenced even after the lease
 * that issued N is gone (and after a restart, because `state.epoch` is persisted).
 *
 * @param {MirrorState} state
 * @param {MirrorLease | null} [lease]
 * @returns {number}
 */
export function nextEpoch(state, lease = null) {
  const base = normalizeMirrorState(state)
  const high = Math.max(base.epoch ?? 0, lease?.epoch ?? 0)
  return high + 1
}

/**
 * The epoch a writer must present for its writes to be accepted right now.
 * @param {unknown} state
 * @returns {number}
 */
export function currentEpoch(state) {
  const base = normalizeMirrorState(state)
  return Math.max(base.epoch ?? 0, base.lease?.epoch ?? 0)
}

/**
 * Whether `owner` may append at `epoch` (design §6.2), i.e. the fencing check every write
 * goes through.
 *
 * Refusal reasons are typed so the caller can annotate the mirror:
 * - `stale-epoch` — the write carries an epoch below the high-water mark. This is the
 *   split-brain case: the writer was fenced while it was partitioned and must stop, even
 *   if its lease still looks unexpired locally.
 * - `lease-held-by-other` / `lease-expired` / `no-lease` — no authority at all.
 *
 * An epoch *above* the high-water mark is accepted and raises the mark: the only way to
 * learn about a newer grant is to be told about it, and the number is the truth.
 *
 * @param {unknown} state
 * @param {{ owner?: unknown, epoch?: unknown, now?: unknown }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason?: 'invalid-write' | 'stale-epoch' | 'lease-held-by-other' | 'lease-expired' | 'no-lease',
 *   epoch: number,
 *   currentEpoch: number,
 *   holder?: string,
 *   state: MirrorState,
 *   readOnly: boolean,
 * }}
 */
export function assertWritable(state, options = {}) {
  const base = normalizeMirrorState(state)
  const owner = textOrNull(options.owner)
  const epoch = finiteNumber(options.epoch)
  const now = finiteNumber(options.now)
  const high = currentEpoch(base)
  if (owner === null || epoch === null || now === null || epoch < 0) {
    return { ok: false, reason: 'invalid-write', epoch: high, currentEpoch: high, state: base, readOnly: true }
  }
  if (epoch < high) {
    // Fenced: someone else owns a strictly newer epoch. Never write, never lower the mark.
    return {
      ok: false,
      reason: 'stale-epoch',
      epoch,
      currentEpoch: high,
      holder: base.lease?.owner,
      state: base,
      readOnly: true,
    }
  }
  const lease = base.lease ?? null
  if (lease === null) {
    return { ok: false, reason: 'no-lease', epoch, currentEpoch: high, state: base, readOnly: true }
  }
  if (lease.owner !== owner) {
    return {
      ok: false,
      reason: 'lease-held-by-other',
      epoch,
      currentEpoch: high,
      holder: lease.owner,
      state: base,
      readOnly: true,
    }
  }
  if (lease.expiresAt <= now) {
    return {
      ok: false,
      reason: 'lease-expired',
      epoch,
      currentEpoch: high,
      holder: lease.owner,
      state: base,
      readOnly: true,
    }
  }
  // Accepted. A writer presenting a newer epoch than we know raises the mark, so the
  // next stale write is recognised without waiting for a lease refresh.
  const raised = epoch > (base.epoch ?? 0) ? { ...base, epoch } : base
  return { ok: true, epoch, currentEpoch: Math.max(high, epoch), state: raised, readOnly: false }
}

/**
 * Compare the lease authority the remote reports with ours (design §6.2/§7).
 *
 * A different writer id or an epoch above ours is a **fencing event**: we have been
 * overtaken, so the local side stops writing and keeps the mirror readable. Reporting is
 * typed and idempotent per epoch — the caller emits one notice per occurrence instead of
 * one per sync (`fenced: false` means "already known, stay quiet").
 *
 * @param {unknown} state
 * @param {{ writer?: unknown, epoch?: unknown, now?: unknown }} [report]
 * @returns {{
 *   fenced: boolean,
 *   changed: boolean,
 *   reason?: 'fenced-by-newer-epoch' | 'writer-changed',
 *   holder?: string,
 *   epoch: number,
 *   state: MirrorState,
 *   readOnly: boolean,
 * }}
 */
export function observeRemoteLease(state, report = {}) {
  const base = normalizeMirrorState(state)
  const writer = textOrNull(report.writer)
  const epoch = finiteNumber(report.epoch)
  const high = currentEpoch(base)
  // No usable report: nothing is known, so nothing changes and nothing is announced.
  if (writer === null && epoch === null) {
    return { fenced: false, changed: false, epoch: high, state: base, readOnly: false }
  }
  const theirs = epoch === null ? 0 : epoch
  const ours = base.lease ?? null
  if (theirs > high) {
    // They hold a newer grant. Adopt the number (so we are fenced from now on), **drop our
    // own lease** — a fenced writer must not be able to renew the epoch it just lost — and
    // report the takeover; only a *new* number is an occurrence.
    return {
      fenced: true,
      changed: true,
      reason: 'fenced-by-newer-epoch',
      holder: writer ?? ours?.owner,
      epoch: theirs,
      state: { ...base, epoch: theirs, lease: null, fencedWriter: writer ?? ours?.owner ?? null },
      readOnly: true,
    }
  }
  if (theirs === high && writer !== null && ours !== null && ours.owner !== writer) {
    // Same epoch, different writer. Still fenced, and again our lease is no longer ours to
    // hold. `changed` is only true the first time this writer is seen at this epoch —
    // otherwise every sync would announce it again.
    const alreadySeen = base.fencedWriter === writer
    return {
      fenced: true,
      changed: !alreadySeen,
      reason: 'writer-changed',
      holder: writer,
      epoch: theirs,
      state: alreadySeen ? base : { ...base, lease: null, fencedWriter: writer },
      readOnly: true,
    }
  }
  if (theirs === high && ours === null && base.fencedWriter === writer) {
    // We already dropped our lease for this writer: still fenced (we hold nothing), but the
    // occurrence was reported the first time.
    return {
      fenced: true,
      changed: false,
      reason: 'writer-changed',
      holder: writer,
      epoch: theirs,
      state: base,
      readOnly: true,
    }
  }
  return { fenced: false, changed: false, epoch: high, state: base, readOnly: false }
}

// ------------------------------------------------------------------- levels

/**
 * Decide the highest level this host can actually deliver (design §4 选型,
 * §4.2 capability gate, §7 failure table).
 *
 * Downgrade rules, in order: an unknown version or a version mismatch stops at
 * L1 (`version-unknown` / `version-mismatch`, the code docs/api.md already names);
 * a missing probe stops at L1 (`probe-missing`); an unreadable remote directory
 * stops at L1 (`list-unavailable`); no history replay stops at L1
 * (`history-unavailable`); no event stream stops at L2 (`stream-unavailable`);
 * no input or approval channel stops at L2 (`input-unavailable` /
 * `approve-unavailable`). Only a fully verified probe reaches L3 with
 * `reason: null`.
 *
 * @param {{ hostVersion?: unknown, localVersion?: unknown, probe?: unknown }} [input]
 * @returns {{
 *   level: MirrorLevel,
 *   downgraded: boolean,
 *   reason: MirrorReason | null,
 *   capabilities: MirrorCapabilities,
 *   versionParity: { local: string | null, host: string | null, same: boolean },
 * }}
 */
export function decideLevel(input = {}) {
  const hostVersion = versionOrNull(input.hostVersion)
  const localVersion = versionOrNull(input.localVersion)
  const capabilities = normalizeCapabilities(input.probe)
  const probeUsable = input.probe !== null && typeof input.probe === 'object'
  const same = hostVersion !== null && localVersion !== null && versionsEqual(hostVersion, localVersion)
  /**
   * @param {MirrorLevel} level
   * @param {string | null} code
   * @param {{ zh: string, en: string } | null} detail
   */
  const build = (level, code, detail) => ({
    level,
    downgraded: level !== MIRROR_LEVELS.L3,
    reason: code === null || detail === null ? null : { code, detail },
    capabilities,
    versionParity: { local: localVersion, host: hostVersion, same },
  })

  if (hostVersion === null || localVersion === null) {
    return build(MIRROR_LEVELS.L1, 'version-unknown', {
      zh: '无法确定本地或远端 DSH 版本，按目录镜像（L1）处理。',
      en: 'The local or remote DSH version is unknown, so the mirror stays at the directory level (L1).',
    })
  }
  if (!same) {
    return build(MIRROR_LEVELS.L1, 'version-mismatch', {
      zh: `远端 DSH（${hostVersion}）与本机（${localVersion}）版本不一致，只做目录镜像（L1）。`,
      en: `Remote DSH (${hostVersion}) differs from this machine (${localVersion}); directory mirror only (L1).`,
    })
  }
  if (!probeUsable) {
    return build(MIRROR_LEVELS.L1, 'probe-missing', {
      zh: '尚未探测远端会话能力，只做目录镜像（L1）。',
      en: 'Remote session capabilities have not been probed, so the mirror stays at L1.',
    })
  }
  if (!capabilities.list) {
    return build(MIRROR_LEVELS.L1, 'list-unavailable', {
      zh: '远端会话目录不可读，只保留本地已知记录（L1）。',
      en: 'The remote session directory is unreadable, so only the last known local records remain (L1).',
    })
  }
  if (!capabilities.history) {
    return build(MIRROR_LEVELS.L1, 'history-unavailable', {
      zh: '远端没有可用的历史回放接口，只做目录镜像（L1）。',
      en: 'The remote exposes no history replay, so the mirror stays at the directory level (L1).',
    })
  }
  if (!capabilities.stream) {
    return build(MIRROR_LEVELS.L2, 'stream-unavailable', {
      zh: '远端事件流不可用，会话为只读镜像（L2）。',
      en: 'The remote event stream is unavailable, so the session is a read-only mirror (L2).',
    })
  }
  if (!capabilities.input) {
    return build(MIRROR_LEVELS.L2, 'input-unavailable', {
      zh: '远端不接受输入转发，会话为只读镜像（L2）。',
      en: 'The remote does not accept forwarded input, so the session is a read-only mirror (L2).',
    })
  }
  if (!capabilities.approve) {
    return build(MIRROR_LEVELS.L2, 'approve-unavailable', {
      zh: '远端审批无法回传本地，会话只读（L2）。',
      en: 'Remote approvals cannot be carried back locally, so the session is read-only (L2).',
    })
  }
  return build(MIRROR_LEVELS.L3, null, null)
}

/**
 * Decide whether a local mirror session must re-pull from the remote.
 *
 * `ctx.sessions` is in-memory only: a mirror session created outside the agent
 * lifecycle persists nothing (design §4.1), so after a restart the local copy is
 * gone even though the descriptor still claims `cursor > 0`. The only correct
 * answer is to re-create the session and re-pull from the remote starting at 0;
 * the notice is what the UI shows so the user is not surprised.
 *
 * @param {{ cursor?: unknown, live?: unknown }} [input]
 * @returns {{
 *   needed: boolean,
 *   from: number,
 *   reason: 'local-session-missing' | null,
 *   notice: { zh: string, en: string } | null,
 * }}
 */
export function decideResync(input = {}) {
  const cursor = nonNegativeInteger(input.cursor) ?? 0
  if (input.live === true) return { needed: false, from: cursor, reason: null, notice: null }
  return {
    needed: true,
    from: 0,
    reason: 'local-session-missing',
    notice: {
      zh: '本地镜像会话在重启后不保留（P0 未挂载写入者），将从远端重新拉取。',
      en: 'Mirror sessions do not survive a restart yet (P0 attaches no writer); this mirror re-pulls from the remote.',
    },
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Accept the parsed workspace list (`{ workspaces: [...] }`), a bare list, or the
 * raw DSH registry (`{ tables: { workspaces: { id: entry } } }`) so the planner
 * can be pointed straight at `storages/workspace.json`.
 * @param {unknown} value
 * @returns {Record<string, any>[]}
 */
function workspaceList(value) {
  const keep = (/** @type {unknown} */ entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  if (Array.isArray(value)) return value.filter(keep)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = /** @type {Record<string, any>} */ (value)
  if (Array.isArray(record.workspaces)) return record.workspaces.filter(keep)
  const table = record.tables?.workspaces
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    return Object.entries(table)
      .filter(([, entry]) => keep(entry))
      .map(([id, entry]) => ({ .../** @type {Record<string, any>} */ (entry), id }))
  }
  return []
}

/**
 * @param {Record<string, any>} workspace
 * @returns {string[]}
 */
function sessionIdsOf(workspace) {
  if (!Array.isArray(workspace.sessionIds)) return []
  /** @type {string[]} */
  const out = []
  for (const raw of workspace.sessionIds) {
    const id = textOrNull(raw)
    if (id !== null) out.push(id)
  }
  return out
}

/**
 * @param {Record<string, any>} workspace
 * @returns {string}
 */
function workspaceTitle(workspace) {
  const title = textOrNull(workspace.title)
  if (title !== null) return title
  const pathValue = typeof workspace.path === 'string' ? workspace.path : ''
  const base = pathValue.split(/[\\/]/).filter(Boolean).pop()
  if (base) return base
  return textOrNull(workspace.id) ?? 'remote'
}

/**
 * L1 placeholder title; L2 replaces it with the remote session title.
 * @param {string} baseTitle
 * @param {string} remoteSessionId
 * @returns {string}
 */
function mirrorTitle(baseTitle, remoteSessionId) {
  const short = remoteSessionId.length > 8 ? remoteSessionId.slice(0, 8) : remoteSessionId
  const title = `${baseTitle} · ${short}`
  return title.length > 120 ? title.slice(0, 120) : title
}

/**
 * @param {readonly unknown[] | null | undefined} descriptors
 * @returns {Map<string, MirrorDescriptor>}
 */
function indexDescriptors(descriptors) {
  /** @type {Map<string, MirrorDescriptor>} */
  const index = new Map()
  if (!Array.isArray(descriptors)) return index
  for (const raw of descriptors) {
    const descriptor = normalizeMirrorDescriptor(raw)
    if (descriptor !== null) index.set(descriptor.localSessionId, descriptor)
  }
  return index
}

/**
 * @param {readonly unknown[] | null | undefined} descriptors
 * @returns {MirrorDescriptor[]}
 */
function normalizeDescriptorList(descriptors) {
  if (!Array.isArray(descriptors)) return []
  /** @type {MirrorDescriptor[]} */
  const out = []
  for (const raw of descriptors) {
    const descriptor = normalizeMirrorDescriptor(raw)
    if (descriptor !== null) out.push(descriptor)
  }
  return out
}

/**
 * @param {unknown} state
 * @returns {MirrorState}
 */
function normalizeMirrorState(state) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? /** @type {any} */ (state) : {}
  /** @type {MirrorState} */
  const out = { cursor: nonNegativeInteger(source.cursor) ?? 0 }
  if (Array.isArray(source.events)) {
    out.events = source.events.filter(isMirrorEvent).map((/** @type {MirrorEvent} */ event) => ({ ...event }))
  }
  if (source.lease !== undefined) out.lease = normalizeLease(source.lease)
  if (source.status === 'remote-deleted') out.status = 'remote-deleted'
  // The fencing high-water mark outlives the lease: it is what stops an epoch from being
  // reused after expiry/release, so it must survive normalisation (and therefore a
  // restart, since it is persisted with the descriptor).
  const epoch = nonNegativeInteger(source.epoch)
  if (epoch !== null) out.epoch = epoch
  if (Array.isArray(source.conflicts)) {
    out.conflicts = capConflicts(
      source.conflicts.filter(isMirrorConflict).map((/** @type {MirrorConflict} */ conflict) => ({ ...conflict })),
    )
  }
  const conflictCount = nonNegativeInteger(source.conflictCount)
  if (conflictCount !== null) out.conflictCount = conflictCount
  const fencedWriter = textOrNull(source.fencedWriter)
  if (fencedWriter !== null) out.fencedWriter = fencedWriter
  return out
}

/**
 * @param {unknown} value
 * @returns {value is MirrorConflict}
 */
function isMirrorConflict(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    nonNegativeInteger(/** @type {any} */ (value).seq) !== null &&
    typeof (/** @type {any} */ (value).kept === 'string' && typeof (/** @type {any} */ (value).lost) === 'string')
  )
}

/**
 * @param {unknown} value
 * @returns {value is MirrorEvent}
 */
function isMirrorEvent(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && nonNegativeInteger(value.seq) !== null
}

/**
 * Sort, dedupe and validate a batch of remote events, **reporting** duplicate-`seq`
 * payload conflicts instead of dropping them silently.
 *
 * Keep-first stays the policy (the first record for a seq is the one that gets applied),
 * but every later record that disagrees is described in `conflicts` with a bounded
 * summary of both sides. Identical duplicates are not conflicts — a replayed batch is
 * normal and must not look like data loss.
 *
 * @param {unknown} events
 * @returns {{ events: MirrorEvent[], conflicts: MirrorConflict[] }}
 */
function normalizeEventsDetailed(events) {
  if (!Array.isArray(events)) return { events: [], conflicts: [] }
  /** @type {Map<number, MirrorEvent>} */
  const bySeq = new Map()
  /** @type {MirrorConflict[]} */
  const conflicts = []
  for (const entry of events) {
    if (!isMirrorEvent(entry)) continue
    const seq = nonNegativeInteger(entry.seq)
    if (seq === null || seq < FIRST_EVENT_SEQ) continue
    const kept = bySeq.get(seq)
    if (kept === undefined) {
      bySeq.set(seq, entry)
      continue
    }
    if (eventDigest(kept) !== eventDigest(entry)) {
      conflicts.push({ seq, kept: eventDigest(kept), lost: eventDigest(entry) })
    }
  }
  const sorted = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
  // Not capped here: the *stored* history is capped (`capConflicts` when merging into the
  // state), but the count of distinct conflicts in this batch must stay exact — capping
  // first would make `conflictCount` under-report and let the counter track the visible
  // window instead of reality. The list is bounded by the caller's batch anyway.
  return { events: sorted, conflicts }
}

/**
 * A bounded, stable fingerprint of an event for conflict reporting.
 *
 * Deliberately shallow: the report is for humans and tests, and must never copy an
 * attachment or a large tool payload into the descriptor.
 *
 * The clipped preview alone is **not** a fingerprint — two payloads that differ only after
 * the limit would look identical, which would hide the very conflict being reported. A
 * short hash of the full text rides along so distinct payloads stay distinguishable while
 * the preview stays readable.
 * @param {MirrorEvent} event
 * @returns {string}
 */
function eventDigest(event) {
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const data = event.data && typeof event.data === 'object' ? /** @type {any} */ (event.data) : null
  const text =
    data === null
      ? ''
      : typeof data.text === 'string'
        ? data.text
        : typeof data.content === 'string'
          ? data.content
          : typeof data.role === 'string'
            ? data.role
            : ''
  const clipped = text.length > CONFLICT_TEXT_LIMIT ? `${text.slice(0, CONFLICT_TEXT_LIMIT)}…` : text
  if (clipped === '') return type
  return `${type}: ${clipped} #${shortHash(text)}`
}

/**
 * A short stable digest, only used to keep clipped conflict previews distinguishable.
 * @param {string} text
 * @returns {string}
 */
function shortHash(text) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(-7)
}

/**
 * Trim a conflict list to the newest `MIRROR_CONFLICT_LIMIT` entries.
 * @param {MirrorConflict[]} conflicts
 * @returns {MirrorConflict[]}
 */
function capConflicts(conflicts) {
  return conflicts.length <= MIRROR_CONFLICT_LIMIT ? conflicts : conflicts.slice(-MIRROR_CONFLICT_LIMIT)
}

/**
 * @param {unknown} raw
 * @returns {MirrorLease | null}
 */
function normalizeLease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = /** @type {Record<string, any>} */ (raw)
  const owner = textOrNull(record.owner)
  const acquiredAt = finiteNumber(record.acquiredAt)
  const expiresAt = finiteNumber(record.expiresAt)
  if (owner === null || acquiredAt === null || expiresAt === null) return null
  return {
    owner,
    acquiredAt,
    renewedAt: finiteNumber(record.renewedAt) ?? acquiredAt,
    expiresAt,
    // A lease persisted before fencing existed has no epoch; it is treated as epoch 1 so
    // an upgrade cannot leave a writer permanently fenced against its own old lease.
    epoch: nonNegativeInteger(record.epoch) ?? 1,
  }
}

/** @param {unknown} value @returns {number | null} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** @param {unknown} value @returns {number | null} */
function nonNegativeInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/** @param {unknown} value @returns {string | null} */
function textOrNull(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * @param {unknown} value
 * @returns {MirrorLevel | null} a supported level, or null for anything else
 */
function levelOrNull(value) {
  return value === MIRROR_LEVELS.L1 || value === MIRROR_LEVELS.L2 || value === MIRROR_LEVELS.L3 ? value : null
}

/**
 * Normalize a descriptor reason. `decideLevel` reports `{ code, detail }`;
 * descriptors persist `{ code, message }`. Both shapes are accepted so a stored
 * descriptor and a fresh decision can share this validator.
 * @param {unknown} value
 * @returns {MirrorDescriptorReason | null}
 */
function descriptorReason(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = /** @type {Record<string, any>} */ (value)
  const code = textOrNull(record.code)
  const detail = record.message ?? record.detail
  if (code === null || !detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const zh = textOrNull(/** @type {Record<string, any>} */ (detail).zh)
  const en = textOrNull(/** @type {Record<string, any>} */ (detail).en)
  if (zh === null || en === null) return null
  return { code, message: { zh, en } }
}

/**
 * @param {unknown} value
 * @returns {string | null} ISO-8601 timestamp, or null when unusable
 */
function toIsoTime(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/**
 * @param {unknown} value
 * @returns {string | null} normalized version, or null when absent
 */
function versionOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return normalizeVersion(value.trim())
}

/** @param {string} left @param {string} right @returns {number} */
function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Nulls sort last so descriptors without a workspace stay grouped at the end.
 * @param {string | null} left
 * @param {string | null} right
 * @returns {number}
 */
function compareNullableText(left, right) {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return compareText(left, right)
}

// client/src/connect-logs.ts - the connect-log channel's merge rules (R1 preserve, R2 seed, R3 apply): cursor, dedupe, reset; after api-client.ts, before primitives.ts.
/** The statuses with a connect window: only these hosts carry log rows, so an empty `logs` array is readable. */
// That is how a state frame alone tells "no window" from "rows come on the other channel".
const CONNECT_LOG_STATUSES: HostStatus[] = ['connecting', 'fingerprint-pending', 'error']
/** The Client keeps the Host's window, so the panel never drifts from the `/state` tail. */
const CONNECT_LOG_LIMIT = 120
/** One host's position: the publish generation, the attempt and the newest `seq` — together the ordering key. */
interface LogCursor {
  instance: string | null
  attempt: number
  seq: number
}
type LogCursors = Map<string, LogCursor>
type MaybeState = StateView | null
type LogFrameResult = { state: MaybeState; applied: boolean }
function connectLogVisible(host: HostView | null | undefined): boolean {
  return Boolean(host) && CONNECT_LOG_STATUSES.indexOf(host.status) >= 0
}
function lastLogSeq(entries: unknown): number {
  if (!Array.isArray(entries) || entries.length === 0) return 0
  const last = entries[entries.length - 1]
  return last && typeof last.seq === 'number' ? last.seq : 0
}
/** The cursor a `HostView` claims: with `logAttempt`/`logSeq` the Host states it; older ones take the newest `seq`. */
function logCursorOfHost(host: HostView, instance: string | null, previous: LogCursor | null): LogCursor {
  const tailSeq = lastLogSeq(host.logs)
  const claimed = typeof host.logSeq === 'number' && Number.isFinite(host.logSeq) ? host.logSeq : tailSeq
  const claimedAttempt =
    typeof host.logAttempt === 'number' && Number.isFinite(host.logAttempt) ? host.logAttempt : null
  const attempt = claimedAttempt !== null ? claimedAttempt : previous !== null ? previous.attempt : 0
  const floor = previous !== null && previous.attempt === attempt ? previous.seq : 0
  return { instance, attempt, seq: Math.max(claimed, tailSeq, floor) }
}
function mergeLogEntries(existing: ConnectLogEntry[], incoming: ConnectLogEntry[]): ConnectLogEntry[] {
  const current = Array.isArray(existing) ? existing : []
  if (!Array.isArray(incoming) || incoming.length === 0) return current
  const known = new Set(current.map((entry) => entry && entry.seq))
  const added: ConnectLogEntry[] = []
  for (const entry of incoming) {
    if (!entry || typeof entry.seq !== 'number' || known.has(entry.seq)) continue
    known.add(entry.seq)
    added.push(entry)
  }
  if (added.length === 0) return current
  const merged = current.concat(added)
  merged.sort((left, right) => (left.seq || 0) - (right.seq || 0))
  return merged.length > CONNECT_LOG_LIMIT ? merged.slice(-CONNECT_LOG_LIMIT) : merged
}
function sameLogSeqs(left: ConnectLogEntry[], right: ConnectLogEntry[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index].seq !== right[index].seq) return false
  return true
}
function withHostLogs(state: StateView, index: number, host: HostView, logs: ConnectLogEntry[]): StateView {
  const hosts = state.hosts.slice()
  hosts[index] = Object.assign({}, host, { logs })
  return Object.assign({}, state, { hosts })
}
/** R1: a state frame carries `logs: []`, so merged rows survive it; inline rows re-anchor the cursor instead. */
// A host that left the log-visible set loses its rows.
function mergeStatePreservingLogs(previous: MaybeState, next: MaybeState, cursors: LogCursors): MaybeState {
  if (!next || typeof next !== 'object' || !Array.isArray(next.hosts)) return next
  const instance = stateInstance(next)
  const previousHosts = previous && Array.isArray(previous.hosts) ? previous.hosts : []
  const hosts = next.hosts.map((host) => {
    if (!host || typeof host !== 'object') return host
    const incoming = Array.isArray(host.logs) ? host.logs : []
    if (incoming.length > 0) {
      cursors.set(host.id, logCursorOfHost(host, instance, cursors.get(host.id) || null))
      const windowed = incoming.length > CONNECT_LOG_LIMIT ? incoming.slice(-CONNECT_LOG_LIMIT) : incoming
      return windowed === incoming ? host : Object.assign({}, host, { logs: windowed })
    }
    const carried = previousHosts.find((item) => item && item.id === host.id)
    const logs = connectLogVisible(host) && carried && Array.isArray(carried.logs) ? carried.logs : []
    return Object.assign({}, host, { logs })
  })
  return Object.assign({}, next, { hosts })
}
/** R2: `GET /state` is the authoritative tail, and merging it is idempotent, so it applies even when unpaintable. */
// The revision gate is about state, not rows, which keeps the panel complete while the log channel is down.
function seedLogsFromSnapshot(state: MaybeState, snapshot: MaybeState, cursors: LogCursors): MaybeState {
  if (!state || !Array.isArray(state.hosts)) return state
  if (!snapshot || !Array.isArray(snapshot.hosts)) return state
  const instance = stateInstance(snapshot)
  let changed = false
  const hosts = state.hosts.map((host) => {
    if (!host || typeof host !== 'object') return host
    const from = snapshot.hosts.find((item) => item && item.id === host.id)
    if (!from) return host
    const incoming = Array.isArray(from.logs) ? from.logs : []
    if (incoming.length === 0) return host
    const existing = Array.isArray(host.logs) ? host.logs : []
    const anchor = logCursorOfHost(from, instance, cursors.get(host.id) || null)
    const current = cursors.get(host.id) || null
    if (current && anchor.instance === current.instance && anchor.attempt < current.attempt) return host
    const merged = mergeLogEntries(existing, incoming)
    cursors.set(host.id, {
      instance: anchor.instance,
      attempt: anchor.attempt,
      seq: Math.max(anchor.seq, lastLogSeq(merged)),
    })
    if (merged === existing) return host
    changed = true
    return Object.assign({}, host, { logs: merged })
  })
  return changed ? Object.assign({}, state, { hosts }) : state
}
/** R3: apply one `log` frame; the cursor orders and dedupes: newer replaces, older drops, same keeps rows past it. */
// `reset` rebuilds from the frame, and `applied: false` means nothing visible changed (so no render).
function applyLogFrame(state: MaybeState, frame: ConnectLogFrame, cursors: LogCursors): LogFrameResult {
  if (!state || !Array.isArray(state.hosts)) return { state, applied: false }
  if (!frame || typeof frame.hostId !== 'string') return { state, applied: false }
  const index = state.hosts.findIndex((host) => host && host.id === frame.hostId)
  if (index < 0) return { state, applied: false }
  const host = state.hosts[index]
  const current = Array.isArray(host.logs) ? host.logs : []
  const cursor = cursors.get(frame.hostId) || null
  const instance = stateInstance(state)
  const frameInstance = typeof frame.instance === 'string' && frame.instance !== '' ? frame.instance : null
  if (instance !== null && frameInstance !== null && frameInstance !== instance) {
    cursors.delete(frame.hostId)
    if (current.length === 0) return { state, applied: false }
    return { state: withHostLogs(state, index, host, []), applied: true }
  }
  const attempt = typeof frame.attempt === 'number' && Number.isFinite(frame.attempt) ? frame.attempt : 0
  // The frame's own `seq` claim, read once: both the no-change path and the applied one advance on it.
  const frameSeq = typeof frame.seq === 'number' && Number.isFinite(frame.seq) ? frame.seq : null
  const entries = Array.isArray(frame.entries) ? frame.entries : []
  if (cursor !== null && attempt < cursor.attempt) return { state, applied: false }
  const advance = (seq: number) =>
    cursors.set(frame.hostId, { instance: frameInstance !== null ? frameInstance : instance, attempt, seq })
  const reset = frame.reset === true || (cursor !== null && attempt > cursor.attempt)
  let logs
  if (reset) {
    logs = entries.length > CONNECT_LOG_LIMIT ? entries.slice(-CONNECT_LOG_LIMIT) : entries
  } else {
    const floor = cursor !== null && cursor.instance === instance ? cursor.seq : -1
    const fresh = entries.filter((entry) => entry && typeof entry.seq === 'number' && entry.seq > floor)
    if (fresh.length === 0) {
      advance(cursor !== null ? cursor.seq : lastLogSeq(current))
      return { state, applied: false }
    }
    logs = mergeLogEntries(current, fresh)
  }
  const sameAttempt = cursor === null || attempt === cursor.attempt
  if (sameAttempt && sameLogSeqs(current, logs)) {
    advance(frameSeq ?? lastLogSeq(logs))
    return { state, applied: false }
  }
  advance(frameSeq ?? Math.max(lastLogSeq(logs), attempt))
  return { state: withHostLogs(state, index, host, logs), applied: true }
}

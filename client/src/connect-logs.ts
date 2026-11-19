// client/src/connect-logs.ts - the connect-log channel's merge rules (R1 preserve, R2 seed, R3 apply): cursor, dedupe, reset; after api-client.ts, before primitives.ts.
//#region 6a. connect log merge

/**
 * The statuses whose connect window is on screen: only these hosts carry log rows (contract
 * `CONNECT_LOG_STATUSES`). The Host decides the same set; the Client repeats it so a state frame
 * alone can tell whether an empty `logs` array means "no window" or "rows come on the other
 * channel" (docs/api.md v2.12).
 */
const CONNECT_LOG_STATUSES: HostStatus[] = ['connecting', 'fingerprint-pending', 'error']

/** The Client keeps the Host's window, so the panel never drifts from the `/state` tail. */
const CONNECT_LOG_LIMIT = 120

/**
 * One host's position in the log stream: the publish generation it was merged under, the attempt
 * (the boundary line's N) and the `seq` of the newest rendered row. `(attempt, seq)` is the
 * contract's only ordering and dedupe key (docs/api.md `ConnectLogFrame`).
 */
interface LogCursor {
  instance: string | null
  attempt: number
  seq: number
}

/** The per-host cursors of one page; the merge functions mutate it in place. */
type LogCursors = Map<string, LogCursor>

/** Whether this host currently has a connect window (and therefore a log tail). */
function connectLogVisible(host: HostView | null | undefined): boolean {
  return Boolean(host) && CONNECT_LOG_STATUSES.indexOf(host.status) >= 0
}

/** The `seq` of the newest row an array holds (`0` for an empty or absent one). */
function lastLogSeq(entries: unknown): number {
  if (!Array.isArray(entries) || entries.length === 0) return 0
  const last = entries[entries.length - 1]
  return last && typeof last.seq === 'number' ? last.seq : 0
}

/**
 * The cursor a `HostView` claims. A Host that has `logAttempt`/`logSeq` (from v2.12) states it;
 * an older Host only has the tail, so the newest `seq` is the cursor and the attempt is whatever
 * this page last saw (0 until a frame says otherwise).
 */
function logCursorOfHost(host: HostView, instance: string | null, previous: LogCursor | null): LogCursor {
  const tailSeq = lastLogSeq(host.logs)
  const claimed = typeof host.logSeq === 'number' && Number.isFinite(host.logSeq) ? host.logSeq : tailSeq
  const attempt =
    typeof host.logAttempt === 'number' && Number.isFinite(host.logAttempt)
      ? host.logAttempt
      : previous !== null
        ? previous.attempt
        : 0
  // A new attempt restarts `seq` at 1: carrying the old high-water mark across it would filter
  // out every fresh row.
  const floor = previous !== null && previous.attempt === attempt ? previous.seq : 0
  return { instance, attempt, seq: Math.max(claimed, tailSeq, floor) }
}

/** Merge rows by `seq` (never twice), keeping them ordered and inside the tail window. */
function mergeLogEntries(existing: ConnectLogEntry[], incoming: ConnectLogEntry[]): ConnectLogEntry[] {
  const current = Array.isArray(existing) ? existing : []
  if (!Array.isArray(incoming) || incoming.length === 0) return current
  const known = new Set(current.map((entry) => entry && entry.seq))
  const added: ConnectLogEntry[] = []
  for (const entry of incoming) {
    if (!entry || typeof entry.seq !== 'number') continue
    if (known.has(entry.seq)) continue
    known.add(entry.seq)
    added.push(entry)
  }
  if (added.length === 0) return current
  const merged = current.concat(added)
  merged.sort((left, right) => (left.seq || 0) - (right.seq || 0))
  return merged.length > CONNECT_LOG_LIMIT ? merged.slice(-CONNECT_LOG_LIMIT) : merged
}

/** Whether two row arrays hold the same cursors (then a frame changes nothing on screen). */
function sameLogSeqs(left: ConnectLogEntry[], right: ConnectLogEntry[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].seq !== right[index].seq) return false
  }
  return true
}

/** A copy of the state tree with one host's rows replaced. */
function withHostLogs(state: StateView, index: number, host: HostView, logs: ConnectLogEntry[]): StateView {
  const hosts = state.hosts.slice()
  hosts[index] = Object.assign({}, host, { logs })
  return Object.assign({}, state, { hosts })
}

/**
 * R1: a state frame carries `logs: []` (v2.12), so the rows this page already merged survive it.
 * A frame that *does* inline rows (an older Host, or a hand-fed fixture) is authoritative for its
 * own tail and re-anchors the cursor. A host that left the log-visible set loses its rows.
 */
function mergeStatePreservingLogs(
  previous: StateView | null,
  next: StateView | null,
  cursors: LogCursors,
): StateView | null {
  if (!next || typeof next !== 'object' || !Array.isArray(next.hosts)) return next
  const instance = stateInstance(next)
  const previousHosts = previous && Array.isArray(previous.hosts) ? previous.hosts : []
  const hosts = next.hosts.map((host) => {
    if (!host || typeof host !== 'object') return host
    const incoming = Array.isArray(host.logs) ? host.logs : []
    const prior = cursors.get(host.id) || null
    if (incoming.length > 0) {
      cursors.set(host.id, logCursorOfHost(host, instance, prior))
      const windowed = incoming.length > CONNECT_LOG_LIMIT ? incoming.slice(-CONNECT_LOG_LIMIT) : incoming
      return windowed === incoming ? host : Object.assign({}, host, { logs: windowed })
    }
    const carried = previousHosts.find((item) => item && item.id === host.id)
    const logs = connectLogVisible(host) && carried && Array.isArray(carried.logs) ? carried.logs : []
    return Object.assign({}, host, { logs })
  })
  return Object.assign({}, next, { hosts })
}

/**
 * R2: `GET /state` is the authoritative tail, and merging it is idempotent — so it applies even
 * when the payload is too old to paint (the revision gate is about state, not about rows). This is
 * what keeps the panel complete while the log channel is unavailable (docs/api.md 降级).
 */
function seedLogsFromSnapshot(
  state: StateView | null,
  snapshot: StateView | null,
  cursors: LogCursors,
): StateView | null {
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
    // A snapshot may be older than what the log channel already delivered: never move a cursor
    // backwards into an older attempt of the same generation.
    if (current && anchor.instance === current.instance && anchor.attempt < current.attempt) return host
    const merged = mergeLogEntries(existing, incoming)
    // The cursor must cover rows the log channel already merged, or the next incremental frame
    // would re-send them (they dedupe, but they would still be work for nothing).
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

/**
 * R3: apply one `log` frame (docs/api.md §3.3). Ordering and dedupe are the cursor's job:
 * a newer attempt replaces the rows, an older attempt is dropped, the same attempt keeps only
 * rows past its cursor, and `reset` rebuilds from the frame. `applied: false` means the frame
 * changed nothing this page can see (so no render).
 */
function applyLogFrame(
  state: StateView | null,
  frame: ConnectLogFrame,
  cursors: LogCursors,
): { state: StateView | null; applied: boolean } {
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
    // Another publish generation: these rows describe a Host process this page no longer talks to.
    // Forget them and the cursor; the next state frame brings the new generation's reset frame.
    cursors.delete(frame.hostId)
    if (current.length === 0) return { state, applied: false }
    return { state: withHostLogs(state, index, host, []), applied: true }
  }
  const attempt = typeof frame.attempt === 'number' && Number.isFinite(frame.attempt) ? frame.attempt : 0
  const entries = Array.isArray(frame.entries) ? frame.entries : []
  if (cursor !== null && attempt < cursor.attempt) return { state, applied: false }
  const reset = frame.reset === true || (cursor !== null && attempt > cursor.attempt)
  let logs
  if (reset) {
    logs = entries.length > CONNECT_LOG_LIMIT ? entries.slice(-CONNECT_LOG_LIMIT) : entries
  } else {
    const floor = cursor !== null && cursor.instance === instance ? cursor.seq : -1
    const fresh = entries.filter((entry) => entry && typeof entry.seq === 'number' && entry.seq > floor)
    if (fresh.length === 0) {
      // Nothing new, but the attempt/instance may still have moved: keep the cursor honest.
      cursors.set(frame.hostId, {
        instance: frameInstance !== null ? frameInstance : instance,
        attempt,
        seq: cursor !== null ? cursor.seq : lastLogSeq(current),
      })
      return { state, applied: false }
    }
    logs = mergeLogEntries(current, fresh)
  }
  const sameAttempt = cursor === null || attempt === cursor.attempt
  if (sameAttempt && sameLogSeqs(current, logs)) {
    // A replay of rows already on screen (a reconnect, or the reset frame after `GET /state`):
    // keep the new cursor, but do not repaint.
    cursors.set(frame.hostId, {
      instance: frameInstance !== null ? frameInstance : instance,
      attempt,
      seq: typeof frame.seq === 'number' && Number.isFinite(frame.seq) ? frame.seq : lastLogSeq(logs),
    })
    return { state, applied: false }
  }
  const seq =
    typeof frame.seq === 'number' && Number.isFinite(frame.seq) ? frame.seq : Math.max(lastLogSeq(logs), attempt)
  cursors.set(frame.hostId, {
    instance: frameInstance !== null ? frameInstance : instance,
    attempt,
    seq,
  })
  return { state: withHostLogs(state, index, host, logs), applied: true }
}

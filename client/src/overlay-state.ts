// client/src/overlay-state.ts - stateRevision/stateInstance/isNewerState/useRemoteState, the only /state subscriber and the log merge owner; after toast.ts, before manage-window.ts.
//#region 15. overlay host (floating windows + remote window)

/**
 * Accept a state frame only when it is not older than what is already on screen. The Host
 * stamps every snapshot with a monotonic `rev` (docs/api.md); SSE frames and slow `GET /state`
 * responses can arrive out of order, and a stale one used to paint the UI backwards (a
 * connected host flipping to `connecting`, or `disconnected` after a newer frame). A Host
 * from before `rev` sends no number and keeps the old last-writer-wins behaviour.
 */
function stateRevision(state) {
  return state && typeof state.rev === 'number' && Number.isFinite(state.rev) ? state.rev : null
}
/**
 * The Host's publish generation. `rev` restarts at 0 with every Host process / plugin
 * reload, so a Client holding the old high-water mark would reject every new frame forever.
 * A frame from another generation is accepted regardless of its revision.
 */
function stateInstance(state) {
  return state && typeof state.instance === 'string' && state.instance !== '' ? state.instance : null
}
function isNewerState(next, currentRev, currentInstance) {
  const instance = stateInstance(next)
  if (instance !== null && currentInstance !== null && instance !== currentInstance) return true
  const rev = stateRevision(next)
  if (rev === null) return true
  return !(typeof currentRev === 'number' && rev <= currentRev)
}

function useRemoteState(initialState, onDownload) {
  const hasInitial = initialState !== undefined && initialState !== null
  const [state, setState] = useState(hasInitial ? initialState : null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(!hasInitial)
  const [mode, setMode] = useState('idle')
  const alive = useRef(true)
  const revRef = useRef(stateRevision(initialState))
  const instanceRef = useRef(stateInstance(initialState))
  const streamRef = useRef(null)
  // The last state this hook computed. `setState` alone cannot be read synchronously, and both
  // merge paths (a frame, a log row) need the current tree; keeping the ref ahead of the render
  // is what makes two frames arriving in one tick merge instead of overwrite each other.
  const stateRef = useRef(hasInitial ? initialState : null)
  /**
   * Per-host log cursors (docs/api.md `ConnectLogFrame`). They live beside the state, not inside
   * it: the cursor is transport bookkeeping and must never reach the DOM or a React key.
   */
  const cursorsRef = useRef<LogCursors | null>(null)
  if (cursorsRef.current === null) {
    const cursors = new Map()
    // A server-rendered initial state carries the tail of a Host that may already be connecting:
    // seed from it so the first `reset` frame adds nothing on screen.
    if (hasInitial) seedLogsFromSnapshot(initialState, initialState, cursors)
    cursorsRef.current = cursors
  }
  /** R2: merge a payload's authoritative tail, whatever the revision gate later decides. */
  const seedLogs = (next) => {
    const current = stateRef.current
    if (current === null) return
    const seeded = seedLogsFromSnapshot(current, next, cursorsRef.current)
    if (seeded === current) return
    stateRef.current = seeded
    setState(seeded)
  }
  const applyState = (next) => {
    seedLogs(next)
    if (!isNewerState(next, revRef.current, instanceRef.current)) return false
    instanceRef.current = stateInstance(next) ?? instanceRef.current
    revRef.current = stateRevision(next) ?? revRef.current
    // R1: a v2.12 state frame carries `logs: []`; the rows this page merged stay on screen.
    const merged = mergeStatePreservingLogs(stateRef.current, next, cursorsRef.current)
    stateRef.current = merged
    setState(merged)
    return true
  }
  const applyLog = useCallback((frame) => {
    if (!alive.current) return
    const current = stateRef.current
    if (current === null) return
    // R3: dedupe/replace by cursor. `applied: false` means the frame changed nothing visible.
    const result = applyLogFrame(current, frame, cursorsRef.current)
    if (!result.applied) return
    stateRef.current = result.state
    setState(result.state)
  }, [])
  const applyLogEnd = useCallback((end) => {
    // The host left the log-visible set: its cursor is spent. The rows stay until the next state
    // frame drops them with the connect window (R1), so nothing has to be painted here.
    if (end && typeof end.hostId === 'string') cursorsRef.current.delete(end.hostId)
  }, [])
  const downloadHandler = useRef(typeof onDownload === 'function' ? onDownload : () => {})
  downloadHandler.current = typeof onDownload === 'function' ? onDownload : () => {}
  const refresh = useCallback(() => {
    setLoading(true)
    // The revision (and publish generation) this refresh was requested at: a response that
    // is not newer than it is stale even when it is the last one to resolve.
    const requestedAt = revRef.current
    const requestedInstance = instanceRef.current
    return api.getState().then(
      (next) => {
        if (!alive.current) return
        // The log tail of a snapshot is append-only, so it merges even when the snapshot itself
        // is too old to paint (a slower `/state` must not lose rows the log channel missed).
        seedLogs(next)
        if (!isNewerState(next, requestedAt, requestedInstance)) {
          setLoading(false)
          return
        }
        applyState(next)
        setError(null)
        setLoading(false)
      },
      (readError) => {
        if (!alive.current) return
        setError(toErrorView(readError))
        setLoading(false)
      },
    )
  }, [])
  useEffect(() => {
    alive.current = true
    const dispose = subscribeState({
      onState: (next) => {
        if (!alive.current) return
        if (!applyState(next)) return
        // A frame that is newer than the screen is also newer than any pending refresh: a
        // refresh that resolves after it will be dropped by `isNewerState`.
        setError(null)
        setLoading(false)
      },
      onStatus: (nextMode) => {
        if (alive.current) setMode(nextMode)
      },
      onError: (readError) => {
        if (!alive.current) return
        setError(toErrorView(readError))
        setLoading(false)
      },
      onDownload: (job) => {
        if (alive.current) downloadHandler.current(job)
      },
    })
    streamRef.current = dispose
    return () => {
      alive.current = false
      streamRef.current = null
      dispose()
    }
  }, [])
  const patch = useCallback((updater) => {
    setState((current) => {
      const next = current === null ? current : updater(current)
      if (next !== current) stateRef.current = next
      return next
    })
  }, [])
  const reconnectStream = useCallback(() => {
    const dispose = streamRef.current
    if (dispose && typeof dispose.reconnect === 'function') dispose.reconnect()
  }, [])
  return { state, error, loading, mode, refresh, patch, reconnectStream, applyLog, applyLogEnd }
}

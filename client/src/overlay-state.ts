// client/src/overlay-state.ts - stateRevision/stateInstance/isNewerState/useRemoteState, the only /state subscriber; after toast.ts, before manage-window.ts.
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
  const applyState = (next) => {
    if (!isNewerState(next, revRef.current, instanceRef.current)) return false
    instanceRef.current = stateInstance(next) ?? instanceRef.current
    revRef.current = stateRevision(next) ?? revRef.current
    setState(next)
    return true
  }
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
    setState((current) => (current === null ? current : updater(current)))
  }, [])
  const reconnectStream = useCallback(() => {
    const dispose = streamRef.current
    if (dispose && typeof dispose.reconnect === 'function') dispose.reconnect()
  }, [])
  return { state, error, loading, mode, refresh, patch, reconnectStream }
}

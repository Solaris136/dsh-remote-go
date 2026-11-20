// client/src/overlay-state.ts - stateRevision/stateInstance/isNewerState/createFrameBatch/createLogPump/useRemoteState, the only /state subscriber and the log merge owner; after toast.ts, before manage-window.ts.
/** Accept a frame only if it is not older than what is on screen: every snapshot carries a monotonic `rev`. */
// Out-of-order frames painted the UI backwards once; a Host without `rev` keeps last-writer-wins.
function stateRevision(state: StateView | null | undefined): number | null {
  return state && typeof state.rev === 'number' && Number.isFinite(state.rev) ? state.rev : null
}
/** The publish generation: `rev` restarts at 0 on every reload, so another generation is accepted regardless. */
function stateInstance(state: StateView | null | undefined): string | null {
  return state && typeof state.instance === 'string' && state.instance !== '' ? state.instance : null
}
function isNewerState(next: StateView, currentRev: number | null, currentInstance: string | null): boolean {
  const instance = stateInstance(next)
  if (instance !== null && currentInstance !== null && instance !== currentInstance) return true
  const rev = stateRevision(next)
  if (rev === null) return true
  return !(typeof currentRev === 'number' && rev <= currentRev)
}
/** Ask for one callback on the next display frame; the handle is handed back to `cancel`. */
type FrameSchedule = (callback: () => void) => number
/** Give a scheduled frame back so its callback cannot run (`0` means nothing was scheduled). */
type FrameCancel = (handle: number) => void
/** The page's frame callback with a task as the fallback: a page without `requestAnimationFrame` still repaints. */
// Both are looked up per call since the embedding page may replace them; `0` means nothing to cancel.
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  if (typeof setTimeout === 'function') return setTimeout(callback, 0)
  callback()
  return 0
}
function cancelFrame(handle: number): void {
  if (handle <= 0) return
  if (typeof cancelAnimationFrame === 'function' && typeof requestAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }
  if (typeof clearTimeout === 'function') clearTimeout(handle)
}
/** The handle `createFrameBatch` returns: one `run` at most per display frame. */
type FrameBatch = { request: () => void; flush: () => void; cancel: () => void; pending: () => boolean }
/** Coalesce a burst of "repaint now" into one `run` per frame: the Host answers every log line with an SSE frame. */
// `run` reads whatever is live when it executes, so a deferral paints the newest tree at most one frame late.
function createFrameBatch(run: () => void, schedule?: FrameSchedule, cancel?: FrameCancel): FrameBatch {
  const arm = typeof schedule === 'function' ? schedule : scheduleFrame
  const drop = typeof cancel === 'function' ? cancel : cancelFrame
  let handle = 0
  let armed = false
  const runNow = () => {
    armed = false
    handle = 0
    run()
  }
  const take = () => {
    const pending = handle
    armed = false
    handle = 0
    return pending
  }
  return {
    request() {
      if (armed) return
      armed = true
      handle = arm(runNow)
    },
    flush() {
      if (!armed) return
      drop(take())
      run()
    },
    cancel() {
      if (!armed) return
      drop(take())
    },
    pending: () => armed,
  }
}
type LogPumpOptions = {
  read: () => StateView | null
  deliver: (state: StateView) => void
  cursors: () => LogCursors
  alive: () => boolean
  schedule?: FrameSchedule
  cancel?: FrameCancel
}
type LogPump = { push: (frame: ConnectLogFrame) => void; flush: () => void; cancel: () => void; pending: () => boolean }
/** Queue `log` frames and paint once per frame: the paint waits, not the merge, since frame order is its key. */
// Merging at paint time also means a tree this page already replaced is never painted back over it.
function createLogPump(options: LogPumpOptions): LogPump {
  const frames: ConnectLogFrame[] = []
  const batch = createFrameBatch(paint, options.schedule, options.cancel)
  function paint() {
    const current = options.read()
    if (!options.alive() || current === null || current === undefined) {
      frames.length = 0
      return
    }
    const cursors = options.cursors()
    let state = current
    let changed = false
    for (const frame of frames.splice(0, frames.length)) {
      const result = applyLogFrame(state, frame, cursors)
      if (!result.applied) continue
      state = result.state
      changed = true
    }
    if (changed) options.deliver(state)
  }
  return {
    push(frame) {
      frames.push(frame)
      batch.request()
    },
    flush: () => batch.flush(),
    cancel() {
      batch.cancel()
      frames.length = 0
    },
    pending: () => frames.length > 0 || batch.pending(),
  }
}
function useRemoteState(initialState: StateView | null | undefined, onDownload?: DownloadJobHandler): RemoteState {
  const hasInitial = initialState !== undefined && initialState !== null
  const [state, setState] = useState<StateView | null>(hasInitial ? initialState : null)
  const [error, setError] = useState<ErrorView | null>(null)
  const [loading, setLoading] = useState(!hasInitial)
  const [mode, setMode] = useState<StreamMode>('idle')
  const alive = useRef(true)
  const revRef = useRef<number | null>(stateRevision(initialState))
  const instanceRef = useRef<string | null>(stateInstance(initialState))
  const streamRef = useRef<StateStreamDispose | null>(null)
  // The last state computed: `setState` cannot be read synchronously, so the ref makes two frames in one tick merge.
  const stateRef = useRef<StateView | null>(hasInitial ? initialState : null)
  // Per-host log cursors live beside the state: transport bookkeeping that must never reach the DOM or a React key.
  const cursorsRef = useRef<LogCursors | null>(null)
  if (cursorsRef.current === null) {
    const cursors: LogCursors = new Map()
    if (hasInitial) seedLogsFromSnapshot(initialState, initialState, cursors)
    cursorsRef.current = cursors
  }
  const pumpRef = useRef<LogPump | null>(null)
  if (pumpRef.current === null) {
    pumpRef.current = createLogPump({
      read: () => stateRef.current,
      deliver: (next) => {
        stateRef.current = next
        setState(next)
      },
      cursors: () => cursorsRef.current,
      alive: () => alive.current,
    })
  }
  const seedLogs = (next: StateView) => {
    const current = stateRef.current
    if (current === null) return
    const seeded = seedLogsFromSnapshot(current, next, cursorsRef.current)
    if (seeded === current) return
    stateRef.current = seeded
    setState(seeded)
  }
  const applyState = (next: StateView): boolean => {
    seedLogs(next)
    if (!isNewerState(next, revRef.current, instanceRef.current)) return false
    instanceRef.current = stateInstance(next) ?? instanceRef.current
    revRef.current = stateRevision(next) ?? revRef.current
    const merged = mergeStatePreservingLogs(stateRef.current, next, cursorsRef.current)
    stateRef.current = merged
    setState(merged)
    return true
  }
  const applyLog = useCallback((frame: ConnectLogFrame) => {
    if (alive.current) pumpRef.current.push(frame)
  }, [])
  const applyLogEnd = useCallback((end: ConnectLogEnd) => {
    pumpRef.current.flush()
    if (end && typeof end.hostId === 'string') cursorsRef.current.delete(end.hostId)
  }, [])
  const downloadHandler = useRef<DownloadJobHandler>(typeof onDownload === 'function' ? onDownload : () => {})
  downloadHandler.current = typeof onDownload === 'function' ? onDownload : () => {}
  // Both read paths fail the same way: leave the loading state and show the error view, unless the page is gone.
  const failWith = (readError: unknown) => {
    if (!alive.current) return
    setError(toErrorView(readError))
    setLoading(false)
  }
  const refresh = useCallback(() => {
    setLoading(true)
    const requestedAt = revRef.current
    const requestedInstance = instanceRef.current
    return api.getState().then((next: StateView) => {
      if (!alive.current) return
      seedLogs(next)
      if (!isNewerState(next, requestedAt, requestedInstance)) {
        setLoading(false)
        return
      }
      applyState(next)
      setError(null)
      setLoading(false)
    }, failWith)
  }, [])
  useEffect(() => {
    alive.current = true
    const dispose = subscribeState({
      onState: (next: StateView) => {
        if (!alive.current) return
        if (!applyState(next)) return
        setError(null)
        setLoading(false)
      },
      onStatus: (nextMode: StreamMode) => {
        if (alive.current) setMode(nextMode)
      },
      onError: failWith,
      onDownload: (job: DownloadJobView) => {
        if (alive.current) downloadHandler.current(job)
      },
    })
    streamRef.current = dispose
    return () => {
      alive.current = false
      streamRef.current = null
      pumpRef.current.cancel()
      dispose()
    }
  }, [])
  const patch = useCallback((updater: (current: StateView) => StateView) => {
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

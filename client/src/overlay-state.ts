// client/src/overlay-state.ts - stateRevision/stateInstance/isNewerState/createFrameBatch/createLogPump/useRemoteState, the only /state subscriber and the log merge owner; after toast.ts, before manage-window.ts.
//#region 15. overlay host (floating windows + remote window)

/**
 * Accept a state frame only when it is not older than what is already on screen. The Host
 * stamps every snapshot with a monotonic `rev` (docs/api.md); SSE frames and slow `GET /state`
 * responses can arrive out of order, and a stale one used to paint the UI backwards (a
 * connected host flipping to `connecting`, or `disconnected` after a newer frame). A Host
 * from before `rev` sends no number and keeps the old last-writer-wins behaviour.
 */
function stateRevision(state: StateView | null | undefined): number | null {
  return state && typeof state.rev === 'number' && Number.isFinite(state.rev) ? state.rev : null
}
/**
 * The Host's publish generation. `rev` restarts at 0 with every Host process / plugin
 * reload, so a Client holding the old high-water mark would reject every new frame forever.
 * A frame from another generation is accepted regardless of its revision.
 */
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

/** Ask for one callback on the next display frame; the returned handle is handed back to `cancel`. */
type FrameSchedule = (callback: () => void) => number
/** Give a scheduled frame back so its callback cannot run (`0` means nothing was scheduled). */
type FrameCancel = (handle: number) => void

/**
 * The page's own frame callback, with a task as the fallback: a page that has no
 * `requestAnimationFrame` (a document stub, or a host that removed it) still has to repaint, and
 * one `setTimeout(0)` is the same "not this task, but the next" promise.
 *
 * Both are looked up per call rather than captured at load: they are globals the embedding page
 * may replace, and nothing has been scheduled at load time.
 */
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  if (typeof setTimeout === 'function') return setTimeout(callback, 0)
  // No timer at all (a host that stripped both): running now beats never painting. `0` tells the
  // caller nothing is left to cancel.
  callback()
  return 0
}
function cancelFrame(handle: number): void {
  if (handle <= 0) return
  // The frame pair is cancelled by its own API; a page with one but not the other would leave the
  // callback armed, so both have to be present for the frame path to be taken.
  if (typeof cancelAnimationFrame === 'function' && typeof requestAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }
  if (typeof clearTimeout === 'function') clearTimeout(handle)
}

/** The handle `createFrameBatch` returns: one `run` at most per display frame. */
interface FrameBatch {
  /** Ask for a run in the next frame; a second request inside the same frame does nothing. */
  request: () => void
  /** Run the pending frame now (a caller that cannot wait), then drop it. */
  flush: () => void
  /** Drop the pending frame without running it (teardown). */
  cancel: () => void
  /** Whether a run is still owed to this frame. */
  pending: () => boolean
}

/**
 * Coalesce a burst of "repaint now" requests into one `run` per display frame.
 *
 * Why this exists: the Host answers every log line with its own SSE frame, so a connection emits
 * dozens per second and each one used to be a React render of the whole overlay — including the
 * management window a user may be typing into. Merging inside one frame keeps the content and its
 * order (the frames themselves are not touched here) and costs at most one frame of latency.
 *
 * `run` reads whatever is live when it executes, which is the property that makes the deferral
 * safe: it paints the newest tree, never the one that happened to be current when the frame was
 * asked for.
 */
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
  return {
    request() {
      if (armed) return
      armed = true
      handle = arm(runNow)
    },
    flush() {
      if (!armed) return
      const pending = handle
      armed = false
      handle = 0
      drop(pending)
      run()
    },
    cancel() {
      if (!armed) return
      const pending = handle
      armed = false
      handle = 0
      drop(pending)
    },
    pending() {
      return armed
    },
  }
}

/** What the log pump needs from the hook: the live tree, the way back into React, and the panel. */
interface LogPumpOptions {
  /** The tree a frame merges into, or `null`/`undefined` while the first `/state` read is in flight. */
  read: () => StateView | null
  /** Hand a merged tree back (the hook keeps it as its live tree and asks React to paint). */
  deliver: (state: StateView) => void
  /** The per-host `(attempt, seq)` cursors the merge advances. */
  cursors: () => LogCursors
  /** Once the panel is gone nothing may be delivered. */
  alive: () => boolean
  schedule?: FrameSchedule
  cancel?: FrameCancel
}

/** The connect-log channel's paint path. */
interface LogPump {
  /** Queue one `log` frame: no merge and no paint happens here. */
  push: (frame: ConnectLogFrame) => void
  /** Apply and paint the queued frames now (the end of an attempt cannot wait a frame). */
  flush: () => void
  /** Drop the queued frames and the pending frame (the panel unmounted). */
  cancel: () => void
  /** Whether a frame is queued or a paint is owed. */
  pending: () => boolean
}

/**
 * Queue `log` frames and paint them once per display frame.
 *
 * The *paint* waits, not the merge, and the merge runs at paint time for two reasons: the frame
 * order is the merge's ordering key (`applyLogFrame` advances a per-host cursor, so a burst has to
 * be applied in arrival order), and applying it to the tree React holds *then* means a tree this
 * page already replaced (a saved setting, a newer state frame) is never painted back over it. The
 * one tree that can still lose is a `patch` React has queued but not yet committed: it commits
 * after this paint and is overwritten for a single state frame, which is the same window a
 * same-tick log frame always had, and the Host's next state frame restores it.
 *
 * Rows are not lost when a paint is skipped for an empty state: the next `/state` frame carries
 * the same tail (R2) and the log channel re-sends nothing it has not already sent.
 */
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
    // A frame that only replayed rows already on screen changes nothing: same as R3 returning
    // `applied: false`, there is no reason to paint.
    if (changed) options.deliver(state)
  }
  return {
    push(frame) {
      frames.push(frame)
      batch.request()
    },
    flush() {
      batch.flush()
    },
    cancel() {
      batch.cancel()
      frames.length = 0
    },
    pending() {
      return frames.length > 0 || batch.pending()
    },
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
  // The last state this hook computed. `setState` alone cannot be read synchronously, and both
  // merge paths (a frame, a log row) need the current tree; keeping the ref ahead of the render
  // is what makes two frames arriving in one tick merge instead of overwrite each other.
  const stateRef = useRef<StateView | null>(hasInitial ? initialState : null)
  /**
   * Per-host log cursors (docs/api.md `ConnectLogFrame`). They live beside the state, not inside
   * it: the cursor is transport bookkeeping and must never reach the DOM or a React key.
   */
  const cursorsRef = useRef<LogCursors | null>(null)
  if (cursorsRef.current === null) {
    const cursors: LogCursors = new Map()
    // A server-rendered initial state carries the tail of a Host that may already be connecting:
    // seed from it so the first `reset` frame adds nothing on screen.
    if (hasInitial) seedLogsFromSnapshot(initialState, initialState, cursors)
    cursorsRef.current = cursors
  }
  /**
   * The log channel's queue (one paint per display frame, W2). Built once: it only reads refs and
   * the stable `setState`, so a render-recreated closure is not needed and would drop a queued
   * frame on every render.
   */
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
  /** R2: merge a payload's authoritative tail, whatever the revision gate later decides. */
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
    // R1: a v2.12 state frame carries `logs: []`; the rows this page merged stay on screen.
    const merged = mergeStatePreservingLogs(stateRef.current, next, cursorsRef.current)
    stateRef.current = merged
    setState(merged)
    return true
  }
  const applyLog = useCallback((frame: ConnectLogFrame) => {
    if (!alive.current) return
    // W2: the frame is queued, not merged. `createLogPump` applies every frame that arrived inside
    // this display frame in arrival order and paints once; the merge rules themselves are
    // `applyLogFrame`'s and are unchanged.
    pumpRef.current.push(frame)
  }, [])
  const applyLogEnd = useCallback((end: ConnectLogEnd) => {
    // The host left the log-visible set: its cursor is spent. The rows stay until the next state
    // frame drops them with the connect window (R1), so nothing has to be painted here - but a
    // queued frame still belongs to the cursor this end retires, so it is merged first.
    pumpRef.current.flush()
    if (end && typeof end.hostId === 'string') cursorsRef.current.delete(end.hostId)
  }, [])
  const downloadHandler = useRef<DownloadJobHandler>(typeof onDownload === 'function' ? onDownload : () => {})
  downloadHandler.current = typeof onDownload === 'function' ? onDownload : () => {}
  const refresh = useCallback(() => {
    setLoading(true)
    // The revision (and publish generation) this refresh was requested at: a response that
    // is not newer than it is stale even when it is the last one to resolve.
    const requestedAt = revRef.current
    const requestedInstance = instanceRef.current
    return api.getState().then(
      (next: StateView) => {
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
      (readError: unknown) => {
        if (!alive.current) return
        setError(toErrorView(readError))
        setLoading(false)
      },
    )
  }, [])
  useEffect(() => {
    alive.current = true
    const dispose = subscribeState({
      onState: (next: StateView) => {
        if (!alive.current) return
        if (!applyState(next)) return
        // A frame that is newer than the screen is also newer than any pending refresh: a
        // refresh that resolves after it will be dropped by `isNewerState`.
        setError(null)
        setLoading(false)
      },
      onStatus: (nextMode: StreamMode) => {
        if (alive.current) setMode(nextMode)
      },
      onError: (readError: unknown) => {
        if (!alive.current) return
        setError(toErrorView(readError))
        setLoading(false)
      },
      onDownload: (job: DownloadJobView) => {
        if (alive.current) downloadHandler.current(job)
      },
    })
    streamRef.current = dispose
    return () => {
      alive.current = false
      streamRef.current = null
      // A paint that is still owed must not reach an unmounted panel.
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

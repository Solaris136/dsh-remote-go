// client/src/log-stream.ts - subscribeConnectLog: the connect-log SSE channel, its backoff, its off-switch and the overlay hook; after connect-logs.ts, before primitives.ts.
interface ConnectLogHandlers {
  applyLog: (frame: ConnectLogFrame) => void
  applyLogEnd: (end: ConnectLogEnd) => void
}
interface ConnectLogSubHandlers {
  onFrame?: (frame: ConnectLogFrame) => void
  onEnd?: (end: ConnectLogEnd) => void
  onMode?: (mode: ConnectLogMode) => void
}
interface ConnectLogStream {
  dispose: () => void
  setEnabled: (enabled: boolean) => void
  reconnect: () => void
}
/** The connect-log channel: one stream per connect window, carrying `log`, `log-end` and `ping` frames. */
// It is not part of `subscribeState`, which owns the revision gate, the polling fallback and the banner.
// Retry on the same backoff, never poll, and switch off on a 404, so an older Host has no reconnect loop.
function subscribeConnectLog(handlers: ConnectLogSubHandlers): ConnectLogStream {
  const onFrame: (frame: ConnectLogFrame) => void = typeof handlers.onFrame === 'function' ? handlers.onFrame : () => {}
  const onEnd: (end: ConnectLogEnd) => void = typeof handlers.onEnd === 'function' ? handlers.onEnd : () => {}
  const onMode: (mode: ConnectLogMode) => void = typeof handlers.onMode === 'function' ? handlers.onMode : () => {}
  let disposed = false
  let enabled = false
  let offForGood = false
  let everLive = false
  let source: EventSource | null = null
  let retryTimer: TimerHandle | null = null
  let retryAttempt = 0
  let mode: ConnectLogMode = 'idle'
  const setMode = (next: ConnectLogMode) => {
    if (mode === next) return
    mode = next
    if (!disposed) onMode(next)
  }
  const stopStream = () => {
    if (source === null) return
    try {
      source.close()
    } catch (_error) {
      // swallow-ok: EventSource.close is idempotent; a lost close leaves no resource
    }
    source = null
  }
  const clearRetry = () => {
    if (retryTimer !== null && typeof clearTimeout === 'function') clearTimeout(retryTimer)
    retryTimer = null
  }
  const scheduleRetry = () => {
    if (disposed || !enabled || offForGood || retryTimer !== null) return
    if (retryAttempt >= STREAM_RETRY_MAX_ATTEMPTS) {
      setMode('off')
      return
    }
    if (typeof setTimeout !== 'function') return
    const attempt = retryAttempt
    retryAttempt += 1
    setMode('reconnecting')
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!disposed && enabled && !offForGood) startStream()
    }, streamRetryDelay(attempt))
    unrefTimer(retryTimer)
  }
  const markLive = () => {
    everLive = true
    retryAttempt = 0
    setMode('live')
  }
  const startStream = () => {
    if (disposed || !enabled || offForGood) return
    if (typeof EventSource !== 'function') {
      offForGood = true
      setMode('off')
      return
    }
    stopStream()
    let stream: EventSource
    try {
      stream = new EventSource(LOG_EVENT_PATH)
    } catch (_error) {
      scheduleRetry()
      return
    }
    source = stream
    stream.addEventListener('log', (event: MessageEvent<string>) => {
      if (source !== stream) return
      let frame = null
      try {
        frame = JSON.parse(event.data)
      } catch (_error) {
        // swallow-ok: one malformed log frame must not kill the stream; the next frame is parsed
      }
      markLive()
      if (frame && typeof frame === 'object') onFrame(frame)
    })
    stream.addEventListener('log-end', (event: MessageEvent<string>) => {
      if (source !== stream) return
      try {
        const end = JSON.parse(event.data)
        markLive()
        if (end && typeof end === 'object') onEnd(end)
      } catch (_error) {
        // swallow-ok: one malformed log-end frame must not kill the stream
      }
    })
    stream.addEventListener('ping', () => {
      if (source === stream) markLive()
    })
    stream.addEventListener('error', () => {
      if (disposed || source !== stream) return
      // A permanent refusal (404, or a non-SSE body) leaves it CLOSED; a dropped connection leaves it CONNECTING.
      // Only a CLOSED stream that never delivered a frame means "no log channel"; later it means "the Host went away".
      const permanent = stream.readyState === 2 && !everLive
      stopStream()
      if (permanent) {
        offForGood = true
        setMode('off')
        return
      }
      scheduleRetry()
    })
  }
  const setEnabled = (next: boolean) => {
    const wanted = next === true
    if (wanted === enabled) return
    enabled = wanted
    retryAttempt = 0
    clearRetry()
    if (!wanted) {
      stopStream()
      setMode('off')
      return
    }
    startStream()
  }
  const reconnect = () => {
    if (disposed || !enabled || offForGood) return
    retryAttempt = 0
    clearRetry()
    startStream()
  }
  return {
    dispose: () => {
      disposed = true
      clearRetry()
      stopStream()
    },
    setEnabled,
    reconnect,
  }
}
/** The one log subscription: created with the panel, enabled while a host has a connect window, torn down with it. */
// Handlers go through a ref to keep the effect's deps empty; returns a stable `reconnect()` for the banner's retry.
function useConnectLogStream(remote: RemoteState): () => void {
  const streamRef = useRef<ConnectLogStream | null>(null)
  const handlersRef = useRef<ConnectLogHandlers>({ applyLog: () => {}, applyLogEnd: () => {} })
  handlersRef.current = { applyLog: remote.applyLog, applyLogEnd: remote.applyLogEnd }
  useEffect(() => {
    const stream = subscribeConnectLog({
      onFrame: (frame) => handlersRef.current.applyLog(frame),
      onEnd: (end) => handlersRef.current.applyLogEnd(end),
      onMode: () => {},
    })
    streamRef.current = stream
    return () => {
      stream.dispose()
      streamRef.current = null
    }
  }, [])
  const state = remote.state
  const hosts = state && Array.isArray(state.hosts) ? state.hosts : []
  const needsLogs = hosts.some((host) => connectLogVisible(host))
  useEffect(() => {
    const stream = streamRef.current
    if (stream !== null) stream.setEnabled(needsLogs)
  }, [needsLogs])
  return useCallback(() => {
    const stream = streamRef.current
    if (stream !== null) stream.reconnect()
  }, [])
}

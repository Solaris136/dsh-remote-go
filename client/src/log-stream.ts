// client/src/log-stream.ts - subscribeConnectLog: the connect-log SSE channel, its backoff, its off-switch and the overlay hook; after connect-logs.ts, before primitives.ts.
//#region 6b. connect log stream

/** The two row sinks the overlay hands the channel (swapped per render, read through a ref). */
interface ConnectLogHandlers {
  applyLog: (frame: unknown) => void
  applyLogEnd: (end: unknown) => void
}

/** The handle `subscribeConnectLog` returns (and the overlay keeps for the banner's retry). */
interface ConnectLogStream {
  dispose: () => void
  setEnabled: (enabled: boolean) => void
  reconnect: () => void
}

/**
 * The connect-log channel (docs/api.md `GET /events/logs`): one multiplexed stream for every host
 * with a connect window, carrying `log` / `log-end` / `ping`. It is deliberately *not* wired into
 * `subscribeState`: that one owns the revision gate, the polling fallback and the degraded banner,
 * and a second EventSource inside it would break every existing stream test and every banner
 * promise. This channel only feeds rows.
 *
 * Failure policy: retry with the same backoff as the state stream (no new constants), never poll
 * (the state stream's 3 s `/state` read already carries the tail — that is the documented
 * degradation), and switch off for good when the endpoint does not exist (an older Host answering
 * 404), so an old Host does not get eight pointless reconnects a minute.
 */
function subscribeConnectLog(handlers): ConnectLogStream {
  const onFrame = typeof handlers.onFrame === 'function' ? handlers.onFrame : () => {}
  const onEnd = typeof handlers.onEnd === 'function' ? handlers.onEnd : () => {}
  const onMode = typeof handlers.onMode === 'function' ? handlers.onMode : () => {}
  let disposed = false
  let enabled = false
  let offForGood = false
  let everLive = false
  let source = null
  let retryTimer = null
  let retryAttempt = 0
  let mode = 'idle'

  const setMode = (next) => {
    if (mode === next) return
    mode = next
    if (!disposed) onMode(next)
  }
  const stopStream = () => {
    if (source !== null) {
      try {
        source.close()
      } catch (_error) {
        // swallow-ok: EventSource.close is idempotent; a lost close leaves no resource
      }
      source = null
    }
  }
  const clearRetry = () => {
    if (retryTimer !== null && typeof clearTimeout === 'function') clearTimeout(retryTimer)
    retryTimer = null
  }
  const scheduleRetry = () => {
    if (disposed || !enabled || offForGood || retryTimer !== null) return
    if (retryAttempt >= STREAM_RETRY_MAX_ATTEMPTS) {
      // The automatic chain stops here. The rows keep arriving through `/state` (R2), so this is
      // strictly an internal mode, never a banner.
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
      // No EventSource at all: nothing to fall back to here, the state channel already carries
      // the tail. `off` is the same internal mode as an old Host.
      offForGood = true
      setMode('off')
      return
    }
    stopStream()
    let stream
    try {
      stream = new EventSource(LOG_EVENT_PATH)
    } catch (_error) {
      scheduleRetry()
      return
    }
    source = stream
    stream.addEventListener('log', (event) => {
      if (source !== stream) return
      let frame = null
      try {
        frame = JSON.parse(event.data)
      } catch (_error) {
        // swallow-ok: one malformed log frame must not kill the stream; the next frame is parsed
      }
      // A frame proves the stream works even when `open` never fired.
      markLive()
      if (frame && typeof frame === 'object') onFrame(frame)
    })
    stream.addEventListener('log-end', (event) => {
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
      // A permanent refusal (404 on an older Host, or a non-SSE body) leaves the EventSource
      // CLOSED; a dropped connection leaves it CONNECTING. Only a CLOSED stream that never
      // delivered a frame counts as "this Host has no log channel" — after a live connection the
      // same value only means "the Host went away", which is a retry.
      const permanent = stream.readyState === 2 && !everLive
      stopStream()
      if (permanent) {
        offForGood = true
        setMode('off')
        return
      }
      scheduleRetry()
    })
    // Do not claim `live` on `open`: the state stream learned the same lesson, and an
    // EventSource that opens and immediately dies must not look healthy.
  }
  /** Turn the channel on/off with the connect window; a disabled channel keeps no cursor. */
  const setEnabled = (next) => {
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
  /** A manual retry (the banner's reconnect): the same fresh chain the state stream starts. */
  const reconnect = () => {
    if (disposed || !enabled || offForGood) return
    retryAttempt = 0
    clearRetry()
    startStream()
  }
  const dispose = () => {
    disposed = true
    clearRetry()
    stopStream()
  }
  return { dispose, setEnabled, reconnect }
}

/**
 * The overlay's single log-channel subscription: created once for the panel, enabled only while a
 * host has a connect window, and torn down with the panel. Keeping the two `useEffect`s here (and
 * not inline in the overlay) is what keeps that module inside its budget.
 *
 * The row handlers are read through a ref so the effect keeps its empty dependency list: the hook
 * that owns the state hands out stable callbacks, and a stale closure would silently drop rows.
 * @returns a stable `reconnect()` for the degraded-banner retry (both channels are retried).
 */
function useConnectLogStream(remote) {
  const streamRef = useRef<ConnectLogStream | null>(null)
  const handlersRef = useRef<ConnectLogHandlers>({ applyLog: () => {}, applyLogEnd: () => {} })
  handlersRef.current = { applyLog: remote.applyLog, applyLogEnd: remote.applyLogEnd }
  useEffect(() => {
    const stream = subscribeConnectLog({
      onFrame: (frame) => handlersRef.current.applyLog(frame),
      onEnd: (end) => handlersRef.current.applyLogEnd(end),
      // Internal only: the state channel owns the banner and the polling fallback (docs/api.md),
      // so a dead log channel is never a user-visible error.
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

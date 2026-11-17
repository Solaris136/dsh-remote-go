// client/src/api-client.ts - apiRequest, the api facade and subscribeState (the one /state feed); after errors.ts, before primitives.ts.
//#region 6. HTTP + SSE API client

function getFetch() {
  if (typeof fetch === 'function') return fetch
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window)
  return null
}

/**
 * One request's knobs. The caller builds one inline, `apiRequest` is its only reader, and every
 * member is optional: `GET` without a body is the common case.
 */
interface ApiRequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

/** The error `apiError` throws: a plain `Error` that also carries the view every surface renders. */
interface ApiFailure extends Error {
  view?: LocalErrorView
}

function apiError(view, cause?) {
  const text =
    resolveText(view && view.detail, 'zh') || resolveText(view && view.title, 'zh') || 'dsh-remote-go request failed'
  const error: ApiFailure = new Error(text)
  error.name = 'ApiError'
  error.view = view
  if (cause !== undefined) error.cause = cause
  return error
}

/** One JSON request: the marker header and same-origin credentials are not optional (docs/api.md). */
async function apiRequest(path, options?: ApiRequestOptions) {
  const opts: ApiRequestOptions = options || {}
  const fetcher = getFetch()
  if (!fetcher) throw apiError(localErrorView('network'))
  const method = typeof opts.method === 'string' ? opts.method.toUpperCase() : 'GET'
  const headers: Record<string, string> = { accept: 'application/json', 'x-dsh-remote-go': '1' }
  const init: RequestInit = { method, headers, credentials: 'same-origin' }
  if (opts.signal !== undefined) init.signal = opts.signal
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8'
    init.body = JSON.stringify(opts.body)
  }
  let response
  try {
    response = await fetcher(API_BASE + path, init)
  } catch (cause) {
    throw apiError(localErrorView('network'), cause)
  }
  let payload = null
  try {
    payload = await response.json()
  } catch (_error) {
    payload = null
  }
  if (payload && payload.ok === false) throw apiError(payload.error)
  if (!response || !response.ok) {
    // DSH admission answers without this plugin's JSON envelope. A 401 means the browser
    // session is gone and a 403 means Host/Origin was refused: neither is "internal", and
    // repeating the same request cannot fix either one.
    if (response && response.status === 401) throw apiError(localErrorView('session-expired', 'HTTP 401'))
    if (response && response.status === 403) throw apiError(localErrorView('forbidden', 'HTTP 403'))
    throw apiError(localErrorView('internal', 'HTTP ' + String(response && response.status)))
  }
  if (!payload || payload.ok !== true) throw apiError(localErrorView('internal', 'malformed response'))
  return payload
}

const api = {
  async getState() {
    const payload = await apiRequest('/state')
    return payload.state
  },
  async reportLocalVersion(version) {
    if (typeof version !== 'string' || version.length === 0) return
    try {
      await apiRequest('/local-version', { method: 'POST', body: { version } })
    } catch (_error) {
      // Tolerated by contract: this only backfills the Host's probe.
    }
  },
  async connect(hostId, options) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/connect', {
      method: 'POST',
      body: options || {},
    })
  },
  async confirmConflict(hostId, action) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/conflict', {
      method: 'POST',
      body: { action },
    })
  },
  async disconnect(hostId, stopRemote) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/disconnect', {
      method: 'POST',
      body: { stopRemote: stopRemote === true },
    })
  },
  async reconnect(hostId) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/reconnect', { method: 'POST', body: {} })
  },
  /**
   * Restart the managed remote web on the same SSH session. The Host accepts and
   * reports progress through `/state` (progress code `restarting-remote`); the old
   * launch URL and its tunnel are gone once it finishes.
   */
  async restart(hostId) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/restart', { method: 'POST', body: {} })
  },
  /**
   * Stop the remote DSH this connection manages and release the link. The Host refuses
   * with 409 `stop-unavailable` when the host is not stoppable or the bound pid cannot be
   * proven to be this connection's own; `/state` carries `stopping-remote` while it works.
   */
  async stopRemote(hostId) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/stop-remote', { method: 'POST', body: {} })
  },
  async openHost(hostId) {
    const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/open')
    // The desktop carrier takes the loopback origin; the browser carrier takes the same-origin
    // view path. Both are checked here, so neither backend can be handed anything else.
    if (!isValidLoopbackUrl(payload.url)) throw apiError(localErrorView('blocked-url'))
    const webUrl = typeof payload.webUrl === 'string' ? payload.webUrl : ''
    // A Host from before the web carrier has no webUrl; that must not block the desktop path.
    if (webUrl !== '' && !isValidViewPath(webUrl)) throw apiError(localErrorView('blocked-url'))
    return { url: payload.url, webUrl }
  },
  async acceptFingerprint(hostId, accept, remember, sha256) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/fingerprint', {
      method: 'POST',
      body: { accept: accept === true, remember: remember === true, sha256: sha256 || '' },
    })
  },
  async saveHost(host) {
    const payload = await apiRequest('/hosts', { method: 'POST', body: { host } })
    return payload.host
  },
  /**
   * Remember (or forget) the SSH password without connecting. The Host keeps it in DSH's
   * credential store, never in `hosts.json`; `available:false` means nothing can persist it.
   */
  async saveHostPassword(hostId, options) {
    const body = options || {}
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/password', {
      method: 'POST',
      body: {
        password: typeof body.password === 'string' ? body.password : undefined,
        clear: body.clear === true,
      },
    })
  },
  async deleteHost(hostId) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId), { method: 'DELETE' })
  },
  async diagnose(hostId) {
    const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/diagnose', {
      method: 'POST',
      body: {},
    })
    return payload.report
  },
  async saveSettings(patch) {
    const payload = await apiRequest('/settings', { method: 'POST', body: { patch } })
    return payload.settings
  },
  async activate(hostId) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/activate', { method: 'POST', body: {} })
  },
  async clearActive() {
    return apiRequest('/active', { method: 'POST', body: { id: null } })
  },
  async getAliases() {
    const payload = await apiRequest('/ssh/aliases')
    return {
      aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
      knownHosts: payload.knownHosts && typeof payload.knownHosts === 'object' ? payload.knownHosts : null,
    }
  },
  async listKeyFiles(dir) {
    const query = dir ? '?path=' + encodeURIComponent(dir) : ''
    const payload = await apiRequest('/keyfile/list' + query)
    return {
      path: typeof payload.path === 'string' ? payload.path : '',
      parent: typeof payload.parent === 'string' ? payload.parent : null,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      truncated: payload.truncated === true,
      defaultKeyPath: typeof payload.defaultKeyPath === 'string' ? payload.defaultKeyPath : '',
      defaultDir: typeof payload.defaultDir === 'string' ? payload.defaultDir : '',
    }
  },
  /**
   * Start a Host-side download job for a remote file or folder.
   * The Host streams the content straight into the selected local directory.
   * @param {string} hostId - connected host.
   * @param {string} remotePath - absolute file or folder path.
   * @param {string} destination - local folder chosen by the user.
   * @returns {Promise<object>} the initial job view.
   */
  async startDownload(hostId, remotePath, destination) {
    const payload = await apiRequest('/downloads', {
      method: 'POST',
      body: { hostId, path: remotePath, destination },
    })
    if (!payload.job || typeof payload.job !== 'object') {
      throw apiError(localErrorView('internal', 'malformed download job'))
    }
    return payload.job
  },
  /** Read one job's current status (fallback for a missed SSE frame). */
  async downloadStatus(jobId) {
    const payload = await apiRequest('/downloads/' + encodeURIComponent(jobId) + '/status')
    if (!payload.job || typeof payload.job !== 'object') {
      throw apiError(localErrorView('internal', 'malformed download status'))
    }
    return payload.job
  },
  /** Cancel a preparing/ready job; a missing job is treated as already gone. */
  async cancelDownload(jobId) {
    try {
      await apiRequest('/downloads/' + encodeURIComponent(jobId), { method: 'DELETE' })
      return true
    } catch (_error) {
      return false
    }
  },
}

/**
 * The one `/state` feed for the whole plugin: SSE when it is available, a three-second poll
 * while the stream is down, and an exponential-backoff rebuild of the stream in the
 * background. A reconnected stream stops the poll and reports `live` again. Handlers:
 * `onState(frame)`, `onStatus('live' | 'polling')`, `onError(error)`, `onDownload(job)`.
 * The returned disposer also carries `reconnect()`, which the fallback banner uses.
 */
function subscribeState(handlers) {
  const onState = typeof handlers.onState === 'function' ? handlers.onState : () => {}
  const onStatus = typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {}
  const onError = typeof handlers.onError === 'function' ? handlers.onError : () => {}
  const onDownload = typeof handlers.onDownload === 'function' ? handlers.onDownload : () => {}
  let disposed = false
  let source = null
  let timer = null
  let retryTimer = null
  let retryAttempt = 0
  let polling = false
  let mode = 'idle'
  /** Every callback that settles a state frame, so a late frame can still land. */
  const setMode = (next) => {
    if (mode === next) return
    mode = next
    if (!disposed) onStatus(next)
  }

  const deliver = (state) => {
    if (disposed || !state || typeof state !== 'object') return
    onState(state)
  }
  const fetchOnce = () => {
    if (disposed) return
    api.getState().then(deliver, (error) => {
      if (!disposed) onError(error)
    })
  }
  const stopStream = () => {
    if (source !== null) {
      try {
        source.close()
      } catch (_error) {
        // ignore close failures
      }
      source = null
    }
  }
  const stopPolling = () => {
    polling = false
    if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
    timer = null
  }
  const startPolling = () => {
    if (disposed) return
    if (!polling) {
      polling = true
      if (typeof setInterval === 'function') {
        timer = setInterval(fetchOnce, POLL_INTERVAL_MS)
        unrefTimer(timer)
      }
      fetchOnce()
    }
    setMode('polling')
  }
  const clearRetry = () => {
    if (retryTimer !== null && typeof clearTimeout === 'function') clearTimeout(retryTimer)
    retryTimer = null
  }
  const scheduleStreamRetry = () => {
    if (disposed || retryTimer !== null) return
    if (retryAttempt >= STREAM_RETRY_MAX_ATTEMPTS) {
      // The automatic chain stops here; polling continues and the banner offers a manual
      // reconnect, which resets the counter. This is the cap the UI promises.
      setMode('polling')
      return
    }
    if (typeof setTimeout !== 'function') return
    const attempt = retryAttempt
    retryAttempt += 1
    setMode('reconnecting')
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!disposed) startStream()
    }, streamRetryDelay(attempt))
    unrefTimer(retryTimer)
  }
  const onStreamOpen = () => {
    if (disposed) return
    // The stream is alive again: polling and the retry chain stop, and the backoff resets so
    // the next drop starts from the base delay.
    retryAttempt = 0
    clearRetry()
    stopPolling()
    setMode('live')
  }
  const startStream = () => {
    if (disposed) return
    if (typeof EventSource !== 'function') {
      startPolling()
      scheduleStreamRetry()
      return
    }
    stopStream()
    try {
      source = new EventSource(EVENT_PATH)
    } catch (_error) {
      startPolling()
      scheduleStreamRetry()
      return
    }
    const stream = source
    source.onopen = () => {
      if (source === stream) onStreamOpen()
    }
    source.addEventListener('state', (event) => {
      if (source !== stream) return
      try {
        const state = JSON.parse(event.data)
        // The first frame proves the stream works even when `open` never fired.
        onStreamOpen()
        deliver(state)
      } catch (_error) {
        // a malformed frame must not kill the stream
      }
    })
    source.addEventListener('download', (event) => {
      if (source !== stream) return
      try {
        const job = JSON.parse(event.data)
        if (job && typeof job === 'object') onDownload(job)
      } catch (_error) {
        // a malformed frame must not kill the stream
      }
    })
    source.addEventListener('ping', () => {
      if (source === stream) onStreamOpen()
    })
    source.addEventListener('error', () => {
      if (disposed || source !== stream) return
      // Never leave the panel without data: poll from now on and rebuild the stream with
      // backoff. A successful frame (`onStreamOpen`) turns polling off again.
      startPolling()
      stopStream()
      scheduleStreamRetry()
    })
    // Do not claim `live` here: until `open` (or the first frame/ping) arrives the banner
    // must stay up. A manual or automatic reconnect used to clear it before the stream
    // actually worked (review blocker 2).
  }
  const reconnect = () => {
    if (disposed) return
    retryAttempt = 0
    clearRetry()
    // A manual retry is a fresh attempt even when a scheduled one is in flight.
    if (retryTimer !== null && typeof clearTimeout === 'function') clearTimeout(retryTimer)
    retryTimer = null
    startStream()
    if (mode !== 'live') {
      startPolling()
      // `startPolling` sets `polling`; the retry attempt is the state that keeps the banner
      // saying "reconnecting" until the stream actually opens.
      setMode('reconnecting')
    }
  }

  // Initial read in parallel with opening the stream, so the panel can paint immediately even when SSE is slow.
  fetchOnce()
  startStream()

  const dispose = () => {
    disposed = true
    stopStream()
    stopPolling()
    clearRetry()
  }
  dispose.reconnect = reconnect
  return dispose
}

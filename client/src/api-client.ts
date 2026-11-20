// client/src/api-client.ts - apiRequest, the api facade and subscribeState (the one /state feed); after errors.ts, before primitives.ts.
//#region 6. HTTP + SSE API client

function getFetch(): typeof fetch | null {
  if (typeof fetch === 'function') return fetch
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window)
  return null
}

/** One request's knobs: an inline object whose only reader is `apiRequest`, and `GET` carries no body. */
interface ApiRequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

/** The error `apiError` throws: a plain `Error` that also carries the view every surface renders. */
interface ApiFailure extends Error {
  view?: LocalErrorView
}

function apiError(view?: LocalErrorView, cause?: unknown): ApiFailure {
  const text =
    resolveText(view && view.detail, 'zh') || resolveText(view && view.title, 'zh') || 'dsh-remote-go request failed'
  const error: ApiFailure = new Error(text)
  error.name = 'ApiError'
  error.view = view
  if (cause !== undefined) error.cause = cause
  return error
}

/** The one runtime predicate on a response body: "it is an object", which is what the old truthiness checks did. */
// `T` is the endpoint's frozen response shape from docs/api.md.
function isApiEnvelope<T>(value: unknown): value is T & ApiEnvelope {
  return typeof value === 'object' && value !== null
}

/** One JSON request: the marker header and same-origin credentials are not optional (docs/api.md). */
async function apiRequest<T = Record<string, unknown>>(
  path: string,
  options?: ApiRequestOptions,
): Promise<T & ApiEnvelope> {
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
  let response: Response
  try {
    response = await fetcher(API_BASE + path, init)
  } catch (cause) {
    throw apiError(localErrorView('network'), cause)
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch (_error) {
    payload = null
  }
  if (isApiEnvelope<T>(payload) && payload.ok === false) throw apiError(payload.error)
  if (!response || !response.ok) {
    // DSH admission answers without this plugin's JSON envelope: 401 is a gone session, 403 a refused Host/Origin.
    // Neither is "internal", and repeating the same request cannot fix either one.
    const status = response && response.status
    if (status === 401) throw apiError(localErrorView('session-expired', 'HTTP 401'))
    if (status === 403) throw apiError(localErrorView('forbidden', 'HTTP 403'))
    throw apiError(localErrorView('internal', 'HTTP ' + String(status)))
  }
  if (!isApiEnvelope<T>(payload) || payload.ok !== true)
    throw apiError(localErrorView('internal', 'malformed response'))
  return payload
}

/** A `/hosts/:id` route: the id is percent-encoded here, once per request. */
const hostPath = (hostId: string, suffix = ''): string => '/hosts/' + encodeURIComponent(hostId) + suffix
/** A POST whose body is never absent, so `apiRequest` always sends the JSON content-type. */
const post = <T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T & ApiEnvelope> =>
  apiRequest<T>(path, { method: 'POST', body })

const api = {
  async getState(): Promise<StateView> {
    const payload = await apiRequest<{ state: StateView }>('/state')
    return payload.state
  },
  async reportLocalVersion(version: unknown): Promise<void> {
    if (typeof version !== 'string' || version.length === 0) return
    try {
      await post('/local-version', { version })
    } catch (_error) {
      // swallow-ok: the local half only backfills the Host's version probe; a failed report changes no UI state
    }
  },
  async connect(hostId: string, options?: ConnectRequest) {
    return post(hostPath(hostId, '/connect'), options || {})
  },
  async confirmConflict(hostId: string, action: string) {
    return post(hostPath(hostId, '/conflict'), { action })
  },
  async disconnect(hostId: string, stopRemote: unknown) {
    return post(hostPath(hostId, '/disconnect'), { stopRemote: stopRemote === true })
  },
  async reconnect(hostId: string) {
    return post(hostPath(hostId, '/reconnect'))
  },
  /** Restart the managed remote web on the same SSH session; `/state` reports `restarting-remote` and the old launch URL plus its tunnel are gone once it finishes. */
  async restart(hostId: string) {
    return post<RestartResult>(hostPath(hostId, '/restart'))
  },
  /** Stop the remote DSH this connection manages and release the link. */
  // The Host answers 409 `stop-unavailable` unless the bound pid is provably this connection's own.
  async stopRemote(hostId: string) {
    return post(hostPath(hostId, '/stop-remote'))
  },
  async openHost(hostId: string) {
    const payload = await apiRequest<{ url: unknown; webUrl?: unknown }>(hostPath(hostId, '/open'))
    // Desktop loads the loopback origin, the browser the same-origin view path; both are checked, so neither gets more.
    if (!isValidLoopbackUrl(payload.url)) throw apiError(localErrorView('blocked-url'))
    const webUrl = typeof payload.webUrl === 'string' ? payload.webUrl : ''
    // A Host from before the web carrier has no webUrl; that must not block the desktop path.
    if (webUrl !== '' && !isValidViewPath(webUrl)) throw apiError(localErrorView('blocked-url'))
    return { url: payload.url, webUrl }
  },
  async acceptFingerprint(hostId: string, accept: boolean, remember: boolean, sha256: string) {
    return post(hostPath(hostId, '/fingerprint'), {
      accept: accept === true,
      remember: remember === true,
      sha256: sha256 || '',
    })
  },
  async saveHost(host: HostInputBody) {
    const payload = await post<{ host: HostView }>('/hosts', { host })
    return payload.host
  },
  /** Remember (or forget) the SSH password without connecting; it lives in DSH's credential store, not `hosts.json`. */
  // `available: false` means nothing can persist it.
  async saveHostPassword(hostId: string, options?: SavePasswordRequest) {
    const body = options || {}
    return post(hostPath(hostId, '/password'), {
      password: typeof body.password === 'string' ? body.password : undefined,
      clear: body.clear === true,
    })
  },
  async deleteHost(hostId: string) {
    return apiRequest('/hosts/' + encodeURIComponent(hostId), { method: 'DELETE' })
  },
  async diagnose(hostId: string) {
    const payload = await post<{ report: DiagnoseReport }>(hostPath(hostId, '/diagnose'))
    return payload.report
  },
  async saveSettings(patch: SettingsPatch): Promise<SettingsView> {
    const payload = await post<{ settings: SettingsView }>('/settings', { patch })
    return payload.settings
  },
  async activate(hostId: string) {
    return post(hostPath(hostId, '/activate'))
  },
  async clearActive() {
    return apiRequest('/active', { method: 'POST', body: { id: null } })
  },
  async getAliases(): Promise<SshAliasesResult> {
    const payload = await apiRequest<SshAliasesResult>('/ssh/aliases')
    return {
      aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
      knownHosts: payload.knownHosts && typeof payload.knownHosts === 'object' ? payload.knownHosts : null,
    }
  },
  async listKeyFiles(dir: string): Promise<KeyFileListing> {
    const query = dir ? '?path=' + encodeURIComponent(dir) : ''
    const payload = await apiRequest<Partial<KeyFileListing>>('/keyfile/list' + query)
    return {
      path: typeof payload.path === 'string' ? payload.path : '',
      parent: typeof payload.parent === 'string' ? payload.parent : null,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      truncated: payload.truncated === true,
      defaultKeyPath: typeof payload.defaultKeyPath === 'string' ? payload.defaultKeyPath : '',
      defaultDir: typeof payload.defaultDir === 'string' ? payload.defaultDir : '',
    }
  },
  /** Start a Host-side download job into the selected local folder; the Host streams the content. */
  async startDownload(hostId: string, remotePath: string, destination: string) {
    const payload = await post<{ job?: DownloadJobView }>('/downloads', { hostId, path: remotePath, destination })
    if (!payload.job || typeof payload.job !== 'object') {
      throw apiError(localErrorView('internal', 'malformed download job'))
    }
    return payload.job
  },
  /** Read one job's current status (fallback for a missed SSE frame). */
  async downloadStatus(jobId: string) {
    const payload = await apiRequest<{ job?: DownloadJobView }>('/downloads/' + encodeURIComponent(jobId) + '/status')
    if (!payload.job || typeof payload.job !== 'object') {
      throw apiError(localErrorView('internal', 'malformed download status'))
    }
    return payload.job
  },
  /** Cancel a preparing/ready job; a missing job is treated as already gone. */
  async cancelDownload(jobId: string) {
    try {
      await apiRequest('/downloads/' + encodeURIComponent(jobId), { method: 'DELETE' })
      return true
    } catch (_error) {
      return false
    }
  },
}

/** The one `/state` feed: SSE, else a three-second poll, plus an exponential-backoff rebuild in the background. */
// A reconnected stream stops the poll and reports `live`. Handlers: `onState`, `onStatus`, `onError`, `onDownload`;
// the disposer also carries `reconnect()`, which the fallback banner uses.
function subscribeState(handlers: StateStreamHandlers): StateStreamDispose {
  const onState: (state: StateView) => void = typeof handlers.onState === 'function' ? handlers.onState : () => {}
  const onStatus: (status: StreamMode) => void = typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {}
  const onError: (error: unknown) => void = typeof handlers.onError === 'function' ? handlers.onError : () => {}
  const onDownload: (job: DownloadJobView) => void =
    typeof handlers.onDownload === 'function' ? handlers.onDownload : () => {}
  let disposed = false
  let source: EventSource | null = null
  let timer: TimerHandle | null = null
  let retryTimer: TimerHandle | null = null
  let retryAttempt = 0
  let polling = false
  let mode: StreamMode = 'idle'
  /** The mode only reports a change, so a late frame after `dispose` stays silent. */
  const setMode = (next: StreamMode) => {
    if (mode === next) return
    mode = next
    if (!disposed) onStatus(next)
  }
  const deliver = (state: StateView) => {
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
        // swallow-ok: EventSource.close is idempotent; a lost close leaves no resource to recover
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
      // The automatic chain stops here (the cap the UI promises); the banner offers a manual retry.
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
    // Alive again: polling and the retry chain stop, and the backoff resets to the base delay.
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
    source.addEventListener('state', (event: MessageEvent<string>) => {
      if (source !== stream) return
      try {
        const state: StateView = JSON.parse(event.data)
        // The first frame proves the stream works even when `open` never fired.
        onStreamOpen()
        deliver(state)
      } catch (_error) {
        // swallow-ok: one malformed state frame must not kill the stream; the next frame replaces it
      }
    })
    source.addEventListener('download', (event: MessageEvent<string>) => {
      if (source !== stream) return
      try {
        const job: DownloadJobView = JSON.parse(event.data)
        if (job && typeof job === 'object') onDownload(job)
      } catch (_error) {
        // swallow-ok: one malformed download frame must not kill the stream; later jobs still arrive
      }
    })
    source.addEventListener('ping', () => {
      if (source === stream) onStreamOpen()
    })
    source.addEventListener('error', () => {
      if (disposed || source !== stream) return
      // Never leave the panel without data: poll from now on, rebuild the stream with backoff.
      startPolling()
      stopStream()
      scheduleStreamRetry()
    })
    // Not `live` yet: the banner stays up until `open` or the first frame; clearing it early was the old bug.
  }
  const reconnect = () => {
    if (disposed) return
    retryAttempt = 0
    // A manual retry is a fresh attempt: `clearRetry` drops the scheduled one first.
    clearRetry()
    startStream()
    if (mode !== 'live') {
      startPolling()
      // The retry attempt is the state that keeps the banner saying "reconnecting" until it opens.
      setMode('reconnecting')
    }
  }

  // Initial read in parallel with the stream, so the panel paints immediately even when SSE is slow.
  fetchOnce()
  startStream()

  const dispose: StateStreamDispose = () => {
    disposed = true
    stopStream()
    stopPolling()
    clearRetry()
  }
  dispose.reconnect = reconnect
  return dispose
}

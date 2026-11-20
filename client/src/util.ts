// client/src/util.ts - address/URL validation, formatTime, unrefTimer, withTimeout, readBootVersion, copyText and the four stores; after i18n.ts, before errors.ts.
//#region 4. misc utilities

function isLoopbackAddress(address: unknown): boolean {
  const value = String(address === undefined || address === null ? '' : address)
    .trim()
    .toLowerCase()
  if (value === '') return false
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  if (value.startsWith('localhost:')) return true
  if (value.startsWith('127.')) return true
  return false
}

function looksLikeWebAddress(address: string): boolean {
  const value = address.trim()
  return /^https?:\/\//i.test(value) || value.includes('://') || /[?&]token=/i.test(value)
}

/** A launch URL may only point at this machine's loopback origin, and `startsWith` is not an origin check. */
// Then the parsed URL must prove protocol, host, no credentials and a port; the old check's refusals all still hold.
function isValidLoopbackUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(LOOPBACK_PREFIX)) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch (_error) {
    return false
  }
  // `URL` separates credentials from the host, so a disguised userinfo lands here, not in host.
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  // Missing is an empty string; `URL` drops a default port and rejects >65535, but `:0` still parses.
  if (!/^[0-9]+$/.test(parsed.port)) return false
  const port = Number(parsed.port)
  return port >= 1 && port <= 65535
}

/** A browser carrier URL is a path on this page's own origin: the view prefix, one host id, a slash. */
// Anything absolute, encoded or traversing is refused before it can reach an iframe.
function isValidViewPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_VIEW_PREFIX)) return false
  if (value.includes('://') || value.includes('\\')) return false
  // The browser would collapse these before sending; refusing them keeps the check honest.
  if (/(^|\/)\.{1,2}(\/|$)/.test(value) || /%2e/i.test(value)) return false
  const rest = value.slice(REMOTE_VIEW_PREFIX.length)
  const match = /^([A-Za-z0-9_-]{1,64})\//.exec(rest)
  return match !== null
}

function formatTime(iso: string | null | undefined, locale: DictLocale): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch (_error) {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** The two display-only address fields `HostView` carries (a draft may have neither). */
interface AddressDisplay {
  addressMasked?: string | null
  address?: string | null
}

function displayAddress(host: AddressDisplay | null | undefined): string {
  if (!host) return ''
  if (typeof host.addressMasked === 'string' && host.addressMasked.length > 0) return host.addressMasked
  if (typeof host.address === 'string' && host.address.length > 0) return host.address
  return ''
}

type TimerHandle = ReturnType<typeof setTimeout>
/** The one place the two timer shapes meet: a browser handle is a number and a Node `Timeout` is an object. */
// So the guard is the object shape; reading `.unref` off a number is a no-op there.
function unrefTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}

/** A guest call that never answers must not wedge the intent drain (it would stop forever). */
function withTimeout<T>(promise: PromiseLike<T> | T, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null) => {
      if (settled) return
      settled = true
      if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
      resolve(value)
    }
    let timer: TimerHandle | null = null
    if (typeof setTimeout === 'function') {
      timer = setTimeout(() => finish(null), timeoutMs)
      unrefTimer(timer)
    }
    Promise.resolve(promise).then(finish, () => finish(null))
  })
}

function readBootVersion(): string | undefined {
  const boot = typeof window === 'undefined' ? null : window.__DSH_BOOT__
  const release = boot && typeof boot === 'object' ? boot.release : null
  return release && typeof release.version === 'string' && release.version !== '' ? release.version : undefined
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (_error) {
    // swallow-ok: a refused clipboard write falls through to the legacy copy path
  }
  try {
    if (typeof document === 'undefined' || !document.body) return false
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    document.body.removeChild(area)
    return ok === true
  } catch (_error) {
    return false
  }
}

function progressText(t: LooseTranslate, progress: Progress | null | undefined): string {
  if (!progress || typeof progress.code !== 'string' || progress.code.length === 0) {
    return t('progress.default')
  }
  const params = progress.params && typeof progress.params === 'object' ? progress.params : {}
  const key = 'progress.' + progress.code
  const text = t(key, params)
  // A missing key is returned verbatim by the locale service; fall back.
  return text === key ? t('progress.default') : text
}

/** A one-slot store: `emit` wakes every listener, `subscribe` returns its release. */
function createStore(): Store {
  const listeners = new Set<() => void>()
  return {
    emit() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (_error) {
          // swallow-ok: a stale listener must not break the update for the other listeners
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function createPanelRequestStore(): PanelRequestStore {
  let pending: PanelRequest | null = null
  const store = createStore()
  return {
    request(hostId) {
      if (typeof hostId === 'string' && hostId.length > 0) {
        pending = { kind: 'open', hostId }
        store.emit()
      }
    },
    requestIntent(intent) {
      if (!intent || typeof intent !== 'object') return
      const kinds = ['open', 'disconnect', 'manage', 'local']
      if (!kinds.includes(intent.kind)) return
      // Only these two name a host; anything else is a surface-wide request.
      const namesHost = intent.kind === 'open' || intent.kind === 'disconnect'
      if (namesHost && typeof intent.hostId !== 'string') return
      pending = namesHost ? { kind: intent.kind, hostId: intent.hostId } : { kind: intent.kind }
      store.emit()
    },
    take() {
      const intent = pending
      pending = null
      return intent
    },
    subscribe: store.subscribe,
  }
}

/** The wizard floats in the overlay seat, so it opens from any page without dragging a page along. */
function createWizardStore(): WizardStore {
  let draft: HostDraft | null = null
  const store = createStore()
  return {
    open(next) {
      if (!next || typeof next !== 'object') return
      draft = { mode: next.mode === 'edit' ? 'edit' : 'add', host: next.host || null }
      store.emit()
    },
    close() {
      if (draft === null) return
      draft = null
      store.emit()
    },
    current() {
      return draft
    },
    subscribe: store.subscribe,
  }
}

/** Command queue from a guest page or the switcher row to the overlay (a download, or a toast line). */
function createToolRequestStore(): ToolRequestStore {
  let pending: ToolRequest[] = []
  const store = createStore()
  return {
    requestDownload(request) {
      if (!request || typeof request !== 'object') return
      if (typeof request.hostId !== 'string' || request.hostId === '') return
      if (typeof request.path !== 'string' || request.path === '') return
      pending.push({
        kind: 'download',
        hostId: request.hostId,
        path: request.path,
        name: typeof request.name === 'string' ? request.name : '',
      })
      store.emit()
    },
    /** A visible line for the shell's toast: the bridge's only channel for "this failed". */
    requestNotice(request) {
      if (!request || typeof request !== 'object') return
      if (typeof request.text !== 'string') return
      const text = request.text.trim().slice(0, 200)
      if (text === '') return
      const tone =
        request.tone === 'error' || request.tone === 'success' || request.tone === 'warn' ? request.tone : 'info'
      pending.push({ kind: 'notice', text, tone })
      store.emit()
    },
    take() {
      return pending.length > 0 ? pending.shift() : null
    },
    subscribe: store.subscribe,
  }
}

// client/src/util.ts - address/URL validation, formatTime, unrefTimer, withTimeout, readBootVersion, copyText and the four stores; after i18n.ts, before errors.ts.
//#region 4. misc utilities

function isLoopbackAddress(address) {
  const value = String(address === undefined || address === null ? '' : address)
    .trim()
    .toLowerCase()
  if (value === '') return false
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  if (value.startsWith('localhost:')) return true
  if (value.startsWith('127.')) return true
  return false
}

function looksLikeWebAddress(address) {
  const value = address.trim()
  return /^https?:\/\//i.test(value) || value.includes('://') || /[?&]token=/i.test(value)
}

/**
 * A launch URL may only point at this machine's loopback origin. `startsWith` is not an origin
 * check: `http://127.0.0.1:8080@evil.example/` starts with the prefix yet parses to a remote
 * host with `127.0.0.1:8080` as userinfo. The prefix is kept first so every shape the old check
 * refused stays refused, then the parsed URL must prove protocol, host, no credentials and port.
 */
function isValidLoopbackUrl(url) {
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
  // A missing port is an empty string; `URL` normalizes a default port away and rejects values
  // above 65535 outright, but `:0` still parses, so the range is asserted here.
  if (!/^[0-9]+$/.test(parsed.port)) return false
  const port = Number(parsed.port)
  return port >= 1 && port <= 65535
}

/**
 * A browser carrier URL is a path on this page's own origin, so it must be exactly the view
 * prefix plus one host id plus a slash (the one-shot token rides in the query string).
 * Anything absolute, encoded or traversing is refused before it can reach an iframe.
 */
function isValidViewPath(value) {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_VIEW_PREFIX)) return false
  if (value.includes('://') || value.includes('\\')) return false
  // The browser would collapse these before sending; refusing them keeps the check honest.
  if (/(^|\/)\.{1,2}(\/|$)/.test(value) || /%2e/i.test(value)) return false
  const rest = value.slice(REMOTE_VIEW_PREFIX.length)
  const match = /^([A-Za-z0-9_-]{1,64})\//.exec(rest)
  return match !== null
}

function formatTime(iso, locale) {
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

function displayAddress(host) {
  if (!host) return ''
  if (typeof host.addressMasked === 'string' && host.addressMasked.length > 0) return host.addressMasked
  if (typeof host.address === 'string' && host.address.length > 0) return host.address
  return ''
}

/**
 * `setTimeout`'s handle: a number in the DOM and a `Timeout` object in Node, and only the latter
 * carries `unref`. The callers that keep a ticker alive under a non-browser test process use it.
 */
type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void }

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref()
}

/** A guest call that never answers must not wedge the intent drain (it would stop forever). */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
      resolve(value)
    }
    let timer = null
    if (typeof setTimeout === 'function') {
      timer = setTimeout(() => finish(null), timeoutMs)
      unrefTimer(timer)
    }
    Promise.resolve(promise).then(finish, () => finish(null))
  })
}

function readBootVersion() {
  const boot = typeof window === 'undefined' ? null : window.__DSH_BOOT__
  const release = boot && typeof boot === 'object' ? boot.release : null
  return release && typeof release.version === 'string' && release.version !== '' ? release.version : undefined
}

async function copyText(text) {
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

function progressText(t, progress) {
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
function createStore() {
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

function createPanelRequestStore() {
  let pending = null
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
      if ((intent.kind === 'open' || intent.kind === 'disconnect') && typeof intent.hostId !== 'string') return
      pending =
        intent.kind === 'open' || intent.kind === 'disconnect'
          ? { kind: intent.kind, hostId: intent.hostId }
          : { kind: intent.kind }
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
function createWizardStore() {
  let draft = null
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

/**
 * Command queue from the injected guest page (or the switcher row) to the
 * overlay: currently "download this remote file" plus the capability bridge's
 * toast requests. Consumed in order.
 */
function createToolRequestStore() {
  let pending = []
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

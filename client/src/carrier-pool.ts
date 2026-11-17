// client/src/carrier-pool.ts - the guest pool, carrier surface, load guard, error layer, carrier timeouts and GUEST_PAINT_SCRIPT (9b 5/11); after guest-storage.ts, before carrier-install.ts.
/**
 * The live guests, most recently shown first. A guest is hidden, never reloaded — that is what
 * makes switching instant — and is dropped only when its host goes away.
 */
const carrierPool = {
  entries: [],
  current: null,
  wanted: null,
  poll: null,
}

/**
 * The per-surface operations the pool drives. Both backends (`DESKTOP_CARRIER`, `WEB_CARRIER`)
 * implement exactly this, and the entry they build carries it unchanged.
 */
interface CarrierBackend {
  kind: string
  create(hostId: string, url: string, message: string, options: unknown): unknown
  load(entry: unknown, url: string): void | Promise<void>
  pushRow(entry: unknown, payload: unknown): void
  waitReady(entry: unknown): Promise<unknown>
  dispose(entry: unknown): unknown
  poll: ((entry: unknown) => void) | null
}

/** Show/hide operations run one at a time: two overlapping opens must not build two guests. */
let carrierQueue = Promise.resolve()

let captionStateWatcher = null

/**
 * Serialize one carrier operation behind the previous one and hand back its own result: the queue
 * keeps the *chain*, never the value, so a caller still receives what its task returned.
 */
function whenCarrierIdle<T>(task: () => T | PromiseLike<T>): Promise<T> {
  const run = carrierQueue.then(task, task)
  carrierQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function carrierOf(hostId) {
  if (typeof hostId !== 'string' || hostId === '') return null
  return carrierPool.entries.find((entry) => entry.hostId === hostId) || null
}

function shownCarrier() {
  return carrierPool.current === null ? null : carrierOf(carrierPool.current)
}

function carrierWarm(hostId) {
  return carrierOf(hostId) !== null
}

/**
 * `window.dshDesktop`, narrowed to the browser half this module drives. Anything else (no bridge,
 * another protocol version, or a shell without guest support) answers `null` at the call site.
 */
function desktopBrowserBridge(): DshDesktopBrowser | null {
  if (typeof window === 'undefined') return null
  const carrier = window.dshDesktop
  if (!carrier || carrier.protocolVersion !== DESKTOP_BRIDGE_VERSION) return null
  const browser = carrier.browser
  if (!browser || typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return null
  return browser
}

/**
 * Where this page can put a remote window: the desktop shell's Chromium guest when its bridge
 * is present, otherwise a same-origin frame (the browser build's carrier). Both paths keep the
 * same pool, switching and teardown behaviour — only how a page is embedded differs.
 */
function carrierSurface() {
  if (desktopBrowserBridge() !== null) return 'desktop'
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  // A page loaded from file:// (an Electron build without the guest bridge) cannot host the
  // same-origin view seat: there is no local HTTP origin to proxy through.
  const location = typeof window === 'undefined' ? null : window.location
  if (location && typeof location.protocol === 'string' && !/^https?:$/.test(location.protocol)) return null
  return 'web'
}

/** Each surface accepts a different kind of seat: a loopback origin, or a path on this origin. */
function acceptsCarrierUrl(surface, value) {
  return surface === 'desktop' ? isValidLoopbackUrl(value) : surface === 'web' ? isValidViewPath(value) : false
}

const CARRIER_CSS = `
      .drg-carrier-view{position:absolute;left:0;right:0;top:0;bottom:0;border:0;background:var(--dsw-alias-bg-base);pointer-events:auto}
      .drg-carrier-error{position:absolute;left:0;right:0;top:0;bottom:0;z-index:2;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);font:13px var(--dsw-font-family)}
      .drg-carrier-error-text{max-width:52ch;line-height:1.6}
      .drg-carrier-error button{height:32px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
      .drg-carrier-error button:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .drg-carrier-error button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
    `

/** A switched-to carrier waits this long for its guest document before showing anyway. */
const CARRIER_READY_TIMEOUT_MS = 1200
const CARRIER_PAINT_TIMEOUT_MS = 320
/** A framed page that never fires `load` still needs a visible failure and a way out. */
const CARRIER_LOAD_TIMEOUT_MS = 25000

/**
 * The one-shot timer behind a carrier's load failure. A cold remote on a slow SSH tunnel can
 * take well over ten seconds for the whole document, so the timeout is deliberately generous;
 * the timer only fires when no committed document arrived and is cancelled by the first real
 * `load`. Exposed for the fake-clock test (`__test.createLoadGuard`).
 */
function createLoadGuard(timeoutMs, onTimeout) {
  let timer = null
  let disposed = false
  const cancel = () => {
    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
    timer = null
  }
  return {
    arm() {
      if (disposed) return
      cancel()
      if (typeof setTimeout !== 'function') return
      timer = setTimeout(() => {
        timer = null
        if (!disposed && typeof onTimeout === 'function') onTimeout()
      }, timeoutMs)
      unrefTimer(timer)
    },
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
/** Installing the injected row can fail while the sidebar is still mounting: retry soon. */
const CARRIER_INSTALL_RETRY_MS = 1500
const CARRIER_INSTALL_MAX_ATTEMPTS = 8

/** Set by `apply` (the panel store lives there); a carrier's error layer asks for the local page. */
let requestLocalPage = null

/** The error layer's own handle on its text node, so a reload can rewrite the line in place. */
interface CarrierErrorLayer extends HTMLDivElement {
  __drgText?: HTMLParagraphElement
}

function createCarrierErrorLayer(message, options) {
  const opts = options || {}
  const layer: CarrierErrorLayer = document.createElement('div')
  layer.className = 'drg-carrier-error'
  layer.setAttribute('data-testid', 'remote-overlay-error')
  // A failure that fills the window is an alert: it appears without user action and the only
  // useful move out of it is a button that must be reachable.
  layer.setAttribute('role', 'alert')
  const text = document.createElement('p')
  text.className = 'drg-carrier-error-text'
  text.textContent = typeof message === 'string' ? message : ''
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('data-testid', 'remote-overlay-back-local')
  button.textContent = typeof opts.localLabel === 'string' && opts.localLabel !== '' ? opts.localLabel : 'Local'
  button.addEventListener('click', () => {
    hideOverlays()
    if (typeof requestLocalPage === 'function') requestLocalPage()
  })
  layer.append(text, button)
  layer.style.display = 'none'
  layer.__drgText = text
  return layer
}

function showCarrierError(layer, message?: string) {
  if (!layer) return
  if (layer.__drgText && typeof message === 'string' && message !== '') layer.__drgText.textContent = message
  layer.style.display = 'flex'
}

function hideCarrierError(layer) {
  if (!layer) return
  layer.style.display = 'none'
}
/**
 * Resolves once the guest has painted frames of its own: a hidden `<webview>`'s guest does not
 * paint, so this is what tells a reveal that there is something to show instead of the empty
 * carrier. Two frames: one to produce content, one to hand it to the embedder.
 */
const GUEST_PAINT_SCRIPT =
  '(function(){return new Promise(function(resolve){' +
  'if(typeof requestAnimationFrame!=="function"){resolve("no-raf");return}' +
  'requestAnimationFrame(function(){requestAnimationFrame(function(){resolve("ok")})})' +
  '})})()'

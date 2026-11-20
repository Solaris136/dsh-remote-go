// client/src/carrier-pool.ts - the guest pool, carrier surface, the carrier shell, the guest eval channel, load guard, error layer, carrier timeouts and GUEST_PAINT_SCRIPT (9b 5/11); after guest-storage.ts, before carrier-install.ts.
/** A carrier entry that may be absent: the parameter shape the carrier helpers take. */
type MaybeCarrier = CarrierEntry | null | undefined
/** Live guests, newest first: a hidden one is reused, not reloaded (switching stays instant); dropped with its host. */
const carrierPool: CarrierPool = { entries: [], current: null, wanted: null, poll: null }
/** Show/hide operations run one at a time: two overlapping opens must not build two guests. */
let carrierQueue: Promise<unknown> = Promise.resolve()
let captionStateWatcher: MutationObserver | null = null
/** Run one operation behind the previous one, returning its own result: the queue holds the chain, never the value. */
function whenCarrierIdle<T>(task: () => T | PromiseLike<T>): Promise<T> {
  const run = carrierQueue.then(task, task)
  carrierQueue = run.then(
    (): undefined => undefined,
    (): undefined => undefined,
  )
  return run
}
function carrierOf(hostId: unknown): CarrierEntry | null {
  if (typeof hostId !== 'string' || hostId === '') return null
  return carrierPool.entries.find((entry) => entry.hostId === hostId) || null
}
function shownCarrier(): CarrierEntry | null {
  return carrierPool.current === null ? null : carrierOf(carrierPool.current)
}
function carrierWarm(hostId: unknown): boolean {
  return carrierOf(hostId) !== null
}
/** The guest eval channel: a `<webview>` offers it, an entry whose guest is gone (or is only a frame) does not. */
function guestView(entry: MaybeCarrier): WebviewElement | null {
  const view = entry && entry.view
  return view && typeof view.executeJavaScript === 'function' ? view : null
}
/** Run one script inside the guest and take its answer; a detached guest or a refused call yields `fallback`. */
async function runGuestScript<T>(entry: MaybeCarrier, script: string, fallback: T): Promise<T> {
  const view = guestView(entry)
  if (view === null) return fallback
  try {
    return await view.executeJavaScript<T>(script)
  } catch (_error) {
    return fallback
  }
}
/** Post one script to the guest without waiting for it: the guest may navigate away before the answer lands. */
function fireGuestScript(entry: MaybeCarrier, script: string) {
  const view = guestView(entry)
  if (view === null) return
  try {
    const answer = view.executeJavaScript(script)
    if (answer && typeof answer.catch === 'function') answer.catch(() => {})
  } catch (_error) {
    // swallow-ok: the guest navigated away before the script landed
  }
}
/** `dshDesktop` narrowed to what this module drives: a missing bridge, protocol or guest support gives `null`. */
function desktopBrowserBridge(): DshDesktopBrowser | null {
  if (typeof window === 'undefined') return null
  const carrier = window.dshDesktop
  if (!carrier || carrier.protocolVersion !== DESKTOP_BRIDGE_VERSION) return null
  const browser = carrier.browser
  return browser && typeof browser.acquire === 'function' && typeof browser.release === 'function' ? browser : null
}
/** Where the window goes: the desktop guest with a bridge, else a same-origin frame; only the embedding differs. */
function carrierSurface(): 'desktop' | 'web' | null {
  if (desktopBrowserBridge() !== null) return 'desktop'
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  // A page loaded from file:// (an Electron build without the guest bridge) has no local HTTP origin to proxy through.
  const location = typeof window === 'undefined' ? null : window.location
  if (location && typeof location.protocol === 'string' && !/^https?:$/.test(location.protocol)) return null
  return 'web'
}
function acceptsCarrierUrl(surface: string | null, value: unknown): boolean {
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
/** The one-shot timer behind a carrier's load failure: a cold remote on a slow SSH tunnel can take well over ten
 * seconds for the whole document, so it is deliberately generous and is cancelled by the first real `load`. */
function createLoadGuard(timeoutMs: number, onTimeout?: () => void): CarrierLoadGuard {
  let timer: TimerHandle | null = null
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
/** Installing the injected row can fail while the sidebar is still mounting, so it retries on a capped backoff. */
const CARRIER_INSTALL_RETRY_MS = 1500
const CARRIER_INSTALL_MAX_ATTEMPTS = 8
/** Set by `apply` (the panel store lives there); a carrier's error layer asks for the local page. */
let requestLocalPage: (() => void) | null = null
/** The error layer's own handle on its text node, so a reload can rewrite the line in place. */
interface CarrierErrorLayer extends HTMLDivElement {
  __drgText?: HTMLParagraphElement
}
/** A blank window is never left unexplained: one button hands it back; `role="alert"` keeps the line reachable. */
function createCarrierErrorLayer(message: unknown, options: { localLabel?: unknown }): CarrierErrorLayer {
  const opts = options || {}
  const layer: CarrierErrorLayer = document.createElement('div')
  layer.className = 'drg-carrier-error'
  layer.setAttribute('data-testid', 'remote-overlay-error')
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
function showCarrierError(layer: CarrierErrorLayer | null | undefined, message?: string) {
  if (!layer) return
  if (layer.__drgText && typeof message === 'string' && message !== '') layer.__drgText.textContent = message
  layer.style.display = 'flex'
}
function hideCarrierError(layer: CarrierErrorLayer | null | undefined) {
  if (!layer) return
  layer.style.display = 'none'
}
/** The window every carrier lives in: the fixed root, the injected stylesheet and the failure layer above it. */
// `geometry` is the one thing the two seats disagree on: a guest may start below a caption band it does not own.
function createCarrierShell(hostId: string, geometry: string, message: unknown, localLabel: unknown) {
  const root = document.createElement('div')
  root.id = OVERLAY_ROOT_ID + '-' + (hostId || 'host')
  root.setAttribute('data-testid', 'remote-overlay')
  root.setAttribute('data-host-id', hostId)
  root.style.cssText = [geometry, 'overflow:hidden;background:var(--dsw-alias-bg-base)'].join(';')
  const style = document.createElement('style')
  style.textContent = CARRIER_CSS
  return { root, style, errorLayer: createCarrierErrorLayer(message, { localLabel }) }
}
/** A carrier's lifecycle starts idle in both seats: nothing loaded, no waiter, no reveal in flight, no timer. */
function idleCarrierState() {
  return {
    rowInstalled: false,
    ready: false,
    readyWaiters: [] as ((value: boolean) => void)[],
    revealToken: 0,
    timer: null as TimerHandle | null,
  }
}
/** Resolves once the guest painted a frame: a hidden `<webview>` does not paint, so a reveal waits for it. */
// Two frames: one to produce content, one to hand it to the embedder.
const GUEST_PAINT_SCRIPT =
  '(function(){return new Promise(function(resolve){' +
  'if(typeof requestAnimationFrame!=="function"){resolve("no-raf");return}' +
  'requestAnimationFrame(function(){requestAnimationFrame(function(){resolve("ok")})})' +
  '})})()'

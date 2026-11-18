// client/src/carrier-web.ts - createWebCarrier/webWindow/onWebFrameLoad/scheduleCarrierInstall, the framed backend (9b 9/11); after carrier-desktop.ts, before carrier-intents.ts.
// --- web backend: same-origin frame, used whenever the desktop guest bridge is absent -------

/**
 * The browser build has no guest seat, so the remote page is framed on this origin and the
 * local proxy forwards it to the host's tunnel. Same origin is what lets the row and the file
 * bridge be injected below; it is also why the frame must never navigate off the view prefix.
 */
function createWebCarrier(hostId: string, url: string, message: unknown, options: CarrierShowOptions): CarrierEntry {
  const root = document.createElement('div')
  root.id = OVERLAY_ROOT_ID + '-' + (hostId || 'host')
  root.setAttribute('data-testid', 'remote-overlay')
  root.setAttribute('data-host-id', hostId)
  root.style.cssText = [
    'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483000',
    'overflow:hidden;background:var(--dsw-alias-bg-base)',
  ].join(';')
  const style = document.createElement('style')
  style.textContent = CARRIER_CSS
  // A frame that never loads would otherwise be a blank window; say why instead, and keep a
  // button that hands the window back to the local page.
  const errorLayer = createCarrierErrorLayer(message, { localLabel: options.localLabel })
  const frame = document.createElement('iframe')
  frame.className = 'drg-carrier-view drg-carrier-frame'
  frame.setAttribute('data-testid', 'remote-frame')
  frame.setAttribute('title', 'Remote DSH')
  // No sandbox: it would sever the same-origin access this backend depends on. The URL is
  // re-checked against the view prefix before it is assigned (see acceptsCarrierUrl).
  // `allow` can only narrow what the browser grants a subdocument, so it is not the fix for a
  // capability the frame cannot hold (see the capability bridge): it names the ones the remote
  // page may legitimately use — clipboard, the voice input's microphone, fullscreen, and the
  // account login's `about:blank` popup. No `allow-popups-to-escape-sandbox`: the frame is not
  // sandboxed, so a popup already escapes into this origin.
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone; fullscreen; popups')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  const entry: CarrierEntry = {
    kind: 'web',
    backend: WEB_CARRIER,
    hostId,
    root,
    frame,
    url,
    errorLayer,
    rowInstalled: false,
    ready: false,
    readyWaiters: [],
    revealToken: 0,
    timer: null,
    installAttempts: 0,
    installTimer: null,
    /** Arms the "the document never committed" timer for this navigation. */
    loadGuard: null,
    /** What the frame shows when the loaded document is not the DSH UI. */
    notDshMessage: typeof message === 'string' ? message : '',
  }
  frame.addEventListener('load', () => onWebFrameLoad(entry))
  root.append(style, frame, errorLayer)
  document.body.appendChild(root)
  entry.loadGuard = createLoadGuard(CARRIER_LOAD_TIMEOUT_MS, () => {
    if (!carrierPool.entries.includes(entry)) return
    if (entry.ready === true) return
    showCarrierError(entry.errorLayer)
    markCarrierReady(entry)
  })
  // Assign after the listener and the element are in place, so the first load is observed.
  frame.src = url
  entry.loadGuard.arm()
  return entry
}

function webWindow(entry: CarrierEntry): Window | null {
  try {
    const win = entry.frame && entry.frame.contentWindow
    if (!win) return null
    // Reading a cross-origin frame's document throws; this carrier only accepts same-origin.
    void win.document
    return win
  } catch (_error) {
    return null
  }
}

function onWebFrameLoad(entry: CarrierEntry) {
  if (entry === null || entry.kind !== 'web') return
  const win = webWindow(entry)
  // The initial about:blank of a freshly appended iframe can dispatch `load` before the
  // assigned URL commits. It is not the remote document, so it must not be mistaken for a
  // non-DSH page; the load timeout owns the case where the real URL never arrives.
  try {
    if (win && win.location && win.location.href === 'about:blank') return
  } catch (_error) {
    // swallow-ok: a cross-origin document throws on location reads and is handled below
  }
  if (entry.loadGuard) entry.loadGuard.cancel()
  if (win === null) {
    // The framed page left this origin (an external link, an OAuth hop): a cross-origin
    // frame would hide the host switcher and trap the window there, so bring it back.
    try {
      entry.frame.src = entry.url
    } catch (_error) {
      // swallow-ok: a detached frame reports the refused navigation through the next load event
    }
    return
  }
  // The proxy can answer 200 with an error page (or the Host can hand out a wrong path):
  // detect that this document is not the DSH UI and give the user the way out instead of a
  // frame with no switcher (audit "failure layer always display:none").
  let isDsh = false
  try {
    const doc = win.document
    isDsh = Boolean(doc && (doc.querySelector('#root') || doc.querySelector('[data-dsh-root]')))
  } catch (_error) {
    isDsh = false
  }
  if (!isDsh) {
    showCarrierError(entry.errorLayer, entry.notDshMessage || '')
    markCarrierReady(entry)
    return
  }
  hideCarrierError(entry.errorLayer)
  markCarrierReady(entry)
  const installed = installWebCarrier(entry, win)
  if (!installed) scheduleCarrierInstall(entry)
  if (carrierPool.current === entry.hostId) pushGuestHostRow()
}

/**
 * A row that failed to install because the sidebar was still mounting must not stay missing
 * for the life of the window (audit "install failure never retried"). Retry with a growing
 * delay, capped, and stop once the carrier is gone or the row is live.
 */
function stopCarrierInstall(entry: CarrierEntry | null | undefined) {
  if (entry === null || entry === undefined) return
  if (entry.installTimer !== null && entry.installTimer !== undefined) {
    if (typeof clearTimeout === 'function') clearTimeout(entry.installTimer)
    entry.installTimer = null
  }
}
function scheduleCarrierInstall(entry: CarrierEntry | null | undefined) {
  if (entry === null || entry === undefined || entry.installTimer) return
  if (!carrierPool.entries.includes(entry)) return
  if ((entry.installAttempts || 0) >= CARRIER_INSTALL_MAX_ATTEMPTS) return
  const delay = CARRIER_INSTALL_RETRY_MS * Math.min(8, 2 ** (entry.installAttempts || 0))
  entry.installAttempts = (entry.installAttempts || 0) + 1
  entry.installTimer = setTimeout(async () => {
    entry.installTimer = null
    if (!carrierPool.entries.includes(entry)) return
    let installed = false
    try {
      if (entry.kind === 'web') {
        const win = webWindow(entry)
        installed = win ? installWebCarrier(entry, win) : false
      } else {
        // A desktop guest gets the same retry for all three injections: the row, the file
        // bridge and the capability bridge are independent and each can fail while the
        // sidebar is still mounting.
        installed = await installHostRow(entry)
        await installGuestTools(entry)
        await installCapabilityBridge(entry)
      }
    } catch (_error) {
      installed = false
    }
    if (installed) {
      entry.installAttempts = 0
      if (carrierPool.current === entry.hostId) {
        pushGuestHostRow()
        if (typeof entry.backend.poll === 'function') entry.backend.poll(entry)
      }
      return
    }
    scheduleCarrierInstall(entry)
  }, delay)
  unrefTimer(entry.installTimer)
}

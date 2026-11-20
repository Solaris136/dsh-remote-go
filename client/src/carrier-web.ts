// client/src/carrier-web.ts - createWebCarrier/webWindow/onWebFrameLoad/scheduleCarrierInstall, the framed backend (9b 9/11); after carrier-desktop.ts, before carrier-intents.ts.
/** No guest seat in the browser build: the remote page is framed on this origin and proxied to the host's tunnel. */
// Same origin lets the row and file bridge be injected, and is why the frame never leaves the view prefix.
function createWebCarrier(hostId: string, url: string, message: unknown, options: CarrierShowOptions): CarrierEntry {
  // A frame that never loads would be blank: the shell's error layer says why, with a way back to the local page.
  const geometry = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483000'
  const { root, style, errorLayer } = createCarrierShell(hostId, geometry, message, options.localLabel)
  const frame = document.createElement('iframe')
  frame.className = 'drg-carrier-view drg-carrier-frame'
  frame.setAttribute('data-testid', 'remote-frame')
  frame.setAttribute('title', 'Remote DSH')
  // No sandbox: it would sever the same-origin access this backend needs; `allow` only narrows what the page may use.
  // That is clipboard, the voice input's microphone, fullscreen, and the account login's popup.
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone; fullscreen; popups')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  const entry: CarrierEntry = {
    ...idleCarrierState(),
    kind: 'web',
    backend: WEB_CARRIER,
    hostId,
    root,
    frame,
    url,
    errorLayer,
    installAttempts: 0,
    installTimer: null,
    loadGuard: null,
    notDshMessage: typeof message === 'string' ? message : '',
  }
  frame.addEventListener('load', () => onWebFrameLoad(entry))
  root.append(style, frame, errorLayer)
  document.body.appendChild(root)
  entry.loadGuard = createLoadGuard(CARRIER_LOAD_TIMEOUT_MS, () => {
    if (!carrierPool.entries.includes(entry) || entry.ready === true) return
    showCarrierError(entry.errorLayer)
    markCarrierReady(entry)
  })
  frame.src = url
  entry.loadGuard.arm()
  return entry
}
/** The frame's own window, when it is same-origin: reading a cross-origin frame's document throws, so that is `null`. */
function webWindow(entry: CarrierEntry): Window | null {
  try {
    const win = entry.frame && entry.frame.contentWindow
    if (!win) return null
    void win.document
    return win
  } catch (_error) {
    return null
  }
}
function onWebFrameLoad(entry: CarrierEntry) {
  if (entry === null || entry.kind !== 'web') return
  const win = webWindow(entry)
  // A fresh iframe's about:blank can dispatch `load` before the assigned URL commits; that is not the remote document.
  try {
    if (win && win.location && win.location.href === 'about:blank') return
  } catch (_error) {
    // swallow-ok: a cross-origin document throws on location reads and is handled below
  }
  if (entry.loadGuard) entry.loadGuard.cancel()
  if (win === null) {
    // The framed page left this origin (an external link, an OAuth hop): that hides the switcher, so bring it back.
    try {
      entry.frame.src = entry.url
    } catch (_error) {
      // swallow-ok: a detached frame reports the refused navigation through the next load event
    }
    return
  }
  // The proxy can answer 200 with an error page: detect it and offer a way out instead of a frame with no switcher.
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
/** A row that failed while the sidebar was mounting must not stay missing: retry on a capped backoff until it lands. */
// Stop once the carrier is gone or the row is live.
function stopCarrierInstall(entry: MaybeCarrier) {
  if (entry === null || entry === undefined) return
  if (entry.installTimer !== null && entry.installTimer !== undefined) {
    if (typeof clearTimeout === 'function') clearTimeout(entry.installTimer)
    entry.installTimer = null
  }
}
function scheduleCarrierInstall(entry: MaybeCarrier) {
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
        // A desktop guest retries all three injections: each can fail independently while the sidebar mounts.
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

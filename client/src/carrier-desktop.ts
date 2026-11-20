// client/src/carrier-desktop.ts - createDesktopCarrier, the guest backend (9b 8/11); after carrier-caption.ts, before carrier-web.ts.
/** Electron's `<webview>` has `loadURL`, but `lib.dom` only types the tag; declare the shape here, not as `any`. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  /** Electron's guest-eval channel: the only way into the framed page's own script. */
  executeJavaScript<T = unknown>(code: string): Promise<T>
  /** Reload the committed document (a failed main-frame load is retried through this). */
  reload(): void
}
/** The guest's `did-fail-load` event; a sub-resource failure carries a negative `errorCode`. */
interface WebviewLoadFailure extends Event {
  isMainFrame?: boolean
  errorCode?: number
}
/** One desktop guest; the pool keeps it warm, so the fields a later frame mutates live on the shared `CarrierEntry`. */
interface DesktopCarrierEntry extends CarrierEntry {
  kind: 'desktop'
  backend: CarrierBackend
  hostId: string
  lease: string
  root: HTMLElement
  view: WebviewElement
  grip: HTMLElement | null
  caption: { height: number } | null
  captionApplied: boolean
  sidebarCollapsed: boolean | null
  sidebarStart: string
  url: string
  rowInstalled: boolean
  failed: boolean
  timer: number | null
  ready: boolean
  readyWaiters: ((value: boolean) => void)[]
  revealToken: number
  installAttempts?: number
}
async function createDesktopCarrier(
  hostId: string,
  url: string,
  message: unknown,
  options: CarrierShowOptions,
): Promise<DesktopCarrierEntry | null> {
  const bridge = desktopBrowserBridge()
  if (bridge === null) return null
  let reservation = null
  try {
    reservation = await bridge.acquire('dsh-remote-go:' + (hostId || 'host'))
  } catch (_error) {
    return null
  }
  if (!reservation || typeof reservation.lease !== 'string' || typeof reservation.partition !== 'string') return null
  if (reservation.lease === '') return null
  const caption = desktopCaption()
  if (caption !== null) watchCaptionState()
  // A guest taught the desktop layout reserves the caption band itself, so the carrier covers the whole window.
  // Without a band to mirror (the Web build, a macOS window) the guest starts below it: those clicks belong to the OS.
  const top = caption === null ? CAPTION_FALLBACK_HEIGHT + 'px' : '0px'
  const geometry = 'position:fixed;left:0;right:0;bottom:0;top:' + top + ';z-index:2147483000'
  const { root, style, errorLayer } = createCarrierShell(hostId, geometry, message, options.localLabel)
  // A guest over the band loses the window drag (Electron ignores app regions there), so this strip hands it back.
  // The guest's fixed caption controls sit left of it, and the shell's caption menus paint above the whole carrier.
  let grip = null
  if (caption !== null) {
    grip = document.createElement('div')
    grip.className = 'drg-carrier-grip'
    grip.setAttribute('data-testid', 'remote-overlay-grip')
    grip.style.cssText =
      'position:absolute;left:' +
      CAPTION_GRIP_LEFT +
      'px;right:0;top:0;height:' +
      caption.height +
      'px;z-index:1;-webkit-app-region:drag'
  }
  // The file's only assertion: `lib.dom` types the tag as `HTMLElement`; `WebviewElement` adds the member it calls.
  const view = document.createElement('webview') as WebviewElement
  view.className = 'drg-carrier-view'
  view.setAttribute('name', String(reservation.lease))
  view.setAttribute('partition', String(reservation.partition))
  view.setAttribute('allowpopups', '')
  view.setAttribute('src', 'about:blank#' + String(reservation.lease))
  // Built before any listener, so an event fired during the append cannot read this binding in its temporal dead zone.
  const entry: DesktopCarrierEntry = {
    ...idleCarrierState(),
    kind: 'desktop',
    backend: DESKTOP_CARRIER,
    hostId,
    lease: String(reservation.lease),
    root,
    view,
    grip,
    caption,
    captionApplied: false,
    sidebarCollapsed: null,
    sidebarStart: '',
    url,
    failed: false,
  }
  let navigated = false
  view.addEventListener('dom-ready', () => {
    if (entry.view !== view || navigated) return
    navigated = true
    view.loadURL(entry.url).catch(() => {})
  })
  // Every committed navigation drops the injected marker: re-apply it before the first paint and forget the old rail.
  view.addEventListener('dom-ready', () => {
    if (entry.view !== view) return
    applyGuestSidebar(entry, null)
    applyGuestCaption(entry).then((applied) => {
      if (entry.view !== view) return
      syncCarrierCaption(entry, applied)
    })
  })
  view.addEventListener('did-stop-loading', () => {
    if (entry.view !== view) return
    errorLayer && hideCarrierError(errorLayer)
    entry.failed = false
    // The document is there: a switch waiting for it may show the guest from here on.
    markCarrierReady(entry)
    // Re-install after every load stop: a reload wipes the injected DOM, so installing once leaves the window bare.
    // Both scripts are idempotent, and the caption must land before the row measures the sidebar it enters.
    applyGuestCaption(entry)
      .then(async (applied) => {
        if (entry.view !== view) return false
        syncCarrierCaption(entry, applied)
        // A guest that reserved the band also owns the caption menubar's inset: learn its rail before the row lands.
        await installSidebarMirror(entry)
        if (entry.view !== view) return false
        return installHostRow(entry)
      })
      .then(async (live) => {
        if (entry.view !== view) return
        // The download and capability bridges are independent of the row's target: install them even collapsed.
        const tools = await installGuestTools(entry)
        if (entry.view !== view) return
        const capabilities = await installCapabilityBridge(entry)
        if (entry.view !== view) return
        // Each committed document is a fresh install attempt; a sidebar that is not mounted yet retries with backoff.
        entry.installAttempts = 0
        if (!live || !tools || !capabilities) scheduleCarrierInstall(entry)
        if (carrierPool.current === entry.hostId) startHostRowPoll(entry)
      })
  })
  view.addEventListener('did-fail-load', (event: WebviewLoadFailure) => {
    if (entry.view !== view) return
    // A main-frame failure is reported (a blank window otherwise); sub-resource failures (errorCode -3) stay silent.
    const isMainFrame = !event || event.isMainFrame !== false
    const aborted = event && (event.errorCode === -3 || event.errorCode === undefined)
    if (!isMainFrame || aborted) return
    entry.failed = true
    showCarrierError(errorLayer)
    // The failure line is the page now: show it rather than wait for a frame, and hand the caption band back.
    markCarrierReady(entry)
    syncCarrierCaption(entry, false)
  })
  root.append(style, view, errorLayer)
  if (grip !== null) root.append(grip)
  document.body.appendChild(root)
  return entry
}

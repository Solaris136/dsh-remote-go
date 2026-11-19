// client/src/carrier-desktop.ts - createDesktopCarrier, the guest backend (9b 8/11); after carrier-caption.ts, before carrier-web.ts.
/**
 * The desktop carrier runs inside Electron, where `<webview>` is a real element with a `loadURL`
 * method; `lib.dom` can only type the tag name as `HTMLElement`, so the shape this module calls is
 * declared here instead of being reached for through `any`.
 */
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

/**
 * One desktop guest. The pool keeps it warm and every backend call takes it, so the fields a
 * later frame mutates (`installAttempts`, `ready`, `failed`, …) live on the shared `CarrierEntry`.
 */
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
  /** Install retries for the current document; the pool's retry chain increments it. */
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
  if (
    !reservation ||
    typeof reservation.lease !== 'string' ||
    typeof reservation.partition !== 'string' ||
    reservation.lease === ''
  ) {
    return null
  }

  const caption = desktopCaption()
  if (caption !== null) watchCaptionState()
  const root = document.createElement('div')
  // One root per warm host, so the ids stay unique (the host shows which window it is).
  root.id = OVERLAY_ROOT_ID + '-' + (hostId || 'host')
  root.setAttribute('data-testid', 'remote-overlay')
  root.setAttribute('data-host-id', hostId)
  // A guest that is taught the desktop layout reserves the caption band itself, so the carrier covers the whole
  // window and both pages lay out on one grid. Without a band to mirror (the Web build, or a macOS window) the
  // guest starts below the window's own band: clicks in it belong to the OS, not to this page.
  const top = caption === null ? CAPTION_FALLBACK_HEIGHT + 'px' : '0px'
  root.style.cssText = [
    'position:fixed;left:0;right:0;bottom:0;top:' + top + ';z-index:2147483000',
    'overflow:hidden;background:var(--dsw-alias-bg-base)',
  ].join(';')

  const style = document.createElement('style')
  style.textContent = CARRIER_CSS

  // A failed main-frame load leaves a blank window; say so instead of showing
  // nothing, and keep a way back to the local page (audit "failed layer has no exit").
  const errorLayer = createCarrierErrorLayer(message, { localLabel: options.localLabel })

  // A guest that covers the caption band takes the window drag away with it (Electron ignores app regions inside a
  // guest). This strip hands the empty part of the band back to the window; the guest's own fixed caption controls
  // sit left of it, and the shell's caption menus paint above the whole carrier.
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

  // `lib.dom` types a custom tag as a plain `HTMLElement`; the one member this module calls
  // (`loadURL`) is declared on `WebviewElement` above, and this is the only assertion in the file.
  const view = document.createElement('webview') as WebviewElement
  view.className = 'drg-carrier-view'
  view.setAttribute('name', String(reservation.lease))
  view.setAttribute('partition', String(reservation.partition))
  view.setAttribute('allowpopups', '')
  view.setAttribute('src', 'about:blank#' + String(reservation.lease))

  // Built before any listener is attached: the handlers below read it, and a guest that fired an event while the
  // element was being appended would otherwise read a binding that is still in its temporal dead zone.
  const entry: DesktopCarrierEntry = {
    kind: 'desktop',
    backend: DESKTOP_CARRIER,
    hostId,
    lease: String(reservation.lease),
    root,
    view,
    grip,
    caption,
    /** Set once the guest page carries the desktop marker (never in a band-less window). */
    captionApplied: false,
    /** The guest's rail state as it last reported it; null until the mirror says. */
    sidebarCollapsed: null,
    /** The menubar inset the guest's own DSH rule resolved to; empty when it could not say. */
    sidebarStart: '',
    url,
    rowInstalled: false,
    failed: false,
    timer: null,
    /** True once the guest committed a document (or failed): a reveal can stop waiting. */
    ready: false,
    readyWaiters: [],
    /** Bumped per reveal, so a reveal that lost the window cannot paint over the next one. */
    revealToken: 0,
  }

  // `dom-ready` fires once per committed navigation, so navigating from it
  // unconditionally would reload the remote page forever (visible as flicker).
  let navigated = false
  view.addEventListener('dom-ready', () => {
    if (entry.view !== view || navigated) return
    navigated = true
    view.loadURL(entry.url).catch(() => {})
  })
  // Every committed navigation starts from a fresh document, which drops the injected
  // caption marker: re-apply it before the page can paint the Web grid.
  view.addEventListener('dom-ready', () => {
    if (entry.view !== view) return
    // The document that just went away says nothing about this one's rail: forget its state
    // instead of writing it onto this page's band once more (the mirror reports again below).
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
    // Re-install after *every* load stop: the remote page reloading wipes the injected DOM, and a one-shot install
    // would leave the window without any control. Both scripts are idempotent inside the page, and the caption has
    // to land before the row measures the sidebar it is placed into.
    applyGuestCaption(entry)
      .then(async (applied) => {
        if (entry.view !== view) return false
        syncCarrierCaption(entry, applied)
        // A guest that reserved the band also owns the caption menubar's inset: learn its rail
        // state before the row measures the sidebar it is placed into.
        await installSidebarMirror(entry)
        if (entry.view !== view) return false
        return installHostRow(entry)
      })
      .then(async (live) => {
        if (entry.view !== view) return
        // The download bridge is independent of the row's target: install it even
        // when the sidebar is collapsed and the row had nowhere to land yet.
        const tools = await installGuestTools(entry)
        if (entry.view !== view) return
        // Same channel, its own install: a collapsed sidebar must not cost the guest its
        // links and clipboard any more than it costs it the file bridge.
        const capabilities = await installCapabilityBridge(entry)
        if (entry.view !== view) return
        // Each committed document is a fresh install attempt; a collapsed / not-yet-mounted
        // sidebar retries with backoff instead of leaving the guest without its row.
        entry.installAttempts = 0
        if (!live || !tools || !capabilities) scheduleCarrierInstall(entry)
        if (carrierPool.current === entry.hostId) startHostRowPoll(entry)
      })
  })
  view.addEventListener('did-fail-load', (event: WebviewLoadFailure) => {
    if (entry.view !== view) return
    // A main-frame failure leaves a blank window, so say so; sub-resource
    // failures (errorCode -3, aborted) are normal and must stay silent.
    const isMainFrame = !event || event.isMainFrame !== false
    const aborted = event && (event.errorCode === -3 || event.errorCode === undefined)
    if (!isMainFrame || aborted) return
    entry.failed = true
    showCarrierError(errorLayer)
    // The failure line is the page now: show it rather than wait for a frame that never comes.
    markCarrierReady(entry)
    // The page cannot paint its own frame, so it must not own the caption band either:
    // hand the band back to the local page (its menus stay reachable while the failure
    // line is up) and the next successful load takes it again.
    syncCarrierCaption(entry, false)
  })

  root.append(style, view, errorLayer)
  if (grip !== null) root.append(grip)
  document.body.appendChild(root)

  return entry
}

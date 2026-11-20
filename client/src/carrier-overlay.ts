// client/src/carrier-overlay.ts - show/reveal/hide/dispose/close for the carrier overlay (9b 11/11); after carrier-intents.ts, before key-picker.ts.
/** Remove one browser frame: its guard, its last navigation and its root. */
function disposeWebCarrier(entry: CarrierEntry) {
  stopCarrierInstall(entry)
  if (entry.loadGuard) entry.loadGuard.dispose()
  try {
    entry.frame.src = 'about:blank'
  } catch (_error) {
    // swallow-ok: the frame may already be detached; removing its root below is the cleanup
  }
  if (entry.root.parentNode !== null) entry.root.parentNode.removeChild(entry.root)
}
interface CarrierShowResult {
  ok: boolean
  reason?: string
  reused?: boolean
}
/** Show one host's window, warming it on first visit: creation is async, so `wanted` makes the last request win. */
async function showOverlay(options: CarrierShowOptions): Promise<CarrierShowResult> {
  const hostId = typeof options.hostId === 'string' ? options.hostId : ''
  carrierPool.wanted = hostId
  return whenCarrierIdle(() => showOverlayNow(hostId, options))
}
/** One display frame, or 60 ms: a reveal must not wait on a page that will not paint. */
function nextLocalFrame(): Promise<boolean> {
  const frame = new Promise<boolean>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve(true))
  })
  return withTimeout(frame, 60).then((framed) => framed === true)
}
/** Resolves true once the guest painted a frame: a hidden `<webview>` does not paint, so a reveal waits for it. */
// The guest answers 'no-raf' when it has no frame callback: its document is there, so that counts as painted.
function waitForGuestPaint(entry: MaybeCarrier, timeoutMs: number): Promise<boolean> {
  if (guestView(entry) === null) return Promise.resolve(false)
  const painted = Promise.resolve()
    .then(() => runGuestScript(entry, GUEST_PAINT_SCRIPT, ''))
    .then((value) => value === 'ok' || value === 'no-raf')
  return withTimeout(painted, timeoutMs).then((paintedNow) => paintedNow === true)
}
function markCarrierReady(entry: MaybeCarrier) {
  if (entry === null || entry === undefined) return
  entry.ready = true
  const waiters = Array.isArray(entry.readyWaiters) ? entry.readyWaiters : []
  entry.readyWaiters = []
  for (const resolve of waiters) resolve(true)
}
function waitForCarrierReady(entry: CarrierEntry, timeoutMs: number): Promise<boolean> {
  if (entry.ready === true) return Promise.resolve(true)
  const ready = new Promise<boolean>((resolve) => {
    entry.readyWaiters.push(resolve)
  })
  return withTimeout(ready, timeoutMs).then((readyNow) => readyNow === true)
}
/** Reveal without the empty frame: a hidden guest has no surface, so it starts transparent and then turns opaque. */
// The browser frame keeps its last frame; a reveal that lost its turn leaves the carrier hidden.
async function revealCarrier(entry: CarrierEntry) {
  const token = (entry.revealToken ?? 0) + 1
  entry.revealToken = token
  entry.root.style.display = ''
  entry.root.style.opacity = '0'
  entry.root.style.pointerEvents = 'none'
  await nextLocalFrame()
  await entry.backend.waitReady(entry)
  await nextLocalFrame()
  if (entry.revealToken !== token || carrierPool.current !== entry.hostId) return
  entry.root.style.pointerEvents = ''
  entry.root.style.opacity = ''
}
async function showOverlayNow(hostId: string, options: CarrierShowOptions): Promise<CarrierShowResult> {
  const url = typeof options.url === 'string' ? options.url : ''
  let entry = carrierOf(hostId)
  const reused = entry !== null
  const surface = entry === null ? carrierSurface() : entry.kind
  let navigatedRev: number | null = null
  if (entry === null) {
    if (surface === null) return { ok: false, reason: 'acquire-failed' }
    if (!acceptsCarrierUrl(surface, url)) return { ok: false, reason: 'bad-url' }
    entry = await createCarrier(hostId, url, options.message, options)
    if (entry === null) return { ok: false, reason: 'acquire-failed' }
    navigatedRev = options.viewRev
    if (carrierPool.wanted !== hostId) {
      await disposeCarrier(entry)
      return { ok: false, reason: 'superseded' }
    }
  } else if (
    url !== '' &&
    (entry.url !== url || (Number.isInteger(options.viewRev) && entry.viewRev !== options.viewRev)) &&
    acceptsCarrierUrl(entry.kind, url)
  ) {
    await entry.backend.load(entry, url)
    navigatedRev = options.viewRev
  }
  if (typeof options.message === 'string' && options.message !== '') entry.notDshMessage = options.message
  if (carrierPool.wanted !== hostId) return { ok: false, reason: 'superseded' }
  if (navigatedRev !== null && Number.isInteger(navigatedRev)) entry.viewRev = navigatedRev
  if (reused && entry.kind === 'desktop' && entry.failed === true) {
    entry.failed = false
    try {
      entry.view.reload()
    } catch (_error) {
      // swallow-ok: the guest may already be gone; reload is a best-effort retry
    }
  }
  for (const other of carrierPool.entries) if (other !== entry) other.root.style.display = 'none'
  carrierPool.entries = [entry, ...carrierPool.entries.filter((item) => item !== entry)]
  const alreadyShown = carrierPool.current === hostId && entry.root.style.display !== 'none'
  carrierPool.current = hostId
  if (alreadyShown) {
    entry.root.style.pointerEvents = ''
    entry.root.style.opacity = ''
  } else {
    revealCarrier(entry).catch(() => {})
  }
  ownCaptionBand(entry, entry.captionApplied === true)
  updateSwitcher({ current: hostId })
  if (entry.rowInstalled === true) {
    pushGuestHostRow()
    if (typeof entry.backend.poll === 'function') entry.backend.poll(entry)
  }
  return { ok: true, reused }
}
/** Hide every carrier but keep it warm, so coming back to it needs no load at all. */
function hideOverlays() {
  carrierPool.wanted = null
  if (carrierPool.current === null) return
  stopHostRowPoll()
  for (const entry of carrierPool.entries) entry.root.style.display = 'none'
  carrierPool.current = null
  ownCaptionBand(null, false)
}
/** Set by the overlay host: a disposed carrier invalidates the launch URL kept for it. */
let onCarrierDisposed: ((hostId: string) => void) | null = null
/** Tear a carrier down: stop retries, hand the band back, release the guest then the lease; safe if never pooled. */
async function disposeCarrier(entry: MaybeCarrier) {
  if (entry === null || entry === undefined) return
  stopCarrierInstall(entry)
  if (carrierPool.poll === entry) stopHostRowPoll()
  carrierPool.entries = carrierPool.entries.filter((item) => item !== entry)
  // The window that filled the page is going away, so the local page is next and the row has to follow here as well.
  // React state cannot clear it: a disconnect arrives through a subscription whose closure holds the target from mount.
  const wasShown = carrierPool.current === entry.hostId
  if (wasShown) {
    carrierPool.current = null
    ownCaptionBand(null, false)
  }
  await entry.backend.dispose(entry)
  // The launch URL for this host is one-shot and its tunnel is gone: keep no copy of it.
  if (typeof onCarrierDisposed === 'function') onCarrierDisposed(entry.hostId)
  if (wasShown) updateSwitcher({ current: 'local' })
}
/** Hand one desktop guest back to the shell: injected row, DOM, then the lease itself. */
async function disposeDesktopCarrier(entry: CarrierEntry) {
  if (entry.rowInstalled === true) fireGuestScript(entry, 'window.__drgHostRow && window.__drgHostRow.destroy()')
  if (entry.root.parentNode !== null) entry.root.parentNode.removeChild(entry.root)
  const bridge = desktopBrowserBridge()
  if (bridge !== null && entry.lease !== null) {
    try {
      await bridge.release(entry.lease)
    } catch (_error) {
      // swallow-ok: a lease the shell already dropped is already released
    }
  }
}
async function closeCarrier(hostId: string) {
  const entry = carrierOf(hostId)
  if (entry !== null) await disposeCarrier(entry)
}
async function closeOverlay() {
  stopHostRowPoll()
  const hosts = carrierPool.entries.map((entry) => entry.hostId)
  carrierPool.current = null
  ownCaptionBand(null, false)
  if (captionStateWatcher !== null) {
    captionStateWatcher.disconnect()
    captionStateWatcher = null
  }
  for (const hostId of hosts) await closeCarrier(hostId)
}

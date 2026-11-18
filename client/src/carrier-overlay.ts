// client/src/carrier-overlay.ts - show/reveal/hide/dispose/close for the carrier overlay (9b 11/11); after carrier-intents.ts, before key-picker.ts.
function disposeWebCarrier(entry) {
  stopCarrierInstall(entry)
  if (entry.loadGuard) entry.loadGuard.dispose()
  try {
    entry.frame.src = 'about:blank'
  } catch (_error) {
    // swallow-ok: the frame may already be detached; removing its root below is the cleanup
  }
  if (entry.root.parentNode !== null) entry.root.parentNode.removeChild(entry.root)
}

/**
 * What one acquire attempt produced. `ok:false` carries the reason the window did not change
 * (`acquire-failed`, `bad-url`, `superseded`); the overlay host only acts on the acquire failure.
 */
interface CarrierShowResult {
  ok: boolean
  reason?: string
  reused?: boolean
}

/**
 * Show one host's window, warming it on first visit. Creation is async (the bridge hands out a
 * lease), so `carrierPool.wanted` makes the last request win: a superseded creation is dropped.
 */
async function showOverlay(options): Promise<CarrierShowResult> {
  const hostId = typeof options.hostId === 'string' ? options.hostId : ''
  carrierPool.wanted = hostId
  return whenCarrierIdle(() => showOverlayNow(hostId, options))
}

/** One frame of this page, so the compositor has committed what was just changed here. */
function nextLocalFrame() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => finish(true))
    // An occluded window (or a windowless test) schedules no frames: never wait for one.
    if (typeof setTimeout === 'function') unrefTimer(setTimeout(() => finish(false), 60))
  })
}

/** Resolve once the guest has painted frames of its own; false when it never answers. */
function waitForGuestPaint(entry, timeoutMs) {
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return Promise.resolve(false)
  let timer = null
  const painted = Promise.resolve()
    .then(() => view.executeJavaScript(GUEST_PAINT_SCRIPT))
    .then(
      (value) => value === 'ok' || value === 'no-raf',
      () => false,
    )
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    unrefTimer(timer)
  })
  return Promise.race([painted, expired]).then((paintedNow) => {
    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
    return paintedNow
  })
}

/** The guest committed a document (or failed to): a reveal no longer has to wait for it. */
function markCarrierReady(entry) {
  if (entry === null || entry === undefined) return
  entry.ready = true
  const waiters = Array.isArray(entry.readyWaiters) ? entry.readyWaiters : []
  entry.readyWaiters = []
  for (const resolve of waiters) resolve(true)
}

function waitForCarrierReady(entry, timeoutMs) {
  if (entry.ready === true) return Promise.resolve(true)
  return new Promise((resolve) => {
    entry.readyWaiters.push(resolve)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    unrefTimer(timer)
  })
}

/**
 * Make a carrier visible without painting its empty frame first. The desktop guest has no
 * surface while hidden, so revealing it as-is paints the carrier's own background; the browser
 * frame keeps its last frame, so it only needs the same one-frame opacity handoff. The carrier
 * goes up transparent, waits for its content (guest paint, or the frame's own compositor), and
 * only then becomes opaque. A reveal that lost its turn leaves the carrier hidden.
 */
async function revealCarrier(entry) {
  const token = (entry.revealToken ?? 0) + 1
  entry.revealToken = token
  entry.root.style.display = ''
  entry.root.style.opacity = '0'
  // Still transparent: the local page underneath stays the one receiving clicks.
  entry.root.style.pointerEvents = 'none'
  await nextLocalFrame()
  await entry.backend.waitReady(entry)
  await nextLocalFrame()
  if (entry.revealToken !== token || carrierPool.current !== entry.hostId) return
  entry.root.style.pointerEvents = ''
  entry.root.style.opacity = ''
}

async function showOverlayNow(hostId, options): Promise<CarrierShowResult> {
  const url = typeof options.url === 'string' ? options.url : ''
  let entry = carrierOf(hostId)
  const reused = entry !== null
  const surface = entry === null ? carrierSurface() : entry.kind
  // The revision of the attach this call actually navigated to. Only a real navigation
  // (a new carrier, or a reload of an existing one) may claim the new revision.
  let navigatedRev = null
  if (entry === null) {
    if (surface === null) return { ok: false, reason: 'acquire-failed' }
    if (!acceptsCarrierUrl(surface, url)) return { ok: false, reason: 'bad-url' }
    entry = await createCarrier(hostId, url, options.message, options)
    if (entry === null) return { ok: false, reason: 'acquire-failed' }
    navigatedRev = options.viewRev
    // The user moved on (another host, or back to local) while this one was being
    // built: drop it instead of stealing the window.
    if (carrierPool.wanted !== hostId) {
      await disposeCarrier(entry)
      return { ok: false, reason: 'superseded' }
    }
  } else if (
    url !== '' &&
    (entry.url !== url || (Number.isInteger(options.viewRev) && entry.viewRev !== options.viewRev)) &&
    acceptsCarrierUrl(entry.kind, url)
  ) {
    // A reconnect or a remote restart hands out a new one-shot URL and a new attach
    // revision: the warm page is stale, reload it.
    await entry.backend.load(entry, url)
    navigatedRev = options.viewRev
  }
  // The localized "not a DSH document" line is owned by the caller; a reload reuses the
  // entry but may carry a fresh translation.
  if (typeof options.message === 'string' && options.message !== '') entry.notDshMessage = options.message
  // Every caller (including the reuse branch) must respect the last request: the carrier
  // build is async, and a stale call used to take the window back from the host the user
  // actually chose (audit "wanted race").
  if (carrierPool.wanted !== hostId) return { ok: false, reason: 'superseded' }
  // Remember which attach this carrier was navigated for: the next attach invalidates it.
  if (navigatedRev !== null && Number.isInteger(navigatedRev)) entry.viewRev = navigatedRev
  // A desktop guest whose page failed is not worth showing as-is: retry it once.
  if (reused && entry.kind === 'desktop' && entry.failed === true) {
    entry.failed = false
    try {
      entry.view.reload()
    } catch (_error) {
      // swallow-ok: the guest may already be gone; reload is a best-effort retry
    }
  }
  for (const other of carrierPool.entries) {
    if (other === entry) continue
    other.root.style.display = 'none'
  }
  carrierPool.entries = [entry, ...carrierPool.entries.filter((item) => item !== entry)]
  const alreadyShown = carrierPool.current === hostId && entry.root.style.display !== 'none'
  carrierPool.current = hostId
  if (alreadyShown) {
    entry.root.style.pointerEvents = ''
    entry.root.style.opacity = ''
  } else {
    // Rendered over the next frames, once the carrier has something to show.
    revealCarrier(entry).catch(() => {})
  }
  // The band belongs to this guest now: keep the shell's caption menus above it, but
  // only when the guest actually reserved the band (otherwise the local band is intact).
  ownCaptionBand(entry, entry.captionApplied === true)
  updateSwitcher({ current: hostId })
  if (entry.rowInstalled === true) {
    pushGuestHostRow()
    if (typeof entry.backend.poll === 'function') entry.backend.poll(entry)
  }
  return { ok: true, reused }
}

function hideOverlays() {
  carrierPool.wanted = null
  if (carrierPool.current === null) return
  stopHostRowPoll()
  for (const entry of carrierPool.entries) entry.root.style.display = 'none'
  carrierPool.current = null
  // The local band is back: its menus belong to the page again, not above a guest.
  ownCaptionBand(null, false)
}

/** Set by the overlay host: a disposed carrier invalidates the launch URL kept for it. */
let onCarrierDisposed = null

/** Tear one carrier down. Safe for one that never entered the pool. */
async function disposeCarrier(entry) {
  if (entry === null || entry === undefined) return
  stopCarrierInstall(entry)
  if (carrierPool.poll === entry) stopHostRowPoll()
  carrierPool.entries = carrierPool.entries.filter((item) => item !== entry)
  // The window that filled the page is going away, so the local page is next: the row has to follow here as well.
  // The React state that asked for the teardown is not enough - a disconnect arrives through a subscription created
  // at mount, whose closure holds the target from that render, so it cannot clear it.
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
async function disposeDesktopCarrier(entry) {
  if (entry.view !== null && entry.rowInstalled === true) {
    try {
      const destroyed = entry.view.executeJavaScript('window.__drgHostRow && window.__drgHostRow.destroy()')
      if (destroyed && typeof destroyed.catch === 'function') destroyed.catch(() => {})
    } catch (_error) {
      // swallow-ok: the guest may already be gone; its DOM is removed right below
    }
  }
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

async function closeCarrier(hostId) {
  const entry = carrierOf(hostId)
  if (entry === null) return
  await disposeCarrier(entry)
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

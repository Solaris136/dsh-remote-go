// client/src/carrier-intents.ts - the guest intent allow-list/sanitizer/sink, the web install + row, the two backend descriptors and createCarrier (9b 10/11); after carrier-web.ts, before carrier-overlay.ts.
const GUEST_ACTIONS = new Set([
  'download-file',
  'open-external',
  'clipboard-write',
  'notify',
  'add',
  'manage',
  'disconnect',
])
/** The trust boundary for a framed page's requests: known actions only, and download/disconnect pinned to this host. */
// A host switch is accepted only for `local` or this host, so reaching a third host goes through Local first.
// A switch is accepted only for `local` or this host, so a third host from a remote page goes through Local.
function sanitizeGuestIntent(intent: GuestIntentLike, hostId: string): SafeGuestIntent | null {
  if (!intent || typeof intent !== 'object') return null
  const action = typeof intent.action === 'string' ? intent.action : ''
  if (action !== '' && GUEST_ACTIONS.has(action)) {
    if (action === 'download-file') {
      const path = typeof intent.path === 'string' ? intent.path : ''
      if (path === '' || path.charAt(0) !== '/') return null
      return {
        action,
        hostId,
        kind: intent.kind === 'directory' ? 'directory' : 'file',
        path,
        name: typeof intent.name === 'string' ? intent.name : '',
      }
    }
    if (action === 'disconnect') return intent.hostId === hostId ? { action, hostId } : null
    if (action === 'clipboard-write') {
      return {
        action,
        id: typeof intent.id === 'string' ? intent.id : undefined,
        text: typeof intent.text === 'string' ? intent.text : '',
      }
    }
    if (action === 'open-external') return { action, url: intent.url }
    if (action === 'notify') return { action, code: intent.code, tone: intent.tone, text: intent.text }
    return { action }
  }
  const target = typeof intent.target === 'string' ? intent.target : ''
  if (target === 'local' || (hostId !== '' && target === hostId)) return { target }
  return null
}
/** The sink handed to a framed page: sanitize, dispatch, report a refusal; the host id is bound here, not read. */
function guestIntentSink(entry: CarrierEntry): (intent: GuestIntentLike) => unknown {
  return (intent) => {
    const safe = sanitizeGuestIntent(intent, entry.hostId)
    if (safe === null) return { ok: false, reason: 'blocked-intent' }
    return dispatchSwitcherIntent(safe)
  }
}
/** Inject the row, download bridge, capability bridge and storage partition as plain functions, so no eval. */
// Each install is independent, so a page that refuses one of them still gets the others.
function installWebCarrier(entry: CarrierEntry, existingWindow?: Window | null): boolean {
  const win = existingWindow ?? webWindow(entry)
  if (!win) {
    entry.rowInstalled = false
    return false
  }
  try {
    win.__drgBridgeSink = guestIntentSink(entry)
  } catch (_error) {
    return false
  }
  let row: unknown
  try {
    row = mountHostRow(win)
  } catch (_error) {
    row = 'error'
  }
  const live = guestLive(row)
  entry.rowInstalled = live
  if (live) pushWebCarrierRow(entry, guestSwitcherPayload(entry.hostId))
  try {
    mountGuestTools(win)
  } catch (_error) {
    // swallow-ok: the download bridge is optional; the remote window still works without it
  }
  try {
    mountCapabilityBridge(win)
  } catch (_error) {
    // swallow-ok: the capability bridge is best effort; the framed page keeps its own behaviour
  }
  try {
    mountGuestStorage(win, entry.hostId)
  } catch (_error) {
    // swallow-ok: an unpartitioned frame is the old behaviour, not a broken window
  }
  return live
}
function pushWebCarrierRow(entry: CarrierEntry, payload: unknown) {
  const win = webWindow(entry)
  if (!win || !win.__drgHostRow || typeof win.__drgHostRow.update !== 'function') return
  try {
    win.__drgHostRow.update(payload)
  } catch (_error) {
    // swallow-ok: the frame may still be navigating; the next row push updates it
  }
}
const DESKTOP_CARRIER: CarrierBackend = {
  kind: 'desktop',
  create: (hostId, url, message, options) => createDesktopCarrier(hostId, url, message, options),
  load: async (entry, url) => {
    entry.url = url
    try {
      await entry.view.loadURL(url)
    } catch (_error) {
      // swallow-ok: navigation failures arrive through did-fail-load; this call is fire and forget
    }
  },
  pushRow: (entry, payload) =>
    fireGuestScript(entry, 'window.__drgHostRow && window.__drgHostRow.update(' + JSON.stringify(payload) + ')'),
  waitReady: async (entry) => {
    if (entry.ready !== true) await waitForCarrierReady(entry, CARRIER_READY_TIMEOUT_MS)
    await waitForGuestPaint(entry, CARRIER_PAINT_TIMEOUT_MS)
  },
  dispose: (entry) => disposeDesktopCarrier(entry),
  poll: (entry) => startHostRowPoll(entry),
}
const WEB_CARRIER: CarrierBackend = {
  kind: 'web',
  create: (hostId, url, message, options) => createWebCarrier(hostId, url, message, options),
  load: (entry, url) => {
    entry.url = url
    entry.rowInstalled = false
    entry.ready = false
    entry.installAttempts = 0
    stopCarrierInstall(entry)
    try {
      entry.frame.src = url
      if (entry.loadGuard) entry.loadGuard.arm()
    } catch (_error) {
      // swallow-ok: a frame that refuses a navigation reports it through the load event
    }
  },
  pushRow: (entry, payload) => pushWebCarrierRow(entry, payload),
  waitReady: async () => true,
  dispose: (entry) => disposeWebCarrier(entry),
  poll: null,
}
function createCarrier(
  hostId: string,
  url: string,
  message: unknown,
  options: CarrierShowOptions,
): CarrierEntry | Promise<CarrierEntry | null> | null {
  switch (carrierSurface()) {
    case null:
      return null
    case 'desktop':
      return createDesktopCarrier(hostId, url, message, options)
    default:
      return createWebCarrier(hostId, url, message, options)
  }
}

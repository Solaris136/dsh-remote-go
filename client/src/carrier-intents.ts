// client/src/carrier-intents.ts - the guest intent allow-list/sanitizer/sink, the web install + row, the two backend descriptors and createCarrier (9b 10/11); after carrier-web.ts, before carrier-overlay.ts.
/**
 * Inject the host row and the file bridge into the framed page. Both are ordinary functions
 * taking its window, so nothing is evaluated as a string (a CSP without 'unsafe-eval' cannot
 * break them) and the intent sink is a direct call back into this module.
 */
/** Guest actions that can never target another host. */
const GUEST_ACTIONS = new Set([
  'download-file',
  'open-external',
  'clipboard-write',
  'notify',
  'add',
  'manage',
  'disconnect',
])

/**
 * The trust boundary for everything a framed/guest page can ask the local half to do. The
 * document inside the carrier is the user's own remote DSH, but its intents used to be handed
 * to `switcher.dispatch` unchanged: a page could switch the whole window to any host id or
 * disconnect any host (audit "intent trust"). Now:
 *   - only the known actions pass (unknown actions are dropped);
 *   - a download or a disconnect is forced to this carrier's host, so a crafted `hostId` in
 *     the intent cannot reach a different one;
 *   - a host switch is only accepted for `local` or this carrier's own host; switching to a
 *     third host from a remote page goes through Local first (docs/design.md §4.8/§7).
 */
function sanitizeGuestIntent(intent: GuestIntentLike, hostId: string): SafeGuestIntent | null {
  if (!intent || typeof intent !== 'object') return null
  const action = typeof intent.action === 'string' ? intent.action : ''
  if (action !== '' && GUEST_ACTIONS.has(action)) {
    if (action === 'download-file') {
      const kind = intent.kind === 'directory' ? 'directory' : 'file'
      const path = typeof intent.path === 'string' ? intent.path : ''
      if (path === '' || path.charAt(0) !== '/') return null
      return {
        action,
        hostId,
        kind,
        path,
        name: typeof intent.name === 'string' ? intent.name : '',
      }
    }
    if (action === 'disconnect') {
      // The row a guest sees only contains Local and its own host, so the only legitimate
      // exit is its own. A forged id for another host is refused instead of being rewritten
      // into "disconnect myself" (review blocker 1).
      return intent.hostId === hostId ? { action, hostId } : null
    }
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

/** The sink handed to a framed page: sanitize, then dispatch (and report a refusal). */
function guestIntentSink(entry: CarrierEntry): (intent: GuestIntentLike) => unknown {
  return (intent) => {
    const safe = sanitizeGuestIntent(intent, entry.hostId)
    if (safe === null) return { ok: false, reason: 'blocked-intent' }
    return dispatchSwitcherIntent(safe)
  }
}

function installWebCarrier(entry: CarrierEntry, existingWindow?: Window | null): boolean {
  const win = existingWindow ?? webWindow(entry)
  if (!win) {
    entry.rowInstalled = false
    return false
  }
  try {
    // The page calls this function directly, so the host id is bound here rather than read
    // from the intent (a guest-supplied hostId must never win).
    win.__drgBridgeSink = guestIntentSink(entry)
  } catch (_error) {
    return false
  }
  // `mountHostRow` reports one of its own status strings; a throw means the row is unusable.
  let row: unknown
  try {
    row = mountHostRow(win)
  } catch (_error) {
    row = 'error'
  }
  const live = typeof row === 'string' && row !== 'error' && row !== 'no-document'
  entry.rowInstalled = live
  if (live) pushWebCarrierRow(entry, guestSwitcherPayload(entry.hostId))
  try {
    mountGuestTools(win)
  } catch (_error) {
    // swallow-ok: the download bridge is optional; the remote window still works without it
  }
  // Links, clipboard writes and notices cross the same channel; each install is independent,
  // so a page that refuses one of them still gets the others.
  try {
    mountCapabilityBridge(win)
  } catch (_error) {
    // swallow-ok: the capability bridge is best effort; the framed page keeps its own behaviour
  }
  try {
    // The frame shares this origin's store; give it the host's own key space.
    mountGuestStorage(win, entry.hostId)
  } catch (_error) {
    // swallow-ok: an unpartitioned frame is the old behaviour, not a broken window
  }
  return live
}

function pushWebCarrierRow(entry: CarrierEntry, payload: unknown) {
  try {
    const win = entry.frame && entry.frame.contentWindow
    if (win && win.__drgHostRow && typeof win.__drgHostRow.update === 'function') {
      win.__drgHostRow.update(payload)
    }
  } catch (_error) {
    // swallow-ok: the frame may still be navigating; the next row push updates it
  }
}

/** Desktop guest backend: the shell hands out a Chromium guest lease per host. */
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
  pushRow: (entry, payload) => {
    try {
      const answer = entry.view.executeJavaScript(
        'window.__drgHostRow && window.__drgHostRow.update(' + JSON.stringify(payload) + ')',
      )
      if (answer && typeof answer.catch === 'function') answer.catch(() => {})
    } catch (_error) {
      // swallow-ok: the guest may still be navigating; the next row push retries
    }
  },
  waitReady: async (entry) => {
    if (entry.ready !== true) await waitForCarrierReady(entry, CARRIER_READY_TIMEOUT_MS)
    await waitForGuestPaint(entry, CARRIER_PAINT_TIMEOUT_MS)
  },
  dispose: (entry) => disposeDesktopCarrier(entry),
  poll: (entry) => startHostRowPoll(entry),
}

/** Web frame backend: a same-origin iframe, warmed and hidden exactly like the guest. */
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

/** Build the carrier that fits this window: guest when the shell offers one, frame otherwise. */
function createCarrier(
  hostId: string,
  url: string,
  message: unknown,
  options: CarrierShowOptions,
): CarrierEntry | Promise<CarrierEntry | null> | null {
  const surface = carrierSurface()
  if (surface === null) return null
  return surface === 'desktop'
    ? createDesktopCarrier(hostId, url, message, options)
    : createWebCarrier(hostId, url, message, options)
}

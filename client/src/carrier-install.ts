// client/src/carrier-install.ts - install the row/tools/bridge into a guest, replyToGuest and the host-row poll (9b 6/11); after carrier-pool.ts, before carrier-caption.ts.
async function installHostRow(entry: CarrierEntry | null | undefined): Promise<boolean> {
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return false
  let status
  try {
    status = await view.executeJavaScript(HOST_ROW_SCRIPT)
  } catch (_error) {
    status = 'error'
  }
  // 'collapsed' and 'no-anchor' still mean the handle exists: the next state push
  // places the row as soon as the remote sidebar is wide enough to hold it.
  const live = typeof status === 'string' && status !== 'error' && status !== 'no-document'
  entry.rowInstalled = live
  if (live && carrierPool.current === entry.hostId) pushGuestHostRow()
  return live
}

/**
 * Install the guest-side download bridge after every load stop. It shares the
 * row's intent queue, so its install is independent of where the row landed.
 */
async function installGuestTools(entry: CarrierEntry | null | undefined): Promise<boolean> {
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return false
  try {
    const status = await view.executeJavaScript(GUEST_TOOLS_SCRIPT)
    return typeof status === 'string' && status !== 'error' && status !== 'no-document'
  } catch (_error) {
    return false
  }
}

/** The capability bridge's guest copy: same channel as the download bridge, one per load stop. */
async function installCapabilityBridge(entry: CarrierEntry | null | undefined): Promise<boolean> {
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return false
  try {
    const status = await view.executeJavaScript(CAPABILITY_BRIDGE_SCRIPT)
    return typeof status === 'string' && status !== 'error' && status !== 'no-document'
  } catch (_error) {
    return false
  }
}

/** Hand one bridge answer back to the guest; the desktop carrier has no direct callback. */
function replyToGuest(
  entry: CarrierEntry | null | undefined,
  id: unknown,
  result: { ok?: unknown } | null | undefined,
) {
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return
  const payload = JSON.stringify({ id: String(id), ok: Boolean(result && result.ok === true) })
  try {
    const answer = view.executeJavaScript('window.__drgCapabilityReply && window.__drgCapabilityReply(' + payload + ')')
    if (answer && typeof answer.catch === 'function') answer.catch(() => {})
  } catch (_error) {
    // swallow-ok: the guest may have navigated away before the reply was written
  }
}

function startHostRowPoll(entry: CarrierEntry) {
  stopHostRowPoll()
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return
  carrierPool.poll = entry
  // One drain at a time: an overlapping read of the same intent must not dispatch twice.
  let draining = false
  entry.timer = setInterval(() => {
    if (carrierPool.poll !== entry || carrierPool.current !== entry.hostId) return
    if (draining) return
    let pending: Promise<unknown> | null = null
    try {
      pending = view.executeJavaScript(TAKE_INTENTS_SCRIPT)
    } catch (_error) {
      return
    }
    if (pending === null || typeof pending.then !== 'function') return
    draining = true
    // A guest that stops answering must not keep `draining` true forever: the drain would
    // never run again and the row/capability bridge would go dead silently.
    withTimeout(pending, 5000)
      .then((value) => {
        if (!value || !Array.isArray(value) || value.length === 0 || carrierPool.poll !== entry) return
        for (const intent of value) {
          // A rail report is news about the band, not a click: it moves this page's caption
          // menubar and must never reach the intent dispatch.
          if (isCaptionSidebarIntent(intent)) {
            applyGuestSidebar(entry, intent.collapsed === true, typeof intent.start === 'string' ? intent.start : '')
            continue
          }
          // File intents belong to the host whose guest queued them, and every guest intent
          // goes through the same whitelist/hostId override as the browser frame.
          const safe = sanitizeGuestIntent(intent, entry.hostId)
          const answer = safe === null ? undefined : dispatchSwitcherIntent(safe)
          // A capability intent carries the id its guest is waiting on; answer it even when
          // the dispatch refused it (`ok:false`) so the page can fail instead of hanging.
          if (intent && typeof intent.id === 'string' && intent.id !== '') {
            // A receipt is an object with `then`; a boolean has never been thenable, so the
            // object test narrows without changing which answers take the promise path.
            if (answer && typeof answer === 'object' && typeof answer.then === 'function') {
              answer.then(
                (result) => replyToGuest(entry, intent.id, result),
                () => replyToGuest(entry, intent.id, { ok: false }),
              )
            } else {
              replyToGuest(entry, intent.id, { ok: answer === true })
            }
          }
        }
      })
      .catch(() => {})
      .then(() => {
        draining = false
      })
  }, 400)
  unrefTimer(entry.timer)
}

function stopHostRowPoll() {
  const entry = carrierPool.poll
  carrierPool.poll = null
  if (entry !== null && entry !== undefined && entry.timer !== null && entry.timer !== undefined) {
    if (typeof clearInterval === 'function') clearInterval(entry.timer)
    entry.timer = null
  }
}

// client/src/carrier-install.ts - install the row/tools/bridge into a guest, replyToGuest and the host-row poll (9b 6/11); after carrier-pool.ts, before carrier-caption.ts.
/** The status test the three injections share: anything but a refusal means the injected handle exists. */
function guestLive(status: unknown): boolean {
  return typeof status === 'string' && status !== 'error' && status !== 'no-document'
}
/** Install the host row: 'collapsed' and 'no-anchor' still mean the handle exists, so the next push places it. */
async function installHostRow(entry: MaybeCarrier): Promise<boolean> {
  // No guest means no verdict to record: the entry keeps whatever the previous document reported.
  if (!entry || guestView(entry) === null) return false
  const live = guestLive(await runGuestScript(entry, HOST_ROW_SCRIPT, 'error'))
  entry.rowInstalled = live
  if (live && carrierPool.current === entry.hostId) pushGuestHostRow()
  return live
}
/** Install the download bridge after every load stop: it shares the row's queue but not its install. */
async function installGuestTools(entry: MaybeCarrier): Promise<boolean> {
  return guestLive(await runGuestScript(entry, GUEST_TOOLS_SCRIPT, 'error'))
}
/** The capability bridge's guest copy: same channel as the download bridge, one install per load stop. */
async function installCapabilityBridge(entry: MaybeCarrier): Promise<boolean> {
  return guestLive(await runGuestScript(entry, CAPABILITY_BRIDGE_SCRIPT, 'error'))
}
/** Hand one bridge answer back to the guest; the desktop carrier has no direct callback, only this eval channel. */
function replyToGuest(entry: MaybeCarrier, id: unknown, result: { ok?: unknown } | null | undefined) {
  const payload = JSON.stringify({ id: String(id), ok: Boolean(result && result.ok === true) })
  fireGuestScript(entry, 'window.__drgCapabilityReply && window.__drgCapabilityReply(' + payload + ')')
}
/** The row's intent poll: one drain at a time, a 5 s ceiling, so a silent guest cannot block it forever. */
function startHostRowPoll(entry: CarrierEntry) {
  stopHostRowPoll()
  const view = guestView(entry)
  if (view === null) return
  carrierPool.poll = entry
  let draining = false
  entry.timer = setInterval(() => {
    if (carrierPool.poll !== entry || carrierPool.current !== entry.hostId || draining) return
    let pending: Promise<unknown> | null = null
    try {
      pending = view.executeJavaScript(TAKE_INTENTS_SCRIPT)
    } catch (_error) {
      return
    }
    if (pending === null || typeof pending.then !== 'function') return
    draining = true
    withTimeout(pending, 5000)
      .then((value) => {
        if (!value || !Array.isArray(value) || value.length === 0 || carrierPool.poll !== entry) return
        for (const intent of value) {
          // A rail report is news about the band, not a click: it moves the menubar and never reaches the dispatch.
          if (isCaptionSidebarIntent(intent)) {
            applyGuestSidebar(entry, intent.collapsed === true, typeof intent.start === 'string' ? intent.start : '')
            continue
          }
          // Every guest intent goes through the same allow-list and hostId override as the browser frame.
          const safe = sanitizeGuestIntent(intent, entry.hostId)
          const answer = safe === null ? undefined : dispatchSwitcherIntent(safe)
          if (!intent || typeof intent.id !== 'string' || intent.id === '') continue
          // A capability intent carries the id its guest awaits, so answer even on refusal; a receipt has `then`.
          if (answer && typeof answer === 'object' && typeof answer.then === 'function') {
            answer.then(
              (result) => replyToGuest(entry, intent.id, result),
              () => replyToGuest(entry, intent.id, { ok: false }),
            )
          } else {
            replyToGuest(entry, intent.id, { ok: answer === true })
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

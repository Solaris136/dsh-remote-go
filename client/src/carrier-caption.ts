// client/src/carrier-caption.ts - caption band, the sidebar mirror and the scripts injected for them (9b 7/11); after carrier-install.ts, before carrier-desktop.ts.
/** The page's root element, or null where there is no page (a guest document is reached through its own window). */
function documentRoot(): HTMLElement | null {
  return typeof document === 'undefined' || !document.documentElement ? null : document.documentElement
}
/** The caption band this page reserves, or null: without it the remote UI would lay out as the Web build. */
function desktopCaption(): { height: number } | null {
  const root = documentRoot()
  if (root === null) return null
  if (!root.hasAttribute(CAPTION_MARKER)) return null
  let height = CAPTION_FALLBACK_HEIGHT
  if (typeof getComputedStyle === 'function') {
    try {
      const raw = getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height')
      const parsed = Number.parseFloat(String(raw))
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 200) height = parsed
    } catch (_error) {
      // swallow-ok: a titlebar height that cannot be read keeps the measured fallback
    }
  }
  return { height }
}
/** The menubar inset for a collapsed or expanded band: the guest hands over what DSH's own rule resolves there. */
// The constants are only the fallback for a guest that cannot answer, so a DSH that changes the number still works.
function captionMenuStart(collapsed: unknown, start?: unknown): string {
  const raw = typeof start === 'string' ? start.trim() : ''
  // `getComputedStyle` resolves it to px; a unitless value counts as px too, since the old px-only regex dropped it.
  if (/^\d+(?:\.\d+)?(?:px)?$/.test(raw) && Number.parseFloat(raw) <= CAPTION_MENU_MAX)
    return raw.replace(/px$/, '') + 'px'
  return (collapsed === true ? CAPTION_MENU_START_COLLAPSED : CAPTION_MENU_START) + 'px'
}
/** Publish where the caption menubar starts. Inline, which wins over the shell's stylesheet without touching it, and
 * only while a guest owns the band; `collapsed === null` removes the override again and leaves DSH's own rule in charge. */
function setCaptionMenuStart(collapsed: unknown, start?: unknown): boolean {
  const target = documentRoot()
  if (target === null || !target.style) return false
  if (typeof target.style.setProperty !== 'function') return false
  if (collapsed === null || collapsed === undefined) {
    if (typeof target.style.removeProperty === 'function') target.style.removeProperty(CAPTION_MENU_VAR)
    return true
  }
  target.style.setProperty(CAPTION_MENU_VAR, captionMenuStart(collapsed, start))
  return true
}
/** The band belongs to its owner: the collapsed rail's new-session control sits at 48px, where the menubar starts. */
// `collapsed === null` means "this document has not told us yet", so the state is forgotten, never carried over.
function applyGuestSidebar(entry: MaybeCarrier, collapsed: unknown, start?: unknown) {
  if (entry === null || entry === undefined) return
  entry.sidebarCollapsed = collapsed === true ? true : collapsed === false ? false : null
  entry.sidebarStart = typeof start === 'string' ? start : ''
  if (carrierPool.current !== entry.hostId || entry.captionApplied !== true) return
  setCaptionMenuStart(entry.sidebarCollapsed === true, entry.sidebarStart)
}
/** True when an intent is the guest's rail report rather than a click on the switcher row. */
function isCaptionSidebarIntent(intent: GuestIntentLike | null | undefined): boolean {
  return intent !== null && typeof intent === 'object' && intent.action === CAPTION_SIDEBAR_INTENT
}
/** Guest half: report the rail state and the inset DSH resolves for it; `executeJavaScript` is the only way back. */
// Both change long after load, so the watcher leaves one intent in the queue the row and file bridge already use.
function mountSidebarMirror(win: Window): unknown {
  try {
    var doc = win.document
    if (!doc || !doc.documentElement) return 'no-document'
    if (win.__drgSidebarMirror === true) return 'already'
    win.__drgSidebarMirror = true
    var read = function () {
      var frame = doc.querySelector('[data-sidebar-collapsed]')
      return frame !== null && frame.getAttribute('data-sidebar-collapsed') !== 'false'
    }
    var readStart = function () {
      try {
        if (typeof win.getComputedStyle !== 'function') return ''
        var computed = win.getComputedStyle(doc.documentElement)
        if (!computed || typeof computed.getPropertyValue !== 'function') return ''
        var value = computed.getPropertyValue('--dsh-windows-menu-start')
        return typeof value === 'string' ? value.trim() : ''
      } catch (_error) {
        return ''
      }
    }
    var current = function () {
      return { collapsed: read(), start: readStart() }
    }
    var last: { collapsed: boolean; start: string } | null = null
    var report = function () {
      var state = current()
      if (last !== null && state.collapsed === last.collapsed && state.start === last.start) return
      last = state
      var queue = win.__drgBridgeQueue
      if (!queue || typeof queue.push !== 'function') queue = []
      queue.push({ action: 'caption-sidebar', collapsed: state.collapsed, start: state.start })
      win.__drgBridgeQueue = queue
    }
    if (typeof win.MutationObserver === 'function') {
      new win.MutationObserver(report).observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ['data-sidebar-collapsed'],
        subtree: true,
      })
    }
    report()
    return current()
  } catch (_error) {
    return 'error'
  }
}
const SIDEBAR_MIRROR_SCRIPT = '(' + mountSidebarMirror.toString() + ')(window)'
/** One round trip that takes the guest's intents and clears them: two calls let one queued between them be wiped. */
// A wiped rail report never comes back, because the guest already recorded that state as reported.
const TAKE_INTENTS_SCRIPT = '(function(){var q=window.__drgBridgeQueue||[];window.__drgBridgeQueue=[];return q})()'
/** Install the rail watcher in the guest and adopt its report at once; the intent poll only carries later changes. */
async function installSidebarMirror(entry: MaybeCarrier): Promise<boolean> {
  const state = await runGuestScript<GuestSidebarReport | null>(entry, SIDEBAR_MIRROR_SCRIPT, null)
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false
  if (typeof state.collapsed !== 'boolean') return false
  applyGuestSidebar(entry, state.collapsed, typeof state.start === 'string' ? state.start : '')
  return true
}
/** Teach the guest the desktop layout: titlebar marker, band height, and fullscreen, which drops the band insets. */
async function applyGuestCaption(entry: MaybeCarrier): Promise<boolean> {
  const caption = entry === null || entry === undefined ? null : entry.caption
  if (caption === null || caption === undefined) return false
  let fullscreen = false
  try {
    fullscreen = document.documentElement.hasAttribute('data-fullscreen')
  } catch (_error) {
    fullscreen = false
  }
  const source =
    '(function(){var root=document.documentElement;if(!root)return "no-document";' +
    'root.setAttribute("' +
    CAPTION_MARKER +
    '","");' +
    'root.style.setProperty("--dsh-windows-titlebar-height","' +
    caption.height +
    'px");' +
    'root.toggleAttribute("data-fullscreen",' +
    (fullscreen === true ? 'true' : 'false') +
    ');' +
    'return "ok"})()'
  return (await runGuestScript(entry, source, '')) === 'ok'
}
function watchCaptionState() {
  if (captionStateWatcher !== null || typeof MutationObserver !== 'function') return
  const root = documentRoot()
  if (root === null) return
  captionStateWatcher = new MutationObserver(() => {
    const entry = shownCarrier()
    if (entry === null || entry.captionApplied !== true) return
    applyGuestCaption(entry)
  })
  captionStateWatcher.observe(root, {
    attributes: true,
    attributeFilter: ['data-fullscreen'],
  })
}
/** Exactly one band, never two: the guest reserves it when the marker landed, else the carrier is pushed below it. */
function syncCarrierCaption(entry: MaybeCarrier, applied: unknown) {
  const caption = entry === null || entry === undefined ? null : entry.caption
  if (caption === null || caption === undefined) return
  entry.captionApplied = applied === true
  entry.root.style.top = entry.captionApplied ? '0px' : caption.height + 'px'
  if (entry.grip !== null && entry.grip !== undefined) entry.grip.style.display = entry.captionApplied ? '' : 'none'
  if (carrierPool.current === entry.hostId) ownCaptionBand(entry, entry.captionApplied === true)
}
function setCaptionLive(live: unknown) {
  const root = documentRoot()
  if (root === null) return
  if (live === true) root.classList.add(CAPTION_LIVE_CLASS)
  else root.classList.remove(CAPTION_LIVE_CLASS)
}
function ownCaptionBand(entry: MaybeCarrier, owned: unknown) {
  const mine = owned === true && entry !== null && entry !== undefined
  setCaptionLive(mine)
  setCaptionMenuStart(mine ? entry.sidebarCollapsed === true : null, mine ? entry.sidebarStart : '')
}

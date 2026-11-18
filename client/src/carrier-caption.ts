// client/src/carrier-caption.ts - caption band, the sidebar mirror and the scripts injected for them (9b 7/11); after carrier-install.ts, before carrier-desktop.ts.
/**
 * The caption band this page reserves, or null. A guest page has no preload, so the remote UI
 * would otherwise lay out as the Web build inside a window that is not one.
 */
function desktopCaption() {
  if (typeof document === 'undefined' || !document.documentElement) return null
  const root = document.documentElement
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

/**
 * The caption menubar's inset for a band whose sidebar is collapsed or expanded. The guest
 * hands over the value DSH's own rule resolves to there (`84px` collapsed, nothing expanded),
 * so a DSH that changes the number keeps working; the constants above are only the fallback for
 * a guest that cannot answer.
 */
function captionMenuStart(collapsed, start = '') {
  const raw = typeof start === 'string' ? start.trim() : ''
  // `getComputedStyle` normally resolves the custom property to px; a unitless value is read
  // as px as well, because the old px-only regex dropped a perfectly good number (audit).
  if (/^\d+(?:\.\d+)?(?:px)?$/.test(raw) && Number.parseFloat(raw) <= CAPTION_MENU_MAX)
    return raw.replace(/px$/, '') + 'px'
  return (collapsed === true ? CAPTION_MENU_START_COLLAPSED : CAPTION_MENU_START) + 'px'
}

/**
 * Publish where the caption menubar starts. The band normally belongs to the local page, whose
 * own `html[data-windows-titlebar]:has([data-sidebar-collapsed])` rule (and the preload's 48px
 * default behind it) decides the inset, so this only writes while a guest owns the band — inline,
 * which wins over that stylesheet without touching it — and removes the override again when the
 * local page takes the band back, leaving DSH's own rule in charge.
 */
function setCaptionMenuStart(collapsed, start = '') {
  const target = typeof document === 'undefined' ? null : document.documentElement
  if (target === null || target === undefined || !target.style) return false
  if (typeof target.style.setProperty !== 'function') return false
  if (collapsed === null || collapsed === undefined) {
    if (typeof target.style.removeProperty === 'function') target.style.removeProperty(CAPTION_MENU_VAR)
    return true
  }
  target.style.setProperty(CAPTION_MENU_VAR, captionMenuStart(collapsed, start))
  return true
}

/**
 * The band's controls belong to the band's owner (issue #63): the collapsed rail puts the
 * new-session control in the band at 48px, which is exactly where the local page's caption
 * menubar starts until the local sidebar collapses as well. A guest that reserves the band
 * therefore decides that inset, the same way the local sidebar's rule does when it owns it.
 * `collapsed === null` means "this document has not told us yet": the state is forgotten rather
 * than carried over from the page that navigated away.
 */
function applyGuestSidebar(entry, collapsed, start = '') {
  if (entry === null || entry === undefined) return
  entry.sidebarCollapsed = collapsed === true ? true : collapsed === false ? false : null
  entry.sidebarStart = typeof start === 'string' ? start : ''
  if (carrierPool.current !== entry.hostId || entry.captionApplied !== true) return
  setCaptionMenuStart(entry.sidebarCollapsed === true, entry.sidebarStart)
}

/** True when an intent is the guest's rail report rather than a click on the switcher row. */
function isCaptionSidebarIntent(intent) {
  return intent !== null && typeof intent === 'object' && intent.action === CAPTION_SIDEBAR_INTENT
}

/**
 * Guest half: report the remote sidebar's rail state and the caption menubar inset DSH's own
 * rule resolves for it. Both change long after the document loaded, and `executeJavaScript` is
 * the desktop guest's only channel back, so the watcher leaves one intent in the bridge queue
 * the row and the file bridge already use. Returns the same record at install time, which the
 * host adopts before waiting for the next drain.
 */
function mountSidebarMirror(win) {
  try {
    var doc = win.document
    if (!doc || !doc.documentElement) return 'no-document'
    if (win.__drgSidebarMirror === true) return 'already'
    win.__drgSidebarMirror = true
    // The frame DSH collapses carries the mark its own caption rule keys on. Presence is the
    // signal (a rail is collapsed or it is not); only an explicit "false" says otherwise.
    var read = function () {
      var frame = doc.querySelector('[data-sidebar-collapsed]')
      return frame !== null && frame.getAttribute('data-sidebar-collapsed') !== 'false'
    }
    // The guest carries the desktop marker, so DSH's sidebar rule resolves the menubar inset
    // here too: hand the authoritative value over instead of repeating its number.
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
    var last = null
    var report = function () {
      var state = current()
      if (last !== null && state.collapsed === last.collapsed && state.start === last.start) return
      last = state
      // Read the queue fresh: the host replaces the array after every drain. The action name
      // has to match CAPTION_SIDEBAR_INTENT (a stringified guest cannot close over it).
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

/**
 * One round trip that hands this guest's queued intents over and clears them together. Reading
 * (the old `window.__drgBridgeQueue || []`) and clearing in two calls left a window for an
 * intent queued in between to be wiped — and a wiped rail report never comes back, because the
 * guest already recorded that state as reported.
 */
const TAKE_INTENTS_SCRIPT = '(function(){var q=window.__drgBridgeQueue||[];window.__drgBridgeQueue=[];return q})()'

/**
 * Install the rail watcher in the shown guest and adopt what it reports right away; the row's
 * intent poll only carries the changes that follow.
 */
async function installSidebarMirror(entry) {
  const view = entry && entry.view
  if (!view || typeof view.executeJavaScript !== 'function') return false
  let state = null
  try {
    state = await view.executeJavaScript(SIDEBAR_MIRROR_SCRIPT)
  } catch (_error) {
    state = null
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false
  if (typeof state.collapsed !== 'boolean') return false
  applyGuestSidebar(entry, state.collapsed, typeof state.start === 'string' ? state.start : '')
  return true
}

async function applyGuestCaption(entry) {
  const caption = entry === null || entry === undefined ? null : entry.caption
  if (caption === null || caption === undefined) return false
  const view = entry.view
  if (view === null || view === undefined || typeof view.executeJavaScript !== 'function') return false
  // Fullscreen drops the insets derived from the caption band (the window controls are
  // hidden), so the guest has to mirror the flag as well as the band.
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
  let status = ''
  try {
    status = await view.executeJavaScript(source)
  } catch (_error) {
    status = ''
  }
  return status === 'ok'
}

function watchCaptionState() {
  if (captionStateWatcher !== null || typeof MutationObserver !== 'function') return
  if (typeof document === 'undefined' || !document.documentElement) return
  captionStateWatcher = new MutationObserver(() => {
    const entry = shownCarrier()
    if (entry === null || entry.captionApplied !== true) return
    applyGuestCaption(entry)
  })
  captionStateWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-fullscreen'],
  })
}

/** Exactly one band, never two: the guest reserves it when the marker landed, else it is pushed below. */
function syncCarrierCaption(entry, applied) {
  const caption = entry === null || entry === undefined ? null : entry.caption
  if (caption === null || caption === undefined) return
  entry.captionApplied = applied === true
  entry.root.style.top = entry.captionApplied ? '0px' : caption.height + 'px'
  if (entry.grip !== null && entry.grip !== undefined) {
    entry.grip.style.display = entry.captionApplied ? '' : 'none'
  }
  if (carrierPool.current === entry.hostId) ownCaptionBand(entry, entry.captionApplied === true)
}

function setCaptionLive(live) {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (live === true) document.documentElement.classList.add(CAPTION_LIVE_CLASS)
  else document.documentElement.classList.remove(CAPTION_LIVE_CLASS)
}

/**
 * The band changed hands. A guest that reserves it gets the marks this page needs while it is
 * in front — the shell's caption menus above the guest, and the menubar inset from the guest's
 * own rail — and the local page takes both back when no guest owns the band.
 */
function ownCaptionBand(entry, owned) {
  const mine = owned === true && entry !== null && entry !== undefined
  setCaptionLive(mine)
  // A guest that has not reported its rail yet keeps the band's own default (the shell's 48px),
  // never a value remembered from the document it replaced.
  setCaptionMenuStart(mine ? entry.sidebarCollapsed === true : null, mine ? entry.sidebarStart : '')
}

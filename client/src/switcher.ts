// client/src/switcher.ts - host switcher row state/payloads and the one external-window call site (region 9b 1/11); after connect-window.ts, before guest-host-row.ts.
//#region 9b. host switcher row + remote carrier backends

const SWITCHER_TICK_MS = 1500

/** What both copies of the row show. The row is plain DOM: it must outlive React re-renders. */
const switcher = {
  current: 'local',
  hosts: [],
  labels: { local: 'Local', addHost: 'Add host', manage: 'Manage hosts', exit: 'Exit remote' },
  dispatch: null,
  labelsOf: null,
  installed: false,
}

function switcherPayload() {
  const hosts = []
  for (const host of switcher.hosts) {
    if (!host || typeof host.id !== 'string') continue
    hosts.push({
      id: host.id,
      name: host.name || '',
      address: host.address || '',
      status: host.status || 'idle',
    })
  }
  // A host deleted elsewhere must not leave the row naming a target that is gone.
  const known = switcher.current === 'local' || hosts.some((host) => host.id === switcher.current)
  const labels = typeof switcher.labelsOf === 'function' ? switcher.labelsOf() : switcher.labels
  return {
    current: known ? switcher.current : 'local',
    hosts,
    labels: {
      local: labels.local,
      addHost: labels.addHost,
      manage: labels.manage,
      exit: labels.exit,
    },
  }
}

function updateSwitcher(patch) {
  if (patch && typeof patch === 'object') {
    if (Array.isArray(patch.hosts)) {
      switcher.hosts = patch.hosts.filter((host) => host && typeof host.id === 'string')
    }
    if (typeof patch.current === 'string' && patch.current.length > 0) switcher.current = patch.current
    if (patch.labels && typeof patch.labels === 'object') {
      switcher.labels = { ...switcher.labels, ...patch.labels }
    }
  }
  const payload = switcherPayload()
  pushLocalHostRow(payload)
  pushGuestHostRow()
  return payload
}

function localWindow() {
  return typeof window === 'undefined' || !window.document ? null : window
}

function pushLocalHostRow(payload) {
  const win = localWindow()
  if (win === null) return false
  // The local row talks to this module directly instead of being polled.
  win.__drgBridgeSink = dispatchSwitcherIntent
  let status = 'absent'
  if (win.__drgHostRow && typeof win.__drgHostRow.update === 'function') {
    try {
      status = win.__drgHostRow.update(payload)
    } catch (_error) {
      status = 'error'
    }
  }
  if (status === 'absent' || status === 'error') {
    try {
      // A half-installed row must be dismantled before a second mount: the old code only
      // dropped the reference, leaving its DOM/listeners behind (audit "reinstall not
      // idempotent").
      if (win.__drgHostRow && typeof win.__drgHostRow.destroy === 'function') win.__drgHostRow.destroy()
      win.__drgHostRow = null
      status = mountHostRow(win)
      if (status === 'installed') win.__drgHostRow.update(payload)
    } catch (_error) {
      status = 'error'
    }
  }
  switcher.installed = status === 'installed'
  return switcher.installed
}

/**
 * The row payload for a carrier's own page. A guest must not render other hosts' rows at
 * all: its exit control is bound to its own host, and a forged intent for another host is
 * refused by `sanitizeGuestIntent` (audit review). So the projection is `local + own host`;
 * cross-host switching from a remote page goes through Local first.
 */
function guestSwitcherPayload(hostId) {
  const payload = switcherPayload()
  return {
    ...payload,
    current: payload.current === hostId ? hostId : 'local',
    hosts: payload.hosts.filter((host) => host.id === hostId),
  }
}

function pushGuestHostRow() {
  const entry = shownCarrier()
  if (entry === null || entry.rowInstalled !== true) return
  try {
    entry.backend.pushRow(entry, guestSwitcherPayload(entry.hostId))
  } catch (_error) {
    // the framed page or guest may still be navigating
  }
}

function dispatchSwitcherIntent(intent) {
  if (!intent || typeof intent !== 'object') return undefined
  if (typeof switcher.dispatch === 'function') return switcher.dispatch(intent)
  return undefined
}

// The capability bridge's local half: link validation and the one new-window call site.
/**
 * The only URL shape this page will hand to a browser tab or to the OS: an absolute http(s)
 * address with a host and no credentials. `javascript:`, `data:`, `file:` and `blob:` are the
 * obvious ways a framed page could escalate, and they all end here.
 */
function externalUrlOf(value) {
  if (typeof value !== 'string' || value === '' || value.length > 8192) return null
  let url
  try {
    url = new URL(value)
  } catch (_error) {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  if (url.username !== '' || url.password !== '') return null
  return url.href
}

/**
 * Open one user-picked link in this page. The framed page cannot do it: a subdocument's
 * `window.open` needs `allow-popups`, a gesture of its own and a place to show the tab, so the
 * request travels here and this document performs it.
 *
 * `noopener,noreferrer` is not negotiable — the opened site must not reach this page's
 * `window.opener`, and the Referer must not carry this page's URL (it holds the local launch
 * token). Those features also make a *successful* open return `null`, so the return value says
 * nothing about whether the browser's popup blocker refused the tab; the click that started it
 * is a real gesture, which is what the blocker actually checks.
 */
function openExternalUrl(value) {
  const url = externalUrlOf(value)
  if (url === null) return 'blocked'
  const win = localWindow()
  if (win === null || typeof win.open !== 'function') return 'unavailable'
  try {
    win.open(url, '_blank', 'noopener,noreferrer')
  } catch (_error) {
    return 'unavailable'
  }
  return 'opened'
}

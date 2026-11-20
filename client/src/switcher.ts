// client/src/switcher.ts - host switcher row state/payloads and the one external-window call site (region 9b 1/11); after connect-window.ts, before guest-host-row.ts.
const SWITCHER_TICK_MS = 1500
const switcher: SwitcherState = {
  current: 'local',
  hosts: [],
  labels: { local: 'Local', addHost: 'Add host', manage: 'Manage hosts', exit: 'Exit remote' },
  dispatch: null,
  labelsOf: null,
  installed: false,
}
function switcherPayload(): SwitcherPayload {
  const hosts: SwitcherHost[] = []
  for (const host of switcher.hosts) {
    if (!host || typeof host.id !== 'string') continue
    hosts.push({ id: host.id, name: host.name || '', address: host.address || '', status: host.status || 'idle' })
  }
  const known = switcher.current === 'local' || hosts.some((host) => host.id === switcher.current)
  const labels = typeof switcher.labelsOf === 'function' ? switcher.labelsOf() : switcher.labels
  return {
    current: known ? switcher.current : 'local',
    hosts,
    labels: { local: labels.local, addHost: labels.addHost, manage: labels.manage, exit: labels.exit },
  }
}
function updateSwitcher(patch?: SwitcherPatch): SwitcherPayload {
  if (patch && typeof patch === 'object') {
    if (Array.isArray(patch.hosts)) switcher.hosts = patch.hosts.filter((host) => host && typeof host.id === 'string')
    if (typeof patch.current === 'string' && patch.current.length > 0) switcher.current = patch.current
    if (patch.labels && typeof patch.labels === 'object') switcher.labels = { ...switcher.labels, ...patch.labels }
  }
  const payload = switcherPayload()
  pushLocalHostRow(payload)
  pushGuestHostRow()
  return payload
}
function localWindow(): Window | null {
  return typeof window === 'undefined' || !window.document ? null : window
}
function pushLocalHostRow(payload: SwitcherPayload): boolean {
  const win = localWindow()
  if (win === null) return false
  win.__drgBridgeSink = dispatchSwitcherIntent
  let status: unknown = 'absent'
  if (win.__drgHostRow && typeof win.__drgHostRow.update === 'function') {
    try {
      status = win.__drgHostRow.update(payload)
    } catch (_error) {
      status = 'error'
    }
  }
  if (status === 'absent' || status === 'error') {
    try {
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
/** A guest must not render other hosts' rows: its exit is bound to its own host, and a forged intent is refused. */
// So the projection is `local + own host`; cross-host switching from a remote page goes through Local first.
function guestSwitcherPayload(hostId: string): SwitcherPayload {
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
    // swallow-ok: the framed page or guest may still be navigating; the next push updates it
  }
}
function dispatchSwitcherIntent(intent: SafeGuestIntent | null | undefined): IntentReceipt | boolean | undefined {
  if (!intent || typeof intent !== 'object') return undefined
  return typeof switcher.dispatch === 'function' ? switcher.dispatch(intent) : undefined
}
/** The only URL shape this page hands to a browser tab or the OS: absolute http(s), a host, no credentials. */
// `javascript:`, `data:`, `file:` and `blob:` are how a framed page could escalate, and they all end here.
function externalUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 8192) return null
  let url
  try {
    url = new URL(value)
  } catch (_error) {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null
  return url.href
}
/** Open a user-picked link here: a framed `window.open` needs allow-popups and a gesture, so this document does it. */
// `noopener,noreferrer` is not negotiable: no `window.opener`, no launch-token Referer, and success returns `null`.
function openExternalUrl(value: unknown): 'blocked' | 'unavailable' | 'opened' {
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

// client/src/constants.ts - NS, API/event paths, retry + caption constants, PHASES, DIAGNOSE_IDS, TONE_VARS, STATUS, statusOf; after react.ts, before i18n-dict.ts.
//#region 1. constants

const NS = 'dsh-remote-go'
const PANEL_ID = 'dsh-remote-go'
const API_BASE = '/dsh-remote-go/api'
const EVENT_PATH = '/dsh-remote-go/api/events'
/** The connect-log channel (docs/api.md): the same admission as `/events`, rows only. */
const LOG_EVENT_PATH = '/dsh-remote-go/api/events/logs'
const POLL_INTERVAL_MS = 3000
/**
 * A dropped SSE stream is rebuilt with exponential backoff instead of leaving the panel in
 * polling forever (docs/api.md `/events`). The first retry is immediate enough to ride out a
 * page reload, and the cap keeps a permanently refused stream from hammering the Host.
 */
const STREAM_RETRY_BASE_MS = 500
const STREAM_RETRY_MAX_MS = 15000
/** One state fetch in a retry chain must not hold the stream down forever. */
const STREAM_RETRY_MAX_ATTEMPTS = 8
function streamRetryDelay(attempt) {
  const safe = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)))
  return Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** safe)
}
const DESKTOP_BRIDGE_VERSION = 1
const OVERLAY_ROOT_ID = 'dsh-remote-go-overlay'
const CAPTION_FALLBACK_HEIGHT = 40
const CAPTION_MARKER = 'data-windows-titlebar'
const CAPTION_LIVE_CLASS = 'drg-caption-live'
/**
 * Fallback for the caption band's control strip, used only when the guest cannot report DSH's
 * own value: the sidebar toggle sits at 12px, a collapsed rail pins the new-session control at
 * 48px (both are DSH's, see SidebarRoot.module.css), 28px wide, plus 8px of air. The window drag
 * strip starts here.
 */
const CAPTION_CONTROLS_END = 84
const CAPTION_GRIP_LEFT = CAPTION_CONTROLS_END
/**
 * Where DSH mounts the Windows caption menubar (应用 / 编辑): a fixed host that reads
 * `--dsh-windows-menu-start`, which the sidebar's own collapse rule raises to the value above.
 * The guest resolves that variable for this page (its document carries the same rule), so these
 * two numbers are only the fallback for a guest that cannot answer.
 */
const CAPTION_MENU_VAR = '--dsh-windows-menu-start'
const CAPTION_MENU_START = 48
const CAPTION_MENU_START_COLLAPSED = CAPTION_CONTROLS_END
/** A caption band is tens of pixels tall; an inset past this is not a number worth copying. */
const CAPTION_MENU_MAX = 200
/** A guest reports its rail state through the same queue its row clicks use (mountSidebarMirror). */
const CAPTION_SIDEBAR_INTENT = 'caption-sidebar'
/**
 * Only loopback URLs may ever be handed to the desktop guest (docs/api.md 安全约束). The
 * prefix is the outer shape check; `isValidLoopbackUrl` still verifies the parsed origin.
 */
const LOOPBACK_PREFIX = 'http://127.0.0.1:'
/**
 * Same-origin seat of the remote UI used by the browser carrier. It is a path, not an origin:
 * the local DSH proxies it to the connected host's tunnel (docs/api.md `GET /hosts/:id/open`).
 */
const REMOTE_VIEW_PREFIX = '/dsh-remote-go/remote/'
/** Ordered connect phases (contract ConnectPhase). */
const PHASES = ['ssh', 'probe', 'bootstrap', 'start', 'tunnel', 'verifying', 'ready']
/** Known diagnostic check ids, in the contract's fixed order. */
const DIAGNOSE_IDS = [
  'ssh-reachable',
  'auth',
  'host-key',
  'tunnel',
  'remote-service',
  'remote-ui',
  'remote-node',
  'remote-version',
  'model-credentials',
  'desktop-guard',
]
const TONE_VARS = {
  idle: 'var(--dsw-alias-state-idle-primary)',
  info: 'var(--dsw-alias-state-business-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  limited: 'var(--dsw-static-violet-400)',
}
/** One entry per HostStatus, so the label, the strip and the primary action cannot disagree. */
const STATUS = {
  unconfigured: { tone: 'idle', action: 'cardConnect', connect: true },
  connecting: { tone: 'info', action: 'connecting', wait: true, window: true },
  'fingerprint-pending': { tone: 'warn', action: 'confirmFingerprint', window: true },
  'conflict-pending': { tone: 'warn', action: 'statusConflictPending', wait: true, strip: 'status' },
  connected: { tone: 'success', action: 'cardOpen' },
  disconnected: { tone: 'warn', action: 'cardConnect', connect: true, retry: true },
  error: { tone: 'error', action: 'cardConnect', connect: true, retry: true, window: true, strip: 'alert' },
  limited: { tone: 'limited', action: 'cardConnect', retry: true, strip: 'alert' },
}
/** That status' entry plus its dictionary keys; every status names them `status<Name>`. */
function statusOf(status) {
  const id = STATUS[status] === undefined ? 'unconfigured' : status
  const name = id.replace(/(?:^|-)([a-z])/g, (_all, letter) => letter.toUpperCase())
  return { ...STATUS[id], label: 'status' + name, hint: 'statusHint' + name }
}

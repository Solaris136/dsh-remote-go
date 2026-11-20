// client/src/constants.ts - NS, API/event paths, retry + caption constants, PHASES, DIAGNOSE_IDS, TONE_VARS, STATUS, statusOf; after react.ts, before i18n-dict.ts.
//#region 1. constants

const NS = 'dsh-remote-go'
const PANEL_ID = 'dsh-remote-go'
const API_BASE = '/dsh-remote-go/api'
const EVENT_PATH = '/dsh-remote-go/api/events'
/** The connect-log channel (docs/api.md): the same admission as `/events`, rows only. */
const LOG_EVENT_PATH = '/dsh-remote-go/api/events/logs'
const POLL_INTERVAL_MS = 3000
/** A dropped SSE stream is rebuilt with exponential backoff instead of polling forever. */
// The first retry rides out a page reload, and the cap stops a permanently refused stream from hammering.
const STREAM_RETRY_BASE_MS = 500
const STREAM_RETRY_MAX_MS = 15000
/** One state fetch in a retry chain must not hold the stream down forever. */
const STREAM_RETRY_MAX_ATTEMPTS = 8
function streamRetryDelay(attempt: number): number {
  const safe = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)))
  return Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** safe)
}
const DESKTOP_BRIDGE_VERSION = 1
const OVERLAY_ROOT_ID = 'dsh-remote-go-overlay'
const CAPTION_FALLBACK_HEIGHT = 40
const CAPTION_MARKER = 'data-windows-titlebar'
const CAPTION_LIVE_CLASS = 'drg-caption-live'
/** Fallback for the caption band's control strip, used only when the guest cannot report DSH's own value. */
// The toggle sits at 12px, a collapsed rail's new-session control at 48px (both DSH's), 28px wide, plus 8px of air.
const CAPTION_CONTROLS_END = 84
const CAPTION_GRIP_LEFT = CAPTION_CONTROLS_END
/** Where DSH mounts the Windows caption menubar: a fixed host reads `--dsh-windows-menu-start`. */
// The sidebar's collapse rule raises it, and the guest resolves it here, so these two numbers are only the fallback.
const CAPTION_MENU_VAR = '--dsh-windows-menu-start'
const CAPTION_MENU_START = 48
const CAPTION_MENU_START_COLLAPSED = CAPTION_CONTROLS_END
/** A caption band is tens of pixels tall; an inset past this is not a number worth copying. */
const CAPTION_MENU_MAX = 200
/** A guest reports its rail state through the same queue its row clicks use (mountSidebarMirror). */
const CAPTION_SIDEBAR_INTENT = 'caption-sidebar'
/** Only loopback URLs may ever be handed to the desktop guest. */
// The prefix is the outer shape check; `isValidLoopbackUrl` still verifies the parsed origin.
const LOOPBACK_PREFIX = 'http://127.0.0.1:'
/** The browser carrier's same-origin seat: a path, not an origin, which the local DSH proxies to the host's tunnel. */
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
const TONE_VARS: Record<Tone, string> = {
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
} satisfies Record<HostStatus, StatusEntry>
/** The contract's own status ids, so a plain string from a prop can be narrowed without a cast. */
function isHostStatus(value: unknown): value is HostStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS, value)
}

/** That status' entry plus its dictionary keys; every status names them `status<Name>`. */
function statusOf(status: unknown): StatusView {
  const id: HostStatus = isHostStatus(status) ? status : 'unconfigured'
  const name = id.replace(/(?:^|-)([a-z])/g, (_all, letter) => letter.toUpperCase())
  return {
    ...STATUS[id],
    label: dictionaryKey('status' + name),
    hint: dictionaryKey('statusHint' + name),
  }
}

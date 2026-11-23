/** Shared constants for the remote npx runtime and the plugin surface. */
export const DEFAULT_REMOTE_PROFILE = 'web'
export const REMOTE_DSH_DIR = '.dsh'
export const REMOTE_STATE_DIR = 'remote-go'
export const API_PREFIX = '/dsh-remote-go/api'
export const REMOTE_VIEW_PREFIX = '/dsh-remote-go/remote/'
export const API_HEADER = 'x-dsh-remote-go'
export const PLUGIN_ID = 'dsh-remote-go'
export const PLUGIN_VERSION = '0.3.2'
export const MIN_DSH_VERSION = '0.2.2-rc.3'
export const API_VERSION = '2.12'
export const DEFAULT_KEY_PATH = '~/.ssh/id_rsa'
export const REMOTE_START_TIMEOUT_MS = 300_000
export const REMOTE_CONFLICT_TIMEOUT_MS = 120_000
export const SSH_READY_TIMEOUT_MS = 20_000
/** SSH keepalive cadence: a probe every 15 s keeps NAT/firewall state alive without loading a thin link. */
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000
/** Unanswered keepalives tolerated before the transport is declared dead: 4 x 15 s rides out a ~60 s stall
 * (mobile handoff, VPN re-key, congestion) that used to drop the session after 45 s. */
export const SSH_KEEPALIVE_COUNT_MAX = 4
export const DEFAULT_IDLE_MINUTES = 15
export const TUNNEL_PROBE_TIMEOUT_MS = 10_000
export const REMOTE_HEARTBEAT_DEFAULT_SEC = 30
export const REMOTE_HEARTBEAT_MIN_SEC = 5
export const REMOTE_HEARTBEAT_MAX_SEC = 600
/** Consecutive failed probes before a re-attach. Two was one lost packet away from tearing down a healthy link over a
 * slow tunnel; the quick recheck after each failure still proves a real restart in a few seconds. */
export const REMOTE_UNREACHABLE_FAILURES = 3
export const REMOTE_UNREACHABLE_CONFIRM_DELAY_MS = 2_500
export const REMOTE_UNREACHABLE_RECHECK_DELAY_MS = 3_500
export const REMOTE_EPISODE_COOLDOWN_MS = 15_000
export const REMOTE_REPAIR_BACKOFF_MS = 30_000
export const REMOTE_REPAIR_BACKOFF_MAX_MS = 120_000
export const REMOTE_TUNNEL_REPAIR_SETTLE_MS = 5_000
export const REMOTE_REATTACH_ATTEMPTS = 6
export const REMOTE_REATTACH_INTERVAL_MS = 2_000
/** Spacing of the slow retries that follow the fast reconnect budget: one attempt every 30 s keeps a bad link from
 * being hammered while the user still gets the link back on its own. */
export const REMOTE_RECONNECT_SLOW_DELAY_MS = 30_000
/** How long the slow phase keeps trying before auto-reconnect gives up: 10 minutes covers a reboot, a VPN re-dial or
 * a carrier handoff, which is exactly the window where a user expects the connection to come back by itself. */
export const REMOTE_RECONNECT_PATIENCE_MS = 10 * 60_000

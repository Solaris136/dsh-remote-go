/**
 * Shared constants for the remote npx runtime and the plugin surface.
 */

export const DEFAULT_REMOTE_PROFILE = 'web'

export const REMOTE_DSH_DIR = '.dsh'

export const REMOTE_STATE_DIR = 'remote-go'

export const API_PREFIX = '/dsh-remote-go/api'

/**
 * Same-origin seat of the remote web UI used by the browser half: every request below
 * `<prefix><hostId>/` is proxied to that connected host's loopback tunnel (see remote-proxy.js).
 */
export const REMOTE_VIEW_PREFIX = '/dsh-remote-go/remote/'

export const API_HEADER = 'x-dsh-remote-go'

export const PLUGIN_ID = 'dsh-remote-go'
export const PLUGIN_VERSION = '0.1.0'

/** Host↔Client contract version served by `GET /version` (docs/api.md v2.8). */
export const API_VERSION = '2.8'

export const DEFAULT_KEY_PATH = '~/.ssh/id_rsa'

export const REMOTE_START_TIMEOUT_MS = 300_000

export const REMOTE_CONFLICT_TIMEOUT_MS = 120_000

export const SSH_READY_TIMEOUT_MS = 20_000

export const DEFAULT_IDLE_MINUTES = 15

export const TUNNEL_PROBE_TIMEOUT_MS = 10_000

/**
 * Remote liveness: a connected host's remote UI is probed on this interval
 * (`settings.remoteHeartbeat`). Two consecutive failed probes - not one failed
 * request - are what confirm that the remote web really went away.
 */
export const REMOTE_HEARTBEAT_DEFAULT_SEC = 30

export const REMOTE_HEARTBEAT_MIN_SEC = 5

export const REMOTE_HEARTBEAT_MAX_SEC = 600

/** Consecutive failed probes that turn a suspicion into a confirmed restart. */
export const REMOTE_UNREACHABLE_FAILURES = 2

/** Delay before the confirming probe after a proxy/tunnel error (never trust one failure). */
export const REMOTE_UNREACHABLE_CONFIRM_DELAY_MS = 750

/** Delay between the two confirming probes, so they are consecutive but not one slow request. */
export const REMOTE_UNREACHABLE_RECHECK_DELAY_MS = 1200

/**
 * After a transient (proxy/tunnel) episode is confirmed healthy, the same kind of report is
 * ignored for this long: a flapping tunnel must not emit suspected/recovered on every request.
 */
export const REMOTE_EPISODE_COOLDOWN_MS = 15_000

/**
 * A remote restart needs a little time to print its new readiness line. The
 * re-attach retries the read-back a few times before it declares the remote gone.
 */
export const REMOTE_REATTACH_ATTEMPTS = 6

export const REMOTE_REATTACH_INTERVAL_MS = 2_000

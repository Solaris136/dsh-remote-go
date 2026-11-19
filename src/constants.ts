/**
 * Shared constants for the remote npx runtime and the plugin surface.
 */

export const DEFAULT_REMOTE_PROFILE = 'web'

export const REMOTE_DSH_DIR = '.dsh'

export const REMOTE_STATE_DIR = 'remote-go'

export const API_PREFIX = '/dsh-remote-go/api'

/**
 * Same-origin seat of the remote web UI used by the browser half: every request below
 * `<prefix><hostId>/` is proxied to that connected host's loopback tunnel (see proxy/index.ts).
 */
export const REMOTE_VIEW_PREFIX = '/dsh-remote-go/remote/'

export const API_HEADER = 'x-dsh-remote-go'

export const PLUGIN_ID = 'dsh-remote-go'
export const PLUGIN_VERSION = '0.3.0'

/**
 * DSH's own lower bound, mirrored from this package's `engines.dsh`. The client may only
 * backfill a locally-detected DSH version; a value below this floor names a build the plugin
 * does not support, so `/local-version` refuses it (it would otherwise pin the remote npx
 * runtime to an arbitrary, possibly unusable version).
 */
export const MIN_DSH_VERSION = '0.2.2-rc.3'

/** Host↔Client contract version served by `GET /version` (docs/api.md v2.12). */
export const API_VERSION = '2.12'

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
 * A failed listener rebuild waits before the next attempt (doubling up to the max). The
 * episode cooldown alone would still let a broken rebuild retry every 15s forever.
 */
export const REMOTE_REPAIR_BACKOFF_MS = 30_000
export const REMOTE_REPAIR_BACKOFF_MAX_MS = 120_000

/**
 * How long teardown waits for an in-flight listener rebuild. The rebuild is local and fast;
 * a stuck one must not delay disconnect / host removal / shutdown indefinitely. Its token is
 * already cancelled, so it still closes any listener it manages to publish afterwards.
 */
export const REMOTE_TUNNEL_REPAIR_SETTLE_MS = 5_000

/**
 * A remote restart needs a little time to print its new readiness line. The
 * re-attach retries the read-back a few times before it declares the remote gone.
 */
export const REMOTE_REATTACH_ATTEMPTS = 6

export const REMOTE_REATTACH_INTERVAL_MS = 2_000

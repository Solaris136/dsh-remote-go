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

/** Host↔Client contract version served by `GET /version` (docs/api.md v2.7). */
export const API_VERSION = '2.7'

export const DEFAULT_KEY_PATH = '~/.ssh/id_rsa'

export const REMOTE_START_TIMEOUT_MS = 300_000

export const REMOTE_CONFLICT_TIMEOUT_MS = 120_000

export const SSH_READY_TIMEOUT_MS = 20_000

export const DEFAULT_IDLE_MINUTES = 15

export const TUNNEL_PROBE_TIMEOUT_MS = 10_000

/**
 * Shared constants for remote bootstrap and the plugin surface.
 */

/** Node.js release used for the T3 no-Node bootstrap; pinned exact. */
export const DEFAULT_NODE_VERSION = '24.22.2'

/** Official Node distribution root (SHA-256 sums live beside the archives). */
export const NODE_DIST_BASE = 'https://nodejs.org/dist'

/** Remote DSH profile booted by the plugin. */
export const REMOTE_PROFILE = 'web'

/** API route prefix mounted on the local DSH Web server. */
export const API_PREFIX = '/dsh-remote-go/api'

/** Required request header; forces a CORS preflight for cross-site callers. */
export const API_HEADER = 'x-dsh-remote-go'

/** Plugin/version metadata. */
export const PLUGIN_ID = 'dsh-remote-go'
export const PLUGIN_VERSION = '0.1.0'

/** Host↔Client contract version served by `GET /version` (docs/api.md v1.1). */
export const API_VERSION = '1.1'

/** Default remote directory (tilde keeps it user-owned; expanded remotely). */
export const DEFAULT_REMOTE_DIR = '~/.dsh-remote-go'

/** How long the remote web may take to print its URL line. */
export const REMOTE_START_TIMEOUT_MS = 300_000

/** How long a local SSH connect may take. */
export const SSH_READY_TIMEOUT_MS = 20_000

/** Default idle minutes for the `idle` keep-alive policy. */
export const DEFAULT_IDLE_MINUTES = 15

/** Local HTTP probe timeout through the tunnel. */
export const TUNNEL_PROBE_TIMEOUT_MS = 10_000

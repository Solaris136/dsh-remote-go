/**
 * Shared constants for the remote npx runtime and the plugin surface.
 */

/** Profile booted by the remote DSH; it lives under the remote's `$DSH_HOME/profiles`. */
export const DEFAULT_REMOTE_PROFILE = 'web'

/** Directory name of the remote DSH home under the remote user's home (`~/.dsh`). */
export const REMOTE_DSH_DIR = '.dsh'

/** Plugin state directory **inside** the remote DSH home (`~/.dsh/remote-go`). */
export const REMOTE_STATE_DIR = 'remote-go'

/** API route prefix mounted on the local DSH Web server. */
export const API_PREFIX = '/dsh-remote-go/api'

/** Required request header; forces a CORS preflight for cross-site callers. */
export const API_HEADER = 'x-dsh-remote-go'

/** Plugin/version metadata. */
export const PLUGIN_ID = 'dsh-remote-go'
export const PLUGIN_VERSION = '0.1.0'

/** Host↔Client contract version served by `GET /version` (docs/api.md v1.3). */
export const API_VERSION = '2.0'

/**
 * Default private-key path offered for key-file authentication. Key-only SSH is
 * the supported model, so a new host starts with this value pre-filled instead of
 * asking for a path from scratch.
 */
export const DEFAULT_KEY_PATH = '~/.ssh/id_ed25519'

/** How long the remote web may take to print its URL line. */
export const REMOTE_START_TIMEOUT_MS = 300_000

/** How long the user has to answer the "manual DSH is already running" prompt. */
export const REMOTE_CONFLICT_TIMEOUT_MS = 120_000

/** How long a local SSH connect may take. */
export const SSH_READY_TIMEOUT_MS = 20_000

/** Default idle minutes for the `idle` keep-alive policy. */
export const DEFAULT_IDLE_MINUTES = 15

/** Local HTTP probe timeout through the tunnel. */
export const TUNNEL_PROBE_TIMEOUT_MS = 10_000

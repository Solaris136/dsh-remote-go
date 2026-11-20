/** The two ceilings one upstream connection is held to: how long the remote may take to answer, and how large a
 * handshake response head may grow before it can no longer be a WebSocket upgrade. */

/** How long the remote may take to accept a connection and answer. */
export const UPSTREAM_TIMEOUT_MS = 30_000
/** A handshake response head larger than this cannot be a WebSocket upgrade; it is dropped. */
export const MAX_UPSTREAM_HEAD_BYTES = 64 * 1024

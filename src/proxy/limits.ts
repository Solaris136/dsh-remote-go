/**
 * The two ceilings one upstream connection is held to: how long it may take to answer, and how
 * large a handshake response head may grow before it can no longer be a WebSocket upgrade.
 */

/** How long the remote may take to accept a connection and answer; see `createRemoteProxy`. */
export const UPSTREAM_TIMEOUT_MS = 30_000

/** A handshake response head larger than this is not a WebSocket upgrade; it is dropped. */
export const MAX_UPSTREAM_HEAD_BYTES = 64 * 1024

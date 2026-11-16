/**
 * The per-host runtime object shared by the service and every helper.
 */

export function emptyRemote() {
  return {
    version: null,
    uiReady: false,
    localPort: null,
    port: null,
    pid: null,
    dshHome: null,
    profile: null,
    bootstrapLevel: null,
    nodeVersion: null,
    nodeSource: null,
    startedAt: null,
    /**
     * Bumped on every successful attach (connect, local restart, remote re-attach).
     * The Client uses it to know that its warm carrier holds a launch URL and a
     * session cookie from the previous tunnel, so it must navigate again.
     */
    viewRev: 0,
  }
}

export function createHostRuntime(host) {
  return {
    id: host.id,
    entry: host,
    status: 'unconfigured',
    phase: null,
    progress: null,
    error: null,
    warning: null,
    fingerprint: host.pinnedFingerprint
      ? { sha256: host.pinnedFingerprint, keyType: 'pinned', status: 'pinned', pinned: host.pinnedFingerprint }
      : null,
    /**
     * The jump host's own host key context: `{ sha256, keyType, status, pinned }`. Kept apart
     * from `fingerprint` (the target) so a jump-host confirmation can never pin the target
     * and a target pin can never be checked against the jump host (B1).
     */
    jumpFingerprint: null,
    remote: emptyRemote(),
    ssh: null,
    jumpSsh: null,
    tunnel: null,
    token: null,
    password: null,
    facts: null,
    /**
     * The last known remote home and managed web pid. `facts`/`remote` are cleared by every
     * teardown, but the idle policy still has to stop the right process on the right host
     * path afterwards (H1).
     */
    remoteHome: null,
    remotePid: null,
    exchange: null,
    pendingHostKey: null,
    pendingConflict: null,
    conflict: null,
    desired: 'idle',
    /**
     * The user answered a prompt with "no" (or let it time out): the connection attempt must
     * not be retried automatically, because a retry would ask the same question again (H2).
     */
    connectCancelled: false,
    /**
     * The transport this attempt was dialling closed under the pipeline (including while the
     * handshake was still waiting for a host-key answer). Such a failure is a dropped link,
     * not an auth/key decision (H3).
     */
    transportLost: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    idleTimer: null,
    connectPromise: null,
    /** One-shot link actions (local restart / remote re-attach / listener repair / stop) and their token. */
    linkBusy: null,
    linkToken: 0,
    restartPromise: null,
    reattachPromise: null,
    /**
     * Processes this connection actually launched (pid -> start time), plus pids adopted from a
     * registry record written by a launch. Only these may ever be stopped; a pid a re-attach
     * discovered gets display rights, never kill rights.
     */
    launched: new Map(),
    /**
     * The remote web this connection is bound to, with the `/proc` identity proved when it bound:
     * `{ pid, startTime, origin: 'launch' | 'reattach' }`. A re-attached pid lives here (never in
     * `launched`), so the explicit "Stop remote DSH" action can stop exactly that one process
     * without granting the kill right to a restart.
     */
    bound: null,
    /** Current tunnel repair (a broken local listener under a healthy remote). */
    tunnelRepair: null,
    tunnelRepairFailures: 0,
    nextTunnelRepairAt: 0,
    /** Liveness probes: a confirmed episode is two consecutive failed probes. */
    heartbeatTimer: null,
    remoteCheckTimer: null,
    remoteFailures: 0,
    remoteEpisode: false,
    episodeSource: null,
    episodeCooldownUntil: 0,
    /** Processes kept alongside this connection (chosen in the conflict prompt). */
    alongsidePids: [],
    /** Bounded, client-independent record of restarts / re-attaches for diagnostics. */
    restarts: [],
    closing: false,
    logs: [],
    logSeq: 0,
    // Which connection this runtime is on; the connect log starts at 1 and resets its ring.
    connectCount: 0,
  }
}

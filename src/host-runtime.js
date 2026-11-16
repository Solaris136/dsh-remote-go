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
    remote: emptyRemote(),
    ssh: null,
    jumpSsh: null,
    tunnel: null,
    token: null,
    password: null,
    facts: null,
    exchange: null,
    pendingHostKey: null,
    pendingConflict: null,
    conflict: null,
    desired: 'idle',
    reconnectAttempts: 0,
    reconnectTimer: null,
    idleTimer: null,
    connectPromise: null,
    /** One-shot link actions (local restart / remote re-attach) and the token that owns them. */
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

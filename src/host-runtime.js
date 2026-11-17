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
        viewRev: 0,
    };
}
/** Build the mutable state for one host. The entry always carries the id the store issued. */
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
        jumpFingerprint: null,
        remote: emptyRemote(),
        ssh: null,
        jumpSsh: null,
        tunnel: null,
        token: null,
        password: null,
        savePassword: false,
        forgetPassword: false,
        passwordSaved: false,
        facts: null,
        remoteHome: null,
        remotePid: null,
        remoteProfile: null,
        exchange: null,
        pendingHostKey: null,
        pendingConflict: null,
        conflict: null,
        desired: 'idle',
        connectCancelled: false,
        transportLost: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        idleTimer: null,
        connectPromise: null,
        linkBusy: null,
        linkToken: 0,
        restartPromise: null,
        reattachPromise: null,
        launched: new Map(),
        bound: null,
        tunnelRepair: null,
        tunnelRepairFailures: 0,
        nextTunnelRepairAt: 0,
        heartbeatTimer: null,
        remoteCheckTimer: null,
        remoteFailures: 0,
        remoteEpisode: false,
        episodeSource: null,
        episodeCooldownUntil: 0,
        // The three containers start empty and are filled by `connect-pipeline`; the `as` fixes the
        // element type an empty literal cannot infer (it erases at emit time).
        alongsidePids: [],
        restarts: [],
        closing: false,
        logs: [],
        logSeq: 0,
        connectCount: 0,
    };
}

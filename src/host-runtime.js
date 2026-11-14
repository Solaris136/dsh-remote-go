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
    /** `'system'` (the remote's own Node) or `'managed'` (provisioned by the plugin). */
    nodeSource: null,
    startedAt: null,
  }
}

/** @param {Record<string, any>} host */
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
    plan: null,
    managedNode: null,
    exchange: null,
    pendingHostKey: null,
    pendingConflict: null,
    conflict: null,
    desired: 'idle',
    reconnectAttempts: 0,
    reconnectTimer: null,
    idleTimer: null,
    connectPromise: null,
    closing: false,
    logs: [],
  }
}

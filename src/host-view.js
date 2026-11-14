/**
 * The client-facing view of one host (docs/api.md HostView).
 */
import { versionParity } from './version.js'
import { connectLogTail, connectLogVisible } from './connect-log.js'

/** @param {any} runtime @param {{ targetVersion: string | null, passwordStorageAvailable: boolean }} ctx */
export function hostView(runtime, ctx) {
  const entry = runtime.entry
  return {
    id: runtime.id,
    name: entry.name,
    address: entry.address,
    addressMasked: maskAddress(entry),
    /** Never the secret itself; lets the Client ask for a one-time password. */
    authType: entry.auth?.type ?? 'key',
    /** Whether a remembered password exists in the credential store (never the value). */
    passwordSaved: entry.auth?.type === 'password' ? runtime.passwordSaved === true || runtime.password != null : false,
    /** Whether this composition can persist a password at all. */
    passwordStorageAvailable: ctx.passwordStorageAvailable,
    jumpHost: entry.jumpHost ?? null,
    status: runtime.status,
    phase: runtime.phase,
    progress: runtime.progress,
    error: runtime.error,
    warning: runtime.warning,
    conflict: runtime.conflict,
    fingerprint: runtime.fingerprint,
    /**
     * Connect log tail for the window that is showing this host's connection
     * (docs/api.md): empty unless the status has a connect window, bounded so a
     * `/state` frame stays small. Newest entry last.
     */
    logs: connectLogVisible(runtime.status) ? connectLogTail(runtime) : [],
    remote: {
      ...runtime.remote,
      version: runtime.remote.version ?? null,
    },
    keepAlive: entry.keepAlive,
    idleMinutes: entry.idleMinutes,
    autoReconnect: entry.autoReconnect,
    hostKeyPolicy: entry.hostKeyPolicy,
    lastOpenedAt: entry.lastOpenedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    targetVersion: ctx.targetVersion,
    versionParity: versionParity(ctx.targetVersion, runtime.remote.version ?? null),
  }
}

/** @param {Record<string, any>} entry */
export function maskAddress(entry) {
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  const user = entry.username ? `${entry.username}@` : ''
  const host = entry.address || '?'
  return `${user}${host}${port}`
}

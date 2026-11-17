/**
 * The client-facing view of one host (docs/api.md HostView).
 */
import { versionParity } from './version.js'
import { connectLogTail, connectLogVisible } from './connect-log.js'

export function hostView(runtime, ctx) {
  const entry = runtime.entry
  return {
    id: runtime.id,
    name: entry.name,
    address: entry.address,
    addressMasked: maskAddress(entry),
    /**
     * The plain connection fields. The masked address is presentation only: the editor must not
     * parse it back (a bare IPv6 like `fe80::1` used to yield port 1, and the default port was
     * silently replaced by 22). Never a secret.
     */
    username: entry.username ?? null,
    port: entry.port ?? 22,
    /** Never the secret itself; lets the Client ask for a one-time password. */
    authType: entry.auth?.type ?? 'key',
    /** The configured key file path (not a secret); lets the edit form prefill it. */
    authKeyPath: entry.auth?.type === 'key' && typeof entry.auth.keyPath === 'string' ? entry.auth.keyPath : null,
    /**
     * Whether a remembered password exists in the credential store (never the value). The
     * runtime mirror is restored from the store on load, so this stays true across a DSH
     * restart while a one-time password used for this connection alone stays false.
     */
    passwordSaved: entry.auth?.type === 'password' ? runtime.passwordSaved === true : false,
    passwordStorageAvailable: ctx.passwordStorageAvailable,
    jumpHost: entry.jumpHost ?? null,
    status: runtime.status,
    phase: runtime.phase,
    progress: runtime.progress,
    error: runtime.error,
    warning: runtime.warning,
    conflict: runtime.conflict,
    fingerprint: runtime.fingerprint,
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
    /**
     * True when `hosts.json` was unreadable on load: this list is the recovered fallback, and a
     * copy of the damaged file is kept next to it (`hosts.json.corrupt-<timestamp>`). Contract
     * field only — the Client renders it as a warning (docs/api.md HostView).
     */
    storeCorrupt: ctx.storeCorrupt === true,
  }
}

/**
 * The display form of the endpoint: `user@host`, `user@host:2222`, and bracketed IPv6
 * (`user@[fe80::1]`, `user@[fe80::1]:2222`). The port is omitted only for SSH's default 22, which
 * is why the Client reads `port`/`username` instead of parsing this string.
 */
export function maskAddress(entry) {
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  const user = entry.username ? `${entry.username}@` : ''
  const raw = entry.address || '?'
  // An unbracketed address containing a colon is IPv6 in URL/SSH notation.
  const host = raw.includes(':') && !(raw.startsWith('[') && raw.endsWith(']')) ? `[${raw}]` : raw
  return `${user}${host}${port}`
}

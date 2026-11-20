/** The client-facing view of one host (docs/api.md HostView). */
import { versionParity } from './version.js'
import { connectLogTail, connectLogVisible } from './connect-log.js'
import type { BilingualText } from './util.js'
import type { ErrorView } from './errors.js'
import type { KeepAlive, HostKeyPolicy } from './settings.js'
import type { ConnectLogTailItem } from './connect-log.js'
import type { ConnectProgressState } from './connect-progress.js'
import type { HostRuntime, RemoteRuntime, RuntimeFingerprint } from './host-runtime.js'
import type { VersionParity } from './version.js'
export interface HostViewContext {
  passwordStorageAvailable: boolean
  targetVersion: string
  storeCorrupt?: boolean
}
/** `logs: false` is the SSE state-frame shape: rows travel on the log channel, so the frame keeps `logs: []`. */
export interface HostViewOptions {
  logs?: boolean
}
export interface HostView {
  id: string
  name: string
  address: string
  addressMasked: string
  username: string | null
  port: number
  authType: string
  authKeyPath: string | null
  passwordSaved: boolean
  passwordStorageAvailable: boolean
  jumpHost: string | null
  status: string
  phase: string | null
  progress: ConnectProgressState | null
  error: ErrorView | null
  warning: BilingualText | null
  conflict: unknown
  fingerprint: RuntimeFingerprint | null
  logs: ConnectLogTailItem[]
  /** The log cursor this tail ends at (attempt plus newest `seq`), for aligning a merge and for older Hosts. */
  logAttempt: number
  logSeq: number
  remote: RemoteRuntime
  keepAlive: KeepAlive
  idleMinutes: number
  autoReconnect: boolean
  hostKeyPolicy: HostKeyPolicy
  lastOpenedAt: string | null
  createdAt: string
  updatedAt: string
  targetVersion: string
  versionParity: VersionParity
  storeCorrupt: boolean
}
export interface MaskedAddressSource {
  address?: string | null
  username?: string | null
  port?: number | null
}

export function hostView(runtime: HostRuntime, ctx: HostViewContext, options: HostViewOptions = {}): HostView {
  const entry = runtime.entry
  return {
    id: runtime.id,
    name: entry.name,
    address: entry.address,
    // Presentation only: the editor must never parse this form back (a bare IPv6 such as
    // `fe80::1` used to yield port 1 and silently replace the default port with 22).
    addressMasked: maskAddress(entry),
    username: entry.username ?? null,
    port: entry.port ?? 22,
    authType: entry.auth?.type ?? 'key',
    authKeyPath: entry.auth?.type === 'key' && typeof entry.auth.keyPath === 'string' ? entry.auth.keyPath : null,
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
    logs: options.logs === false ? [] : connectLogVisible(runtime.status) ? connectLogTail(runtime) : [],
    logAttempt: typeof runtime.connectCount === 'number' ? runtime.connectCount : 0,
    logSeq: typeof runtime.logSeq === 'number' ? runtime.logSeq : 0,
    remote: { ...runtime.remote, version: runtime.remote.version ?? null },
    keepAlive: entry.keepAlive,
    idleMinutes: entry.idleMinutes,
    autoReconnect: entry.autoReconnect,
    hostKeyPolicy: entry.hostKeyPolicy,
    lastOpenedAt: entry.lastOpenedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    targetVersion: ctx.targetVersion,
    versionParity: versionParity(ctx.targetVersion, runtime.remote.version ?? null),
    storeCorrupt: ctx.storeCorrupt === true,
  }
}
/** The display form of the endpoint (`user@host`, `user@host:2222`, bracketed IPv6); the port is omitted only for SSH's
 * default 22, which is why the Client reads `port`/`username` instead of parsing this string. */
export function maskAddress(entry: MaskedAddressSource): string {
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  const user = entry.username ? `${entry.username}@` : ''
  const raw = entry.address || '?'
  // An unbracketed address containing a colon is IPv6 in URL/SSH notation.
  const host = raw.includes(':') && !(raw.startsWith('[') && raw.endsWith(']')) ? `[${raw}]` : raw
  return `${user}${host}${port}`
}

/** Plugin settings: defaults, validation and sanitization; unknown or invalid fields fall back to defaults instead of failing activation. */
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_KEY_PATH,
  DEFAULT_REMOTE_PROFILE,
  REMOTE_HEARTBEAT_DEFAULT_SEC,
  REMOTE_HEARTBEAT_MAX_SEC,
  REMOTE_HEARTBEAT_MIN_SEC,
  SSH_READY_TIMEOUT_MS,
} from './constants.js'
import { clamp, deepMerge, isPlainObject, parseSshDestination } from './util.js'
import type { SshDestination } from './util.js'

export type AuthType = 'key' | 'password'
export type KeepAlive = 'keep' | 'stop' | 'idle'
export type HostKeyPolicy = 'first-use' | 'strict'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type Language = 'auto' | 'zh' | 'en'

export interface AutoReconnectSettings {
  enabled: boolean
  maxAttempts: number
  baseDelayMs: number
}

export interface RemoteHeartbeatSettings {
  enabled: boolean
  intervalSec: number
}

export interface BootstrapSettings {
  profile: string
}

// A `type`, not an `interface`: `sanitizeSettings` reads the merged result through a
// `Record<string, unknown>` view, and only a type alias is assignable to an index signature.
export type Settings = {
  defaultPort: number
  defaultAuth: AuthType
  defaultKeyPath: string
  connectTimeoutSec: number
  autoReconnect: AutoReconnectSettings
  remoteHeartbeat: RemoteHeartbeatSettings
  hostKeyPolicy: HostKeyPolicy
  saveTokens: boolean
  language: Language
  logLevel: LogLevel
  bootstrap: BootstrapSettings
}

/** One host's SSH authentication choice; `keyPath` is only present for key auth. */
export interface HostAuth {
  type: AuthType
  keyPath?: string
}

/** The sanitized host entry persisted in `hosts.json` and rendered as `HostView`. */
export interface HostEntry {
  id?: string
  name: string
  address: string
  port: number
  username: string | null
  auth: HostAuth
  jumpHost: string | null
  keepAlive: KeepAlive
  idleMinutes: number
  autoReconnect: boolean
  hostKeyPolicy: HostKeyPolicy
  pinnedFingerprint: string | null
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

export function defaultSettings(): Settings {
  return {
    defaultPort: 22,
    // Only a key file (or a one-time password) is supported: there is no SSH agent path any more,
    // so the default is the key file the wizard pre-fills.
    defaultAuth: 'key',
    defaultKeyPath: DEFAULT_KEY_PATH,
    connectTimeoutSec: Math.round(SSH_READY_TIMEOUT_MS / 1000),
    autoReconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 800 },
    // Light liveness probe: two consecutive failures re-read the remote and re-attach; one never does.
    remoteHeartbeat: { enabled: true, intervalSec: REMOTE_HEARTBEAT_DEFAULT_SEC },
    hostKeyPolicy: 'first-use',
    saveTokens: false,
    language: 'auto',
    logLevel: 'info',
    bootstrap: { profile: DEFAULT_REMOTE_PROFILE },
  }
}

/** A profile name DSH can boot: one safe path segment, and never `desktop` (the Electron app reserves that profile and the CLI refuses it). */
function normalizeProfileName(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text)) return null
  if (text.toLowerCase() === 'desktop') return null
  return text
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return clamp(Math.round(num), min, max)
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** A trimmed non-empty string, or `fallback` when the patch names nothing usable. */
function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** A trimmed non-empty string, or `fallback` (null included) when the patch names nothing usable. */
function optionalText(value: unknown, fallback: string | null): string | null {
  if (typeof value !== 'string') return fallback
  return value.trim() !== '' ? value.trim() : null
}

export function sanitizeSettings(raw: unknown): Settings {
  const defaults = defaultSettings()
  if (!isPlainObject(raw)) return defaults
  // A stored file may still carry a retired value (`defaultAuth: "agent"`), so every field is read
  // through a loose view: the type says what a *sanitized* settings object holds, not what the file
  // on disk holds.
  const input: Record<string, unknown> = deepMerge(defaults, raw)
  const autoReconnect = isPlainObject(input.autoReconnect) ? input.autoReconnect : defaults.autoReconnect
  const remoteHeartbeat = isPlainObject(input.remoteHeartbeat) ? input.remoteHeartbeat : defaults.remoteHeartbeat
  const bootstrap = isPlainObject(input.bootstrap) ? input.bootstrap : defaults.bootstrap
  const profile = normalizeProfileName(bootstrap.profile) ?? defaults.bootstrap.profile
  return {
    defaultPort: numberIn(input.defaultPort, 1, 65535, defaults.defaultPort),
    // The retired "agent" choice migrates to key-file auth instead of silently resetting, because
    // key files are the only non-interactive option left.
    defaultAuth:
      input.defaultAuth === 'agent' ? 'key' : oneOf(input.defaultAuth, ['key', 'password'], defaults.defaultAuth),
    defaultKeyPath: textOr(input.defaultKeyPath, defaults.defaultKeyPath),
    connectTimeoutSec: numberIn(input.connectTimeoutSec, 5, 300, defaults.connectTimeoutSec),
    autoReconnect: {
      enabled: boolean(autoReconnect.enabled, defaults.autoReconnect.enabled),
      maxAttempts: numberIn(autoReconnect.maxAttempts, 0, 20, defaults.autoReconnect.maxAttempts),
      baseDelayMs: numberIn(autoReconnect.baseDelayMs, 100, 30_000, defaults.autoReconnect.baseDelayMs),
    },
    remoteHeartbeat: {
      enabled: boolean(remoteHeartbeat.enabled, defaults.remoteHeartbeat.enabled),
      intervalSec: numberIn(
        remoteHeartbeat.intervalSec,
        REMOTE_HEARTBEAT_MIN_SEC,
        REMOTE_HEARTBEAT_MAX_SEC,
        defaults.remoteHeartbeat.intervalSec,
      ),
    },
    hostKeyPolicy: oneOf(input.hostKeyPolicy, ['first-use', 'strict'], defaults.hostKeyPolicy),
    saveTokens: boolean(input.saveTokens, defaults.saveTokens),
    language: oneOf(input.language, ['auto', 'zh', 'en'], defaults.language),
    logLevel: oneOf(input.logLevel, ['error', 'warn', 'info', 'debug'], defaults.logLevel),
    bootstrap: { profile },
  }
}

/** The only id shape this plugin issues: `randomId('h')` (docs/api.md `HostView.id`). */
export const HOST_ID_RE = /^h_[a-z0-9]{1,32}$/

/** The persisted auth choice; a payload that names no usable type falls back to the settings default. */
function readAuthType(auth: Record<string, unknown> | null, existing: HostEntry | null, settings: Settings): AuthType {
  if (auth === null) return existing?.auth?.type ?? settings.defaultAuth
  // The retired "agent" choice migrates instead of resetting: key files are the only non-interactive
  // option left, and a silent reset would drop a configured key path from the form.
  if (auth.type === 'agent') return 'key'
  return oneOf(auth.type, ['key', 'password'], settings.defaultAuth)
}

export function sanitizeHostEntry(
  raw: unknown,
  options: { settings?: Settings; existing?: HostEntry | null } = {},
): HostEntry {
  const settings = options.settings ?? defaultSettings()
  const existing = options.existing ?? null
  if (!isPlainObject(raw)) throw new Error('host entry must be an object')
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 120) : ''
  const address = typeof raw.address === 'string' ? raw.address.trim() : ''
  if (address === '') throw new Error('address is required')
  // `parseSshDestination` never returns an `alias`; the fallback below is dead but the order of
  // fallbacks is part of the accepted host-name shape, so it stays.
  const destination = parseSshDestination(address) as SshDestination & { alias?: string }
  if (!destination.host) throw new Error('address is invalid')
  const userInput = typeof raw.username === 'string' ? raw.username.trim() : ''
  const username = userInput || existing?.username || destination.user || ''
  const authPatch = isPlainObject(raw.auth) ? raw.auth : null
  const authType = readAuthType(authPatch, existing, settings)
  const keyPathInput = authPatch !== null && typeof authPatch.keyPath === 'string' ? authPatch.keyPath.trim() : ''
  const keyPath = keyPathInput || existing?.auth?.keyPath || (authType === 'key' ? settings.defaultKeyPath : '')
  const keepAlive = oneOf(raw.keepAlive, ['keep', 'stop', 'idle'], existing?.keepAlive ?? 'keep')
  const hostKeyPolicy = oneOf(
    raw.hostKeyPolicy,
    ['first-use', 'strict'],
    existing?.hostKeyPolicy ?? settings.hostKeyPolicy,
  )
  return {
    // A malformed or over-long id is never echoed: an id names the secrets entry, the proxy route
    // and the client's host link, so only the shape this plugin issues is accepted.
    id: typeof raw.id === 'string' && HOST_ID_RE.test(raw.id) ? raw.id : (existing?.id ?? undefined),
    name: name || destination.host || destination.alias || 'remote',
    address,
    port: numberIn(raw.port ?? destination.port ?? existing?.port, 1, 65535, settings.defaultPort),
    username: username || null,
    auth: { type: authType, ...(keyPath ? { keyPath } : {}) },
    jumpHost: optionalText(raw.jumpHost, existing?.jumpHost ?? null),
    keepAlive,
    idleMinutes: numberIn(raw.idleMinutes ?? existing?.idleMinutes, 1, 24 * 60, DEFAULT_IDLE_MINUTES),
    autoReconnect: boolean(raw.autoReconnect, existing?.autoReconnect ?? settings.autoReconnect.enabled),
    hostKeyPolicy,
    pinnedFingerprint:
      typeof raw.pinnedFingerprint === 'string' && raw.pinnedFingerprint.startsWith('SHA256:')
        ? raw.pinnedFingerprint
        : (existing?.pinnedFingerprint ?? null),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOpenedAt: existing?.lastOpenedAt ?? null,
  }
}

/**
 * Plugin settings: defaults, validation and sanitization. Unknown or invalid
 * fields fall back to defaults instead of failing activation (a malformed saved
 * setting must never brick the plugin).
 */
import { DEFAULT_IDLE_MINUTES, DEFAULT_KEY_PATH, DEFAULT_REMOTE_PROFILE, SSH_READY_TIMEOUT_MS } from './constants.js'
import { clamp, deepMerge, isPlainObject, parseSshDestination } from './util.js'

/**
 * @typedef {{
 *   defaultPort: number,
 *   defaultAuth: 'key' | 'password',
 *   defaultKeyPath: string,
 *   connectTimeoutSec: number,
 *   autoReconnect: { enabled: boolean, maxAttempts: number, baseDelayMs: number },
 *   hostKeyPolicy: 'first-use' | 'strict',
 *   saveTokens: boolean,
 *   language: 'auto' | 'zh' | 'en',
 *   logLevel: 'error' | 'warn' | 'info' | 'debug',
 *   bootstrap: { profile: string },
 * }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    defaultPort: 22,
    // Only a key file (or a one-time password) is supported: there is no SSH
    // agent path any more, so the default is the key file the wizard pre-fills.
    defaultAuth: 'key',
    defaultKeyPath: DEFAULT_KEY_PATH,
    connectTimeoutSec: Math.round(SSH_READY_TIMEOUT_MS / 1000),
    autoReconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 800 },
    hostKeyPolicy: 'first-use',
    saveTokens: false,
    language: 'auto',
    logLevel: 'info',
    bootstrap: {
      profile: DEFAULT_REMOTE_PROFILE,
    },
  }
}

/**
 * A profile name DSH can boot: one safe path segment, and never `desktop`
 * (the Electron app reserves that profile and the CLI refuses it).
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeProfileName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text)) return null
  if (text.toLowerCase() === 'desktop') return null
  return text
}

/** @param {unknown} value @param {unknown[]} allowed @param {any} fallback */
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function numberIn(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return clamp(Math.round(num), min, max)
}

/** @param {unknown} value @param {boolean} fallback */
function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Merge a saved/partial settings object over defaults with validation.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
  const defaults = defaultSettings()
  if (!isPlainObject(raw)) return defaults
  const input = deepMerge(defaults, raw)
  const autoReconnect = isPlainObject(input.autoReconnect) ? input.autoReconnect : defaults.autoReconnect
  const bootstrap = isPlainObject(input.bootstrap) ? input.bootstrap : defaults.bootstrap
  const profile = normalizeProfileName(bootstrap.profile) ?? defaults.bootstrap.profile
  return {
    defaultPort: numberIn(input.defaultPort, 1, 65535, defaults.defaultPort),
    // The retired "agent" choice migrates to key-file auth instead of silently
    // resetting, because key files are the only non-interactive option left.
    defaultAuth:
      input.defaultAuth === 'agent' ? 'key' : oneOf(input.defaultAuth, ['key', 'password'], defaults.defaultAuth),
    defaultKeyPath:
      typeof input.defaultKeyPath === 'string' && input.defaultKeyPath.trim() !== ''
        ? input.defaultKeyPath.trim()
        : defaults.defaultKeyPath,
    connectTimeoutSec: numberIn(input.connectTimeoutSec, 5, 300, defaults.connectTimeoutSec),
    autoReconnect: {
      enabled: boolean(autoReconnect.enabled, defaults.autoReconnect.enabled),
      maxAttempts: numberIn(autoReconnect.maxAttempts, 0, 20, defaults.autoReconnect.maxAttempts),
      baseDelayMs: numberIn(autoReconnect.baseDelayMs, 100, 30_000, defaults.autoReconnect.baseDelayMs),
    },
    hostKeyPolicy: oneOf(input.hostKeyPolicy, ['first-use', 'strict'], defaults.hostKeyPolicy),
    saveTokens: boolean(input.saveTokens, defaults.saveTokens),
    language: oneOf(input.language, ['auto', 'zh', 'en'], defaults.language),
    logLevel: oneOf(input.logLevel, ['error', 'warn', 'info', 'debug'], defaults.logLevel),
    bootstrap: {
      profile,
    },
  }
}

/**
 * Validate and normalize a host entry coming from the Client.
 * @param {unknown} raw
 * @param {{ settings?: Settings, existing?: Record<string, any> | null, idFactory?: () => string }} [options]
 * @returns {Record<string, any>}
 */
export function sanitizeHostEntry(raw, options = {}) {
  const settings = options.settings ?? defaultSettings()
  const existing = options.existing ?? null
  if (!isPlainObject(raw)) throw new Error('host entry must be an object')
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 120) : ''
  const address = typeof raw.address === 'string' ? raw.address.trim() : ''
  if (address === '') throw new Error('address is required')
  const destination = parseSshDestination(address)
  if (!destination.host) throw new Error('address is invalid')
  const userInput = typeof raw.username === 'string' ? raw.username.trim() : ''
  const username = userInput || existing?.username || destination.user || ''
  const authType =
    raw.auth && isPlainObject(raw.auth)
      ? raw.auth.type === 'agent'
        ? 'key'
        : oneOf(raw.auth.type, ['key', 'password'], settings.defaultAuth)
      : (existing?.auth?.type ?? settings.defaultAuth)
  const keyPathInput =
    raw.auth && isPlainObject(raw.auth) && typeof raw.auth.keyPath === 'string' ? raw.auth.keyPath.trim() : ''
  const keyPath = keyPathInput || existing?.auth?.keyPath || (authType === 'key' ? settings.defaultKeyPath : '')
  const keepAlive = oneOf(raw.keepAlive, ['keep', 'stop', 'idle'], existing?.keepAlive ?? 'keep')
  const hostKeyPolicy = oneOf(
    raw.hostKeyPolicy,
    ['first-use', 'strict'],
    existing?.hostKeyPolicy ?? settings.hostKeyPolicy,
  )
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : (existing?.id ?? undefined),
    name: name || destination.host || destination.alias || 'remote',
    address,
    port: numberIn(raw.port ?? destination.port ?? existing?.port, 1, 65535, settings.defaultPort),
    username: username || null,
    auth: { type: authType, ...(keyPath ? { keyPath } : {}) },
    jumpHost:
      typeof raw.jumpHost === 'string'
        ? raw.jumpHost.trim() !== ''
          ? raw.jumpHost.trim()
          : null
        : (existing?.jumpHost ?? null),
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

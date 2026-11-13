/**
 * Plugin settings: defaults, validation and sanitization. Unknown or invalid
 * fields fall back to defaults instead of failing activation (a malformed saved
 * setting must never brick the plugin).
 */
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_KEY_PATH,
  DEFAULT_NODE_VERSION,
  DEFAULT_REMOTE_DIR,
  SSH_READY_TIMEOUT_MS,
} from './constants.js'
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
 *   mirrorToSidebar: boolean,
 *   mirrorMaxSessions: number,
 *   mirrorMaxEvents: number,
 *   mirrorHistory: boolean,
 *   language: 'auto' | 'zh' | 'en',
 *   logLevel: 'error' | 'warn' | 'info' | 'debug',
 *   bootstrap: { targetVersion: string, mode: 'auto' | 'reuse' | 'npx' | 'isolated', remoteDir: string, nodeVersion: string },
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
    // Mirrored remote sessions stay OUT of the sidebar by default: the window
    // takeover already presents the remote host as-is, and the extra
    // "Remote: <host>" workspace only duplicates it. Opt in to get it back.
    mirrorToSidebar: false,
    // Upper bound on local mirror sessions created per sync; 0 means unlimited.
    // It only limits creation: a session a previous sync created is never removed.
    mirrorMaxSessions: 200,
    // Upper bound on replayed history events per mirror session (0 = unlimited).
    // L2 keeps the NEWEST window and announces the folded prefix, so a session
    // whose remote log is long still lands with a contiguous cursor.
    mirrorMaxEvents: 200,
    // L2 toggle: false keeps every mirror at L1 (directory only).
    mirrorHistory: true,
    // L3 polled follower (design §6.4). **Off by default**: with it false the plugin behaves
    // exactly as it did before the follower existed, so a regression cannot break anyone.
    mirrorStream: false,
    language: 'auto',
    logLevel: 'info',
    bootstrap: {
      targetVersion: 'local',
      mode: 'auto',
      remoteDir: DEFAULT_REMOTE_DIR,
      nodeVersion: DEFAULT_NODE_VERSION,
    },
  }
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
  const targetVersion =
    typeof bootstrap.targetVersion === 'string' && bootstrap.targetVersion.trim() !== ''
      ? bootstrap.targetVersion.trim()
      : defaults.bootstrap.targetVersion
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
    mirrorToSidebar: boolean(input.mirrorToSidebar, defaults.mirrorToSidebar),
    // `null` is not a value the user can choose: it means "unset", so it falls
    // back to the default. Only an explicit 0 means unlimited.
    mirrorMaxSessions:
      input.mirrorMaxSessions === null
        ? defaults.mirrorMaxSessions
        : numberIn(input.mirrorMaxSessions, 0, 5000, defaults.mirrorMaxSessions),
    // Same "null means unset, 0 means unlimited" rule as `mirrorMaxSessions`.
    mirrorMaxEvents:
      input.mirrorMaxEvents === null
        ? defaults.mirrorMaxEvents
        : numberIn(input.mirrorMaxEvents, 0, 5000, defaults.mirrorMaxEvents),
    mirrorHistory: boolean(input.mirrorHistory, defaults.mirrorHistory),
    mirrorStream: boolean(input.mirrorStream, defaults.mirrorStream),
    language: oneOf(input.language, ['auto', 'zh', 'en'], defaults.language),
    logLevel: oneOf(input.logLevel, ['error', 'warn', 'info', 'debug'], defaults.logLevel),
    bootstrap: {
      targetVersion,
      mode: oneOf(bootstrap.mode, ['auto', 'reuse', 'npx', 'isolated'], defaults.bootstrap.mode),
      remoteDir:
        typeof bootstrap.remoteDir === 'string' && bootstrap.remoteDir.trim() !== ''
          ? bootstrap.remoteDir.trim()
          : defaults.bootstrap.remoteDir,
      nodeVersion:
        typeof bootstrap.nodeVersion === 'string' && /^v?\d+\.\d+\.\d+$/.test(bootstrap.nodeVersion.trim())
          ? bootstrap.nodeVersion.trim()
          : defaults.bootstrap.nodeVersion,
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
  const bootstrapRaw = isPlainObject(raw.bootstrap) ? raw.bootstrap : {}
  const bootstrapExisting = existing?.bootstrap ?? {}
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
    bootstrap: {
      mode: oneOf(
        bootstrapRaw.mode,
        ['auto', 'reuse', 'npx', 'isolated'],
        bootstrapExisting.mode ?? settings.bootstrap.mode,
      ),
      targetVersion:
        typeof bootstrapRaw.targetVersion === 'string' && bootstrapRaw.targetVersion.trim() !== ''
          ? bootstrapRaw.targetVersion.trim()
          : (bootstrapExisting.targetVersion ?? settings.bootstrap.targetVersion),
      remoteDir:
        typeof bootstrapRaw.remoteDir === 'string' && bootstrapRaw.remoteDir.trim() !== ''
          ? bootstrapRaw.remoteDir.trim()
          : (bootstrapExisting.remoteDir ?? settings.bootstrap.remoteDir),
      nodeVersion:
        typeof bootstrapRaw.nodeVersion === 'string' && /^v?\d+\.\d+\.\d+$/.test(bootstrapRaw.nodeVersion.trim())
          ? bootstrapRaw.nodeVersion.trim()
          : (bootstrapExisting.nodeVersion ?? settings.bootstrap.nodeVersion),
    },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOpenedAt: existing?.lastOpenedAt ?? null,
  }
}

// client/src/wizard-draft.ts - HOST_LIMITS, the host-draft parser/validator and initialDraft (driven through __test); after key-picker.ts, before wizard.ts.
//#region 10. connect wizard
/** The ranges the Host clamps to (`src/settings.js`): the Client checks the same numbers, so both sides agree. */
// A value is accepted unchanged on both sides or rejected, never rewritten, and `__test.limits` pins the table.
interface HostRange {
  min: number
  max: number
}

/** What the host wizard keeps between renders: flat, string-or-number fields. */
interface HostDraftForm {
  [key: string]: unknown
}

const HOST_LIMITS: Record<string, HostRange> = {
  defaultPort: { min: 1, max: 65535 },
  connectTimeoutSec: { min: 5, max: 300 },
  idleMinutes: { min: 1, max: 1440 },
  maxAttempts: { min: 0, max: 20 },
  baseDelayMs: { min: 100, max: 30000 },
}
/** A profile name DSH can boot: one safe path segment, and never `desktop`. */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function isValidProfileName(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : ''
  return text !== '' && PROFILE_PATTERN.test(text) && text.toLowerCase() !== 'desktop'
}
function inRange(value: unknown, limit: HostRange): boolean {
  const number = toInt(value, NaN)
  return Number.isInteger(number) && number >= limit.min && number <= limit.max
}
function toInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isFinite(number) && Number.isInteger(number) ? number : fallback
}

/** Legacy Hosts only expose `addressMasked`: the bracketed IPv6 form carries a port, a bare one never does. */
// New Hosts expose `port`/`username`, read directly.
function parseMaskedAddress(masked: unknown): { username: string; port: number | null } {
  const text = String(masked || '')
  const at = text.lastIndexOf('@')
  const tail = at >= 0 ? text.slice(at + 1) : text
  const result: { username: string; port: number | null } = { username: at < 0 ? '' : text.slice(0, at), port: null }
  const bracketed = tail.match(/^\[([^\]]+)\](?::(\d+))?$/)
  // More than one colon means IPv6: nothing after the last colon is a port (`fe80::1` gave 1).
  const single = (tail.match(/:/g) || []).length > 1 ? null : tail.match(/:(\d+)\s*$/)
  if (bracketed) result.port = bracketed[2] ? Number(bracketed[2]) : null
  else if (single) result.port = Number(single[1])
  return result
}

/** The body `POST /hosts` takes: `jumpHost`, `id` and `auth` are added conditionally. */
// The Host treats a missing field as "keep what is stored".
interface HostInputBody {
  name: string
  address: string
  port: number
  username: string
  keepAlive: string
  idleMinutes: number
  autoReconnect: boolean
  hostKeyPolicy: string
  jumpHost?: string
  id?: string
  auth?: { type: string; keyPath?: string }
}
/** What a save may or may not demand from the draft (an edit that leaves auth alone demands less). */
interface HostDraftValidationOptions {
  requireKeyPath?: boolean
  requirePassword?: boolean
}

function buildHostInput(draft: HostDraftForm, hostId: string | undefined, includeAuth: boolean): HostInputBody {
  const host: HostInputBody = {
    name: String(draft.name || '').trim(),
    address: String(draft.address || '').trim(),
    port: toInt(draft.port, 22),
    username: String(draft.username || '').trim(),
    keepAlive: draft.keepAlive === 'stop' || draft.keepAlive === 'idle' ? draft.keepAlive : 'keep',
    idleMinutes: toInt(draft.idleMinutes, 15),
    autoReconnect: draft.autoReconnect !== false,
    hostKeyPolicy: draft.hostKeyPolicy === 'strict' ? 'strict' : 'first-use',
  }
  // An explicit empty string clears the jump host; an omitted field keeps the existing value.
  if (!hostId || draft.jumpHostKnown !== false) host.jumpHost = String(draft.jumpHost || '').trim()
  if (hostId) host.id = hostId
  // Key files and passwords are the only methods; a stale draft with the retired "agent" choice falls back to a key.
  const keyPath = String(draft.keyPath || '').trim()
  if (includeAuth) host.auth = draft.authType === 'password' ? { type: 'password' } : { type: 'key', keyPath }
  return host
}

/** One validation failure names the field so the form can mark and focus it, not only toast it. */
function fieldError(field: string, code: string) {
  return { field, code }
}

function validateHostDraft(draft: HostDraftForm, options: HostDraftValidationOptions = {}) {
  if (!String(draft.name || '').trim()) return fieldError('name', 'wizard.validationName')
  const address = String(draft.address || '').trim()
  if (!address) return fieldError('address', 'wizard.validationAddress')
  if (looksLikeWebAddress(address)) return fieldError('address', 'wizard.validationAddressUrl')
  if (!inRange(draft.port, HOST_LIMITS.defaultPort)) return fieldError('port', 'wizard.validationPort')
  if (draft.keepAlive === 'idle' && !inRange(draft.idleMinutes, HOST_LIMITS.idleMinutes)) {
    return fieldError('idleMinutes', 'wizard.validationIdleMinutes')
  }
  // An edit that leaves authentication untouched keeps the stored key, so an empty field errors only when auth is sent.
  const keyPath = String(draft.keyPath || '').trim()
  if (draft.authType === 'key' && options.requireKeyPath !== false && !keyPath) {
    return fieldError('keyPath', 'wizard.validationKeyPath')
  }
  if (draft.authType === 'password' && options.requirePassword === true && String(draft.password || '').trim() === '') {
    return fieldError('password', 'wizard.validationPassword')
  }
  return null
}

/** The settings modal validates against the same table the Host clamps with. */
function validateSettingsDraft(draft: SettingsDraft) {
  const checks = [
    ['defaultPort', 'settings.validationPort'],
    ['connectTimeoutSec', 'settings.validationTimeout'],
    ['maxAttempts', 'settings.validationAttempts'],
    ['baseDelayMs', 'settings.validationBaseDelay'],
  ]
  for (const [field, code] of checks) if (!inRange(draft[field], HOST_LIMITS[field])) return fieldError(field, code)
  if (!isValidProfileName(draft.profile)) return fieldError('profile', 'settings.validationProfile')
  return null
}

function initialDraft(mode: string, host: HostLike | null, settings: SettingsView | null | undefined): HostDraftForm {
  const defaults: Partial<SettingsView> = settings && typeof settings === 'object' ? settings : {}
  const auto: Partial<SettingsView['autoReconnect']> =
    defaults.autoReconnect && typeof defaults.autoReconnect === 'object' ? defaults.autoReconnect : {}
  // Adding starts from the settings, an edit from the fields the Host exposes; the masked address is display only.
  // Parsing it back invented a port (`user@fe80::1` -> 1) and overwrote the default, so it is pre-v2.10 only.
  const editing = mode === 'edit' && Boolean(host)
  const source: Partial<HostView> = editing ? host : {}
  const parsed = parseMaskedAddress(source.addressMasked)
  const port = typeof source.port === 'number' && Number.isInteger(source.port) ? source.port : null
  const user = typeof source.username === 'string' ? source.username : null
  const configuredKey = editing ? '' : defaults.defaultKeyPath || '~/.ssh/id_rsa'
  return {
    name: source.name || '',
    address: source.address || '',
    port: port === null ? (parsed.port === null ? defaults.defaultPort || 22 : parsed.port) : port,
    username: user === null ? parsed.username : user,
    jumpHost: typeof source.jumpHost === 'string' ? source.jumpHost : '',
    jumpHostKnown: !editing || typeof source.jumpHost === 'string',
    authType: typeof source.authType === 'string' ? source.authType : defaults.defaultAuth || 'key',
    // The Host exposes the configured path (not a secret), so an edit does not start at the default.
    keyPath: typeof source.authKeyPath === 'string' ? source.authKeyPath : configuredKey,
    keepAlive: source.keepAlive || 'keep',
    idleMinutes: source.idleMinutes || 15,
    autoReconnect: editing ? source.autoReconnect !== false : auto.enabled !== false,
    hostKeyPolicy: source.hostKeyPolicy || defaults.hostKeyPolicy || 'first-use',
  }
}

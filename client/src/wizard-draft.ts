// client/src/wizard-draft.ts - HOST_LIMITS, the host-draft parser/validator and initialDraft (driven through __test); after key-picker.ts, before wizard.ts.
//#region 10. connect wizard

/**
 * The ranges the Host actually enforces (`src/settings.js` clamps to them). The Client now
 * checks the same numbers before it saves, so a value is either accepted unchanged on both
 * sides or rejected with a field error — never silently rewritten by the Host. `__test.limits`
 * keeps this table pinned to the Host's behaviour in `test/unit/client.test.js`.
 */
const HOST_LIMITS = {
  defaultPort: { min: 1, max: 65535 },
  connectTimeoutSec: { min: 5, max: 300 },
  idleMinutes: { min: 1, max: 1440 },
  maxAttempts: { min: 0, max: 20 },
  baseDelayMs: { min: 100, max: 30000 },
}
/** A profile name DSH can boot: one safe path segment, and never `desktop`. */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function isValidProfileName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text !== '' && PROFILE_PATTERN.test(text) && text.toLowerCase() !== 'desktop'
}
function inRange(value, limit) {
  const number = toInt(value, NaN)
  return Number.isInteger(number) && number >= limit.min && number <= limit.max
}

function toInt(value, fallback) {
  const number =
    typeof value === 'number' ? value : Number(String(value === undefined || value === null ? '' : value).trim())
  return Number.isFinite(number) && Number.isInteger(number) ? number : fallback
}

/**
 * Legacy Hosts only expose `addressMasked`; this reads a port out of it. Bracketed IPv6
 * (`user@[fe80::1]:2222`) carries one; a bare IPv6 (`user@fe80::1`) never does, so its last
 * colon-separated group is not a port. New Hosts expose `port`/`username`, and the editor reads
 * those directly (see `initialDraft`).
 */
function parseMaskedAddress(masked) {
  const text = String(masked || '')
  const result = { username: '', port: null }
  const at = text.lastIndexOf('@')
  if (at >= 0) result.username = text.slice(0, at)
  const tail = at >= 0 ? text.slice(at + 1) : text
  const bracketed = tail.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracketed) {
    result.port = bracketed[2] ? Number(bracketed[2]) : null
    return result
  }
  // An unbracketed address with more than one colon is IPv6: nothing after the last colon is
  // a port (`fe80::1` used to yield port 1 here).
  if ((tail.match(/:/g) || []).length > 1) return result
  const match = tail.match(/:(\d+)\s*$/)
  if (match) result.port = Number(match[1])
  return result
}

/**
 * The body `POST /hosts` takes as this wizard builds it. `jumpHost`, `id` and `auth` are added
 * conditionally (a new host vs. an edit, an untouched credential vs. a new one), which is why they
 * are optional here: the Host treats a missing field as "keep what is stored".
 */
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

function buildHostInput(draft, hostId, includeAuth) {
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
  // Contract: an explicit empty string clears the jump host; an omitted field keeps the existing value on update.
  // Send it only when the HostView exposed it (edit) or when adding a host.
  const jumpHost = String(draft.jumpHost || '').trim()
  if (!hostId || draft.jumpHostKnown !== false) host.jumpHost = jumpHost
  if (hostId) host.id = hostId
  if (includeAuth) {
    // Key files and passwords are the only accepted methods; anything
    // else (a stale draft carrying the retired "agent" choice) falls back to a key.
    if (draft.authType === 'password') {
      host.auth = { type: 'password' }
    } else {
      host.auth = { type: 'key', keyPath: String(draft.keyPath || '').trim() }
    }
  }
  return host
}

/** One validation failure names the field so the form can mark and focus it, not only toast it. */
function fieldError(field, code) {
  return { field, code }
}

function validateHostDraft(draft, options: HostDraftValidationOptions = {}) {
  if (!String(draft.name || '').trim()) return fieldError('name', 'wizard.validationName')
  const address = String(draft.address || '').trim()
  if (!address) return fieldError('address', 'wizard.validationAddress')
  if (looksLikeWebAddress(address)) return fieldError('address', 'wizard.validationAddressUrl')
  if (!inRange(draft.port, HOST_LIMITS.defaultPort)) return fieldError('port', 'wizard.validationPort')
  if (draft.keepAlive === 'idle' && !inRange(draft.idleMinutes, HOST_LIMITS.idleMinutes)) {
    return fieldError('idleMinutes', 'wizard.validationIdleMinutes')
  }
  // An edit that leaves authentication untouched keeps the stored key, so an
  // empty field is only an error when this save actually sends auth.
  const requireKeyPath = options.requireKeyPath !== false
  if (draft.authType === 'key' && requireKeyPath && !String(draft.keyPath || '').trim()) {
    return fieldError('keyPath', 'wizard.validationKeyPath')
  }
  if (draft.authType === 'password' && options.requirePassword === true && String(draft.password || '').trim() === '') {
    return fieldError('password', 'wizard.validationPassword')
  }
  return null
}

/** The settings modal validates against the same table the Host clamps with. */
function validateSettingsDraft(draft) {
  if (!inRange(draft.defaultPort, HOST_LIMITS.defaultPort)) {
    return fieldError('defaultPort', 'settings.validationPort')
  }
  if (!inRange(draft.connectTimeoutSec, HOST_LIMITS.connectTimeoutSec)) {
    return fieldError('connectTimeoutSec', 'settings.validationTimeout')
  }
  if (!inRange(draft.maxAttempts, HOST_LIMITS.maxAttempts)) {
    return fieldError('maxAttempts', 'settings.validationAttempts')
  }
  if (!inRange(draft.baseDelayMs, HOST_LIMITS.baseDelayMs)) {
    return fieldError('baseDelayMs', 'settings.validationBaseDelay')
  }
  if (!isValidProfileName(draft.profile)) return fieldError('profile', 'settings.validationProfile')
  return null
}

function initialDraft(mode, host, settings) {
  const defaults = settings && typeof settings === 'object' ? settings : {}
  const auto = defaults.autoReconnect && typeof defaults.autoReconnect === 'object' ? defaults.autoReconnect : {}
  if (mode === 'edit' && host) {
    // Read the plain fields the Host exposes; the masked address is presentation only and
    // parsing it back used to invent a port (`user@fe80::1` -> 1) or overwrite the default
    // port with 22. The parse stays as the fallback for a Host from before v2.10.
    const parsed = parseMaskedAddress(host.addressMasked)
    const exposedPort = typeof host.port === 'number' && Number.isInteger(host.port) ? host.port : null
    const exposedUser = typeof host.username === 'string' ? host.username : null
    return {
      name: host.name || '',
      address: host.address || '',
      port: exposedPort === null ? (parsed.port === null ? defaults.defaultPort || 22 : parsed.port) : exposedPort,
      username: exposedUser === null ? parsed.username : exposedUser,
      jumpHost: typeof host.jumpHost === 'string' ? host.jumpHost : '',
      jumpHostKnown: typeof host.jumpHost === 'string',
      authType: typeof host.authType === 'string' ? host.authType : defaults.defaultAuth || 'key',
      // The Host exposes the configured path (not a secret) so an edit does not
      // start with an empty field; touching nothing still keeps the stored key.
      keyPath: typeof host.authKeyPath === 'string' ? host.authKeyPath : '',
      keepAlive: host.keepAlive || 'keep',
      idleMinutes: host.idleMinutes || 15,
      autoReconnect: host.autoReconnect !== false,
      hostKeyPolicy: host.hostKeyPolicy || defaults.hostKeyPolicy || 'first-use',
    }
  }
  return {
    name: '',
    address: '',
    port: defaults.defaultPort || 22,
    username: '',
    jumpHost: '',
    jumpHostKnown: true,
    authType: defaults.defaultAuth || 'key',
    keyPath: defaults.defaultKeyPath || '~/.ssh/id_rsa',
    keepAlive: 'keep',
    idleMinutes: 15,
    autoReconnect: auto.enabled !== false,
    hostKeyPolicy: defaults.hostKeyPolicy || 'first-use',
  }
}

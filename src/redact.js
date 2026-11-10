/**
 * Diagnostics redaction (design §15.2 P9, §16.8): tokens, passwords and private
 * keys never leave the machine in a diagnostic package.
 */

const SECRET_QUERY_KEYS = ['token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password', 'passwd', 'auth']
const SECRET_HEADER_RE = /\b(authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*:\s*[^\r\n]+/gi
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
const TOKEN_QUERY_RE = new RegExp(`([?&](?:${SECRET_QUERY_KEYS.join('|')})=)[^&#\\s"']+`, 'gi')
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const PASSWORD_FLAG_RE = /(--password[=\s]+|-p\s+|password[=:]\s*)(\S+)/gi
const DSH_TOKEN_LINE_RE = /(dsh web:\s*\S*?\?token=)[A-Za-z0-9._~+/=-]+/g
const LONG_HEX_RE = /\b[a-f0-9]{40,}\b/gi
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{48,}={0,2}\b/g

/**
 * Redact a single string.
 * @param {string} text
 * @param {{ keepPaths?: boolean }} [options]
 */
export function redactText(text, options = {}) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  out = out.replace(PRIVATE_KEY_RE, '-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----')
  out = out.replace(SECRET_HEADER_RE, (match) => `${match.split(':')[0]}: <redacted>`)
  out = out.replace(BEARER_RE, (_match, scheme) => `${scheme} <redacted>`)
  out = out.replace(TOKEN_QUERY_RE, '$1<redacted>')
  out = out.replace(DSH_TOKEN_LINE_RE, '$1<redacted>')
  out = out.replace(PASSWORD_FLAG_RE, '$1<redacted>')
  if (!options.keepPaths) {
    // Home directories of the remote account are not secrets, but avoid leaking
    // arbitrary local user names into exported diagnostics.
    out = out.replace(/(\/home\/)[^/\s]+/g, '$1<user>')
    out = out.replace(/\b(C:\\Users\\)[^\\\s]+/gi, '$1<user>')
  }
  return out
}

/** @param {unknown} value */
function redactValue(key, value) {
  const lowered = String(key).toLowerCase()
  if (typeof value === 'string') {
    if (/(password|token|secret|passphrase|authorization|apikey|api_key|privatekey|cookie)/.test(lowered)) return '<redacted>'
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item))
  if (value && typeof value === 'object') return redactObject(value)
  return value
}

/**
 * Deep-redact a JSON-compatible value.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function redactObject(value) {
  if (Array.isArray(value)) return /** @type {T} */ (value.map((item) => redactValue('', item)))
  if (!value || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = redactValue(key, item)
  return /** @type {T} */ (out)
}

/**
 * Strip a secret query parameter from a URL for display.
 * @param {string} url
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url)
    for (const key of SECRET_QUERY_KEYS) parsed.searchParams.delete(key)
    return parsed.toString()
  } catch {
    return redactText(String(url))
  }
}

/**
 * Remove long opaque identifiers that are almost certainly credentials while
 * keeping ordinary diagnostics text readable.
 * @param {string} text
 */
export function redactLongOpaque(text) {
  return redactText(String(text)).replace(LONG_HEX_RE, '<redacted-hex>').replace(LONG_BASE64_RE, '<redacted-b64>')
}

/**
 * Build a redacted diagnostics bundle for "copy diagnostics".
 * @param {{ host?: string, checks?: unknown, logs?: string[], connection?: unknown }} input
 */
export function buildDiagnosticBundle(input) {
  return redactObject({
    generatedAt: new Date().toISOString(),
    plugin: 'dsh-remote-go',
    ...input,
  })
}

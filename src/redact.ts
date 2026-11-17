/**
 * Diagnostics redaction: tokens, passwords and private keys never leave the machine in a diagnostic package.
 */

/** Callers that render paths themselves set `keepPaths` so the home-directory rule is opt-out. */
export interface RedactOptions {
  keepPaths?: boolean
}

const SECRET_QUERY_KEYS = ['token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password', 'passwd', 'auth']
const SECRET_HEADER_RE = /\b(authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*:\s*[^\r\n]+/gi
/** Custom authentication headers (`x-auth-token`, `x-dsh-session-key`, …) are secrets too. */
const SECRET_CUSTOM_HEADER_RE = /\b(x-[a-z0-9-]*(?:token|key|secret|auth)[a-z0-9-]*)\s*:\s*[^\r\n]+/gi
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
const TOKEN_QUERY_RE = new RegExp(`([?&](?:${SECRET_QUERY_KEYS.join('|')})=)[^&#\\s"']+`, 'gi')
/**
 * A bare `token=…` outside a query string (log lines, `#fragment`, key=value dumps). The
 * value never contains `<`/`>` so an already-redacted `<redacted>` is left alone.
 */
const BARE_TOKEN_KEYS = ['token', 'access_token', 'api_key', 'apikey', 'secret', 'password', 'passwd']
const BARE_TOKEN_RE = new RegExp(`\\b((?:${BARE_TOKEN_KEYS.join('|')})\\s*=\\s*)[^\\s&;,'"<>]+`, 'gi')
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
/**
 * `--password X`, `password=X` and the short `-p X` form. The short form is also ssh's
 * port flag (`ssh -p 2222`), so a bare number is left alone: a port is not a secret and
 * mangling it would make the technical detail unreadable.
 */
const PASSWORD_FLAG_RE = /(--password[=\s]+|password[=:]\s*|-p\s+(?!\d+\b))(\S+)/gi
const DSH_TOKEN_LINE_RE = /(dsh web:\s*\S*?\?token=)[A-Za-z0-9._~+/=-]+/g

export function redactText(text: string, options: RedactOptions = {}): string {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  out = out.replace(PRIVATE_KEY_RE, '-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----')
  out = out.replace(SECRET_HEADER_RE, (match) => `${match.split(':')[0]}: <redacted>`)
  out = out.replace(SECRET_CUSTOM_HEADER_RE, (match) => `${match.split(':')[0]}: <redacted>`)
  out = out.replace(BEARER_RE, (_match, scheme) => `${scheme} <redacted>`)
  out = out.replace(TOKEN_QUERY_RE, '$1<redacted>')
  out = out.replace(DSH_TOKEN_LINE_RE, '$1<redacted>')
  out = out.replace(BARE_TOKEN_RE, '$1<redacted>')
  out = out.replace(PASSWORD_FLAG_RE, '$1<redacted>')
  if (!options.keepPaths) {
    // Home directories of the remote account are not secrets, but avoid leaking
    // arbitrary local user names into exported diagnostics.
    out = out.replace(/(\/home\/)[^/\s]+/g, '$1<user>')
    out = out.replace(/(\/Users\/)[^/\s]+/g, '$1<user>')
    out = out.replace(/\b(C:\\Users\\)[^\\\s]+/gi, '$1<user>')
  }
  return out
}

function redactValue(key: string, value: unknown): unknown {
  const lowered = String(key).toLowerCase()
  if (typeof value === 'string') {
    if (/(password|token|secret|passphrase|authorization|apikey|api_key|privatekey|cookie)/.test(lowered))
      return '<redacted>'
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item))
  if (value && typeof value === 'object') return redactObject(value)
  return value
}

/**
 * Deep-redact a JSON-compatible value.
 */
export function redactObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactValue('', item)) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = redactValue(key, item)
  return out as T
}

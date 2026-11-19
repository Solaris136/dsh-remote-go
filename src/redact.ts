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
/**
 * A bare `key=value` pair (log lines, `#fragment`, dumps). The anchor is "not alphanumeric" rather
 * than `\b`, so a prefixed env name such as `MYSQL_PWD=…` is caught too (`_` is a word character,
 * which made `\b` miss it). The value never contains `<`/`>` so an already-redacted `<redacted>` is
 * left alone.
 */
const BARE_TOKEN_KEYS = [
  'token',
  'access_token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'credential',
  'key',
]
const BARE_TOKEN_RE = new RegExp(`(^|[^A-Za-z0-9])((?:${BARE_TOKEN_KEYS.join('|')})\\s*=\\s*)[^\\s&;,'"<>]+`, 'gi')
/**
 * A secret passed as a command-line flag (`--token abc`, `--api-key x`, `--password y`). No `\b`
 * anchor: `-` is a non-word character, so a boundary never holds right before `--token`. The
 * separate `PASSWORD_FLAG_RE` below covers the historic spellings; this one catches the token-ish
 * flags that a launch command line carries, which `ps` output made worth redacting.
 */
const SECRET_FLAG_RE =
  /(?:--?)(?:token|api-key|apikey|auth-token|access-token|password|passphrase)[=\s]+(?!<redacted>)\S+/gi
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
/**
 * `--password X`, `password=X` and the short `-p X` form. The short form is also ssh's
 * port flag (`ssh -p 2222`), so a bare number is left alone: a port is not a secret and
 * mangling it would make the technical detail unreadable. The value may also be glued to the
 * flag (`mysql -pHunter2`), which is why the whitespace after `-p` is optional.
 */
const PASSWORD_FLAG_RE = /(--password[=\s]+|password[=:]\s*|-p\s*(?!\d+\b))(\S+)/gi
const DSH_TOKEN_LINE_RE = /(dsh web:\s*\S*?\?token=)[A-Za-z0-9._~+/=-]+/g

export function redactText(text: string, options: RedactOptions = {}): string {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  out = out.replace(PRIVATE_KEY_RE, '-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----')
  // A capture that was cut before the footer (`safeText` bounds every field before it redacts) leaves
  // a header with no END; the complete-block rule above cannot match it, so the body is dropped
  // explicitly. The placeholder from the rule above already carries an END and is left alone.
  const strayBegin = out.lastIndexOf('-----BEGIN ')
  if (strayBegin >= 0 && strayBegin > out.lastIndexOf('-----END ')) {
    out = `${out.slice(0, strayBegin)}-----BEGIN PRIVATE KEY-----<redacted>`
  }
  out = out.replace(SECRET_HEADER_RE, (match) => `${match.split(':')[0]}: <redacted>`)
  out = out.replace(SECRET_CUSTOM_HEADER_RE, (match) => `${match.split(':')[0]}: <redacted>`)
  out = out.replace(BEARER_RE, (_match, scheme) => `${scheme} <redacted>`)
  out = out.replace(TOKEN_QUERY_RE, '$1<redacted>')
  out = out.replace(DSH_TOKEN_LINE_RE, '$1<redacted>')
  out = out.replace(SECRET_FLAG_RE, (match) => `${match.replace(/\S+$/, '')}<redacted>`)
  out = out.replace(BARE_TOKEN_RE, '$1$2<redacted>')
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

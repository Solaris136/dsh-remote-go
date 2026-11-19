/**
 * Header rewriting for the same-origin proxy: an allowlist on the way out, a blocklist on the way
 * back, and the two authority fields rewritten so the remote keeps seeing its own loopback seat.
 *
 * The proxy hands the browser a page from another origin without handing it a second origin, so
 * `Host`/`Origin` are rewritten to the remote's own loopback authority (its authority-bound cookie
 * and same-origin fence keep working), while the browser's own local credentials and the
 * traffic-shaping headers of this hop stay here.
 */
import { REMOTE_VIEW_PREFIX } from '../constants.js'
import { cookieHeader } from './cookies.js'
import type { CookieJar } from './cookies.js'

/** Headers that describe one hop and must not be copied to the other connection. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * The request headers this proxy forwards. This is an allowlist on purpose: the browser's own
 * credentials belong to the *local* origin (`authorization`, `cookie`, `x-dsh-*`) and the
 * traffic-shaping headers belong to this hop (`forwarded`, `x-forwarded-*`, `sec-fetch-*`).
 * A blacklist forwarded them all to a host that the remote controls.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'range',
  'user-agent',
  'x-requested-with',
])

/** Conditional-request headers: `if-match`, `if-none-match`, `if-modified-since`, `if-range`, … */
const FORWARDED_REQUEST_PREFIX = 'if-'

/** The fields a WebSocket handshake needs, forwarded only on an upgrade. */
const UPGRADE_REQUEST_HEADERS = new Set([
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
])

/**
 * Response headers a remote page may not set on the local origin. `clear-site-data` would let a
 * compromised remote wipe this GUI's own cookies and storage, `access-control-*` would open the
 * local origin to other sites, and `refresh` / `content-location` / `report-to` / `nel` /
 * `permissions-policy` / `alt-svc` redirect or reshape the browser's view of a server it does
 * not own.
 */
const BLOCKED_RESPONSE_HEADERS = new Set([
  'clear-site-data',
  'refresh',
  'content-location',
  'report-to',
  'nel',
  'permissions-policy',
  'alt-svc',
])

/** Every `access-control-*` response header belongs to the remote's origin, not this one. */
const BLOCKED_RESPONSE_PREFIX = 'access-control-'

/**
 * The loopback seat of one connected host's remote web: the tunnel's local port and the port the
 * remote's own listener uses. Nothing else about a tunnel belongs in this module.
 */
export interface ProxyTarget {
  localPort: number
  remotePort?: number | null
}

/**
 * The remote a rewritten header belongs to: the host id that addresses its seat and the loopback
 * origin the remote sees itself on. Both are optional because a caller without a seat (tests, a
 * diagnostics rewrite) still filters headers.
 */
export interface HeaderRewriteInput {
  hostId?: string
  remoteOrigin?: string
  /** True for the response to a WebSocket handshake (see `responseHeaders`). */
  preserveUpgrade?: boolean
}

/** The two fields a `Location` rewrite needs; the handshake flag does not change it. */
export type LocationInput = Pick<HeaderRewriteInput, 'hostId' | 'remoteOrigin'>

/** Everything one forwarded request needs: its upstream seat, the local origin and this host's jar. */
export interface UpstreamHeadersInput {
  target: ProxyTarget
  localOrigin: string
  path: string
  jar: CookieJar
  /** True for a WebSocket handshake: its own handshake headers are forwarded as well. */
  preserveUpgrade?: boolean
}

/**
 * Whether one browser request header may reach the remote.
 * @param name - lowercase header name.
 * @param preserveUpgrade - whether this is a WebSocket handshake.
 */
export function forwardableRequestHeader(name: string, preserveUpgrade = false): boolean {
  if (FORWARDED_REQUEST_HEADERS.has(name)) return true
  if (name.startsWith(FORWARDED_REQUEST_PREFIX)) return true
  return preserveUpgrade === true && UPGRADE_REQUEST_HEADERS.has(name)
}

/**
 * Whether one upstream response header may reach the browser.
 * @param name - lowercase header name.
 */
export function forwardableResponseHeader(name: string): boolean {
  if (BLOCKED_RESPONSE_HEADERS.has(name)) return false
  if (name.startsWith(BLOCKED_RESPONSE_PREFIX)) return false
  return true
}

/** Absolute origin of the remote's own listener, as the remote sees itself through the tunnel. */
export function remoteOrigin(target: ProxyTarget): string {
  const port = Number(target.remotePort)
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : target.localPort}`
}

/** The remote's own `host:port`, as its `Host` header and its cookies are bound to it. */
export function remoteAuthority(target: ProxyTarget): string {
  return remoteOrigin(target).slice('http://'.length)
}

/** Rewrite an absolute URL from the local origin to the remote's origin, keeping its path. */
function rewriteSameOrigin(value: string, localOrigin: string, target: ProxyTarget): string {
  const local = typeof localOrigin === 'string' ? localOrigin.replace(/\/$/, '') : ''
  const text = String(value)
  if (local !== '' && (text === local || text.startsWith(`${local}/`))) {
    return remoteOrigin(target) + text.slice(local.length)
  }
  return text
}

/**
 * Request headers for the upstream: only the allowlisted content headers are copied, the two
 * authority fields are rewritten, and only this host's own cookies are added.
 * @param rawHeaders - node raw header list.
 */
export function upstreamHeaders(rawHeaders: string[], input: UpstreamHeadersInput): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const preserveUpgrade = input.preserveUpgrade === true
  for (let at = 0; at < rawHeaders.length; at += 2) {
    const name = String(rawHeaders[at]).toLowerCase()
    const value = rawHeaders[at + 1]
    if (name === 'host' || name === 'cookie') continue
    if (name === 'origin') {
      out.origin = remoteOrigin(input.target)
      continue
    }
    if (name === 'referer') {
      out.referer = rewriteSameOrigin(value, input.localOrigin, input.target)
      continue
    }
    if (!forwardableRequestHeader(name, preserveUpgrade)) continue
    out[name] = out[name] === undefined ? value : [].concat(out[name], value)
  }
  out.host = remoteAuthority(input.target)
  const cookies = cookieHeader(input.jar, input.path)
  if (cookies !== '') out.cookie = cookies
  return out
}

/**
 * Drop only the `frame-ancestors` directive of a CSP: the proxy exists to frame that one page,
 * and a hostile-looking directive would otherwise make a hardened remote unusable in a browser.
 * Every other directive stays exactly as the remote sent it.
 * @param value - one Content-Security-Policy value.
 */
export function withoutFrameAncestors(value: string): string {
  return String(value)
    .split(';')
    .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '')
    .join('; ')
}

/**
 * Rewrite one upstream `Location` for the browser.
 *
 * A redirect that names the remote's own loopback listener is folded back under the view
 * prefix, so a form post or a token exchange stays inside the frame. Everything else that is an
 * absolute URL — another host, another scheme, a protocol-relative `//evil.example`, or a
 * different loopback port — is refused (`null`): the header is dropped, because navigation
 * inside this same-origin frame must never leave the seat the user opened. A relative
 * reference (`.`, `./next`, `/assets/app.js`) is already resolved against that seat, so it is
 * passed through untouched.
 * @param value - one upstream Location header value.
 * @returns the header value to send, or null to drop the header.
 */
export function safeLocation(value: string, input: LocationInput = {}): string | null {
  const text = String(value ?? '')
    .replace(/[\r\n]/g, '')
    .trim()
  if (text === '') return null
  if (input.hostId && input.remoteOrigin) {
    if (text === input.remoteOrigin) return `${REMOTE_VIEW_PREFIX}${input.hostId}/`
    if (text.startsWith(`${input.remoteOrigin}/`)) {
      return `${REMOTE_VIEW_PREFIX}${input.hostId}${text.slice(input.remoteOrigin.length)}`
    }
    if (text.startsWith(`${input.remoteOrigin}?`) || text.startsWith(`${input.remoteOrigin}#`)) {
      return `${REMOTE_VIEW_PREFIX}${input.hostId}/${text.slice(input.remoteOrigin.length)}`
    }
  }
  // Any scheme (`https:`, `javascript:`, `data:`…) is an absolute target.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null
  // A backslash is a slash to the URL parser for special schemes: `/\evil.example/x` and
  // `\/evil.example` both resolve to `http://evil.example/`, so a surviving backslash in what
  // looks like a relative reference is an off-origin escape. (`%5c` stays percent-encoded and is
  // not a separator, so it is not caught here.)
  if (text.includes('\\')) return null
  // `//host/…`: a browser reads it as protocol-relative, i.e. off-origin.
  if (text.startsWith('//')) return null
  return text
}

/**
 * Response headers to hand the browser: drop hop-by-hop fields, this connection's framing, the
 * remote's cookies (they go to the jar), any frame denial the remote inherited from another
 * deployment, and browser-policy headers the remote must not set on the local origin. A
 * `Location` that names the remote's own listener is folded back under the view prefix; any
 * other absolute target is dropped so a redirect cannot slip out of the frame.
 * @param rawHeaders - upstream raw header list.
 * @returns flat [name, value, …] pairs.
 */
export function responseHeaders(rawHeaders: string[], input: HeaderRewriteInput = {}): string[] {
  const out: string[] = []
  const preserveUpgrade = input.preserveUpgrade === true
  for (let at = 0; at < rawHeaders.length; at += 2) {
    const name = String(rawHeaders[at]).toLowerCase()
    // `Connection`/`Upgrade` are hop-by-hop, except in the response to a WebSocket handshake:
    // dropping them there would turn a valid 101 into a protocol error.
    if (HOP_BY_HOP.has(name) && !(preserveUpgrade && (name === 'connection' || name === 'upgrade'))) continue
    if (name === 'set-cookie' || name === 'x-frame-options') continue
    if (!forwardableResponseHeader(name)) continue
    if (name === 'content-security-policy') {
      out.push(rawHeaders[at], withoutFrameAncestors(String(rawHeaders[at + 1])))
      continue
    }
    if (name === 'location') {
      const location = safeLocation(rawHeaders[at + 1], input)
      if (location === null) continue
      out.push(rawHeaders[at], location)
      continue
    }
    out.push(rawHeaders[at], rawHeaders[at + 1])
  }
  return out
}

/**
 * Rewrite one raw upstream response head (status line + headers, without the final blank line).
 *
 * The upgrade path forwards a 101 byte-for-byte if left alone, which also forwarded
 * `Set-Cookie` and every browser-policy header the remote chose to attach to the handshake. The
 * same policy as `responseHeaders` applies here; only the status line and the header block are
 * touched, never the frames that follow.
 * @param headText - latin1-decoded head, `HTTP/1.1 101 …\r\nkey: value…`.
 * @returns the filtered head (without the trailing blank line), or '' when unparseable.
 */
export function filterResponseHead(headText: string, input: HeaderRewriteInput = {}): string {
  const lines = String(headText ?? '').split('\r\n')
  const statusLine = lines.shift() ?? ''
  if (!/^HTTP\/1\.[01] \d{3}(?: .*)?$/.test(statusLine)) return ''
  const raw: string[] = []
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    raw.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  const filtered = responseHeaders(raw, { ...input, preserveUpgrade: true })
  let out = `${statusLine}\r\n`
  for (let at = 0; at < filtered.length; at += 2) out += `${filtered[at]}: ${filtered[at + 1]}\r\n`
  return out
}

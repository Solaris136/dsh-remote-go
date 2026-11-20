/** Header rewriting for the same-origin proxy: an allowlist out, a blocklist back, and `Host`/`Origin` rewritten to the
 * remote's own loopback authority, so its authority-bound cookie and same-origin fence keep working while the browser's
 * local credentials and this hop's traffic-shaping headers stay here. */
import { REMOTE_VIEW_PREFIX } from '../constants.js'
import { cookieHeader } from './cookies.js'
import type { CookieJar } from './cookies.js'

/** One set of lowercase header names, written space-separated so a list stays visible at a glance. */
const headerSet = (names: string): Set<string> => new Set(names.split(' '))
/** Headers that describe one hop and must not be copied to the other connection. */
const HOP_BY_HOP = headerSet(
  'connection keep-alive proxy-authenticate proxy-authorization te trailer transfer-encoding upgrade',
)

const FORWARDED_REQUEST_HEADERS = headerSet(
  'accept accept-encoding accept-language cache-control content-length content-type range user-agent x-requested-with',
)

/** Conditional-request headers: `if-match`, `if-none-match`, `if-modified-since`, `if-range`, … */
const FORWARDED_REQUEST_PREFIX = 'if-'
/** The fields a WebSocket handshake needs, forwarded only on an upgrade. */
const UPGRADE_REQUEST_HEADERS = headerSet(
  'connection upgrade sec-websocket-key sec-websocket-version sec-websocket-protocol sec-websocket-extensions',
)

// The request side is an allowlist on purpose: a blocklist forwarded the browser's local credentials (`authorization`,
// `cookie`, `x-dsh-*`) and this hop's `forwarded`/`sec-fetch-*` headers to a host the remote controls. The response
// side blocks what would let a remote reshape this origin (`clear-site-data`, `access-control-*`).
const BLOCKED_RESPONSE_HEADERS = headerSet(
  'clear-site-data refresh content-location report-to nel permissions-policy alt-svc',
)

/** Every `access-control-*` response header belongs to the remote's origin, not this one. */
const BLOCKED_RESPONSE_PREFIX = 'access-control-'

/** The loopback seat of one connected host's remote web: the tunnel's local port and the remote listener's port; a
 * tunnel is nothing else to this module. */
export interface ProxyTarget {
  localPort: number
  remotePort?: number | null
}

/** The remote a header belongs to: host id + loopback origin, both optional so a seatless caller still filters. */
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

export function forwardableRequestHeader(name: string, preserveUpgrade = false): boolean {
  if (FORWARDED_REQUEST_HEADERS.has(name)) return true
  if (name.startsWith(FORWARDED_REQUEST_PREFIX)) return true
  return preserveUpgrade === true && UPGRADE_REQUEST_HEADERS.has(name)
}

export function forwardableResponseHeader(name: string): boolean {
  if (BLOCKED_RESPONSE_HEADERS.has(name)) return false
  return !name.startsWith(BLOCKED_RESPONSE_PREFIX)
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
  const local = (typeof localOrigin === 'string' ? localOrigin : '').replace(/\/$/, '')
  const text = String(value)
  if (local !== '' && (text === local || text.startsWith(`${local}/`))) {
    return remoteOrigin(target) + text.slice(local.length)
  }
  return text
}

/** Request headers for the upstream: allowlisted content headers, rewritten `Host`/`Origin`/`Referer`, this host's
 * cookies — nothing else. */
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

/** Drop only the `frame-ancestors` CSP directive — the proxy frames that one page, so a hardened remote stays usable;
 * every other directive goes out as sent. */
export function withoutFrameAncestors(value: string): string {
  return String(value)
    .split(';')
    .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '')
    .join('; ')
}

/** Rewrite one upstream `Location` for the browser: one naming the remote's loopback listener folds back under the view
 * prefix (a form post or token exchange stays in-frame); any other absolute target — host, scheme, `//evil.example`,
 * another loopback port — is refused (`null` drops it), since this frame must never leave the seat the user opened. */
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
  // A backslash is a slash for special schemes (`/\evil.example` resolves to http://evil.example/): off-origin.
  if (text.includes('\\')) return null
  // `//host/…`: a browser reads it as protocol-relative, i.e. off-origin.
  if (text.startsWith('//')) return null
  return text
}

/** Response headers for the browser: drop hop-by-hop fields, this connection's framing, the remote's cookies (to the
 * jar), inherited frame denials and browser-policy headers; `Location` is rewritten as `safeLocation` describes. */
export function responseHeaders(rawHeaders: string[], input: HeaderRewriteInput = {}): string[] {
  const out: string[] = []
  const preserveUpgrade = input.preserveUpgrade === true
  for (let at = 0; at < rawHeaders.length; at += 2) {
    const name = String(rawHeaders[at]).toLowerCase()
    // `Connection`/`Upgrade` are hop-by-hop, except in the response to a WebSocket handshake: dropping them there
    // would turn a valid 101 into a protocol error.
    if (HOP_BY_HOP.has(name) && !(preserveUpgrade && (name === 'connection' || name === 'upgrade'))) continue
    if (name === 'set-cookie' || name === 'x-frame-options') continue
    if (!forwardableResponseHeader(name)) continue
    if (name === 'content-security-policy') {
      out.push(rawHeaders[at], withoutFrameAncestors(String(rawHeaders[at + 1])))
      continue
    }
    if (name === 'location') {
      const location = safeLocation(rawHeaders[at + 1], input)
      if (location !== null) out.push(rawHeaders[at], location)
      continue
    }
    out.push(rawHeaders[at], rawHeaders[at + 1])
  }
  return out
}

/** Rewrite one raw upstream response head (status line + headers, without the final blank line). The upgrade path would
 * otherwise forward a 101 byte-for-byte, `Set-Cookie` and browser policy included; frames are never touched. */
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

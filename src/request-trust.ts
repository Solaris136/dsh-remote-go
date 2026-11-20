/** The browser-trust fence shared by the local HTTP API and the same-origin remote proxy: did this request arrive from
 * the origin it names? Two confused-deputy paths reach a loopback web server — DNS rebinding and a cross-site page —
 * and a browser labels neither reliably, so `Host` (the one header rebinding cannot forge) is checked on every request,
 * and `Origin`/`sec-fetch-site` must agree when attached. */

/** The part of an `IncomingMessage` the fence reads. */
export interface TrustedRequestInput {
  headers: Record<string, string | string[] | undefined>
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** The port a URL actually names, counting an omitted default port. */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

// Hostname/port match for a `Host` header (no scheme); loopback spellings are interchangeable
// because a browser may dial either one.
export function sameServerHost(value: unknown, origin: URL): boolean {
  if (typeof value !== 'string' || value === '') return false
  let candidate: URL
  try {
    candidate = new URL(`${origin.protocol}//${value}`)
  } catch {
    return false
  }
  // WHATWG parsing rewrites anything that is not a bare authority: `user@host` drops its userinfo, a backslash becomes
  // a path separator, `#`/`?` start the fragment/query, a trailing dot and a zero-padded port are normalized away. A
  // browser fills `Host` from the serialized URL, so a rewritten value is not an authority this server answers to —
  // comparing the rewritten hostname would let `attacker.example@127.0.0.1:port` pass as loopback.
  if (candidate.host !== value.toLowerCase()) return false
  if (effectivePort(candidate) !== effectivePort(origin)) return false
  if (candidate.hostname === origin.hostname) return true
  return LOOPBACK_HOSTNAMES.has(origin.hostname) && LOOPBACK_HOSTNAMES.has(candidate.hostname)
}

// Full same-origin match for an `Origin` header (scheme included). The authority is compared verbatim
// as well as through `sameServerHost`, for the rewrite reason above: otherwise
// `http://attacker.example@127.0.0.1:port` would pass as loopback.
export function sameServerOrigin(value: unknown, origin: URL): boolean {
  if (typeof value !== 'string' || value === '') return false
  // One trailing slash is tolerated (`Origin: http://host/` is not what a browser sends, but a
  // hand-written caller may); no regex on this string, it is attacker-controlled.
  const text = value.endsWith('/') ? value.slice(0, -1) : value
  let candidate: URL
  try {
    candidate = new URL(text)
  } catch {
    return false
  }
  // Drop the scheme without a regex: `scheme://rest` is the only shape left after URL parsing.
  const schemeEnd = text.indexOf('://')
  const authority = schemeEnd === -1 ? '' : text.slice(schemeEnd + 3)
  if (authority.toLowerCase() !== candidate.host) return false
  return candidate.protocol === origin.protocol && sameServerHost(candidate.host, origin)
}

// The fence applied to a browser navigation and its subresources: the request must name this server,
// and any browser-announced relationship must be same-origin.
export function trustedRequest(req: TrustedRequestInput, origin: URL): boolean {
  if (!sameServerHost(req.headers.host, origin)) return false
  const originHeader = req.headers.origin
  if (typeof originHeader === 'string' && originHeader !== '' && !sameServerOrigin(originHeader, origin)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

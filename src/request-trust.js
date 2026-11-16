/**
 * The browser-trust fence shared by the local HTTP API and the same-origin remote proxy.
 *
 * Both surfaces answer on the local DSH origin, so both must give the same answer to one question:
 * did this request arrive from the origin it names? Two confused-deputy paths reach a loopback web
 * server — DNS rebinding and a cross-site page — and a browser labels neither reliably: a rebound
 * page sends its own hostname as `Host` while the socket lands on this server, and a plain
 * navigation or image read carries no `Origin` and no Fetch-Metadata. `Host` is the one header
 * rebinding cannot forge, so it is checked for every request; when a browser does attach `Origin`
 * or `sec-fetch-site`, they must agree too.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** The port a URL actually names, counting an omitted default port. */
function effectivePort(url) {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * Hostname/port match for a `Host` header (which carries no scheme). The suffix is the local
 * listener's origin; loopback spellings are interchangeable because a browser may dial either one.
 * @param {string | undefined} value - verbatim `Host` header.
 * @param {URL} origin - this listener's own origin.
 * @returns {boolean}
 */
export function sameServerHost(value, origin) {
  if (typeof value !== 'string' || value === '') return false
  let candidate
  try {
    candidate = new URL(`${origin.protocol}//${value}`)
  } catch {
    return false
  }
  if (effectivePort(candidate) !== effectivePort(origin)) return false
  if (candidate.hostname === origin.hostname) return true
  return LOOPBACK_HOSTNAMES.has(origin.hostname) && LOOPBACK_HOSTNAMES.has(candidate.hostname)
}

/**
 * Full same-origin match for an `Origin` header (scheme included).
 * @param {string | undefined} value - verbatim `Origin` header.
 * @param {URL} origin - this listener's own origin.
 * @returns {boolean}
 */
export function sameServerOrigin(value, origin) {
  if (typeof value !== 'string' || value === '') return false
  let candidate
  try {
    candidate = new URL(value)
  } catch {
    return false
  }
  return candidate.protocol === origin.protocol && sameServerHost(candidate.host, origin)
}

/**
 * The fence applied to a browser navigation and its subresources: the request must name this
 * server, and any browser-announced relationship must be same-origin.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @param {URL} origin - this listener's own origin.
 * @returns {boolean}
 */
export function trustedRequest(req, origin) {
  if (!sameServerHost(req.headers.host, origin)) return false
  const originHeader = req.headers.origin
  if (typeof originHeader === 'string' && originHeader !== '' && !sameServerOrigin(originHeader, origin)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

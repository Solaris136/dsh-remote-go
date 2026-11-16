/**
 * Same-origin reverse proxy for a connected host's remote DSH web UI.
 *
 * The browser half shows the remote UI in a same-origin frame. This module makes that frame work
 * without handing the browser a second origin:
 *
 * - every request under `REMOTE_VIEW_PREFIX<hostId>/` is stripped of the prefix and forwarded to
 *   that host's loopback tunnel;
 * - the remote's session cookies stay in a per-host jar here, never in the local GUI's cookie jar
 *   (both GUIs answer on 127.0.0.1, so browser cookies are shared across ports);
 * - `Host`/`Origin` are rewritten to the remote's own loopback authority, so the remote's
 *   authority-bound cookie and same-origin fence keep working;
 * - the only WebSocket route a remote DSH owns (`/api/remote.mux`) gets one exact upgrade route
 *   per connected host, because the local web server matches upgrades by exact pathname.
 *
 * It proxies nothing but a host that is currently connected: an unknown or disconnected host id
 * is a 404, and the same-origin fence rejects cross-site requests, matching the local API.
 */
import http from 'node:http'
import net from 'node:net'
import { REMOTE_VIEW_PREFIX } from './constants.js'

/** How long the remote web UI's own stream route is (the only upgrade a DSH web serves). */
const REMOTE_STREAM_PATH = '/api/remote.mux'

const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

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
 * Split `/dsh-remote-go/remote/<hostId>/<rest>` into its host and the upstream path.
 * Returns null for anything that is not one well-formed view path (encoded slashes included).
 * @param {string} pathname - URL pathname.
 * @returns {{ hostId: string, path: string } | null}
 */
export function parseViewPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(REMOTE_VIEW_PREFIX)) return null
  const rest = pathname.slice(REMOTE_VIEW_PREFIX.length)
  const slash = rest.indexOf('/')
  const rawId = slash === -1 ? rest : rest.slice(0, slash)
  let hostId
  try {
    hostId = decodeURIComponent(rawId)
  } catch {
    return null
  }
  if (!HOST_ID_PATTERN.test(hostId)) return null
  // The seat is always `<prefix><hostId>/`: the bare id is not a page.
  if (slash === -1) return null
  const upstream = rest.slice(slash)
  return { hostId, path: upstream === '' ? '/' : upstream }
}

/** Exact pathname the remote's stream upgrade arrives on. */
export function upgradePath(hostId) {
  return `${REMOTE_VIEW_PREFIX}${hostId}${REMOTE_STREAM_PATH}`
}

/**
 * Parse one `Set-Cookie` line into the jar entry it should replace.
 * Only the attributes that decide whether and where the value is sent are kept.
 * @param {string} line - one Set-Cookie header value.
 * @returns {{ name: string, value: string, path: string, expiresAt: number } | null}
 */
export function parseSetCookie(line) {
  const [pair, ...attributes] = String(line ?? '').split(';')
  const equals = pair.indexOf('=')
  if (equals <= 0) return null
  const name = pair.slice(0, equals).trim()
  const value = pair.slice(equals + 1).trim()
  if (name === '') return null
  let cookiePath = '/'
  let expiresAt = Number.POSITIVE_INFINITY
  for (const attribute of attributes) {
    const at = attribute.indexOf('=')
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
    const raw = at === -1 ? '' : attribute.slice(at + 1).trim()
    if (key === 'path' && raw.startsWith('/')) cookiePath = raw
    if (key === 'max-age') {
      const seconds = Number(raw)
      if (Number.isFinite(seconds)) expiresAt = seconds <= 0 ? 0 : Date.now() + seconds * 1000
    }
    if (key === 'expires' && expiresAt === Number.POSITIVE_INFINITY) {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) expiresAt = parsed
    }
  }
  return { name, value, path: cookiePath, expiresAt }
}

/** One host's cookies, keyed by name; values never leave this process. */
function createCookieJar() {
  return new Map()
}

/**
 * Store every non-expired cookie from one response and drop the ones it cleared.
 * @param {Map<string, { value: string, path: string, expiresAt: number }>} jar - host jar.
 * @param {string | string[] | undefined} setCookie - raw Set-Cookie value(s).
 */
export function storeCookies(jar, setCookie) {
  if (setCookie === undefined) return
  for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const entry = parseSetCookie(line)
    if (entry === null) continue
    if (entry.value === '' || entry.expiresAt <= Date.now()) jar.delete(entry.name)
    else jar.set(entry.name, entry)
  }
}

/**
 * Cookies whose path covers the upstream path, as one Cookie header value.
 * @param {Map<string, { value: string, path: string, expiresAt: number }>} jar - host jar.
 * @param {string} path - upstream request path.
 * @returns {string}
 */
export function cookieHeader(jar, path) {
  const now = Date.now()
  const parts = []
  for (const [name, entry] of jar) {
    if (entry.expiresAt <= now) {
      jar.delete(name)
      continue
    }
    const covers =
      entry.path === '/' ||
      path === entry.path ||
      path.startsWith(`${entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path}/`)
    if (covers) parts.push(`${name}=${entry.value}`)
  }
  return parts.join('; ')
}

/** Absolute origin of the remote's own listener, as the remote sees itself through the tunnel. */
function remoteOrigin(target) {
  const port = Number(target.remotePort)
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : target.localPort}`
}

function remoteAuthority(target) {
  return remoteOrigin(target).slice('http://'.length)
}

/** Rewrite an absolute URL from the local origin to the remote's origin, keeping its path. */
function rewriteSameOrigin(value, localOrigin, target) {
  const local = typeof localOrigin === 'string' ? localOrigin.replace(/\/$/, '') : ''
  const text = String(value)
  if (local !== '' && (text === local || text.startsWith(`${local}/`))) {
    return remoteOrigin(target) + text.slice(local.length)
  }
  return text
}

/**
 * Request headers for the upstream: hop-by-hop and browser-authority fields are replaced, and
 * only this host's own cookies are added. Everything else (accept, content-type, range…) is kept.
 * @param {string[]} rawHeaders - node raw header list.
 * @param {{ target: object, localOrigin: string, path: string, jar: Map }} input
 * @returns {Record<string, string | string[]>}
 */
export function upstreamHeaders(rawHeaders, input) {
  const out = {}
  for (let at = 0; at < rawHeaders.length; at += 2) {
    const name = String(rawHeaders[at]).toLowerCase()
    const value = rawHeaders[at + 1]
    // A WebSocket handshake is exactly the two hop-by-hop fields an ordinary request drops.
    const upgradeField = name === 'connection' || name === 'upgrade'
    if (HOP_BY_HOP.has(name) && !(input.preserveUpgrade === true && upgradeField)) continue
    if (name === 'host' || name === 'cookie') continue
    if (name === 'origin') {
      out.origin = remoteOrigin(input.target)
      continue
    }
    if (name === 'referer') {
      out.referer = rewriteSameOrigin(value, input.localOrigin, input.target)
      continue
    }
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
 * @param {string} value - one Content-Security-Policy value.
 * @returns {string}
 */
export function withoutFrameAncestors(value) {
  return String(value)
    .split(';')
    .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '')
    .join('; ')
}

/**
 * Response headers to hand the browser: drop hop-by-hop fields, this connection's framing, the
 * remote's cookies (they go to the jar), and any frame denial the remote inherited from another
 * deployment — this proxy exists to frame that one page. A `Location` that names the remote's own
 * listener is folded back under the view prefix so a redirect cannot slip out of the frame.
 * @param {string[]} rawHeaders - upstream raw header list.
 * @param {{ hostId?: string, remoteOrigin?: string }} [input]
 * @returns {string[]} flat [name, value, …] pairs.
 */
export function responseHeaders(rawHeaders, input = {}) {
  const out = []
  for (let at = 0; at < rawHeaders.length; at += 2) {
    const name = String(rawHeaders[at]).toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'set-cookie' || name === 'x-frame-options') continue
    if (name === 'content-security-policy') {
      out.push(rawHeaders[at], withoutFrameAncestors(String(rawHeaders[at + 1])))
      continue
    }
    if (name === 'location' && input.hostId && input.remoteOrigin) {
      const value = String(rawHeaders[at + 1])
      if (value.startsWith(`${input.remoteOrigin}/`)) {
        out.push(rawHeaders[at], `${REMOTE_VIEW_PREFIX}${input.hostId}${value.slice(input.remoteOrigin.length)}`)
        continue
      }
      if (value === input.remoteOrigin) {
        out.push(rawHeaders[at], `${REMOTE_VIEW_PREFIX}${input.hostId}/`)
        continue
      }
    }
    out.push(rawHeaders[at], rawHeaders[at + 1])
  }
  return out
}

/** The port a URL actually names, counting an omitted default port. */
function effectivePort(url) {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/** Hostname/port match for a `Host` header (which carries no scheme). */
function sameServerHost(value, origin) {
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

/** Full same-origin match for an `Origin` header (scheme included). */
function sameServerOrigin(value, origin) {
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
 * The same-origin fence the local API uses, applied to a browser navigation and its subresources:
 * the request must name this server and must not be announced as cross-site.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @param {URL} origin
 * @returns {boolean}
 */
export function trustedRequest(req, origin) {
  if (!sameServerHost(req.headers.host, origin)) return false
  const originHeader = req.headers.origin
  if (typeof originHeader === 'string' && originHeader !== '' && !sameServerOrigin(originHeader, origin)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

function plain(res, status, text) {
  const body = String(text)
  try {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    // swallow-ok: the client may already have closed the response
  }
}

/**
 * Create the proxy. `resolveHost` is the single pivot: it returns the loopback target for one
 * connected host (`{ localPort, remotePort }`) or null. Nothing else in this module knows how a
 * tunnel was made.
 * @param {object} options
 * @param {object} options.webServer - local DSH web server (register/registerUpgrade/getOrigin).
 * @param {() => string | null} options.getOrigin - local origin, read per request.
 * @param {(hostId: string) => ({ localPort: number, remotePort: number } | null)} options.resolveHost
 * @param {{ warn?: Function, debug?: Function, error?: Function }} [options.logger]
 */
export function createRemoteProxy(options) {
  const logger = options.logger ?? console
  const webServer = options.webServer
  const getOrigin = options.getOrigin
  const resolveHost = options.resolveHost
  const jars = new Map()
  const upgrades = new Map()
  const sockets = new Set()
  let disposed = false

  function jarOf(hostId) {
    let jar = jars.get(hostId)
    if (jar === undefined) {
      jar = createCookieJar()
      jars.set(hostId, jar)
    }
    return jar
  }

  function localOrigin() {
    try {
      const origin = getOrigin()
      return typeof origin === 'string' && origin !== '' ? new URL(origin) : null
    } catch {
      return null
    }
  }

  function targetOf(hostId) {
    try {
      const target = resolveHost(hostId)
      return target && Number.isInteger(Number(target.localPort)) && Number(target.localPort) > 0 ? target : null
    } catch {
      return null
    }
  }

  function handle(req, res) {
    if (disposed) {
      plain(res, 503, 'proxy disposed')
      return
    }
    const origin = localOrigin()
    if (origin === null) {
      plain(res, 503, 'local origin is not ready')
      return
    }
    if (!trustedRequest(req, origin)) {
      plain(res, 403, 'cross-site request rejected')
      return
    }
    let pathname
    let search
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      pathname = url.pathname
      search = url.search
    } catch {
      plain(res, 400, 'bad request path')
      return
    }
    const parsed = parseViewPath(pathname)
    if (parsed === null) {
      plain(res, 404, 'unknown remote view')
      return
    }
    const target = targetOf(parsed.hostId)
    if (target === null) {
      plain(res, 404, 'host is not connected')
      return
    }
    const jar = jarOf(parsed.hostId)
    const upstreamPath = parsed.path + search
    const headers = upstreamHeaders(req.rawHeaders, {
      target,
      localOrigin: origin.origin,
      path: parsed.path,
      jar,
    })
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: target.localPort,
        path: upstreamPath,
        method: req.method,
        headers,
      },
      (response) => {
        storeCookies(jar, response.headers['set-cookie'])
        try {
          res.writeHead(
            response.statusCode ?? 502,
            responseHeaders(response.rawHeaders, {
              hostId: parsed.hostId,
              remoteOrigin: remoteOrigin(target),
            }),
          )
        } catch {
          response.destroy()
          return
        }
        // A browser that leaves the page mid-load must not keep the tunneled response alive.
        res.once('close', () => response.destroy())
        response.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      // The host id in this message came from the request path; a raw path fragment in a log line
      // is a log-injection sink, so the line names the loopback upstream instead (that port is what
      // identifies the host to an operator).
      logger.debug?.(
        `[dsh-remote-go] remote proxy upstream 127.0.0.1:${target.localPort} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      plain(res, 502, 'remote UI is unreachable')
    })
    req.once('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }

  /** One exact upgrade route per host: the only WebSocket a DSH web serves is its stream mux. */
  function handleUpgrade(hostId, req, socket, head) {
    if (disposed) {
      socket.destroy()
      return
    }
    const origin = localOrigin()
    if (origin === null || !trustedRequest(req, origin)) {
      socket.destroy()
      return
    }
    const target = targetOf(hostId)
    if (target === null) {
      socket.destroy()
      return
    }
    // A malformed request target (absolute-form, broken escape) must not throw out of the upgrade
    // handler: the HTTP path already degrades to a 400, this one just drops the socket.
    let parsed = null
    try {
      parsed = parseViewPath(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      parsed = null
    }
    if (parsed === null) {
      socket.destroy()
      return
    }
    const jar = jarOf(hostId)
    const headers = upstreamHeaders(req.rawHeaders, {
      target,
      localOrigin: origin.origin,
      path: parsed.path,
      jar,
      preserveUpgrade: true,
    })
    let raw = `${req.method} ${parsed.path} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) raw += `${name}: ${item}\r\n`
    }
    raw += '\r\n'
    const upstream = net.connect(target.localPort, '127.0.0.1')
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      upstream.destroy()
    })
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    upstream.once('connect', () => {
      upstream.write(raw)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  }

  /**
   * Keep one upgrade route per configured host. Called on init and on every state change; a host
   * that disappears loses its route and its cookies.
   * @param {string[]} hostIds
   */
  function sync(hostIds) {
    if (disposed) return
    const wanted = new Set((Array.isArray(hostIds) ? hostIds : []).filter((id) => HOST_ID_PATTERN.test(String(id))))
    for (const [hostId, dispose] of upgrades) {
      if (wanted.has(hostId)) continue
      dispose()
      upgrades.delete(hostId)
      jars.delete(hostId)
    }
    for (const hostId of wanted) {
      if (upgrades.has(hostId)) continue
      try {
        upgrades.set(
          hostId,
          webServer.registerUpgrade({
            path: upgradePath(hostId),
            handler: (req, socket, head) => handleUpgrade(hostId, req, socket, head),
          }),
        )
      } catch (error) {
        logger.warn?.(
          `[dsh-remote-go] could not register the stream route for ${hostId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  return {
    prefix: REMOTE_VIEW_PREFIX,
    /**
     * The route registration path. The web server matches a prefix as `pathname === prefix ||
     * pathname.startsWith(prefix + '/')`, so registering the trailing-slash seat prefix verbatim
     * would never match a real view URL.
     */
    routePath: REMOTE_VIEW_PREFIX.replace(/\/$/, ''),
    handle,
    handleUpgrade,
    sync,
    /** One host's current cookie header, for diagnostics and tests. */
    cookies(hostId) {
      const jar = jars.get(hostId)
      return jar === undefined ? '' : cookieHeader(jar, '/')
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of upgrades.values()) dispose()
      upgrades.clear()
      jars.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

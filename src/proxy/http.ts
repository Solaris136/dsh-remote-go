/**
 * The HTTP half of the same-origin proxy: admission, the local same-origin fence, view-path
 * resolution, the upstream forward with its 30 s deadline, and the seven plain-text refusals.
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Admission } from '../admission.js'
import { trustedRequest } from '../request-trust.js'
import { storeCookies } from './cookies.js'
import type { CookieJar } from './cookies.js'
import { remoteOrigin, responseHeaders, upstreamHeaders } from './headers.js'
import type { ProxyTarget } from './headers.js'
import { parseViewPath } from './routes.js'

/** The Host-process logger this proxy reports through; every method is optional. */
export interface ProxyLogger {
  warn?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/**
 * Everything the two request handlers need from the assembly.
 *
 * Explicitly injected rather than captured from `createRemoteProxy`'s closure: the assembly owns
 * the jars, the routes and the teardown, while a handler only calls the handful of operations
 * below, so the split is a real module boundary and a test can drive one handler on its own.
 */
export interface ProxyRuntime {
  /** Whether the proxy was already torn down (`dispose`). */
  readonly disposed: () => boolean
  readonly logger: ProxyLogger
  /** DSH admission: the rejection status for a request, or undefined when it may proceed. */
  readonly admit: Admission
  /** The local origin, read per request (null before the web server knows it). */
  readonly localOrigin: () => URL | null
  /** The loopback target for one connected host, or null when it is not connected. */
  readonly targetOf: (hostId: string) => ProxyTarget | null
  /** This host's cookie jar, bound to the remote authority behind `target`. */
  readonly jarFor: (hostId: string, target: ProxyTarget) => CookieJar
  /** Called once per failed upstream so the Host can confirm a suspected remote restart. */
  readonly reportUpstreamFailure: (hostId: string) => void
  /** Milliseconds the remote may take to accept and answer. */
  readonly upstreamTimeoutMs: number
}

/** One status line and a short body: every refusal this proxy answers with. */
function plain(res: ServerResponse, status: number, text: string): void {
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
 * Create the HTTP handler of one proxy activation.
 *
 * Every request under the view prefix is stripped of the prefix and forwarded to that host's
 * loopback tunnel; a host that is not currently connected is a 404, and DSH's own admission plus
 * the local same-origin fence decide whether the caller may use the seat at all.
 */
export function createHttpHandler(rt: ProxyRuntime): (req: IncomingMessage, res: ServerResponse) => void {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    if (rt.disposed()) {
      plain(res, 503, 'proxy disposed')
      return
    }
    // DSH's own admission gate runs before anything this module decides: the proxy reaches a
    // connected host's remote session (its cookie jar), so only an admitted caller may use it.
    const rejection = rt.admit(req)
    if (rejection !== undefined) {
      plain(res, rejection, 'request rejected by DSH admission')
      return
    }
    const origin = rt.localOrigin()
    if (origin === null) {
      plain(res, 503, 'local origin is not ready')
      return
    }
    if (!trustedRequest(req, origin)) {
      plain(res, 403, 'cross-site request rejected')
      return
    }
    let pathname: string
    let search: string
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
    const target = rt.targetOf(parsed.hostId)
    if (target === null) {
      plain(res, 404, 'host is not connected')
      return
    }
    const jar = rt.jarFor(parsed.hostId, target)
    const upstreamPath = parsed.path + search
    const headers = upstreamHeaders(req.rawHeaders, {
      target,
      localOrigin: origin.origin,
      path: parsed.path,
      jar,
    })
    // The remote is reached over a tunnel; a listener that accepts and never answers used to
    // hang the local request forever. The deadline covers the wait for response headers only —
    // once the response started, an idle stream (SSE, a large asset) is legitimate.
    let answered = false
    let failed = false
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: target.localPort,
        path: upstreamPath,
        method: req.method,
        headers,
        timeout: rt.upstreamTimeoutMs,
      },
      (response: IncomingMessage) => {
        answered = true
        upstream.setTimeout(0)
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
    /**
     * One failed upstream: report it once and answer 502 (or nothing, when the response has
     * already started). Nothing from the failure reaches the log line: the emitter is
     * request-driven, so CodeQL treats its error as user-controlled (log injection). The
     * loopback port names the host to an operator, and the browser only ever sees the 502.
     */
    const upstreamFailed = (): void => {
      if (failed) return
      failed = true
      rt.logger.debug?.(`[dsh-remote-go] remote proxy upstream 127.0.0.1:${target.localPort} failed`)
      plain(res, 502, 'remote UI is unreachable')
      rt.reportUpstreamFailure(parsed.hostId)
    }
    upstream.on('timeout', () => {
      if (answered) return
      answered = true
      upstream.destroy()
      upstreamFailed()
    })
    upstream.on('error', () => {
      // A failure after the response started is still worth reporting (the Host confirms it
      // with probes); `plain` is a no-op once the headers are out.
      upstreamFailed()
    })
    req.once('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }
}

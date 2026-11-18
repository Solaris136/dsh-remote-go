/**
 * Local HTTP API for the browser half (contract: docs/api.md); every request passes DSH's own
 * admission when the kernel provides it, then the marker header and, with an Origin, same-origin.
 *
 * This module is routing only: authentication, the JSON envelope and the status codes. The two
 * SSE channels live in `events.ts` (own subscriber sets, caps and replay).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_HEADER, API_PREFIX, API_VERSION, PLUGIN_VERSION } from './constants.js'
import { errors, isRemoteGoError, toErrorView } from './errors.js'
import type { ErrorView } from './errors.js'
import { createEventHub } from './events.js'
import type { EventHub } from './events.js'
import type { RawHostEntry } from './host-registry.js'
import { redactObject } from './redact.js'
import { sameServerHost, sameServerOrigin } from './request-trust.js'
import type { RemoteGoService } from './service.js'
import { nowIso } from './util.js'

const MAX_BODY_BYTES = 1 * 1024 * 1024

/** HTTP status for one `invalid-input` refusal: an oversized body is not a business conflict. */
const PAYLOAD_TOO_LARGE = 413

/** `/version` and `/diagnostics/self` share one version row. */
const VERSION_ROW = { version: PLUGIN_VERSION, apiVersion: API_VERSION }
const PLUGIN_ROW = { id: 'dsh-remote-go', version: PLUGIN_VERSION }

/** The logger this module reports through; both methods are optional (a test passes `{}`). */
interface ApiLogger {
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/**
 * One authorization verdict: `ok: true` lets the route proceed; a rejection also carries the status
 * the dispatcher answers with and its coded body. Not a discriminated union on purpose — the route
 * code reads `!verdict.ok` (the idiom `!` cannot narrow a literal discriminant here).
 */
interface AuthVerdict {
  ok: boolean
  status?: number
  error?: ErrorView
}

/** One JSON request body: a parsed document this module narrows field by field. */
type JsonBody = Record<string, unknown>

/** One route handler: the dispatcher owns auth, init and the status codes around it. */
type RouteHandler = (req?: IncomingMessage, url?: URL) => unknown | Promise<unknown>

/** One `/hosts/:id[/action]` handler: the id from the path, plus the request for a POST body. */
type HostAction = (id: string, req?: IncomingMessage) => unknown | Promise<unknown>

/** Everything `createApi` needs from its composition. */
export interface ApiOptions {
  service: RemoteGoService
  /** The listener origin as the kernel names it, or null while it cannot be named. */
  getOrigin?: () => string | null
  /** DSH's own admission for the route, when the kernel provides the Connection service. */
  admit?: (req: IncomingMessage) => number | undefined
  logger?: ApiLogger
  diagnostics?: () => Record<string, unknown>
}

/** What one mounted API exposes: the route handler and the listener cleanup. */
export interface Api {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  dispose: () => void
}

/**
 * The HTTP status one ErrorView maps to (docs/api.md). `internal` used to fall through to 409,
 * which made a plugin bug look like a state conflict; only the two explicit codes are special,
 * everything else is a business refusal of the current state.
 */
export function statusForErrorCode(code: string): number {
  if (code === 'invalid-input') return 400
  if (code === 'internal') return 500
  return 409
}

export function createApi(options: ApiOptions): Api {
  const { service } = options
  const logger = options.logger ?? console
  const kernelAdmit = typeof options.admit === 'function' ? options.admit : null
  // Both SSE channels: subscriber sets, caps, heartbeat, 150 ms coalescing and cursor replay.
  const hub: EventHub = createEventHub({ service, logger })

  const crossSite = (): AuthVerdict => ({
    ok: false,
    status: 403,
    error: toErrorView(
      errors.invalidInput('origin', { zh: '跨站请求被拒绝。', en: 'Cross-site requests are rejected.' }),
    ),
  })

  /** The listener origin as a URL, or null while the kernel cannot name it yet. */
  function parseOrigin(value: unknown): URL | null {
    if (typeof value !== 'string' || value === '') return null
    try {
      return new URL(value)
    } catch {
      return null
    }
  }

  /**
   * The kernel's own admission (`ctx.connection.requestRejection`): its Host/Origin fence plus
   * browser authentication against a live Peer — the gate every DSH route passes. Absent on a
   * kernel without the Connection service, where the marker-header fence below stays the fallback.
   * @returns rejection status, or undefined when the route may proceed.
   */
  function admission(req: IncomingMessage): number | undefined {
    if (kernelAdmit === null) return undefined
    const rejection = kernelAdmit(req)
    return typeof rejection === 'number' ? rejection : undefined
  }

  /** Response body for an admission rejection: the kernel decided, and this route never ran. */
  function admissionView(status: number): { ok: false; error: ErrorView } {
    // A gate that could not decide is this plugin's problem, not a client mistake.
    if (status === 500) {
      return { ok: false, error: toErrorView(errors.internal('the DSH connection admission check failed')) }
    }
    const detail =
      status === 401
        ? {
            zh: '这次请求没有通过 DSH 的浏览器会话认证（会话失效或未登录）。',
            en: 'The request did not pass DSH browser-session authentication (no session, or it expired).',
          }
        : {
            zh: '请求没有通过 DSH 的 Host / Origin 准入检查。',
            en: 'The request did not pass DSH Host / Origin admission.',
          }
    return { ok: false, error: toErrorView(errors.invalidInput('request', detail)) }
  }

  /**
   * Browser trust for same-origin reads (used by SSE, which cannot set custom
   * headers): an absent Origin is a non-browser local caller; a present Origin
   * must be this GUI's origin and the request must not be cross-site. The Host
   * fence is checked for both kinds of caller, because a DNS-rebinding page
   * reaches the socket under its own hostname: it sends no Origin, its
   * Fetch-Metadata says same-origin, and `Host` is the one header it cannot forge.
   *
   * The Origin comparison is the shared `sameServerOrigin`, not a string compare: the kernel
   * names its listener as `127.0.0.1:<port>`, while a user may open the GUI on
   * `http://localhost:<port>`, and `localhost` / `127.0.0.1` / `[::1]` are the same server.
   * The old equality check locked those users out of every write while `/state` still worked
   * without an Origin.
   */
  function authorizeOrigin(req: IncomingMessage): AuthVerdict {
    const local = parseOrigin(options.getOrigin())
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      if (local === null || !sameServerOrigin(origin, local)) return crossSite()
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return crossSite()
    // An origin the kernel cannot name yet is no reason to reject local traffic; the kernel's own
    // admission (when present) has already judged Host, and this fence is the fallback.
    if (local !== null && !sameServerHost(req.headers.host, local)) return crossSite()
    return { ok: true }
  }

  function authorize(req: IncomingMessage): AuthVerdict {
    const origin = authorizeOrigin(req)
    if (!origin.ok) return origin
    if (req.headers[API_HEADER] !== '1') {
      return {
        ok: false,
        status: 403,
        error: toErrorView(
          errors.invalidInput(API_HEADER, {
            zh: '请求缺少本地插件标识头。',
            en: 'The request is missing the local plugin header.',
          }),
        ),
      }
    }
    return { ok: true }
  }

  /** The 413 the API answers once a body crosses `MAX_BODY_BYTES`. */
  function payloadTooLarge() {
    const error = errors.invalidInput('body', {
      zh: `请求体超过上限（${MAX_BODY_BYTES} 字节）。`,
      en: `The request body exceeds the limit (${MAX_BODY_BYTES} bytes).`,
    })
    error.httpStatus = PAYLOAD_TOO_LARGE
    return error
  }

  function readJson(req: IncomingMessage): Promise<JsonBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let refused = false
      req.on('data', (chunk: Buffer) => {
        if (refused) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          // Answer 413 with a JSON body *before* the socket goes away. Destroying the request
          // here (the old behavior) made the client see ECONNRESET instead of the refusal, and
          // the rest of the body is drained rather than buffered so the response can flush.
          refused = true
          chunks.length = 0
          reject(payloadTooLarge())
          req.resume()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      req.on('end', () => {
        if (refused) return
        if (chunks.length === 0) {
          resolve({})
          return
        }
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          resolve(text === '' ? {} : JSON.parse(text))
        } catch {
          reject(
            errors.invalidInput('body', { zh: '请求体不是合法 JSON。', en: 'The request body is not valid JSON.' }),
          )
        }
      })
      req.on('error', reject)
    })
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * Which SSE channel a GET path names, or null. Both routes pass the same pre-condition: DSH's
   * admission (above) plus the Origin/Host fence, because an EventSource cannot set the marker
   * header. Keeping the pair in one place is what stops the two routes from drifting apart.
   */
  function sseRoute(path: string, method: string): 'state' | 'logs' | null {
    if (method !== 'GET') return null
    if (path === '/events') return 'state'
    if (path === '/events/logs') return 'logs'
    return null
  }

  // One entry per route: `(req, url) => response body`. The dispatcher owns auth,

  // init, status codes and the error envelope, so handlers only shape data.
  const ROUTES: Record<string, RouteHandler> = {
    // A liveness probe only: no state, no version, nothing worth reading without a session.
    'GET /health': () => ({ ok: true }),
    'GET /state': () => ({ ok: true, state: service.snapshot() }),
    'GET /version': () => ({ ok: true, ...VERSION_ROW, hostVersion: service.localVersion }),
    'GET /ssh/aliases': async () => ({ ok: true, ...(await service.discoverSshAliases()) }),
    'GET /keyfile/list': async (req, url) => ({
      ok: true,
      ...(await service.listKeyFiles(url.searchParams.get('path') ?? '')),
    }),
    // Machine paths (`home`, `stateDir`) and the client-module row are troubleshooting data,
    // not the user's business: redact them like any other diagnostic export.
    'GET /diagnostics/self': () =>
      redactObject({
        ok: true,
        plugin: PLUGIN_ROW,
        at: nowIso(),
        ...(typeof options.diagnostics === 'function' ? options.diagnostics() : {}),
      }),
    'POST /hosts': async (req) => {
      const body = await readJson(req)
      // The store's own sanitizer is the validator; the body is only restated as the document
      // shape it accepts (a JSON body can be anything, and this route never parses it further).
      return { ok: true, host: await service.saveHost((body.host ?? body) as RawHostEntry) }
    },
    'POST /settings': async (req) => {
      const body = await readJson(req)
      return { ok: true, settings: await service.saveSettings(body.patch ?? body) }
    },
    'POST /local-version': async (req) => {
      const { version } = await readJson(req)
      // The client only backfills a *missing* probe result; the service decides whether this
      // one may be adopted (unknown locally, and not below DSH's `engines.dsh` floor).
      return { ok: true, accepted: service.setLocalVersion(String(version ?? ''), 'client') }
    },
    'POST /active': async (req) => {
      const { id } = await readJson(req)
      service.setActiveHost(typeof id === 'string' ? id : null)
      return { ok: true }
    },
  }

  // `/hosts/:id` and `/hosts/:id/<action>`, keyed the same way.
  const HOST_ACTIONS: Record<string, HostAction> = {
    DELETE: async (id) => {
      await service.removeHost(id)
      return { ok: true }
    },
    'POST connect': async (id, req) => {
      const body = await readJson(req)
      const result = await service.connect(id, {
        password: typeof body.password === 'string' ? body.password : undefined,
        // Remembering is the default for a password that is actually supplied; the Client
        // sends false only when its "remember" box is unchecked.
        rememberPassword: body.rememberPassword !== false,
      })
      return { ok: true, ...result }
    },
    // Remember (or forget) the SSH password without connecting: the wizard's save action and
    // an explicit credential refresh. The value never enters hosts.json; `available:false`
    // means nothing can be persisted here.
    'POST password': async (id, req) => {
      const body = await readJson(req)
      const result = await service.saveHostPassword(id, {
        password: typeof body.password === 'string' ? body.password : undefined,
        clear: body.clear === true,
      })
      return { ok: true, ...result }
    },
    'POST conflict': async (id, req) => {
      const { action } = await readJson(req)
      return { ok: true, ...(await service.confirmConflict(id, { action })) }
    },
    'POST disconnect': async (id, req) => {
      const { stopRemote } = await readJson(req)
      await service.disconnect(id, { stopRemote: stopRemote === true })
      return { ok: true }
    },
    'POST reconnect': async (id) => {
      await service.reconnect(id)
      return { ok: true }
    },
    'POST restart': async (id) => ({ ok: true, ...(await service.restart(id)) }),
    'POST stop-remote': async (id) => ({ ok: true, ...(await service.stopRemote(id)) }),
    'POST fingerprint': async (id, req) => {
      const body = await readJson(req)
      await service.confirmFingerprint(id, {
        accept: body.accept === true,
        remember: body.remember === true,
        sha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
      })
      return { ok: true }
    },
    'POST diagnose': async (id) => ({ ok: true, report: await service.diagnose(id) }),
    'GET open': (id) => ({ ok: true, ...service.openInfo(id) }),
    'POST activate': (id) => {
      service.setActiveHost(id)
      return { ok: true }
    },
  }

  /** Resolve `/hosts/:id[/action]` to `{ id, run }`, or null for an unknown shape. */
  function hostHandler(hostPath: string, method: string): { id: string; run: HostAction } | null {
    const segments = hostPath.split('/').filter(Boolean)
    if (segments[0] !== 'hosts' || segments.length < 2) return null
    const key = segments[2] ? `${method} ${segments[2]}` : method
    if (!Object.hasOwn(HOST_ACTIONS, key)) return null
    let id: string
    try {
      id = decodeURIComponent(segments[1])
    } catch {
      // A malformed escape (`/hosts/%E0%A4%A/activate`) is a client mistake, not an internal
      // failure: answer 400 with a readable field error instead of leaking URIError as 500.
      throw errors.invalidInput('id', {
        zh: '主机 id 不是合法的 URL 编码。',
        en: 'The host id is not valid URL encoding.',
      })
    }
    return { id, run: HOST_ACTIONS[key] }
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(API_PREFIX)) {
        sendJson(res, 404, {
          ok: false,
          error: toErrorView(errors.invalidInput('path', { zh: '未知 API 路径。', en: 'Unknown API path.' })),
        })
        return
      }
      const path = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      // `/health` stays the documented unauthenticated liveness probe (it carries no state), and
      // still passes the Host/Origin fence below. Everything else passes DSH's own admission
      // first, so a rebound page or an unauthenticated local caller cannot read state or change it.
      const probe = path === '/health' && method === 'GET'
      if (!probe) {
        const rejection = admission(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, admissionView(rejection))
          return
        }
      }

      if (probe) {
        const trust = authorizeOrigin(req)
        if (!trust.ok) {
          sendJson(res, trust.status, { ok: false, error: trust.error })
          return
        }
        sendJson(res, 200, ROUTES['GET /health']())
        return
      }

      // SSE cannot carry the custom header. It already passed DSH's admission above; the fence
      // here covers kernels without the Connection service, and browsers block a cross-origin
      // EventSource anyway because these routes never send CORS headers. The state channel
      // (`/events`) and the connect-log channel (`/events/logs`) share this one pre-condition.
      const sse = sseRoute(path, method)
      if (sse !== null) {
        const originOnly = authorizeOrigin(req)
        if (!originOnly.ok) {
          sendJson(res, originOnly.status, { ok: false, error: originOnly.error })
          return
        }
        await service.init()
        if (sse === 'logs') hub.handleLogs(req, res)
        else hub.handleState(req, res)
        return
      }

      const auth = authorize(req)
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error: auth.error })
        return
      }

      await service.init()

      // Download jobs save through the Host directly; no binary response route is
      // needed, so these handlers only shape JSON.
      const segments = path.split('/').filter(Boolean)
      if (method === 'POST' && path === '/downloads') {
        const body = await readJson(req)
        // Both paths are opaque strings the job layer validates (`runtimeOf` refuses an unknown
        // id, the downloader refuses a bad path); the body is a JSON document, not a schema.
        const job = await service.startRemoteDownload(body.hostId as string, body.path, {
          destination: body.destination as string | undefined,
        })
        sendJson(res, 200, { ok: true, job })
        return
      }
      if (segments[0] === 'downloads' && segments.length >= 2 && segments.length <= 3) {
        let jobId = ''
        try {
          jobId = decodeURIComponent(segments[1])
        } catch {
          throw errors.invalidInput('id', {
            zh: '下载任务 id 不是合法的 URL 编码。',
            en: 'The download job id is not valid URL encoding.',
          })
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'status') {
          sendJson(res, 200, { ok: true, job: await service.remoteDownloadStatus(jobId) })
          return
        }
        if (method === 'DELETE' && segments.length === 2) {
          await service.cancelRemoteDownload(jobId)
          sendJson(res, 200, { ok: true })
          return
        }
      }

      const routeKey = `${method} ${path}`
      if (Object.hasOwn(ROUTES, routeKey)) {
        sendJson(res, 200, await ROUTES[routeKey](req, url))
        return
      }

      const host = hostHandler(path, method)
      if (host) {
        sendJson(res, 200, await host.run(host.id, req))
        return
      }

      sendJson(res, 404, {
        ok: false,
        error: toErrorView(
          errors.invalidInput('path', { zh: `未知路径 ${method} ${path}`, en: `Unknown path ${method} ${path}` }),
        ),
      })
    } catch (error) {
      const view = toErrorView(error)
      const status = Number.isInteger(error?.httpStatus)
        ? error.httpStatus
        : isRemoteGoError(error)
          ? statusForErrorCode(view.code)
          : 500
      logger.error?.('[dsh-remote-go] API error:', error)
      try {
        sendJson(res, status, { ok: false, error: view })
      } catch {
        /* response already gone */
      }
    }
  }

  return {
    handler,
    dispose() {
      // One entry point for the whole listener teardown: the hub owns both channel sets.
      hub.dispose()
    },
  }
}

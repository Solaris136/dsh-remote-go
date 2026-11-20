/** Local HTTP API for the browser half (contract: docs/api.md): DSH's own admission when the kernel provides it, then
 * the marker header and, with an Origin, same-origin. Routing only; the two SSE channels live in `events.ts`. */
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
/** An oversized body is the caller's mistake, not a business conflict (409). */
const PAYLOAD_TOO_LARGE = 413
const VERSION_ROW = { version: PLUGIN_VERSION, apiVersion: API_VERSION }
const PLUGIN_ROW = { id: 'dsh-remote-go', version: PLUGIN_VERSION }
/** An authorization verdict: `ok` proceeds, else a status and coded body (not a union; route code reads `!ok`). */
interface AuthVerdict {
  ok: boolean
  status?: number
  error?: ErrorView
}
type JsonBody = Record<string, unknown>
type RouteHandler = (req?: IncomingMessage, url?: URL) => unknown | Promise<unknown>
type HostAction = (id: string, req?: IncomingMessage) => unknown | Promise<unknown>
export interface ApiOptions {
  service: RemoteGoService
  getOrigin?: () => string | null
  admit?: (req: IncomingMessage) => number | undefined
  /** The logger this module reports through; both methods are optional (a test passes `{}`). */
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
  diagnostics?: () => Record<string, unknown>
}
export interface Api {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  dispose: () => void
}
/** The HTTP status for an ErrorView: only `invalid-input` (400) and `internal` (500) are special, the rest is 409. */
export function statusForErrorCode(code: string): number {
  if (code === 'invalid-input') return 400
  if (code === 'internal') return 500
  return 409
}

export function createApi(options: ApiOptions): Api {
  const { service, logger = console } = options
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
  function parseOrigin(value: unknown): URL | null {
    if (typeof value !== 'string' || value === '') return null
    try {
      return new URL(value)
    } catch {
      return null
    }
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
  /** Browser trust for same-origin reads (SSE cannot set custom headers): a present Origin must be this GUI, and the
   * Host fence is checked for both kinds of caller because a DNS-rebinding page cannot forge `Host`. */
  function authorizeOrigin(req: IncomingMessage): AuthVerdict {
    const local = parseOrigin(options.getOrigin())
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      if (local === null || !sameServerOrigin(origin, local)) return crossSite()
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return crossSite()
    // An unknown local origin is no reason to reject: admission (when present) already judged Host.
    if (local !== null && !sameServerHost(req.headers.host, local)) return crossSite()
    return { ok: true }
  }

  function authorize(req: IncomingMessage): AuthVerdict {
    const origin = authorizeOrigin(req)
    if (!origin.ok) return origin
    if (req.headers[API_HEADER] === '1') return { ok: true }
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

  function readJson(req: IncomingMessage): Promise<JsonBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let refused = false
      req.on('data', (chunk: Buffer) => {
        if (refused) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          refused = true
          chunks.length = 0
          // Answer 413 with a JSON body *before* the socket goes away: destroying the request made the client see
          // ECONNRESET instead of the refusal. The rest is drained, not buffered.
          const error = errors.invalidInput('body', {
            zh: `请求体超过上限（${MAX_BODY_BYTES} 字节）。`,
            en: `The request body exceeds the limit (${MAX_BODY_BYTES} bytes).`,
          })
          error.httpStatus = PAYLOAD_TOO_LARGE
          reject(error)
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
  /** Which SSE channel a GET path names, or null; both routes share one pre-condition. */
  function sseRoute(path: string, method: string): 'state' | 'logs' | null {
    if (method !== 'GET') return null
    if (path === '/events') return 'state'
    if (path === '/events/logs') return 'logs'
    return null
  }
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
    // Machine paths and the client-module row are troubleshooting data: redact them like any export.
    'GET /diagnostics/self': () =>
      redactObject({
        ok: true,
        plugin: PLUGIN_ROW,
        at: nowIso(),
        ...(typeof options.diagnostics === 'function' ? options.diagnostics() : {}),
      }),
    'POST /hosts': async (req) => {
      const body = await readJson(req)
      return { ok: true, host: await service.saveHost((body.host ?? body) as RawHostEntry) }
    },
    'POST /settings': async (req) => {
      const body = await readJson(req)
      return { ok: true, settings: await service.saveSettings(body.patch ?? body) }
    },
    'POST /local-version': async (req) => {
      const { version } = await readJson(req)
      // The client backfills only a missing probe: the service adopts it when unknown and above the engines floor.
      return { ok: true, accepted: service.setLocalVersion(String(version ?? ''), 'client') }
    },
    'POST /active': async (req) => {
      const { id } = await readJson(req)
      service.setActiveHost(typeof id === 'string' ? id : null)
      return { ok: true }
    },
  }
  const HOST_ACTIONS: Record<string, HostAction> = {
    DELETE: async (id) => {
      await service.removeHost(id)
      return { ok: true }
    },
    'POST connect': async (id, req) => {
      const body = await readJson(req)
      // Remembering is the default when a password is supplied; the Client sends false only with its box unchecked.
      const result = await service.connect(id, {
        password: typeof body.password === 'string' ? body.password : undefined,
        rememberPassword: body.rememberPassword !== false,
      })
      return { ok: true, ...result }
    },
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

  function hostHandler(hostPath: string, method: string): { id: string; run: HostAction } | null {
    const segments = hostPath.split('/').filter(Boolean)
    if (segments[0] !== 'hosts' || segments.length < 2) return null
    const key = segments[2] ? `${method} ${segments[2]}` : method
    if (!Object.hasOwn(HOST_ACTIONS, key)) return null
    let id: string
    try {
      id = decodeURIComponent(segments[1])
    } catch {
      // A malformed escape is a client mistake: answer 400 with a field error instead of leaking URIError as 500.
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
      // `/health` is the one unauthenticated probe (it carries no state) but still passes the Host fence; the rest of
      // the routes pass DSH's own admission first.
      const probe = path === '/health' && method === 'GET'
      if (!probe) {
        const rejection = kernelAdmit === null ? undefined : kernelAdmit(req)
        const rejected = typeof rejection === 'number' ? rejection : undefined
        if (rejected !== undefined) {
          sendJson(res, rejected, admissionView(rejected))
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
      // SSE cannot carry the custom header; it already passed admission, and this fence covers kernels without
      // `connection` (browsers block a cross-origin EventSource anyway).
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
      const segments = path.split('/').filter(Boolean)
      if (method === 'POST' && path === '/downloads') {
        const body = await readJson(req)
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
        // swallow-ok: the response is already gone; a failed write cannot be reported on it
      }
    }
  }
  return {
    handler,
    dispose() {
      hub.dispose()
    },
  }
}

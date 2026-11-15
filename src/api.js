/**
 * Local HTTP API for the browser half (contract: docs/api.md); every request needs the marker header and, with an Origin, same-origin.
 */
import { API_HEADER, API_PREFIX, API_VERSION, PLUGIN_VERSION } from './constants.js'
import { errors, isRemoteGoError, toErrorView } from './errors.js'
import { nowIso } from './util.js'

const MAX_BODY_BYTES = 1 * 1024 * 1024

/** Rows shared by the `/version` and `/diagnostics/self` responses. */
const VERSION_ROW = { version: PLUGIN_VERSION, apiVersion: API_VERSION }
const PLUGIN_ROW = { id: 'dsh-remote-go', version: PLUGIN_VERSION }

export function createApi(options) {
  const { service } = options
  const logger = options.logger ?? console
  const sseClients = new Set()

  /** Write one SSE frame to every subscriber, dropping the ones that already went away. */
  function writeAll(frame) {
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  const broadcastState = () => writeAll(`event: state\ndata: ${JSON.stringify(service.snapshot())}\n\n`)
  service.on('state', broadcastState)

  const heartbeat = setInterval(() => writeAll('event: ping\ndata: {}\n\n'), 15_000)
  heartbeat.unref?.()

  const crossSite = () => ({
    ok: false,
    status: 403,
    error: toErrorView(
      errors.invalidInput('origin', { zh: '跨站请求被拒绝。', en: 'Cross-site requests are rejected.' }),
    ),
  })

  /**
   * Browser trust for same-origin reads (used by SSE, which cannot set custom
   * headers): an absent Origin is a non-browser local caller; a present Origin
   * must be this GUI's origin and the request must not be cross-site.
   */
  function authorizeOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      const expected = options.getOrigin()
      if (!expected || origin.replace(/\/$/, '') !== expected.replace(/\/$/, '')) return crossSite()
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return crossSite()
    return { ok: true }
  }

  function authorize(req) {
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

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(errors.invalidInput('body', { zh: '请求体过大。', en: 'The request body is too large.' }))
          req.destroy()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      req.on('end', () => {
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

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function handleSse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`event: state\ndata: ${JSON.stringify(service.snapshot())}\n\n`)
    sseClients.add(res)
    req.on('close', () => {
      sseClients.delete(res)
    })
  }

  // One entry per route: `(req, url) => response body`. The dispatcher owns auth,
  // init, status codes and the error envelope, so handlers only shape data.
  const ROUTES = {
    'GET /health': () => ({ ok: true, version: PLUGIN_VERSION, at: nowIso() }),
    'GET /state': () => ({ ok: true, state: service.snapshot() }),
    'GET /version': () => ({ ok: true, ...VERSION_ROW, hostVersion: service.localVersion }),
    'GET /ssh/aliases': async () => ({ ok: true, ...(await service.discoverSshAliases()) }),
    'GET /keyfile/list': async (req, url) => ({
      ok: true,
      ...(await service.listKeyFiles(url.searchParams.get('path') ?? '')),
    }),
    'GET /diagnostics/self': () => ({
      ok: true,
      plugin: PLUGIN_ROW,
      at: nowIso(),
      ...(typeof options.diagnostics === 'function' ? options.diagnostics() : {}),
    }),
    'POST /hosts': async (req) => {
      const body = await readJson(req)
      return { ok: true, host: await service.saveHost(body.host ?? body) }
    },
    'POST /settings': async (req) => {
      const body = await readJson(req)
      return { ok: true, settings: await service.saveSettings(body.patch ?? body) }
    },
    'POST /local-version': async (req) => {
      const { version } = await readJson(req)
      service.setLocalVersion(String(version ?? ''), 'client')
      return { ok: true }
    },
    'POST /active': async (req) => {
      const { id } = await readJson(req)
      service.setActiveHost(typeof id === 'string' ? id : null)
      return { ok: true }
    },
  }

  // `/hosts/:id` and `/hosts/:id/<action>`, keyed the same way.
  const HOST_ACTIONS = {
    DELETE: async (id) => {
      await service.removeHost(id)
      return { ok: true }
    },
    'POST connect': async (id, req) => {
      const body = await readJson(req)
      const result = await service.connect(id, {
        password: typeof body.password === 'string' ? body.password : undefined,
        rememberPassword: body.rememberPassword === true,
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
    'POST sync': async (id) => {
      await service.syncNow(id)
      return { ok: true, accepted: true }
    },
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
  function hostHandler(hostPath, method) {
    const segments = hostPath.split('/').filter(Boolean)
    if (segments[0] !== 'hosts' || segments.length < 2) return null
    const key = segments[2] ? `${method} ${segments[2]}` : method
    if (!Object.hasOwn(HOST_ACTIONS, key)) return null
    return { id: decodeURIComponent(segments[1]), run: HOST_ACTIONS[key] }
  }

  async function handler(req, res) {
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

      if (path === '/health' && method === 'GET') {
        sendJson(res, 200, ROUTES['GET /health']())
        return
      }

      // SSE cannot carry the custom header; trusting only the same-origin fence
      // is enough for a read-only state stream (browsers block cross-origin
      // EventSource without CORS headers, which this route never sends).
      if (path === '/events' && method === 'GET') {
        const originOnly = authorizeOrigin(req)
        if (!originOnly.ok) {
          sendJson(res, originOnly.status, { ok: false, error: originOnly.error })
          return
        }
        await service.init()
        handleSse(req, res)
        return
      }

      const auth = authorize(req)
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error: auth.error })
        return
      }

      await service.init()

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
      const status = isRemoteGoError(error) ? (view.code === 'invalid-input' ? 400 : 409) : 500
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
      service.removeListener('state', broadcastState)
      clearInterval(heartbeat)
      for (const client of sseClients) {
        try {
          client.end()
        } catch {}
      }
      sseClients.clear()
    },
  }
}

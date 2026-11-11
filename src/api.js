/**
 * Local HTTP API used by the browser half (contract: docs/api.md). Mounted on
 * the local DSH Web server as a prefix route; every request must carry the
 * `x-dsh-remote-go` header and, when a browser supplies an Origin, be same-origin
 * (design §9.1: the remote UI is never exposed, only the local plugin state).
 */
import { API_HEADER, API_PREFIX, API_VERSION, PLUGIN_VERSION } from './constants.js'
import { errors, isRemoteGoError, toErrorView } from './errors.js'
import { nowIso } from './util.js'

const MAX_BODY_BYTES = 1 * 1024 * 1024

/**
 * @param {{
 *   service: import('./service.js').RemoteGoService,
 *   getOrigin: () => string | null,
 *   logger?: { warn?: (...a: any[]) => void, error?: (...a: any[]) => void },
 *   diagnostics?: () => Record<string, unknown>,
 * }} options
 */
export function createApi(options) {
  const { service } = options
  const logger = options.logger ?? console
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set()

  const broadcastState = () => {
    const data = JSON.stringify(service.snapshot())
    for (const client of sseClients) {
      try {
        client.write(`event: state\ndata: ${data}\n\n`)
      } catch {
        sseClients.delete(client)
      }
    }
  }
  service.on('state', broadcastState)

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write('event: ping\ndata: {}\n\n')
      } catch {
        sseClients.delete(client)
      }
    }
  }, 15_000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  /**
   * Browser trust for same-origin reads (used by SSE, which cannot set custom
   * headers): an absent Origin is a non-browser local caller; a present Origin
   * must be this GUI's origin and the request must not be cross-site.
   * @param {import('node:http').IncomingMessage} req
   */
  function authorizeOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      const expected = options.getOrigin()
      if (!expected || origin.replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
        return {
          ok: false,
          status: 403,
          error: toErrorView(
            errors.invalidInput('origin', { zh: '跨站请求被拒绝。', en: 'Cross-site requests are rejected.' }),
          ),
        }
      }
    }
    const secFetchSite = req.headers['sec-fetch-site']
    if (secFetchSite === 'cross-site') {
      return {
        ok: false,
        status: 403,
        error: toErrorView(
          errors.invalidInput('origin', { zh: '跨站请求被拒绝。', en: 'Cross-site requests are rejected.' }),
        ),
      }
    }
    return { ok: true }
  }

  /** @param {import('node:http').IncomingMessage} req */
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

  /** @param {import('node:http').IncomingMessage} req */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
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

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {Record<string, unknown>} payload */
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
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

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
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
        sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, at: nowIso() })
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
      const segments = path.split('/').filter(Boolean)

      if (method === 'GET' && path === '/state') {
        sendJson(res, 200, { ok: true, state: service.snapshot() })
        return
      }
      if (method === 'GET' && path === '/ssh/aliases') {
        sendJson(res, 200, { ok: true, ...(await service.discoverSshAliases()) })
        return
      }
      if (method === 'GET' && path === '/local/workspaces') {
        sendJson(res, 200, { ok: true, ...(await service.listLocalWorkspaces()) })
        return
      }
      if (method === 'POST' && path === '/hosts') {
        const body = await readJson(req)
        const host = await service.saveHost(body.host ?? body)
        sendJson(res, 200, { ok: true, host })
        return
      }
      if (method === 'POST' && path === '/settings') {
        const body = await readJson(req)
        const settings = await service.saveSettings(body.patch ?? body)
        sendJson(res, 200, { ok: true, settings })
        return
      }
      if (method === 'POST' && path === '/local-version') {
        const body = await readJson(req)
        service.setLocalVersion(String(body.version ?? ''), 'client')
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && path === '/active') {
        const body = await readJson(req)
        service.setActiveHost(typeof body.id === 'string' ? body.id : null)
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'GET' && path === '/version') {
        sendJson(res, 200, {
          ok: true,
          version: PLUGIN_VERSION,
          apiVersion: API_VERSION,
          hostVersion: service.localVersion,
        })
        return
      }
      if (method === 'GET' && path === '/diagnostics/self') {
        const extra = typeof options.diagnostics === 'function' ? options.diagnostics() : {}
        sendJson(res, 200, {
          ok: true,
          plugin: { id: 'dsh-remote-go', version: PLUGIN_VERSION },
          at: nowIso(),
          ...extra,
        })
        return
      }

      if (segments[0] === 'hosts' && segments.length >= 2) {
        const id = decodeURIComponent(segments[1])
        const action = segments[2] ?? null
        if (method === 'DELETE' && action === null) {
          await service.removeHost(id)
          sendJson(res, 200, { ok: true })
          return
        }
        if (method === 'POST' && action === 'connect') {
          const body = await readJson(req)
          const result = await service.connect(id, {
            password: typeof body.password === 'string' ? body.password : undefined,
            rememberFingerprint: body.rememberFingerprint !== false,
            overrideVersion: body.overrideVersion === true,
          })
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (method === 'POST' && action === 'disconnect') {
          const body = await readJson(req)
          await service.disconnect(id, { stopRemote: body.stopRemote === true })
          sendJson(res, 200, { ok: true })
          return
        }
        if (method === 'POST' && action === 'reconnect') {
          await service.reconnect(id)
          sendJson(res, 200, { ok: true })
          return
        }
        if (method === 'POST' && action === 'fingerprint') {
          const body = await readJson(req)
          await service.confirmFingerprint(id, {
            accept: body.accept === true,
            remember: body.remember === true,
            sha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
          })
          sendJson(res, 200, { ok: true })
          return
        }
        if (method === 'POST' && action === 'diagnose') {
          const report = await service.diagnose(id)
          sendJson(res, 200, { ok: true, report })
          return
        }
        if (method === 'GET' && action === 'workspaces') {
          sendJson(res, 200, { ok: true, ...(await service.listHostWorkspaces(id)) })
          return
        }
        if (method === 'GET' && action === 'mirrors') {
          sendJson(res, 200, { ok: true, ...(await service.listHostMirrors(id)) })
          return
        }
        if (method === 'POST' && action === 'mirrors' && segments[3] === 'sync') {
          const body = await readJson(req)
          sendJson(res, 200, {
            ok: true,
            ...(await service.syncHostMirrors(id, { acknowledgeResync: body.acknowledgeResync === true })),
          })
          return
        }
        if (method === 'GET' && action === 'open') {
          sendJson(res, 200, { ok: true, ...service.openInfo(id) })
          return
        }
        if (method === 'POST' && action === 'keepalive') {
          const body = await readJson(req)
          const host = await service.updateHostPolicy(id, {
            keepAlive: body.keepAlive,
            idleMinutes: body.idleMinutes,
          })
          sendJson(res, 200, { ok: true, host })
          return
        }
        if (method === 'POST' && action === 'activate') {
          service.setActiveHost(id)
          sendJson(res, 200, { ok: true })
          return
        }
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
        } catch {
          /* ignore */
        }
      }
      sseClients.clear()
    },
  }
}

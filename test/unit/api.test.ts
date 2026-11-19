import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAdmission } from '../../dist/src/admission.js'
import { createApi } from '../../dist/src/api.js'
import { PLUGIN_VERSION } from '../../dist/src/constants.js'
import { errors } from '../../dist/src/errors.js'
import { createHost, fakeSecretStore, makeTestService, waitFor } from '../helpers/fake-remote.ts'

const HEADER = { 'x-dsh-remote-go': '1' }

async function startApi(service, options = {}) {
  let server
  const api = createApi({
    service,
    getOrigin: () => {
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    admit: options.admit,
    logger: { warn() {}, error() {} },
    diagnostics: options.diagnostics,
  })
  server = http.createServer(api.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/dsh-remote-go/api`
  return {
    base,
    port,
    api,
    async close() {
      api.dispose()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

async function call(base, path, init = {}) {
  const headers = { ...HEADER, ...(init.headers ?? {}) }
  const response = await fetch(`${base}${path}`, { ...init, headers })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text, headers: response.headers }
}

/** One GET with caller-chosen headers, including `Host` (fetch refuses to set it). */
function rawGet(base, path, headers) {
  const url = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text === '' ? null : JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, json, text })
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** One GET whose response is dropped as soon as the headers arrive (for never-ending streams). */
function rawHead(base, path, headers) {
  const url = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers },
      (response) => {
        const status = response.statusCode
        response.destroy()
        resolve({ status })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** Race one promise against a deadline so a broken SSE case cannot hang the suite. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** One open `/events` (or `/events/logs`) stream: its response, the text so far and its end. */
function openSse(base, ssePath = '/events') {
  const url = new URL(`${base}${ssePath}`)
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        const ended = new Promise((endResolve) => {
          response.once('end', () => endResolve('end'))
          response.once('close', () => endResolve('close'))
        })
        resolve({
          request,
          response,
          text: () => text,
          ended: ended.then(() => text),
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** Wait until one SSE client's collected text contains `needle`. */
async function waitForText(client, needle, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (client.text().includes(needle)) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`SSE frame ${needle} never arrived; got ${JSON.stringify(client.text().slice(0, 200))}`)
}

test('health is a bare liveness probe; every other endpoint requires the local plugin header', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const health = await fetch(`${api.base}/health`)
    assert.equal(health.status, 200)
    // `{ ok: true }` only: this route needs no session, so it must carry no state at all.
    assert.deepEqual(await health.json(), { ok: true })
    const unauth = await fetch(`${api.base}/state`)
    assert.equal(unauth.status, 403)
    const body = await unauth.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'invalid-input')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('GET /state returns the contract shape', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    await createHost(service)
    const result = await call(api.base, '/state')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    const state = result.json.state
    assert.equal(typeof state.rev, 'number', 'every snapshot carries its monotonic revision')
    assert.equal(typeof state.instance, 'string', 'and the publish instance that scopes the revision')
    assert.equal(state.hostVersion, '0.2.2-rc.1')
    assert.equal(state.hosts.length, 1)
    assert.equal(state.firstRun, false)
    assert.ok(state.settings && typeof state.settings.defaultPort === 'number')
    assert.equal(state.hosts[0].status, 'unconfigured')
    assert.equal(state.hosts[0].error, null)
    // The plain connection fields are part of the contract; the editor must not parse the
    // masked display string back (v2.10).
    assert.equal(state.hosts[0].username, 'ubuntu')
    assert.equal(state.hosts[0].port, 22)
    assert.equal(state.hosts[0].addressMasked, 'ubuntu@test-host')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('host CRUD, connect, open and keep-alive work over HTTP', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const created = await call(api.base, '/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: { name: 'VM', address: 'test-host', keepAlive: 'keep' } }),
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    const hostId = created.json.host.id
    assert.ok(hostId)
    const connect = await call(api.base, `/hosts/${hostId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(connect.status, 200)
    assert.equal(connect.json.ok, true)
    await waitFor(() => service.snapshot().hosts[0].status === 'connected')
    const open = await call(api.base, `/hosts/${hostId}/open`)
    assert.equal(open.status, 200)
    assert.match(open.json.url, /^http:\/\/127\.0\.0\.1:45123\/\?token=/)
    assert.equal(open.json.localPort, 45123)
    assert.match(open.json.webUrl, new RegExp(`^/dsh-remote-go/remote/${hostId}/\\?token=`))
    const disconnected = await call(api.base, `/hosts/${hostId}/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(disconnected.status, 200)
    assert.equal(service.snapshot().hosts[0].status, 'disconnected')
    const removed = await call(api.base, `/hosts/${hostId}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal(service.snapshot().hosts.length, 0)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('the password route remembers and clears a password without connecting', async () => {
  const secrets = fakeSecretStore()
  const { service } = await makeTestService({ secrets })
  const api = await startApi(service)
  try {
    const host = await createHost(service, { auth: { type: 'password' } })
    const saved = await call(api.base, `/hosts/${host.id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 's3cret' }),
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json, { ok: true, available: true, saved: true })
    assert.equal(secrets.store.get(host.id), 's3cret')
    assert.equal(service.snapshot().hosts[0].passwordSaved, true)

    // The contract defaults remembering to true for a connect that carries a password, and the
    // wizard's plain save uses this route so the value is not lost without a connection.
    const cleared = await call(api.base, `/hosts/${host.id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.json, { ok: true, available: true, saved: false })
    assert.equal(secrets.store.has(host.id), false)

    const empty = await call(api.base, `/hosts/${host.id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '' }),
    })
    assert.equal(empty.status, 400)
    assert.equal(empty.json.ok, false)
    assert.equal(empty.json.error.code, 'invalid-input')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /downloads starts a job; status and cancel are separate', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const started = []
    let cancelled = null
    // The local folder check lives in `service.startRemoteDownload` (see the refusal test below);
    // this case is about the HTTP shapes, so it stubs the three route-level methods.
    service.startRemoteDownload = async (id, path, options) => {
      started.push({ runtimeId: id, path, destination: options?.destination })
      return {
        id: 'dl_1',
        hostId: id,
        path,
        name: 'report.bin',
        kind: 'file',
        phase: 'preparing',
        totalBytes: 0,
        doneBytes: 0,
        totalFiles: 0,
        doneFiles: 0,
        destination: options?.destination ?? null,
        error: null,
      }
    }
    service.remoteDownloadStatus = async (id) => ({
      id,
      phase: 'ready',
      name: 'report.bin',
      kind: 'file',
      totalBytes: 4,
      doneBytes: 4,
      totalFiles: 1,
      doneFiles: 1,
      destination: 'C:/Users/me/Downloads/report.bin',
      error: null,
    })
    service.cancelRemoteDownload = async (id) => {
      cancelled = id
      return true
    }
    const start = await call(api.base, '/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: host.id,
        path: '/home/ubuntu/report.bin',
        destination: 'C:/Users/me/Downloads',
      }),
    })
    assert.equal(start.status, 200)
    assert.equal(start.json.job.phase, 'preparing')
    assert.deepEqual(started, [
      { runtimeId: host.id, path: '/home/ubuntu/report.bin', destination: 'C:/Users/me/Downloads' },
    ])

    const status = await call(api.base, '/downloads/dl_1/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.job.phase, 'ready')
    assert.equal(status.json.job.destination, 'C:/Users/me/Downloads/report.bin')

    const cancel = await call(api.base, '/downloads/dl_1', { method: 'DELETE' })
    assert.equal(cancel.status, 200)
    assert.equal(cancelled, 'dl_1')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /hosts/:id/restart requires a restartable state', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const refused = await call(api.base, `/hosts/${host.id}/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'restart-unavailable')
    assert.ok(refused.json.error.detail.zh.length > 0)
    assert.equal(service.snapshot().hosts[0].status, 'unconfigured')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /hosts/:id/restart accepts on a connected host and relaunches on the new port', async () => {
  const started = []
  const web = (port, token, pid) => ({
    pid,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    logPath: '/tmp/web.log',
    startedAt: new Date().toISOString(),
    rawLine: '',
    profile: 'web',
    dshHome: '/home/ubuntu/.dsh',
  })
  const { service } = await makeTestService({
    readRegistry: async () => ({ pid: 4242, port: 38123, profile: 'web', dshHome: '/home/ubuntu/.dsh' }),
    startWeb: async () => {
      started.push(true)
      return started.length === 1 ? web(38123, 'tok_first', 4242) : web(38200, 'tok_second', 4243)
    },
  })
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    await call(api.base, `/hosts/${host.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await waitFor(() => service.snapshot().hosts[0].status === 'connected')
    const restart = await call(api.base, `/hosts/${host.id}/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(restart.status, 200)
    assert.equal(restart.json.ok, true)
    assert.equal(restart.json.accepted, true)
    await waitFor(
      () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38200,
      { label: 'restarted on the new port' },
    )
    const open = await call(api.base, `/hosts/${host.id}/open`)
    assert.match(open.json.url, /:45123\/\?token=tok_second$/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /hosts/:id/stop-remote requires a stoppable state', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const refused = await call(api.base, `/hosts/${host.id}/stop-remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'stop-unavailable')
    assert.ok(refused.json.error.detail.zh.length > 0)
    assert.equal(service.snapshot().hosts[0].status, 'unconfigured')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /hosts/:id/stop-remote stops the bound remote web and leaves the host disconnected', async () => {
  const stopped = []
  let registry = null
  const { service } = await makeTestService({
    readRegistry: async () => registry,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      registry = null
      return { ok: true, output: 'STOPPED' }
    },
  })
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    await call(api.base, `/hosts/${host.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await waitFor(() => service.snapshot().hosts[0].status === 'connected')
    registry = { pid: 4242, port: 38123, profile: 'web', dshHome: '/home/ubuntu/.dsh' }
    const stop = await call(api.base, `/hosts/${host.id}/stop-remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(stop.status, 200)
    assert.equal(stop.json.ok, true)
    assert.equal(stop.json.pid, 4242)
    assert.deepEqual(stopped, [4242])
    const view = service.snapshot().hosts[0]
    assert.equal(view.status, 'disconnected')
    assert.equal(view.keepAlive, 'keep')
    // The remote UI is gone from the API surface: opening it is refused, the settings stay.
    const open = await call(api.base, `/hosts/${host.id}/open`)
    assert.equal(open.status, 409)
    assert.equal(open.json.error.code, 'remote-ui-unreachable')
    assert.equal((await call(api.base, '/state')).json.state.hosts.length, 1)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /hosts/:id/stop-remote refuses a pid it cannot prove and keeps the link', async () => {
  const stopped = []
  const { service } = await makeTestService({
    readRegistry: async () => null,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    await call(api.base, `/hosts/${host.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await waitFor(() => service.snapshot().hosts[0].status === 'connected')
    const refused = await call(api.base, `/hosts/${host.id}/stop-remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'stop-unavailable')
    assert.match(refused.json.error.detail.zh + refused.json.error.detail.en, /run\/web\.json/)
    assert.deepEqual(stopped, [])
    assert.equal(service.snapshot().hosts[0].status, 'connected')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('SSE /events also broadcasts remote-unreachable episode frames', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const controller = new AbortController()
    const response = await fetch(`${api.base}/events`, { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle) => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    }
    await readUntil('event: state')
    service.emit('remote-unreachable', {
      hostId: 'h_1',
      phase: 'confirmed',
      source: 'heartbeat',
      at: '2026-11-16T00:00:00.000Z',
    })
    await readUntil('event: remote-unreachable')
    controller.abort()
    assert.match(text, /event: remote-unreachable/)
    assert.match(text, /"phase":"confirmed"/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('diagnose returns a redacted report', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const result = await call(api.base, `/hosts/${host.id}/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.report.redacted, true)
    assert.ok(Array.isArray(result.json.report.checks))
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('SSH alias discovery reads the local config through the service', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const result = await call(api.base, '/ssh/aliases')
    assert.equal(result.status, 200)
    assert.deepEqual(
      result.json.aliases.map((alias) => alias.alias),
      ['test-host'],
    )
    assert.equal(result.json.aliases[0].host, '2001:db8::1')
    assert.equal(result.json.aliases[0].user, 'ubuntu')
    assert.ok(result.json.knownHosts)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('settings and local-version endpoints update the snapshot', async () => {
  const { service } = await makeTestService({ localVersion: null })
  const api = await startApi(service)
  try {
    const version = await call(api.base, '/local-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.2.2-rc.3' }),
    })
    assert.equal(version.status, 200)
    assert.equal(version.json.accepted, true)
    assert.equal(service.snapshot().hostVersion, '0.2.2-rc.3')
    const settings = await call(api.base, '/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { defaultPort: 2200, language: 'zh' } }),
    })
    assert.equal(settings.status, 200)
    assert.equal(settings.json.settings.defaultPort, 2200)
    assert.equal(settings.json.settings.language, 'zh')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('cross-site origins are refused', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const response = await fetch(`${api.base}/state`, {
      headers: { ...HEADER, origin: 'http://evil.example' },
    })
    assert.equal(response.status, 403)
    const sameOrigin = await fetch(`${api.base}/state`, {
      headers: { ...HEADER, origin: `http://127.0.0.1:${api.port}` },
    })
    assert.equal(sameOrigin.status, 200)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a foreign Host is refused even with a same-origin Origin', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    // DNS rebinding: the socket reaches this server, but the browser names the attacker's domain
    // in Host. The Origin the attacker's page sends names this origin, so Origin alone passes.
    const origin = `http://127.0.0.1:${api.port}`
    const state = await rawGet(api.base, '/state', { host: 'attacker.example', origin, ...HEADER })
    assert.equal(state.status, 403)
    assert.equal(state.json.ok, false)
    const events = await rawGet(api.base, '/events', { host: 'attacker.example', origin })
    assert.equal(events.status, 403)
    assert.equal(events.json.ok, false)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a foreign Host is refused without an Origin, like the proxy fence', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    // A plain browser read: no Origin, Fetch-Metadata still says same-origin, Host is the attacker's.
    const rebound = { host: `attacker.example:${api.port}`, 'sec-fetch-site': 'same-origin' }
    const state = await rawGet(api.base, '/state', { ...rebound, ...HEADER })
    assert.equal(state.status, 403)
    const events = await rawGet(api.base, '/events', rebound)
    assert.equal(events.status, 403)
    // The local authority itself is still served, so the fence admits real same-origin traffic.
    const allowed = await rawGet(api.base, '/state', { host: `127.0.0.1:${api.port}`, ...HEADER })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.json.ok, true)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('DSH admission runs before dispatch and covers the SSE route', async () => {
  const { service } = await makeTestService()
  const paths = []
  const api = await startApi(service, {
    admit: (req) => {
      paths.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      return req.headers['x-test-session'] === 'ok' ? undefined : 401
    },
  })
  try {
    const state = await call(api.base, '/state')
    assert.equal(state.status, 401)
    assert.equal(state.json.ok, false)
    const events = await call(api.base, '/events')
    assert.equal(events.status, 401)
    const allowed = await call(api.base, '/state', { headers: { 'x-test-session': 'ok' } })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.json.ok, true)
    // The liveness probe is the documented exception: no session, still fenced by Host.
    const health = await call(api.base, '/health')
    assert.equal(health.status, 200)
    assert.deepEqual(paths, ['/dsh-remote-go/api/state', '/dsh-remote-go/api/events', '/dsh-remote-go/api/state'])
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a failing DSH admission rejects the request instead of admitting it', async () => {
  const { service } = await makeTestService()
  const logged = []
  const admit = createAdmission(
    {
      get: () => ({
        requestRejection() {
          throw new Error('kernel exploded')
        },
      }),
    },
    { warn: (...args) => logged.push(args.map(String).join(' ')) },
  )
  assert.equal(admit({ headers: {} }), 500)
  const api = await startApi(service, { admit })
  try {
    const state = await call(api.base, '/state')
    assert.equal(state.status, 500)
    assert.equal(state.json.ok, false)
    assert.equal(state.json.error.code, 'internal')
    // A rejected request never reaches its route: the write below must not have happened.
    const active = await call(api.base, '/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'h_never' }),
    })
    assert.equal(active.status, 500)
    assert.equal(service.snapshot().activeHostId, null)
    const events = await call(api.base, '/events')
    assert.equal(events.status, 500)
    // One warning from the direct call above, one per rejected request; none of them silent.
    assert.equal(logged.length, 4, logged.join('\n'))
    for (const line of logged) assert.match(line, /admission failed/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('without the Connection service the plugin keeps its own fence, Host check included', async () => {
  const { service } = await makeTestService()
  const admit = createAdmission({ get: () => undefined }, { warn() {} })
  assert.equal(admit({ headers: {} }), undefined)
  // A context that cannot report services at all degrades the same way, with a warning.
  assert.equal(createAdmission({}, { warn() {} })({ headers: {} }), undefined)
  const brokenLookup = createAdmission(
    {
      get() {
        throw new Error('reflection unavailable')
      },
    },
    { warn() {} },
  )
  assert.equal(brokenLookup({ headers: {} }), undefined)
  const api = await startApi(service, { admit })
  try {
    // The marker header is the old gate again, but the Host self-check still bites.
    const local = `127.0.0.1:${api.port}`
    const allowed = await rawGet(api.base, '/state', { host: local, ...HEADER })
    assert.equal(allowed.status, 200)
    const rebound = await rawGet(api.base, '/state', {
      host: 'attacker.example',
      'sec-fetch-site': 'same-origin',
      ...HEADER,
    })
    assert.equal(rebound.status, 403)
    const events = await rawGet(api.base, '/events', { host: `attacker.example:${api.port}` })
    assert.equal(events.status, 403)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('invalid host payloads answer 400 and unknown paths answer 404', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const invalid = await call(api.base, '/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: { name: 'x' } }),
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.ok, false)
    assert.equal(invalid.json.error.code, 'invalid-input')
    const missing = await call(api.base, '/nope')
    assert.equal(missing.status, 404)
    const badJson = await call(api.base, '/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(badJson.status, 400)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('SSE /events emits the first state frame immediately', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const controller = new AbortController()
    const response = await fetch(`${api.base}/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !text.includes('event: state')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    controller.abort()
    assert.match(text, /event: state/)
    assert.match(text, /"hosts"/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('SSE /events also broadcasts download progress frames', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const controller = new AbortController()
    const response = await fetch(`${api.base}/events`, { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle) => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    }
    await readUntil('event: state')
    service.emit('download', { id: 'dl_1', phase: 'preparing', doneBytes: 3, totalBytes: 10 })
    await readUntil('event: download')
    controller.abort()
    assert.match(text, /event: download/)
    assert.match(text, /"id":"dl_1"/)
    assert.match(text, /"doneBytes":3/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('SSE still refuses cross-site callers without the header', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const response = await fetch(`${api.base}/events`, {
      headers: { origin: 'http://evil.example' },
    })
    assert.equal(response.status, 403)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('GET /diagnostics/self proves host activation and client-module registration', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service, {
    diagnostics: () => ({ stateDir: '/tmp/dsh-remote-go', entry: { id: 'dsh-remote-go' } }),
  })
  try {
    const result = await call(api.base, '/diagnostics/self')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.plugin.id, 'dsh-remote-go')
    assert.equal(result.json.plugin.version, PLUGIN_VERSION)
    assert.equal(typeof result.json.stateDir, 'string')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('GET /version reports plugin and host versions', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const result = await call(api.base, '/version')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.hostVersion, '0.2.2-rc.1')
    assert.equal(result.json.version, PLUGIN_VERSION)
    // v2.12 splits the SSE channels (docs/api.md): the contract version moves with it.
    assert.equal(result.json.apiVersion, '2.12')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

// --- Audit regressions: each test proves a blocked behavior, not that a helper exists. ---

test('the same-origin fence accepts every loopback spelling of this listener', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    // A user who opened the GUI on `localhost` sends `Origin: http://localhost:<port>` and
    // `Host: localhost:<port>`. The old string comparison rejected every write (403) while a
    // request without an Origin still worked, which is the "can read but cannot write" bug.
    const localhostOrigin = `http://localhost:${api.port}`
    const localhost = await rawGet(api.base, '/state', {
      host: `localhost:${api.port}`,
      origin: localhostOrigin,
      ...HEADER,
    })
    assert.equal(localhost.status, 200)
    assert.equal(localhost.json.ok, true)
    const ipv6 = await rawGet(api.base, '/state', {
      host: `[::1]:${api.port}`,
      origin: `http://[::1]:${api.port}`,
      ...HEADER,
    })
    assert.equal(ipv6.status, 200)
    // A different port, a different scheme and a foreign domain are still cross-origin.
    for (const origin of [
      `http://127.0.0.1:${api.port + 1}`,
      `https://127.0.0.1:${api.port}`,
      `http://localhost.evil.example:${api.port}`,
    ]) {
      const refused = await rawGet(api.base, '/state', { host: `127.0.0.1:${api.port}`, origin, ...HEADER })
      assert.equal(refused.status, 403, `Origin ${origin} must be refused`)
    }
    // The SSE route uses the same fence, so the write path cannot disagree with the read path.
    // (A stream never ends by itself: only the status matters here.)
    const events = await rawHead(api.base, '/events', { host: `localhost:${api.port}`, origin: localhostOrigin })
    assert.equal(events.status, 200)
    const refusedEvents = await rawHead(api.base, '/events', {
      host: `localhost:${api.port}`,
      origin: `http://127.0.0.1:${api.port + 1}`,
    })
    assert.equal(refusedEvents.status, 403)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a failed connect never leaks the remote launch token, headers or home path through /state', async () => {
  const tail = [
    'dsh web: http://127.0.0.1:38123/?token=SUPERSECRET-TOKEN',
    'Authorization: Bearer local-session-value-9911',
    '/home/alice/.dsh/remote-go/run/web.log',
  ].join('\n')
  const { service } = await makeTestService({
    startWeb: async () => {
      throw errors.remoteDshStartFailed(tail)
    },
  })
  const api = await startApi(service)
  try {
    await createHost(service)
    await call(api.base, `/hosts/${service.snapshot().hosts[0].id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'connect failed' })
    const result = await call(api.base, '/state')
    assert.equal(result.status, 200)
    // Nothing from the captured remote output may reach the API response.
    for (const secret of ['SUPERSECRET-TOKEN', 'local-session-value-9911', 'alice']) {
      assert.equal(result.text.includes(secret), false, `the response leaked ${secret}`)
    }
    const view = result.json.state.hosts[0].error
    assert.equal(view.code, 'remote-dsh-start-failed')
    assert.match(view.technical, /token=<redacted>/)
    assert.match(view.technical, /<user>/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('GET /diagnostics/self never returns a machine path or user name', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service, {
    diagnostics: () => ({
      home: 'C:\\Users\\alice',
      stateDir: 'C:\\Users\\alice\\.dsh\\remote-go',
      hostVersion: '0.2.2-rc.3',
      entry: { id: 'dsh-remote-go' },
    }),
  })
  try {
    const result = await call(api.base, '/diagnostics/self')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.text.includes('alice'), false, 'the diagnostics leaked the user name')
    assert.match(result.json.home, /<user>/)
    assert.match(result.json.stateDir, /<user>/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('an internal failure answers 500, not 409', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service, {
    diagnostics: () => {
      throw new Error('diagnostics exploded')
    },
  })
  try {
    const result = await call(api.base, '/diagnostics/self')
    assert.equal(result.status, 500)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'internal')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('an oversized body answers 413 with a JSON error body instead of resetting the socket', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const body = JSON.stringify({ host: { name: 'x', address: 'a'.repeat(2 * 1024 * 1024) } })
    const result = await call(api.base, '/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(result.status, 413)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'invalid-input')
    assert.equal(service.snapshot().hosts.length, 0)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a malformed host id is a 400, not an escaped URIError', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const result = await call(api.base, '/hosts/%E0%A4%A/activate', { method: 'POST' })
    assert.equal(result.status, 400)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'invalid-input')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('the key-file picker refuses a path outside the home directory without echoing it', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const result = await call(api.base, `/keyfile/list?path=${encodeURIComponent('C:\\Windows')}`)
    assert.equal(result.status, 400)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'invalid-input')
    assert.equal(result.text.includes('Windows'), false, 'the refusal echoed the requested path')
    assert.equal(result.json.error.technical, undefined)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a client-chosen host id is never adopted, an existing one still updates', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const created = await call(api.base, '/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: { id: 'pwned-by-client', name: 'x', address: 'a.example.com' } }),
    })
    assert.equal(created.status, 200)
    assert.match(created.json.host.id, /^h_[a-z0-9]{1,32}$/)
    assert.notEqual(created.json.host.id, 'pwned-by-client')
    const updated = await call(api.base, '/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: { id: created.json.host.id, address: 'b.example.com' } }),
    })
    assert.equal(updated.json.host.id, created.json.host.id)
    assert.equal(updated.json.host.address, 'b.example.com')
    assert.equal(service.snapshot().hosts.length, 1)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /local-version only backfills a missing version and refuses one below the floor', async () => {
  const known = await makeTestService({ localVersion: '0.2.2-rc.3' })
  const knownApi = await startApi(known.service)
  try {
    const ignored = await call(knownApi.base, '/local-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9' }),
    })
    assert.equal(ignored.status, 200)
    assert.equal(ignored.json.accepted, false)
    assert.equal(known.service.snapshot().hostVersion, '0.2.2-rc.3')
  } finally {
    await knownApi.close()
    await known.service.shutdown()
  }

  const missing = await makeTestService({ localVersion: null })
  const missingApi = await startApi(missing.service)
  try {
    const tooOld = await call(missingApi.base, '/local-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0' }),
    })
    assert.equal(tooOld.status, 400)
    assert.equal(tooOld.json.error.code, 'invalid-input')
    assert.equal(missing.service.snapshot().hostVersion, null)
    const accepted = await call(missingApi.base, '/local-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.2.2-rc.3' }),
    })
    assert.equal(accepted.json.accepted, true)
    assert.equal(missing.service.snapshot().hostVersion, '0.2.2-rc.3')
  } finally {
    await missingApi.close()
    await missing.service.shutdown()
  }
})

test('the SSE fan-out is bounded: a ninth stream evicts the oldest', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  const clients = []
  try {
    for (let index = 0; index < 9; index += 1) clients.push(await openSse(api.base))
    // The cap (8) evicts the oldest subscriber rather than growing the set.
    await withTimeout(clients[0].ended, 4000, 'the oldest SSE stream was not evicted')
    // The newest subscriber is still live and receives a broadcast.
    service.emit('download', { id: 'dl_sse', phase: 'preparing', doneBytes: 1, totalBytes: 2 })
    await withTimeout(waitForText(clients[8], 'event: download'), 4000, 'the newest SSE stream received no frame')
  } finally {
    for (const client of clients) client.response.destroy()
    await api.close()
    await service.shutdown()
  }
})

test('the connect log is redacted at its producer: a start line never reaches /state, SSE or diagnostics', async () => {
  const tokenLine = 'LINE:dsh web: http://127.0.0.1:38123/?token=SUPERSECRET-TOKEN'
  const { service } = await makeTestService({
    // The real `remote-web/start.js` hands every start line to `options.onLine`, including the
    // launch URL with its token; the old fake threw before calling it, so the leak had no coverage.
    startWeb: async (_ssh, options) => {
      options.onLine(tokenLine)
      throw errors.remoteDshStartFailed(tokenLine)
    },
  })
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    await call(api.base, `/hosts/${host.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'connect failed' })
    const state = await call(api.base, '/state')
    assert.equal(state.status, 200)
    assert.equal(state.text.includes('SUPERSECRET-TOKEN'), false, 'the state frame leaked the launch token')
    const logs = state.json.state.hosts[0].logs
    assert.ok(logs.length > 0, 'the failed start must leave log lines')
    assert.ok(
      logs.some((entry) => entry.message.includes('token=<redacted>')),
      'the launch line is kept, redacted',
    )
    // The diagnostics export reads the same ring (`entry.line`).
    const diagnosed = await call(api.base, `/hosts/${host.id}/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(diagnosed.status, 200)
    assert.equal(diagnosed.text.includes('SUPERSECRET-TOKEN'), false, 'the diagnostics export leaked the launch token')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('the connecting log frame carries the redacted start line, not the token', async () => {
  const tokenLine = 'LINE:dsh web: http://127.0.0.1:38124/?token=SUPERSECRET-TOKEN'
  const { service } = await makeTestService({
    // Connect stays in `connecting` long enough for the frames to be observed.
    startWeb: async (_ssh, options) => {
      options.onLine(tokenLine)
      await new Promise((resolve) => setTimeout(resolve, 250))
      return {
        pid: 4242,
        port: 38124,
        token: 'tok_connecting',
        url: 'http://127.0.0.1:38124/?token=tok_connecting',
        logPath: '/tmp/web.log',
        startedAt: new Date().toISOString(),
        rawLine: '',
        profile: 'web',
        dshHome: '/home/ubuntu/.dsh',
      }
    },
  })
  const api = await startApi(service)
  // v2.12 contract change (docs/api.md): the log rows travel on the log channel, not inside the
  // state frame. This case used to read them from `/events`; it now reads the log channel and
  // keeps the security assertion on both streams.
  const stateStream = await openSse(api.base)
  const logStream = await openSse(api.base, '/events/logs')
  try {
    const host = await createHost(service)
    const connect = call(api.base, `/hosts/${host.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !logStream.text().includes('dsh web')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await connect
    const frames = logStream.text()
    assert.ok(frames.includes('dsh web'), `the log frame never carried the start line: ${frames.slice(0, 400)}`)
    assert.equal(frames.includes('SUPERSECRET-TOKEN'), false, 'the log frame leaked the launch token')
    assert.match(frames, /token=<redacted>/)
    // The state channel carries no log rows at all (the same rule the state frame test pins).
    const stateFrames = stateStream.text()
    assert.equal(stateFrames.includes('SUPERSECRET-TOKEN'), false, 'the state frame leaked the launch token')
    assert.equal(stateFrames.includes('dsh web'), false, 'the state frame must not inline log rows')
    await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  } finally {
    stateStream.request.destroy()
    logStream.request.destroy()
    await api.close()
    await service.shutdown()
  }
})

test('POST /downloads refuses a protected destination synchronously with 400', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const response = await call(api.base, '/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: host.id,
        path: '/home/ubuntu/project',
        destination: 'C:\\Windows',
      }),
    })
    // The old flow created a job and reported the refusal asynchronously as a job error.
    assert.equal(response.status, 400)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.error.code, 'invalid-input')
    assert.equal(service.downloads.size, 0, 'a refused destination must not consume a job slot')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /local-version answers 400 for a value that is not a version', async () => {
  const { service } = await makeTestService({ localVersion: null })
  const api = await startApi(service)
  try {
    const result = await call(api.base, '/local-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'not-a-version' }),
    })
    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'invalid-input')
    assert.equal(service.snapshot().hostVersion, null)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a quarantined hosts.json is visible on /state and on every HostView', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    await createHost(service)
    // A successful write clears the flag (the recovered file is authoritative again), so the
    // flag is set here after the list exists; the projection is what this test pins.
    service.store.corrupt.add('hosts.json')
    const state = await call(api.base, '/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.state.storeCorrupt, true)
    assert.equal(state.json.state.hosts[0].storeCorrupt, true)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('a successful write clears the corruption flag instead of warning forever', async () => {
  const { service } = await makeTestService()
  try {
    service.store.corrupt.add('hosts.json')
    assert.equal(service.snapshot().storeCorrupt, true)
    await createHost(service)
    assert.equal(service.store.hostsCorrupt, false)
    assert.equal(service.snapshot().storeCorrupt, false)
  } finally {
    await service.shutdown()
  }
})

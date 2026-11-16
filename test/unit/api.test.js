import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAdmission } from '../../src/admission.js'
import { createApi } from '../../src/api.js'
import { createHost, makeTestService, waitFor } from '../helpers/fake-remote.js'

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

test('health is open, every other endpoint requires the local plugin header', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const health = await fetch(`${api.base}/health`)
    assert.equal(health.status, 200)
    const healthJson = await health.json()
    assert.equal(healthJson.ok, true)
    assert.equal(typeof healthJson.version, 'string')
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
    assert.equal(state.hostVersion, '0.2.2-rc.1')
    assert.equal(state.hosts.length, 1)
    assert.equal(state.firstRun, false)
    assert.ok(state.settings && typeof state.settings.defaultPort === 'number')
    assert.equal(state.hosts[0].status, 'unconfigured')
    assert.equal(state.hosts[0].error, null)
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

test('POST /downloads starts a job; status and cancel are separate', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const started = []
    let cancelled = null
    service.downloads = {
      start(runtime, path, options) {
        started.push({ runtimeId: runtime.id, path, destination: options?.destination })
        return {
          id: 'dl_1',
          hostId: runtime.id,
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
      },
      status(id) {
        return {
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
        }
      },
      cancel(id) {
        cancelled = id
        return true
      },
      dispose() {},
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
      body: JSON.stringify({ version: '0.2.2-rc.1' }),
    })
    assert.equal(version.status, 200)
    assert.equal(service.snapshot().hostVersion, '0.2.2-rc.1')
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
    assert.equal(result.json.plugin.version, '0.1.0')
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
    assert.equal(result.json.version, '0.1.0')
    assert.equal(result.json.apiVersion, '2.8')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

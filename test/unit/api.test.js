import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApi } from '../../src/api.js'
import { FakeSsh, createHost, makeTestService, waitFor } from '../helpers/fake-remote.js'

const HEADER = { 'x-dsh-remote-go': '1' }

/** @param {any} service @param {{ diagnostics?: () => Record<string, unknown> }} [options] */
async function startApi(service, options = {}) {
  /** @type {import('node:http').Server} */
  let server
  const api = createApi({
    service,
    getOrigin: () => {
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
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

/** @param {string} base @param {string} path @param {RequestInit} [init] */
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

    const keepalive = await call(api.base, `/hosts/${hostId}/keepalive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepAlive: 'idle', idleMinutes: 20 }),
    })
    assert.equal(keepalive.status, 200)
    assert.equal(keepalive.json.host.keepAlive, 'idle')
    assert.equal(keepalive.json.host.idleMinutes, 20)

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
    // EventSource cannot set the custom header: the origin fence alone must admit it.
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
    // v2.0 removes mirror/workspace endpoints; an unknown settings field is ignored.
    assert.equal(result.json.apiVersion, '2.0')
  } finally {
    await api.close()
    await service.shutdown()
  }
})

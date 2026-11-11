import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApi } from '../../src/api.js'
import { createSessionAdapter } from '../../src/session-adapter.js'
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

test('workspace inventory endpoints serve local and per-remote groups', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const local = await call(api.base, '/local/workspaces')
    assert.equal(local.status, 200)
    assert.equal(local.json.ok, true)
    assert.ok(Array.isArray(local.json.workspaces))

    const host = await createHost(service)
    const remote = await call(api.base, `/hosts/${host.id}/workspaces`)
    assert.equal(remote.status, 200)
    assert.equal(remote.json.ok, true)
    assert.equal(remote.json.connected, false)
    assert.deepEqual(remote.json.workspaces, [])
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('GET /hosts/:id/mirrors serves the persisted directory mirrors', async () => {
  const { service } = await makeTestService()
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    const before = await call(api.base, `/hosts/${host.id}/mirrors`)
    assert.equal(before.status, 200)
    assert.equal(before.json.ok, true)
    assert.equal(before.json.hostId, host.id)
    assert.equal(before.json.connected, false)
    assert.deepEqual(before.json.mirrors, [])
    // P0 verifies the directory channel only, so the honest level is L1.
    assert.equal(before.json.level, 'L1')
    assert.equal(before.json.capabilities.list, true)
    assert.equal(before.json.capabilities.stream, false)
    assert.equal(before.json.sessionsAvailable, false)

    await service.mirrorStore.upsertMirrors([
      { hostId: host.id, remoteSessionId: 'remote-1', title: 'Project A · remote-1', cursor: 7 },
      { hostId: 'h_other', remoteSessionId: 'remote-9', title: 'Other host mirror' },
    ])
    const after = await call(api.base, `/hosts/${host.id}/mirrors`)
    assert.equal(after.status, 200)
    assert.equal(after.json.mirrors.length, 1)
    const [mirror] = after.json.mirrors
    assert.equal(mirror.hostId, host.id)
    assert.equal(mirror.remoteSessionId, 'remote-1')
    assert.equal(mirror.title, 'Project A · remote-1')
    assert.equal(mirror.cursor, 7)
    assert.equal(mirror.status, 'active')
    assert.equal(mirror.capabilities.list, true)
    assert.equal(mirror.capabilities.stream, false)
    assert.match(mirror.localSessionId, /^mirror_[a-z0-9]{25}$/)
  } finally {
    await api.close()
    await service.shutdown()
  }
})

test('POST /hosts/:id/mirrors/sync exposes the restart re-pull notice', async () => {
  const stdout = JSON.stringify({
    global: { initialized: true, defaultWorkspaceId: 'ws-1', workspaceIds: ['ws-1'] },
    tables: { workspaces: { 'ws-1': { path: '/home/u/proj', title: 'proj', sessionIds: ['remote-1'] } } },
  })
  // A real adapter over an empty in-memory sessions store: the mirror session
  // does not exist (as after a restart), so the sync must report `resyncRequired`.
  const live = new Map()
  const sessions = {
    create(id) {
      const session = { id, append() {} }
      live.set(id, session)
      return session
    },
    get(id) {
      return live.get(id)
    },
  }
  const sessionAdapter = createSessionAdapter({ sessions, logger: { warn() {} } })
  const { service } = await makeTestService({
    sessionAdapter,
    sshFactory: (options) => new FakeSsh({ options, exec: async () => ({ code: 0, stdout, stderr: '' }) }),
  })
  const api = await startApi(service)
  try {
    const host = await createHost(service)
    await service.connect(host.id)
    await waitFor(() => service.snapshot().hosts[0].status === 'connected')
    await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 1)
    // Wait for the connect-time sync to finish before simulating the restart.
    await waitFor(() => !service.runtimes.get(host.id).mirrorSync)
    // Simulate a restart: the descriptor survives, the in-memory session does not.
    live.clear()
    const result = await call(api.base, `/hosts/${host.id}/mirrors/sync`, { method: 'POST' })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.synced, true)
    assert.equal(result.json.mirrors.length, 1)
    assert.equal(result.json.sessionsAvailable, true)
    // The local session persists nothing, so the API surfaces the re-pull path.
    assert.equal(result.json.resyncRequired, 1)
    assert.equal(result.json.sessions[0].resync.reason, 'local-session-missing')
    assert.match(result.json.notice.en, /re-pull/i)
    assert.equal(live.size, 1)
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
  } finally {
    await api.close()
    await service.shutdown()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeSsh, createHost, makeFacts, makeTestService, waitFor } from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'
import { createSessionAdapter } from '../../src/session-adapter.js'
import { RemoteGoService } from '../../src/service.js'
import { HostStore } from '../../src/store.js'
import { createWorkspaceAdapter } from '../../src/workspace-adapter.js'

/**
 * A `workspaceRegistry` double with the behaviour the plugin depends on:
 * idempotent create per canonical path, non-creating lookup, registration-only
 * delete. Service tests use it through the **real** adapter, so they exercise the
 * production path rather than a hand-written stub.
 */
function createFakeWorkspaceRegistry() {
  /** @type {Map<string, any>} */
  const byPath = new Map()
  /** @type {Map<string, any>} */
  const byId = new Map()
  /** @type {{ create: { path: string, title: string | undefined }[], delete: string[] }} */
  const calls = { create: [], delete: [] }
  let seq = 0
  /** @param {string} value */
  const key = (value) => path.resolve(value)
  const registry = {
    calls,
    async create(dir, title) {
      calls.create.push({ path: dir, title })
      const existing = byPath.get(key(dir))
      if (existing) return existing
      const workspace = {
        id: `ws_${(seq += 1)}`,
        path: key(dir),
        title: title ?? path.basename(dir),
        /** @type {string[]} */
        sessionIds: [],
        /** @param {string} next */
        async setTitle(next) {
          workspace.title = next
        },
      }
      byPath.set(workspace.path, workspace)
      byId.set(workspace.id, workspace)
      return workspace
    },
    async resolveByPath(dir) {
      return byPath.get(key(dir))
    },
    async delete(id) {
      calls.delete.push(id)
      const workspace = byId.get(id)
      if (!workspace) return false
      byId.delete(id)
      byPath.delete(workspace.path)
      return true
    },
    list() {
      return [...byId.values()]
    },
  }
  return { registry, calls }
}

/** @param {string} target */
async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

test('connect runs the full pipeline and opens a loopback URL', async () => {
  const { service, store } = await makeTestService()
  const host = await createHost(service)
  assert.equal(service.snapshot().hosts[0].status, 'unconfigured')

  const codes = []
  service.on('state', (state) => {
    const progress = state.hosts[0]?.progress?.code
    if (progress) codes.push(progress)
  })

  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })

  const view = service.snapshot().hosts[0]
  assert.equal(view.phase, 'ready')
  assert.equal(view.remote.uiReady, true)
  assert.equal(view.remote.version, '0.2.2-rc.1')
  assert.equal(view.remote.localPort, 45123)
  assert.equal(view.remote.bootstrapLevel, 'T0-local')
  assert.equal(view.progress.code, 'ready')
  assert.ok(codes.includes('ssh-connecting'))
  assert.ok(codes.includes('probing'))
  assert.ok(codes.includes('tunneling'))
  assert.ok(codes.includes('verifying'))

  const open = service.openInfo(host.id)
  assert.match(open.url, /^http:\/\/127\.0\.0\.1:45123\/\?token=tok_test_123$/)
  assert.equal(open.localPort, 45123)

  const persisted = store.getHost(host.id)
  assert.ok(persisted.lastOpenedAt, 'lastOpenedAt must be persisted')
  assert.equal(service.snapshot().activeHostId, host.id)
  const hostView = service.snapshot().hosts[0]
  assert.equal(hostView.authType, 'agent')
  assert.equal(hostView.jumpHost, null)
  assert.equal(hostView.warning, null)
  assert.equal(hostView.versionParity.status, 'same')
  await service.shutdown()
})

test('connect pauses on the first host key and resumes after confirmation', async () => {
  let sshInstance = null
  /** @type {{ sha256: string, keyType: string, pinned: boolean } | null} */
  let asked = null
  const { service, store } = await makeTestService({
    sshFactory: (options) => {
      const ssh = new FakeSsh({
        options,
        connect: async () => {
          const accepted = await options.onHostKey({ sha256: 'SHA256:abc123', keyType: 'ssh-ed25519', pinned: false })
          if (!accepted) throw errors.hostKeyUnknown('SHA256:abc123')
          ssh.connected = true
          return { fingerprint: 'SHA256:abc123', keyType: 'ssh-ed25519', serverBanner: null }
        },
      })
      ssh.onHostKeyProbe = options.onHostKey
      sshInstance = ssh
      asked = null
      return ssh
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'fingerprint-pending', { label: 'fingerprint-pending' })
  const pending = service.snapshot().hosts[0]
  assert.equal(pending.fingerprint.sha256, 'SHA256:abc123')
  assert.equal(pending.fingerprint.status, 'pending')

  await service.confirmFingerprint(host.id, { accept: true, remember: true, sha256: 'SHA256:abc123' })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected after confirm' })
  assert.equal(store.getHost(host.id).pinnedFingerprint, 'SHA256:abc123')
  assert.ok(sshInstance)
  await service.shutdown()
})

test('refusing the host key keeps the host in error state', async () => {
  const { service } = await makeTestService({
    sshFactory: (options) => {
      const ssh = new FakeSsh({
        options,
        connect: async () => {
          const accepted = await options.onHostKey({ sha256: 'SHA256:bad', keyType: 'ssh-ed25519', pinned: false })
          if (!accepted) throw errors.hostKeyUnknown('SHA256:bad')
          return { fingerprint: 'SHA256:bad', keyType: 'ssh-ed25519', serverBanner: null }
        },
      })
      return ssh
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'fingerprint-pending')
  await service.confirmFingerprint(host.id, { accept: false, remember: false })
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  assert.equal(service.snapshot().hosts[0].error.code, 'host-key-unknown')
  await service.shutdown()
})

test('a version mismatch is refused before starting, and can be overridden', async () => {
  const facts = makeFacts({ dshPath: '/usr/local/bin/dsh', dshVersion: '0.2.1', nodeVersion: '24.22.2' })
  const { service } = await makeTestService({ facts })
  const host = await createHost(service, {
    bootstrap: { mode: 'reuse', targetVersion: 'local', remoteDir: '~/.dsh-remote-go', nodeVersion: '24.22.2' },
  })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  assert.equal(service.snapshot().hosts[0].error.code, 'version-mismatch')

  await service.connect(host.id, { overrideVersion: true })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'override connect' })
  const view = service.snapshot().hosts[0]
  assert.equal(view.warning !== null, true)
  assert.equal(view.remote.version, '0.2.1')
  await service.shutdown()
})

test('an unreachable remote UI fails with a coded error and cleans the tunnel', async () => {
  const { service } = await makeTestService({
    waitUi: async () => ({ ok: false, status: null }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  assert.equal(service.snapshot().hosts[0].error.code, 'remote-ui-unreachable')
  await service.shutdown()
})

test('a blocked iframe is reported as a warning but keeps the connection', async () => {
  const { service } = await makeTestService({
    exchange: async () => ({
      ok: true,
      firstStatus: 302,
      cookieNames: ['dsh-auth-x'],
      location: './',
      status: 200,
      title: 'DSH',
      frameBlocked: true,
      xFrameOptions: 'DENY',
      csp: null,
      bodyLength: 100,
    }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.match(service.snapshot().hosts[0].warning.zh, /在新窗口打开/)
  await service.shutdown()
})

test('auto-reconnect retries after an unexpected SSH close', async () => {
  const { service, events } = await makeTestService()
  await service.saveSettings({ autoReconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 20 } })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.equal(events.filter((event) => event.type === 'ssh').length, 1)

  events[0].ssh.simulateClose()
  await waitFor(
    () => service.snapshot().hosts[0].status === 'disconnected' || service.snapshot().hosts[0].status === 'connecting',
    {
      label: 'disconnected',
    },
  )
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { timeoutMs: 8000, label: 'reconnected' })
  assert.ok(events.filter((event) => event.type === 'ssh').length >= 2)
  await service.shutdown()
})

test('disconnect honors the stop keep-alive policy', async () => {
  const stopped = []
  const { service } = await makeTestService({
    stopWeb: async () => {
      stopped.push(true)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service, { keepAlive: 'stop' })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await service.disconnect(host.id)
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(stopped.length, 1)
  await service.shutdown()
})

test('shutdown stops the remote only under the stop policy', async () => {
  const stopped = []
  const { service } = await makeTestService({
    stopWeb: async () => {
      stopped.push(true)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const keep = await createHost(service, { name: 'keep-host', address: 'keep-host', keepAlive: 'keep' })
  const stop = await createHost(service, { name: 'stop-host', address: 'stop-host', keepAlive: 'stop' })
  await service.connect(keep.id)
  await waitFor(() => service.snapshot().hosts.find((item) => item.id === keep.id).status === 'connected')
  await service.connect(stop.id)
  await waitFor(() => service.snapshot().hosts.find((item) => item.id === stop.id).status === 'connected')
  await service.shutdown()
  assert.equal(stopped.length, 1)
})

test('diagnose returns the documented checklist', async () => {
  const { service } = await makeTestService()
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const report = await service.diagnose(host.id)
  assert.equal(report.redacted, true)
  assert.deepEqual(
    report.checks.map((check) => check.id),
    [
      'ssh-reachable',
      'auth',
      'host-key',
      'tunnel',
      'remote-service',
      'remote-ui',
      'remote-version',
      'model-credentials',
      'desktop-guard',
    ],
  )
  assert.equal(report.checks.find((check) => check.id === 'remote-version').status, 'pass')
  assert.equal(report.checks.find((check) => check.id === 'ssh-reachable').status, 'pass')
  assert.equal(report.checks.find((check) => check.id === 'desktop-guard').status, 'pass')
  assert.equal(report.checks.find((check) => check.id === 'model-credentials').status, 'pass')
  // The session fingerprint is observed but not pinned yet, so the checklist is
  // honest about that rather than claiming an all-green result.
  assert.equal(report.checks.find((check) => check.id === 'host-key').status, 'unknown')
  assert.equal(report.summary, 'warning')
  await service.shutdown()
})

test('invalid host input is rejected as invalid-input', async () => {
  const { service } = await makeTestService()
  await assert.rejects(
    () => service.saveHost({ name: 'no address' }),
    (error) => error.code === 'invalid-input',
  )
})

test('saving and removing hosts updates the snapshot', async () => {
  const { service } = await makeTestService()
  const host = await createHost(service)
  assert.equal(service.snapshot().hosts.length, 1)
  assert.equal(service.snapshot().firstRun, false)
  await service.removeHost(host.id)
  assert.equal(service.snapshot().hosts.length, 0)
  assert.equal(service.snapshot().firstRun, true)
})

test('setLocalVersion enables local-version parity resolution', async () => {
  const { service } = await makeTestService({ localVersion: null })
  assert.equal(service.snapshot().hostVersion, null)
  service.setLocalVersion('v0.2.2-rc.1', 'client')
  assert.equal(service.snapshot().hostVersion, '0.2.2-rc.1')
  assert.equal(service.snapshot().targetVersion, '0.2.2-rc.1')
})

test('updateHostPolicy patches keep-alive fields', async () => {
  const { service, store } = await makeTestService()
  const host = await createHost(service)
  const view = await service.updateHostPolicy(host.id, { keepAlive: 'idle', idleMinutes: 45 })
  assert.equal(view.keepAlive, 'idle')
  assert.equal(view.idleMinutes, 45)
  assert.equal(store.getHost(host.id).keepAlive, 'idle')
})

test('listLocalWorkspaces reads the local DSH workspace registry', async () => {
  const { service, dir } = await makeTestService()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const home = path.join(dir, 'home')
  await mkdir(path.join(home, 'storages'), { recursive: true })
  await writeFile(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1', 'w2'] },
      tables: {
        workspaces: {
          w1: { path: '/p/one', title: 'one', sessionIds: [] },
          w2: { path: '/p/two', title: 'two', sessionIds: ['s'] },
        },
      },
    }),
    'utf8',
  )
  const result = await service.listLocalWorkspaces()
  assert.equal(result.workspaces.length, 2)
  assert.equal(result.workspaces[0].origin, 'local')
  assert.equal(result.workspaces[0].title, 'one')
  assert.equal(result.defaultWorkspaceId, 'w1')
})

test('listHostWorkspaces reports disconnected hosts without throwing', async () => {
  const { service } = await makeTestService()
  const host = await createHost(service)
  const result = await service.listHostWorkspaces(host.id)
  assert.equal(result.connected, false)
  assert.deepEqual(result.workspaces, [])
  assert.equal(result.hostId, host.id)
})

test('listHostWorkspaces reads the remote registry over the live SSH session', async () => {
  const { service } = await makeTestService()
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  const calls = []
  runtime.ssh.exec = async (command) => {
    calls.push(command)
    return {
      code: 0,
      stdout: JSON.stringify({
        global: { initialized: true, defaultWorkspaceId: 'r1', workspaceIds: ['r1'] },
        tables: { workspaces: { r1: { path: '/home/u/proj', title: 'remote project', sessionIds: ['a', 'b'] } } },
      }),
      stderr: '',
    }
  }
  const result = await service.listHostWorkspaces(host.id)
  assert.equal(result.connected, true)
  assert.equal(result.workspaces.length, 1)
  assert.equal(result.workspaces[0].origin, 'remote')
  assert.equal(result.workspaces[0].hostId, host.id)
  assert.equal(result.workspaces[0].sessionCount, 2)
  assert.match(calls[0], /storages\/workspace\.json/)
  await service.shutdown()
})

// ---------------------------------------------------------------- mirrors

/** Serialize a remote `storages/workspace.json` body. */
function remoteRegistry(workspaces) {
  return JSON.stringify({
    global: { initialized: true, defaultWorkspaceId: 'ws-1', workspaceIds: Object.keys(workspaces) },
    tables: { workspaces },
  })
}

/** A fake SSH whose only command answers the workspace registry read. */
function registrySshFactory(stdout) {
  return (options) => new FakeSsh({ options, exec: async () => ({ code: 0, stdout, stderr: '' }) })
}

test('connect mirrors the remote workspace directory into L1 descriptors', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  const { service } = await makeTestService({ sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  // The directory sync runs after `connected`, so wait for the persisted rows.
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2, { label: 'mirror sync' })

  const mirrors = service.mirrorStore.listMirrors({ hostId: host.id })
  assert.deepEqual(
    mirrors.map((mirror) => mirror.remoteSessionId),
    ['s-a', 's-b'],
  )
  assert.equal(
    mirrors.every((mirror) => mirror.status === 'active' && mirror.cursor === 0),
    true,
  )
  assert.equal(
    mirrors.every((mirror) => mirror.capabilities.list === true),
    true,
  )
  assert.equal(
    mirrors.every((mirror) => mirror.capabilities.stream === false),
    true,
  )
  assert.equal(mirrors[0].hostId, host.id)
  assert.match(mirrors[0].localSessionId, /^mirror_[a-z0-9]{25}$/)
  // mirroredAt records the successful directory read.
  assert.equal(typeof mirrors[0].mirroredAt, 'string')

  const listed = await service.listHostMirrors(host.id)
  assert.equal(listed.connected, true)
  assert.equal(listed.level, 'L1')
  assert.equal(listed.reason.code, 'history-unavailable')
  assert.equal(listed.sessionsAvailable, false)
  assert.equal(listed.mirrors.length, 2)
  await service.shutdown()
})

test('a parseable empty registry is treated as transient, never as mass deletion', async () => {
  let payload = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  const sshFactory = (options) => new FakeSsh({ options, exec: async () => ({ code: 0, stdout: payload, stderr: '' }) })
  const { service } = await makeTestService({ sshFactory })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2)

  // A fresh/partially-written remote registry parses but lists nothing.
  payload = remoteRegistry({})
  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.synced, false)
  assert.equal(synced.reason, 'empty-registry')
  const kept = service.mirrorStore.listMirrors({ hostId: host.id })
  assert.equal(kept.length, 2)
  assert.equal(
    kept.every((mirror) => mirror.status === 'active'),
    true,
  )
  await service.shutdown()
})

test('the connect pipeline does not wait for the directory sync', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a'] },
  })
  // A slow remote read must not delay the ready state or the connect response.
  const sshFactory = (options) =>
    new FakeSsh({
      options,
      exec: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return { code: 0, stdout, stderr: '' }
      },
    })
  const { service } = await makeTestService({ sshFactory })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  // The sync is in flight and is not part of the connect promise.
  assert.ok(runtime.mirrorSync, 'the mirror sync should still be running')
  assert.equal(service.mirrorStore.listMirrors({ hostId: host.id }).length, 0)
  await runtime.mirrorSync
  assert.equal(service.mirrorStore.listMirrors({ hostId: host.id }).length, 1)
  await service.shutdown()
})

test('typed mirror-session failures are counted and logged, not swallowed', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  const sessionAdapter = {
    ensureMirrorSession(descriptor) {
      if (descriptor.remoteSessionId === 's-a') {
        return { ok: true, created: true, localSessionId: descriptor.localSessionId }
      }
      return { ok: false, reason: 'sessions-unavailable', localSessionId: descriptor.localSessionId }
    },
  }
  const { service } = await makeTestService({ sessionAdapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2)
  const runtime = service.runtimes.get(host.id)
  await waitFor(() => runtime.logs.some((entry) => entry.line.includes('mirror sessions:')))
  const info = runtime.logs.find((entry) => entry.line.includes('mirror sessions:'))
  assert.match(info.line, /2 descriptor\(s\) \/ 1 local session\(s\)/)
  assert.match(info.line, /sessions-unavailable/)
  assert.equal(
    runtime.logs.some((entry) => entry.line.includes('mirror session failure reasons:')),
    true,
  )
  await service.shutdown()
})

test('removing a host asks the adapter to remove its local mirror sessions', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  /** @type {string[]} */
  const removed = []
  const sessionAdapter = {
    ensureMirrorSession: (descriptor) => ({ ok: true, created: true, localSessionId: descriptor.localSessionId }),
    removeMirrorSession: (localSessionId) => {
      removed.push(localSessionId)
      return { ok: true, removed: false, reason: 'fiber-owned' }
    },
  }
  const { service } = await makeTestService({ sessionAdapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2)
  const mirrorIds = service.mirrorStore.listMirrors({ hostId: host.id }).map((mirror) => mirror.localSessionId)

  await service.removeHost(host.id)
  assert.deepEqual(removed.sort(), mirrorIds.sort())
  assert.equal(service.mirrorStore.listMirrors({ hostId: host.id }).length, 0)
  await service.shutdown()
})

test('removing a host actually drops local sessions when the host can delete them', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  // A real adapter over a fake `sessions` service that supports removal.
  /** @type {Map<string, any>} */
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
    remove(id) {
      live.delete(id)
    },
  }
  const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-mirror-cwd-'))
  const sessionAdapter = createSessionAdapter({ sessions, logger: { warn() {} }, mirrorRoot })
  const { service } = await makeTestService({ sessionAdapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => live.size === 2, { label: 'two live mirror sessions' })
  // The per-host cwd exists (the host keys storage off it).
  assert.equal(await pathExists(path.join(mirrorRoot, host.id)), true)

  await service.removeHost(host.id)
  assert.equal(live.size, 0, 'the local mirror sessions must be gone, not just reported')
  await service.shutdown()
})

test('connect registers one sidebar workspace per host with the host name', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  /** @type {{ hostId?: string, hostName?: string, enabled?: boolean }[]} */
  const calls = []
  const workspaceAdapter = {
    async ensureHostWorkspace(request) {
      calls.push(request)
      return {
        ok: true,
        enabled: true,
        reason: null,
        hostId: request.hostId,
        path: `/mirrors/${request.hostId}`,
        title: `Remote: ${request.hostName}`,
        workspaceId: 'ws_mirror',
        created: true,
        renamed: false,
      }
    },
  }
  const { service } = await makeTestService({
    workspaceAdapter,
    sessionAdapter: {
      ensureMirrorSession: (descriptor) => ({ ok: true, created: true, localSessionId: descriptor.localSessionId }),
    },
    sshFactory: registrySshFactory(stdout),
  })
  const host = await createHost(service)
  const synced0 = await service.connect(host.id)
  assert.equal(synced0.accepted, true)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2)
  await waitFor(() => calls.length > 0, { label: 'the sidebar workspace registration' })

  assert.equal(calls[0].hostId, host.id)
  assert.equal(calls[0].hostName, host.name)
  assert.equal(calls[0].enabled, true)

  // The sync response exposes what the sidebar registration did, so the client
  // (and this test) never has to guess.
  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.sidebar.ok, true)
  assert.equal(synced.sidebar.workspaceId, 'ws_mirror')
  assert.equal(synced.sidebar.title, `Remote: ${host.name}`)
  await service.shutdown()
})

test('mirrorToSidebar:false unregisters the group a host already registered', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a'] },
  })
  // The real adapter over a fake registry: this proves the whole chain
  // settings -> service -> registry delete, not just that a call was attempted.
  const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-sidebar-off-'))
  const { registry, calls } = createFakeWorkspaceRegistry()
  const workspaceAdapter = createWorkspaceAdapter({ registry, mirrorRoot })
  const { service } = await makeTestService({
    workspaceAdapter,
    sessionAdapter: {
      ensureMirrorSession: (descriptor) => ({ ok: true, created: true, localSessionId: descriptor.localSessionId }),
    },
    sshFactory: registrySshFactory(stdout),
  })
  const host = await createHost(service)
  try {
    await service.connect(host.id)
    await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 1)
    await waitFor(() => registry.list().length === 1, { label: 'the sidebar registration' })

    // Turning the toggle off must actually remove the "Remote: …" group.
    await service.saveSettings({ mirrorToSidebar: false })
    const synced = await service.syncHostMirrors(host.id)
    assert.equal(synced.synced, true)
    assert.equal(synced.sidebar.enabled, false)
    assert.equal(synced.sidebar.reason, 'disabled')
    assert.equal(synced.sidebar.removed, true)
    assert.equal(registry.list().length, 0, 'the group is gone from the sidebar')
    assert.equal(calls.delete.length, 1)
    assert.equal((await stat(path.join(mirrorRoot, host.id))).isDirectory(), true, 'the directory is retained')

    // Idempotent: nothing left to remove on the next sync.
    const again = await service.syncHostMirrors(host.id)
    assert.equal(again.sidebar.reason, 'disabled')
    assert.equal(again.sidebar.removed, false)
    assert.equal(calls.delete.length, 1)

    // Re-enabling restores the group on the next sync.
    await service.saveSettings({ mirrorToSidebar: true })
    const restored = await service.syncHostMirrors(host.id)
    assert.equal(restored.sidebar.ok, true)
    assert.equal(restored.sidebar.created, true)
    assert.equal(registry.list().length, 1)
  } finally {
    await service.shutdown()
    await rm(mirrorRoot, { recursive: true, force: true })
  }
})

test('removing a host removes its sidebar workspace registration', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a'] },
  })
  /** @type {string[]} */
  const removed = []
  const workspaceAdapter = {
    ensureHostWorkspace: async () => ({ ok: true, enabled: true, workspaceId: 'ws_mirror' }),
    removeHostWorkspace: async (request) => {
      removed.push(request.hostId)
      return { ok: true, removed: true, workspaceId: 'ws_mirror', path: '/mirrors/x' }
    },
  }
  const { service } = await makeTestService({ workspaceAdapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 1)

  await service.removeHost(host.id)
  assert.deepEqual(removed, [host.id])
  await service.shutdown()
})

test('a throwing workspace adapter cannot fail the sync or the host removal', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a'] },
  })
  const workspaceAdapter = {
    ensureHostWorkspace: async () => {
      throw new Error('registry exploded')
    },
    removeHostWorkspace: async () => {
      throw new Error('delete exploded')
    },
  }
  const { service } = await makeTestService({
    workspaceAdapter,
    sessionAdapter: {
      ensureMirrorSession: (descriptor) => ({ ok: true, created: true, localSessionId: descriptor.localSessionId }),
    },
    sshFactory: registrySshFactory(stdout),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 1)

  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.synced, true, 'a sidebar failure must not roll back the directory sync')
  assert.equal(synced.sidebar.ok, false)
  assert.equal(synced.sidebar.reason, 'adapter-error')
  const runtime = service.runtimes.get(host.id)
  assert.equal(
    runtime.logs.some((entry) => entry.line.includes('mirror sidebar workspace ensureHostWorkspace failed')),
    true,
  )

  // Host removal must complete too (the mirror rows are what really matter).
  const removedHost = await service.removeHost(host.id)
  assert.equal(removedHost.ok, true)
  assert.equal(service.mirrorStore.listMirrors({ hostId: host.id }).length, 0)
  await service.shutdown()
})

test('without a sessions service no empty sidebar group is created', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a'] },
  })
  /** @type {any[]} */
  const calls = []
  const workspaceAdapter = {
    async ensureHostWorkspace(request) {
      calls.push(request)
      return { ok: true, enabled: true, workspaceId: 'ws_mirror' }
    },
  }
  const { service } = await makeTestService({ workspaceAdapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 1)

  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.sidebar.reason, 'sessions-unavailable')
  assert.deepEqual(calls, [])
  await service.shutdown()
})

test('a sync where every session create fails registers no empty group', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-sidebar-nosessions-'))
  const { registry } = createFakeWorkspaceRegistry()
  const workspaceAdapter = createWorkspaceAdapter({ registry, mirrorRoot })
  /** @type {any[]} */
  const ensured = []
  const sessionAdapter = {
    ensureMirrorSession(descriptor) {
      ensured.push(descriptor)
      return { ok: false, reason: 'create-failed', localSessionId: descriptor.localSessionId }
    },
  }
  const { service } = await makeTestService({
    workspaceAdapter,
    sessionAdapter,
    sshFactory: registrySshFactory(stdout),
  })
  const host = await createHost(service)
  try {
    await service.connect(host.id)
    await waitFor(() => ensured.length === 2, { label: 'the failing session creates' })
    const synced = await service.syncHostMirrors(host.id)
    assert.equal(synced.synced, true)
    // `sessions-unavailable` is the documented meaning "no local session to
    // group", so no workspace may be registered here.
    assert.equal(synced.sidebar.reason, 'sessions-unavailable')
    assert.equal(synced.sidebar.ok, true)
    assert.deepEqual(synced.sidebar.path, null)
    assert.equal(registry.list().length, 0, 'an empty group must not be registered')
  } finally {
    await service.shutdown()
    await rm(mirrorRoot, { recursive: true, force: true })
  }
})

test('init sweeps sidebar registrations whose host no longer exists', async () => {
  const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-sidebar-sweep-'))
  const { registry, calls } = createFakeWorkspaceRegistry()
  const workspaceAdapter = createWorkspaceAdapter({ registry, mirrorRoot })
  // A ghost left behind by an earlier failed unregister.
  await registry.create(path.join(mirrorRoot, 'h_deleted'), 'Remote: deleted host')
  /** @type {any[]} */
  const swept = []
  const recording = {
    ...workspaceAdapter,
    async pruneOrphanWorkspaces(request) {
      swept.push(request)
      return await workspaceAdapter.pruneOrphanWorkspaces(request)
    },
  }
  const { service, dir } = await makeTestService({ workspaceAdapter: recording })
  const host = await createHost(service)
  const quiet = { warn() {}, info() {}, debug() {}, error() {} }
  try {
    // `makeTestService` already awaited init; at that point no host was persisted,
    // so every registration under the root was an orphan.
    assert.equal(swept.length, 1, 'init must sweep exactly once')
    assert.deepEqual(swept[0].hostIds, [])
    assert.equal(registry.list().length, 0, 'the ghost registration is gone')
    assert.equal(calls.delete.length, 1)

    // A later init (same persisted store, now with a host) keeps that host's
    // group and has nothing left to prune.
    const ensured = await workspaceAdapter.ensureHostWorkspace({ hostId: host.id, hostName: host.name })
    assert.equal(ensured.ok, true)
    const store = new HostStore({ dir, logger: quiet })
    await store.load()
    const reloaded = new RemoteGoService({ store, home: dir, logger: quiet, workspaceAdapter: recording })
    await reloaded.init()
    assert.equal(swept.length, 2)
    assert.deepEqual(swept[1].hostIds, [host.id], 'the persisted host is known to the sweep')
    assert.deepEqual(
      registry.list().map((workspace) => workspace.id),
      [ensured.workspaceId],
      'a live host keeps its group',
    )
  } finally {
    await service.shutdown()
    await rm(mirrorRoot, { recursive: true, force: true })
  }
})

test('a failing orphan sweep is logged and never blocks init', async () => {
  const warnings = []
  const workspaceAdapter = {
    async pruneOrphanWorkspaces() {
      throw new Error('sweep exploded')
    },
  }
  const { service } = await makeTestService({
    workspaceAdapter,
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), info() {}, debug() {}, error() {} },
  })
  assert.equal(service.initialized, true, 'init completed despite the sweep failure')
  await service.shutdown()
  assert.equal(
    warnings.some((line) => line.includes('cannot prune orphan mirror workspaces')),
    true,
  )
})

test('a sweep that reports a typed failure is surfaced without throwing', async () => {
  const warnings = []
  const workspaceAdapter = {
    pruneOrphanWorkspaces: async () => ({ ok: false, reason: 'workspaces-unavailable', removed: [], kept: 0 }),
  }
  const { service } = await makeTestService({
    workspaceAdapter,
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), info() {}, debug() {}, error() {} },
  })
  assert.equal(service.initialized, true)
  await service.shutdown()
  assert.equal(
    warnings.some((line) => line.includes('workspaces-unavailable')),
    true,
  )
})

test('syncHostMirrors keeps and marks a session the remote deleted', async () => {
  let sessionIds = ['s-a', 's-b']
  const commands = []
  const sshFactory = (options) =>
    new FakeSsh({
      options,
      exec: async (command) => {
        commands.push(command)
        const stdout = remoteRegistry({
          'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds },
        })
        return { code: 0, stdout, stderr: '' }
      },
    })
  const { service } = await makeTestService({ sshFactory })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2)

  sessionIds = ['s-a']
  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.synced, true)
  assert.deepEqual(synced.markedDeleted, ['s-b'])
  const kept = service.mirrorStore.listMirrors({ hostId: host.id })
  assert.equal(kept.length, 2)
  assert.equal(kept.find((mirror) => mirror.remoteSessionId === 's-b').status, 'remote-deleted')
  // The plugin only ever read the registry; it never asked the remote to delete.
  assert.equal(
    commands.every((command) => command.startsWith('cat ')),
    true,
  )
  await service.shutdown()
})

test('mirror sessions are created only when the optional sessions adapter is injected', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  /** @type {any[]} */
  const ensured = []
  const sessionAdapter = {
    ensureMirrorSession(descriptor) {
      ensured.push(descriptor)
      return { ok: true, created: true, localSessionId: descriptor.localSessionId }
    },
  }
  const { service } = await makeTestService({ sessionAdapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => ensured.length === 2, { label: 'adapter calls' })
  assert.deepEqual(
    ensured.map((descriptor) => descriptor.remoteSessionId),
    ['s-a', 's-b'],
  )
  assert.equal(
    ensured.every((descriptor) => descriptor.status === 'active'),
    true,
  )
  await service.shutdown()
})

test('without the optional sessions adapter the mirror stays directory-only', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a'] },
  })
  const { service } = await makeTestService({ sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 1)
  assert.equal(service.sessionAdapter, null)
  assert.equal(service.mirrorStore.listMirrors({ hostId: host.id }).length, 1)
  await service.shutdown()
})

// ------------------------------------------------- L2 preflight: descriptors

/** A live-session adapter double: records creates/removals and answers liveness. */
function createLiveMirrorAdapter() {
  /** @type {Map<string, any>} */
  const live = new Map()
  /** @type {string[]} */
  const created = []
  /** @type {string[]} */
  const removed = []
  return {
    live,
    created,
    removed,
    ensureMirrorSession(descriptor) {
      created.push(descriptor.localSessionId)
      live.set(descriptor.localSessionId, {})
      return { ok: true, created: true, localSessionId: descriptor.localSessionId }
    },
    hasMirrorSession(localSessionId) {
      return live.has(localSessionId)
    },
    removeMirrorSession(localSessionId) {
      removed.push(localSessionId)
      live.delete(localSessionId)
      return { ok: true, removed: true, reason: null }
    },
  }
}

test('a version mismatch is annotated on every mirrored session, not just the host', async () => {
  const facts = makeFacts({ dshPath: '/usr/local/bin/dsh', dshVersion: '0.2.1', nodeVersion: '24.22.2' })
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b'] },
  })
  const { service } = await makeTestService({ facts, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service, {
    bootstrap: { mode: 'reuse', targetVersion: 'local', remoteDir: '~/.dsh/remote-go', nodeVersion: '24.22.2' },
  })
  await service.connect(host.id, { overrideVersion: true })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 2)

  const listed = await service.listHostMirrors(host.id)
  assert.equal(listed.level, 'L1')
  assert.equal(listed.reason.code, 'version-mismatch')
  for (const mirror of listed.mirrors) {
    assert.equal(mirror.level, 'L1')
    assert.equal(mirror.reason.code, 'version-mismatch')
    assert.equal(typeof mirror.reason.message.zh, 'string')
    assert.equal(typeof mirror.reason.message.en, 'string')
  }
  await service.shutdown()
})

test('mirrorMaxSessions caps creation and reports truncated/skipped', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b', 's-c'] },
  })
  const adapter = createLiveMirrorAdapter()
  const { service } = await makeTestService({ sessionAdapter: adapter, sshFactory: registrySshFactory(stdout) })
  await service.saveSettings({ mirrorMaxSessions: 2 })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await waitFor(() => service.mirrorStore.listMirrors({ hostId: host.id }).length === 3)
  await waitFor(() => adapter.live.size === 2, { label: 'capped session creation' })

  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.synced, true)
  assert.equal(synced.sessionLimit, 2)
  assert.equal(synced.truncated, 1)
  assert.equal(synced.skipped, 1)
  assert.equal(synced.sessions.length, 2)
  assert.equal(adapter.live.size, 2)
  assert.equal(new Set(adapter.created).size, 2)
  await service.shutdown()
})

test('lowering mirrorMaxSessions never orphans a session it already created', async () => {
  const stdout = remoteRegistry({
    'ws-1': { path: '/home/u/proj', title: 'remote project', sessionIds: ['s-a', 's-b', 's-c'] },
  })
  const adapter = createLiveMirrorAdapter()
  const { service } = await makeTestService({ sessionAdapter: adapter, sshFactory: registrySshFactory(stdout) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await waitFor(() => adapter.live.size === 3, { label: 'three sessions created under the default cap' })

  await service.saveSettings({ mirrorMaxSessions: 1 })
  const synced = await service.syncHostMirrors(host.id)
  assert.equal(synced.sessionLimit, 1)
  assert.equal(synced.truncated, 2)
  assert.equal(synced.skipped, 0, 'sessions created earlier are not skipped work')
  assert.deepEqual(adapter.removed, [])
  assert.equal(adapter.live.size, 3)
  await service.shutdown()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeSsh, createHost, makeFacts, makeTestService, waitFor } from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'
import { createSessionAdapter } from '../../src/session-adapter.js'

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

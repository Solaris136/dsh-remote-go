import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSsh, createHost, makeFacts, makeTestService, waitFor } from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'

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
  const host = await createHost(service, { bootstrap: { mode: 'reuse', targetVersion: 'local', remoteDir: '~/.dsh-remote-go', nodeVersion: '24.22.2' } })
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
  await waitFor(() => service.snapshot().hosts[0].status === 'disconnected' || service.snapshot().hosts[0].status === 'connecting', {
    label: 'disconnected',
  })
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
    ['ssh-reachable', 'auth', 'host-key', 'tunnel', 'remote-service', 'remote-ui', 'remote-version', 'model-credentials', 'desktop-guard'],
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
  await assert.rejects(() => service.saveHost({ name: 'no address' }), (error) => error.code === 'invalid-input')
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



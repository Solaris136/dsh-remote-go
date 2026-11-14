import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { FakeSsh, createHost, makeFacts, makeTestService, managedNodeFixture, waitFor } from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'
import { RemoteGoService, describePreflightEvent } from '../../src/service.js'
import { HostStore } from '../../src/store.js'
import { LOG_TAIL_LIMIT } from '../../src/connect-log.js'

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
  assert.equal(view.remote.bootstrapLevel, 'npx')
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
  assert.equal(hostView.authType, 'key')
  assert.equal(hostView.jumpHost, null)
  assert.equal(hostView.warning, null)
  assert.equal(hostView.versionParity.status, 'same')
  await service.shutdown()
})

test('connect always launches on the plugin-managed Node', async () => {
  /** @type {any[]} */
  const provisining = []
  /** @type {any[]} */
  const plans = []
  const { service } = await makeTestService({
    ensureNode: async (_ssh, options) => {
      provisining.push({ facts: options.facts.nodeVersion, version: options.version })
      return managedNodeFixture(options.version)
    },
    startWeb: async (_ssh, options) => {
      plans.push(options.plan)
      return {
        pid: 4242,
        port: 38123,
        token: 'tok_test_123',
        url: 'http://127.0.0.1:38123/?token=tok_test_123',
        logPath: '/tmp/web.log',
        startedAt: new Date().toISOString(),
        rawLine: '',
        profile: 'web',
        dshHome: '/home/ubuntu/.dsh',
      }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })

  const view = service.snapshot().hosts[0]
  // The remote already had a supported Node; the plugin still provisions its own,
  // so a shared system/nvm runtime can never leak into the remote DSH.
  assert.deepEqual(provisining, [{ facts: '24.22.2', version: '24.9.0' }])
  assert.equal(view.remote.nodeSource, 'managed')
  assert.equal(view.remote.nodeVersion, '24.9.0')
  assert.equal(plans.length, 1)
  assert.equal(plans[0].start.npxPath, '/home/ubuntu/.dsh/remote-go/node/v24.9.0/bin/npx')
  assert.equal(plans[0].start.nodeBinDir, '/home/ubuntu/.dsh/remote-go/node/v24.9.0/bin')
  await service.shutdown()
})

test('the managed Node version follows the local DSH engines.node', async () => {
  /** @type {string[]} */
  const versions = []
  const { service } = await makeTestService({
    engineNodeRange: '>=25.1.0',
    ensureNode: async (_ssh, options) => {
      versions.push(options.version)
      return managedNodeFixture(options.version)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  assert.deepEqual(versions, ['25.1.0'])
  await service.shutdown()
})

test('a failed managed install is fatal even when the system Node looks usable', async () => {
  const { service } = await makeTestService({
    // The system Node is perfectly fine; strict mode must not fall back to it.
    facts: makeFacts({ nodeVersion: '24.22.2', npxPath: '/usr/bin/npx' }),
    ensureNode: async () => {
      throw errors.nodeInstallFailed({ zh: '下载失败', en: 'download failed' }, { technical: 'network blocked' })
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'error' })

  const view = service.snapshot().hosts[0]
  assert.equal(view.error.code, 'remote-node-install-failed')
  await service.shutdown()
})

test('describePreflightEvent turns npm output into localized progress codes', () => {
  assert.deepEqual(
    describePreflightEvent(
      '\u001B[33mnpm WARN exec The following package was not found and will be installed\u001B[39m',
      '0.2.2-rc.1',
    ),
    { code: 'bootstrap-first-run', params: { version: '0.2.2-rc.1' } },
  )
  assert.deepEqual(
    describePreflightEvent('npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh', 'x'),
    { code: 'bootstrap-fetching' },
  )
  assert.deepEqual(describePreflightEvent('added 120 packages in 8s', 'x'), { code: 'bootstrap-installed' })
  // The version line is the success signal, not a progress message.
  assert.equal(describePreflightEvent('0.2.2-rc.1', 'x'), null)
  assert.equal(describePreflightEvent('   ', 'x'), null)
  assert.deepEqual(describePreflightEvent('some other line', 'x'), {
    code: 'bootstrap-progress',
    params: { detail: 'some other line' },
  })
})

test('the connect log streams to /state while connecting and stops once the host is up', async () => {
  /** @type {() => void} */
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service } = await makeTestService({
    ensureNode: async (_ssh, options) => {
      // Hold the pipeline mid-connect so the log tail can be inspected in flight.
      await gate
      return managedNodeFixture(options.version)
    },
  })
  /** @type {any[]} */
  const frames = []
  service.on('state', (state) => frames.push(state))
  const host = await createHost(service)
  const connecting = service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connecting', { label: 'connecting' })
  await waitFor(() => (service.snapshot().hosts[0].logs ?? []).length >= 2, { label: 'two log lines' })

  const live = service.snapshot().hosts[0]
  assert.ok(live.logs.length > 0, 'a connecting host must carry its log tail')
  for (const entry of live.logs) {
    assert.equal(typeof entry.seq, 'number')
    assert.equal(typeof entry.at, 'string')
    assert.equal(typeof entry.level, 'string')
    assert.equal(typeof entry.message, 'string')
  }
  const seqs = live.logs.map((entry) => entry.seq)
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    'the log keeps the order it was written in',
  )
  assert.equal(new Set(seqs).size, seqs.length, 'every line has its own seq')
  // The lines are the real steps, not a synthetic summary.
  const text = live.logs.map((entry) => entry.message).join('\n')
  assert.match(text, /^connect: /m)
  assert.match(text, /SSH connected to /)
  assert.match(text, /probe: /)
  // Some frame carried the log: that is what keeps the console live.
  assert.ok(
    frames.some((frame) => (frame.hosts[0]?.logs ?? []).length > 0),
    'expected a /state frame carrying the connect log',
  )

  release()
  await connecting
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  // The window is gone with the connection, so the tail is not shipped any more.
  assert.deepEqual(service.snapshot().hosts[0].logs, [])
  await service.shutdown()
})

test('the connect log is capped while the ring keeps the newest lines', async () => {
  const { service } = await makeTestService({
    ensureNode: async () => {
      throw errors.nodeInstallFailed({ zh: '下载失败', en: 'download failed' }, { technical: 'blocked' })
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'error' })
  const failed = service.snapshot().hosts[0]
  // A failure keeps the log on screen: the reason and the lines before it are one story.
  assert.ok(failed.logs.length > 0)
  assert.ok(failed.logs.length <= LOG_TAIL_LIMIT)
  assert.match(failed.error.code, /node-install-failed/)
  await service.shutdown()
})
test('the npx preflight reports npm output as connect progress', async () => {
  const { service } = await makeTestService({
    preflight: async (_ssh, _plan, options) => {
      options.onStderr('npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh\n')
      return '0.2.2-rc.1'
    },
  })
  /** @type {any[]} */
  const progress = []
  service.on('state', (state) => {
    const line = state.hosts[0]?.progress
    if (line) progress.push(line)
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const streamed = progress.find((entry) => entry.code === 'bootstrap-fetching')
  assert.ok(streamed, 'expected a bootstrap-fetching progress entry')
  await service.shutdown()
})

test('a remote web instance from an older launch path is replaced before starting', async () => {
  /** @type {number[]} */
  const stopped = []
  const { service } = await makeTestService({
    // The registry row is valid, but it predates the browser-carrier launch tag.
    readRegistry: async () => ({
      pid: 777,
      port: 39123,
      profile: 'web',
      dshHome: '/home/ubuntu/.dsh',
      version: '0.2.2-rc.1',
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options.pid)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  assert.deepEqual(stopped, [777])
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

test('the npx preflight refuses a different version before starting the remote', async () => {
  let started = 0
  const { service } = await makeTestService({
    preflight: async () => {
      throw errors.versionMismatch('0.2.2-rc.1', '0.2.1')
    },
    startWeb: async () => {
      started += 1
      return {
        pid: 1,
        port: 1,
        token: 't',
        url: 'http://127.0.0.1:1/?token=t',
        logPath: '/tmp/x',
        startedAt: new Date().toISOString(),
        rawLine: '',
        profile: 'web',
        dshHome: '/home/ubuntu/.dsh',
      }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  assert.equal(service.snapshot().hosts[0].error.code, 'version-mismatch')
  assert.equal(started, 0)
  await service.shutdown()
})

test('a stale adopted instance is stopped before the pinned version starts', async () => {
  const stopped = []
  const { service } = await makeTestService({
    adopt: async () => ({
      pid: 77,
      port: 4000,
      token: 'old',
      url: 'http://127.0.0.1:4000/?token=old',
      version: '0.0.1-old',
      profile: 'web',
      dshHome: '/home/ubuntu/.dsh',
      adopted: true,
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(stopped, [77])
  assert.equal(service.snapshot().hosts[0].remote.version, '0.2.2-rc.1')
  await service.shutdown()
})

test('a foreign remote DSH pauses the pipeline and cancel aborts the connect', async () => {
  let started = 0
  const { service } = await makeTestService({
    readRegistry: async () => null,
    findForeign: async () => ({
      ok: true,
      processes: [{ pid: 77, command: '/usr/local/bin/dsh --profile web --no-open' }],
    }),
    startWeb: async () => {
      started += 1
      throw new Error('must not start')
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'conflict-pending')
  const pending = service.snapshot().hosts[0]
  assert.equal(pending.conflict.processes[0].pid, 77)
  assert.equal(pending.progress.code, 'remote-dsh-running')
  await service.confirmConflict(host.id, { action: 'cancel' })
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  assert.equal(service.snapshot().hosts[0].error.code, 'remote-dsh-running')
  assert.equal(started, 0)
  await service.shutdown()
})

test('a foreign remote DSH can be stopped and then the managed instance starts', async () => {
  const stopped = []
  const { service } = await makeTestService({
    readRegistry: async () => null,
    findForeign: async () => ({ ok: true, processes: [{ pid: 88, command: 'dsh web' }] }),
    stopForeign: async (_ssh, processes) => {
      stopped.push(...processes.map((process) => process.pid))
      return { ok: true, alive: [], output: 'STOPPED' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'conflict-pending')
  await service.confirmConflict(host.id, { action: 'stop' })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(stopped, [88])
  assert.equal(service.snapshot().hosts[0].remote.version, '0.2.2-rc.1')
  await service.shutdown()
})

test('a foreign remote DSH can be kept alongside with a warning', async () => {
  let stopped = 0
  const { service } = await makeTestService({
    readRegistry: async () => null,
    findForeign: async () => ({ ok: true, processes: [{ pid: 99, command: 'dsh web' }] }),
    stopForeign: async () => {
      stopped += 1
      return { ok: true, alive: [], output: 'STOPPED' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'conflict-pending')
  await service.confirmConflict(host.id, { action: 'alongside' })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.equal(stopped, 0)
  assert.ok(service.snapshot().hosts[0].warning)
  await service.shutdown()
})

test('the conflict prompt ignores the plugin-owned registry pid', async () => {
  let scanned = null
  const { service } = await makeTestService({
    readRegistry: async () => ({ pid: 123, dshHome: '/home/ubuntu/.dsh', profile: 'web' }),
    findForeign: async (_ssh, options) => {
      scanned = options
      return { ok: true, processes: [] }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(scanned.ignorePids, [123])
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

test('a page that refuses framing still connects cleanly and reports no warning', async () => {
  // The remote UI is rendered by the desktop guest, never embedded in a frame, so
  // X-Frame-Options / CSP are irrelevant: such a host must connect exactly like any
  // other, with no "blocked embedding" warning left over from the iframe era.
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
  const view = service.snapshot().hosts[0]
  assert.equal(view.warning, null, 'framing headers must not produce a warning any more')
  assert.equal(view.remote.uiReady, true)
  const report = await service.diagnose(host.id)
  const remoteUi = report.checks.find((check) => check.id === 'remote-ui')
  assert.equal(remoteUi.status, 'pass', 'a framing-refusing page is still a reachable remote UI')
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
      'remote-node',
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

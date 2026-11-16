import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { FakeSsh, createHost, makeFacts, makeTestService, managedNodeFixture, waitFor } from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'
import { describePreflightEvent } from '../../src/service.js'
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
  assert.equal(open.webUrl, `/dsh-remote-go/remote/${host.id}/?token=tok_test_123`)
  assert.equal(open.localPort, 45123)
  // The same-origin proxy reads the live tunnel (and the remote's own port for Host rewriting).
  assert.deepEqual(service.webViewTarget(host.id), { localPort: 45123, remotePort: 38123 })
  assert.equal(service.webViewTarget('h_missing'), null)
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
  const provisining = []
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
  assert.deepEqual(provisining, [{ facts: '24.22.2', version: '24.9.0' }])
  assert.equal(view.remote.nodeSource, 'managed')
  assert.equal(view.remote.nodeVersion, '24.9.0')
  assert.equal(plans.length, 1)
  assert.equal(plans[0].start.npxPath, '/home/ubuntu/.dsh/remote-go/node/v24.9.0/bin/npx')
  assert.equal(plans[0].start.nodeBinDir, '/home/ubuntu/.dsh/remote-go/node/v24.9.0/bin')
  await service.shutdown()
})

test('the managed Node version follows the local DSH engines.node', async () => {
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
  assert.equal(describePreflightEvent('0.2.2-rc.1', 'x'), null)
  assert.equal(describePreflightEvent('   ', 'x'), null)
  assert.deepEqual(describePreflightEvent('some other line', 'x'), {
    code: 'bootstrap-progress',
    params: { detail: 'some other line' },
  })
})

test('the connect log streams to /state while connecting and stops once the host is up', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service } = await makeTestService({
    ensureNode: async (_ssh, options) => {
      await gate
      return managedNodeFixture(options.version)
    },
  })
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
  const text = live.logs.map((entry) => entry.message).join('\n')
  assert.match(text, /^connect: /m)
  assert.match(text, /SSH connected to /)
  assert.match(text, /probe: /)
  assert.ok(
    frames.some((frame) => (frame.hosts[0]?.logs ?? []).length > 0),
    'expected a /state frame carrying the connect log',
  )
  release()
  await connecting
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
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
  assert.ok(failed.logs.length > 0)
  assert.ok(failed.logs.length <= LOG_TAIL_LIMIT)
  assert.match(failed.error.code, /node-install-failed/)
  await service.shutdown()
})

/** The log as a user reads it in the panel: localized text first, the raw line otherwise. */
function logTextOf(view) {
  return (view.logs ?? []).map((entry) => entry.text?.zh ?? entry.message).join('\n')
}

test('a new connection replaces the previous attempt’s log instead of appending to it', async () => {
  let attempts = 0
  const { service } = await makeTestService({
    ensureNode: async () => {
      attempts += 1
      throw errors.nodeInstallFailed({ zh: `下载失败 ${attempts}`, en: `download failed ${attempts}` })
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'first failure' })
  const first = service.snapshot().hosts[0]
  assert.match(logTextOf(first), /^— 第 1 次连接 · /m)
  assert.match(logTextOf(first), /下载失败 1/)
  assert.equal(first.logs[0].seq, 1)

  // Reconnect without cleaning anything: attempt 2 must open on a clean log.
  await service.connect(host.id)
  const failedAgain = () =>
    service.snapshot().hosts[0].status === 'error' && /下载失败 2/.test(logTextOf(service.snapshot().hosts[0]))
  await waitFor(failedAgain, { label: 'second failure' })
  const second = service.snapshot().hosts[0]
  assert.equal(second.logs[0].boundary, true, 'the new connection opens with its boundary line')
  assert.equal(second.logs[0].seq, 1, 'the second connection starts its own sequence')
  assert.match(second.logs[0].text.zh, /^— 第 2 次连接 · /)
  assert.doesNotMatch(
    logTextOf(second),
    /第 1 次连接|下载失败 1/,
    'no line from the previous attempt may survive into this connection',
  )
  assert.match(logTextOf(second), /下载失败 2/)
  await service.shutdown()
})

test('a failed connection’s log explains itself: phase, code, reason and hints at error level', async () => {
  const { service } = await makeTestService({ waitUi: async () => ({ ok: false, status: 502 }) })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'error' })
  const view = service.snapshot().hosts[0]
  assert.equal(view.error.code, 'remote-ui-unreachable')
  const text = logTextOf(view)
  assert.match(text, /连接失败于 verifying 阶段：remote-ui-unreachable/)
  assert.match(text, /原因：远端 DSH 的本地 127\.0\.0\.1:38123 没有响应/)
  assert.match(text, /建议：点「重连」重试一次/)
  assert.match(text, /建议：查看诊断中的隧道与界面可达性检查/)
  const failures = view.logs.filter((entry) => entry.level === 'error')
  assert.ok(failures.length >= 4, 'the failure is written as several error lines, not one')
  assert.ok(
    failures.every((entry) => entry.phase === 'verifying'),
    'every failure line names the phase it failed in',
  )
  const phases = new Set(view.logs.map((entry) => entry.phase))
  for (const phase of ['ssh', 'probe', 'bootstrap', 'start', 'tunnel', 'verifying']) {
    assert.ok(phases.has(phase), `the log must show the ${phase} phase ran`)
  }
  assert.equal(
    view.logs.every((entry) => 'phase' in entry),
    true,
    'every /state log line carries its phase',
  )
  await service.shutdown()
})

test('a failed remote start prints the remote log tail line by line', async () => {
  const { service } = await makeTestService({
    startWeb: async () => {
      throw errors.remoteDshStartFailed(
        'EXITED:4242\n---LOG---\nError: Cannot find module @deepseek-ai/dsh\n  at Module._resolveFilename',
      )
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'error' })
  const view = service.snapshot().hosts[0]
  const text = logTextOf(view)
  assert.match(text, /连接失败于 start 阶段：remote-dsh-start-failed/)
  assert.match(text, /远端日志尾部：/)
  const header = view.logs.findIndex((entry) => entry.text?.zh === '远端日志尾部：')
  assert.ok(header >= 0, 'the tail needs its own header line')
  assert.deepEqual(
    view.logs.slice(header + 1).map((entry) => entry.message),
    ['EXITED:4242', '---LOG---', 'Error: Cannot find module @deepseek-ai/dsh', '  at Module._resolveFilename'],
    'each remote log line is its own log line',
  )
  assert.equal(
    view.logs.slice(header + 1).every((entry) => entry.level === 'error' && entry.phase === 'start'),
    true,
  )
  await service.shutdown()
})
test('the npx preflight reports npm output as connect progress', async () => {
  const { service } = await makeTestService({
    preflight: async (_ssh, _plan, options) => {
      options.onStderr('npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh\n')
      return '0.2.2-rc.1'
    },
  })
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
  const stopped = []
  const { service } = await makeTestService({
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
  const { service } = await makeTestService({
    exchange: async () => ({
      ok: true,
      firstStatus: 302,
      location: './',
      status: 200,
      title: 'DSH',
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
  const frames = []
  const onState = (state) => frames.push(state)
  service.on('state', onState)
  events[0].ssh.simulateClose()
  await waitFor(
    () => service.snapshot().hosts[0].status === 'disconnected' || service.snapshot().hosts[0].status === 'connecting',
    {
      label: 'disconnected',
    },
  )
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { timeoutMs: 8000, label: 'reconnected' })
  service.off('state', onState)
  assert.ok(events.filter((event) => event.type === 'ssh').length >= 2)
  // The retry is a new connection (#62): its first `connecting` frame carries only its own
  // boundary line, so the panel never shows the log of the link that just dropped.
  const firstConnecting = frames.find((state) => state.hosts[0]?.status === 'connecting')
  assert.ok(firstConnecting, 'the retry must publish a connecting frame')
  const retryLog = firstConnecting.hosts[0].logs
  assert.equal(retryLog.length, 1, 'the retry starts on an empty log plus its boundary line')
  assert.equal(retryLog[0].seq, 1, 'the retry restarts the sequence')
  assert.equal(retryLog[0].boundary, true)
  assert.match(retryLog[0].text.zh, /^— 第 2 次连接 · /)
  assert.doesNotMatch(
    JSON.stringify(retryLog),
    /第 1 次连接|link lost/,
    'no line of the dropped connection may survive into the retry',
  )
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

test('a download is judged against the same home root the writer receives', async () => {
  const { service } = await makeTestService()
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-download-home-'))
  delete service.userHome
  service.userHome = () => base
  try {
    const host = await createHost(service)
    const seen = []
    service.downloads = {
      start(runtime, path, options) {
        seen.push({ runtimeId: runtime.id, path, home: options.home })
        return { id: 'dl_home', phase: 'preparing' }
      },
      dispose() {},
    }
    const started = await service.startRemoteDownload(host.id, '/home/ubuntu/a.txt', { destination: base })
    assert.equal(started.id, 'dl_home')
    // The pre-flight and the writer must agree on the root: a fallback to `os.homedir()` in the
    // job would disagree whenever HOME/USERPROFILE is unset.
    assert.deepEqual(seen, [{ runtimeId: host.id, path: '/home/ubuntu/a.txt', home: base }])
    await assert.rejects(
      service.startRemoteDownload(host.id, '/home/ubuntu/a.txt', {
        destination: path.join(base, '..', 'elsewhere'),
      }),
      (error) => error.code === 'invalid-input',
    )
    assert.equal(seen.length, 1, 'a refused destination never reaches the job')
  } finally {
    delete service.userHome
    await rm(base, { recursive: true, force: true })
    await service.shutdown()
  }
})
test('setLocalVersion adopts a detected version and only backfills a missing one', async () => {
  const { service } = await makeTestService({ localVersion: null })
  assert.equal(service.snapshot().hostVersion, null)
  // The client may fill in a version the Host could not detect…
  assert.equal(service.setLocalVersion('v0.2.2-rc.3', 'client'), true)
  assert.equal(service.snapshot().hostVersion, '0.2.2-rc.3')
  assert.equal(service.snapshot().targetVersion, '0.2.2-rc.3')
  // …but a version that is already known is never overwritten by the page.
  assert.equal(service.setLocalVersion('0.9.9', 'client'), false)
  assert.equal(service.snapshot().hostVersion, '0.2.2-rc.3')
  // A locally detected version replaces the backfill: it is the Host's own reading.
  assert.equal(service.setLocalVersion('0.3.0', 'package.json:/x'), true)
  assert.equal(service.snapshot().hostVersion, '0.3.0')
})

test('the client backfill refuses a version below the supported floor or one that is not a version', async () => {
  const { service } = await makeTestService({ localVersion: null })
  assert.throws(
    () => service.setLocalVersion('0.2.2-rc.1', 'client'),
    (error) => error.code === 'invalid-input',
  )
  assert.equal(service.snapshot().hostVersion, null)
  // A malformed value is a client mistake, not a silent `accepted:false` (docs/api.md says 400).
  assert.throws(
    () => service.setLocalVersion('not-a-version', 'client'),
    (error) => error.code === 'invalid-input',
  )
  assert.throws(
    () => service.setLocalVersion('', 'client'),
    (error) => error.code === 'invalid-input',
  )
  assert.equal(service.snapshot().hostVersion, null)
})

test('a re-attached instance with another version is never stopped by the next connect', async () => {
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
      origin: 'reattach',
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(stopped, [], 'an instance the plugin did not launch must not be killed')
  assert.equal(service.snapshot().hosts[0].remote.version, '0.2.2-rc.1')
  await service.shutdown()
})

test('a leftover registry record from a re-attach is left running by a new connection', async () => {
  const stopped = []
  const { service } = await makeTestService({
    adopt: async () => null,
    readRegistry: async () => ({
      pid: 77,
      port: 4000,
      startedAt: '2026-11-16T00:00:00.000Z',
      profile: 'web',
      version: '0.2.2-rc.1',
      dshHome: '/home/ubuntu/.dsh',
      launch: 'browser-carrier-v1',
      origin: 'reattach',
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(stopped, [])
  await service.shutdown()
})

test('every emitted state frame carries a strictly increasing revision and a publish instance', async () => {
  const { service } = await makeTestService()
  const first = service.snapshot()
  assert.equal(typeof first.rev, 'number')
  assert.equal(typeof first.instance, 'string')
  assert.notEqual(first.instance, '')
  const revisions = []
  service.on('state', (state) => revisions.push(state.rev))
  const start = first.rev
  service.emitState()
  service.emitState()
  assert.deepEqual(revisions, [start + 1, start + 2])
  assert.equal(service.snapshot().rev, revisions.at(-1), 'GET /state reports the latest revision')
  // A host mutation publishes through the same counter, so the Client can reject a stale frame.
  const before = service.snapshot().rev
  await createHost(service)
  assert.ok(service.snapshot().rev > before)
  // A restart (or a plugin reload) starts a new instance: its rev may be lower, and the Client
  // relies on the instance change to accept its frames instead of freezing on the old mark.
  const restarted = await makeTestService()
  assert.notEqual(restarted.service.snapshot().instance, service.snapshot().instance)
  assert.equal(typeof restarted.service.snapshot().rev, 'number')
  await service.shutdown()
  await restarted.service.shutdown()
})

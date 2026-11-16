import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FakeTunnel,
  createHost,
  makeFacts,
  makeTestService,
  managedNodeFixture,
  waitFor,
} from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'
import { remoteHeartbeatTick } from '../../src/host-lifecycle.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A mutable run registry, so a re-attach's rewrite is visible to the next restart. */
function registryStore(initial = null) {
  let value = initial
  return {
    read: async () => value,
    write: async (_ssh, _layout, record) => {
      value = record
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
    set: (next) => {
      value = next
    },
    get: () => value,
  }
}

function webInfo(port, token, pid) {
  return {
    pid,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    logPath: '/home/ubuntu/.dsh/remote-go/logs/web.log',
    startedAt: new Date().toISOString(),
    rawLine: '',
    profile: 'web',
    dshHome: '/home/ubuntu/.dsh',
  }
}

const REGISTRY = { pid: 4242, port: 38123, profile: 'web', dshHome: '/home/ubuntu/.dsh' }

/** Record every tunnel the restart/re-attach opens, with the port it forwards to. */
function tunnelRecorder() {
  const tunnels = []
  const factory = async (options) => {
    const tunnel = new FakeTunnel(45000 + tunnels.length + 1)
    tunnels.push({ remotePort: options.remotePort, localPort: tunnel.localPort, tunnel })
    return tunnel
  }
  return { tunnels, factory }
}

function resolved(port, token, overrides = {}) {
  return {
    ok: true,
    pid: 4242,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    version: '0.2.2-rc.1',
    profile: 'web',
    dshHome: '/home/ubuntu/.dsh',
    source: 'log',
    ...overrides,
  }
}

function statusesOf(service) {
  const seen = []
  service.on('state', (state) => {
    for (const host of state.hosts) seen.push(host.status)
  })
  return seen
}

function messagesOf(service, id) {
  const runtime = service.runtimes.get(id)
  return (runtime?.logs ?? []).map((entry) => entry.message)
}

test('restart refuses every state that cannot support it', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
  // The unconfigured / never-connected host has no transport at all.
  await assert.rejects(
    () => service.restart(host.id),
    (error) => error.code === 'restart-unavailable',
  )
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  // Disconnecting releases the SSH transport, so a restart has nothing to ride on.
  await service.disconnect(host.id)
  await assert.rejects(
    () => service.restart(host.id),
    (error) => error.code === 'restart-unavailable',
  )
  // Every other status is refused unless the remote-unreachable error kept the transport.
  for (const status of ['connecting', 'fingerprint-pending', 'conflict-pending', 'limited']) {
    runtime.status = status
    await assert.rejects(
      () => service.restart(host.id),
      (error) => error.code === 'restart-unavailable',
      status,
    )
  }
  runtime.status = 'error'
  runtime.error = { code: 'auth' }
  await assert.rejects(
    () => service.restart(host.id),
    (error) => error.code === 'restart-unavailable',
  )
  await service.shutdown()
})

test('restart stops the managed pid, relaunches on the same plan and rebuilds the tunnel', async () => {
  const { tunnels, factory } = tunnelRecorder()
  const stopped = []
  const writes = []
  let starts = 0
  // The registry is written by the launch: it only names the pid once the host is up.
  let registry = null
  const { service, events } = await makeTestService({
    readRegistry: async () => registry,
    tunnelFactory: factory,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    writeRegistry: async (_ssh, _layout, record) => {
      writes.push(record)
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  assert.equal(service.snapshot().hosts[0].remote.viewRev, 1)
  registry = REGISTRY
  const sshCount = events.filter((event) => event.type === 'ssh').length

  assert.deepEqual(await service.restart(host.id), { accepted: true })
  await waitFor(
    () =>
      service.snapshot().hosts[0].status === 'connected' &&
      service.snapshot().hosts[0].remote.port === 38210 &&
      service.snapshot().hosts[0].progress.code === 'ready',
    { label: 'restarted on the new port' },
  )

  // No second SSH session and no probe/bootstrap work: restart reuses the live transport.
  assert.equal(events.filter((event) => event.type === 'ssh').length, sshCount)
  assert.deepEqual(stopped, [4242])
  assert.equal(starts, 2)
  assert.equal(tunnels.length, 2)
  assert.equal(tunnels[1].remotePort, 38210)
  assert.equal(tunnels[0].remotePort, 38123)
  assert.equal(tunnels[0].localPort !== tunnels[1].localPort, true, 'the tunnel must be rebuilt')

  const view = service.snapshot().hosts[0]
  assert.equal(view.remote.pid, 4343)
  assert.equal(view.remote.localPort, 45002)
  assert.equal(view.remote.viewRev, 2)
  assert.equal(service.openInfo(host.id).localPort, 45002)
  assert.match(service.openInfo(host.id).url, /tok_second$/)
  assert.deepEqual(service.webViewTarget(host.id), { localPort: 45002, remotePort: 38210 })

  assert.equal(writes.length, 1)
  assert.equal(writes[0].pid, 4343)
  assert.equal(writes[0].port, 38210)
  assert.equal(writes[0].profile, 'web')
  assert.equal(writes[0].dshHome, '/home/ubuntu/.dsh')
  assert.equal(writes[0].launch, 'browser-carrier-v1')

  const messages = messagesOf(service, host.id).join('\n')
  assert.match(messages, /restart: stopped the managed remote web pid=4242/)
  assert.match(messages, /restart: remote DSH started pid 4343, port 38210/)
  assert.match(messages, /restart: run registry refreshed \(pid 4343, port 38210\)/)
  assert.match(messages, /restart: connected again/)
  // The old tunnel is closed, not leaked.
  assert.equal(tunnels[0].tunnel.closed, true)
  await service.shutdown()
})

test('restart failure lands in a coded error and tears the half-built link down', async () => {
  const { tunnels, factory } = tunnelRecorder()
  let registry = null
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => registry,
    tunnelFactory: factory,
    startWeb: async () => {
      starts += 1
      if (starts > 1) throw errors.remoteDshStartFailed('boom: the remote exited')
      return webInfo(38123, 'tok_first', 4242)
    },
  })
  const host = await createHost(service, { keepAlive: 'keep' })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  registry = REGISTRY
  await service.restart(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'restart failed' })
  const view = service.snapshot().hosts[0]
  assert.equal(view.error.code, 'remote-dsh-start-failed')
  assert.equal(view.remote.uiReady, false)
  assert.equal(view.remote.localPort, null)
  assert.equal(view.keepAlive, 'keep')
  assert.equal(tunnels[0].tunnel.closed, true)
  const runtime = service.runtimes.get(host.id)
  assert.equal(runtime.ssh, null, 'a failed restart tears the transport down like a failed connect')
  await service.shutdown()
})

test('restart never kills a DSH the run registry does not name', async () => {
  const stopped = []
  let foreign = []
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => null,
    findForeign: async (_ssh, options) => ({
      ok: true,
      processes: foreign.filter((process) => !(options?.ignorePids ?? []).includes(process.pid)),
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return webInfo(38000 + starts, `tok_${starts}`, 5000 + starts)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')

  // The connection is now a managed instance, but the registry is gone and one manual DSH
  // remains: a restart must ask, not kill.
  foreign = [{ pid: 777, command: 'node /opt/dsh/bin/dsh web --profile web --no-open' }]
  const seen = statusesOf(service)
  await service.restart(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'conflict-pending', { label: 'conflict prompt' })
  assert.equal(service.snapshot().hosts[0].conflict.processes[0].pid, 777)
  assert.deepEqual(stopped, [], 'the foreign pid must not be stopped silently')
  assert.ok(seen.includes('conflict-pending'))

  await service.confirmConflict(host.id, { action: 'alongside' })
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38002,
    { label: 'restarted alongside' },
  )
  assert.deepEqual(stopped, [])
  assert.ok(service.snapshot().hosts[0].warning)
  assert.deepEqual(service.runtimes.get(host.id).alongsidePids, [777])

  // The same known-alongside process is not asked about a second time.
  await service.restart(host.id)
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38003,
    { label: 'second restart without a prompt' },
  )
  assert.deepEqual(stopped, [])
  await service.shutdown()
})

test('restart cancelling the conflict prompt keeps the current remote instance', async () => {
  const stopped = []
  let foreign = []
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => null,
    findForeign: async (_ssh, options) => ({
      ok: true,
      processes: foreign.filter((process) => !(options?.ignorePids ?? []).includes(process.pid)),
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return webInfo(38000 + starts, `tok_${starts}`, 5000 + starts)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  foreign = [{ pid: 778, command: 'node /opt/dsh/bin/dsh web --profile web' }]
  await service.restart(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'conflict-pending')
  await service.confirmConflict(host.id, { action: 'cancel' })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'restored' })
  assert.equal(service.snapshot().hosts[0].remote.port, 38001)
  assert.equal(service.snapshot().hosts[0].progress.code, 'ready')
  assert.deepEqual(stopped, [])
  assert.equal(starts, 1, 'a cancelled restart does not launch a second instance')
  await service.shutdown()
})

test('restart is busy while another restarts and keeps the state machine linear', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => {
      starts += 1
      if (starts === 2) await gate
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(await service.restart(host.id), { accepted: true })
  await waitFor(() => service.snapshot().hosts[0].progress.code === 'restarting-remote')
  assert.deepEqual(await service.restart(host.id), { accepted: false, reason: 'busy' })
  release()
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
    { label: 'single restart completed' },
  )
  assert.equal(starts, 2)
  await service.shutdown()
})

test('a disconnect during a restart wins: the stale restart cannot write state', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => {
      starts += 1
      if (starts === 2) await gate
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await service.restart(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connecting')
  await service.disconnect(host.id)
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  release()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(service.snapshot().hosts[0].remote.localPort, null)
  await service.shutdown()
})

test('two consecutive failed probes re-attach to the restarted remote without a conflict prompt', async () => {
  const resolutions = []
  const { tunnels, factory } = tunnelRecorder()
  const writes = []
  const probes = []
  let registry = null
  const { service } = await makeTestService({
    readRegistry: async () => registry,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    tunnelFactory: factory,
    remoteStatus: async () => {
      probes.push(true)
      return null
    },
    resolveRemote: async () => {
      resolutions.push(true)
      return resolved(38210, 'tok_new')
    },
    writeRegistry: async (_ssh, _layout, record) => {
      writes.push(record)
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  registry = REGISTRY
  const runtime = service.runtimes.get(host.id)
  const phases = []
  const seen = statusesOf(service)
  service.on('remote-unreachable', (event) => phases.push(event.phase))

  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => phases.includes('confirmed'), { label: 'remote restart confirmed' })
  await waitFor(
    () =>
      service.snapshot().hosts[0].status === 'connected' &&
      service.snapshot().hosts[0].remote.port === 38210 &&
      service.snapshot().hosts[0].progress.code === 'ready',
    { label: 're-attached' },
  )

  assert.deepEqual(phases, ['suspected', 'confirmed'])
  assert.equal(probes.length >= 2, true, 'two probes are needed before the re-attach')
  assert.equal(resolutions.length, 1)
  assert.deepEqual(
    seen.filter((status) => status === 'conflict-pending'),
    [],
    'no conflict prompt',
  )
  assert.equal(service.snapshot().hosts[0].error, null)
  const view = service.snapshot().hosts[0]
  assert.equal(view.remote.localPort, 45002)
  assert.equal(view.remote.viewRev, 2)
  assert.equal(tunnels[1].remotePort, 38210)
  assert.equal(tunnels[0].tunnel.closed, true)
  assert.equal(writes[0].pid, 4242)
  assert.equal(writes[0].port, 38210)
  assert.equal(runtime.restarts.length, 1)
  assert.equal(runtime.restarts[0].kind, 'remote-reattach')
  assert.equal(runtime.restarts[0].fromPort, 38123)
  assert.equal(runtime.restarts[0].toPort, 38210)
  const messages = messagesOf(service, host.id).join('\n')
  assert.match(messages, /remote restart suspected: probe-failed-2/)
  assert.match(messages, /re-attach: found remote web pid=4242 port=38210/)
  assert.match(messages, /re-attach: run registry refreshed/)
  assert.match(messages, /re-attached: remote 0.2.2-rc.1/)
  await service.shutdown()
})

test('one failed probe followed by a healthy one is not a restart', async () => {
  let probes = 0
  let resolutions = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => {
      probes += 1
      return probes === 1 ? null : 200
    },
    resolveRemote: async () => {
      resolutions += 1
      return resolved(38210, 'tok_new')
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => probes >= 2, { label: 'confirming probe ran' })
  await waitFor(() => phases.includes('recovered'), { label: 'recovered' })
  assert.equal(resolutions, 0)
  assert.deepEqual(phases, ['suspected', 'recovered'])
  assert.equal(runtime.remoteFailures, 0)
  assert.equal(service.snapshot().hosts[0].remote.port, 38123)
  await service.shutdown()
})

test('a proxy failure alone does not judge a restart and repeated reports are coalesced', async () => {
  let probes = 0
  let resolutions = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => {
      probes += 1
      return 200
    },
    resolveRemote: async () => {
      resolutions += 1
      return resolved(38210, 'tok_new')
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  service.ctx.noteRemoteUnreachable(runtime, 'tunnel')
  await waitFor(() => phases.includes('recovered'), { label: 'confirmed healthy' })
  assert.equal(probes, 1, 'bursts share one confirming probe')
  assert.equal(resolutions, 0)
  assert.deepEqual(phases, ['suspected', 'recovered'])
  await service.shutdown()
})

test('a missing remote instance ends in remote-unreachable and keeps the host and its settings', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => null,
    resolveRemote: async () => ({ ok: false, reason: 'no-running-web' }),
  })
  const host = await createHost(service, { keepAlive: 'keep' })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'remote-unreachable' })
  const view = service.snapshot().hosts[0]
  assert.equal(view.error.code, 'remote-unreachable')
  assert.equal(view.keepAlive, 'keep')
  assert.equal(view.remote.uiReady, false)
  assert.equal(view.remote.localPort, null)
  assert.equal(service.snapshot().hosts.length, 1)
  // The transport is kept so the user can decide between restart and reconnect.
  assert.notEqual(service.runtimes.get(host.id).ssh, null)
  const messages = messagesOf(service, host.id).join('\n')
  assert.match(messages, /re-attach failed: remote-unreachable/)
  await service.shutdown()
})

test('a remote that restarted into another DSH version is not adopted silently', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => null,
    resolveRemote: async () => resolved(38210, 'tok_new', { version: '0.1.0-old' }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'version mismatch' })
  assert.equal(service.snapshot().hosts[0].error.code, 'version-mismatch')
  await service.shutdown()
})

test('the heartbeat follows the settings switch and stops with the connection', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  assert.notEqual(runtime.heartbeatTimer, null, 'the heartbeat is on by default')
  await service.disconnect(host.id)
  assert.equal(runtime.heartbeatTimer, null)

  await service.saveSettings({ remoteHeartbeat: { enabled: false, intervalSec: 30 } })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.equal(runtime.heartbeatTimer, null, 'the setting disables the probe')
  await service.shutdown()
})

test('the proxy upstream hook feeds the same confirmation for a known host only', async () => {
  let probes = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => {
      probes += 1
      return 200
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  service.noteUpstreamFailure(host.id)
  assert.doesNotThrow(() => service.noteUpstreamFailure('h_missing'))
  await waitFor(() => phases.includes('recovered'), { label: 'proxy suspicion confirmed healthy' })
  assert.equal(probes, 1)
  assert.deepEqual(phases, ['suspected', 'recovered'])
  assert.equal(runtime.remoteFailures, 0)
  await service.shutdown()
})

test('a restart recovers from the retained remote-unreachable error state', async () => {
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
    remoteStatus: async () => null,
    resolveRemote: async () => ({ ok: false, reason: 'no-running-web' }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'remote-unreachable' })
  assert.equal(service.snapshot().hosts[0].error.code, 'remote-unreachable')
  const runtime = service.runtimes.get(host.id)
  assert.notEqual(runtime.ssh, null, 'the transport is kept for exactly this recovery')

  assert.deepEqual(await service.restart(host.id), { accepted: true })
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
    { label: 'restarted from the error state' },
  )
  const view = service.snapshot().hosts[0]
  assert.equal(view.error, null)
  assert.equal(view.progress.code, 'ready')
  assert.equal(starts, 2)
  await service.shutdown()
})

test('the heartbeat setting applies to a host that is already connected', async () => {
  let probes = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => {
      probes += 1
      return 200
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  assert.notEqual(runtime.heartbeatTimer, null)
  await service.saveSettings({ remoteHeartbeat: { enabled: false } })
  assert.equal(runtime.heartbeatTimer, null, 'the switch turns the probe off immediately')
  await service.saveSettings({ remoteHeartbeat: { enabled: true, intervalSec: 5 } })
  assert.notEqual(runtime.heartbeatTimer, null, 'and back on immediately')
  await service.shutdown()
})

test('a local restart records one entry in the diagnostic report', async () => {
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await service.restart(host.id)
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  const report = await service.diagnose(host.id)
  assert.equal(report.redacted, true)
  assert.equal(report.restarts.length, 1)
  assert.equal(report.restarts[0].kind, 'local-restart')
  assert.equal(report.restarts[0].fromPort, 38123)
  assert.equal(report.restarts[0].toPort, 38210)
  await service.shutdown()
})

test('restart does not re-run probe, managed Node provisioning or the npx preflight', async () => {
  const counts = { probe: 0, ensureNode: 0, preflight: 0 }
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    probe: async () => {
      counts.probe += 1
      return makeFacts()
    },
    ensureNode: async (_ssh, options) => {
      counts.ensureNode += 1
      return managedNodeFixture(options.version)
    },
    preflight: async (_ssh, plan) => {
      counts.preflight += 1
      return plan.targetVersion
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  assert.deepEqual(counts, { probe: 1, ensureNode: 1, preflight: 1 })
  counts.probe = 0
  counts.ensureNode = 0
  counts.preflight = 0
  await service.restart(host.id)
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  assert.deepEqual(counts, { probe: 0, ensureNode: 0, preflight: 0 }, 'a restart reuses the recorded facts and plan')
  await service.shutdown()
})

test('a restart during a connect and a connect during a restart are refused, not interleaved', async () => {
  let release = () => {}
  const firstGate = new Promise((resolve) => {
    release = resolve
  })
  let releaseSecond = () => {}
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve
  })
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => {
      starts += 1
      if (starts === 1) await firstGate
      if (starts === 2) await secondGate
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connecting')
  assert.deepEqual(await service.restart(host.id), { accepted: false, reason: 'busy' })
  release()
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')

  await service.restart(host.id)
  await waitFor(() => service.snapshot().hosts[0].progress.code === 'restarting-remote')
  assert.deepEqual(await service.connect(host.id), { accepted: false, reason: 'already-restarting' })
  releaseSecond()
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  await service.shutdown()
})

test('a re-attach to a pid this connection did not launch grants no kill rights', async () => {
  const registry = registryStore(null)
  const stopped = []
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
    remoteStatus: async () => null,
    resolveRemote: async () => ({
      ok: true,
      pid: 777,
      port: 38010,
      token: 'tok_external',
      url: 'http://127.0.0.1:38010/?token=tok_external',
      version: '0.2.2-rc.1',
      profile: 'web',
      dshHome: '/home/ubuntu/.dsh',
      source: 'log',
    }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => phases.includes('confirmed'), { label: 'reattach confirmed' })
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38010,
  )
  assert.equal(registry.get().pid, 777)
  assert.equal(registry.get().origin, 'reattach')
  assert.equal(runtime.launched.has(777), false)

  await service.restart(host.id)
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  assert.deepEqual(stopped, [], 'a pid discovered by a re-attach must never be killed')
  assert.match(messagesOf(service, host.id).join('\n'), /not stopping pid 777 \(not-launched-by-this-connection\)/)
  await service.shutdown()
})

test('a pid kept alongside is never added to the stop list', async () => {
  const registry = registryStore(null)
  const stopped = []
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  registry.set(REGISTRY)
  const runtime = service.runtimes.get(host.id)
  runtime.alongsidePids = [4242]
  await service.restart(host.id)
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  assert.deepEqual(stopped, [])
  assert.match(messagesOf(service, host.id).join('\n'), /not stopping pid 4242 \(kept-alongside\)/)
  await service.shutdown()
})

test('a reused pid is never signalled as the old DSH', async () => {
  const registry = registryStore(null)
  const stopped = []
  const startTimes = new Map([[4242, '1000']])
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    processIdentity: async (_ssh, pid) => ({
      ok: true,
      startTime: startTimes.get(pid) ?? `5000-${pid}`,
      command: 'node /opt/dsh/bin.js web --profile web --no-open',
      dshHome: '/home/ubuntu/.dsh',
    }),
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  registry.set(REGISTRY)
  assert.equal(service.runtimes.get(host.id).launched.get(4242).startTime, '1000')
  // The remote pid was recycled by an unrelated process: the identity no longer matches.
  startTimes.set(4242, '9999')
  await service.restart(host.id)
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  assert.deepEqual(stopped, [], 'a reused pid must not be signalled with a stale identity')
  assert.match(messagesOf(service, host.id).join('\n'), /not stopping pid 4242 \(pid-reused\)/)
  await service.shutdown()
})

test('a disconnect during the registry write leaves no half-built tunnel', async () => {
  const { tunnels, factory } = tunnelRecorder()
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let writes = 0
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    tunnelFactory: factory,
    writeRegistry: async () => {
      writes += 1
      await gate
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await service.restart(host.id)
  await waitFor(() => writes === 1, { label: 'registry write started' })
  await service.disconnect(host.id)
  release()
  await sleep(50)
  const runtime = service.runtimes.get(host.id)
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(runtime.tunnel, null)
  assert.equal(runtime.remote.localPort, null)
  assert.equal(tunnels.length, 1, 'no listener may be opened after the link was dropped')
  assert.equal(tunnels[0].tunnel.closed, true)
  await service.shutdown()
})

test('a disconnect while the new listener is being created closes that listener', async () => {
  const tunnels = []
  const factoryCalls = { count: 0 }
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    tunnelFactory: async (options) => {
      factoryCalls.count += 1
      if (factoryCalls.count === 2) await gate
      const tunnel = new FakeTunnel(45000 + tunnels.length + 1)
      tunnels.push({ remotePort: options.remotePort, localPort: tunnel.localPort, tunnel })
      return tunnel
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await service.restart(host.id)
  await waitFor(() => factoryCalls.count === 2, { label: 'tunnel creation started' })
  await service.disconnect(host.id)
  release()
  await sleep(50)
  const runtime = service.runtimes.get(host.id)
  assert.equal(tunnels.length, 2)
  assert.equal(tunnels[1].tunnel.closed, true, 'the listener created after the drop must be closed')
  assert.equal(runtime.tunnel, null)
  assert.equal(runtime.remote.localPort, null)
  await service.shutdown()
})

test('removing the host while the new listener is being created cannot leak it', async () => {
  const tunnels = []
  const factoryCalls = { count: 0 }
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    tunnelFactory: async (options) => {
      factoryCalls.count += 1
      if (factoryCalls.count === 2) await gate
      const tunnel = new FakeTunnel(46000 + tunnels.length + 1)
      tunnels.push({ remotePort: options.remotePort, localPort: tunnel.localPort, tunnel })
      return tunnel
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await service.restart(host.id)
  await waitFor(() => factoryCalls.count === 2, { label: 'tunnel creation started' })
  await service.removeHost(host.id)
  release()
  await sleep(50)
  assert.equal(service.snapshot().hosts.length, 0)
  assert.equal(tunnels[1].tunnel.closed, true, 'a removed host must not leave a listener behind')
  await service.shutdown()
})

test('a re-attach that returns an empty token is an explicit failure', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => null,
    resolveRemote: async () => ({
      ok: true,
      pid: 4242,
      port: 38210,
      token: '',
      url: 'http://127.0.0.1:38210/',
      version: '0.2.2-rc.1',
      profile: 'web',
      dshHome: '/home/ubuntu/.dsh',
      source: 'log',
    }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  const view = service.snapshot().hosts[0]
  assert.equal(view.error.code, 'remote-unreachable')
  assert.match(view.error.detail.zh + view.error.detail.en, /launch token|launch token/i)
  assert.equal(service.runtimes.get(host.id).tunnel, null)
  await service.shutdown()
})

test('a no-token resolution reason is explained with the right remedy', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => null,
    resolveRemote: async () => ({ ok: false, reason: 'no-token' }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(() => service.snapshot().hosts[0].status === 'error')
  const detail = service.snapshot().hosts[0].error.detail
  assert.match(detail.zh + detail.en, /launch token/i)
  assert.match(messagesOf(service, host.id).join('\n'), /\(no-token\)/)
  await service.shutdown()
})

test('cancelling the conflict prompt never stops the managed instance first', async () => {
  const registry = registryStore(null)
  const stopped = []
  let foreign = []
  let starts = 0
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    findForeign: async (_ssh, options) => ({
      ok: true,
      processes: foreign.filter((process) => !(options?.ignorePids ?? []).includes(process.pid)),
    }),
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  registry.set(REGISTRY)
  foreign = [{ pid: 777, command: 'node /opt/dsh/bin.js web --profile web --no-open' }]
  await service.restart(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'conflict-pending')
  assert.deepEqual(stopped, [], 'nothing may be stopped before the user decides')
  await service.confirmConflict(host.id, { action: 'cancel' })
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'restored' })
  assert.deepEqual(stopped, [])
  assert.equal(service.snapshot().hosts[0].remote.port, 38123)
  assert.equal(starts, 1)
  await service.shutdown()
})

test('a broken tunnel under a healthy remote is rebuilt once instead of flapping', async () => {
  const { tunnels, factory } = tunnelRecorder()
  let probes = 0
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    tunnelFactory: factory,
    remoteStatus: async () => {
      probes += 1
      return 200
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  const runtime = service.runtimes.get(host.id)
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await waitFor(() => phases.includes('recovered'), { label: 'tunnel repaired' })
  assert.deepEqual(phases, ['suspected', 'recovered'])
  assert.equal(tunnels.length, 2, 'the local listener is rebuilt')
  assert.equal(tunnels[0].tunnel.closed, true)
  assert.notEqual(runtime.tunnel, null)
  assert.equal(service.snapshot().hosts[0].remote.localPort, tunnels[1].localPort)

  const probesBefore = probes
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await sleep(30)
  assert.deepEqual(phases, ['suspected', 'recovered'], 'a second report inside the cooldown is ignored')
  assert.equal(probes, probesBefore)
  await service.shutdown()
})

test('an unproven remote version stays unknown and is never written as the local one', async () => {
  const registry = registryStore(null)
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => null,
    resolveRemote: async () => ({
      ok: true,
      pid: 4242,
      port: 38210,
      token: 'tok_new',
      url: 'http://127.0.0.1:38210/?token=tok_new',
      version: null,
      profile: 'web',
      dshHome: '/home/ubuntu/.dsh',
      source: 'log',
    }),
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected')
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(
    () => service.snapshot().hosts[0].status === 'connected' && service.snapshot().hosts[0].remote.port === 38210,
  )
  assert.equal(registry.get().version, '', 'an unproven version is not laundered into the registry')
  assert.equal(service.snapshot().hosts[0].remote.version, null)
  assert.match(messagesOf(service, host.id).join('\n'), /version could not be proven/)
  await service.shutdown()
})

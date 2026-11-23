import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FakeTunnel,
  createHost,
  makeFacts,
  makeTestService,
  managedNodeFixture,
  waitFor,
} from '../helpers/fake-remote.ts'
import { repairTunnel } from '../../dist/src/connect/repair.js'
import { errors } from '../../dist/src/errors.js'
import { remoteHeartbeatTick } from '../../dist/src/watchdog.js'
const HOME = '/home/ubuntu/.dsh'
const REGISTRY = { pid: 4242, port: 38123, profile: 'web', dshHome: HOME }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** The coded refusal a restart gives when the host state cannot support one. */
const restartUnavailable = (error) => error.code === 'restart-unavailable'
/** The error a host with no live UI target throws. */
const uiUnreachable = (error) => error.code === 'remote-ui-unreachable'
/** The connected host's public view: what the carrier and the UI actually read. */
const hostView = (service) => service.snapshot().hosts[0]
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
/** One `startWeb` answer: the pid/port/token the launch reported, shaped like the real port's. */
function webInfo(port, token, pid) {
  return {
    pid,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    logPath: `${HOME}/remote-go/logs/web.log`,
    startedAt: new Date().toISOString(),
    rawLine: '',
    profile: 'web',
    dshHome: HOME,
  }
}
/** What a resolution step hands back for a remote that restarted itself. */
function resolved(port, token, overrides = {}) {
  return {
    ok: true,
    pid: 4242,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    version: '0.2.2-rc.1',
    profile: 'web',
    dshHome: HOME,
    source: 'log',
    ...overrides,
  }
}
/** The two-instance restart shape: pid 4242/port 38123 first, 4343/38210 after; `holds[n]` gates launch n. */
function restartedStartWeb(holds = {}) {
  let starts = 0
  const startWeb = async () => {
    starts += 1
    await holds[starts]?.promise
    return starts === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38210, 'tok_second', 4343)
  }
  return { startWeb, count: () => starts }
}
/** A fresh instance per launch: port 38000+n, pid 5000+n. */
function countingStartWeb() {
  let starts = 0
  const startWeb = async () => {
    starts += 1
    return webInfo(38000 + starts, `tok_${starts}`, 5000 + starts)
  }
  return { startWeb, count: () => starts }
}
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
/** Record every pid the service asks the remote to stop; `reply` is the port's answer. */
function stopRecorder({ reply = { ok: true, output: 'STOPPED' }, after } = {}) {
  const stopped = []
  const stopWeb = async (_ssh, _layout, options) => {
    stopped.push(options?.pid)
    const pending = after?.()
    if (pending) await pending
    return reply
  }
  return { stopped, stopWeb }
}
/** A promise the test resolves by hand, so one async step can be held mid-flight. */
function hold() {
  let release = () => {}
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}
// A tunnel factory that records every listener and holds the `holdAt`-th one mid-creation, so a teardown can land
// exactly while a replacement listener is being built.
function heldTunnels({ portBase = 45000, holdAt = 2 } = {}) {
  const tunnels = []
  const held = hold()
  let calls = 0
  const factory = async (options) => {
    calls += 1
    const tunnel = new FakeTunnel(portBase + tunnels.length + 1)
    tunnels.push({ tunnel, remotePort: options.remotePort })
    if (calls === holdAt) await held.promise
    return tunnel
  }
  return { tunnels, factory, held, count: () => calls }
}
/** Wait until the host is connected again on `port`: a restart or a re-attach landed. */
function settled(service, port, label) {
  return waitFor(() => hostView(service).status === 'connected' && hostView(service).remote.port === port, { label })
}
/** Every status the host passes through, in emission order (the array fills as the service emits). */
function statusesOf(service) {
  const seen = []
  service.on('state', (state) => {
    for (const host of state.hosts) seen.push(host.status)
  })
  return seen
}
/** The connect log of one host, joined into one string. */
function messagesOf(service, id) {
  return (service.runtimes.get(id)?.logs ?? []).map((entry) => entry.message).join('\n')
}
/** A foreign-process scan over a mutable list, honouring the ignore list the service passes. */
function foreignScan(foreign) {
  return async (_ssh, options) => ({
    ok: true,
    processes: foreign.filter((process) => !(options?.ignorePids ?? []).includes(process.pid)),
  })
}
/** A service whose single host is already connected: the starting point of most restart tests. */
async function connectedService(options = {}) {
  const { host: hostOptions, registry, stops, start, ...serviceOptions } = options
  const made = await makeTestService({
    readRegistry: registry?.read ?? (async () => REGISTRY),
    writeRegistry: registry?.write,
    stopWeb: stops?.stopWeb,
    startWeb: start?.startWeb ?? (async () => webInfo(38123, 'tok_first', 4242)),
    ...serviceOptions,
  })
  const host = await createHost(made.service, hostOptions)
  await made.service.connect(host.id)
  await waitFor(() => hostView(made.service).status === 'connected', { label: 'connected' })
  return { ...made, host, runtime: made.service.runtimes.get(host.id) }
}
/** Bring the test service to "re-attached to an external pid 777" (the npx wrapper/listener shape). */
async function reattachedService(overrides = {}) {
  const registry = registryStore(null)
  const stops = stopRecorder()
  const foreignStopped = []
  const start = restartedStartWeb()
  const made = await connectedService({
    ...overrides,
    registry,
    stops,
    start,
    stopForeign: async (_ssh, processes) => {
      foreignStopped.push(...processes.map((process) => process.pid))
      return { ok: true, alive: [], output: 'STOPPED' }
    },
    remoteStatus: async () => null,
    resolveRemote: async () => resolved(38010, 'tok_external', { pid: 777 }),
  })
  await remoteHeartbeatTick(made.service.ctx, made.runtime)
  await waitFor(() => hostView(made.service).remote.port === 38010, { label: 'reattached' })
  return { ...made, registry, stopped: stops.stopped, foreignStopped, starts: start.count }
}

test('restart refuses every state that cannot support it', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => REGISTRY,
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
  // The unconfigured / never-connected host has no transport at all.
  await assert.rejects(() => service.restart(host.id), restartUnavailable)
  await service.connect(host.id)
  await waitFor(() => hostView(service).status === 'connected')
  // Disconnecting releases the SSH transport, so a restart has nothing to ride on.
  await service.disconnect(host.id)
  await assert.rejects(() => service.restart(host.id), restartUnavailable)
  // Every other status is refused unless the remote-unreachable error kept the transport.
  for (const status of ['connecting', 'fingerprint-pending', 'conflict-pending', 'limited']) {
    runtime.status = status
    await assert.rejects(() => service.restart(host.id), restartUnavailable, status)
  }
  runtime.status = 'error'
  runtime.error = { code: 'auth' }
  await assert.rejects(() => service.restart(host.id), restartUnavailable)
  await service.shutdown()
})

test('restart stops the managed pid, relaunches on the same plan and rebuilds the tunnel', async () => {
  const { tunnels, factory } = tunnelRecorder()
  const stops = stopRecorder()
  const writes = []
  const start = restartedStartWeb()
  // The registry is written by the launch: it only names the pid once the host is up.
  let registry = null
  const { service, events, host } = await connectedService({
    readRegistry: async () => registry,
    tunnelFactory: factory,
    stops,
    writeRegistry: async (_ssh, _layout, record) => {
      writes.push(record)
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
    start,
  })
  assert.equal(hostView(service).remote.viewRev, 1)
  registry = REGISTRY
  const sshCount = events.filter((event) => event.type === 'ssh').length

  assert.deepEqual(await service.restart(host.id), { accepted: true })
  await settled(service, 38210, 'restarted on the new port')

  // No second SSH session and no probe/bootstrap work: restart reuses the live transport.
  assert.equal(events.filter((event) => event.type === 'ssh').length, sshCount)
  assert.deepEqual(stops.stopped, [4242])
  assert.equal(start.count(), 2)
  assert.equal(tunnels.length, 2)
  assert.equal(tunnels[1].remotePort, 38210)
  assert.equal(tunnels[0].remotePort, 38123)
  assert.equal(tunnels[0].localPort !== tunnels[1].localPort, true, 'the tunnel must be rebuilt')

  const view = hostView(service)
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

  const messages = messagesOf(service, host.id)
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
  const { service, host } = await connectedService({
    host: { keepAlive: 'keep' },
    readRegistry: async () => registry,
    tunnelFactory: factory,
    startWeb: async () => {
      starts += 1
      if (starts > 1) throw errors.remoteDshStartFailed('boom: the remote exited')
      return webInfo(38123, 'tok_first', 4242)
    },
  })
  registry = REGISTRY
  await service.restart(host.id)
  await waitFor(() => hostView(service).status === 'error', { label: 'restart failed' })
  const view = hostView(service)
  assert.equal(view.error.code, 'remote-dsh-start-failed')
  assert.equal(view.remote.uiReady, false)
  assert.equal(view.remote.localPort, null)
  assert.equal(view.keepAlive, 'keep')
  assert.equal(tunnels[0].tunnel.closed, true)
  const runtime = service.runtimes.get(host.id)
  assert.equal(runtime.ssh, null, 'a failed restart tears the transport down like a failed connect')
  // #68: the connect log explains the failure on its own instead of one code+message line.
  const logs = messagesOf(service, host.id)
  assert.match(logs, /Connect failed in phase start: remote-dsh-start-failed/)
  assert.match(logs, /Remote log tail:\nboom: the remote exited/)
  await service.shutdown()
})

test('restart is busy while another restarts and keeps the state machine linear', async () => {
  const second = hold()
  const start = restartedStartWeb({ 2: second })
  const { service, host } = await connectedService({ start })
  assert.deepEqual(await service.restart(host.id), { accepted: true })
  await waitFor(() => hostView(service).progress.code === 'restarting-remote')
  assert.deepEqual(await service.restart(host.id), { accepted: false, reason: 'busy' })
  second.release()
  await settled(service, 38210, 'single restart completed')
  assert.equal(start.count(), 2)
  await service.shutdown()
})
// Every way a heartbeat can conclude "the remote is not the instance I left": the resolver's answer and the coded
// failure it produces stay side by side, so the re-attach vocabulary lives in one place. `[name, options, check]` rows.
test('a restart that cannot adopt the remote ends in a coded failure', async () => {
  const cases = [
    [
      'a missing remote instance ends in remote-unreachable and keeps the host and its settings',
      { host: { keepAlive: 'keep' }, resolveRemote: async () => ({ ok: false, reason: 'no-running-web' }) },
      ({ service, host, view, messages }) => {
        assert.equal(view.error.code, 'remote-unreachable')
        assert.equal(view.keepAlive, 'keep')
        assert.equal(view.remote.uiReady, false)
        assert.equal(view.remote.localPort, null)
        assert.equal(service.snapshot().hosts.length, 1)
        // The transport is kept so the user can decide between restart and reconnect.
        assert.notEqual(service.runtimes.get(host.id).ssh, null)
        // #68: the re-attach failure is explained as a connection failure (phase + code + reason + details).
        assert.match(messages, /Connect failed in phase start: remote-unreachable/)
        assert.match(messages, /No re-attachable remote DSH instance was found/)
        assert.match(messages, /reason=no-running-web/)
      },
    ],
    [
      'a remote that restarted into another DSH version is not adopted silently',
      { resolveRemote: async () => resolved(38210, 'tok_new', { version: '0.1.0-old' }) },
      ({ view }) => {
        assert.equal(view.error.code, 'version-mismatch')
      },
    ],
    [
      'a re-attach that returns an empty token is an explicit failure',
      { resolveRemote: async () => resolved(38210, '', { url: 'http://127.0.0.1:38210/' }) },
      ({ service, host, view }) => {
        assert.equal(view.error.code, 'remote-unreachable')
        assert.match(view.error.detail.zh + view.error.detail.en, /launch token|launch token/i)
        assert.equal(service.runtimes.get(host.id).tunnel, null)
      },
    ],
    [
      'a no-token resolution reason is explained with the right remedy',
      { resolveRemote: async () => ({ ok: false, reason: 'no-token' }) },
      ({ view, messages }) => {
        assert.match(view.error.detail.zh + view.error.detail.en, /launch token/i)
        assert.match(messages, /\(no-token\)/)
      },
    ],
  ]
  for (const [name, options, check] of cases) {
    const { service, host, runtime } = await connectedService({ remoteStatus: async () => null, ...options })
    await remoteHeartbeatTick(service.ctx, runtime)
    await waitFor(() => hostView(service).status === 'error', { label: name })
    check({ service, host, runtime, view: hostView(service), messages: messagesOf(service, host.id) })
    await service.shutdown()
  }
})

test('an unproven remote version stays unknown and is never written as the local one', async () => {
  const registry = registryStore(null)
  const { service, host } = await connectedService({
    registry,
    remoteStatus: async () => null,
    resolveRemote: async () => resolved(38210, 'tok_new', { version: null }),
  })
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await settled(service, 38210)
  assert.equal(registry.get().version, '', 'an unproven version is not laundered into the registry')
  assert.equal(hostView(service).remote.version, null)
  assert.match(messagesOf(service, host.id), /version could not be proven/)
  await service.shutdown()
})

test('a restart during a connect and a connect during a restart are refused, not interleaved', async () => {
  const first = hold()
  const second = hold()
  const start = restartedStartWeb({ 1: first, 2: second })
  const { service } = await makeTestService({ readRegistry: async () => REGISTRY, startWeb: start.startWeb })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => hostView(service).status === 'connecting')
  assert.deepEqual(await service.restart(host.id), { accepted: false, reason: 'busy' })
  first.release()
  await waitFor(() => hostView(service).status === 'connected')

  await service.restart(host.id)
  await waitFor(() => hostView(service).progress.code === 'restarting-remote')
  assert.deepEqual(await service.connect(host.id), { accepted: false, reason: 'already-restarting' })
  second.release()
  await settled(service, 38210)
  await service.shutdown()
})

test('three consecutive failed probes re-attach to the restarted remote without a conflict prompt', async () => {
  const resolutions = []
  const { tunnels, factory } = tunnelRecorder()
  const writes = []
  const probes = []
  let registry = null
  const { service, host, runtime } = await connectedService({
    readRegistry: async () => registry,
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
  registry = REGISTRY
  const phases = []
  const seen = statusesOf(service)
  service.on('remote-unreachable', (event) => phases.push(event.phase))

  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => phases.includes('confirmed'), { label: 'remote restart confirmed' })
  await waitFor(
    () =>
      hostView(service).status === 'connected' &&
      hostView(service).remote.port === 38210 &&
      hostView(service).progress.code === 'ready',
    { label: 're-attached' },
  )

  assert.deepEqual(phases, ['suspected', 'confirmed'])
  assert.equal(probes.length >= 3, true, 'three probes are needed before the re-attach')
  assert.equal(resolutions.length, 1)
  assert.deepEqual(
    seen.filter((status) => status === 'conflict-pending'),
    [],
    'no conflict prompt',
  )
  assert.equal(hostView(service).error, null)
  const view = hostView(service)
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
  const messages = messagesOf(service, host.id)
  assert.match(messages, /remote restart suspected: probe-failed-3/)
  assert.match(messages, /re-attach: found remote web pid=4242 port=38210/)
  assert.match(messages, /re-attach: run registry refreshed/)
  assert.match(messages, /re-attached: remote 0.2.2-rc.1/)
  await service.shutdown()
})

test('one failed probe followed by a healthy one is not a restart', async () => {
  let probes = 0
  let resolutions = 0
  const { service, runtime } = await connectedService({
    remoteStatus: async () => {
      probes += 1
      return probes === 1 ? null : 200
    },
    resolveRemote: async () => {
      resolutions += 1
      return resolved(38210, 'tok_new')
    },
  })
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => probes >= 2, { label: 'confirming probe ran' })
  await waitFor(() => phases.includes('recovered'), { label: 'recovered' })
  assert.equal(resolutions, 0)
  assert.deepEqual(phases, ['suspected', 'recovered'])
  assert.equal(runtime.remoteFailures, 0)
  assert.equal(hostView(service).remote.port, 38123)
  await service.shutdown()
})

test('a proxy failure alone does not judge a restart and repeated reports are coalesced', async () => {
  let probes = 0
  let resolutions = 0
  const { service, runtime } = await connectedService({
    remoteStatus: async () => {
      probes += 1
      return 200
    },
    resolveRemote: async () => {
      resolutions += 1
      return resolved(38210, 'tok_new')
    },
  })
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

test('the proxy upstream hook feeds the same confirmation for a known host only', async () => {
  let probes = 0
  const { service, host, runtime } = await connectedService({
    remoteStatus: async () => {
      probes += 1
      return 200
    },
  })
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
  const start = restartedStartWeb()
  const { service, host, runtime } = await connectedService({
    start,
    remoteStatus: async () => null,
    resolveRemote: async () => ({ ok: false, reason: 'no-running-web' }),
  })
  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => hostView(service).status === 'error', { label: 'remote-unreachable' })
  assert.equal(hostView(service).error.code, 'remote-unreachable')
  assert.notEqual(runtime.ssh, null, 'the transport is kept for exactly this recovery')

  assert.deepEqual(await service.restart(host.id), { accepted: true })
  await settled(service, 38210, 'restarted from the error state')
  const view = hostView(service)
  assert.equal(view.error, null)
  assert.equal(view.progress.code, 'ready')
  assert.equal(start.count(), 2)
  await service.shutdown()
})
/** The two settings-switch shapes: the same probe timer, one toggled around a reconnect. */
test('the heartbeat follows the service settings', async () => {
  const cases = [
    [
      'the heartbeat follows the settings switch and stops with the connection',
      async ({ service, host, runtime }) => {
        assert.notEqual(runtime.heartbeatTimer, null, 'the heartbeat is on by default')
        await service.disconnect(host.id)
        assert.equal(runtime.heartbeatTimer, null)
        await service.saveSettings({ remoteHeartbeat: { enabled: false, intervalSec: 30 } })
        await service.connect(host.id)
        await waitFor(() => hostView(service).status === 'connected')
        assert.equal(runtime.heartbeatTimer, null, 'the setting disables the probe')
      },
    ],
    [
      'the heartbeat setting applies to a host that is already connected',
      async ({ service, runtime }) => {
        assert.notEqual(runtime.heartbeatTimer, null)
        await service.saveSettings({ remoteHeartbeat: { enabled: false } })
        assert.equal(runtime.heartbeatTimer, null, 'the switch turns the probe off immediately')
        await service.saveSettings({ remoteHeartbeat: { enabled: true, intervalSec: 5 } })
        assert.notEqual(runtime.heartbeatTimer, null, 'and back on immediately')
      },
    ],
  ]
  for (const [, check] of cases) {
    const { service, host, runtime } = await connectedService({
      remoteStatus: async () => {
        return 200
      },
    })
    await check({ service, host, runtime })
    await service.shutdown()
  }
})

test('a local restart records one entry in the diagnostic report', async () => {
  const start = restartedStartWeb()
  const { service, host } = await connectedService({ start })
  await service.restart(host.id)
  await settled(service, 38210)
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
  const start = restartedStartWeb()
  const { service, host } = await connectedService({
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
    start,
  })
  assert.deepEqual(counts, { probe: 1, ensureNode: 1, preflight: 1 })
  counts.probe = 0
  counts.ensureNode = 0
  counts.preflight = 0
  await service.restart(host.id)
  await settled(service, 38210)
  assert.deepEqual(counts, { probe: 0, ensureNode: 0, preflight: 0 }, 'a restart reuses the recorded facts and plan')
  await service.shutdown()
})
// A restart that hits a foreign DSH asks first, and asks once. Rows are `[name, { foreign, registry? }, action,
// check]`; the shared body wires the conflict prompt, so a row
// names the scenario and what the answer must have changed.
test('a restart conflict waits for the answer and never signals on its own', async () => {
  const cases = [
    [
      'restart never kills a DSH the run registry does not name',
      { foreign: 777 },
      'alongside',
      async ({ service, host, stopped, starts, seen }) => {
        assert.ok(seen.includes('conflict-pending'))
        assert.deepEqual(stopped, [], 'the foreign pid must not be stopped silently')
        assert.ok(hostView(service).warning)
        assert.deepEqual(service.runtimes.get(host.id).alongsidePids, [777])
        // The same known-alongside process is not asked about a second time.
        await service.restart(host.id)
        await settled(service, 38003, 'second restart without a prompt')
        assert.deepEqual(stopped, [])
      },
    ],
    [
      'restart cancelling the conflict prompt keeps the current remote instance',
      { foreign: 778 },
      'cancel',
      ({ service, host, stopped, starts }) => {
        assert.deepEqual(stopped, [])
        assert.equal(hostView(service).remote.port, 38001)
        assert.equal(hostView(service).progress.code, 'ready')
        assert.equal(starts(), 1, 'a cancelled restart does not launch a second instance')
      },
    ],
    [
      'cancelling the conflict prompt never stops the managed instance first',
      { foreign: 777, registry: true, fixedStart: true },
      'cancel',
      ({ service, stopped, starts }) => {
        assert.deepEqual(stopped, [])
        assert.equal(hostView(service).remote.port, 38123)
        assert.equal(starts(), 1)
      },
    ],
  ]
  for (const [name, spec, action, check] of cases) {
    const registry = registryStore(null)
    const stops = stopRecorder()
    const start = spec.fixedStart ? restartedStartWeb() : countingStartWeb()
    const foreign = []
    const { service, host } = await connectedService({
      ...(spec.registry ? { registry } : { readRegistry: async () => null }),
      findForeign: foreignScan(foreign),
      stops,
      start,
    })
    const statuses = statusesOf(service)
    if (spec.registry) registry.set(REGISTRY)
    foreign.push({ pid: spec.foreign, command: 'node /opt/dsh/bin.js web --profile web --no-open' })
    await service.restart(host.id)
    await waitFor(() => hostView(service).status === 'conflict-pending', { label: name })
    assert.equal(hostView(service).conflict.processes[0].pid, spec.foreign)
    assert.deepEqual(stops.stopped, [], 'nothing may be stopped before the user decides')
    await service.confirmConflict(host.id, { action })
    if (action === 'alongside') await settled(service, 38002, `${name}: restarted alongside`)
    else {
      await waitFor(() => hostView(service).status === 'connected', { label: `${name}: restored` })
    }
    await check({ service, host, stopped: stops.stopped, starts: start.count, seen: statuses })
    await service.shutdown()
  }
})
// A restart after the connection re-attached to a pid it did not launch. The prompt is the same as a connect conflict;
// rows are `[name, action, checkFn]` and keep their own expectations.
test('a restart after a re-attach asks before starting a second instance', async () => {
  const cases = [
    [
      'a re-attach to a pid this connection did not launch grants no kill rights',
      'stop',
      {
        before: ({ registry, runtime }) => {
          assert.equal(registry.get().pid, 777)
          assert.equal(registry.get().origin, 'reattach')
          assert.equal(runtime.launched.has(777), false)
        },
        pending: ({ stopped, starts }) => {
          assert.equal(starts(), 1, 'no new instance may start before the user decides')
          assert.deepEqual(stopped, [])
        },
        after: ({ stopped, foreignStopped, starts, messages }) => {
          assert.deepEqual(stopped, [], 'the explicit conflict stop is not a stopWeb of the managed pid')
          assert.deepEqual(foreignStopped, [777])
          assert.match(messages, /not stopping pid 777 \(not-launched-by-this-connection\)/)
        },
      },
    ],
    [
      'restart after a re-attach asks before starting a second instance (cancel keeps the old one)',
      'cancel',
      {
        after: ({ service, runtime, stopped, foreignStopped, starts, before }) => {
          assert.equal(starts(), 1)
          assert.deepEqual(stopped, [])
          assert.deepEqual(foreignStopped, [])
          assert.equal(hostView(service).remote.port, 38010)
          assert.equal(hostView(service).remote.viewRev, before.viewRev)
          assert.notEqual(runtime.tunnel, null)
        },
      },
    ],
    [
      'restart after a re-attach can keep the old instance alongside, deliberately',
      'alongside',
      {
        after: ({ service, runtime, stopped, foreignStopped, starts }) => {
          assert.equal(starts(), 2)
          assert.deepEqual(stopped, [])
          assert.deepEqual(foreignStopped, [])
          assert.deepEqual(hostView(service).conflict, null)
          assert.deepEqual(runtime.alongsidePids, [777])
        },
      },
    ],
    [
      'a failed foreign scan never starts a second instance next to a re-attached one',
      'stop',
      {
        overrides: { findForeign: async () => ({ ok: false, reason: 'scan-failed' }) },
        pending: ({ service, host, starts, messages }) => {
          assert.equal(starts(), 1, 'a broken scan must not allow [start]')
          assert.match(messages, /foreign DSH: scan failed: scan-failed/)
        },
        after: ({ starts }) => {
          assert.equal(starts(), 2)
        },
      },
    ],
  ]
  for (const [name, action, hooks] of cases) {
    const made = await reattachedService(hooks.overrides)
    const before = hostView(made.service).remote
    const messages = messagesOf(made.service, made.host.id)
    hooks.before?.(made)
    await made.service.restart(made.host.id)
    await waitFor(() => hostView(made.service).status === 'conflict-pending', { label: `${name}: conflict` })
    assert.deepEqual(
      made.service.snapshot().hosts[0].conflict.processes.map((process) => process.pid),
      [777],
    )
    hooks.pending?.({ ...made, messages })
    await made.service.confirmConflict(made.host.id, { action })
    if (action === 'cancel') await waitFor(() => hostView(made.service).status === 'connected')
    else await settled(made.service, 38210)
    hooks.after?.({ ...made, before, messages: messagesOf(made.service, made.host.id) })
    await made.service.shutdown()
  }
})
/** A pid this connection may not signal: kept alongside, or recycled by an unrelated process. */
test('a pid kept alongside or reused is never added to the stop list', async () => {
  const cases = [
    [
      'a pid kept alongside is never added to the stop list',
      { prepare: ({ runtime }) => (runtime.alongsidePids = [4242]) },
      ({ stopped }) => assert.deepEqual(stopped, []),
      /not stopping pid 4242 \(kept-alongside\)/,
    ],
    [
      'a reused pid is never signalled as the old DSH',
      {
        startTimes: new Map([[4242, '1000']]),
        prepare: ({ service, host }) =>
          assert.equal(service.runtimes.get(host.id).launched.get(4242).startTime, '1000'),
        beforeRestart: (startTimes) => startTimes.set(4242, '9999'),
      },
      ({ stopped }) => assert.deepEqual(stopped, [], 'a reused pid must not be signalled with a stale identity'),
      /not stopping pid 4242 \(pid-reused\)/,
    ],
  ]
  for (const [name, spec, check, logPattern] of cases) {
    const registry = registryStore(null)
    const stops = stopRecorder()
    const start = restartedStartWeb()
    const startTimes = spec.startTimes ?? new Map()
    const { service, host, runtime } = await connectedService({
      registry,
      stops,
      start,
      processIdentity: async (_ssh, pid) => ({
        ok: true,
        startTime: startTimes.get(pid) ?? `5000-${pid}`,
        command: 'node /opt/dsh/bin.js web --profile web --no-open',
        dshHome: HOME,
      }),
    })
    registry.set(REGISTRY)
    spec.prepare?.({ service, host, runtime })
    spec.beforeRestart?.(startTimes)
    await service.restart(host.id)
    await settled(service, 38210, name)
    check({ stopped: stops.stopped })
    assert.match(messagesOf(service, host.id), logPattern)
    await service.shutdown()
  }
})

test('a disconnect during a restart wins: the stale restart cannot write state', async () => {
  const second = hold()
  const start = restartedStartWeb({ 2: second })
  const { service, host } = await connectedService({ start })
  await service.restart(host.id)
  await waitFor(() => hostView(service).status === 'connecting')
  await service.disconnect(host.id)
  assert.equal(hostView(service).status, 'disconnected')
  second.release()
  await sleep(30)
  assert.equal(hostView(service).status, 'disconnected')
  assert.equal(hostView(service).remote.localPort, null)
  await service.shutdown()
})

test('a disconnect during the registry write leaves no half-built tunnel', async () => {
  const { tunnels, factory } = tunnelRecorder()
  const write = hold()
  const start = restartedStartWeb()
  let writes = 0
  const { service, host } = await connectedService({
    tunnelFactory: factory,
    writeRegistry: async () => {
      writes += 1
      await write.promise
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
    start,
  })
  await service.restart(host.id)
  await waitFor(() => writes === 1, { label: 'registry write started' })
  await service.disconnect(host.id)
  write.release()
  await sleep(50)
  const runtime = service.runtimes.get(host.id)
  assert.equal(hostView(service).status, 'disconnected')
  assert.equal(runtime.tunnel, null)
  assert.equal(runtime.remote.localPort, null)
  assert.equal(tunnels.length, 1, 'no listener may be opened after the link was dropped')
  assert.equal(tunnels[0].tunnel.closed, true)
  await service.shutdown()
})
// A teardown that lands while a replacement listener is created. Rows are `[name, { trigger, keepAlive?, portBase },
// teardown, check]`; the body wires the hold and the teardown, so every row only names its scenario and the outcome.
test('a listener created under a dropped link is always closed', async () => {
  const cases = [
    [
      'a disconnect while the new listener is being created closes that listener',
      { trigger: 'restart', portBase: 45000 },
      'disconnect',
      ({ tunnels, runtime }) => {
        assert.equal(tunnels.length, 2)
        assert.equal(tunnels[1].tunnel.closed, true, 'the listener created after the drop must be closed')
        assert.equal(runtime.tunnel, null)
        assert.equal(runtime.remote.localPort, null)
      },
    ],
    [
      'removing the host while the new listener is being created cannot leak it',
      { trigger: 'restart', portBase: 46000 },
      'remove',
      ({ service, tunnels }) => {
        assert.equal(service.snapshot().hosts.length, 0)
        assert.equal(tunnels[1].tunnel.closed, true, 'a removed host must not leave a listener behind')
      },
    ],
    ...['keep', 'stop', 'idle'].map((policy) => [
      `a disconnect during a tunnel rebuild leaves no listener (keepAlive=${policy})`,
      { trigger: 'rebuild', keepAlive: policy, portBase: 47000 },
      'disconnect',
      ({ service, tunnels, runtime }) => {
        assert.equal(hostView(service).status, 'disconnected')
        assert.equal(runtime.tunnel, null)
        assert.equal(runtime.remote.localPort, null)
        assert.equal(tunnels.length, 2)
        assert.equal(tunnels[1].tunnel.closed, true, 'the listener created after the drop must be closed')
      },
    ]),
    [
      'removing a host during a tunnel rebuild cannot leak the new listener',
      { trigger: 'rebuild', portBase: 48000 },
      'remove',
      ({ service, tunnels, runtime }) => {
        assert.equal(service.snapshot().hosts.length, 0)
        assert.equal(tunnels.length, 2)
        assert.equal(tunnels[1].tunnel.closed, true, 'a removed host must not leave the rebuilt listener behind')
        assert.equal(runtime.tunnel, null)
      },
    ],
    [
      'shutting down during a tunnel rebuild closes the new listener',
      { trigger: 'rebuild', portBase: 49000 },
      'shutdown',
      ({ tunnels }) => {
        assert.equal(tunnels[1].tunnel.closed, true)
      },
    ],
  ]
  for (const [name, spec, teardown, check] of cases) {
    const spy = heldTunnels({ portBase: spec.portBase })
    const { service, host, runtime } = await connectedService({
      ...(spec.keepAlive === undefined ? {} : { host: { keepAlive: spec.keepAlive } }),
      tunnelFactory: spy.factory,
      tunnelProbe: async () => false,
      remoteStatus: async () => 200,
    })
    // A rebuild releases on a timer; a restart is released only after the teardown landed.
    if (spec.trigger === 'rebuild') setTimeout(spy.held.release, 20)
    if (spec.trigger === 'restart') await service.restart(host.id)
    else service.ctx.noteRemoteUnreachable(runtime, 'proxy')
    // Teardown cancels the continuation and waits for it, so the listener can never be published.
    await waitFor(() => spy.count() === 2, { label: `${name}: listener creating` })
    if (teardown === 'disconnect') await service.disconnect(host.id)
    else if (teardown === 'remove') await service.removeHost(host.id)
    else await service.shutdown()
    if (spec.trigger === 'restart') spy.held.release()
    await sleep(50)
    check({ service, host, runtime, tunnels: spy.tunnels })
    if (teardown !== 'shutdown') await service.shutdown()
  }
})
/** The same race on the stop path: the answer never arrives, so the action must stay cancelled. */
test('an unconfirmed stop cannot resurrect a torn-down connection', async () => {
  const cases = [
    [
      'a disconnect during an unconfirmed stop never resurrects the connection',
      'disconnect',
      ({ service, host, runtime, start }) => {
        assert.equal(hostView(service).status, 'disconnected')
        assert.equal(runtime.status, 'disconnected')
        assert.equal(runtime.tunnel, null)
        assert.equal(runtime.remote.localPort, null)
        assert.equal(runtime.heartbeatTimer, null, 'a late action must not start a heartbeat')
        assert.equal(start.count(), 1, 'a late action must not start a new instance')
        assert.throws(() => service.openInfo(host.id), uiUnreachable)
      },
    ],
    [
      'removing a host during an unconfirmed stop cannot resurrect it',
      'remove',
      ({ service, runtime, start }) => {
        assert.equal(service.snapshot().hosts.length, 0)
        assert.notEqual(runtime.status, 'connected', 'a removed runtime must not be resumed')
        assert.equal(runtime.tunnel, null)
        assert.equal(runtime.heartbeatTimer, null, 'a late action must not start a heartbeat on a removed host')
        assert.equal(start.count(), 1)
      },
    ],
  ]
  for (const [name, teardown, check] of cases) {
    const registry = registryStore(null)
    const stop = hold()
    const stops = stopRecorder({ reply: { ok: false, output: 'still alive' }, after: () => stop.promise })
    const start = restartedStartWeb()
    const { service, host, runtime } = await connectedService({ registry, stops, start })
    registry.set(REGISTRY)
    assert.equal((await service.restart(host.id)).accepted, true, `${name}: the stop stays in flight`)
    await waitFor(() => stops.stopped.length === 1, { label: 'stopWeb in flight' })
    const work = teardown === 'disconnect' ? service.disconnect(host.id) : service.removeHost(host.id)
    stop.release()
    await work
    await sleep(60)
    check({ service, host, runtime, start })
    await service.shutdown()
  }
})

test('a restart does not start a second instance when the old one did not confirm its stop', async () => {
  const registry = registryStore(null)
  const stops = stopRecorder({ reply: { ok: false, output: 'still alive' } })
  const start = restartedStartWeb()
  const { service, host, runtime } = await connectedService({ registry, stops, start })
  registry.set(REGISTRY)
  await service.restart(host.id)
  await waitFor(() => hostView(service).status === 'connected' && hostView(service).warning != null, {
    label: 'restart aborted with a warning',
  })
  assert.equal(start.count(), 1, 'an unconfirmed stop must never lead to a second instance')
  assert.deepEqual(stops.stopped, [4242])
  assert.equal(hostView(service).remote.port, 38123)
  assert.match(hostView(service).warning.en, /did not confirm its stop/)
  assert.equal(runtime.launched.has(4242), true, 'the pid is still ours; nothing was confirmed stopped')
  await service.shutdown()
})

test('teardown does not wait forever for a stuck tunnel rebuild', async () => {
  const spy = heldTunnels({ portBase: 49500 })
  const { service, host, runtime } = await connectedService({
    tunnelProbe: async () => false,
    remoteStatus: async () => 200,
    tunnelRepairSettleMs: 10,
    tunnelFactory: spy.factory,
  })
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await waitFor(() => spy.count() === 2, { label: 'rebuild listener creating' })
  // Release long after the settle timeout: teardown must return before this.
  setTimeout(spy.held.release, 400)
  const started = Date.now()
  await service.disconnect(host.id)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 300, `disconnect waited ${elapsed}ms for a stuck rebuild`)
  assert.equal(hostView(service).status, 'disconnected')
  // Release the abandoned rebuild now: its token is gone, so its finally must close the listener.
  spy.held.release()
  await sleep(80)
  assert.equal(spy.tunnels[1].tunnel.closed, true, 'the abandoned rebuild still closes its listener')
  assert.equal(runtime.tunnel, null)
  await service.shutdown()
})

test('a tunnel rebuild bumps the view revision and replaces the listener', async () => {
  const { tunnels, factory } = tunnelRecorder()
  const { service, runtime } = await connectedService({
    tunnelFactory: factory,
    tunnelProbe: async () => false,
    remoteStatus: async () => 200,
  })
  const before = hostView(service).remote
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await waitFor(() => phases.includes('recovered'), { label: 'tunnel repaired' })
  const after = hostView(service).remote
  assert.equal(after.viewRev, before.viewRev + 1, 'the carrier must refetch open and re-navigate')
  assert.notEqual(after.localPort, before.localPort)
  assert.equal(after.localPort, runtime.tunnel.localPort)
  assert.equal(tunnels.length, 2)
  assert.equal(tunnels[0].tunnel.closed, true)
  assert.equal(tunnels[1].tunnel.closed, false)
  await service.shutdown()
})

test('a healthy local listener is not rebuilt for one failed request', async () => {
  const { tunnels, factory } = tunnelRecorder()
  let probes = 0
  const { service, runtime } = await connectedService({
    tunnelFactory: factory,
    tunnelProbe: async () => true,
    remoteStatus: async () => {
      probes += 1
      return 200
    },
  })
  const before = hostView(service).remote.viewRev
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await waitFor(() => phases.includes('recovered'))
  assert.equal(probes, 1)
  assert.equal(tunnels.length, 1, 'a listener that still answers is not rebuilt')
  assert.equal(hostView(service).remote.viewRev, before)
  await service.shutdown()
})

test('a broken tunnel under a healthy remote is rebuilt once instead of flapping', async () => {
  const { tunnels, factory } = tunnelRecorder()
  let probes = 0
  const { service, runtime } = await connectedService({
    tunnelFactory: factory,
    remoteStatus: async () => {
      probes += 1
      return 200
    },
  })
  const phases = []
  service.on('remote-unreachable', (event) => phases.push(event.phase))
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await waitFor(() => phases.includes('recovered'), { label: 'tunnel repaired' })
  assert.deepEqual(phases, ['suspected', 'recovered'])
  assert.equal(tunnels.length, 2, 'the local listener is rebuilt')
  assert.equal(tunnels[0].tunnel.closed, true)
  assert.notEqual(runtime.tunnel, null)
  assert.equal(hostView(service).remote.localPort, tunnels[1].localPort)

  const probesBefore = probes
  service.ctx.noteRemoteUnreachable(runtime, 'proxy')
  await sleep(30)
  assert.deepEqual(phases, ['suspected', 'recovered'], 'a second report inside the cooldown is ignored')
  assert.equal(probes, probesBefore)
  await service.shutdown()
})

test('a failed tunnel rebuild backs off instead of rebuilding in a storm', async () => {
  let calls = 0
  const { service, runtime } = await connectedService({
    tunnelProbe: async () => false,
    tunnelFactory: async () => {
      calls += 1
      if (calls === 2) throw new Error('cannot listen on a loopback port')
      return new FakeTunnel(45000 + calls)
    },
  })
  const first = await repairTunnel(service.ctx, runtime)
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'rebuild-failed')
  assert.ok(runtime.nextTunnelRepairAt > Date.now())
  const second = await repairTunnel(service.ctx, runtime)
  assert.equal(second.reason, 'backoff')
  assert.equal(calls, 2, 'no second listener attempt inside the backoff window')
  // The old listener was never closed: a failed rebuild leaves the connection usable.
  assert.notEqual(runtime.tunnel, null)
  runtime.nextTunnelRepairAt = 0
  const third = await repairTunnel(service.ctx, runtime)
  assert.equal(third.ok, true)
  assert.equal(calls, 3)
  await service.shutdown()
})

test('a successful restart clears the tunnel rebuild backoff', async () => {
  const start = restartedStartWeb()
  const { service, host, runtime } = await connectedService({ start })
  runtime.nextTunnelRepairAt = Date.now() + 60_000
  runtime.tunnelRepairFailures = 2
  await service.restart(host.id)
  await settled(service, 38210)
  assert.equal(runtime.nextTunnelRepairAt, 0)
  assert.equal(runtime.tunnelRepairFailures, 0)
  await service.shutdown()
})

test('a successful restart clears only the unconfirmed-stop warning', async () => {
  const registry = registryStore(null)
  let stops = 0
  const stopWeb = async () => {
    stops += 1
    return stops === 1 ? { ok: false, output: 'still alive' } : { ok: true, output: 'STOPPED' }
  }
  let starts = 0
  const startWeb = async () => {
    starts += 1
    return webInfo(38000 + starts, `tok_${starts}`, starts === 1 ? 4242 : 4300 + starts)
  }
  const { service, host, runtime } = await connectedService({ registry, stops: { stopWeb }, start: { startWeb } })
  registry.set(REGISTRY)
  await service.restart(host.id)
  await waitFor(() => hostView(service).status === 'connected' && runtime.warningSource === 'restart-stop', {
    label: 'unconfirmed stop warning',
  })
  assert.ok(runtime.warning)
  await service.restart(host.id)
  await settled(service, 38002)
  assert.equal(runtime.warning, null, 'a successful restart makes the stop warning stale')
  assert.equal(runtime.warningSource, null)
  // An alongside warning describes a process that is still running: it survives a restart.
  runtime.warning = { zh: '并存', en: 'alongside' }
  runtime.warningSource = 'alongside'
  await service.restart(host.id)
  await settled(service, 38003)
  assert.equal(runtime.warningSource, 'alongside')
  assert.deepEqual(runtime.warning, { zh: '并存', en: 'alongside' })
  await service.shutdown()
})

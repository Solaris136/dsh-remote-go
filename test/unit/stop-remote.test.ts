import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeTunnel, createHost, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { remoteHeartbeatTick } from '../../dist/src/watchdog.js'

const LAYOUT_HOME = '/home/ubuntu/.dsh'

function registryStore(initial = null) {
  let value = initial
  return {
    read: async () => value,
    write: async (_ssh, _layout, record) => {
      value = record
      return { ok: true, output: 'REGISTRY-WRITTEN' }
    },
    clear: () => {
      value = null
    },
    set: (next) => {
      value = next
    },
    get: () => value,
  }
}

function registryRecord(pid = 4242, port = 38123) {
  return {
    pid,
    port,
    profile: 'web',
    dshHome: LAYOUT_HOME,
    launch: 'browser-carrier-v1',
    origin: 'launch',
  }
}

function webInfo(port, token, pid) {
  return {
    pid,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    logPath: `${LAYOUT_HOME}/remote-go/logs/web.log`,
    startedAt: new Date().toISOString(),
    rawLine: '',
    profile: 'web',
    dshHome: LAYOUT_HOME,
  }
}

function messagesOf(service, id) {
  const runtime = service.runtimes.get(id)
  return (runtime?.logs ?? []).map((entry) => entry.message).join('\n')
}

/** Connect one host the ordinary way and hand back its runtime. */
async function connectHost(service, host) {
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  return service.runtimes.get(host.id)
}

test('stop refuses every state that cannot support it', async () => {
  const { service } = await makeTestService({
    readRegistry: async () => registryRecord(),
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
  // Never connected at all.
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable',
  )
  await connectHost(service, host)
  // A host that is busy with another one-shot action cannot interleave.
  runtime.linkBusy = 'restart'
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable' && /busy|连接动作/.test(error.detail.zh + error.detail.en),
  )
  runtime.linkBusy = null
  runtime.connectPromise = Promise.resolve()
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable',
  )
  runtime.connectPromise = null
  // Every other status is refused too.
  for (const status of [
    'unconfigured',
    'disconnected',
    'connecting',
    'fingerprint-pending',
    'conflict-pending',
    'limited',
  ]) {
    runtime.status = status
    await assert.rejects(
      () => service.stopRemote(host.id),
      (error) => error.code === 'stop-unavailable',
      status,
    )
  }
  runtime.status = 'error'
  runtime.error = { code: 'auth' }
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable',
  )
  // None of the refusals may have touched the remote or the local link.
  assert.equal(runtime.ssh.connected, true)
  assert.equal(runtime.tunnel.closed, false)
  await service.shutdown()
})

test('stop the launched instance: the pid is signalled and the host is kept disconnected', async () => {
  const registry = registryStore(null)
  const stopped = []
  const tunnels = []
  let starts = 0
  const { service, events } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    tunnelFactory: async (options) => {
      const tunnel = new FakeTunnel(45100 + tunnels.length + 1)
      tunnels.push({ remotePort: options.remotePort, tunnel })
      return tunnel
    },
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      // `stopRemoteWeb` removes run/web.json as part of the stop.
      registry.clear()
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return webInfo(38123, 'tok_first', 4242)
    },
  })
  const host = await createHost(service, { keepAlive: 'idle' })
  await connectHost(service, host)
  registry.set(registryRecord())
  const runtime = service.runtimes.get(host.id)
  const sshEvents = events.filter((event) => event.type === 'ssh').length

  const result = await service.stopRemote(host.id)
  assert.deepEqual(result, { ok: true, pid: 4242 })

  // Only the one bound pid was signalled, once.
  assert.deepEqual(stopped, [4242])
  const view = service.snapshot().hosts[0]
  assert.equal(view.status, 'disconnected')
  assert.equal(view.progress, null)
  assert.equal(view.phase, null)
  assert.equal(view.error, null)
  assert.equal(view.remote.pid, null)
  assert.equal(view.remote.localPort, null)
  assert.equal(view.remote.uiReady, false)
  // The host entry itself is untouched: same id, same keep-alive, credentials kept.
  assert.equal(view.id, host.id)
  assert.equal(view.keepAlive, 'idle')
  assert.equal(service.snapshot().hosts.length, 1)
  // The link is released: tunnel closed, SSH disposed, no timer left behind.
  assert.equal(tunnels[0].tunnel.closed, true)
  assert.equal(runtime.tunnel, null)
  assert.equal(runtime.ssh, null)
  assert.equal(runtime.token, null)
  assert.equal(runtime.desired, 'idle')
  assert.equal(runtime.reconnectTimer, null)
  assert.equal(runtime.idleTimer, null, 'a stopped host must not arm the idle stop')
  assert.equal(runtime.bound, null)
  assert.equal(runtime.launched.has(4242), false)
  assert.equal(events.filter((event) => event.type === 'ssh').length, sshEvents, 'no new SSH session')
  assert.equal(starts, 1, 'stopping never launches anything')
  const messages = messagesOf(service, host.id)
  assert.match(messages, /stop remote requested \(pid=4242, remote port=38123\)/)
  assert.match(messages, /stop remote: stopped the managed remote web pid=4242/)
  assert.match(messages, /stop remote: the remote DSH is stopped; the host is kept and can be reconnected/)
  // No stale registry left behind: the next connect starts a clean instance.
  assert.equal(registry.get(), null)
  // The old tunnel/token are gone from the API surface too.
  assert.throws(
    () => service.openInfo(host.id),
    (error) => error.code === 'remote-ui-unreachable',
  )
  await service.shutdown()
})

test('stop with keepAlive "stop" sends exactly one stop signal and arms no idle stop', async () => {
  const registry = registryStore(null)
  const stopped = []
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      registry.clear()
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  // The `stop` policy normally stops the remote web itself when the link is torn down; the
  // explicit action already did that, so teardown must not signal the pid a second time.
  const host = await createHost(service, { keepAlive: 'stop' })
  await connectHost(service, host)
  registry.set(registryRecord())
  const runtime = service.runtimes.get(host.id)
  assert.deepEqual(await service.stopRemote(host.id), { ok: true, pid: 4242 })
  assert.deepEqual(stopped, [4242], 'the managed pid is signalled once, by the explicit action')
  assert.equal(runtime.idleTimer, null)
  assert.equal(runtime.ssh, null)
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(service.snapshot().hosts[0].keepAlive, 'stop')
  await service.shutdown()
})

test('stop with keepAlive "stop" and an already-gone pid signals nothing', async () => {
  const registry = registryStore(null)
  const stopped = []
  const cleared = []
  let identityGone = false
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    clearRegistry: async (_ssh, layout) => {
      cleared.push(layout)
      registry.clear()
      return { ok: true, output: '' }
    },
    processIdentity: async (_ssh, pid) =>
      identityGone && pid === 4242
        ? { ok: false, reason: 'missing' }
        : {
            ok: true,
            startTime: `start-${pid}`,
            command: 'node /opt/dsh/bin.js web --profile web --no-open',
            dshHome: LAYOUT_HOME,
          },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service, { keepAlive: 'stop' })
  await connectHost(service, host)
  registry.set(registryRecord())
  identityGone = true
  assert.deepEqual(await service.stopRemote(host.id), { ok: true, pid: 4242 })
  // The pid was proven missing: the action only clears its registry, and the `stop` policy's
  // teardown must not send the signal the action deliberately did not send.
  assert.deepEqual(stopped, [], 'a pid proven gone must never be signalled by the teardown either')
  assert.equal(cleared.length, 1)
  assert.equal(service.runtimes.get(host.id).idleTimer, null)
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  await service.shutdown()
})

test('a stopped host never reconnects on its own', async () => {
  const registry = registryStore(null)
  let starts = 0
  const { service, events } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    stopWeb: async () => {
      registry.clear()
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts += 1
      return webInfo(38123, 'tok_first', 4242)
    },
  })
  const host = await createHost(service)
  await connectHost(service, host)
  registry.set(registryRecord())
  const runtime = service.runtimes.get(host.id)
  const sshEvents = events.filter((event) => event.type === 'ssh').length
  await service.stopRemote(host.id)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(runtime.reconnectAttempts, 0)
  assert.equal(events.filter((event) => event.type === 'ssh').length, sshEvents)
  assert.equal(starts, 1)
  await service.shutdown()
})

test('stop reports stopping-remote while the remote process is being stopped', async () => {
  const registry = registryStore(null)
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async () => {
      await gate
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  await connectHost(service, host)
  registry.set(registryRecord())
  const work = service.stopRemote(host.id)
  await waitFor(
    () => {
      const view = service.snapshot().hosts[0]
      return view.status === 'connecting' && view.progress?.code === 'stopping-remote'
    },
    { label: 'stopping-remote progress' },
  )
  const view = service.snapshot().hosts[0]
  assert.equal(view.phase, 'start')
  assert.deepEqual(view.progress, { code: 'stopping-remote', params: { pid: 4242, port: 38123 } })
  release()
  await work
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  await service.shutdown()
})

test('stop from remote-unreachable clears the stale registry and releases the link', async () => {
  const registry = registryStore(null)
  const stopped = []
  const cleared = []
  let identityGone = false
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    clearRegistry: async (_ssh, layout) => {
      cleared.push(layout)
      registry.clear()
      return { ok: true, output: '' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
    remoteStatus: async () => null,
    resolveRemote: async () => ({ ok: false, reason: 'no-running-web' }),
    processIdentity: async (_ssh, pid) =>
      identityGone && pid === 4242
        ? { ok: false, reason: 'missing' }
        : {
            ok: true,
            startTime: `start-${pid}`,
            command: 'node /opt/dsh/bin.js web --profile web --no-open',
            dshHome: LAYOUT_HOME,
          },
  })
  const host = await createHost(service, { keepAlive: 'keep' })
  await connectHost(service, host)
  registry.set(registryRecord())
  await remoteHeartbeatTick(service.ctx, service.runtimes.get(host.id))
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'remote-unreachable' })
  assert.equal(service.snapshot().hosts[0].error.code, 'remote-unreachable')
  // The process that used to back this host is gone before the user asks to close it.
  identityGone = true

  const result = await service.stopRemote(host.id)
  assert.deepEqual(result, { ok: true, pid: 4242 })
  // The process is already gone: nothing is signalled, only its stale record is removed.
  assert.deepEqual(stopped, [])
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].runFile.endsWith('/remote-go/run/web.json'), true)
  assert.equal(registry.get(), null)
  const view = service.snapshot().hosts[0]
  assert.equal(view.status, 'disconnected')
  assert.equal(view.error, null)
  assert.equal(service.runtimes.get(host.id).ssh, null)
  assert.match(messagesOf(service, host.id), /stop remote: the bound remote process pid=4242 is already gone/)
  await service.shutdown()
})

test('stop refuses a pid the run registry does not name', async () => {
  const registry = registryStore(null)
  const stopped = []
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  await connectHost(service, host)
  // The launch's registry record was removed (or was never written).
  registry.set(null)
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable' && /run\/web\.json/.test(error.detail.zh + error.detail.en),
  )
  assert.deepEqual(stopped, [])
  const view = service.snapshot().hosts[0]
  assert.equal(view.status, 'connected', 'a refused stop keeps the live connection')
  assert.equal(view.progress.code, 'ready')
  assert.equal(service.runtimes.get(host.id).ssh.connected, true)
  // The refusal is written to the connect log as an explained failure, not one code line.
  const logs = messagesOf(service, host.id)
  assert.match(logs, /Stopping the remote DSH failed/)
  assert.match(logs, /Reason: .*run\/web\.json/)
  assert.match(logs, /Details:\nreason=registry-mismatch pid=4242/)
  await service.shutdown()
})

test('stop never signals a pid this connection did not launch or take over', async () => {
  const registry = registryStore(null)
  const stopped = []
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  const runtime = await connectHost(service, host)
  registry.set(registryRecord())
  // The registry names the pid, but nothing proves this connection owns it any more.
  runtime.launched.delete(4242)
  runtime.bound = null
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) =>
      error.code === 'stop-unavailable' && /不是本连接启动或接管的实例/.test(error.detail.zh + error.detail.en),
  )
  assert.deepEqual(stopped, [], 'an unowned pid must never be signalled')
  assert.equal(service.snapshot().hosts[0].status, 'connected')
  assert.match(messagesOf(service, host.id), /reason=not-launched-by-this-connection/)
  await service.shutdown()
})

test('stop never signals a pid kept alongside the managed instance', async () => {
  const registry = registryStore(null)
  const stopped = []
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  const runtime = await connectHost(service, host)
  registry.set(registryRecord())
  runtime.alongsidePids = [4242]
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable' && /保留/.test(error.detail.zh + error.detail.en),
  )
  assert.deepEqual(stopped, [])
  assert.equal(service.snapshot().hosts[0].status, 'connected')
  assert.match(messagesOf(service, host.id), /reason=kept-alongside/)
  await service.shutdown()
})

test('stop never signals a pid that was reused by another process', async () => {
  const registry = registryStore(null)
  const stopped = []
  let startTime = '1000'
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      return { ok: true, output: 'STOPPED' }
    },
    processIdentity: async (_ssh, pid) => ({
      ok: true,
      startTime,
      command: 'node /opt/dsh/bin.js web --profile web --no-open',
      dshHome: LAYOUT_HOME,
    }),
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  await connectHost(service, host)
  registry.set(registryRecord())
  assert.equal(service.runtimes.get(host.id).launched.get(4242).startTime, '1000')
  // The remote pid now belongs to a different process: the kernel start time moved.
  startTime = '9999'
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable' && /pid/.test(error.detail.zh + error.detail.en),
  )
  assert.deepEqual(stopped, [], 'a reused pid must never be signalled')
  assert.equal(service.snapshot().hosts[0].status, 'connected')
  assert.match(messagesOf(service, host.id), /reason=pid-reused/)
  await service.shutdown()
})

test('stop a re-attached instance, then reconnect starts a clean new one', async () => {
  const registry = registryStore(null)
  const stopped = []
  const starts = []
  const tunnels = []
  const { service } = await makeTestService({
    readRegistry: registry.read,
    writeRegistry: registry.write,
    tunnelFactory: async (options) => {
      const tunnel = new FakeTunnel(46000 + tunnels.length + 1)
      tunnels.push({ remotePort: options.remotePort, tunnel })
      return tunnel
    },
    stopWeb: async (_ssh, _layout, options) => {
      stopped.push(options?.pid)
      registry.clear()
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => {
      starts.push(true)
      return starts.length === 1 ? webInfo(38123, 'tok_first', 4242) : webInfo(38444, 'tok_second', 4343)
    },
    remoteStatus: async () => null,
    resolveRemote: async () => ({
      ok: true,
      pid: 777,
      port: 38010,
      token: 'tok_reattached',
      url: 'http://127.0.0.1:38010/?token=tok_reattached',
      version: '0.2.2-rc.1',
      profile: 'web',
      dshHome: LAYOUT_HOME,
      source: 'log',
    }),
  })
  const host = await createHost(service)
  const runtime = await connectHost(service, host)
  registry.set(registryRecord())
  // The remote restarted itself: the watchdog re-attaches to pid 777 (origin reattach).
  await remoteHeartbeatTick(service.ctx, runtime)
  await waitFor(() => service.snapshot().hosts[0].remote.pid === 777, { label: 're-attached' })
  assert.equal(runtime.launched.has(777), false, 'a re-attached pid grants no restart kill rights')
  assert.deepEqual(runtime.bound, { pid: 777, startTime: 'start-777', origin: 'reattach' })
  assert.equal(registry.get().origin, 'reattach')

  // The user explicitly stops it: exactly the bound pid is signalled.
  const result = await service.stopRemote(host.id)
  assert.deepEqual(result, { ok: true, pid: 777 })
  assert.deepEqual(stopped, [777])
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(runtime.bound, null)
  assert.equal(registry.get(), null)

  // Reconnect must start a fresh instance instead of tripping over a leftover registry.
  await service.reconnect(host.id)
  await waitFor(
    () => {
      const view = service.snapshot().hosts[0]
      return view.status === 'connected' && view.remote.port === 38444
    },
    { label: 'reconnected on a new instance' },
  )
  const view = service.snapshot().hosts[0]
  assert.equal(starts.length, 2)
  assert.equal(view.remote.pid, 4343)
  assert.notEqual(view.remote.port, 38010, 'the reconnect launches a new remote instance')
  assert.equal(view.error, null)
  assert.match(service.openInfo(host.id).url, /tok_second$/)
  const messages = messagesOf(service, host.id)
  assert.doesNotMatch(messages, /conflict-pending|foreign DSH/)
  await service.shutdown()
})

test('a failed stop keeps the connected link and explains the reason', async () => {
  const registry = registryStore(null)
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async () => ({ ok: false, output: 'kill: Operation not permitted' }),
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  const runtime = await connectHost(service, host)
  registry.set(registryRecord())
  await assert.rejects(
    () => service.stopRemote(host.id),
    (error) => error.code === 'stop-unavailable' && /干净停止|clean stop/.test(error.detail.zh + error.detail.en),
  )
  const view = service.snapshot().hosts[0]
  assert.equal(view.status, 'connected')
  assert.equal(view.progress.code, 'ready')
  assert.equal(view.error, null)
  assert.equal(runtime.ssh.connected, true, 'a failed stop keeps the SSH session')
  assert.notEqual(runtime.tunnel, null)
  const logs = messagesOf(service, host.id)
  assert.match(logs, /Stopping the remote DSH failed/)
  assert.match(logs, /Operation not permitted/)
  await service.shutdown()
})

test('a disconnect during the stop owns the final state', async () => {
  const registry = registryStore(null)
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service } = await makeTestService({
    readRegistry: registry.read,
    stopWeb: async () => {
      await gate
      return { ok: true, output: 'STOPPED' }
    },
    startWeb: async () => webInfo(38123, 'tok_first', 4242),
  })
  const host = await createHost(service)
  await connectHost(service, host)
  registry.set(registryRecord())
  const work = service.stopRemote(host.id)
  await waitFor(() => service.snapshot().hosts[0].progress?.code === 'stopping-remote')
  await service.disconnect(host.id)
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  release()
  const result = await work
  assert.deepEqual(result, { ok: true, pid: 4242 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // The late stop must not resurrect a connection state after the disconnect.
  assert.equal(service.snapshot().hosts[0].status, 'disconnected')
  assert.equal(service.runtimes.get(host.id).ssh, null)
  await service.shutdown()
})

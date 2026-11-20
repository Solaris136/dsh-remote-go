import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { cancelIdleStop, stopRemoteForIdle } from '../../dist/src/host-lifecycle.js'
import { layoutForRuntime, remoteLayout } from '../../dist/src/layout.js'

const HOME = '/home/ubuntu'
const viewOf = (service) => service.snapshot().hosts[0]
const unknownHome = (error) =>
  error.code === 'internal' && /remote home directory is unknown/.test(error.technical ?? '')
const identityOf = (startTime = 'start-4242') => ({
  ok: true,
  startTime,
  command: 'node /home/ubuntu/.dsh/remote-go/node/v24.9.0/bin/npx -y @deepseek-ai/dsh@0.2.2-rc.1 --profile web',
  dshHome: '/home/ubuntu/.dsh',
})
// An idle-kept host that was connected once and then disconnected, so its idle timer is armed - the state every case
// starts from. `stopped` records each `stopWeb` call.
async function idleService(overrides = {}) {
  const stopped = []
  const { service } = await makeTestService({
    stopWeb: async (_ssh, layout, options) => {
      stopped.push({ layout, pid: options?.pid })
      return { ok: true, output: 'STOPPED' }
    },
    ...overrides,
  })
  const host = await createHost(service, { keepAlive: 'idle' })
  await service.connect(host.id)
  await waitFor(() => viewOf(service).status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  const ssh = runtime.ssh
  await service.disconnect(host.id)
  return { service, host, runtime, ssh, stopped }
}

test('a remote layout refuses an unknown home instead of building a literal-tilde path', () => {
  for (const value of [null, undefined, '', '   ', '~', 'relative/home']) {
    assert.throws(() => remoteLayout(value), unknownHome, `remoteLayout(${JSON.stringify(value)}) must throw`)
  }
  assert.equal(remoteLayout(HOME).logFile, '/home/ubuntu/.dsh/remote-go/logs/web.log')
  assert.equal(remoteLayout('/srv/app/').root, '/srv/app/.dsh/remote-go')
})

test('a runtime layout prefers live facts and falls back to the remembered home', () => {
  assert.equal(
    layoutForRuntime({ facts: { home: HOME }, remoteHome: '/elsewhere' }).root,
    '/home/ubuntu/.dsh/remote-go',
  )
  assert.equal(layoutForRuntime({ facts: null, remoteHome: HOME }).root, '/home/ubuntu/.dsh/remote-go')
  assert.throws(() => layoutForRuntime({ facts: null, remoteHome: null }), unknownHome)
})

test('the idle policy remembers the real remote home and pid across the teardown', async () => {
  const { service, runtime, ssh, stopped } = await idleService()
  // The teardown clears `facts`/`remote`, but the idle timer still
  // has to know where the remote lives and what it may stop (H1).
  assert.equal(runtime.facts, null)
  assert.equal(runtime.remote.pid, null)
  assert.equal(runtime.remoteHome, HOME)
  assert.equal(runtime.remotePid, 4242)
  assert.ok(runtime.idleTimer !== null, 'the idle policy must arm its timer')
  cancelIdleStop(runtime)
  assert.equal((await stopRemoteForIdle(service.ctx, runtime)).ok, true)
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].layout.dshHome, '/home/ubuntu/.dsh')
  assert.equal(stopped[0].layout.logFile, '/home/ubuntu/.dsh/remote-go/logs/web.log')
  assert.equal(stopped[0].pid, 4242, 'the idle stop must signal the pid it remembered')
  assert.equal(stopped[0].layout.root.includes('~'), false, 'no literal tilde may reach the remote shell')
  assert.equal(ssh.disposed, true)
  await service.shutdown()
})

test('an idle stop never touches a live link, whichever timer fired it', async () => {
  const stopped = []
  const { service } = await makeTestService({
    stopWeb: async () => {
      stopped.push(true)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service, { keepAlive: 'idle' })
  await service.connect(host.id)
  await waitFor(() => viewOf(service).status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  const liveSsh = runtime.ssh
  assert.deepEqual(await stopRemoteForIdle(service.ctx, runtime), { ok: false, reason: 'still-wanted' })
  assert.equal(stopped.length, 0)
  assert.equal(liveSsh.disposed, false)
  assert.equal(runtime.ssh, liveSsh)
  assert.equal(runtime.status, 'connected')
  await service.shutdown()
})
// Both rows refuse before `stopWeb` is reached: one has no home to address, one has no pid it owns.
const refusedBeforeStop = [
  [
    'an idle stop with no known home skips the remote instead of shelling a tilde path',
    (runtime) => {
      runtime.remoteHome = null
      runtime.facts = null
      runtime.remotePid = null
    },
    'no-home',
  ],
  [
    'an idle stop with no pid refuses instead of letting the registry pick one',
    (runtime) => {
      runtime.remotePid = null
      runtime.bound = null
      runtime.launched = new Map()
    },
    'pid-unknown',
  ],
]
for (const [name, forget, reason] of refusedBeforeStop) {
  test(name, async () => {
    const { service, runtime, stopped } = await idleService()
    // Forget what the connection knew about the remote: there is nothing safe to address.
    forget(runtime)
    assert.deepEqual(await stopRemoteForIdle(service.ctx, runtime), { ok: false, reason })
    assert.deepEqual(stopped, [], 'no stop call at all')
    await service.shutdown()
  })
}

test('connecting again cancels the idle timer and releases the idle-kept transport', async () => {
  const { service, host, runtime, ssh: idleSsh, stopped } = await idleService()
  assert.ok(runtime.idleTimer !== null, 'the idle timer is armed while disconnected')
  // The Client's "Connect" on a disconnected card is this call, not `reconnect`.
  await service.connect(host.id)
  await waitFor(() => viewOf(service).status === 'connected', { label: 'connected again' })
  assert.equal(runtime.idleTimer, null, 'a new link must not keep the previous idle timer')
  assert.notEqual(runtime.ssh, idleSsh)
  assert.equal(idleSsh.disposed, true, 'the transport kept for the idle policy is released')
  assert.equal(stopped.length, 0)
  // Even if the old timer callback still ran, it may not touch the live link.
  assert.deepEqual(await stopRemoteForIdle(service.ctx, runtime), { ok: false, reason: 'still-wanted' })
  assert.equal(stopped.length, 0, 'the idle policy must not stop a host that is connected')
  assert.equal(runtime.ssh.connected, true, 'the live transport is not released')
  assert.equal(runtime.status, 'connected')
  assert.notEqual(runtime.tunnel, null)
  await service.shutdown()
})

test('an idle stop refuses a pid whose /proc identity no longer matches the launch', async () => {
  const identity = { startTime: 'start-4242' }
  const { service, runtime, stopped } = await idleService({
    processIdentity: async () => identityOf(identity.startTime),
  })
  identity.startTime = 'start-reused'
  const reused = await stopRemoteForIdle(service.ctx, runtime)
  assert.equal(reused.ok, false)
  assert.equal(reused.reason, 'pid-reused')
  assert.equal(stopped.length, 0, 'a reused pid must never be signalled')

  // Without any proof of ownership the pid is left alone too.
  const host2 = await createHost(service, { name: 'second', address: 'second-host', keepAlive: 'idle' })
  await service.connect(host2.id)
  await waitFor(() => service.snapshot().hosts.find((view) => view.id === host2.id)?.status === 'connected', {
    label: 'second connected',
  })
  const runtime2 = service.runtimes.get(host2.id)
  await service.disconnect(host2.id)
  runtime2.launched = new Map()
  runtime2.bound = null
  identity.startTime = 'start-4242'
  const second = await stopRemoteForIdle(service.ctx, runtime2)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'not-owned')
  assert.equal(stopped.length, 0)
  await service.shutdown()
})

test('a connect that lands during the identity proof keeps its new transport', async () => {
  const state = { gateEnabled: false, identityStarted: false, release: null }
  const gate = new Promise((resolve) => {
    state.release = resolve
  })
  const {
    service,
    host,
    runtime,
    ssh: idleSsh,
    stopped,
  } = await idleService({
    processIdentity: async () => {
      // Only the idle stop's proof is parked; the connect and its identity read run normally, and the reconnect shares
      // the open gate.
      if (state.gateEnabled) {
        state.identityStarted = true
        await gate
      }
      return identityOf()
    },
  })
  state.gateEnabled = true
  const idleStop = stopRemoteForIdle(service.ctx, runtime)
  await waitFor(() => state.identityStarted, { label: 'identity in flight' })
  await service.connect(host.id)
  state.release()
  assert.deepEqual(await idleStop, { ok: false, reason: 'still-wanted' })
  await waitFor(() => viewOf(service).status === 'connected', { label: 'connected again' })
  assert.equal(stopped.length, 0, 'the idle stop must not run once the link is live')
  assert.notEqual(runtime.ssh, idleSsh)
  assert.equal(idleSsh.disposed, true, 'the idle transport is released by the new connect')
  assert.equal(runtime.ssh.connected, true)
  assert.equal(runtime.ssh.disposed, false, 'the new transport is never disposed by the idle policy')
  await service.shutdown()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, makeTestService, waitFor } from '../helpers/fake-remote.js'
import { cancelIdleStop, stopRemoteForIdle } from '../../src/host-lifecycle.js'
import { layoutForRuntime, remoteLayout } from '../../src/layout.js'

const HOME = '/home/ubuntu'

test('a remote layout refuses an unknown home instead of building a literal-tilde path', () => {
  for (const value of [null, undefined, '', '   ', '~', 'relative/home']) {
    assert.throws(
      () => remoteLayout(value),
      (error) => error.code === 'internal' && /remote home directory is unknown/.test(error.technical ?? ''),
      `remoteLayout(${JSON.stringify(value)}) must throw`,
    )
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
  assert.throws(
    () => layoutForRuntime({ facts: null, remoteHome: null }),
    (error) => error.code === 'internal' && /remote home directory is unknown/.test(error.technical ?? ''),
  )
})

test('the idle policy remembers the real remote home and pid across the teardown', async () => {
  const stopped = []
  const { service } = await makeTestService({
    stopWeb: async (_ssh, layout, options) => {
      stopped.push({ layout, pid: options?.pid })
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service, { keepAlive: 'idle' })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  const ssh = runtime.ssh
  await service.disconnect(host.id)
  // The teardown clears `facts`/`remote`, but the idle timer still has to know where the
  // remote lives and which process it may stop (H1).
  assert.equal(runtime.facts, null)
  assert.equal(runtime.remote.pid, null)
  assert.equal(runtime.remoteHome, HOME)
  assert.equal(runtime.remotePid, 4242)
  assert.ok(runtime.idleTimer !== null, 'the idle policy must arm its timer')

  cancelIdleStop(runtime)
  const result = await stopRemoteForIdle(service.ctx, runtime)
  assert.equal(result.ok, true)
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].layout.dshHome, '/home/ubuntu/.dsh')
  assert.equal(stopped[0].layout.logFile, '/home/ubuntu/.dsh/remote-go/logs/web.log')
  assert.equal(stopped[0].pid, 4242, 'the idle stop must signal the pid it remembered')
  assert.equal(stopped[0].layout.root.includes('~'), false, 'no literal tilde may reach the remote shell')
  assert.equal(ssh.disposed, true)
  await service.shutdown()
})

test('an idle stop with no known home skips the remote instead of shelling a tilde path', async () => {
  const stopped = []
  const { service } = await makeTestService({
    stopWeb: async (_ssh, layout) => {
      stopped.push(layout)
      return { ok: true, output: 'STOPPED' }
    },
  })
  const host = await createHost(service, { keepAlive: 'idle' })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  await service.disconnect(host.id)
  // Forget what the connection knew about the remote: there is nothing safe to address.
  runtime.remoteHome = null
  runtime.facts = null
  runtime.remotePid = null
  const result = await stopRemoteForIdle(service.ctx, runtime)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-home')
  assert.deepEqual(stopped, [])
  await service.shutdown()
})

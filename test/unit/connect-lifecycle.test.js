import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSsh, FakeTunnel, createHost, makeFacts, makeTestService, waitFor } from '../helpers/fake-remote.js'
import { errors } from '../../src/errors.js'

function webInfo() {
  return {
    pid: 4242,
    port: 38123,
    token: 'tok_test',
    url: 'http://127.0.0.1:38123/?token=tok_test',
    logPath: '/home/ubuntu/.dsh/remote-go/logs/web.log',
    startedAt: new Date().toISOString(),
    rawLine: '',
    profile: 'web',
    dshHome: '/home/ubuntu/.dsh',
  }
}

function framesOf(service) {
  const frames = []
  service.on('state', (state) => frames.push(state))
  return frames
}

test('autoReconnect.maxAttempts is the real retry budget, not one attempt', async () => {
  let failing = false
  let attempts = 0
  const { service } = await makeTestService({
    sshFactory: (options) => {
      attempts += 1
      const ssh = new FakeSsh({ options })
      if (failing) {
        ssh.connect = async () => {
          throw errors.network({ zh: '链路已断。', en: 'the link is down' })
        }
      }
      return ssh
    },
  })
  await service.saveSettings({ autoReconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 10 } })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  const retryFrames = []
  service.on('state', (state) => {
    const progress = state.hosts[0]?.progress
    if (progress?.code === 'reconnecting') retryFrames.push(progress.params)
  })

  failing = true
  runtime.ssh.simulateClose()
  await waitFor(() => service.snapshot().hosts[0].status === 'error' && service.snapshot().hosts[0].progress === null, {
    timeoutMs: 20_000,
    label: 'retry budget spent',
  })
  // The initial connection plus exactly three retries: the budget was actually spent.
  assert.equal(attempts, 4, 'maxAttempts=3 must produce three retries after the drop')
  assert.equal(runtime.reconnectAttempts, 3)
  assert.equal(Math.max(...retryFrames.map((params) => params.attempt)), 3)
  assert.equal(service.snapshot().hosts[0].error.code, 'network')
  assert.doesNotMatch(JSON.stringify(service.snapshot().hosts[0].logs), /internal/)
  await service.shutdown()
})

test('a transport dropped during bootstrap is a network failure and is retried', async () => {
  const state = { host: null, service: null, failRetry: false, attempts: 0 }
  const { service } = await makeTestService({
    sshFactory: (options) => {
      state.attempts += 1
      const ssh = new FakeSsh({ options })
      if (state.failRetry) {
        ssh.connect = async () => {
          throw errors.network({ zh: '链路已断。', en: 'the link is down' })
        }
      }
      return ssh
    },
    probe: async () => {
      // The SSH session dies right after it was established, inside the probe step.
      state.failRetry = true
      state.service.runtimes.get(state.host.id)?.ssh?.simulateClose()
      throw new Error('channel closed while reading the probe output')
    },
  })
  state.service = service
  await service.saveSettings({ autoReconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 30 } })
  const host = await createHost(service)
  state.host = host
  const frames = framesOf(service)
  await service.connect(host.id)
  const runtime = service.runtimes.get(host.id)
  // The first failure must be classified as a dropped link, with a retry already armed -
  // never as an internal error and never with no timer at all (H3).
  await waitFor(
    () => runtime.status === 'error' && runtime.error?.code === 'network' && runtime.progress?.code === 'reconnecting',
    { timeoutMs: 5_000, label: 'network + reconnecting' },
  )
  assert.ok(runtime.reconnectTimer !== null, 'a retry must be scheduled')
  assert.match(JSON.stringify(frames), /"code":"network"/)
  assert.doesNotMatch(JSON.stringify(frames), /"code":"internal"/)

  await waitFor(() => runtime.status === 'error' && runtime.progress === null, {
    timeoutMs: 20_000,
    label: 'budget spent',
  })
  assert.equal(state.attempts, 3, 'the initial attempt plus two retries')
  assert.equal(runtime.error.code, 'network')
  await service.shutdown()
})

test('a host-key prompt that times out clears its pending state', async () => {
  const { service } = await makeTestService({
    hostKeyConfirmTimeoutMs: 60,
    sshFactory: (options) => {
      const ssh = new FakeSsh({
        options,
        connect: async () => {
          const accepted = await options.onHostKey({ sha256: 'SHA256:pending', keyType: 'ssh-ed25519' })
          if (accepted !== true) throw errors.hostKeyUnknown('SHA256:pending')
          ssh.connected = true
          return { fingerprint: 'SHA256:pending', keyType: 'ssh-ed25519' }
        },
      })
      return ssh
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  const runtime = service.runtimes.get(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { timeoutMs: 5_000, label: 'timeout' })
  assert.equal(runtime.pendingHostKey, null, 'a timed-out prompt must not stay pending')
  assert.equal(runtime.error.code, 'host-key-unknown')
  await waitFor(() => runtime.connectPromise === null, { label: 'pipeline settled' })
  await assert.rejects(
    () => service.confirmFingerprint(host.id, { accept: true, remember: true }),
    (error) => error.code === 'invalid-input',
  )
  await service.shutdown()
})

test('a disconnect during a host-key prompt settles the connect immediately', async () => {
  const { service } = await makeTestService({
    // Long enough that only the teardown can end the wait.
    hostKeyConfirmTimeoutMs: 60_000,
    sshFactory: (options) => {
      const ssh = new FakeSsh({
        options,
        connect: async () => {
          const accepted = await options.onHostKey({ sha256: 'SHA256:pending', keyType: 'ssh-ed25519' })
          if (accepted !== true) throw errors.hostKeyUnknown('SHA256:pending')
          ssh.connected = true
          return { fingerprint: 'SHA256:pending', keyType: 'ssh-ed25519' }
        },
      })
      return ssh
    },
  })
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'fingerprint-pending', { label: 'prompt' })
  const startedAt = Date.now()
  await service.disconnect(host.id)
  await waitFor(() => runtime.connectPromise === null, { timeoutMs: 5_000, label: 'pipeline settled' })
  assert.ok(Date.now() - startedAt < 2_000, 'the connect must not wait for the prompt timeout')
  assert.equal(runtime.pendingHostKey, null, 'a disconnect must clear the pending prompt')
  assert.equal(runtime.status, 'disconnected')
  await service.shutdown()
})

test('a transport that closes while a host-key prompt is open is a dropped link and is retried', async () => {
  const state = { failRetry: false }
  const { service } = await makeTestService({
    sshFactory: (options) => {
      const ssh = new FakeSsh({
        options,
        connect: async () => {
          if (state.failRetry) throw errors.network({ zh: '链路已断。', en: 'the link is down' })
          // The user is being asked about the key when the transport dies underneath.
          const asked = options.onHostKey({ sha256: 'SHA256:pending', keyType: 'ssh-ed25519' })
          setTimeout(() => {
            state.failRetry = true
            ssh.simulateClose()
          }, 20)
          const accepted = await asked
          if (accepted !== true) throw errors.hostKeyUnknown('SHA256:pending')
          ssh.connected = true
          return { fingerprint: 'SHA256:pending', keyType: 'ssh-ed25519' }
        },
      })
      return ssh
    },
  })
  await service.saveSettings({ autoReconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 30 } })
  const host = await createHost(service)
  const frames = framesOf(service)
  await service.connect(host.id)
  const runtime = service.runtimes.get(host.id)
  await waitFor(() => runtime.status === 'error' && runtime.error?.code === 'network', {
    timeoutMs: 8_000,
    label: 'network failure',
  })
  const serialized = JSON.stringify(frames)
  assert.doesNotMatch(serialized, /"code":"host-key-unknown"/, 'the close must not be reported as a key decision')
  assert.match(serialized, /"code":"reconnecting"/, 'the dropped link must arm a retry')
  await waitFor(() => runtime.status === 'error' && runtime.progress === null, {
    timeoutMs: 20_000,
    label: 'retry budget spent',
  })
  assert.equal(runtime.error.code, 'network')
  await service.shutdown()
})

const STAGES = ['probe', 'bootstrap', 'start', 'tunnel', 'verifying']

function stageOverrides(stage, state) {
  const facts = makeFacts()
  switch (stage) {
    case 'probe':
      return {
        probe: async () => {
          await state.act()
          return facts
        },
      }
    case 'bootstrap':
      return {
        preflight: async () => {
          await state.act()
          return '0.2.2-rc.1'
        },
      }
    case 'start':
      return {
        startWeb: async () => {
          await state.act()
          return webInfo()
        },
      }
    case 'tunnel':
      return {
        tunnelFactory: async () => {
          await state.act()
          const tunnel = new FakeTunnel(45124)
          state.tunnels.push(tunnel)
          return tunnel
        },
      }
    case 'verifying':
      return {
        waitUi: async () => {
          await state.act()
          return { ok: true, status: 200 }
        },
      }
    default:
      throw new Error(`unknown stage ${stage}`)
  }
}

for (const action of ['disconnect', 'removeHost']) {
  test(`${action} during any connect step never publishes a connected state`, async (t) => {
    for (const stage of STAGES) {
      await t.test(stage, async () => {
        const state = { service: null, host: null, tunnels: [], act: null }
        const { service } = await makeTestService(stageOverrides(stage, state))
        state.service = service
        const host = await createHost(service)
        state.host = host
        const frames = framesOf(service)
        state.act = async () => {
          if (action === 'disconnect') await service.disconnect(host.id)
          else await service.removeHost(host.id)
        }
        const runtime = service.runtimes.get(host.id)
        await service.connect(host.id)
        await waitFor(() => runtime.connectPromise === null, { timeoutMs: 5_000, label: `${stage} settled` })

        const hostFrames = frames.flatMap((frame) => frame.hosts.filter((view) => view.id === host.id))
        assert.equal(
          hostFrames.some((view) => view.status === 'connected'),
          false,
          'the connect must not report a connected host the user already closed',
        )
        assert.equal(
          hostFrames.some((view) => view.error?.code === 'internal' || view.error?.code === 'network'),
          false,
          `a cancelled connect must not publish a failure (${stage}/${action})`,
        )
        for (const tunnel of state.tunnels) assert.equal(tunnel.closed, true, 'the listener must be closed')
        if (action === 'disconnect') {
          assert.equal(runtime.status, 'disconnected')
          assert.equal(runtime.error, null)
          assert.equal(runtime.tunnel, null)
        } else {
          assert.equal(service.snapshot().hosts.length, 0)
          assert.equal(service.snapshot().activeHostId, null)
        }
        assert.doesNotThrow(() => service.snapshot())
        await service.shutdown()
      })
    }
  })
}

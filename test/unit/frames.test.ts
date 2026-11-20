/**
 * The `/state` frame sequence of the five connect paths: success, a host-key timeout, a dropped transport, a local
 * restart and the explicit "stop remote DSH". `fsm.test.ts` proves the state table; this one proves the *wiring* — a
 * listening Client must receive that sequence and must never see `connected` resurrected after the user closed the
 * link. The recorder keeps the ordered distinct triples: the service legitimately publishes the same state twice. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSsh, FakeTunnel, createHost, makeFacts, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { errors } from '../../dist/src/errors.js'

/** The `status` / `phase` / `progress.code` triple every frame carries for one host. */
function triple(view) {
  return { status: view?.status ?? null, phase: view?.phase ?? null, code: view?.progress?.code ?? null }
}

/** Record the distinct triples of one host for the rest of a test. */
function frameRecorder(service, hostId) {
  const frames = []
  service.on('state', (state) => {
    const next = triple(state.hosts.find((host) => host.id === hostId))
    if (JSON.stringify(frames.at(-1)) !== JSON.stringify(next)) frames.push(next)
  })
  return frames
}

/** `status/phase/code` strings, readable in an assertion diff. */
const strings = (frames) => frames.map((frame) => `${frame.status}/${frame.phase}/${frame.code}`)

/** A transport whose host-key prompt is answered by the service, not by the test. */
const pendingKeySsh =
  (sha256 = 'SHA256:pending') =>
  (options) => {
    const ssh = new FakeSsh({
      options,
      connect: async () => {
        const accepted = await options.onHostKey({ sha256, keyType: 'ssh-ed25519' })
        if (accepted !== true) throw errors.hostKeyUnknown(sha256)
        ssh.connected = true
        return { fingerprint: sha256, keyType: 'ssh-ed25519' }
      },
    })
    return ssh
  }

/** A saved host on a fresh service; the caller records frames before or after connecting. */
async function hostService(options = {}) {
  const { service } = await makeTestService(options)
  const host = await createHost(service)
  return { service, host, runtime: service.runtimes.get(host.id) }
}

/** A saved host already connected, as most of these cases start out. */
async function connectedService(options = {}) {
  const context = await hostService(options)
  await context.service.connect(context.host.id)
  await waitFor(() => context.service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  return context
}

test('golden frames: a successful connect walks connecting → ready and never regresses', async () => {
  const { service, host } = await hostService()
  const frames = frameRecorder(service, host.id)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  assert.deepEqual(strings(frames), [
    'connecting/null/null',
    'connecting/ssh/ssh-connecting',
    'connecting/probe/probing',
    'connecting/start/starting-remote',
    'connecting/bootstrap/bootstrapping',
    'connecting/start/starting-remote',
    'connecting/tunnel/tunneling',
    'connecting/verifying/verifying',
    'connected/ready/ready',
  ])
  // Nothing may follow the ready frame while the link is idle.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(service.snapshot().hosts[0].status, 'connected')
  assert.equal(strings(frames).at(-1), 'connected/ready/ready')
  await service.shutdown()
})

test('golden frames: a host-key timeout ends in error and disarms the prompt', async () => {
  const { service, host } = await hostService({ hostKeyConfirmTimeoutMs: 60, sshFactory: pendingKeySsh() })
  const frames = frameRecorder(service, host.id)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { timeoutMs: 5_000, label: 'timeout' })
  assert.deepEqual(strings(frames), [
    'connecting/null/null',
    'connecting/ssh/ssh-connecting',
    'fingerprint-pending/ssh/host-key-confirm',
    'error/null/null',
  ])
  assert.equal(service.snapshot().hosts[0].progress, null)
  assert.equal(service.snapshot().hosts[0].error.code, 'host-key-unknown')
  await service.shutdown()
})

test('golden frames: a dropped transport leaves disconnected and reports the lost link', async () => {
  const { service, host, runtime } = await hostService()
  await service.saveSettings({ autoReconnect: { enabled: false, maxAttempts: 3, baseDelayMs: 10 } })
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const frames = frameRecorder(service, host.id)
  // Auto-reconnect is off for this case: the drop is reported, not retried.
  runtime.ssh.simulateClose()
  await waitFor(() => runtime.status === 'disconnected', { label: 'dropped' })
  // The drop published `reconnecting` and today's policy-off path keeps that code.
  assert.deepEqual(strings(frames), ['disconnected/null/reconnecting'])
  assert.equal(runtime.transportLost, true)
  await service.shutdown()
})

test('golden frames: a local restart re-publishes connecting → ready on a new listener', async () => {
  const tunnels = []
  const { service, host, runtime } = await connectedService({
    tunnelFactory: async () => {
      const tunnel = new FakeTunnel(45123 + tunnels.length)
      tunnels.push(tunnel)
      return tunnel
    },
  })
  const frames = frameRecorder(service, host.id)
  assert.equal((await service.restart(host.id)).accepted, true)
  await waitFor(
    () => runtime.restartPromise === null && runtime.status === 'connected' && runtime.progress?.code === 'ready',
    {
      label: 'restarted',
    },
  )
  assert.deepEqual(strings(frames), [
    'connecting/start/restarting-remote',
    'connecting/tunnel/tunneling',
    'connecting/verifying/verifying',
    'connected/ready/ready',
  ])
  await service.shutdown()
})

test('golden frames: stopping the remote ends disconnected and never publishes connected again', async () => {
  // The explicit stop needs the run registry to name the bound pid (its ownership proof).
  const { service, host } = await connectedService({
    readRegistry: async () => ({
      pid: 4242,
      port: 38123,
      version: '0.2.2-rc.1',
      profile: 'web',
      dshHome: '/home/ubuntu/.dsh',
      origin: 'launch',
      startedAt: new Date().toISOString(),
    }),
  })
  const frames = frameRecorder(service, host.id)
  assert.equal((await service.stopRemote(host.id)).ok, true)
  const sequence = strings(frames)
  assert.deepEqual(sequence, ['connecting/start/stopping-remote', 'disconnected/null/null'])
  // After the user closed the link no frame may say `connected`.
  const disconnectedAt = sequence.findIndex((frame) => frame.startsWith('disconnected/'))
  assert.ok(disconnectedAt >= 0)
  assert.equal(
    sequence.slice(disconnectedAt).some((frame) => frame.startsWith('connected/')),
    false,
    'a frame after the disconnect still reports a connected host',
  )
  await service.shutdown()
})

test('golden frames: disconnecting during a connect never publishes connected', async () => {
  const { service, host, runtime } = await hostService({
    probe: async () => {
      // The user disconnects while the probe step is in flight.
      await service.disconnect(host.id)
      return makeFacts()
    },
  })
  const frames = frameRecorder(service, host.id)
  await service.connect(host.id)
  await waitFor(() => runtime.connectPromise === null, { timeoutMs: 5_000, label: 'settled' })
  assert.equal(runtime.status, 'disconnected')
  assert.equal(
    strings(frames).some((frame) => frame.startsWith('connected/')),
    false,
    'a cancelled connect must not publish a connected host',
  )
  assert.equal(
    strings(frames).some((frame) => frame.includes('/network/') || frame.includes('/internal/')),
    false,
    'a cancelled connect is not a failure',
  )
  await service.shutdown()
})

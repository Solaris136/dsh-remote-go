/**
 * The `/state` frame sequence of the five paths §6.2 (risks 1 and 3) names: connect success, a
 * host-key timeout, a transport that drops, a local restart and the explicit "stop remote DSH".
 *
 * The unit-level FSM golden test (`fsm.test.js`) proves the table; this one proves the *wiring*:
 * the frames a listening Client receives must carry the state machine's sequence and must never
 * resurrect a `connected` state after the user closed the link. It is the guard against
 * "state writes that bypass the FSM" and against an emit-count change that would flash a card.
 *
 * The helper collapses consecutive identical triples: the service legitimately publishes the same
 * state twice (the old catch/JSDoc emit points did, and they still do), and what the Client's
 * state machine must see is the *ordered distinct* sequence, not the duplicate count.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSsh, FakeTunnel, createHost, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { errors } from '../../dist/src/errors.js'

/** The `status` / `phase` / `progress.code` triple every frame carries for one host. */
function triple(view) {
  return {
    status: view?.status ?? null,
    phase: view?.phase ?? null,
    code: view?.progress?.code ?? null,
  }
}

/** Record the distinct triples of one host for the duration of a test. */
function frameRecorder(service, hostId) {
  const frames = []
  service.on('state', (state) => {
    const view = state.hosts.find((host) => host.id === hostId)
    // The host list can be empty after a removal; the removal paths assert on that separately.
    const next = triple(view)
    const last = frames[frames.length - 1]
    if (!last || JSON.stringify(last) !== JSON.stringify(next)) frames.push(next)
  })
  return frames
}

/** `status/phase/code` strings, readable in an assertion diff. */
const strings = (frames) => frames.map((frame) => `${frame.status}/${frame.phase}/${frame.code}`)

test('golden frames: a successful connect walks connecting → ready and never regresses', async () => {
  const { service } = await makeTestService()
  const host = await createHost(service)
  const frames = frameRecorder(service, host.id)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const sequence = strings(frames)
  assert.deepEqual(sequence, [
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
  // The last frame is the published connect state; nothing may follow it while the link is idle.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(service.snapshot().hosts[0].status, 'connected')
  assert.equal(strings(frames).at(-1), 'connected/ready/ready')
  await service.shutdown()
})

test('golden frames: a host-key timeout ends in error and disarms the prompt', async () => {
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
  const frames = frameRecorder(service, host.id)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { timeoutMs: 5_000, label: 'timeout' })
  const sequence = strings(frames)
  assert.deepEqual(sequence, [
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
  const { service } = await makeTestService()
  await service.saveSettings({ autoReconnect: { enabled: false, maxAttempts: 3, baseDelayMs: 10 } })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  const frames = frameRecorder(service, host.id)
  // Auto-reconnect is off for this case: the drop is reported, not retried.
  runtime.ssh.simulateClose()
  await waitFor(() => runtime.status === 'disconnected', { label: 'dropped' })
  const sequence = strings(frames)
  // The `reconnecting` line is the one the drop published; today's policy-off path keeps it
  // (it patched only the status), and `reconnect.skipped` reproduces that exactly.
  assert.deepEqual(sequence, ['disconnected/null/reconnecting'])
  assert.equal(runtime.transportLost, true)
  await service.shutdown()
})

test('golden frames: a local restart re-publishes connecting → ready on a new listener', async () => {
  const tunnels = []
  const { service } = await makeTestService({
    tunnelFactory: async () => {
      const tunnel = new FakeTunnel(45123 + tunnels.length)
      tunnels.push(tunnel)
      return tunnel
    },
  })
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  const frames = frameRecorder(service, host.id)
  const accepted = await service.restart(host.id)
  assert.equal(accepted.accepted, true)
  await waitFor(
    () => runtime.restartPromise === null && runtime.status === 'connected' && runtime.progress?.code === 'ready',
    { label: 'restarted' },
  )
  const sequence = strings(frames)
  assert.deepEqual(sequence, [
    'connecting/start/restarting-remote',
    'connecting/tunnel/tunneling',
    'connecting/verifying/verifying',
    'connected/ready/ready',
  ])
  await service.shutdown()
})

test('golden frames: stopping the remote ends disconnected and never publishes connected again', async () => {
  // The explicit stop needs the run registry to name the bound pid (its ownership proof).
  const { service } = await makeTestService({
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
  const host = await createHost(service)
  await service.connect(host.id)
  await waitFor(() => service.snapshot().hosts[0].status === 'connected', { label: 'connected' })
  const frames = frameRecorder(service, host.id)
  const stopped = await service.stopRemote(host.id)
  assert.equal(stopped.ok, true)
  const sequence = strings(frames)
  assert.deepEqual(sequence, ['connecting/start/stopping-remote', 'disconnected/null/null'])
  // §6.2 risk 3's explicit assertion: after the user closed the link no frame may say `connected`.
  const connectedAt = sequence.findIndex((frame) => frame.startsWith('disconnected/'))
  assert.ok(connectedAt >= 0)
  assert.equal(
    sequence.slice(connectedAt).some((frame) => frame.startsWith('connected/')),
    false,
    'a frame after the disconnect still reports a connected host',
  )
  await service.shutdown()
})

test('golden frames: disconnecting during a connect never publishes connected', async () => {
  const { service } = await makeTestService({
    probe: async () => {
      // The user disconnects while the probe step is in flight.
      await service.disconnect(host.id)
      return facts
    },
  })
  const facts = (await import('../helpers/fake-remote.ts')).makeFacts()
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
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

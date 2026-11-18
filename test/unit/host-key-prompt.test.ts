import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSsh, createHost, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { errors } from '../../dist/src/errors.js'

/**
 * M1: a host-key prompt settles exactly once.
 *
 * `confirmHostKey` refuses an answer unless the prompt it names is still the live one (the slot is
 * installed and `status === 'fingerprint-pending'`), so a second answer and an answer that arrives
 * after the timeout must both be no-ops: no second pin, no revived attempt, no budget reset.
 * The service-level path is used on purpose — the guard lives in `prompts.ts`, but what a late
 * answer must not do (write the store, move the runtime) only a full connect can prove.
 */
function promptSsh(answered) {
  return (options) => {
    const ssh = new FakeSsh({
      options,
      connect: async () => {
        const accepted = await options.onHostKey({ sha256: 'SHA256:pending', keyType: 'ssh-ed25519' })
        answered.push(accepted)
        if (accepted !== true) throw errors.hostKeyUnknown('SHA256:pending')
        ssh.connected = true
        return { fingerprint: 'SHA256:pending', keyType: 'ssh-ed25519', serverBanner: null }
      },
    })
    return ssh
  }
}

/** Count the pin writes the answer path performs; every other patch is passed through untouched. */
function countPinWrites(store) {
  const writes = { pins: 0, all: [] }
  const original = store.patchHost.bind(store)
  store.patchHost = async (id, patch) => {
    writes.all.push(patch)
    if (patch !== null && typeof patch === 'object' && 'pinnedFingerprint' in patch) writes.pins += 1
    return original(id, patch)
  }
  return writes
}

test('answering a host-key prompt twice is refused: a late answer cannot revive a settled attempt', async () => {
  // Phase 1: a live prompt accepts one answer and refuses the second one in the same tick.
  const answered = []
  const first = await makeTestService({ sshFactory: promptSsh(answered) })
  const writes = countPinWrites(first.store)
  const host = await createHost(first.service)
  const runtime = first.service.runtimes.get(host.id)
  await first.service.connect(host.id)
  await waitFor(() => runtime.status === 'fingerprint-pending', { label: 'host-key prompt' })
  assert.deepEqual(await first.service.confirmFingerprint(host.id, { accept: true, remember: true }), { ok: true })
  const attemptsAfterFirstAnswer = runtime.reconnectAttempts
  await assert.rejects(
    () => first.service.confirmFingerprint(host.id, { accept: true, remember: true }),
    (error) => error.code === 'invalid-input',
    'a second answer to the same prompt must be refused',
  )
  await waitFor(() => runtime.status === 'connected', { label: 'connected after the accepted key' })
  assert.equal(writes.pins, 1, 'the second answer must not write a second pin')
  assert.equal(runtime.entry.pinnedFingerprint, 'SHA256:pending')
  assert.equal(first.service.snapshot().hosts[0].fingerprint.pinned, 'SHA256:pending')
  assert.equal(runtime.reconnectAttempts, attemptsAfterFirstAnswer, 'a refused answer must not reset the budget')
  await first.service.shutdown()

  // Phase 2: the prompt timed out; the Client's late answer must leave every field as it was.
  const lateAnswered = []
  const second = await makeTestService({
    hostKeyConfirmTimeoutMs: 50,
    sshFactory: promptSsh(lateAnswered),
  })
  const lateWrites = countPinWrites(second.store)
  const lateHost = await createHost(second.service)
  const lateRuntime = second.service.runtimes.get(lateHost.id)
  await second.service.connect(lateHost.id)
  await waitFor(() => lateRuntime.status === 'error' && lateRuntime.pendingHostKey === null, {
    timeoutMs: 5_000,
    label: 'prompt timeout',
  })
  const before = {
    status: lateRuntime.status,
    error: lateRuntime.error?.code,
    attempts: lateRuntime.reconnectAttempts,
    pin: lateRuntime.entry.pinnedFingerprint ?? null,
  }
  await assert.rejects(
    () => second.service.confirmFingerprint(lateHost.id, { accept: true, remember: true }),
    (error) => error.code === 'invalid-input',
    'a settled prompt must refuse a late answer',
  )
  await waitFor(() => lateRuntime.connectPromise === null, { label: 'pipeline settled' })
  assert.equal(lateRuntime.status, before.status, 'a late answer must not revive the attempt')
  assert.equal(lateRuntime.error?.code, before.error)
  assert.equal(lateRuntime.reconnectAttempts, before.attempts, 'a late answer must not reset the retry budget')
  assert.equal(lateWrites.pins, 0, 'a late answer must not pin the key')
  assert.equal(lateRuntime.entry.pinnedFingerprint ?? null, before.pin)
  assert.equal(second.store.getHost(lateHost.id).pinnedFingerprint ?? null, null)
  assert.equal(lateAnswered[0], false, 'the parked handshake is still settled exactly once, by the timeout')
  await second.service.shutdown()
})

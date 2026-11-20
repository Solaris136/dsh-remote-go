import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeSsh, createHost, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { errors } from '../../dist/src/errors.js'

/**
 * M1: a host-key prompt settles exactly once. `confirmHostKey` refuses an answer unless the prompt it names is still
 * the live one (the slot is installed and `status === 'fingerprint-pending'`), so a second answer and an answer that
 * arrives after the timeout must both be no-ops: no second pin, no revived attempt, no budget reset. */
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

/** Connect one host against a live prompt; `writes` counts the pin writes the answer path performs. */
async function startPrompt(serviceOptions = {}) {
  const answered = []
  const result = await makeTestService({ ...serviceOptions, sshFactory: promptSsh(answered) })
  const writes = { pins: 0, all: [] }
  const patchHost = result.store.patchHost.bind(result.store)
  result.store.patchHost = async (id, patch) => {
    writes.all.push(patch)
    if (patch !== null && typeof patch === 'object' && 'pinnedFingerprint' in patch) writes.pins += 1
    return patchHost(id, patch)
  }
  const host = await createHost(result.service)
  const runtime = result.service.runtimes.get(host.id)
  await result.service.connect(host.id)
  return { answered, writes, host, runtime, service: result.service, store: result.store }
}

test('answering a host-key prompt twice is refused: a late answer cannot revive a settled attempt', async () => {
  // Phase 1: a live prompt accepts one answer and refuses the second one in the same tick.
  const first = await startPrompt()
  await waitFor(() => first.runtime.status === 'fingerprint-pending', { label: 'host-key prompt' })
  const confirm = () => first.service.confirmFingerprint(first.host.id, { accept: true, remember: true })
  assert.deepEqual(await confirm(), { ok: true })
  const attemptsAfterFirstAnswer = first.runtime.reconnectAttempts
  await assert.rejects(confirm, (error) => error.code === 'invalid-input', 'a second answer must be refused')
  await waitFor(() => first.runtime.status === 'connected', { label: 'connected after the accepted key' })
  assert.equal(first.writes.pins, 1, 'the second answer must not write a second pin')
  assert.equal(first.runtime.entry.pinnedFingerprint, 'SHA256:pending')
  assert.equal(first.service.snapshot().hosts[0].fingerprint.pinned, 'SHA256:pending')
  assert.equal(first.runtime.reconnectAttempts, attemptsAfterFirstAnswer, 'a refused answer must not reset the budget')
  await first.service.shutdown()

  // Phase 2: the prompt timed out; the Client's late answer must leave every field as it was.
  const second = await startPrompt({ hostKeyConfirmTimeoutMs: 50 })
  const settled = async () =>
    waitFor(() => second.runtime.status === 'error' && second.runtime.pendingHostKey === null, {
      timeoutMs: 5_000,
      label: 'prompt timeout',
    })
  await settled()
  const before = {
    status: second.runtime.status,
    error: second.runtime.error?.code,
    attempts: second.runtime.reconnectAttempts,
    pin: second.runtime.entry.pinnedFingerprint ?? null,
  }
  const lateConfirm = () => second.service.confirmFingerprint(second.host.id, { accept: true, remember: true })
  await assert.rejects(lateConfirm, (error) => error.code === 'invalid-input', 'a settled prompt refuses a late answer')
  await waitFor(() => second.runtime.connectPromise === null, { label: 'pipeline settled' })
  assert.equal(second.runtime.status, before.status, 'a late answer must not revive the attempt')
  assert.equal(second.runtime.error?.code, before.error)
  assert.equal(second.runtime.reconnectAttempts, before.attempts, 'a late answer must not reset the retry budget')
  assert.equal(second.writes.pins, 0, 'a late answer must not pin the key')
  assert.equal(second.runtime.entry.pinnedFingerprint ?? null, before.pin)
  assert.equal(second.store.getHost(second.host.id).pinnedFingerprint ?? null, null)
  assert.equal(second.answered[0], false, 'the parked handshake is still settled exactly once, by the timeout')
  await second.service.shutdown()
})

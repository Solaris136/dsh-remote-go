import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, FakeSsh, makeTestService, waitFor } from '../helpers/fake-remote.ts'
import { errors } from '../../dist/src/errors.js'

const viewOf = (service) => service.snapshot().hosts[0]
/** Wait for a host-key prompt; `sha256` narrows it to the prompt for one key. */
const promptFor = (service, sha256) =>
  waitFor(
    () =>
      viewOf(service).status === 'fingerprint-pending' &&
      (sha256 === undefined || viewOf(service).fingerprint?.sha256 === sha256),
    { label: 'prompt' },
  )
const settled = (service) =>
  waitFor(() => ['connected', 'error'].includes(viewOf(service).status), { label: 'settled' })
const pinsOf = (calls) => calls.map((call) => [call.role, call.pin])
// A factory that behaves like the SSH layer's host-key verification for the two roles a jump connection dials. Every
// call records the options that decided the verification, so a test can prove the jump host and the target were checked
// against different pins.
function jumpFactory({
  jumpSha = 'SHA256:jump-key',
  jumpShaFor = null,
  targetSha = 'SHA256:target-key',
  calls,
  autoAccept = false,
  isJumpHost = (host) => host === 'jump-host',
}) {
  return (options) => {
    const role = isJumpHost(options.host) ? 'jump' : 'target'
    const actual = role === 'jump' ? (jumpShaFor ? jumpShaFor(options.host) : jumpSha) : targetSha
    calls.push({
      role,
      host: options.host,
      pin: options.pinnedFingerprint ?? null,
      policy: options.hostKeyPolicy,
      known: options.knownHostFingerprints ?? [],
    })
    const ssh = new FakeSsh({
      options,
      connect: async () => {
        const pinned = options.pinnedFingerprint ?? null
        const known = options.knownHostFingerprints ?? []
        // The same precedence SshConnection.verifyHostKey uses.
        if (pinned) {
          if (pinned !== actual) throw errors.hostKeyChanged(pinned, actual)
        } else if (known.length > 0) {
          if (!known.includes(actual)) throw errors.hostKeyChanged(known[0], actual)
        } else if (options.hostKeyPolicy === 'strict') {
          throw errors.hostKeyUnknown(actual)
        } else if (autoAccept) {
          // The caller pre-answered this prompt (a scenario that does not inspect it).
        } else if (typeof options.onHostKey === 'function') {
          const accepted = await options.onHostKey({ sha256: actual, keyType: 'ssh-ed25519', pinned: false })
          if (accepted !== true) throw errors.hostKeyUnknown(actual)
        } else {
          throw errors.hostKeyUnknown(actual)
        }
        ssh.connected = true
        return { fingerprint: actual, keyType: 'ssh-ed25519' }
      },
    })
    return ssh
  }
}

test('a jump host and the target keep separate host-key contexts', async () => {
  const calls = []
  const { service, store } = await makeTestService({
    sshFactory: jumpFactory({ jumpSha: 'SHA256:jump-key', targetSha: 'SHA256:target-key', calls }),
  })
  const host = await createHost(service, { jumpHost: 'jump-host' })
  await service.connect(host.id)

  // 1. The jump host's key is asked for first, and it is not the target's fingerprint.
  await promptFor(service)
  let view = viewOf(service)
  assert.equal(view.progress.params.role, 'jump')
  assert.equal(view.progress.params.host, 'jump-host')
  // The dialog renders HostView.fingerprint: it must show the key being confirmed (the jump host's), not the target's.
  assert.equal(view.fingerprint.sha256, 'SHA256:jump-key')
  assert.equal(view.fingerprint.status, 'pending')
  const runtime = service.runtimes.get(host.id)
  assert.equal(runtime.jumpFingerprint.sha256, 'SHA256:jump-key')

  // Answering "accept and remember" for the jump host must not pin the target.
  await service.confirmFingerprint(host.id, { accept: true, remember: true, sha256: 'SHA256:jump-key' })
  assert.equal(store.getHost(host.id).pinnedFingerprint, null, 'a jump-host remember must not write the target pin')
  assert.equal(runtime.jumpFingerprint.pinned, 'SHA256:jump-key', 'the jump pin is remembered for this session')

  // 2. Then the target's own key is asked for, under the target's context.
  await promptFor(service, 'SHA256:target-key')
  view = viewOf(service)
  assert.equal(view.progress.params.role, undefined, 'the target prompt keeps its original shape')
  await service.confirmFingerprint(host.id, { accept: true, remember: true, sha256: 'SHA256:target-key' })
  await waitFor(() => viewOf(service).status === 'connected', { label: 'connected' })
  assert.equal(store.getHost(host.id).pinnedFingerprint, 'SHA256:target-key')
  assert.equal(
    viewOf(service).fingerprint.sha256,
    'SHA256:target-key',
    'the connected host card must describe the target key, not the jump key',
  )
  assert.equal(viewOf(service).fingerprint.status, 'pinned')

  // The two factory calls carried independent pins: the jump host and the target were both checked with no pin.
  assert.deepEqual(pinsOf(calls), [
    ['jump', null],
    ['target', null],
  ])

  // 3. A second connection reuses each pin in its own context.
  await service.disconnect(host.id)
  await service.connect(host.id)
  await settled(service)
  assert.equal(
    viewOf(service).status,
    'connected',
    `the jump reconnect must not fail on the target pin: ${JSON.stringify(calls.slice(2))}`,
  )
  assert.deepEqual(
    pinsOf(calls.slice(2)),
    [
      ['jump', 'SHA256:jump-key'],
      ['target', 'SHA256:target-key'],
    ],
    'the jump reconnect must use the remembered jump pin, not the target pin',
  )
  await service.shutdown()
})

test('an existing target pin never reaches the jump host connection', async () => {
  const calls = []
  const { service } = await makeTestService({
    sshFactory: jumpFactory({
      jumpSha: 'SHA256:jump-key',
      targetSha: 'SHA256:target-key',
      calls,
      autoAccept: true,
    }),
  })
  const host = await createHost(service, { jumpHost: 'jump-host', pinnedFingerprint: 'SHA256:target-key' })
  await service.connect(host.id)
  // With the shared-context bug the jump factory got the target pin and the fake rejected it before the target dialled.
  await settled(service)
  assert.equal(
    viewOf(service).status,
    'connected',
    `the first jump connection must not be checked against the target pin: ${JSON.stringify(calls)}`,
  )
  assert.equal(viewOf(service).error, null)
  assert.deepEqual(pinsOf(calls), [
    ['jump', null],
    ['target', 'SHA256:target-key'],
  ])
  assert.equal(viewOf(service).fingerprint.status, 'pinned')
  await service.shutdown()
})

test('the target host-key policy does not apply to the jump host', async () => {
  const calls = []
  const { service } = await makeTestService({
    sshFactory: jumpFactory({ jumpSha: 'SHA256:jump-key', targetSha: 'SHA256:target-key', calls }),
  })
  // A strict policy describes the saved target only; the jump host keeps the global policy.
  const host = await createHost(service, { jumpHost: 'jump-host', hostKeyPolicy: 'strict' })
  await service.connect(host.id)
  await promptFor(service)
  assert.equal(viewOf(service).progress.params.role, 'jump')
  await service.confirmFingerprint(host.id, { accept: true, remember: true })
  await waitFor(() => viewOf(service).status === 'error', { label: 'target refused' })
  assert.equal(viewOf(service).error.code, 'host-key-unknown')
  assert.deepEqual(
    calls.map((call) => [call.role, call.policy]),
    [
      ['jump', 'first-use'],
      ['target', 'strict'],
    ],
  )
  await service.shutdown()
})

test('editing the jump host re-asks for its key instead of reporting host-key-changed', async () => {
  const calls = []
  const { service, store } = await makeTestService({
    sshFactory: jumpFactory({
      isJumpHost: (host) => String(host).startsWith('jump-host'),
      jumpShaFor: (host) => (host === 'jump-host' ? 'SHA256:key-jump-old' : 'SHA256:key-jump-new'),
      targetSha: 'SHA256:target-key',
      calls,
    }),
  })
  const host = await createHost(service, { jumpHost: 'jump-host' })
  await service.connect(host.id)
  await promptFor(service)
  await service.confirmFingerprint(host.id, { accept: true, remember: true, sha256: 'SHA256:key-jump-old' })
  await promptFor(service, 'SHA256:target-key')
  await service.confirmFingerprint(host.id, { accept: true, remember: true, sha256: 'SHA256:target-key' })
  await waitFor(() => viewOf(service).status === 'connected', { label: 'connected' })
  const runtime = service.runtimes.get(host.id)
  assert.equal(runtime.jumpFingerprint.host, 'jump-host')
  assert.equal(runtime.jumpFingerprint.pinned, 'SHA256:key-jump-old')

  // Editing the host keeps the runtime object: only the jump host changed, not the target.
  await service.saveHost({ ...store.getHost(host.id), jumpHost: 'jump-host-new' })
  assert.equal(service.runtimes.get(host.id), runtime, 'the runtime is preserved by an edit')
  await service.disconnect(host.id)
  await service.connect(host.id)
  // The new jump host must be askable again: its key is not the old machine's pin.
  await waitFor(() => ['fingerprint-pending', 'connected', 'error'].includes(viewOf(service).status), {
    timeoutMs: 5_000,
    label: 'new jump host settled',
  })
  assert.equal(
    viewOf(service).status,
    'fingerprint-pending',
    `the edited jump host must ask again, not fail: ${JSON.stringify(viewOf(service).error)}`,
  )
  assert.equal(viewOf(service).progress?.params?.role, 'jump')
  const prompt = viewOf(service)
  assert.equal(prompt.progress.params.host, 'jump-host-new')
  assert.equal(prompt.fingerprint.sha256, 'SHA256:key-jump-new')
  await service.confirmFingerprint(host.id, { accept: true, remember: true, sha256: 'SHA256:key-jump-new' })
  await settled(service)
  assert.equal(
    viewOf(service).status,
    'connected',
    `the edited jump host must not be checked against the old pin: ${JSON.stringify(calls.slice(2))}`,
  )
  assert.deepEqual(
    calls.slice(2).map((call) => [call.role, call.host, call.pin]),
    [
      ['jump', 'jump-host-new', null],
      ['target', '2001:db8::1', 'SHA256:target-key'],
    ],
    'the old jump pin may not travel to the new jump host (the target pin still applies)',
  )
  assert.equal(runtime.jumpFingerprint.host, 'jump-host-new')
  assert.equal(runtime.jumpFingerprint.pinned, 'SHA256:key-jump-new')
  await service.shutdown()
})

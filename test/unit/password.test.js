import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, fakeSecretStore, makeTestService, waitFor } from '../helpers/fake-remote.js'
import { createSecretStore } from '../../src/secrets.js'

const connected = (service) =>
  waitFor(() => service.snapshot().hosts[0]?.status === 'connected', { label: 'connected' })

/** The raw DSH credential service (the seam `src/secrets.js` adapts), backed by a map. */
function fakeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

const secretStoreOver = (credentials) =>
  createSecretStore({
    ctx: { get: (name) => (name === 'credentials' ? credentials : undefined) },
    logger: { warn() {} },
  })

test('the production store writes a DSH-addressable record and restores it after a restart', async () => {
  const credentials = fakeCredentials()
  const first = await makeTestService({ secrets: secretStoreOver(credentials) })
  const host = await createHost(first.service, { auth: { type: 'password' } })
  await first.service.connect(host.id, { password: 's3cret' })
  await connected(first.service)
  const keys = [...credentials.records.keys()]
  assert.deepEqual(keys, [`dsh-remote-go/ssh-password-${host.id.replace(/_/g, '-')}`])
  // The exact shape DSH's credential document accepts; a colon key used to poison the file.
  assert.match(keys[0], /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  assert.deepEqual(credentials.records.get(keys[0]), {
    kind: 'grant',
    payload: { version: 1, password: 's3cret' },
  })
  await first.service.shutdown()

  const second = await makeTestService({ dir: first.dir, secrets: secretStoreOver(credentials) })
  assert.equal(second.service.snapshot().hosts[0].passwordSaved, true)
  await second.service.shutdown()
})

test('a typed password is saved by default and recognized by the next Host process', async () => {
  const secrets = fakeSecretStore()
  const first = await makeTestService({ secrets })
  const host = await createHost(first.service, { auth: { type: 'password' } })
  await first.service.connect(host.id, { password: 's3cret' })
  await connected(first.service)
  assert.equal(secrets.store.get(host.id), 's3cret', 'remembering is the default')
  assert.equal(first.service.snapshot().hosts[0].passwordSaved, true)
  await first.service.shutdown()

  // A restarted Host loads hosts.json again. Without the rehydration read the Client would
  // prompt for a password the store already holds, which is the reported "only once" behavior.
  const second = await makeTestService({ dir: first.dir, secrets })
  assert.equal(second.service.snapshot().hosts[0].passwordSaved, true)
  await second.service.shutdown()
})

test('rememberPassword:false uses the password once and forgets an older record', async () => {
  const secrets = fakeSecretStore()
  const { service } = await makeTestService({ secrets })
  const host = await createHost(service, { auth: { type: 'password' } })
  await service.connect(host.id, { password: 's3cret' })
  await connected(service)
  assert.equal(secrets.store.get(host.id), 's3cret')

  await service.disconnect(host.id)
  assert.equal(service.snapshot().hosts[0].passwordSaved, true, 'disconnect keeps the record')
  await service.connect(host.id, { password: 'other', rememberPassword: false })
  await connected(service)
  assert.equal(secrets.store.has(host.id), false, 'an explicit no must not leave a stale secret')
  assert.equal(service.snapshot().hosts[0].passwordSaved, false)
  await service.shutdown()
})

test('a failed authentication never stores the password', async () => {
  const secrets = fakeSecretStore()
  const { service } = await makeTestService({
    secrets,
    sshFactory: () => {
      throw new Error('authentication failed')
    },
  })
  const host = await createHost(service, { auth: { type: 'password' } })
  await service.connect(host.id, { password: 'wrong' }).catch(() => {})
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'error' })
  assert.equal(secrets.store.has(host.id), false)
  await service.shutdown()
})

test('a password accepted by SSH stays saved even when a later step fails', async () => {
  const secrets = fakeSecretStore()
  const { service } = await makeTestService({
    secrets,
    probe: async () => {
      throw new Error('probe exploded')
    },
  })
  const host = await createHost(service, { auth: { type: 'password' } })
  await service.connect(host.id, { password: 's3cret' })
  await waitFor(() => service.snapshot().hosts[0].status === 'error', { label: 'error' })
  // The credential was proven by the handshake: a failed bootstrap must not make the user
  // type it again on the retry.
  assert.equal(secrets.store.get(host.id), 's3cret')
  assert.equal(service.snapshot().hosts[0].passwordSaved, true)
  await service.shutdown()
})

test('the wizard can remember or forget a password without connecting', async () => {
  const secrets = fakeSecretStore()
  const { service } = await makeTestService({ secrets })
  const host = await createHost(service, { auth: { type: 'password' } })

  assert.deepEqual(await service.saveHostPassword(host.id, { password: 's3cret' }), {
    available: true,
    saved: true,
  })
  assert.equal(secrets.store.get(host.id), 's3cret')
  assert.equal(service.snapshot().hosts[0].passwordSaved, true)

  assert.deepEqual(await service.saveHostPassword(host.id, { clear: true }), {
    available: true,
    saved: false,
  })
  assert.equal(secrets.store.has(host.id), false)
  assert.equal(service.snapshot().hosts[0].passwordSaved, false)

  await assert.rejects(service.saveHostPassword(host.id, { password: '' }), (error) => error.code === 'invalid-input')
  await service.shutdown()
})

test('switching auth away from password and removing the host both forget the secret', async () => {
  const secrets = fakeSecretStore()
  const { service } = await makeTestService({ secrets })
  const host = await createHost(service, { auth: { type: 'password' } })
  await service.saveHostPassword(host.id, { password: 's3cret' })

  const saved = service.snapshot().hosts[0]
  await service.saveHost({
    id: saved.id,
    name: saved.name,
    address: saved.address,
    port: saved.port,
    username: saved.username,
    auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
  })
  assert.equal(secrets.store.has(host.id), false, 'key auth must not leave an orphaned password')

  await service.saveHost({
    id: saved.id,
    name: saved.name,
    address: saved.address,
    port: saved.port,
    username: saved.username,
    auth: { type: 'password' },
  })
  await service.saveHostPassword(host.id, { password: 's3cret' })
  await service.removeHost(host.id)
  assert.equal(secrets.store.has(host.id), false, 'a removed host must not leave its password behind')
  await service.shutdown()
})

test('the state view tells the Client whether a password can be stored at all', async () => {
  const withStore = await makeTestService({ secrets: fakeSecretStore() })
  assert.equal(withStore.service.snapshot().passwordStorageAvailable, true)
  await withStore.service.shutdown()

  const withoutStore = await makeTestService()
  assert.equal(withoutStore.service.snapshot().passwordStorageAvailable, false)
  const host = await createHost(withoutStore.service, { auth: { type: 'password' } })
  assert.deepEqual(await withoutStore.service.saveHostPassword(host.id, { password: 'x' }), {
    available: false,
    saved: false,
  })
  await withoutStore.service.shutdown()
})

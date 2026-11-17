import test from 'node:test'
import assert from 'node:assert/strict'
import { createSecretStore, passwordRecordKey } from '../../src/secrets.js'

function fakeCredentials() {
  const records = new Map()
  return {
    records,
    calls: [],
    async readRecord(key) {
      this.calls.push(['readRecord', key])
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      this.calls.push(['modifyRecord', key])
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      this.calls.push(['deleteRecord', key])
      records.delete(key)
    },
  }
}

function ctxWith(service) {
  return { get: (name) => (name === 'credentials' ? service : undefined) }
}

test('the secret store round-trips one password per host', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  assert.equal(secrets.available(), true)
  assert.equal(await secrets.get('h_1'), null)
  assert.equal(await secrets.set('h_1', 's3cret'), true)
  assert.equal(await secrets.get('h_1'), 's3cret')
  assert.equal(await secrets.get('h_2'), null, 'hosts must not share a record')
  assert.equal(await secrets.remove('h_1'), true)
  assert.equal(await secrets.get('h_1'), null)
})

test('records are tagged as grants with a versioned payload, never a plain string', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  await secrets.set('h_1', 's3cret')
  const [key, record] = [...credentials.records.entries()][0]
  // DSH admits a record only at `<scope>/<id>` (both lowercase identifiers). The old
  // colon-separated key was accepted on write and then made the whole credential document
  // unreadable at the next boot, so the save silently stopped working across restarts.
  assert.equal(key, 'dsh-remote-go/ssh-password-h-1')
  assert.match(key, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  assert.equal(record.kind, 'grant')
  assert.deepEqual(record.payload, { version: 1, password: 's3cret' })
})

test('the record key is the only DSH-addressable form and never collides across hosts', () => {
  assert.equal(passwordRecordKey('h_1'), 'dsh-remote-go/ssh-password-h-1')
  assert.equal(passwordRecordKey('h_abc123'), 'dsh-remote-go/ssh-password-h-abc123')
  assert.notEqual(passwordRecordKey('h_1'), passwordRecordKey('h_2'))
  assert.match(passwordRecordKey('h_1'), /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  // An id this plugin never issued is not addressable: writing it would poison the document.
  for (const bad of ['', 'h_', 'H_1', 'x_1', 'h_1/2', 'h_1 ', null, undefined, 42]) {
    assert.equal(passwordRecordKey(bad), null, `unexpected key for ${JSON.stringify(bad)}`)
  }
})

test('a payload of the wrong shape is ignored instead of returned', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  for (const payload of [undefined, null, 'plain', { version: 99, password: 'x' }, { version: 1, password: '' }]) {
    credentials.records.set('dsh-remote-go/ssh-password-h-1', { kind: 'grant', payload })
    assert.equal(await secrets.get('h_1'), null, 'unexpected value for payload ' + JSON.stringify(payload))
  }
})

test('without a credential service nothing is persisted and available() says so', async () => {
  const secrets = createSecretStore({ ctx: { get: () => undefined }, logger: { warn() {} } })
  assert.equal(secrets.available(), false)
  assert.equal(await secrets.set('h_1', 's3cret'), false, 'a save must report failure, not silently drop it')
  assert.equal(await secrets.get('h_1'), null)
  assert.equal(await secrets.remove('h_1'), false)
})

test('a throwing credential service never breaks the caller', async () => {
  const secrets = createSecretStore({
    ctx: ctxWith({
      async readRecord() {
        throw new Error('boom')
      },
      async modifyRecord() {
        throw new Error('boom')
      },
      async deleteRecord() {
        throw new Error('boom')
      },
    }),
    logger: { warn() {} },
  })
  assert.equal(await secrets.get('h_1'), null)
  assert.equal(await secrets.set('h_1', 's3cret'), false)
  assert.equal(await secrets.remove('h_1'), false)
})

test('an empty password is never stored', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  assert.equal(await secrets.set('h_1', ''), false)
  assert.equal(credentials.records.size, 0)
})

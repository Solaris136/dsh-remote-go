import test from 'node:test'
import assert from 'node:assert/strict'
import { createSecretStore } from '../../src/secrets.js'

/** A minimal in-memory stand-in for DSH's credential record space. */
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

  await secrets.remove('h_1')
  assert.equal(await secrets.get('h_1'), null)
})

test('records are tagged as grants with a versioned payload, never a plain string', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  await secrets.set('h_1', 's3cret')

  const [key, record] = [...credentials.records.entries()][0]
  assert.match(key, /dsh-remote-go:ssh-password:h_1/)
  assert.equal(record.kind, 'grant')
  assert.deepEqual(record.payload, { version: 1, password: 's3cret' })
})

test('a payload of the wrong shape is ignored instead of returned', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  for (const payload of [undefined, null, 'plain', { version: 99, password: 'x' }, { version: 1, password: '' }]) {
    credentials.records.set('dsh-remote-go:ssh-password:h_1', { kind: 'grant', payload })
    assert.equal(await secrets.get('h_1'), null, 'unexpected value for payload ' + JSON.stringify(payload))
  }
})

test('without a credential service nothing is persisted and available() says so', async () => {
  const secrets = createSecretStore({ ctx: { get: () => undefined }, logger: { warn() {} } })
  assert.equal(secrets.available(), false)
  assert.equal(await secrets.set('h_1', 's3cret'), false, 'a save must report failure, not silently drop it')
  assert.equal(await secrets.get('h_1'), null)
  await secrets.remove('h_1')
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
  await secrets.remove('h_1')
})

test('an empty password is never stored', async () => {
  const credentials = fakeCredentials()
  const secrets = createSecretStore({ ctx: ctxWith(credentials), logger: { warn() {} } })
  assert.equal(await secrets.set('h_1', ''), false)
  assert.equal(credentials.records.size, 0)
})

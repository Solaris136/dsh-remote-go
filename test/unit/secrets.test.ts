import test from 'node:test'
import assert from 'node:assert/strict'
import { createSecretStore, passwordRecordKey } from '../../dist/src/secrets.js'

const silentLogger = { warn() {} }
function fakeCredentials() {
  const records = new Map()
  return {
    records,
    readRecord: async (key) => records.get(key),
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    deleteRecord: async (key) => records.delete(key),
  }
}
const ctxWith = (service) => ({ get: (name) => (name === 'credentials' ? service : undefined) })
const storeOn = (credentials) => createSecretStore({ ctx: ctxWith(credentials), logger: silentLogger })

test('the secret store round-trips one password per host as a versioned grant record', async () => {
  const credentials = fakeCredentials()
  const secrets = storeOn(credentials)
  assert.equal(secrets.available(), true)
  assert.equal(await secrets.get('h_1'), null)
  assert.equal(await secrets.set('h_1', 's3cret'), true)
  assert.equal(await secrets.get('h_1'), 's3cret')
  assert.equal(await secrets.get('h_2'), null, 'hosts must not share a record')
  const [key, record] = [...credentials.records.entries()][0]
  // DSH admits a record only at `<scope>/<id>` (both lowercase identifiers); the old colon-separated key was accepted
  // on write and then made the whole credential document unreadable at the next boot.
  assert.equal(key, 'dsh-remote-go/ssh-password-h-1')
  assert.match(key, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  assert.equal(record.kind, 'grant', 'a record is a grant, never a plain string')
  assert.deepEqual(record.payload, { version: 1, password: 's3cret' })
  assert.equal(await secrets.remove('h_1'), true)
  assert.equal(await secrets.get('h_1'), null)
  const empty = fakeCredentials()
  assert.equal(await storeOn(empty).set('h_1', ''), false, 'an empty password is never stored')
  assert.equal(empty.records.size, 0)
})

test('the record key is the only DSH-addressable form and only a well-formed payload reads back', async () => {
  assert.equal(passwordRecordKey('h_1'), 'dsh-remote-go/ssh-password-h-1')
  assert.equal(passwordRecordKey('h_abc123'), 'dsh-remote-go/ssh-password-h-abc123')
  assert.notEqual(passwordRecordKey('h_1'), passwordRecordKey('h_2'))
  assert.match(passwordRecordKey('h_1'), /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  // An id this plugin never issued is not addressable: writing it would poison the document.
  for (const bad of ['', 'h_', 'H_1', 'x_1', 'h_1/2', 'h_1 ', null, undefined, 42]) {
    assert.equal(passwordRecordKey(bad), null, `unexpected key for ${JSON.stringify(bad)}`)
  }
  const credentials = fakeCredentials()
  const secrets = storeOn(credentials)
  for (const payload of [undefined, null, 'plain', { version: 99, password: 'x' }, { version: 1, password: '' }]) {
    credentials.records.set('dsh-remote-go/ssh-password-h-1', { kind: 'grant', payload })
    assert.equal(await secrets.get('h_1'), null, 'unexpected value for payload ' + JSON.stringify(payload))
  }
})

test('an absent or reshaped credential service persists nothing and says so once', async () => {
  const warnings = []
  // `changed` is not `absent`: the service exists but its record members moved, and answering null silently would
  // present every remembered password as forgotten (security review L-1).
  const moved = { readRecord: 'not-a-function', modifyRecord: 42 }
  for (const [shape, credentials] of [
    ['absent', undefined],
    ['reshaped', moved],
  ]) {
    const logger = { warn: (...args) => warnings.push(args) }
    const secrets = createSecretStore({ ctx: { get: () => credentials }, logger })
    assert.equal(secrets.available(), false, shape)
    assert.equal(await secrets.get('h_1'), null, shape)
    assert.equal(await secrets.set('h_1', 's3cret'), false, `${shape}: a save must report failure`)
    assert.equal(await secrets.remove('h_1'), false, shape)
  }
  assert.equal(warnings.length, 1, 'a changed credential service must warn exactly once per store')
  assert.match(String(warnings[0][0]), /credential service changed shape/)
})

test('a throwing credential service never breaks the caller', async () => {
  const boom = async () => {
    throw new Error('boom')
  }
  const secrets = storeOn({ readRecord: boom, modifyRecord: boom, deleteRecord: boom })
  assert.equal(await secrets.get('h_1'), null)
  assert.equal(await secrets.set('h_1', 's3cret'), false)
  assert.equal(await secrets.remove('h_1'), false)
})

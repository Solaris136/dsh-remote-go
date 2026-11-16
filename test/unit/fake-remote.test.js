import test from 'node:test'
import assert from 'node:assert/strict'
import { SshConnection } from '../../src/ssh.js'
import { FakeSsh } from '../helpers/fake-remote.js'

// Test-only helpers the service never sees; anything else on FakeSsh must exist on the
// real transport, otherwise a test can pass against a method production does not have.
const TEST_ONLY_METHODS = new Set(['simulateClose'])

test('the fake SSH transport only stands in for real SshConnection methods', () => {
  const real = new Set(Object.getOwnPropertyNames(SshConnection.prototype))
  const fake = Object.getOwnPropertyNames(FakeSsh.prototype).filter(
    (name) => name !== 'constructor' && !TEST_ONLY_METHODS.has(name),
  )
  assert.ok(fake.length > 0, 'FakeSsh must expose the transport surface')
  const orphaned = fake.filter((name) => !real.has(name))
  assert.deepEqual(
    orphaned,
    [],
    `FakeSsh declares method(s) the real SshConnection does not have: ${orphaned.join(', ')}`,
  )
})

test('the fake does not keep a transport method that was removed from production', () => {
  // readRemoteFile was dropped from the real transport when downloads moved to SFTP;
  // keeping it here made tests look as if the removed API still existed.
  assert.equal(FakeSsh.prototype.readRemoteFile, undefined)
})

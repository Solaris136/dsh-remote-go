import test from 'node:test'
import assert from 'node:assert/strict'
import { SshConnection } from '../../dist/src/ssh.js'
import { FakeSsh } from '../helpers/fake-remote.ts'
// Test-only helpers the service never sees; every other method must exist on the real transport, otherwise a test can
// pass against a method production does not have.
const TEST_ONLY_METHODS = new Set(['simulateClose'])

test('the fake SSH transport only stands in for real SshConnection methods', () => {
  const real = new Set(Object.getOwnPropertyNames(SshConnection.prototype))
  const fake = Object.getOwnPropertyNames(FakeSsh.prototype)
  const tested = fake.filter((name) => name !== 'constructor' && !TEST_ONLY_METHODS.has(name))
  assert.ok(tested.length > 0, 'FakeSsh must expose the transport surface')
  const orphaned = tested.filter((name) => !real.has(name))
  assert.deepEqual(orphaned, [], `FakeSsh declares methods the real transport lacks: ${orphaned.join(', ')}`)
  // readRemoteFile was dropped from the real transport when downloads moved to SFTP; keeping it here made tests look as
  // if the removed API still existed.
  assert.equal(FakeSsh.prototype.readRemoteFile, undefined)
})

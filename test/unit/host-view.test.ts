import test from 'node:test'
import assert from 'node:assert/strict'
import { hostView, maskAddress } from '../../dist/src/host-view.js'
import { parseSshDestination } from '../../dist/src/util.js'

function entryOf(overrides = {}) {
  return {
    name: 'host-a',
    address: 'host-a',
    port: 22,
    username: null,
    auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
    jumpHost: null,
    keepAlive: 'keep',
    idleMinutes: 15,
    autoReconnect: true,
    hostKeyPolicy: 'first-use',
    lastOpenedAt: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  }
}
function runtimeOf(overrides = {}) {
  return {
    id: 'h_a',
    status: 'disconnected',
    phase: null,
    progress: null,
    error: null,
    warning: null,
    conflict: null,
    fingerprint: null,
    passwordSaved: false,
    remote: { version: null, uiReady: false },
    ...overrides,
    entry: entryOf(overrides.entry),
  }
}
const ctx = { passwordStorageAvailable: false, targetVersion: '0.2.2-rc.3' }

test('HostView exposes the plain port and username instead of only the masked address', () => {
  const view = hostView(runtimeOf({ entry: { port: 2222, username: 'ubuntu' } }), ctx)
  assert.equal(view.port, 2222, 'the editor reads this directly instead of parsing the display string')
  assert.equal(view.username, 'ubuntu')
  assert.equal(view.addressMasked, 'ubuntu@host-a:2222')
  const defaults = hostView(runtimeOf({}), ctx)
  assert.deepEqual([defaults.port, defaults.username, defaults.addressMasked], [22, null, 'host-a'])
  const warned = hostView(
    runtimeOf({
      warning: { zh: '手工实例并存', en: 'A manual instance is running' },
      remote: { version: '0.2.2-rc.1', uiReady: true },
    }),
    ctx,
  )
  assert.deepEqual(warned.warning, { zh: '手工实例并存', en: 'A manual instance is running' })
  assert.deepEqual([warned.versionParity.status, warned.targetVersion], ['different', '0.2.2-rc.3'])
})

test('the masked address is canonical, parses back to the same endpoint and brackets IPv6', () => {
  const cases = [
    [{ username: 'user', address: 'host', port: 22 }, 'user@host', ['user', 'host', null]],
    [{ username: 'user', address: 'host', port: 2222 }, 'user@host:2222', ['user', 'host', 2222]],
    [{ username: 'user', address: 'host', port: 120 }, 'user@host:120', ['user', 'host', 120]],
    [{ username: 'user', address: 'fe80::1', port: 22 }, 'user@[fe80::1]', ['user', 'fe80::1', null]],
    [{ username: 'user', address: 'fe80::1', port: 2222 }, 'user@[fe80::1]:2222', ['user', 'fe80::1', 2222]],
    [{ username: null, address: '::1', port: 22 }, '[::1]', [null, '::1', null]],
  ]
  for (const [entry, display, parsed] of cases) {
    assert.equal(maskAddress(entry), display)
    const destination = parseSshDestination(display)
    // Port 22 is omitted from the display by design; every other port must survive the round trip.
    assert.deepEqual([destination.user, destination.host, destination.port], parsed, display)
  }
  // A bare IPv6 address is one host on either side: the old Client parse read `:1` as a port.
  assert.deepEqual(parseSshDestination('user@fe80::1'), { user: 'user', host: 'fe80::1', port: null })
  assert.equal(maskAddress({ username: 'user', address: 'fe80::1', port: 22 }), 'user@[fe80::1]')
})

test('passwordSaved reflects the credential store, never a one-time password in memory', () => {
  const passwordEntry = { entry: { auth: { type: 'password' } } }
  const oneTime = hostView(runtimeOf({ ...passwordEntry, password: 's3cret', passwordSaved: false }), ctx)
  assert.equal(oneTime.passwordSaved, false, 'a password used for this connection alone is not a saved one')
  const saved = hostView(runtimeOf({ ...passwordEntry, passwordSaved: true }), ctx)
  assert.equal(saved.passwordSaved, true, 'the runtime mirror of the store is what the Client reads')
  assert.equal(hostView(runtimeOf({ passwordSaved: true }), ctx).passwordSaved, false, 'key auth never has one')
})

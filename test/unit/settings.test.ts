import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings, sanitizeHostEntry, sanitizeSettings } from '../../dist/src/settings.js'

test('settings defaults and host-entry sanitization survive malformed input', () => {
  const settings = defaultSettings()
  assert.equal(settings.defaultPort, 22)
  assert.equal(settings.defaultAuth, 'key')
  assert.equal(settings.defaultKeyPath, '~/.ssh/id_rsa')
  assert.equal(settings.hostKeyPolicy, 'first-use')
  assert.equal(settings.saveTokens, false)
  assert.equal(settings.autoReconnect.enabled, true)
  assert.equal(settings.bootstrap.profile, 'web')
  assert.equal('remoteDir' in settings.bootstrap, false)
  // The retired presentation mode is gone from settings entirely.
  assert.equal('windowMode' in settings, false)
  for (const windowMode of ['panel', 'overlay', 'external']) {
    assert.equal('windowMode' in sanitizeSettings({ windowMode }), false, windowMode)
  }
  const recovered = sanitizeSettings({
    defaultPort: 99999,
    defaultAuth: 'bogus',
    autoReconnect: { enabled: 'yes', maxAttempts: -3, baseDelayMs: 1 },
    language: 'fr',
    bootstrap: { mode: 'nope', nodeVersion: 'not-a-version', targetVersion: '', profile: 'desktop' },
  })
  assert.deepEqual([recovered.defaultPort, recovered.defaultAuth], [65535, 'key'])
  assert.equal(recovered.defaultKeyPath, '~/.ssh/id_rsa')
  assert.deepEqual(recovered.autoReconnect, { enabled: true, maxAttempts: 0, baseDelayMs: 100 })
  assert.deepEqual([recovered.language, recovered.bootstrap.profile], ['auto', 'web'])
  assert.equal('remoteDir' in recovered.bootstrap, false)
  assert.deepEqual(sanitizeSettings('garbage'), defaultSettings())
  const heartbeatOf = (value) => sanitizeSettings({ remoteHeartbeat: value }).remoteHeartbeat
  assert.deepEqual(settings.remoteHeartbeat, { enabled: true, intervalSec: 30 })
  assert.deepEqual(sanitizeSettings({}).remoteHeartbeat, { enabled: true, intervalSec: 30 })
  assert.deepEqual(heartbeatOf({ enabled: false }), { enabled: false, intervalSec: 30 })
  assert.equal(heartbeatOf({ intervalSec: 1 }).intervalSec, 5)
  assert.equal(heartbeatOf({ intervalSec: 9999 }).intervalSec, 600)
  assert.equal(heartbeatOf({ intervalSec: 'nope' }).intervalSec, 30)
  assert.equal(heartbeatOf('off').enabled, true)
})

test('sanitizeHostEntry validates a first host, keeps existing values and fills defaults', () => {
  const settings = defaultSettings()
  const first = sanitizeHostEntry(
    {
      name: '  腾讯云  ',
      address: 'ubuntu@192.0.2.10:2222',
      auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
      keepAlive: 'idle',
      idleMinutes: 30,
    },
    { settings },
  )
  assert.equal(first.name, '腾讯云')
  assert.equal(first.address, 'ubuntu@192.0.2.10:2222')
  assert.equal(first.port, 2222, 'the address port wins over the settings default')
  assert.equal(first.username, 'ubuntu')
  assert.deepEqual(first.auth, { type: 'key', keyPath: '~/.ssh/id_rsa' })
  assert.equal(first.keepAlive, 'idle')
  assert.equal(first.idleMinutes, 30)
  assert.ok(first.createdAt)
  assert.ok(first.updatedAt)
  const existing = {
    id: 'h_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    pinnedFingerprint: 'SHA256:abc',
    jumpHost: 'bastion',
  }
  const edit = (raw) => sanitizeHostEntry(raw, { settings, existing })
  const kept = edit({ id: 'h_1', address: 'test-host' })
  assert.deepEqual([kept.id, kept.createdAt], ['h_1', '2026-01-01T00:00:00.000Z'])
  assert.deepEqual([kept.pinnedFingerprint, kept.jumpHost], ['SHA256:abc', 'bastion'])
  assert.equal(edit({ address: 'test-host', jumpHost: '' }).jumpHost, null, 'an empty jump host clears')
  assert.equal(edit({ address: 'test-host', jumpHost: 'other-bastion' }).jumpHost, 'other-bastion')
  assert.throws(() => sanitizeHostEntry({ name: 'x' }, { settings }), /address is required/)
  const strict = { ...defaultSettings(), defaultPort: 2200, hostKeyPolicy: 'strict', defaultAuth: 'password' }
  const filled = sanitizeHostEntry({ address: 'example.com' }, { settings: strict })
  assert.equal(filled.port, 2200)
  assert.equal(filled.hostKeyPolicy, 'strict')
  assert.equal(filled.auth.type, 'password')
  assert.equal(filled.keepAlive, 'keep')
  assert.equal(filled.autoReconnect, true)
  assert.equal('bootstrap' in filled, false)
  assert.equal(sanitizeSettings({ bootstrap: { profile: 'headless' } }).bootstrap.profile, 'headless')
  assert.equal(sanitizeSettings({ bootstrap: { profile: 'team.1' } }).bootstrap.profile, 'team.1')
  assert.equal(sanitizeSettings({ bootstrap: { profile: 'desktop' } }).bootstrap.profile, 'web')
  assert.equal(sanitizeSettings({ bootstrap: { profile: '../escape' } }).bootstrap.profile, 'web')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings, sanitizeHostEntry, sanitizeSettings } from '../../src/settings.js'

test('defaultSettings matches the documented defaults', () => {
  const settings = defaultSettings()
  assert.equal(settings.defaultPort, 22)
  assert.equal(settings.defaultAuth, 'key')
  assert.equal(settings.defaultKeyPath, '~/.ssh/id_rsa')
  assert.equal(settings.hostKeyPolicy, 'first-use')
  assert.equal(settings.saveTokens, false)
  assert.equal(settings.autoReconnect.enabled, true)
  assert.equal(settings.bootstrap.profile, 'web')
  assert.equal('remoteDir' in settings.bootstrap, false)
})

test('the retired presentation mode is gone from settings entirely', () => {
  assert.equal('windowMode' in defaultSettings(), false)
  assert.equal('windowMode' in sanitizeSettings({ windowMode: 'panel' }), false)
  assert.equal('windowMode' in sanitizeSettings({ windowMode: 'overlay' }), false)
  assert.equal('windowMode' in sanitizeSettings({ windowMode: 'external' }), false)
})

test('sanitizeSettings recovers from malformed input', () => {
  const settings = sanitizeSettings({
    defaultPort: 99999,
    defaultAuth: 'bogus',
    autoReconnect: { enabled: 'yes', maxAttempts: -3, baseDelayMs: 1 },
    language: 'fr',
    bootstrap: { mode: 'nope', nodeVersion: 'not-a-version', targetVersion: '', profile: 'desktop' },
  })
  assert.equal(settings.defaultPort, 65535)
  assert.equal(settings.defaultAuth, 'key')
  assert.equal(settings.defaultKeyPath, '~/.ssh/id_rsa')
  assert.equal(settings.autoReconnect.enabled, true)
  assert.equal(settings.autoReconnect.maxAttempts, 0)
  assert.equal(settings.autoReconnect.baseDelayMs, 100)
  assert.equal(settings.language, 'auto')
  assert.equal(settings.bootstrap.profile, 'web')
  assert.equal('remoteDir' in settings.bootstrap, false)
  assert.deepEqual(sanitizeSettings('garbage'), defaultSettings())
})

test('the remote heartbeat defaults to on and is sanitized', () => {
  assert.deepEqual(defaultSettings().remoteHeartbeat, { enabled: true, intervalSec: 30 })
  assert.deepEqual(sanitizeSettings({}).remoteHeartbeat, { enabled: true, intervalSec: 30 })
  assert.deepEqual(sanitizeSettings({ remoteHeartbeat: { enabled: false } }).remoteHeartbeat, {
    enabled: false,
    intervalSec: 30,
  })
  assert.equal(sanitizeSettings({ remoteHeartbeat: { intervalSec: 1 } }).remoteHeartbeat.intervalSec, 5)
  assert.equal(sanitizeSettings({ remoteHeartbeat: { intervalSec: 9999 } }).remoteHeartbeat.intervalSec, 600)
  assert.equal(sanitizeSettings({ remoteHeartbeat: { intervalSec: 'nope' } }).remoteHeartbeat.intervalSec, 30)
  assert.equal(sanitizeSettings({ remoteHeartbeat: 'off' }).remoteHeartbeat.enabled, true)
})

test('sanitizeHostEntry validates and normalizes a first host', () => {
  const settings = defaultSettings()
  const entry = sanitizeHostEntry(
    {
      name: '  腾讯云  ',
      address: 'ubuntu@192.0.2.10:2222',
      auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
      keepAlive: 'idle',
      idleMinutes: 30,
    },
    { settings },
  )
  assert.equal(entry.name, '腾讯云')
  assert.equal(entry.address, 'ubuntu@192.0.2.10:2222')
  assert.equal(entry.port, 2222)
  assert.equal(entry.username, 'ubuntu')
  assert.equal(entry.auth.type, 'key')
  assert.equal(entry.auth.keyPath, '~/.ssh/id_rsa')
  assert.equal(entry.keepAlive, 'idle')
  assert.equal(entry.idleMinutes, 30)
  assert.ok(entry.createdAt)
  assert.ok(entry.updatedAt)
})

test('sanitizeHostEntry keeps an existing id and pinned fingerprint, rejects missing address', () => {
  const existing = { id: 'h_1', createdAt: '2026-01-01T00:00:00.000Z', pinnedFingerprint: 'SHA256:abc' }
  const entry = sanitizeHostEntry({ id: 'h_1', address: 'test-host' }, { settings: defaultSettings(), existing })
  assert.equal(entry.id, 'h_1')
  assert.equal(entry.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(entry.pinnedFingerprint, 'SHA256:abc')
  assert.throws(() => sanitizeHostEntry({ name: 'x' }, { settings: defaultSettings() }), /address is required/)
})

test('sanitizeHostEntry keeps an existing jump host when an edit omits it, and clears on empty', () => {
  const existing = { id: 'h_1', createdAt: '2026-01-01T00:00:00.000Z', jumpHost: 'bastion' }
  const kept = sanitizeHostEntry({ id: 'h_1', address: 'test-host' }, { settings: defaultSettings(), existing })
  assert.equal(kept.jumpHost, 'bastion')
  const cleared = sanitizeHostEntry(
    { id: 'h_1', address: 'test-host', jumpHost: '' },
    { settings: defaultSettings(), existing },
  )
  assert.equal(cleared.jumpHost, null)
  const replaced = sanitizeHostEntry(
    { id: 'h_1', address: 'test-host', jumpHost: 'other-bastion' },
    { settings: defaultSettings(), existing },
  )
  assert.equal(replaced.jumpHost, 'other-bastion')
})

test('sanitizeHostEntry fills defaults from settings and existing values', () => {
  const settings = { ...defaultSettings(), defaultPort: 2200, hostKeyPolicy: 'strict', defaultAuth: 'password' }
  const entry = sanitizeHostEntry({ address: 'example.com' }, { settings })
  assert.equal(entry.port, 2200)
  assert.equal(entry.hostKeyPolicy, 'strict')
  assert.equal(entry.auth.type, 'password')
  assert.equal(entry.keepAlive, 'keep')
  assert.equal(entry.autoReconnect, true)
  assert.equal('bootstrap' in entry, false)
})

test('the remote profile setting accepts safe names and rejects desktop', () => {
  assert.equal(sanitizeSettings({ bootstrap: { profile: 'headless' } }).bootstrap.profile, 'headless')
  assert.equal(sanitizeSettings({ bootstrap: { profile: 'team.1' } }).bootstrap.profile, 'team.1')
  assert.equal(sanitizeSettings({ bootstrap: { profile: 'desktop' } }).bootstrap.profile, 'web')
  assert.equal(sanitizeSettings({ bootstrap: { profile: '../escape' } }).bootstrap.profile, 'web')
})

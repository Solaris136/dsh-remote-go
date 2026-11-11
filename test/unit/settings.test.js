import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings, sanitizeHostEntry, sanitizeSettings } from '../../src/settings.js'

test('defaultSettings matches the documented defaults', () => {
  const settings = defaultSettings()
  assert.equal(settings.defaultPort, 22)
  assert.equal(settings.defaultAuth, 'agent')
  assert.equal(settings.hostKeyPolicy, 'first-use')
  assert.equal(settings.saveTokens, false)
  assert.equal(settings.autoReconnect.enabled, true)
  assert.equal(settings.bootstrap.targetVersion, 'local')
  assert.equal(settings.bootstrap.mode, 'auto')
})

test('sanitizeSettings recovers from malformed input', () => {
  const settings = sanitizeSettings({
    defaultPort: 99999,
    defaultAuth: 'bogus',
    autoReconnect: { enabled: 'yes', maxAttempts: -3, baseDelayMs: 1 },
    language: 'fr',
    bootstrap: { mode: 'nope', nodeVersion: 'not-a-version', targetVersion: '' },
  })
  assert.equal(settings.defaultPort, 65535)
  assert.equal(settings.defaultAuth, 'agent')
  assert.equal(settings.autoReconnect.enabled, true)
  assert.equal(settings.autoReconnect.maxAttempts, 0)
  assert.equal(settings.autoReconnect.baseDelayMs, 100)
  assert.equal(settings.language, 'auto')
  assert.equal(settings.bootstrap.mode, 'auto')
  assert.equal(settings.bootstrap.nodeVersion, defaultSettings().bootstrap.nodeVersion)
  assert.equal(settings.bootstrap.targetVersion, 'local')
  assert.deepEqual(sanitizeSettings('garbage'), defaultSettings())
})

test('sanitizeHostEntry validates and normalizes a first host', () => {
  const settings = defaultSettings()
  const entry = sanitizeHostEntry(
    {
      name: '  腾讯云  ',
      address: 'ubuntu@43.133.80.40:2222',
      auth: { type: 'key', keyPath: '~/.ssh/id_ed25519' },
      keepAlive: 'idle',
      idleMinutes: 30,
    },
    { settings },
  )
  assert.equal(entry.name, '腾讯云')
  assert.equal(entry.address, 'ubuntu@43.133.80.40:2222')
  assert.equal(entry.port, 2222)
  assert.equal(entry.username, 'ubuntu')
  assert.equal(entry.auth.type, 'key')
  assert.equal(entry.auth.keyPath, '~/.ssh/id_ed25519')
  assert.equal(entry.keepAlive, 'idle')
  assert.equal(entry.idleMinutes, 30)
  assert.ok(entry.createdAt)
  assert.ok(entry.updatedAt)
})

test('sanitizeHostEntry keeps an existing id and pinned fingerprint, rejects missing address', () => {
  const existing = { id: 'h_1', createdAt: '2026-01-01T00:00:00.000Z', pinnedFingerprint: 'SHA256:abc' }
  const entry = sanitizeHostEntry({ id: 'h_1', address: 'tencent-vm' }, { settings: defaultSettings(), existing })
  assert.equal(entry.id, 'h_1')
  assert.equal(entry.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(entry.pinnedFingerprint, 'SHA256:abc')
  assert.throws(() => sanitizeHostEntry({ name: 'x' }, { settings: defaultSettings() }), /address is required/)
})

test('sanitizeHostEntry keeps an existing jump host when an edit omits it, and clears on empty', () => {
  const existing = { id: 'h_1', createdAt: '2026-01-01T00:00:00.000Z', jumpHost: 'bastion' }
  const kept = sanitizeHostEntry({ id: 'h_1', address: 'tencent-vm' }, { settings: defaultSettings(), existing })
  assert.equal(kept.jumpHost, 'bastion')
  const cleared = sanitizeHostEntry(
    { id: 'h_1', address: 'tencent-vm', jumpHost: '' },
    { settings: defaultSettings(), existing },
  )
  assert.equal(cleared.jumpHost, null)
  const replaced = sanitizeHostEntry(
    { id: 'h_1', address: 'tencent-vm', jumpHost: 'other-bastion' },
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
})

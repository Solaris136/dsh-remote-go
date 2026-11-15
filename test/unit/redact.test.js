import test from 'node:test'
import assert from 'node:assert/strict'
import { redactObject, redactText } from '../../src/redact.js'

test('redactText removes tokens from query strings and dsh web lines', () => {
  assert.match(redactText('http://127.0.0.1:5000/?token=abc123def456'), /token=<redacted>/)
  assert.doesNotMatch(redactText('http://127.0.0.1:5000/?token=abc123def456'), /abc123def456/)
  assert.match(redactText('dsh web: http://127.0.0.1:38123/?token=SUPERSECRET'), /token=<redacted>/)
  assert.doesNotMatch(redactText('dsh web: http://127.0.0.1:38123/?token=SUPERSECRET'), /SUPERSECRET/)
})

test('redactText removes headers, bearer tokens, passwords and private keys', () => {
  const sample = [
    'Authorization: Bearer abcdefghijklmnop',
    'Cookie: dsh-auth-xyz=secretvalue',
    'curl --password hunter2 https://example.com',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'AAAAB3NzaC1yc2EAAAADAQABAAABgQ==',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n')
  const redacted = redactText(sample)
  assert.doesNotMatch(redacted, /abcdefghijklmnop/)
  assert.doesNotMatch(redacted, /secretvalue/)
  assert.doesNotMatch(redacted, /hunter2/)
  assert.doesNotMatch(redacted, /AAAAB3NzaC1yc2E/)
  assert.match(redacted, /<redacted>/)
})

test('redactText anonymizes home directories by default but keeps them on request', () => {
  assert.equal(redactText('/home/alice/.dsh/profile'), '/home/<user>/.dsh/profile')
  assert.equal(redactText('/home/alice/.dsh/profile', { keepPaths: true }), '/home/alice/.dsh/profile')
  assert.equal(redactText('C:\\Users\\alice\\file'), 'C:\\Users\\<user>\\file')
})

test('redactObject deep-redacts secret-keyed fields', () => {
  const input = {
    host: 'test-host',
    password: 'p@ss',
    nested: { token: 'abc', label: 'ok' },
    list: [{ apiKey: 'k', name: 'n' }],
  }
  const output = redactObject(input)
  assert.equal(output.password, '<redacted>')
  assert.equal(output.nested.token, '<redacted>')
  assert.equal(output.nested.label, 'ok')
  assert.equal(output.list[0].apiKey, '<redacted>')
  assert.equal(output.list[0].name, 'n')
})

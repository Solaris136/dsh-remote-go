import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDiagnosticBundle, redactLongOpaque, redactObject, redactText, redactUrl } from '../../src/redact.js'

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
    host: 'tencent-vm',
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

test('redactUrl keeps the shape without secrets', () => {
  const url = redactUrl('http://127.0.0.1:5000/?token=abc&x=1')
  assert.match(url, /x=1/)
  assert.doesNotMatch(url, /token=abc/)
})

test('redactLongOpaque hides long secrets but keeps diagnostics text', () => {
  const longHex = 'a'.repeat(64)
  const output = redactLongOpaque(`fingerprint ${longHex} at /home/bob/x`)
  assert.doesNotMatch(output, new RegExp(longHex))
  assert.match(output, /fingerprint <redacted-hex>/)
  assert.match(output, /\/home\/<user>\/x/)
})

test('buildDiagnosticBundle redacts nested credentials and adds metadata', () => {
  const bundle = buildDiagnosticBundle({
    host: 'tencent-vm',
    connection: { token: 'secret', port: 22 },
    checks: [{ id: 'ssh', status: 'pass' }],
  })
  assert.equal(bundle.host, 'tencent-vm')
  assert.equal(bundle.connection.token, '<redacted>')
  assert.equal(bundle.connection.port, 22)
  assert.equal(bundle.plugin, 'dsh-remote-go')
  assert.ok(typeof bundle.generatedAt === 'string')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { redactObject, redactText } from '../../dist/src/redact.js'

test('redactText removes tokens from query strings, fragments and header lines', () => {
  const secrets = ['abc123def456', 'SUPERSECRET', 'abcdefghijkl', 'supersecretkey']
  const sample = [
    'http://127.0.0.1:5000/?token=abc123def456',
    'dsh web: http://127.0.0.1:38123/?token=SUPERSECRET',
    'launch token=abc123def456 done',
    'see #token=abc123def456',
    'x-auth-token: abcdefghijkl',
    'x-dsh-session-key: supersecretkey',
  ].join('\n')
  const redacted = redactText(sample)
  for (const secret of secrets) assert.equal(redacted.includes(secret), false, `${secret} survived redaction`)
  assert.match(redacted, /token=<redacted>/)
  assert.match(redacted, /x-auth-token: <redacted>/i)
  // Each URL shape is checked on its own: a union match would still pass if one shape stopped rewriting its token to
  // the same replacement.
  assert.match(redactText('http://127.0.0.1:5000/?token=abc123def456'), /token=<redacted>/)
  assert.match(redactText('dsh web: http://127.0.0.1:38123/?token=SUPERSECRET'), /token=<redacted>/)
})

test('redactText removes secrets and home paths, and redactObject redacts secret-keyed fields', () => {
  const redacted = redactText(
    'Authorization: Bearer abcdefghijklmnop\nCookie: dsh-auth-xyz=secretvalue\n' +
      'curl --password hunter2 https://example.com\n-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      'AAAAB3NzaC1yc2EAAAADAQABAAABgQ==\n-----END OPENSSH PRIVATE KEY-----',
  )
  for (const secret of ['abcdefghijklmnop', 'secretvalue', 'hunter2', 'AAAAB3NzaC1yc2E']) {
    assert.doesNotMatch(redacted, new RegExp(secret), secret)
  }
  assert.match(redacted, /<redacted>/)
  // `-p` is ssh's port flag; the password redaction used to eat the port number.
  assert.equal(redactText('ssh -p 2222 ubuntu@host'), 'ssh -p 2222 ubuntu@host')
  assert.match(redactText('sshpass -p hunter2 ssh ubuntu@host'), /<redacted>/)
  for (const line of [
    'sshpass -p hunter2 ssh ubuntu@host',
    'curl --password hunter2 https://example.com',
    'password=hunter2',
  ]) {
    assert.doesNotMatch(redactText(line), /hunter2/, line)
  }
  // Home paths are anonymized by default; `keepPaths` opts out.
  const cases = [
    ['/home/alice/.dsh/profile', '/home/<user>/.dsh/profile'],
    ['C:\\Users\\alice\\file', 'C:\\Users\\<user>\\file'],
    ['/Users/alice/.ssh/id_rsa', '/Users/<user>/.ssh/id_rsa'],
  ]
  for (const [input, expected] of cases) assert.equal(redactText(input), expected, input)
  assert.equal(redactText('/home/alice/.dsh/profile', { keepPaths: true }), '/home/alice/.dsh/profile')
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

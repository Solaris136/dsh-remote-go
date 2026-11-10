import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshConnection, parseSshKeyType, toSshError, WINDOWS_AGENT_PIPE } from '../../src/ssh.js'
import { fingerprintFromBlob } from '../../src/known-hosts.js'
import { errors } from '../../src/errors.js'

function makeKeyBlob(keyType = 'ssh-ed25519', payload = 'key-material') {
  const type = Buffer.from(keyType, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length, 0)
  return Buffer.concat([len, type, Buffer.from(payload, 'ascii')])
}

test('parseSshKeyType reads the SSH wire key type', () => {
  assert.equal(parseSshKeyType(makeKeyBlob('ssh-ed25519')), 'ssh-ed25519')
  assert.equal(parseSshKeyType(makeKeyBlob('ecdsa-sha2-nistp256')), 'ecdsa-sha2-nistp256')
  assert.equal(parseSshKeyType(Buffer.alloc(0)), 'unknown')
  assert.equal(parseSshKeyType(Buffer.from([0, 0, 0, 99, 1, 2])), 'unknown')
})

test('toSshError classifies auth, network and host-key failures', () => {
  assert.equal(toSshError(new Error('All configured authentication methods failed'), 'h', 22).code, 'auth')
  assert.equal(toSshError(new Error('connect ECONNREFUSED 1.2.3.4:22'), 'h', 22).code, 'network')
  assert.equal(toSshError(new Error('Timed out while waiting for handshake'), 'h', 22).code, 'network')
  assert.equal(toSshError(new Error('Host key verification failed'), 'h', 22).code, 'network')
  // Already-coded plugin errors pass through untouched.
  assert.equal(toSshError(errors.auth(), 'h', 22).code, 'auth')
  assert.equal(toSshError(errors.hostKeyChanged('SHA256:a', 'SHA256:b'), 'h', 22).code, 'host-key-changed')
})

test('verifyHostKey accepts a matching pinned fingerprint', async () => {
  const blob = makeKeyBlob()
  const fingerprint = fingerprintFromBlob(blob)
  const ssh = new SshConnection({ host: 'example.com', pinnedFingerprint: fingerprint })
  assert.equal(await ssh.verifyHostKey(blob), true)
  assert.equal(ssh.fingerprint, fingerprint)
  assert.equal(ssh.keyType, 'ssh-ed25519')
})

test('verifyHostKey rejects a changed pinned fingerprint', async () => {
  const blob = makeKeyBlob()
  const ssh = new SshConnection({ host: 'example.com', pinnedFingerprint: 'SHA256:somethingelse' })
  await assert.rejects(() => ssh.verifyHostKey(blob), (error) => error.code === 'host-key-changed')
})

test('verifyHostKey accepts any fingerprint present in known_hosts', async () => {
  const blob = makeKeyBlob()
  const ssh = new SshConnection({ host: 'example.com', knownHostFingerprints: ['SHA256:other', fingerprintFromBlob(blob)] })
  assert.equal(await ssh.verifyHostKey(blob), true)
})

test('verifyHostKey rejects an unknown fingerprint under strict policy', async () => {
  const ssh = new SshConnection({ host: 'example.com', hostKeyPolicy: 'strict' })
  await assert.rejects(() => ssh.verifyHostKey(makeKeyBlob()), (error) => error.code === 'host-key-unknown')
})

test('verifyHostKey asks the UI on first use and honors the answer', async () => {
  const blob = makeKeyBlob()
  let asked = null
  const accept = new SshConnection({
    host: 'example.com',
    onHostKey: async (info) => {
      asked = info
      return true
    },
  })
  assert.equal(await accept.verifyHostKey(blob), true)
  assert.equal(asked.sha256, fingerprintFromBlob(blob))
  assert.equal(asked.keyType, 'ssh-ed25519')

  const reject = new SshConnection({ host: 'example.com', onHostKey: async () => false })
  await assert.rejects(() => reject.verifyHostKey(blob), (error) => error.code === 'host-key-unknown')
})

test('verifyHostKey refuses unknown keys when no UI is attached', async () => {
  const ssh = new SshConnection({ host: 'example.com' })
  await assert.rejects(() => ssh.verifyHostKey(makeKeyBlob()), (error) => error.code === 'host-key-unknown')
})

test('verifyHostKey can be told to accept unknown keys (automation)', async () => {
  const ssh = new SshConnection({ host: 'example.com', acceptUnknownHostKey: true })
  assert.equal(await ssh.verifyHostKey(makeKeyBlob()), true)
})

test('resolveAuthCandidates returns password, key and agent candidates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-key-'))
  const keyFile = path.join(dir, 'id_test')
  await writeFile(keyFile, 'PRIVATE-KEY-BYTES', 'utf8')

  const password = new SshConnection({ host: 'h', auth: { type: 'password', password: 'pw' } })
  assert.deepEqual(await password.resolveAuthCandidates(), [{ password: 'pw', tryKeyboard: true }])

  const key = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: keyFile }, home: dir })
  const keyCandidates = await key.resolveAuthCandidates()
  assert.equal(keyCandidates.length, 1)
  assert.equal(Buffer.from(keyCandidates[0].privateKey).toString('utf8'), 'PRIVATE-KEY-BYTES')

  const missing = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: path.join(dir, 'nope') }, home: dir })
  assert.deepEqual(await missing.resolveAuthCandidates(), [])

  const previousAgent = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
  try {
    const agent = new SshConnection({ host: 'h', auth: { type: 'agent' }, home: dir })
    const agentCandidates = await agent.resolveAuthCandidates()
    assert.equal(agentCandidates[0].agent, '/tmp/agent.sock')
  } finally {
    if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = previousAgent
  }
  assert.equal(typeof WINDOWS_AGENT_PIPE, 'string')
})

test('exec refuses to run without an open connection', async () => {
  const ssh = new SshConnection({ host: 'example.com' })
  await assert.rejects(() => ssh.exec('true'), /not open/)
  await assert.rejects(() => ssh.forwardOut('127.0.0.1', 80), /not open/)
})

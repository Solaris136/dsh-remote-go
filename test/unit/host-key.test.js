import test from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
import {
  createHostKey,
  describeHostKey,
  HOST_KEY_GENERATION_ATTEMPTS,
  normalizePrivateKey,
} from '../../e2e/sim/host-key.mjs'

const { utils } = ssh2

function carriageReturns(buffer) {
  let count = 0
  for (const byte of buffer) if (byte === 0x0d) count += 1
  return count
}

function fingerprintOf(material) {
  const parsed = utils.parseKey(material)
  assert.equal(parsed instanceof Error, false, parsed instanceof Error ? parsed.message : '')
  return {
    fingerprint: Buffer.from(parsed.getPublicSSH()).toString('base64'),
    keyType: parsed.type,
  }
}

test('the host key the simulator uses parses and carries a fingerprint', () => {
  const hostKey = createHostKey()
  assert.equal(Buffer.isBuffer(hostKey.material), true, 'the key material must stay a Buffer end to end')
  assert.equal(carriageReturns(hostKey.material), 0, 'the key material must be free of carriage returns')
  assert.match(hostKey.fingerprint, /^SHA256:[A-Za-z0-9+/]{40,}$/)
  assert.equal(hostKey.keyType, 'ssh-ed25519')
  assert.ok(hostKey.publicBlob.length > 0, 'the public blob must not be empty')
  const parsed = utils.parseKey(hostKey.material)
  assert.equal(parsed instanceof Error, false, parsed instanceof Error ? parsed.message : '')
  assert.equal(Buffer.compare(Buffer.from(parsed.getPublicSSH()), hostKey.publicBlob), 0)
})

test('a CRLF-mangled host key normalises back to something ssh2 can parse', () => {
  const lf = Buffer.from(createHostKey().material)
  const crlf = Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8')
  assert.ok(carriageReturns(crlf) > 0, 'the fixture must actually contain carriage returns')
  const normalized = normalizePrivateKey(crlf)
  assert.equal(Buffer.isBuffer(normalized), true)
  assert.equal(carriageReturns(normalized), 0, 'normalisation must remove every carriage return')
  assert.equal(normalized.toString('latin1'), lf.toString('latin1'), 'CRLF and LF forms must normalise identically')
  assert.deepEqual(fingerprintOf(normalized), fingerprintOf(lf))
  assert.equal(describeHostKey(crlf).fingerprint, describeHostKey(lf).fingerprint)
})

test('binary key material is left byte-identical (no carriage-return stripping)', () => {
  const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x01])
  assert.deepEqual(normalizePrivateKey(binary), binary)
  assert.deepEqual(normalizePrivateKey(new Uint8Array(binary)), binary)
})

test('an unusable host key fails loudly at startup instead of at handshake time', () => {
  const broken = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nnot base64\n-----END OPENSSH PRIVATE KEY-----\n')
  assert.throws(
    () => describeHostKey(broken),
    (error) => {
      assert.match(String(error?.message), /not parseable/)
      return true
    },
  )
  const parsed = utils.parseKey(broken)
  assert.equal(parsed instanceof Error, true, 'ssh2 must reject this fixture, or the test proves nothing')
  assert.match(parsed.message, /privateKey|Malformed/i)
})

const UNPARSEABLE_ARMOR = Buffer.from(
  '-----BEGIN OPENSSH PRIVATE KEY-----\nnot base64\n-----END OPENSSH PRIVATE KEY-----\n',
)

test('host-key generation retries a malformed key, and stops after the bounded attempts', () => {
  const valid = createHostKey()
  let calls = 0
  const key = createHostKey({
    generate: () => {
      calls += 1
      return calls === 1 ? { private: UNPARSEABLE_ARMOR } : { private: valid.material }
    },
  })
  assert.equal(calls, 2, 'the first, unparseable key must trigger exactly one retry')
  assert.equal(key.keyType, 'ssh-ed25519')
  assert.equal(Buffer.compare(key.publicBlob, valid.publicBlob), 0)
  let attempts = 0
  assert.throws(
    () =>
      createHostKey({
        generate: () => {
          attempts += 1
          return { private: UNPARSEABLE_ARMOR }
        },
      }),
    (error) => {
      assert.match(String(error?.message), /not parseable/)
      return true
    },
  )
  assert.equal(attempts, HOST_KEY_GENERATION_ATTEMPTS, 'generation must be bounded, not unbounded retrying')
})

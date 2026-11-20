import test from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
import { createHostKey, describeHostKey, HOST_KEY_GENERATION_ATTEMPTS } from '../../e2e/sim/host-key.mjs'
import { normalizePrivateKey } from '../../e2e/sim/host-key.mjs'

const { utils } = ssh2
/** `\r` bytes in `buffer`; a CRLF-mangled key must end up with none. */
const carriageReturns = (buffer) => [...buffer].filter((byte) => byte === 0x0d).length
function fingerprintOf(material) {
  const parsed = utils.parseKey(material)
  assert.equal(parsed instanceof Error, false, parsed instanceof Error ? parsed.message : '')
  return { fingerprint: Buffer.from(parsed.getPublicSSH()).toString('base64'), keyType: parsed.type }
}
const UNPARSEABLE_ARMOR = Buffer.from(
  '-----BEGIN OPENSSH PRIVATE KEY-----\nnot base64\n-----END OPENSSH PRIVATE KEY-----\n',
)

test('the host key the simulator uses parses, carries a fingerprint and normalises CRLF', () => {
  const hostKey = createHostKey()
  assert.equal(Buffer.isBuffer(hostKey.material), true, 'the key material must stay a Buffer end to end')
  assert.equal(carriageReturns(hostKey.material), 0, 'the key material must be free of carriage returns')
  assert.match(hostKey.fingerprint, /^SHA256:[A-Za-z0-9+/]{40,}$/)
  assert.equal(hostKey.keyType, 'ssh-ed25519')
  assert.ok(hostKey.publicBlob.length > 0, 'the public blob must not be empty')
  const parsed = utils.parseKey(hostKey.material)
  assert.equal(parsed instanceof Error, false, parsed instanceof Error ? parsed.message : '')
  assert.equal(Buffer.compare(Buffer.from(parsed.getPublicSSH()), hostKey.publicBlob), 0)
  // A CRLF-mangled copy of the same key must normalise back to something ssh2 can parse.
  const lf = Buffer.from(createHostKey().material)
  const crlf = Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8')
  assert.ok(carriageReturns(crlf) > 0, 'the fixture must actually contain carriage returns')
  const normalized = normalizePrivateKey(crlf)
  assert.equal(Buffer.isBuffer(normalized), true)
  assert.equal(carriageReturns(normalized), 0, 'normalisation must remove every carriage return')
  assert.equal(normalized.toString('latin1'), lf.toString('latin1'), 'CRLF and LF forms must normalise identically')
  assert.deepEqual(fingerprintOf(normalized), fingerprintOf(lf))
  assert.equal(describeHostKey(crlf).fingerprint, describeHostKey(lf).fingerprint)
  // Binary key material is left byte-identical: normalisation only strips CRLF from text keys.
  const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x01])
  assert.deepEqual(normalizePrivateKey(binary), binary)
  assert.deepEqual(normalizePrivateKey(new Uint8Array(binary)), binary)
})

test('an unusable host key fails at startup and generation retries then stops', () => {
  assert.throws(
    () => describeHostKey(UNPARSEABLE_ARMOR),
    (error) => {
      assert.match(String(error?.message), /not parseable/)
      return true
    },
  )
  const parsed = utils.parseKey(UNPARSEABLE_ARMOR)
  assert.equal(parsed instanceof Error, true, 'ssh2 must reject this fixture, or the test proves nothing')
  assert.match(parsed.message, /privateKey|Malformed/i)
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

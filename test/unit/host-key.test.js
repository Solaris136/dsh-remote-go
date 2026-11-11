/**
 * Regression coverage for the simulated host's SSH host key (e2e/sim/host-key.mjs).
 *
 * Why this exists: on the Windows CI runner the desktop suite failed with
 * `Cannot parse privateKey: Malformed OpenSSH private key`. The simulator died at
 * server construction, so the connect never happened and every panel subtest then
 * failed with "the simulated host was not connected" — a downstream symptom that
 * pointed at the panel instead of at the key. OpenSSH private keys are armored
 * text and line-ending sensitive, and a single CRLF translation in the chain
 * (environment, shim, file round-trip) is enough to produce exactly that message.
 *
 * These assertions run on every platform, including Linux, so the handling cannot
 * silently regress back to "works on my machine": they pin the invariant we own
 * (carriage returns never reach ssh2) rather than trusting ssh2's tolerance, which
 * differs between versions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
import { createHostKey, describeHostKey, normalizePrivateKey } from '../../e2e/sim/host-key.mjs'

const { utils } = ssh2

/** An armored key is text: no carriage return may survive normalisation. */
function carriageReturns(buffer) {
  let count = 0
  for (const byte of buffer) if (byte === 0x0d) count += 1
  return count
}

/** @param {string | Buffer} material */
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
  // The same material must survive ssh2's own parser, which is what the server does.
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
  // The invariant we own: no CR survives, and the bytes are exactly the LF form.
  assert.equal(carriageReturns(normalized), 0, 'normalisation must remove every carriage return')
  assert.equal(normalized.toString('latin1'), lf.toString('latin1'), 'CRLF and LF forms must normalise identically')
  // End to end: the normalised key parses to the same public material.
  assert.deepEqual(fingerprintOf(normalized), fingerprintOf(lf))
  // `describeHostKey` is the simulator's entry point and must accept either form.
  assert.equal(describeHostKey(crlf).fingerprint, describeHostKey(lf).fingerprint)
})

test('binary key material is left byte-identical (no carriage-return stripping)', () => {
  // A lone 0x0d is legitimate key data outside armored text; stripping it would
  // corrupt a binary key, so normalisation must only touch armored input.
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

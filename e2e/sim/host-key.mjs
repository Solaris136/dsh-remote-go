/**
 * SSH host-key material for the simulated remote host.
 *
 * Why this is a module and not three lines in `simulated-remote.mjs`: the host key
 * is generated in memory and handed straight to `ssh2`'s server, and a single CRLF
 * translation anywhere in that chain makes `ssh2` answer
 * `Cannot parse privateKey: Malformed OpenSSH private key` at server construction
 * (i.e. the simulator dies before it can listen, and every test that needs a
 * connection fails with a confusing downstream error). Windows CI is exactly where
 * that class of bug shows up first, so the handling is deterministic, byte-level
 * and unit-tested on every platform.
 *
 * Rules:
 * - the material stays a **Buffer** end to end (no `.toString()` round-trip);
 * - carriage returns are dropped from armored text before `ssh2` sees the key;
 * - a key that cannot be parsed throws here, with the reason, instead of surfacing
 *   later as a handshake failure.
 *
 * This module has no side effects: importing it never starts a listener.
 */
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'

const { utils } = ssh2

/** First bytes of an OpenSSH/PEM armored key (`-----BEGIN `). */
const ARMOR_PREFIX = '-----BEGIN '
/** An armored key is text: `\r` is always transport noise, never key material. */
const CARRIAGE_RETURN = 0x0d

/**
 * Attempts for host-key generation. `ssh2`'s ed25519 keygen is flaky under CPU
 * load (see `createHostKey`), and five attempts take the observed ~3% failure rate
 * to a negligible one without masking a genuinely broken generator.
 */
export const HOST_KEY_GENERATION_ATTEMPTS = 5

/**
 * @typedef {{
 *   material: Buffer,
 *   keyType: string,
 *   publicBlob: Buffer,
 *   fingerprint: string,
 * }} HostKey
 */

/**
 * Normalize private-key material: always a Buffer, with carriage returns removed
 * from armored text.
 *
 * Bytes are filtered in place (no string round-trip), and binary material is left
 * untouched because a lone `0x0d` can be real key data there.
 * @param {string | Buffer | Uint8Array} material
 * @returns {Buffer}
 */
export function normalizePrivateKey(material) {
  /** @type {Buffer} */
  let buffer
  if (typeof material === 'string') {
    buffer = Buffer.from(material, 'utf8')
  } else if (Buffer.isBuffer(material)) {
    // Copy: the caller's buffer must never be mutated by the in-place filter.
    buffer = Buffer.from(material)
  } else if (ArrayBuffer.isView(material)) {
    // Typed arrays are byte material; copied so the filter cannot touch the input.
    buffer = Buffer.from(Uint8Array.from(new Uint8Array(material.buffer, material.byteOffset, material.byteLength)))
  } else {
    throw new TypeError('private key material must be a string, Buffer or typed array')
  }
  if (buffer.toString('ascii', 0, ARMOR_PREFIX.length) !== ARMOR_PREFIX) return buffer
  let write = 0
  for (let read = 0; read < buffer.length; read += 1) {
    if (buffer[read] === CARRIAGE_RETURN) continue
    buffer[write] = buffer[read]
    write += 1
  }
  return buffer.subarray(0, write)
}

/**
 * Parse normalized key material into the facts the simulator needs.
 *
 * Throws (never returns a half-valid key) so a broken key is a startup error that
 * names the reason, rather than a handshake failure minutes later.
 * @param {string | Buffer | Uint8Array} material
 * @returns {HostKey}
 */
export function describeHostKey(material) {
  const normalized = normalizePrivateKey(material)
  const parsed = utils.parseKey(normalized)
  if (parsed instanceof Error) {
    throw new Error(`the SSH host key is not parseable: ${parsed.message}`)
  }
  if (!parsed || typeof parsed.getPublicSSH !== 'function') {
    throw new Error('the SSH host key parsed to an unusable object (no public blob)')
  }
  const publicBlob = Buffer.from(parsed.getPublicSSH())
  const digest = createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')
  return {
    material: normalized,
    keyType: typeof parsed.type === 'string' ? parsed.type : 'unknown',
    publicBlob,
    fingerprint: `SHA256:${digest}`,
  }
}

/**
 * Generate a fresh ed25519 host key and validate it before it is used.
 *
 * `ssh2`'s synchronous ed25519 keygen occasionally produces armored material its
 * own parser rejects (`Malformed OpenSSH private key`) when the machine is under
 * CPU load — observed on the Windows CI runner and reproduced locally with
 * concurrent test workers (~1 in 30 runs). Handing that key to the SSH server makes
 * the simulator die at construction, so generation is retried a bounded number of
 * times; the validation itself stays strict (the assertions are unchanged).
 * @param {{ generate?: () => { private?: unknown, public?: unknown } }} [options]
 *   `generate` is a test seam: it lets the retry be exercised deterministically.
 * @returns {HostKey}
 */
export function createHostKey(options = {}) {
  const generate =
    typeof options.generate === 'function' ? options.generate : () => utils.generateKeyPairSync('ed25519')
  /** @type {Error | null} */
  let lastError = null
  for (let attempt = 1; attempt <= HOST_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    const generated = generate()
    if (!generated || generated.private === undefined || generated.private === null) {
      lastError = new Error('ssh2 generated no private host key')
      continue
    }
    try {
      return describeHostKey(generated.private)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError ?? new Error('ssh2 generated no private host key')
}

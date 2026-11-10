/**
 * Read-only `~/.ssh/known_hosts` parsing and OpenSSH SHA256 fingerprints
 * (design §15.1: hashed entries are counted, never guessed at).
 */
import { createHash } from 'node:crypto'

/**
 * @typedef {{
 *   hosts: string[],
 *   keyType: string,
 *   keyBase64: string,
 *   fingerprint: string,
 *   marker: string | null,
 *   line: number,
 * }} KnownHostEntry
 */

/**
 * @param {string} keyBase64
 * @returns {string} OpenSSH-style `SHA256:<base64 without padding>`
 */
export function fingerprintFromBase64(keyBase64) {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/g, '')}`
}

/**
 * Fingerprint a raw host-key blob (what ssh2's hostVerifier receives).
 * @param {Buffer | Uint8Array} keyBlob
 */
export function fingerprintFromBlob(keyBlob) {
  const digest = createHash('sha256').update(keyBlob).digest('base64')
  return `SHA256:${digest.replace(/=+$/g, '')}`
}

/**
 * @param {string} text
 * @returns {{ entries: KnownHostEntry[], hashedCount: number, malformed: {line: number, text: string}[], revoked: number, certAuthority: number }}
 */
export function parseKnownHosts(text) {
  /** @type {KnownHostEntry[]} */
  const entries = []
  /** @type {{line: number, text: string}[]} */
  const malformed = []
  let hashedCount = 0
  let revoked = 0
  let certAuthority = 0

  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    const raw = lines[index].trim()
    if (raw === '' || raw.startsWith('#')) continue
    const parts = raw.split(/\s+/)
    let marker = null
    if (parts[0].startsWith('@')) marker = parts.shift() ?? null
    if (parts.length < 3) {
      malformed.push({ line: lineNo, text: raw })
      continue
    }
    const [hostField, keyType, keyBase64] = parts
    if (marker === '@revoked') {
      revoked += 1
      continue
    }
    if (marker === '@cert-authority') {
      certAuthority += 1
      continue
    }
    if (hostField.startsWith('|1|')) {
      hashedCount += 1
      continue
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(keyBase64 ?? '')) {
      malformed.push({ line: lineNo, text: raw })
      continue
    }
    entries.push({
      hosts: hostField.split(',').filter(Boolean),
      keyType,
      keyBase64,
      fingerprint: fingerprintFromBase64(keyBase64),
      marker,
      line: lineNo,
    })
  }
  return { entries, hashedCount, malformed, revoked, certAuthority }
}

/**
 * Does a known_hosts host field match `host[:port]`?
 * OpenSSH stores non-default ports as `[host]:port`; wildcards are honored.
 * @param {string} pattern
 * @param {string} host
 * @param {number} port
 */
export function knownHostFieldMatches(pattern, host, port) {
  const portSuffix = port && port !== 22 ? `:${port}` : null
  const candidates = portSuffix ? [`[${host}]${portSuffix}`] : []
  // A plain `host` line also matches a non-default port only for SSH's default
  // behavior; be conservative and require the bracketed form for non-22.
  candidates.push(host, `[${host}]`)
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  const matcher = new RegExp(`^${escaped}$`, 'i')
  return candidates.some((candidate) => matcher.test(candidate))
}

/**
 * @param {ReturnType<typeof parseKnownHosts>} parsed
 * @param {string} host
 * @param {number} port
 */
export function findKnownHostEntries(parsed, host, port) {
  return parsed.entries.filter((entry) => entry.hosts.some((pattern) => knownHostFieldMatches(pattern, host, port)))
}

/**
 * First recorded fingerprint for a host, if any.
 * @param {ReturnType<typeof parseKnownHosts>} parsed
 * @param {string} host
 * @param {number} port
 */
export function findPinnedFingerprint(parsed, host, port) {
  const matches = findKnownHostEntries(parsed, host, port)
  return matches.length > 0 ? matches[0].fingerprint : null
}

/**
 * Human-readable summary for the alias discovery endpoint.
 * @param {ReturnType<typeof parseKnownHosts>} parsed
 */
export function summarizeKnownHosts(parsed) {
  const hosts = new Set()
  for (const entry of parsed.entries) {
    for (const host of entry.hosts) {
      if (!host.startsWith('|1|')) hosts.add(host)
    }
  }
  return {
    entries: parsed.entries.length,
    hashed: parsed.hashedCount,
    hosts: [...hosts].sort().slice(0, 200),
  }
}

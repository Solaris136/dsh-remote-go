import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  findKnownHostEntries,
  findPinnedFingerprint,
  fingerprintFromBase64,
  fingerprintFromBlob,
  knownHostFieldMatches,
  parseKnownHosts,
  summarizeKnownHosts,
} from '../../src/known-hosts.js'

/** A deterministic fake key blob whose first field is the key type. */
function makeKeyBlob(keyType = 'ssh-ed25519', payload = 'abcdef') {
  const type = Buffer.from(keyType, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length, 0)
  return Buffer.concat([len, type, Buffer.from(payload, 'ascii')])
}

function base64(blob) {
  return blob.toString('base64')
}

test('fingerprintFromBlob matches the OpenSSH SHA256 format', () => {
  const blob = makeKeyBlob()
  const expected = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/g, '')}`
  assert.equal(fingerprintFromBlob(blob), expected)
  assert.match(expected, /^SHA256:[A-Za-z0-9+/]+$/)
})

test('fingerprintFromBase64 equals fingerprintFromBlob', () => {
  const blob = makeKeyBlob()
  assert.equal(fingerprintFromBase64(base64(blob)), fingerprintFromBlob(blob))
})

test('parseKnownHosts handles plain, port-qualified, hashed and marker lines', () => {
  const key1 = makeKeyBlob('ssh-ed25519', 'one')
  const key2 = makeKeyBlob('ssh-rsa', 'two')
  const text = [
    '# comment',
    `example.com,192.0.2.1 ${'ssh-ed25519'} ${base64(key1)}`,
    `[example.com]:2222 ssh-rsa ${base64(key2)}`,
    '|1|somesalt|somehash ssh-ed25519 AAAA',
    `@revoked revoked.example ssh-ed25519 ${base64(key1)}`,
    `@cert-authority ca.example ssh-ed25519 ${base64(key2)}`,
    'malformed-line',
  ].join('\n')
  const parsed = parseKnownHosts(text)
  assert.equal(parsed.entries.length, 2)
  assert.deepEqual(parsed.entries[0].hosts, ['example.com', '192.0.2.1'])
  assert.equal(parsed.entries[0].fingerprint, fingerprintFromBlob(key1))
  assert.equal(parsed.hashedCount, 1)
  assert.equal(parsed.revoked, 1)
  assert.equal(parsed.certAuthority, 1)
  assert.equal(parsed.malformed.length, 1)
})

test('findKnownHostEntries matches hosts and non-default ports', () => {
  const key = makeKeyBlob()
  const text = [`[example.com]:2222 ssh-ed25519 ${base64(key)}`, `plain.example ssh-ed25519 ${base64(key)}`].join('\n')
  const parsed = parseKnownHosts(text)
  assert.equal(findKnownHostEntries(parsed, 'example.com', 2222).length, 1)
  assert.equal(findKnownHostEntries(parsed, 'example.com', 22).length, 0)
  assert.equal(findKnownHostEntries(parsed, 'plain.example', 22).length, 1)
  assert.equal(findPinnedFingerprint(parsed, 'plain.example', 22), fingerprintFromBlob(key))
})

test('knownHostFieldMatches supports wildcards', () => {
  assert.equal(knownHostFieldMatches('*.example.com', 'a.example.com', 22), true)
  assert.equal(knownHostFieldMatches('10.0.0.?', '10.0.0.5', 22), true)
  assert.equal(knownHostFieldMatches('*.example.com', 'example.org', 22), false)
})

test('summarizeKnownHosts counts and lists hosts without exposing hashes', () => {
  const key = makeKeyBlob()
  const parsed = parseKnownHosts(`a.example,b.example ssh-ed25519 ${base64(key)}\n|1|x|y ssh-rsa AAAA\n`)
  const summary = summarizeKnownHosts(parsed)
  assert.equal(summary.entries, 1)
  assert.equal(summary.hashed, 1)
  assert.deepEqual(summary.hosts, ['a.example', 'b.example'])
})

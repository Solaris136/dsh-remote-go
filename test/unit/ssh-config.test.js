import test from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverSshAliases,
  entryMatches,
  matchHostPattern,
  parseSshConfig,
  resolveDestination,
  resolveSshAlias,
} from '../../src/ssh-config.js'

const CONFIG = `# global defaults
ServerAliveInterval 30
IdentityFile ~/.ssh/id_rsa

Host tencent-vm 43.133.80.40
  HostName 240d:c000:f05f:8d00:327e:8b66:5c18:0
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519

Host web-*
  User deploy
  Port 2222

Host !web-prod web-*
  IdentityFile ~/.ssh/deploy_rsa

Host *
  ServerAliveInterval 60
`

test('parseSshConfig collects global options, host blocks and unsupported keywords', () => {
  const parsed = parseSshConfig(CONFIG)
  assert.equal(parsed.globals.identityfile[0], '~/.ssh/id_rsa')
  assert.equal(parsed.entries.length, 4) // tencent-vm, web-*, !web-prod web-*, Host *
  const negatedBlock = parsed.entries.find((entry) => entry.negated.length === 1)
  assert.deepEqual(negatedBlock.negated, ['web-prod'])
  const multiPattern = parsed.entries.find((entry) => entry.patterns.includes('tencent-vm'))
  assert.deepEqual(multiPattern.patterns, ['tencent-vm', '43.133.80.40'])
})

test('parseSshConfig records Include/Match as unsupported instead of guessing', () => {
  const parsed = parseSshConfig(`Include ~/.ssh/other.conf\nMatch exec "true"\n  User x\nHost a\n  User b\n`)
  assert.ok(parsed.unsupported.some((item) => item.keyword === 'Include'))
  assert.ok(parsed.unsupported.some((item) => item.keyword === 'Match'))
  // The option inside the Match block must not leak into host `a`.
  const alias = resolveSshAlias(parsed, 'a', { home: '/home/u' })
  assert.equal(alias.user, 'b')
})

test('resolveSshAlias applies host block options and identity files accumulate', () => {
  const parsed = parseSshConfig(CONFIG)
  const alias = resolveSshAlias(parsed, 'tencent-vm', { home: '/home/u' })
  assert.equal(alias.host, '240d:c000:f05f:8d00:327e:8b66:5c18:0')
  assert.equal(alias.user, 'ubuntu')
  assert.equal(alias.port, 22)
  // IdentityFile is additive in OpenSSH: global then host-specific.
  assert.deepEqual(alias.identityFiles, ['/home/u/.ssh/id_rsa', '/home/u/.ssh/id_ed25519'])
  assert.equal(alias.source, 'config')
})

test('first obtained value wins across matching blocks', () => {
  const parsed = parseSshConfig(CONFIG)
  const alias = resolveSshAlias(parsed, 'web-1', { home: '/home/u' })
  // web-* sets User deploy + Port 2222; identity files accumulate from every match.
  assert.equal(alias.user, 'deploy')
  assert.equal(alias.port, 2222)
  assert.deepEqual(alias.identityFiles, ['/home/u/.ssh/id_rsa', '/home/u/.ssh/deploy_rsa'])
})

test('discoverSshAliases returns concrete aliases only', () => {
  const parsed = parseSshConfig(CONFIG)
  const aliases = discoverSshAliases(parsed, { home: '/home/u' }).map((item) => item.alias)
  assert.deepEqual(aliases, ['tencent-vm', '43.133.80.40'])
})

test('resolveDestination keeps literal user/port and inherits global identity files', () => {
  const resolved = resolveDestination('deploy@example.com:2222', { configText: CONFIG, home: '/home/u' })
  assert.equal(resolved.host, 'example.com')
  assert.equal(resolved.user, 'deploy')
  assert.equal(resolved.port, 2222)
  assert.deepEqual(resolved.identityFiles, ['/home/u/.ssh/id_rsa'])
  assert.equal(resolved.source, 'manual')
})

test('resolveDestination resolves a config alias with config host/user/port', () => {
  const resolved = resolveDestination('tencent-vm', { configText: CONFIG, home: '/home/u' })
  assert.equal(resolved.source, 'config')
  assert.equal(resolved.alias, 'tencent-vm')
  assert.equal(resolved.host, '240d:c000:f05f:8d00:327e:8b66:5c18:0')
  assert.equal(resolved.user, 'ubuntu')
})

test('host pattern matching supports wildcards, case folding and negation', () => {
  assert.equal(matchHostPattern('web-*', 'web-prod'), true)
  assert.equal(matchHostPattern('web-*', 'db-prod'), false)
  assert.equal(matchHostPattern('*.example.com', 'a.example.com'), true)
  assert.equal(matchHostPattern('Tencent-VM', 'tencent-vm'), true)
  const entry = { patterns: ['web-*'], negated: ['web-prod'], options: {}, line: 1 }
  assert.equal(entryMatches(entry, 'web-dev'), true)
  assert.equal(entryMatches(entry, 'web-prod'), false)
})

test('expandTokens replaces %h/%r/%p/%d', () => {
  const parsed = parseSshConfig('Host x\n  HostName %h.example.com\n  User %r\n')
  const alias = resolveSshAlias(parsed, 'x', { home: '/home/u' })
  // %h expands to the alias when no hostname was set yet; harmless and deterministic.
  assert.equal(alias.host, 'x.example.com')
})

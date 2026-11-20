import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverSshAliases, entryMatches, matchHostPattern, parseSshConfig } from '../../dist/src/ssh-config.js'
import { resolveDestination, resolveSshAlias } from '../../dist/src/ssh-config.js'

const CONFIG = `# global defaults
ServerAliveInterval 30
IdentityFile ~/.ssh/id_rsa
Host test-host 192.0.2.10
  HostName 2001:db8::1
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
const parsed = parseSshConfig(CONFIG)

test('parseSshConfig collects options and blocks, and host patterns match wildcards and negation', () => {
  assert.equal(parsed.globals.identityfile[0], '~/.ssh/id_rsa')
  assert.equal(parsed.entries.length, 4, 'test-host, web-*, !web-prod web-*, Host *')
  assert.deepEqual(parsed.entries.find((entry) => entry.negated.length === 1).negated, ['web-prod'])
  assert.deepEqual(parsed.entries.find((entry) => entry.patterns.includes('test-host')).patterns, [
    'test-host',
    '192.0.2.10',
  ])
  // Include/Match are recorded instead of guessed at.
  const included = parseSshConfig(`Include ~/.ssh/other.conf\nMatch exec "true"\n  User x\nHost a\n  User b\n`)
  assert.ok(included.unsupported.some((item) => item.keyword === 'Include'))
  assert.ok(included.unsupported.some((item) => item.keyword === 'Match'))
  assert.equal(resolveSshAlias(included, 'a', { home: '/home/u' }).user, 'b')
})

test('resolveSshAlias applies host blocks, accumulates identity files and expands tokens', () => {
  const alias = resolveSshAlias(parsed, 'test-host', { home: '/home/u' })
  assert.equal(alias.host, '2001:db8::1')
  assert.equal(alias.user, 'ubuntu')
  assert.equal(alias.port, 22)
  assert.deepEqual(alias.identityFiles, ['/home/u/.ssh/id_rsa', '/home/u/.ssh/id_ed25519'])
  assert.equal(alias.source, 'config')
  const web = resolveSshAlias(parsed, 'web-1', { home: '/home/u' })
  assert.equal(web.user, 'deploy', 'first obtained value wins across matching blocks')
  assert.equal(web.port, 2222)
  assert.deepEqual(web.identityFiles, ['/home/u/.ssh/id_rsa', '/home/u/.ssh/deploy_rsa'])
  const tokenized = parseSshConfig('Host x\n  HostName %h.example.com\n  User %r\n')
  assert.equal(resolveSshAlias(tokenized, 'x', { home: '/home/u' }).host, 'x.example.com', 'expandTokens replaces %h')
  const aliases = discoverSshAliases(parsed, { home: '/home/u' }).map((item) => item.alias)
  assert.deepEqual(aliases, ['test-host', '192.0.2.10'])
})

test('resolveDestination keeps literal user/port and inherits global identity files', () => {
  const manual = resolveDestination('deploy@example.com:2222', { configText: CONFIG, home: '/home/u' })
  assert.equal(manual.host, 'example.com')
  assert.equal(manual.user, 'deploy')
  assert.equal(manual.port, 2222)
  assert.deepEqual(manual.identityFiles, ['/home/u/.ssh/id_rsa'])
  assert.equal(manual.source, 'manual')
  const fromConfig = resolveDestination('test-host', { configText: CONFIG, home: '/home/u' })
  assert.equal(fromConfig.source, 'config')
  assert.equal(fromConfig.alias, 'test-host')
  assert.equal(fromConfig.host, '2001:db8::1')
  assert.equal(fromConfig.user, 'ubuntu')
  // Host patterns support wildcards, case folding and a negated match.
  assert.equal(matchHostPattern('web-*', 'web-prod'), true)
  assert.equal(matchHostPattern('web-*', 'db-prod'), false)
  assert.equal(matchHostPattern('*.example.com', 'a.example.com'), true)
  assert.equal(matchHostPattern('Test-Host', 'test-host'), true)
  const entry = { patterns: ['web-*'], negated: ['web-prod'], options: {}, line: 1 }
  assert.equal(entryMatches(entry, 'web-dev'), true)
  assert.equal(entryMatches(entry, 'web-prod'), false)
})

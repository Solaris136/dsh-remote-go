import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions,
  isNodeVersionSupported,
  normalizeVersion,
  parseVersion,
  versionParity,
  versionsEqual,
} from '../../src/version.js'

test('parseVersion accepts DSH and Node version shapes', () => {
  assert.deepEqual(parseVersion('0.2.2-rc.1'), {
    raw: '0.2.2-rc.1',
    major: 0,
    minor: 2,
    patch: 2,
    prerelease: ['rc', 1],
    build: null,
  })
  assert.equal(parseVersion('v24.22.2').major, 24)
  assert.equal(parseVersion('1.2.3+build.5').build, 'build.5')
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion('1.2'), null)
})

test('normalizeVersion strips v and build metadata', () => {
  assert.equal(normalizeVersion('v24.22.2'), '24.22.2')
  assert.equal(normalizeVersion('1.2.3+abc'), '1.2.3')
  assert.equal(normalizeVersion('0.2.2-rc.1'), '0.2.2-rc.1')
})

test('compareVersions follows semver ordering', () => {
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.1'), 0)
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2'), -1)
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.1'), 1)
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('24.9.0', '24.22.2'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1)
})

test('versionsEqual ignores prefixes and build metadata only', () => {
  assert.equal(versionsEqual('v0.2.2-rc.1', '0.2.2-rc.1'), true)
  assert.equal(versionsEqual('1.2.3+a', '1.2.3+b'), true)
  assert.equal(versionsEqual('0.2.2-rc.1', '0.2.2'), false)
})

test('isNodeVersionSupported enforces the DSH node engine floor', () => {
  assert.equal(isNodeVersionSupported('24.9.0'), true)
  assert.equal(isNodeVersionSupported('v24.22.2'), true)
  assert.equal(isNodeVersionSupported('24.8.9'), false)
  assert.equal(isNodeVersionSupported('22.19.0'), false)
  assert.equal(isNodeVersionSupported(null), false)
  assert.equal(isNodeVersionSupported('not-semver'), false)
})

test('versionParity reports same/different/unknown', () => {
  const same = versionParity('0.2.2-rc.1', 'v0.2.2-rc.1')
  assert.equal(same.status, 'same')
  assert.equal(same.same, true)
  assert.match(same.message.zh, /一致/)

  const different = versionParity('0.2.2-rc.1', '0.2.1')
  assert.equal(different.status, 'different')
  assert.equal(different.same, false)
  assert.match(different.message.en, /differs/)

  const unknown = versionParity('0.2.2-rc.1', null)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.same, false)
})

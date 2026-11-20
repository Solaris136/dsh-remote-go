import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isNodeVersionSupported, normalizeVersion } from '../../dist/src/version.js'
import { parseVersion, versionParity, versionsEqual } from '../../dist/src/version.js'

test('parseVersion and normalizeVersion read DSH and Node version shapes', () => {
  const parsed = parseVersion('0.2.2-rc.1')
  assert.deepEqual([parsed.raw, parsed.major, parsed.minor, parsed.patch], ['0.2.2-rc.1', 0, 2, 2])
  assert.deepEqual([parsed.prerelease, parsed.build], [['rc', 1], null])
  assert.deepEqual([parseVersion('v24.22.2').major, parseVersion('1.2.3+build.5').build], [24, 'build.5'])
  for (const bad of ['not-a-version', '1.2']) assert.equal(parseVersion(bad), null, bad)
  assert.deepEqual([normalizeVersion('v24.22.2'), normalizeVersion('1.2.3+abc')], ['24.22.2', '1.2.3'])
  assert.equal(normalizeVersion('0.2.2-rc.1'), '0.2.2-rc.1')
})

test('compareVersions, versionsEqual, the node floor and versionParity agree with semver', () => {
  const cases = [
    ['0.2.2-rc.1', '0.2.2-rc.1', 0],
    ['0.2.2-rc.1', '0.2.2', -1],
    ['0.2.2', '0.2.2-rc.1', 1],
    ['0.2.10', '0.2.9', 1],
    ['24.9.0', '24.22.2', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
  ]
  for (const [left, right, expected] of cases)
    assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`)
  assert.equal(versionsEqual('v0.2.2-rc.1', '0.2.2-rc.1'), true)
  assert.equal(versionsEqual('1.2.3+a', '1.2.3+b'), true)
  assert.equal(versionsEqual('0.2.2-rc.1', '0.2.2'), false)
  assert.equal(isNodeVersionSupported('24.9.0'), true)
  assert.equal(isNodeVersionSupported('v24.22.2'), true)
  assert.equal(isNodeVersionSupported('24.8.9'), false)
  assert.equal(isNodeVersionSupported('22.19.0'), false)
  assert.equal(isNodeVersionSupported(null), false)
  assert.equal(isNodeVersionSupported('not-semver'), false)
  const same = versionParity('0.2.2-rc.1', 'v0.2.2-rc.1')
  assert.deepEqual([same.status, same.same], ['same', true])
  assert.match(same.message.zh, /一致/)
  const different = versionParity('0.2.2-rc.1', '0.2.1')
  assert.deepEqual([different.status, different.same], ['different', false])
  assert.match(different.message.en, /differs/)
  const unknown = versionParity('0.2.2-rc.1', null)
  assert.deepEqual([unknown.status, unknown.same], ['unknown', false])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedRemote, buildPreflightCommand, planNpx, verifyNpxVersion } from '../../src/bootstrap.js'
import { makeFacts } from '../helpers/fake-remote.js'

const TARGET = '0.2.2-rc.1'

test('planNpx builds the one supported launch plan', () => {
  const plan = planNpx({
    facts: makeFacts({ nodePath: '/usr/bin/node', npxPath: '/usr/bin/npx' }),
    targetVersion: TARGET,
    profile: 'web',
  })
  assert.equal(plan.level, 'npx')
  assert.equal(plan.profile, 'web')
  assert.equal(plan.targetVersion, TARGET)
  assert.equal(plan.start.kind, 'npx')
  assert.equal(plan.start.npxPath, '/usr/bin/npx')
  assert.equal(plan.start.nodeBinDir, '/usr/bin')
  assert.equal(plan.start.targetVersion, TARGET)
})

test('planNpx refuses a non-Linux remote', () => {
  assert.throws(
    () => assertSupportedRemote(makeFacts({ os: 'Darwin' })),
    (error) => error.code === 'unsupported-os',
  )
})

test('planNpx refuses an old or missing Node', () => {
  for (const version of ['22.19.0', null]) {
    assert.throws(
      () => planNpx({ facts: makeFacts({ nodeVersion: version }), targetVersion: TARGET, profile: 'web' }),
      (error) => error.code === 'remote-dsh-missing',
    )
  }
})

test('planNpx refuses a remote without npx', () => {
  assert.throws(
    () => planNpx({ facts: makeFacts({ npxPath: null }), targetVersion: TARGET, profile: 'web' }),
    (error) => error.code === 'remote-dsh-missing',
  )
})

test('planNpx refuses a remote without curl', () => {
  assert.throws(
    () => planNpx({ facts: makeFacts({ curlPath: null }), targetVersion: TARGET, profile: 'web' }),
    (error) => error.code === 'remote-dsh-missing',
  )
})

test('planNpx refuses an invalid target version', () => {
  assert.throws(
    () => planNpx({ facts: makeFacts(), targetVersion: 'not-a-version', profile: 'web' }),
    (error) => error.code === 'invalid-input',
  )
})

test('buildPreflightCommand pins the exact package and prefixes PATH', () => {
  const plan = planNpx({
    facts: makeFacts({ nodePath: '/opt/node/bin/node', npxPath: '/opt/node/bin/npx' }),
    targetVersion: TARGET,
    profile: 'web',
  })
  const command = buildPreflightCommand(plan)
  assert.match(command, /@deepseek-ai\/dsh@0\.2\.2-rc\.1/)
  assert.match(command, /--version/)
  assert.match(command, /PATH='\/opt\/node\/bin':"\$PATH"/)
})

test('verifyNpxVersion accepts the exact version and warms the cache', async () => {
  const calls = []
  const ssh = {
    async exec(command, options) {
      calls.push({ command, options })
      return { code: 0, stdout: '0.2.2-rc.1\n', stderr: '' }
    },
  }
  const plan = planNpx({ facts: makeFacts(), targetVersion: TARGET, profile: 'web' })
  assert.equal(await verifyNpxVersion(ssh, plan, { timeoutMs: 1234 }), TARGET)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.timeoutMs, 1234)
})

test('verifyNpxVersion reports a different version as version-mismatch', async () => {
  const ssh = {
    async exec() {
      return { code: 0, stdout: '0.2.1\n', stderr: '' }
    },
  }
  const plan = planNpx({ facts: makeFacts(), targetVersion: TARGET, profile: 'web' })
  await assert.rejects(
    () => verifyNpxVersion(ssh, plan),
    (error) => error.code === 'version-mismatch',
  )
})

test('verifyNpxVersion turns a failed npx run into remote-dsh-missing', async () => {
  const ssh = {
    async exec() {
      return { code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found' }
    },
  }
  const plan = planNpx({ facts: makeFacts(), targetVersion: TARGET, profile: 'web' })
  await assert.rejects(
    () => verifyNpxVersion(ssh, plan),
    (error) => error.code === 'remote-dsh-missing' && error.technical.includes('404'),
  )
})

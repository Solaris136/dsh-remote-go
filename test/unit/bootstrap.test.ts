import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedRemote, buildPreflightCommand, planNpx, verifyNpxVersion } from '../../dist/src/bootstrap.js'
import { makeFacts } from '../helpers/fake-remote.ts'

const TARGET = '0.2.2-rc.1'
/** The launch plan for a remote whose facts differ from the default only in `overrides`. */
const planFor = (overrides = {}) => planNpx({ facts: makeFacts(overrides), targetVersion: TARGET, profile: 'web' })
/** assert.throws matcher: the plan refused with exactly this `code`. */
const coded = (code) => (error) => error.code === code
/** A transport whose single `exec` answers through `reply(command, options)`. */
const fakeSsh = (reply) => ({ exec: async (command, options) => reply(command, options) })

test('planNpx builds the one supported launch plan', () => {
  const plan = planFor({ nodePath: '/usr/bin/node', npxPath: '/usr/bin/npx' })
  assert.equal(plan.level, 'npx')
  assert.equal(plan.profile, 'web')
  assert.equal(plan.targetVersion, TARGET)
  assert.equal(plan.start.kind, 'npx')
  assert.equal(plan.start.npxPath, '/usr/bin/npx')
  assert.equal(plan.start.nodeBinDir, '/usr/bin')
  assert.equal(plan.start.targetVersion, TARGET)
})
// One planner call per row: only the facts (or the target) that make it refuse differ.
const refusals = [
  ['planNpx refuses a non-Linux remote', () => assertSupportedRemote(makeFacts({ os: 'Darwin' })), 'unsupported-os'],
  ['planNpx refuses a remote without npx', () => planFor({ npxPath: null }), 'remote-dsh-missing'],
  [
    'planNpx refuses a remote without curl or wget',
    () => planFor({ curlPath: null, wgetPath: null }),
    'remote-dsh-missing',
  ],
  [
    'planNpx refuses an invalid target version',
    () => planNpx({ facts: makeFacts(), targetVersion: 'not-a-version', profile: 'web' }),
    'invalid-input',
  ],
]
for (const [name, run, code] of refusals) test(name, () => assert.throws(run, coded(code)))

test('planNpx refuses an old or missing Node', () => {
  for (const nodeVersion of ['22.19.0', null])
    assert.throws(() => planFor({ nodeVersion }), coded('remote-dsh-missing'))
})

test('planNpx accepts a remote with wget but no curl', () => {
  assert.equal(planFor({ curlPath: null, wgetPath: '/usr/bin/wget' }).level, 'npx')
})

test('buildPreflightCommand pins the exact package, prefixes PATH and streams npm output', () => {
  const command = buildPreflightCommand(planFor({ nodePath: '/opt/node/bin/node', npxPath: '/opt/node/bin/npx' }))
  assert.match(command, /@deepseek-ai\/dsh@0\.2\.2-rc\.1/)
  assert.match(command, /--version/)
  assert.match(command, /PATH='\/opt\/node\/bin':"\$PATH"/)
  assert.match(command, /npm_config_loglevel=http/)
})

test('verifyNpxVersion accepts the exact version, streams output and sets no deadline', async () => {
  const calls = []
  const ssh = fakeSsh((command, options) => {
    calls.push({ command, options })
    options.onStdout('0.2.2-rc.1\n')
    options.onStderr('npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh\n')
    return { code: 0, stdout: '0.2.2-rc.1\n', stderr: '' }
  })
  const stdout = []
  const stderr = []
  const version = await verifyNpxVersion(ssh, planFor(), {
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => stderr.push(chunk),
  })
  assert.equal(version, TARGET)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.timeoutMs, 0)
  assert.equal(stdout.join(''), '0.2.2-rc.1\n')
  assert.match(stderr.join(''), /http fetch/)
})

test('verifyNpxVersion reports a different version as version-mismatch', async () => {
  const ssh = fakeSsh(() => ({ code: 0, stdout: '0.2.1\n', stderr: '' }))
  await assert.rejects(() => verifyNpxVersion(ssh, planFor()), coded('version-mismatch'))
})

test('verifyNpxVersion turns a failed npx run into remote-dsh-missing', async () => {
  const ssh = fakeSsh(() => ({ code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found' }))
  await assert.rejects(
    () => verifyNpxVersion(ssh, planFor()),
    (error) => error.code === 'remote-dsh-missing' && error.technical.includes('404'),
  )
})

test('a preflight that runs out of time is a network failure, not a missing DSH', async () => {
  const ssh = fakeSsh(() => ({ code: null, stdout: '', stderr: '', timedOut: true }))
  await assert.rejects(
    () => verifyNpxVersion(ssh, planFor(), { timeoutMs: 90_000 }),
    (error) => error.code === 'network' && error.retryable === true && /preflight-timeout/.test(error.technical ?? ''),
  )
})

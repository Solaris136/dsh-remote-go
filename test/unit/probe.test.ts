import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProbeScript, parseProbeOutput, probeRemote, toProbeFacts } from '../../dist/src/probe.js'
/** The probe line set the script prints, narrowed to the keys this suite reads. */
const PROBE_OUTPUT = {
  os: 'Linux',
  node_path: '/usr/bin/node',
  node_version: 'v24.22.2',
  npx_path: '/usr/bin/npx',
  curl_path: '/usr/bin/curl',
  wget_path: '/usr/bin/wget',
  libc: 'glibc',
  glibc_version: '2.39',
  disk_free_kb: '35000000',
  ssh_connection: 'yes',
  credentials_file: 'yes',
  provider_env_keys: 'DEEPSEEK,OPENCODE_GO',
}

test('buildProbeScript emits every fact line', () => {
  const script = buildProbeScript()
  for (const marker of [
    'os\t',
    'arch\t',
    'node_path\t',
    'node_version\t',
    'npm_path\t',
    'npx_path\t',
    'curl_path\t',
    'wget_path\t',
    'libc\t',
    'glibc_version\t',
    'disk_free_kb\t',
    'ssh_connection\t',
    'credentials_file\t',
    'provider_env_keys\t',
  ]) {
    assert.ok(script.includes(marker), `missing marker ${marker}`)
  }
})

test('parseProbeOutput keeps values containing spaces and tabs', () => {
  const values = parseProbeOutput('os\tLinux\nos_name\tUbuntu 24.04.1 LTS\nnote\ta\tb\nmalformed-no-tab\n')
  assert.deepEqual([values.os, values.note], ['Linux', 'a\tb'])
  assert.equal(values.os_name, 'Ubuntu 24.04.1 LTS')
  assert.equal(values['malformed-no-tab'], undefined)
})

test('toProbeFacts normalizes versions, reads the runtime facts and tolerates missing fields', () => {
  const facts = toProbeFacts(PROBE_OUTPUT)
  assert.deepEqual([facts.nodePath, facts.npxPath], ['/usr/bin/node', '/usr/bin/npx'])
  assert.deepEqual([facts.curlPath, facts.wgetPath], ['/usr/bin/curl', '/usr/bin/wget'])
  assert.deepEqual([facts.nodeVersion, facts.glibcVersion], ['24.22.2', '2.39'])
  assert.deepEqual([facts.libc, facts.diskFreeKb], ['glibc', 35_000_000])
  assert.deepEqual([facts.sshConnection, facts.credentialsFile], [true, true])
  assert.deepEqual(facts.providerEnvKeys, ['DEEPSEEK', 'OPENCODE_GO'])
  const missing = toProbeFacts({ os: 'Linux', disk_free_kb: 'nope' })
  assert.equal(missing.diskFreeKb, null)
  assert.deepEqual([missing.nodeVersion, missing.npxPath, missing.glibcVersion], [null, null, null])
  assert.deepEqual(missing.providerEnvKeys, [])
})

test('probeRemote parses a successful exec and throws on failure', async () => {
  const ssh = {
    async exec() {
      return { code: 0, stdout: 'os\tLinux\narch\tx86_64\nnode_version\tv24.22.2\n', stderr: '' }
    },
  }
  const facts = await probeRemote(ssh)
  assert.deepEqual([facts.os, facts.nodeVersion], ['Linux', '24.22.2'])
  const failing = {
    async exec() {
      return { code: 2, stdout: '', stderr: 'permission denied' }
    },
  }
  await assert.rejects(
    () => probeRemote(failing),
    (error) => error.code === 'remote-dsh-missing',
  )
  // A probe that runs out of time is a network failure, not a missing DSH.
  const slow = {
    async exec() {
      return { code: null, stdout: '', stderr: '', timedOut: true }
    },
  }
  const timedOut = (error) =>
    error.code === 'network' && error.retryable === true && /probe-timeout/.test(error.technical ?? '')
  await assert.rejects(() => probeRemote(slow, { timeoutMs: 1_500 }), timedOut)
})

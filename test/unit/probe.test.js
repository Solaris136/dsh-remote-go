import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProbeScript,
  describeProbeCapabilities,
  parseProbeOutput,
  probeRemote,
  toProbeFacts,
} from '../../src/probe.js'
import { makeFacts } from '../helpers/fake-remote.js'

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
  assert.equal(values.os, 'Linux')
  assert.equal(values.os_name, 'Ubuntu 24.04.1 LTS')
  assert.equal(values.note, 'a\tb')
  assert.equal(values['malformed-no-tab'], undefined)
})

test('toProbeFacts normalizes versions and reads the runtime facts', () => {
  const facts = toProbeFacts({
    os: 'Linux',
    arch: 'x86_64',
    node_path: '/usr/bin/node',
    node_version: 'v24.22.2',
    npm_path: '/usr/bin/npm',
    npx_path: '/usr/bin/npx',
    curl_path: '/usr/bin/curl',
    wget_path: '/usr/bin/wget',
    libc: 'glibc',
    glibc_version: '2.39',
    disk_free_kb: '35000000',
    ssh_connection: 'yes',
    credentials_file: 'yes',
    provider_env_keys: 'DEEPSEEK,OPENCODE_GO',
  })
  assert.equal(facts.nodePath, '/usr/bin/node')
  assert.equal(facts.nodeVersion, '24.22.2')
  assert.equal(facts.npxPath, '/usr/bin/npx')
  assert.equal(facts.curlPath, '/usr/bin/curl')
  assert.equal(facts.wgetPath, '/usr/bin/wget')
  assert.equal(facts.libc, 'glibc')
  assert.equal(facts.glibcVersion, '2.39')
  assert.equal(facts.diskFreeKb, 35_000_000)
  assert.equal(facts.sshConnection, true)
  assert.equal(facts.credentialsFile, true)
  assert.deepEqual(facts.providerEnvKeys, ['DEEPSEEK', 'OPENCODE_GO'])
})

test('toProbeFacts tolerates missing/invalid fields', () => {
  const facts = toProbeFacts({ os: 'Linux', disk_free_kb: 'nope' })
  assert.equal(facts.diskFreeKb, null)
  assert.equal(facts.nodeVersion, null)
  assert.equal(facts.npxPath, null)
  assert.equal(facts.glibcVersion, null)
  assert.deepEqual(facts.providerEnvKeys, [])
})

test('probeRemote parses a successful exec and throws on failure', async () => {
  const ssh = {
    calls: [],
    async exec(command, options) {
      this.calls.push(command)
      if (command.includes('fail-marker')) return { code: 1, stdout: '', stderr: 'boom' }
      return { code: 0, stdout: 'os\tLinux\narch\tx86_64\nnode_version\tv24.22.2\n', stderr: '' }
    },
  }
  const facts = await probeRemote(ssh)
  assert.equal(facts.os, 'Linux')
  assert.equal(facts.nodeVersion, '24.22.2')

  const failing = {
    async exec() {
      return { code: 2, stdout: '', stderr: 'permission denied' }
    },
  }
  await assert.rejects(
    () => probeRemote(failing),
    (error) => error.code === 'remote-dsh-missing',
  )
})

test('describeProbeCapabilities reports support and credentials', () => {
  const capabilities = describeProbeCapabilities(
    makeFacts({
      nodeVersion: '22.19.0',
      npxPath: null,
      credentialsFile: false,
      deepseekKeyEnv: false,
      providerEnvKeys: [],
    }),
  )
  assert.equal(capabilities.system.supported, true)
  assert.equal(capabilities.node.supported, false)
  assert.equal(capabilities.npx.available, false)
  assert.equal(capabilities.modelCredentials.credentialsFile, false)
})

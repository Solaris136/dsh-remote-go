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

test('buildProbeScript emits every fact line and quotes the remote dir', () => {
  const script = buildProbeScript("~/.dsh/it's")
  for (const marker of [
    'os\t',
    'arch\t',
    'node_version\t',
    'npm_path\t',
    'npx_path\t',
    'dsh_version\t',
    'curl_path\t',
    'disk_free_kb\t',
    'ssh_connection\t',
    'run_registry\t',
  ]) {
    assert.ok(script.includes(marker), `missing marker ${marker}`)
  }
  // Single quote inside the dir must be shell-quoted, not break out.
  assert.ok(script.includes("it'\\''s"))
})

test('parseProbeOutput keeps values containing spaces and tabs', () => {
  const values = parseProbeOutput('os\tLinux\nos_name\tUbuntu 24.04.1 LTS\nnote\ta\tb\nmalformed-no-tab\n')
  assert.equal(values.os, 'Linux')
  assert.equal(values.os_name, 'Ubuntu 24.04.1 LTS')
  assert.equal(values.note, 'a\tb')
  assert.equal(values['malformed-no-tab'], undefined)
})

test('toProbeFacts normalizes versions and parses the run registry', () => {
  const facts = toProbeFacts({
    os: 'Linux',
    arch: 'x86_64',
    node_version: 'v24.22.2',
    npm_version: '11.19.1',
    isolated_node_version: 'v24.22.2',
    isolated_dsh_version: '0.2.2-rc.1',
    disk_free_kb: '35000000',
    ssh_connection: 'yes',
    credentials_file: 'yes',
    provider_env_keys: 'DEEPSEEK,OPENCODE_GO',
    run_registry: '{"pid":42,"port":38123}',
  })
  assert.equal(facts.nodeVersion, '24.22.2')
  assert.equal(facts.npmVersion, '11.19.1')
  assert.equal(facts.isolatedDshVersion, '0.2.2-rc.1')
  assert.equal(facts.diskFreeKb, 35_000_000)
  assert.equal(facts.sshConnection, true)
  assert.equal(facts.credentialsFile, true)
  assert.deepEqual(facts.providerEnvKeys, ['DEEPSEEK', 'OPENCODE_GO'])
  assert.deepEqual(facts.runRegistry, { pid: 42, port: 38123 })
})

test('toProbeFacts tolerates missing/invalid fields', () => {
  const facts = toProbeFacts({ os: 'Linux', disk_free_kb: 'nope', run_registry: 'not-json' })
  assert.equal(facts.diskFreeKb, null)
  assert.equal(facts.runRegistry, null)
  assert.equal(facts.nodeVersion, null)
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
  const facts = await probeRemote(ssh, { remoteDir: '~/.dsh-remote-go' })
  assert.equal(facts.os, 'Linux')
  assert.equal(facts.nodeVersion, '24.22.2')

  const failing = {
    async exec() {
      return { code: 2, stdout: '', stderr: 'permission denied' }
    },
  }
  await assert.rejects(
    () => probeRemote(failing, { remoteDir: '~/x' }),
    (error) => error.code === 'remote-dsh-missing',
  )
})

test('describeProbeCapabilities reports support and credentials', () => {
  const capabilities = describeProbeCapabilities(
    makeFacts({
      nodeVersion: '22.19.0',
      dshVersion: '0.2.2-rc.1',
      credentialsFile: false,
      deepseekKeyEnv: false,
      providerEnvKeys: [],
    }),
  )
  assert.equal(capabilities.system.supported, true)
  assert.equal(capabilities.node.supported, false)
  assert.equal(capabilities.dsh.version, '0.2.2-rc.1')
  assert.equal(capabilities.modelCredentials.credentialsFile, false)
})

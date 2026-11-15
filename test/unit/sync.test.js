/**
 * Sync planning and merge rules: plugin/row/credential classification, patch merging,
 * the plan hash and the credential document merge.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { load } from '../../vendor/yaml.bundle.mjs'
import { createHostRuntime } from '../../src/host-runtime.js'
import { hostView } from '../../src/host-view.js'
import { sanitizeHostEntry } from '../../src/settings.js'
import { mergeCredentialsText } from '../../src/sync-credentials.js'
import { parseCredentialsYaml, parseRowsYaml } from '../../src/sync-local.js'
import { isPortableRow, isRegistrySpec, mergePatchRows, planHash, planHasWork, planSync } from '../../src/sync-plan.js'
import {
  buildSnapshotCommand,
  buildWriteFileCommand,
  parseSnapshotOutput,
  snapshotFiles,
} from '../../src/sync-remote.js'
import { applySync, prepareSync } from '../../src/sync-run.js'
import { satisfiesRange } from '../../src/version.js'

function localSnapshot(overrides = {}) {
  return {
    home: '/home/me/.dsh',
    profileDir: '/home/me/.dsh/profiles/desktop',
    packageJson: { dependencies: {}, dsh: { profile: { bundles: [] } } },
    rows: [],
    rowsError: null,
    credentials: { refs: {}, records: {} },
    credentialsError: null,
    manifests: {},
    env: {},
    ...overrides,
  }
}

const REMOTE_EMPTY = { packageJson: null, rows: [], rowsError: null, credentialsText: '', state: null }

const PLUGIN_OPTIONS = {
  plugins: true,
  credentials: false,
  remoteArch: 'x86_64',
  remoteVersion: '0.2.2-rc.3',
  nodeVersion: '24.21.0',
}

test('registry specs are the only package specs a remote install accepts', () => {
  for (const spec of ['0.9.43', '^0.9.0', '~1.2.3', '>=2.0.0', 'latest', '*']) {
    assert.equal(isRegistrySpec(spec), true, spec)
  }
  for (const spec of ['link:../plugin', 'file:./x.tgz', 'git+https://example.com/x.git', 'npm:alias@1.0.0', '']) {
    assert.equal(isRegistrySpec(spec), false, spec)
  }
})

test('rows that point at a local executable or a Windows path are not portable', () => {
  assert.equal(isPortableRow({ id: 'a', config: { url: 'https://example.com', n: 2 } }), true)
  assert.equal(isPortableRow({ id: 'a', config: { command: 'C:\\tools\\python.exe' } }), false)
  assert.equal(isPortableRow({ id: 'a', config: { args: ['--exe', 'C:\\x\\y.exe'] } }), false)
  assert.equal(isPortableRow({ id: 'a', config: { command: 'pythonw.exe' } }), false)
  assert.equal(isPortableRow({ id: 'a', config: { path: '\\\\wsl$\\Ubuntu\\bin' } }), false)
})

test('plugins: registry installs are planned, local and denied ones are skipped', () => {
  const local = localSnapshot({
    packageJson: {
      dependencies: {
        'dsh-free-search': '0.9.43',
        'dsh-remote-go': 'link:..',
        'dsh-windows-mcp': '0.2.8',
        '@deepseek-ai/dsh-base': '0.2.2-rc.3',
        'local-tool': 'link:../local-tool',
        'win-only': '1.0.0',
        'old-engine': '1.0.0',
      },
      dsh: { profile: { bundles: [] } },
    },
    manifests: {
      'dsh-free-search': { name: 'dsh-free-search', version: '0.9.43' },
      'dsh-remote-go': { name: 'dsh-remote-go', version: '0.1.0' },
      'dsh-windows-mcp': { name: 'dsh-windows-mcp', version: '0.2.8' },
      '@deepseek-ai/dsh-base': { name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.3' },
      'local-tool': { name: 'local-tool', version: '0.0.1' },
      'win-only': { name: 'win-only', version: '1.0.0', os: ['win32'] },
      'old-engine': { name: 'old-engine', version: '1.0.0', engines: { dsh: '>=9.0.0' } },
    },
  })
  const plan = planSync(local, REMOTE_EMPTY, PLUGIN_OPTIONS)
  const byName = Object.fromEntries(plan.plugins.map((entry) => [entry.name, entry]))
  assert.equal(byName['dsh-free-search'].action, 'add')
  assert.equal(byName['dsh-free-search'].version, '0.9.43')
  assert.equal(byName['dsh-remote-go'].reason, 'denied')
  assert.equal(byName['dsh-windows-mcp'].reason, 'denied')
  assert.equal(byName['@deepseek-ai/dsh-base'].reason, 'built-in')
  assert.equal(byName['local-tool'].reason, 'not-registry')
  assert.equal(byName['win-only'].reason, 'platform')
  assert.equal(byName['old-engine'].reason, 'engines')
  assert.equal(plan.counts.pluginsAdd, 1)
})

test('an already installed plugin at the same version is kept, not reinstalled', () => {
  const local = localSnapshot({
    packageJson: { dependencies: { 'dsh-free-search': '0.9.43' } },
    manifests: { 'dsh-free-search': { name: 'dsh-free-search', version: '0.9.43' } },
  })
  const remote = {
    ...REMOTE_EMPTY,
    packageJson: { dependencies: { 'dsh-free-search': '0.9.43' }, dsh: { profile: { bundles: [] } } },
  }
  const plan = planSync(local, remote, PLUGIN_OPTIONS)
  assert.equal(plan.plugins[0].action, 'keep')
  assert.equal(planHasWork(plan), false)
})

test('config rows: plugin-owned rows replace in place, inserts and local paths are skipped', () => {
  const local = localSnapshot({
    packageJson: { dependencies: { 'dsh-free-search': '0.9.43' } },
    manifests: { 'dsh-free-search': { name: 'dsh-free-search', version: '0.9.43' } },
    rows: [
      { id: 'web-search-free', name: 'dsh-free-search', config: { bingMarket: 'zh-CN' } },
      { id: 'fresh-row', name: 'dsh-free-search', config: { disabledEngines: [] } },
      { insert: [{ id: 'mcp-godot', name: 'x' }] },
      { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'standard' } },
      { id: 'win-row', name: 'dsh-free-search', config: { command: 'C:\\tools\\python.exe' } },
    ],
  })
  const remote = { ...REMOTE_EMPTY, rows: [{ id: 'web-search-free', name: 'dsh-free-search', config: { old: 1 } }] }
  const plan = planSync(local, remote, PLUGIN_OPTIONS)
  const byId = Object.fromEntries(plan.rows.entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]))
  assert.equal(byId['web-search-free'].action, 'replace')
  assert.equal(byId['fresh-row'].action, 'append')
  assert.equal(byId['ui-chat'].reason, 'not-selected')
  assert.equal(byId['win-row'].reason, 'local-path')
  assert.equal(plan.rows.entries.filter((entry) => entry.reason === 'insert').length, 1)
})

test('credential refs come from the local store and the launching environment', () => {
  const local = localSnapshot({
    rows: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { apiKeyEnv: 'FROM_ENV' } }],
    credentials: {
      refs: { OPENCODE_GO_API_KEY: 'sk-local', EMPTY: '' },
      records: {
        'llm-pi-ai/openai': { kind: 'grant', payload: { token: 't' } },
        'client-connection/browser-session': { kind: 'grant', payload: {} },
        'broken/record': { kind: 'grant' },
      },
    },
    env: { FROM_ENV: 'sk-env' },
  })
  const plan = planSync(local, REMOTE_EMPTY, { ...PLUGIN_OPTIONS, credentials: true, plugins: false })
  const names = plan.credentials.refs.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['FROM_ENV', 'OPENCODE_GO_API_KEY'])
  assert.equal(plan.credentials.refs.find((entry) => entry.name === 'FROM_ENV').value, 'sk-env')
  assert.deepEqual(
    plan.credentials.records.map((entry) => entry.key),
    ['llm-pi-ai/openai'],
  )
  const skipped = plan.credentials.skipped.map((entry) => [entry.name, entry.reason])
  assert.ok(skipped.some(([name, reason]) => name === 'EMPTY' && reason === 'empty'))
  assert.ok(skipped.some(([name, reason]) => name === 'client-connection/browser-session' && reason === 'local-only'))
  assert.ok(skipped.some(([name, reason]) => name === 'broken/record' && reason === 'invalid'))
})

test('a provider row is selected by the credential it references', () => {
  const local = localSnapshot({
    credentials: { refs: { OPENCODE_GO_API_KEY: 'sk-local' }, records: {} },
    rows: [
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { apiKeyEnv: 'OPENCODE_GO_API_KEY' } },
      { id: 'other', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'ddg' } },
    ],
  })
  const plan = planSync(local, REMOTE_EMPTY, { ...PLUGIN_OPTIONS, credentials: true, plugins: false })
  const ids = plan.rows.entries.filter((entry) => entry.action !== 'skip').map((entry) => entry.id)
  assert.deepEqual(ids, ['llm-pi-ai'])
})

test('mergePatchRows replaces a matching id and appends the rest', () => {
  const merged = mergePatchRows(
    [{ id: 'a', config: { old: 1 } }, { insert: [{ id: 'mcp' }] }],
    [
      { id: 'a', action: 'replace', row: { id: 'a', config: { next: 2 } } },
      { id: 'b', action: 'append', row: { id: 'b', config: { n: 1 } } },
      { id: 'c', action: 'skip', row: { id: 'c' } },
    ],
  )
  assert.equal(merged.replaced, 1)
  assert.equal(merged.appended, 1)
  assert.equal(merged.rows.length, 3)
  assert.deepEqual(merged.rows[0], { id: 'a', config: { next: 2 } })
  assert.deepEqual(merged.rows[2], { id: 'b', config: { n: 1 } })
})

test('the plan hash is stable and changes with a secret value', () => {
  const local = localSnapshot({
    credentials: { refs: { KEY: 'sk-a' }, records: {} },
    rows: [{ id: 'r1', name: 'p', config: { apiKeyEnv: 'KEY' } }],
  })
  const options = { ...PLUGIN_OPTIONS, credentials: true, plugins: false }
  const first = planHash(planSync(local, REMOTE_EMPTY, options))
  const second = planHash(planSync(local, REMOTE_EMPTY, options))
  assert.equal(first, second)
  const rotated = planHash(
    planSync(localSnapshot({ ...local, credentials: { refs: { KEY: 'sk-b' }, records: {} } }), REMOTE_EMPTY, options),
  )
  assert.notEqual(first, rotated)
})

test('credential merge keeps remote-only entries, updates shared refs and never replaces a record', () => {
  const remote = [
    'version: 1',
    'refs:',
    '  OTHER: keep-me',
    'records:',
    '  other/one:',
    '    kind: grant',
    '    payload:',
    '      token: keep-me',
    'x-unknown:',
    '  note: kept',
    '',
  ].join('\n')
  const result = mergeCredentialsText(
    remote,
    {
      refs: [
        { name: 'OPENCODE_GO_API_KEY', value: 'sk-new' },
        { name: 'OTHER', value: 'local-wins' },
      ],
      records: [
        { key: 'llm-pi-ai/x', kind: 'grant', payload: { token: 't' } },
        { key: 'other/one', kind: 'grant', payload: { token: 'replaced?' } },
      ],
    },
    { at: '2026-11-15T00:00:00.000Z' },
  )
  const document = load(result.text)
  assert.equal(document.refs.OPENCODE_GO_API_KEY, 'sk-new')
  assert.equal(document.refs.OTHER, 'local-wins')
  assert.deepEqual(document.records['llm-pi-ai/x'], { kind: 'grant', payload: { token: 't' } })
  assert.deepEqual(document.records['other/one'], { kind: 'grant', payload: { token: 'keep-me' } })
  assert.deepEqual(document['x-unknown'], { note: 'kept' })
  assert.deepEqual(result.counts, {
    addedRefs: 1,
    updatedRefs: 1,
    keptRefs: 0,
    addedRecords: 1,
    keptRecords: 1,
  })
  assert.match(result.text, /^# dsh-remote-go sync:/)
})

test('a malformed remote credential document is refused instead of overwritten', () => {
  assert.throws(() => mergeCredentialsText('- not-a-map\n', { refs: [], records: [] }), /not a mapping/)
})

test('local patch and credential parsers degrade to a typed reason', () => {
  assert.deepEqual(parseRowsYaml(''), { rows: [], error: null })
  assert.deepEqual(parseRowsYaml('[]'), { rows: [], error: null })
  assert.equal(parseRowsYaml('id: not-a-list').error, 'not-a-list')
  assert.equal(parseRowsYaml('a: [unclosed').error, 'unparsable')
  assert.equal(parseCredentialsYaml('version: 1\nrefs: {}\n').error, null)
  assert.equal(parseCredentialsYaml('nope').error, 'not-a-map')
})

test('the remote snapshot splits back into one text per file', () => {
  const files = ['profiles/web/package.json', '.credentials.yaml']
  const stdout = buildSnapshotExample(files)
  const parsed = parseSnapshotOutput(stdout, files)
  assert.equal(parsed[files[0]], '{"dependencies":{}}')
  assert.equal(parsed[files[1]], 'version: 1')
})

function buildSnapshotExample(files) {
  return [
    `@@dsh-remote-go:${files[0]}@@`,
    '{"dependencies":{}}',
    '',
    `@@dsh-remote-go:${files[1]}@@`,
    'version: 1',
    '',
  ].join('\n')
}

test('write commands quote the destination and never put content on the command line', () => {
  const command = buildWriteFileCommand("/home/me/.dsh/it's a file", '600')
  assert.match(command, /chmod 600/)
  assert.match(command, /TARGET='\/home\/me\/\.dsh\/it'\\''s a file'/)
  assert.doesNotMatch(command, /sk-/)
})

test('the snapshot command marks every requested file', () => {
  const command = buildSnapshotCommand({ home: '/home/me/.dsh', files: ['a', 'b'] })
  assert.match(command, /@@dsh-remote-go:a@@/)
  assert.match(command, /@@dsh-remote-go:b@@/)
  assert.match(command, /cat '\/home\/me\/\.dsh\/a'/)
})

test('host entries carry the two sync opt-ins and default them off', () => {
  const base = { name: 'srv', address: 'example.com', auth: { type: 'key', keyPath: '~/.ssh/id_rsa' } }
  const first = sanitizeHostEntry(base, { settings: undefined })
  assert.deepEqual(first.sync, { credentials: false, plugins: false })
  const enabled = sanitizeHostEntry({ ...base, sync: { credentials: true } }, { settings: undefined })
  assert.deepEqual(enabled.sync, { credentials: true, plugins: false })
  const omitted = sanitizeHostEntry({ name: 'srv', address: 'example.com' }, { settings: undefined, existing: enabled })
  assert.deepEqual(omitted.sync, { credentials: true, plugins: false })
})

test('HostView exposes the sync state and the two opt-ins', () => {
  const runtime = createHostRuntime({
    id: 'h_1',
    name: 'srv',
    address: 'example.com',
    port: 22,
    auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
    keepAlive: 'keep',
    idleMinutes: 15,
    autoReconnect: true,
    hostKeyPolicy: 'first-use',
    sync: { credentials: true, plugins: false },
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  })
  const view = hostView(runtime, { passwordStorageAvailable: false, targetVersion: '0.2.2-rc.3' })
  assert.equal(view.sync.enabled, true)
  assert.equal(view.sync.credentials, true)
  assert.equal(view.sync.plugins, false)
  assert.equal(view.sync.status, 'idle')
})

test('plugin engine ranges use a small semver range check', () => {
  assert.equal(satisfiesRange('>=0.2.2-rc.3', '0.2.2-rc.3'), true)
  assert.equal(satisfiesRange('>=0.2.2-rc.3', '0.2.1'), false)
  assert.equal(satisfiesRange('>=24.9.0', '24.21.0'), true)
  assert.equal(satisfiesRange('^1.2.3', '1.9.0'), true)
  assert.equal(satisfiesRange('^1.2.3', '2.0.0'), false)
  assert.equal(satisfiesRange('~1.2.3', '1.3.0'), false)
  assert.equal(satisfiesRange('>=1 <3', '2.4.0'), true)
  assert.equal(satisfiesRange('>=9', '1.0.0'), false)
})

async function localFixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'drg-sync-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {}, dsh: { profile: { bundles: [] } } }),
  )
  await writeFile(
    path.join(profileDir, 'cordis.patch.yml'),
    '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    apiKeyEnv: OPENCODE_GO_API_KEY\n',
  )
  await writeFile(
    path.join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  OPENCODE_GO_API_KEY: sk-test\nrecords: {}\n',
  )
  return { home, profileDir }
}

function remoteSnapshotText() {
  const files = snapshotFiles('web')
  return [
    `@@dsh-remote-go:${files[0]}@@`,
    '{"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}',
    '',
    `@@dsh-remote-go:${files[1]}@@`,
    '[]',
    '',
    `@@dsh-remote-go:${files[2]}@@`,
    'version: 1',
    'refs:',
    '  OTHER: keep',
    'records: {}',
    '',
    `@@dsh-remote-go:${files[3]}@@`,
    '',
    '',
  ].join('\n')
}

function fakeSsh(options = {}) {
  const ssh = {
    commands: [],
    writes: [],
    async exec(command, execOptions = {}) {
      ssh.commands.push(command)
      if (command.includes('@@dsh-remote-go:')) return { code: 0, stdout: remoteSnapshotText(), stderr: '' }
      if (command.includes('tar -xzf')) return { code: 0, stdout: 'RESTORED\n', stderr: '' }
      if (command.includes('tar -czf')) return { code: 0, stdout: 'BACKED-UP\n', stderr: '' }
      if (command.includes('cat > "$TMP"')) {
        ssh.writes.push({ command, stdin: String(execOptions.stdin ?? '') })
        return { code: 0, stdout: 'WROTE\n', stderr: '' }
      }
      if (command.includes('--dump-config')) {
        return options.dumpFails
          ? { code: 1, stdout: '', stderr: 'dump failed' }
          : { code: 0, stdout: '[]\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return ssh
}

function syncContext({ home, profileDir }) {
  return {
    home,
    localProfileDir: profileDir,
    settings: () => ({ bootstrap: { profile: 'web' } }),
    localVersion: () => '0.2.2-rc.3',
    emitState: () => {},
    progress: { log: () => {}, phase: () => {} },
  }
}

function syncRuntime(ssh) {
  const runtime = createHostRuntime({
    id: 'h_sync',
    name: 'srv',
    address: 'example.com',
    port: 22,
    auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
    keepAlive: 'keep',
    idleMinutes: 15,
    autoReconnect: true,
    hostKeyPolicy: 'first-use',
    sync: { credentials: true, plugins: false },
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  })
  runtime.ssh = ssh
  runtime.facts = { home: '/home/me', arch: 'x86_64', nodeVersion: '24.21.0' }
  return runtime
}

test('a sync writes credentials, the config rows and the plan hash', async () => {
  const { home, profileDir } = await localFixture()
  const ssh = fakeSsh()
  const ctx = syncContext({ home, profileDir })
  const runtime = syncRuntime(ssh)
  const prepared = await prepareSync(ctx, runtime)
  assert.equal(prepared.plan.counts.rowsApply, 1)
  assert.equal(prepared.plan.counts.refs, 1)
  runtime.forceSync = true
  await applySync(ctx, runtime, prepared)
  assert.equal(runtime.sync.status, 'applied')

  const credentialWrite = ssh.writes.find((entry) => entry.command.includes('.credentials.yaml'))
  assert.ok(credentialWrite, 'the credential document is written')
  assert.match(credentialWrite.stdin, /OPENCODE_GO_API_KEY: sk-test/)
  assert.match(credentialWrite.stdin, /OTHER: keep/)

  const patchWrite = ssh.writes.find((entry) => entry.command.includes('cordis.patch.yml'))
  assert.ok(patchWrite, 'the patch document is written')
  assert.match(patchWrite.stdin, /llm-pi-ai/)

  const stateWrite = ssh.writes.find((entry) => entry.command.includes('sync/state.json'))
  assert.ok(stateWrite, 'the sync state is recorded')
  assert.match(stateWrite.stdin, /"status": "applied"/)
  assert.match(stateWrite.stdin, /"hash"/)
})

test('a failed verification restores the backup instead of failing the connection', async () => {
  const { home, profileDir } = await localFixture()
  const ssh = fakeSsh({ dumpFails: true })
  const ctx = syncContext({ home, profileDir })
  const runtime = syncRuntime(ssh)
  const prepared = await prepareSync(ctx, runtime)
  runtime.forceSync = true
  await applySync(ctx, runtime, prepared)
  assert.equal(runtime.sync.status, 'failed')
  assert.equal(runtime.sync.error.code, 'sync-failed')
  assert.ok(
    ssh.commands.some((command) => command.includes('tar -xzf')),
    'the backup is restored',
  )
})

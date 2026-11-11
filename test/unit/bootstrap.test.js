import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executeBootstrap,
  manualPreparationHint,
  nodeDownloadNames,
  nodeDownloadStep,
  planBootstrap,
  summarizePlan,
  verifyInstalledVersion,
} from '../../src/bootstrap.js'
import { DEFAULT_NODE_VERSION } from '../../src/constants.js'
import { makeFacts } from '../helpers/fake-remote.js'

const TARGET = '0.2.2-rc.1'
const REMOTE_DIR = '~/.dsh-remote-go'

/** Facts for a bare Ubuntu box (no node, but curl/tar/sha256 present). */
function bareFacts(overrides = {}) {
  return makeFacts({
    nodePath: null,
    nodeVersion: null,
    npmPath: null,
    npmVersion: null,
    npxPath: null,
    dshPath: null,
    dshVersion: null,
    isolatedNodePath: null,
    isolatedNodeVersion: null,
    isolatedDshVersion: null,
    isolatedDshBinPath: null,
    ...overrides,
  })
}

test('planBootstrap reuses a matching remote DSH (T0)', () => {
  const plan = planBootstrap({
    facts: makeFacts({ dshPath: '/usr/local/bin/dsh', dshVersion: TARGET, nodeVersion: '24.22.2' }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  assert.equal(plan.level, 'T0')
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.start.kind, 'dsh')
  assert.equal(plan.start.dshPath, '/usr/local/bin/dsh')
})

test('planBootstrap reuses the plugin isolated runtime (T0-local)', () => {
  const plan = planBootstrap({
    facts: makeFacts({
      nodeVersion: '22.19.0',
      isolatedNodePath: '/home/ubuntu/.dsh/remote-go/node/bin/node',
      isolatedNodeVersion: '24.22.2',
      isolatedDshVersion: TARGET,
      isolatedDshBinPath: '/home/ubuntu/.dsh/remote-go/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js',
    }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  assert.equal(plan.level, 'T0-local')
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.start.kind, 'node-bin')
})

test('planBootstrap prefers npx when Node is new enough (T1)', () => {
  const plan = planBootstrap({
    facts: bareFacts({
      nodePath: '/usr/bin/node',
      nodeVersion: '24.22.2',
      npmPath: '/usr/bin/npm',
      npmVersion: '11.19.1',
      npxPath: '/usr/bin/npx',
    }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  assert.equal(plan.level, 'T1')
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.start.kind, 'npx')
  assert.equal(plan.start.targetVersion, TARGET)
})

test('planBootstrap installs into an isolated directory when npx is unavailable (T2)', () => {
  const plan = planBootstrap({
    facts: bareFacts({
      nodePath: '/usr/bin/node',
      nodeVersion: '24.22.2',
      npmPath: '/usr/bin/npm',
      npmVersion: '11.19.1',
      npxPath: null,
    }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  assert.equal(plan.level, 'T2')
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].id, 'install-dsh-isolated')
  assert.match(plan.steps[0].command, /@deepseek-ai\/dsh@0\.2\.2-rc\.1/)
  assert.match(plan.steps[0].command, /--prefix/)
  assert.equal(plan.start.kind, 'node-bin')
  assert.match(plan.start.dshBinPath, /dsh-home\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/)
})

test('planBootstrap downloads a verified Node when the remote has no usable Node (T3)', () => {
  const plan = planBootstrap({
    facts: bareFacts(),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
    nodeVersion: DEFAULT_NODE_VERSION,
  })
  assert.equal(plan.level, 'T3')
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ['prepare-dirs', 'install-node', 'install-dsh-isolated'],
  )
  const download = plan.steps.find((step) => step.id === 'install-node')
  assert.match(download.command, /sha256sum -c -/)
  assert.match(download.command, new RegExp(`node-v${DEFAULT_NODE_VERSION}-linux-x64\\.tar\\.xz`))
  assert.equal(plan.start.kind, 'node-bin')
})

test('planBootstrap respects an explicit mode of reuse', () => {
  assert.throws(
    () => planBootstrap({ facts: bareFacts(), targetVersion: TARGET, remoteDir: REMOTE_DIR, mode: 'reuse' }),
    (error) => error.code === 'remote-dsh-missing',
  )
})

test('planBootstrap rejects unsupported OS and invalid versions', () => {
  assert.throws(
    () => planBootstrap({ facts: bareFacts({ os: 'Darwin' }), targetVersion: TARGET, remoteDir: REMOTE_DIR }),
    (error) => error.code === 'unsupported-os',
  )
  assert.throws(
    () => planBootstrap({ facts: bareFacts(), targetVersion: 'latest', remoteDir: REMOTE_DIR }),
    (error) => error.code === 'invalid-input',
  )
})

test('planBootstrap reports a dead end when nothing can be downloaded (T5)', () => {
  assert.throws(
    () =>
      planBootstrap({
        facts: bareFacts({ curlPath: null, tarPath: null, sha256Path: null }),
        targetVersion: TARGET,
        remoteDir: REMOTE_DIR,
      }),
    (error) => error.code === 'remote-dsh-missing',
  )
  const hint = manualPreparationHint(bareFacts())
  assert.match(hint, /npm install --prefix/)
})

test('nodeDownloadNames maps the Linux architectures Node publishes', () => {
  assert.equal(nodeDownloadNames(DEFAULT_NODE_VERSION, 'x86_64').file, `node-v${DEFAULT_NODE_VERSION}-linux-x64.tar.xz`)
  assert.equal(
    nodeDownloadNames(DEFAULT_NODE_VERSION, 'aarch64').file,
    `node-v${DEFAULT_NODE_VERSION}-linux-arm64.tar.xz`,
  )
  assert.equal(nodeDownloadNames(DEFAULT_NODE_VERSION, 'riscv64'), null)
  assert.equal(
    nodeDownloadStep({ downloadsDir: '/d', nodeDir: '/n', nodeBin: '/n/bin/node' }, DEFAULT_NODE_VERSION, 'riscv64'),
    null,
  )
})

test('executeBootstrap runs steps in order and reports progress', async () => {
  const plan = planBootstrap({
    facts: bareFacts({ nodePath: '/usr/bin/node', nodeVersion: '24.22.2', npmPath: '/usr/bin/npm', npxPath: null }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  const calls = []
  const progress = []
  const ssh = {
    async exec(command) {
      calls.push(command)
      return { code: 0, stdout: '0.2.2-rc.1\n', stderr: '' }
    },
  }
  await executeBootstrap(ssh, plan, { onProgress: (item) => progress.push(item.state) })
  assert.equal(calls.length, 1)
  assert.ok(progress.includes('running'))
  assert.ok(progress.includes('done'))
})

test('executeBootstrap throws a coded error naming the failed step', async () => {
  const plan = planBootstrap({
    facts: bareFacts({ nodePath: '/usr/bin/node', nodeVersion: '24.22.2', npmPath: '/usr/bin/npm', npxPath: null }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  const ssh = {
    async exec() {
      return { code: 1, stdout: '', stderr: 'npm ERR! network' }
    },
  }
  await assert.rejects(
    () => executeBootstrap(ssh, plan),
    (error) =>
      error.code === 'remote-dsh-missing' &&
      /Install DSH/.test(error.message) &&
      /安装 DSH/.test(error.detail.zh) &&
      /npm ERR! network/.test(error.technical ?? ''),
  )
})

test('verifyInstalledVersion checks the exact version for isolated installs', async () => {
  const plan = planBootstrap({
    facts: bareFacts({ nodePath: '/usr/bin/node', nodeVersion: '24.22.2', npmPath: '/usr/bin/npm', npxPath: null }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  const ok = {
    async exec() {
      return { code: 0, stdout: `${TARGET}\n`, stderr: '' }
    },
  }
  assert.equal(await verifyInstalledVersion(ok, plan), TARGET)

  const mismatch = {
    async exec() {
      return { code: 0, stdout: '0.2.1\n', stderr: '' }
    },
  }
  await assert.rejects(
    () => verifyInstalledVersion(mismatch, plan),
    (error) => error.code === 'version-mismatch',
  )

  const t0 = planBootstrap({
    facts: makeFacts({ dshPath: '/dsh', dshVersion: TARGET }),
    targetVersion: TARGET,
    remoteDir: REMOTE_DIR,
  })
  assert.equal(await verifyInstalledVersion(mismatch, t0), null)
})

test('summarizePlan is client-safe', () => {
  const plan = planBootstrap({ facts: bareFacts(), targetVersion: TARGET, remoteDir: REMOTE_DIR })
  const summary = summarizePlan(plan)
  assert.equal(summary.level, 'T3')
  assert.equal(summary.startKind, 'node-bin')
  assert.equal(summary.steps.length, 3)
  assert.ok(summary.reason.zh.length > 0)
})

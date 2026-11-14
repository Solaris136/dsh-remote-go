import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANAGED_NODE_VERSION_FALLBACK,
  NODE_DIST_BASES,
  applyManagedNodeFacts,
  buildNodeChecksumScript,
  buildNodeInstallScript,
  buildNodeScanScript,
  ensureRemoteNode,
  managedNodeVersionFromEngine,
  nodeDistArch,
  parseNodeChecksumOutput,
  parseNodeScanOutput,
} from '../../src/node-runtime.js'
import { remoteLayout } from '../../src/layout.js'
import { makeFacts } from '../helpers/fake-remote.js'

const LAYOUT = remoteLayout('/home/ubuntu')
const SHA = 'a'.repeat(64)
const VERSION = MANAGED_NODE_VERSION_FALLBACK
const FILE = `node-v${VERSION}-linux-x64.tar.gz`
const NODE_DIR = '/home/ubuntu/.dsh/remote-go/node'

test('nodeDistArch maps uname values to the official Linux build names', () => {
  assert.equal(nodeDistArch('x86_64'), 'x64')
  assert.equal(nodeDistArch('amd64'), 'x64')
  assert.equal(nodeDistArch('aarch64'), 'arm64')
  assert.equal(nodeDistArch('armv7l'), 'armv7l')
  assert.equal(nodeDistArch('ppc64le'), 'ppc64le')
  assert.equal(nodeDistArch('s390x'), 's390x')
  assert.equal(nodeDistArch('i686'), null)
  assert.equal(nodeDistArch(undefined), null)
})

test('managedNodeVersionFromEngine pins the lower bound of DSH engines.node', () => {
  assert.equal(managedNodeVersionFromEngine('>=24.9.0'), '24.9.0')
  assert.equal(managedNodeVersionFromEngine('^22.12.0'), '22.12.0')
  assert.equal(managedNodeVersionFromEngine('~20.11.1'), '20.11.1')
  assert.equal(managedNodeVersionFromEngine('24.9.0'), '24.9.0')
  assert.equal(managedNodeVersionFromEngine('>=24.9.0 <25'), '24.9.0')
  assert.equal(managedNodeVersionFromEngine('>24.8.0'), '24.8.1')
  assert.equal(managedNodeVersionFromEngine('24'), '24.0.0')
  // Unusable declarations fall back to the plugin's own floor.
  for (const range of ['', null, undefined, '*', 'latest', 'not-a-range']) {
    assert.equal(managedNodeVersionFromEngine(range), MANAGED_NODE_VERSION_FALLBACK)
  }
})

test('buildNodeScanScript lists managed builds without any network access', () => {
  const script = buildNodeScanScript(LAYOUT)
  assert.ok(script.includes(`NODE_DIR='${NODE_DIR}'`), script)
  assert.match(script, /bin\/npx/)
  assert.doesNotMatch(script, /curl|wget|SHASUMS/)
})

test('parseNodeScanOutput keeps versions, drops duplicates and junk', () => {
  const versions = parseNodeScanOutput(
    [
      `NODE\t24.9.0\t${NODE_DIR}/v24.9.0`,
      `NODE\tv24.9.0\t${NODE_DIR}/v24.9.0`,
      `NODE\tnot-a-version\t${NODE_DIR}/junk`,
      `NODE\t24.22.3\t${NODE_DIR}/v24.22.3`,
      'garbage',
    ].join('\n'),
  )
  assert.deepEqual(
    versions.map((entry) => entry.version),
    ['24.9.0', '24.22.3'],
  )
})

test('buildNodeChecksumScript pins the version and asks for the exact asset', () => {
  const script = buildNodeChecksumScript({ downloadDir: LAYOUT.downloadDir, version: VERSION, arch: 'x64' })
  assert.ok(script.includes(`VERSION='${VERSION}'`), script)
  assert.match(script, /SHASUMS256\.txt/)
  assert.ok(script.includes(`FILE="node-v$VERSION-linux-x64.tar.gz"`), script)
  for (const base of NODE_DIST_BASES) assert.ok(script.includes(base), base)
})

test('parseNodeChecksumOutput accepts only a known host and a hex checksum', () => {
  const line = `CHECKSUM\thttps://nodejs.org/dist\t${SHA}`
  assert.deepEqual(parseNodeChecksumOutput(line, { version: VERSION, arch: 'x64' }), {
    base: 'https://nodejs.org/dist',
    version: VERSION,
    sha256: SHA,
    file: FILE,
  })
  assert.equal(
    parseNodeChecksumOutput(`CHECKSUM\thttps://evil.example\t${SHA}`, { version: VERSION, arch: 'x64' }),
    null,
  )
  assert.equal(
    parseNodeChecksumOutput(`CHECKSUM\thttps://nodejs.org/dist\tzzz`, { version: VERSION, arch: 'x64' }),
    null,
  )
  assert.equal(parseNodeChecksumOutput('', { version: VERSION, arch: 'x64' }), null)
})

test('buildNodeInstallScript verifies the checksum before unpacking', () => {
  const script = buildNodeInstallScript({
    layout: LAYOUT,
    release: { base: 'https://nodejs.org/dist', version: VERSION, sha256: SHA, file: FILE },
  })
  assert.ok(script.includes(`VERSION='${VERSION}'`), script)
  assert.ok(script.includes(`SHA='${SHA}'`), script)
  assert.ok(script.includes(`FILE='${FILE}'`), script)
  assert.ok(script.includes(`NODE_DIR='${NODE_DIR}'`), script)
  assert.match(script, /sha256sum -c -/)
  assert.match(script, /tar -xzf/)
  // The old build is only replaced after the extracted binary reports the right version.
  assert.ok(script.indexOf('GOT=') < script.indexOf('mv "$TMPX" "$BINDIR"'))
  for (const base of NODE_DIST_BASES) assert.ok(script.includes(base), base)
})

/**
 * @param {{ scan?: string, checksum?: { code: number, stdout?: string, stderr?: string }, install?: (options: any, command: string) => any }} input
 */
function fakeNodeSsh(input = {}) {
  /** @type {{ command: string, options: any }[]} */
  const calls = []
  return {
    calls,
    async exec(command, options = {}) {
      calls.push({ command, options })
      if (command.includes('SHASUMS256.txt')) {
        const checksum = input.checksum ?? { code: 5 }
        return { code: checksum.code, stdout: checksum.stdout ?? '', stderr: checksum.stderr ?? '' }
      }
      if (command.startsWith('set -eu\nNODE_DIR=') && command.includes('tar -xzf')) {
        if (input.install) return input.install(options, command)
        const nodeDir = /NODE_DIR='([^']+)'/.exec(command)?.[1] ?? NODE_DIR
        const version = /VERSION='([^']+)'/.exec(command)?.[1] ?? VERSION
        options.onStdout?.(`STEP\textract\nREADY\t${nodeDir}/v${version}\n`)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: input.scan ?? '', stderr: '' }
    },
  }
}

test('ensureRemoteNode reuses the pinned build without touching the network', async () => {
  const ssh = fakeNodeSsh({ scan: `NODE\t${VERSION}\t${NODE_DIR}/v${VERSION}\n` })
  const result = await ensureRemoteNode(ssh, { facts: makeFacts(), layout: LAYOUT })
  assert.equal(result.version, VERSION)
  assert.equal(result.npxPath, `${NODE_DIR}/v${VERSION}/bin/npx`)
  assert.equal(result.nodeBinDir, `${NODE_DIR}/v${VERSION}/bin`)
  assert.equal(result.installed, false)
  assert.equal(ssh.calls.length, 1, 'only the scan may run when the pinned build is present')
})

test('ensureRemoteNode installs the pinned build when only another version is present', async () => {
  const ssh = fakeNodeSsh({
    scan: `NODE\t24.22.3\t${NODE_DIR}/v24.22.3\n`,
    checksum: { code: 0, stdout: `CHECKSUM\thttps://nodejs.org/dist\t${SHA}\n` },
  })
  /** @type {any[]} */
  const events = []
  const result = await ensureRemoteNode(ssh, {
    facts: makeFacts(),
    layout: LAYOUT,
    onProgress: (event) => events.push(event),
  })
  assert.equal(result.version, VERSION)
  assert.equal(result.installed, true)
  assert.equal(ssh.calls.length, 3, 'scan, checksum and install each run once')
  const steps = events.map((event) => event.step)
  assert.ok(steps.includes('checksum'))
  assert.ok(steps.includes('install'))
  assert.ok(steps.includes('ready'))
})

test('ensureRemoteNode reports a typed failure when no checksum can be fetched', async () => {
  const ssh = fakeNodeSsh({ checksum: { code: 5, stderr: 'curl: (6) Could not resolve host' } })
  await assert.rejects(
    () => ensureRemoteNode(ssh, { facts: makeFacts(), layout: LAYOUT }),
    (error) =>
      error.code === 'remote-node-install-failed' &&
      /nodejs\.org/.test(error.detail.zh) &&
      /Could not resolve host/.test(error.technical ?? ''),
  )
})

test('ensureRemoteNode refuses an unusable remote before any download', async () => {
  const cases = [
    { facts: { os: 'Darwin' }, code: 'unsupported-os' },
    { facts: { libc: 'musl' }, code: 'remote-node-install-failed' },
    { facts: { glibcVersion: '2.17' }, code: 'remote-node-install-failed' },
    { facts: { arch: 'i686' }, code: 'remote-node-install-failed' },
    { facts: { home: '' }, code: 'remote-node-install-failed' },
    { facts: { diskFreeKb: 1000 }, code: 'remote-node-install-failed' },
  ]
  for (const item of cases) {
    const ssh = fakeNodeSsh()
    const facts = item.facts.home === '' ? makeFacts({ home: '' }) : makeFacts(item.facts)
    await assert.rejects(
      () => ensureRemoteNode(ssh, { facts, layout: item.facts.home === '' ? remoteLayout(null) : LAYOUT }),
      (error) => error.code === item.code,
      JSON.stringify(item.facts),
    )
    assert.equal(ssh.calls.length, 0, `no exec for ${JSON.stringify(item.facts)}`)
  }
})

test('ensureRemoteNode surfaces an install failure with its reason', async () => {
  const ssh = fakeNodeSsh({
    checksum: { code: 0, stdout: `CHECKSUM\thttps://nodejs.org/dist\t${SHA}\n` },
    install: (options) => {
      options.onStdout?.('FAILED\tchecksum\n')
      return { code: 6, stdout: '', stderr: '' }
    },
  })
  await assert.rejects(
    () => ensureRemoteNode(ssh, { facts: makeFacts(), layout: LAYOUT }),
    (error) => error.code === 'remote-node-install-failed' && /checksum/.test(error.detail.en),
  )
})

test('applyManagedNodeFacts swaps in the managed binaries and keeps the other facts', () => {
  const facts = makeFacts({ curlPath: null, wgetPath: '/usr/bin/wget' })
  const patched = applyManagedNodeFacts(facts, {
    version: 'v24.9.0',
    nodePath: `${NODE_DIR}/v24.9.0/bin/node`,
    npmPath: `${NODE_DIR}/v24.9.0/bin/npm`,
    npxPath: `${NODE_DIR}/v24.9.0/bin/npx`,
  })
  assert.equal(patched.nodeVersion, '24.9.0')
  assert.equal(patched.nodePath, `${NODE_DIR}/v24.9.0/bin/node`)
  assert.equal(patched.npxPath, `${NODE_DIR}/v24.9.0/bin/npx`)
  assert.equal(patched.curlPath, null)
  assert.equal(patched.wgetPath, '/usr/bin/wget')
  assert.equal(patched.arch, 'x86_64')
})

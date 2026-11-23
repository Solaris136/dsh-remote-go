import { mkdtemp } from 'node:fs/promises'
import { rm, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HostStore } from '../../dist/src/store.js'
import { RemoteGoService } from '../../dist/src/service.js'
import { FakeSshPort } from './fake-ssh-port.ts'
// The service-level suites import the double as `FakeSsh`; it lives in `fake-ssh-port.js` so the port suite shares it.
export { FakeSshPort as FakeSsh }
/* Temporary service directories created by `makeTestService`. `node --test` runs every file in its own child process,
 * so one exit hook covers every suite: without it each unit-test run leaked a `dsh-remote-go-test-*` directory
 * (and its hosts.json) into the OS temp directory. */
const tempDirs = new Set()
process.once('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
  tempDirs.clear()
})
/** Remove one service directory eagerly; also exported for tests that assert cleanup. */
export async function cleanupTestService(result) {
  if (!result?.dir || !tempDirs.has(result.dir)) return
  tempDirs.delete(result.dir)
  await rm(result.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}
export function makeFacts(overrides = {}) {
  return {
    os: 'Linux',
    arch: 'x86_64',
    osName: 'Ubuntu 24.04.1 LTS',
    user: 'ubuntu',
    home: '/home/ubuntu',
    shell: '/bin/bash',
    nodePath: '/usr/bin/node',
    nodeVersion: '24.22.2',
    npmPath: '/usr/bin/npm',
    npxPath: '/usr/bin/npx',
    curlPath: '/usr/bin/curl',
    wgetPath: '/usr/bin/wget',
    libc: 'glibc',
    glibcVersion: '2.39',
    diskFreeKb: 35_000_000,
    sshConnection: true,
    credentialsFile: true,
    deepseekKeyEnv: true,
    providerEnvKeys: ['DEEPSEEK'],
    ...overrides,
  }
}
export class FakeTunnel {
  constructor(port = 41000) {
    this.localPort = port
    this.closed = false
  }
  async close() {
    this.closed = true
  }
}
export function managedNodeFixture(version = '24.9.0') {
  const dir = `/home/ubuntu/.dsh/remote-go/node/v${version}`
  return {
    managed: true,
    version,
    nodePath: `${dir}/bin/node`,
    npmPath: `${dir}/bin/npm`,
    npxPath: `${dir}/bin/npx`,
    nodeBinDir: `${dir}/bin`,
    installed: false,
  }
}
export async function makeTestService(overrides = {}) {
  const dir = overrides.dir ?? (await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-test-')))
  tempDirs.add(dir)
  const store = new HostStore({ dir, logger: { warn() {}, info() {}, debug() {}, error() {} } })
  const events = []
  const facts = overrides.facts ?? makeFacts()
  const sshFactory =
    overrides.sshFactory ??
    ((options) => {
      const ssh = new FakeSshPort({ options, files: overrides.sshFiles })
      events.push({ type: 'ssh', ssh })
      return ssh
    })
  const tunnelFactory = overrides.tunnelFactory ?? (async () => new FakeTunnel(45123))
  // The fake tunnel is not a real listener: tests that want "the listener still answers" override this. Default false.
  const tunnelProbe = overrides.tunnelProbe ?? (async () => false)
  const service = new RemoteGoService({
    store,
    home: path.join(dir, 'home'),
    logger: overrides.logger ?? { warn() {}, info() {}, debug() {}, error() {} },
    secrets: overrides.secrets ?? null,
    localVersion: overrides.localVersion === undefined ? '0.2.2-rc.1' : overrides.localVersion,
    engineNodeRange: overrides.engineNodeRange,
    sshFactory,
    tunnelFactory,
    tunnelProbe,
    probe: overrides.probe ?? (async () => facts),
    plan: (await import('../../dist/src/bootstrap.js')).planNpx,
    ensureNode: overrides.ensureNode ?? (async () => managedNodeFixture()),
    preflight: overrides.preflight ?? (async (_ssh, plan) => plan.targetVersion),
    findForeign: overrides.findForeign ?? (async () => ({ ok: true, processes: [] })),
    stopForeign: overrides.stopForeign ?? (async () => ({ ok: true, alive: [], output: 'STOPPED' })),
    readRegistry: overrides.readRegistry ?? (async () => null),
    startWeb:
      overrides.startWeb ??
      (async () => ({
        pid: 4242,
        port: 38123,
        token: 'tok_test_123',
        url: 'http://127.0.0.1:38123/?token=tok_test_123',
        logPath: '/tmp/web.log',
        startedAt: new Date().toISOString(),
        rawLine: '',
        profile: 'web',
        dshHome: '/home/ubuntu/.dsh',
      })),
    stopWeb: overrides.stopWeb ?? (async () => ({ ok: true, output: 'STOPPED' })),
    waitUi: overrides.waitUi ?? (async () => ({ ok: true, status: 200 })),
    exchange:
      overrides.exchange ??
      (async () => ({
        ok: true,
        firstStatus: 302,
        location: './',
        status: 200,
        title: 'DSH',
        csp: null,
        bodyLength: 1024,
      })),
    adopt: overrides.adopt ?? (async () => null),
    resolveRemote: overrides.resolveRemote ?? (async () => ({ ok: false, reason: 'no-running-web' })),
    writeRegistry: overrides.writeRegistry ?? (async () => ({ ok: true, output: 'REGISTRY-WRITTEN' })),
    clearRegistry: overrides.clearRegistry ?? (async () => ({ ok: true, output: '' })),
    remoteStatus: overrides.remoteStatus ?? (async () => 200),
    processIdentity:
      overrides.processIdentity ??
      (async (_ssh, pid) => ({
        ok: true,
        startTime: `start-${pid}`,
        command: 'node /home/ubuntu/.dsh/remote-go/node/v24.9.0/bin/npx -y @deepseek-ai/dsh@0.2.2-rc.1 --profile web',
        dshHome: '/home/ubuntu/.dsh',
      })),
    loadSshMaterial: async () => ({
      sshDir: '/home/test/.ssh',
      configText: 'Host test-host\n  HostName 2001:db8::1\n  User ubuntu\n',
      knownHostsText: '',
      configPath: '/home/test/.ssh/config',
      knownHostsPath: '/home/test/.ssh/known_hosts',
    }),
    hostKeyConfirmTimeoutMs: overrides.hostKeyConfirmTimeoutMs ?? 2000,
    sessionAdapter: overrides.sessionAdapter ?? null,
    // Liveness confirmation and the re-attach retry loop run on short timers in tests.
    remoteConfirmDelayMs: overrides.remoteConfirmDelayMs ?? 5,
    remoteRecheckMs: overrides.remoteRecheckMs ?? 5,
    reattachAttempts: overrides.reattachAttempts ?? 2,
    reattachIntervalMs: overrides.reattachIntervalMs ?? 0,
    tunnelRepairSettleMs: overrides.tunnelRepairSettleMs ?? 1000,
    // The weak-network patience phase is opt-in here: a suite that asserts a spent retry budget must reach it in
    // milliseconds, so the default stays attempt-only and the patience tests set both values themselves.
    reconnectSlowDelayMs: overrides.reconnectSlowDelayMs ?? 20,
    reconnectPatienceMs: overrides.reconnectPatienceMs ?? 0,
  })
  await service.init()
  const result = { service, store, dir, events, facts }
  result.cleanup = () => cleanupTestService(result)
  return result
}
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000
  const intervalMs = options.intervalMs ?? 10
  const started = Date.now()
  while (true) {
    if (await predicate()) return true
    if (Date.now() - started > timeoutMs)
      throw new Error(`waitFor timed out${options.label ? `: ${options.label}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
export async function createHost(service, overrides = {}) {
  return service.saveHost({
    name: 'Tencent VM',
    address: 'test-host',
    port: 22,
    username: 'ubuntu',
    auth: { type: 'agent' },
    keepAlive: 'keep',
    ...overrides,
  })
}
/* An in-memory stand-in for `src/secrets.js` (same surface, no credential store), so tests can assert exactly which
 * password the pipeline and the wizard persist for a host.
 * @param {Record<string, string>} [initial] - records present before the service starts. */
export function fakeSecretStore(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    available: () => true,
    async get(hostId) {
      return store.get(hostId) ?? null
    },
    async has(hostId) {
      return store.has(hostId)
    },
    async set(hostId, password) {
      if (typeof hostId !== 'string' || typeof password !== 'string' || password === '') return false
      store.set(hostId, password)
      return true
    },
    async remove(hostId) {
      store.delete(hostId)
      return true
    },
  }
}

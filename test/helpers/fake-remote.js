/**
 * Shared fakes for service/API tests: no real SSH, no real remote host.
 * The shapes mirror what ssh.js / probe.js / webapp.js return.
 */
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HostStore } from '../../src/store.js'
import { RemoteGoService } from '../../src/service.js'

/** @param {import('../../src/probe.js').ProbeFacts} overrides */
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

export class FakeSsh extends EventEmitter {
  /**
   * @param {{ exec?: (command: string, options?: any) => Promise<any>, connect?: () => Promise<any>, onConnectRequest?: (options: any) => void, options?: any }} input
   */
  constructor(input = {}) {
    super()
    this.connected = false
    this.disposed = false
    this.options = input.options ?? {}
    this.calls = []
    this.execImpl = input.exec ?? (async () => ({ code: 0, stdout: '', stderr: '' }))
    this.connectImpl = input.connect
    this.onConnectRequest = input.onConnectRequest
  }

  async connect() {
    this.onConnectRequest?.(this.options)
    if (this.connectImpl) return this.connectImpl()
    this.connected = true
    return { fingerprint: 'SHA256:fake', keyType: 'ssh-ed25519', serverBanner: null }
  }

  async exec(command, options = {}) {
    this.calls.push({ command, options })
    return this.execImpl(command, options)
  }

  async forwardOut() {
    return new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
  }

  async dispose() {
    this.disposed = true
    this.connected = false
    this.emit('close')
  }

  simulateClose() {
    this.connected = false
    this.emit('close')
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

/** The managed Node path the fake provisioner reports. */
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

/**
 * Build a service wired to fakes plus the pieces a test wants to observe.
 * @param {{
 *   facts?: any,
 *   ensureNode?: any,
 *   startWeb?: any,
 *   sshFactory?: any,
 *   tunnelFactory?: any,
 *   waitUi?: any,
 *   exchange?: any,
 *   adopt?: any,
 *   findForeign?: any,
 *   stopForeign?: any,
 *   readRegistry?: any,
 *   localVersion?: string | null,
 *   engineNodeRange?: string | null,
 *   hostKeyConfirmTimeoutMs?: number,
 *   sessionAdapter?: any,
 *   workspaceAdapter?: any,
 * }} [overrides]
 */
export async function makeTestService(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-test-'))
  const store = new HostStore({ dir, logger: { warn() {}, info() {}, debug() {}, error() {} } })
  const events = []
  const facts = overrides.facts ?? makeFacts()
  const sshFactory =
    overrides.sshFactory ??
    ((options) => {
      const ssh = new FakeSsh({ options })
      events.push({ type: 'ssh', ssh })
      return ssh
    })
  const tunnelFactory = overrides.tunnelFactory ?? (async () => new FakeTunnel(45123))
  const service = new RemoteGoService({
    store,
    home: path.join(dir, 'home'),
    logger: overrides.logger ?? { warn() {}, info() {}, debug() {}, error() {} },
    localVersion: overrides.localVersion === undefined ? '0.2.2-rc.1' : overrides.localVersion,
    engineNodeRange: overrides.engineNodeRange,
    sshFactory,
    tunnelFactory,
    probe: async () => facts,
    plan: (await import('../../src/bootstrap.js')).planNpx,
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
        cookieNames: ['dsh-auth-test'],
        location: './',
        status: 200,
        title: 'DSH',
        frameBlocked: false,
        xFrameOptions: null,
        csp: null,
        bodyLength: 1024,
      })),
    adopt: overrides.adopt ?? (async () => null),
    loadSshMaterial: async () => ({
      sshDir: '/home/test/.ssh',
      configText: 'Host test-host\n  HostName 2001:db8::1\n  User ubuntu\n',
      knownHostsText: '',
      configPath: '/home/test/.ssh/config',
      knownHostsPath: '/home/test/.ssh/known_hosts',
    }),
    hostKeyConfirmTimeoutMs: overrides.hostKeyConfirmTimeoutMs ?? 2000,
    sessionAdapter: overrides.sessionAdapter ?? null,
    workspaceAdapter: overrides.workspaceAdapter ?? null,
  })
  await service.init()
  return { service, store, dir, events, facts }
}

/**
 * Wait for a predicate with a short timeout.
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000
  const intervalMs = options.intervalMs ?? 10
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return true
    if (Date.now() - started > timeoutMs)
      throw new Error(`waitFor timed out${options.label ? `: ${options.label}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Create a host entry for tests. */
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

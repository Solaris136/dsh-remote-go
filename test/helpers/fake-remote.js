/**
 * Shared fakes for service/API tests: no real SSH, no real remote host.
 * The shapes mirror what ssh.js / probe.js / webapp.js return.
 */
import { EventEmitter } from 'node:events'
import { Readable, Duplex } from 'node:stream'
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
    npmVersion: '11.19.1',
    npxPath: '/usr/bin/npx',
    dshPath: null,
    dshVersion: null,
    curlPath: '/usr/bin/curl',
    tarPath: '/usr/bin/tar',
    sha256Path: '/usr/bin/sha256sum',
    diskFreeKb: 35_000_000,
    sshConnection: true,
    isolatedNodePath: null,
    isolatedNodeVersion: null,
    isolatedDshVersion: null,
    isolatedDshBinPath: null,
    credentialsFile: true,
    deepseekKeyEnv: true,
    providerEnvKeys: ['DEEPSEEK'],
    runRegistry: null,
    remoteDirExists: false,
    homeExists: true,
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

/**
 * Build a service wired to fakes plus the pieces a test wants to observe.
 * @param {{
 *   facts?: any,
 *   startWeb?: any,
 *   sshFactory?: any,
 *   tunnelFactory?: any,
 *   waitUi?: any,
 *   exchange?: any,
 *   adopt?: any,
 *   localVersion?: string | null,
 *   hostKeyConfirmTimeoutMs?: number,
 *   sessionAdapter?: any,
 * }} [overrides]
 */
export async function makeTestService(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-test-'))
  const store = new HostStore({ dir, logger: { warn() {}, info() {}, debug() {}, error() {} } })
  const events = []
  const facts =
    overrides.facts ??
    makeFacts({
      isolatedNodePath: '/home/ubuntu/.dsh/remote-go/node/bin/node',
      isolatedNodeVersion: '24.22.2',
      isolatedDshVersion: '0.2.2-rc.1',
      isolatedDshBinPath: '/home/ubuntu/.dsh/remote-go/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js',
      nodeVersion: '22.19.0',
      npxPath: null,
    })
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
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    localVersion: overrides.localVersion === undefined ? '0.2.2-rc.1' : overrides.localVersion,
    sshFactory,
    tunnelFactory,
    probe: async () => facts,
    plan: (await import('../../src/bootstrap.js')).planBootstrap,
    execute: async () => ({}),
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
    tailLog: async () => '',
    loadSshMaterial: async () => ({
      sshDir: '/home/test/.ssh',
      configText: 'Host test-host\n  HostName 2001:db8::1\n  User ubuntu\n',
      knownHostsText: '',
      configPath: '/home/test/.ssh/config',
      knownHostsPath: '/home/test/.ssh/known_hosts',
    }),
    hostKeyConfirmTimeoutMs: overrides.hostKeyConfirmTimeoutMs ?? 2000,
    sessionAdapter: overrides.sessionAdapter ?? null,
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HostStore } from '../../dist/src/store.js'
import { RemoteGoService } from '../../dist/src/service.js'
import { SshConnection } from '../../dist/src/ssh.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SIM_SCRIPT = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')
const REGISTRY_PATH = '/home/sim/.dsh/remote-go/run/web.json'

const QUIET = { warn() {}, info() {}, debug() {}, error() {} }
const CREDENTIALS = { username: 'sim', password: 'sim' }

function tail(lines) {
  return lines.slice(-15).join('')
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function waitForState(file, predicate, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    const state = readState(file)
    if (state && predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${options.label ?? 'condition'} timed out after ${timeoutMs}ms`)
}

async function startSimulator(stateFile) {
  const logs = []
  const child = spawn(process.execPath, [SIM_SCRIPT, '--serve', '--state-file', stateFile], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SIM_SSH_USER: CREDENTIALS.username,
      SIM_SSH_PASSWORD: CREDENTIALS.password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  const state = await waitForState(
    stateFile,
    (value) => Number(value.pid) === child.pid && Number(value.sshPort) > 0 && Number(value.remotePort) > 0,
    'simulator startup',
  )
  return { child, state, logs }
}

async function stopSimulator(child) {
  if (!child || child.exitCode !== null) return true
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!stopped) {
    child.kill('SIGKILL')
    return await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
  }
  return true
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.setTimeout(5_000, () => request.destroy(new Error('request timed out')))
    request.end()
  })
}

/** The plugin exactly as it runs locally, pointed at the simulated SSH endpoint. */
async function startPlugin(state, dir) {
  const store = new HostStore({ dir: path.join(dir, 'state'), logger: QUIET })
  const service = new RemoteGoService({
    store,
    home: path.join(dir, 'home'),
    logger: QUIET,
    localVersion: '0.2.2-rc.1',
    engineNodeRange: '>=24.9.0',
    // Keep the local ~/.ssh out of the integration run: the simulator's key is accepted below.
    loadSshMaterial: async () => ({
      sshDir: '',
      configText: '',
      knownHostsText: '',
      configPath: '',
      knownHostsPath: '',
    }),
    sshFactory: (options) =>
      new SshConnection({
        ...options,
        acceptUnknownHostKey: true,
        readyTimeoutMs: 15_000,
        keepaliveIntervalMs: 15_000,
      }),
    remoteConfirmDelayMs: 40,
    remoteRecheckMs: 40,
    reattachAttempts: 20,
    reattachIntervalMs: 100,
  })
  await service.init()
  const host = await service.saveHost({
    name: 'simulated remote',
    address: '127.0.0.1',
    port: state.sshPort,
    username: CREDENTIALS.username,
    auth: { type: 'password' },
    keepAlive: 'keep',
  })
  return { service, host }
}

/** Read one remote file over a fresh SSH session (the plugin's own transport is released). */
async function readRemoteText(state, remotePath) {
  const ssh = new SshConnection({
    host: '127.0.0.1',
    port: state.sshPort,
    username: CREDENTIALS.username,
    auth: { type: 'password', password: CREDENTIALS.password },
    acceptUnknownHostKey: true,
    readyTimeoutMs: 15_000,
  })
  await ssh.connect()
  try {
    return await ssh.exec(`cat '${remotePath}' 2>/dev/null || true`, { timeoutMs: 15_000 })
  } finally {
    await ssh.dispose()
  }
}

test(
  'the remote DSH can be stopped from the host card and a later reconnect starts a fresh instance',
  { timeout: 240_000 },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-go-stop-'))
    const stateFile = path.join(dir, 'sim-state.json')
    const { child, state, logs } = await startSimulator(stateFile)
    const { service, host } = await startPlugin(state, dir)
    try {
      const statuses = []
      service.on('state', (snapshot) => {
        for (const view of snapshot.hosts) statuses.push(view.status)
      })
      await service.connect(host.id, { password: CREDENTIALS.password })
      await waitFor(() => service.snapshot().hosts[0].status === 'connected', {
        timeoutMs: 120_000,
        label: 'connected',
      })
      const connected = service.snapshot().hosts[0]
      const firstPort = connected.remote.port
      const firstPid = connected.remote.pid
      const firstLocalPort = connected.remote.localPort
      const firstUrl = service.openInfo(host.id).url
      const firstToken = /[?&]token=([^&]+)/.exec(firstUrl)?.[1] ?? ''
      assert.ok(firstToken.length > 0)
      const firstRegistry = JSON.parse((await readRemoteText(state, REGISTRY_PATH)).stdout)
      assert.equal(firstRegistry.pid, firstPid)
      assert.equal(firstRegistry.port, firstPort)

      await t.test('stopping the remote DSH signals the bound pid and releases the link', async () => {
        const result = await service.stopRemote(host.id)
        assert.deepEqual(result, { ok: true, pid: firstPid })
        const view = service.snapshot().hosts[0]
        assert.equal(view.status, 'disconnected')
        assert.equal(view.error, null)
        assert.equal(view.progress, null)
        assert.equal(view.remote.pid, null, 'the card no longer claims a running instance')
        assert.equal(view.remote.localPort, null)
        assert.equal(view.remote.uiReady, false)
        // The host configuration and its keep-alive survive: the card can reconnect.
        assert.equal(view.id, host.id)
        assert.equal(view.keepAlive, 'keep')
        assert.equal(service.snapshot().hosts.length, 1)
        assert.equal(service.runtimes.get(host.id).ssh, null, 'the SSH session is released')

        // The simulated remote process is really gone: its pid stops answering, its listener is
        // closed and the run registry no longer names an instance.
        const stoppedState = await waitForState(stateFile, (value) => value.stops >= 1, 'remote stop')
        assert.equal(stoppedState.started, false)
        assert.equal(stoppedState.token, '')
        await assert.rejects(
          () => httpGet(firstPort, '/api/health'),
          (error) => error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET',
          'the stopped remote web must not answer any more',
        )
        const registry = await readRemoteText(state, REGISTRY_PATH)
        assert.equal(registry.stdout.trim(), '', 'the stale run registry must not be left behind')
        // Opening the remote UI is refused while the host is disconnected.
        await assert.rejects(
          () => service.stopRemote(host.id),
          (error) => error.code === 'stop-unavailable',
          'a disconnected host cannot be stopped twice',
        )
      })

      await t.test('reconnecting starts a new instance on a new port with a new token', async () => {
        await service.reconnect(host.id)
        await waitFor(
          () => {
            const view = service.snapshot().hosts[0]
            return view.status === 'connected' && Number(view.remote.port) > 0
          },
          { timeoutMs: 120_000, label: 'reconnected' },
        )
        const view = service.snapshot().hosts[0]
        assert.notEqual(view.remote.port, firstPort, 'the relaunch binds a new random port')
        assert.notEqual(view.remote.pid, firstPid, 'a new process backs the host')
        assert.notEqual(view.remote.localPort, firstLocalPort, 'the tunnel is rebuilt')
        assert.equal(view.error, null)
        assert.equal(view.progress.code, 'ready')
        const url = service.openInfo(host.id).url
        const token = /[?&]token=([^&]+)/.exec(url)?.[1] ?? ''
        assert.ok(token.length > 0)
        assert.notEqual(token, firstToken, 'the new process prints a new launch token')
        const health = await httpGet(view.remote.localPort, '/api/health')
        assert.match(health.body, /"simulated":true/)
        // The reconnect really launched a new instance: the remote registry names the new pid/port.
        const registry = JSON.parse((await readRemoteText(state, REGISTRY_PATH)).stdout)
        assert.equal(registry.pid, view.remote.pid)
        assert.equal(registry.port, view.remote.port)
        assert.equal(registry.origin, 'launch')
        // No conflict prompt was ever raised for the stopped instance.
        assert.deepEqual(
          statuses.filter((status) => status === 'conflict-pending'),
          [],
          'a cleaned-up stop must never raise the "manually started DSH" conflict',
        )
      })
    } finally {
      await service.shutdown()
      const stopped = await stopSimulator(child)
      assert.equal(stopped, true, `the simulator was not stopped\n${tail(logs)}`)
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

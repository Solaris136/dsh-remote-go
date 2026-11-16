import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HostStore } from '../../src/store.js'
import { RemoteGoService } from '../../src/service.js'
import { SshConnection } from '../../src/ssh.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SIM_SCRIPT = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')

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
    request.setTimeout(10_000, () => request.destroy(new Error('request timed out')))
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
    // The liveness confirmation and the re-attach retry loop run on short timers here.
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

test(
  'a local restart relaunches the remote and a remote self-restart is re-attached',
  { timeout: 240_000 },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-go-restart-'))
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
      const runtime = service.runtimes.get(host.id)
      const connected = service.snapshot().hosts[0]
      assert.equal(connected.remote.version, '0.2.2-rc.1')
      assert.equal(connected.remote.dshHome, '/home/sim/.dsh')
      assert.equal(connected.remote.pid > 0, true)
      assert.equal(connected.remote.viewRev, 1)
      assert.match(service.openInfo(host.id).url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
      const firstPort = connected.remote.port
      const firstLocalPort = connected.remote.localPort
      const firstPid = connected.remote.pid

      await t.test('the local restart stops the managed pid and rebuilds the tunnel on a new port', async () => {
        assert.deepEqual(await service.restart(host.id), { accepted: true })
        await waitFor(
          () => {
            const view = service.snapshot().hosts[0]
            return view.status === 'connected' && view.remote.port !== firstPort && view.progress.code === 'ready'
          },
          { timeoutMs: 120_000, label: 'local restart' },
        )
        const view = service.snapshot().hosts[0]
        assert.notEqual(view.remote.port, firstPort, 'the relaunch binds a new random port')
        assert.notEqual(view.remote.localPort, firstLocalPort, 'the tunnel is rebuilt')
        assert.notEqual(view.remote.pid, firstPid)
        assert.equal(view.remote.viewRev, 2)
        const health = await httpGet(view.remote.localPort, '/api/health')
        assert.match(health.body, /"simulated":true/)
        // The plugin rewrote the run registry on the remote (read back through the real SSH session).
        const registry = JSON.parse((await runtime.ssh.exec(`cat '/home/sim/.dsh/remote-go/run/web.json'`)).stdout)
        assert.equal(registry.port, view.remote.port)
        assert.equal(registry.pid, view.remote.pid)
        assert.equal(runtime.ssh.connected, true, 'the same SSH session is reused')
      })

      await t.test('a remote self-restart is detected and re-attached by re-reading the port', async () => {
        const before = service.snapshot().hosts[0]
        const restart = await runtime.ssh.exec('sim-internal restart-web', { timeoutMs: 20_000 })
        assert.equal(restart.code, 0, restart.stderr)
        const reported = /RESTARTED:(\d+)/.exec(restart.stdout)
        assert.ok(reported, `unexpected restart answer: ${restart.stdout}`)
        const newRemotePort = Number(reported[1])
        assert.notEqual(newRemotePort, before.remote.port)
        // The remote is up again on the new port, but the run registry still names the old one -
        // exactly the state a plugin-market restart leaves behind.
        await waitForState(stateFile, (value) => Number(value.remotePort) === newRemotePort, 'simulator restart')

        // A proxy 502 is the real trigger: it is not trusted on its own, the probes confirm it.
        service.ctx.noteRemoteUnreachable(runtime, 'proxy')
        await waitFor(
          () => {
            const view = service.snapshot().hosts[0]
            return view.status === 'connected' && view.remote.port === newRemotePort
          },
          { timeoutMs: 60_000, label: 're-attached after a remote restart' },
        )
        const view = service.snapshot().hosts[0]
        assert.equal(view.remote.viewRev, 3)
        assert.notEqual(view.remote.localPort, before.remote.localPort)
        assert.equal(view.error, null)
        assert.equal(view.progress.code, 'ready')
        const health = await httpGet(view.remote.localPort, '/api/health')
        assert.match(health.body, /"simulated":true/)

        // The stale registry was refreshed, so the next connect adopts this instance again.
        const registry = JSON.parse((await runtime.ssh.exec(`cat '/home/sim/.dsh/remote-go/run/web.json'`)).stdout)
        assert.equal(registry.port, newRemotePort)
        assert.equal(registry.pid, view.remote.pid)

        assert.deepEqual(
          statuses.filter((status) => status === 'conflict-pending'),
          [],
          'a runtime re-attach must not raise the conflict prompt',
        )
        const reattach = runtime.restarts.find((entry) => entry.kind === 'remote-reattach')
        assert.ok(reattach, 'the re-attach is recorded for diagnostics')
        assert.equal(reattach.fromPort, before.remote.port)
        assert.equal(reattach.toPort, newRemotePort)
        assert.ok(runtime.restarts.some((entry) => entry.kind === 'local-restart'))
        assert.notEqual(runtime.heartbeatTimer, null, 'the heartbeat is watching again')
        const report = await service.diagnose(host.id)
        assert.equal(report.redacted, true)
        assert.ok(report.restarts.length >= 2)
      })
    } finally {
      await service.shutdown()
      const stopped = await stopSimulator(child)
      assert.equal(stopped, true, `the simulator was not stopped\n${tail(logs)}`)
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

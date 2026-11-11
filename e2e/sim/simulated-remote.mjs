// A local stand-in for an SSH-reachable remote host.
//
// Why: the plugin's real path is SSH auth → exec probe → remote `dsh web` →
// loopback `forwardOut` tunnel. Reproducing that needs a host, and Docker/WSL
// are not always available. This script uses ssh2's *server* API to expose a
// genuine SSH endpoint on 127.0.0.1 plus a local HTTP server that plays the
// remote DSH web, so the real client code can be exercised with no container,
// no VM and no external machine.
//
// Usage:
//   node e2e/sim/simulated-remote.mjs --self-test   # start, verify, exit
//   node e2e/sim/simulated-remote.mjs --serve       # stay up for manual use
//
// Options (environment fallbacks in parentheses):
//   --ssh-user/--ssh-password (SIM_SSH_USER/SIM_SSH_PASSWORD)  the one credential pair accepted
//   --workspace-fixture <file> (SIM_WORKSPACE_FIXTURE)          body served for
//                                                             `storages/workspace.json`, so a test can
//                                                             choose the remote sessions it wants
//   --state-file <file> (SIM_STATE_FILE)                        where ports/pid are published; the
//                                                             default is e2e/sim/.state.json
//
// While serving it writes its state file (ports, host key fingerprint) so other
// tooling can point at it: E2E_SSH_ADDRESS=127.0.0.1:<sshPort>. Parallel test
// files pass their own --state-file so they never race on the default path.
//
// The command answers below are NOT a permissive fake: `respond()` recognises
// the plugin's real command shapes by their leading tokens and returns the
// exact wire format each caller parses. Anything else exits 127 with a stderr
// line, so a drifted command set shows up loudly instead of silently "passing".
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
import { buildProbeScript, parseProbeOutput, toProbeFacts } from '../../src/probe.js'
import { assertSupportedRemote } from '../../src/bootstrap.js'

const { Server: SshServer, Client: SshClient, utils } = ssh2

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_STATE_FILE = path.join(HERE, '.state.json')

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const selfTest = args['self-test'] === true
const serve = args['serve'] === true || !selfTest

/**
 * State file: the repository default, or the path the caller chose. A custom
 * path keeps two simulators (e.g. test files running in parallel) from racing on
 * one file, and still lets each one clean up only what it published.
 * @returns {string}
 */
function resolveStateFile() {
  const requested = args['state-file'] ?? process.env.SIM_STATE_FILE ?? null
  if (requested === null) return DEFAULT_STATE_FILE
  if (typeof requested !== 'string' || requested.trim() === '') {
    console.error('[sim] --state-file needs a file path')
    process.exit(2)
  }
  return path.resolve(requested)
}

const STATE_FILE = resolveStateFile()

/**
 * The single credential pair the simulator accepts (override with
 * --ssh-user/--ssh-password or SIM_SSH_USER/SIM_SSH_PASSWORD). Anything else is
 * rejected: the listener is a simulator, not a credential-free proxy.
 */
const SIM = {
  username: String(args['ssh-user'] ?? process.env.SIM_SSH_USER ?? 'sim'),
  password: String(args['ssh-password'] ?? process.env.SIM_SSH_PASSWORD ?? 'sim'),
  home: '/home/sim',
  shell: '/bin/bash',
  nodeVersion: 'v24.21.0',
  npmVersion: '11.28.9',
  nodePath: '/home/sim/.nvm/versions/node/v24.21.0/bin/node',
  dshVersion: '0.2.2-rc.1',
  dshPath: '/home/sim/.local/bin/dsh',
  curlPath: '/usr/bin/curl',
  tarPath: '/usr/bin/tar',
  sha256Path: '/usr/bin/sha256sum',
  diskFreeKb: '35000000',
  /** Launch token printed in the simulated `dsh web:` readiness line. */
  token: 'sim-token-0123456789abcdef',
}

/** @typedef {{ code: number, stdout: string, stderr: string }} CommandResult */
/** @typedef {{ remotePort: number, pid: number, started: boolean, token: string }} SimState */

// ---------------------------------------------------------------------------
// Isolation guards: this is a simulator that must never be mistaken for, or
// interfere with, the developer's real environment.
// ---------------------------------------------------------------------------
{
  const host = String(args.host ?? '127.0.0.1')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    console.error(`[sim] refusing to bind ${host}: the simulator only listens on loopback`)
    process.exit(2)
  }
  if (SIM.password.length < 1) {
    console.error('[sim] refusing an empty SSH password: set --ssh-password or SIM_SSH_PASSWORD')
    process.exit(2)
  }
  const dshHome = process.env.DSH_HOME ?? ''
  if (dshHome && !dshHome.toLowerCase().includes('sim')) {
    console.warn(`[sim] note: DSH_HOME is set (${dshHome}); the simulator never reads or writes it`)
  }
  if (process.env.E2E_SSH_ADDRESS && !process.env.E2E_SSH_ADDRESS.includes('127.0.0.1')) {
    console.warn(
      `[sim] note: E2E_SSH_ADDRESS already points at ${process.env.E2E_SSH_ADDRESS}; using the simulator from the same shell would override the real target`,
    )
  }
}

// ---------------------------------------------------------------------------
// Command answers
// ---------------------------------------------------------------------------

/**
 * Exactly the `key<TAB>value` lines `buildProbeScript()` prints, with values
 * that satisfy the plugin's own parsing and OS gate.
 * @returns {string}
 */
function probeOutput() {
  /** @type {Array<[string, string]>} */
  const lines = [
    ['os', 'Linux'],
    ['arch', 'x86_64'],
    ['os_name', 'Ubuntu 24.04.1 LTS'],
    ['user', SIM.username],
    ['home', SIM.home],
    ['shell', SIM.shell],
    ['node_path', SIM.nodePath],
    ['node_version', SIM.nodeVersion],
    ['npm_path', '/home/sim/.nvm/versions/node/v24.21.0/bin/npm'],
    ['npm_version', SIM.npmVersion],
    ['npx_path', '/home/sim/.nvm/versions/node/v24.21.0/bin/npx'],
    ['dsh_path', SIM.dshPath],
    ['dsh_version', SIM.dshVersion],
    ['curl_path', SIM.curlPath],
    ['tar_path', SIM.tarPath],
    ['sha256_path', SIM.sha256Path],
    ['disk_free_kb', SIM.diskFreeKb],
    ['ssh_connection', 'yes'],
    ['isolated_node_path', ''],
    ['isolated_node_version', ''],
    ['isolated_dsh_bin_path', ''],
    ['isolated_dsh_version', ''],
    ['remote_dir_exists', 'no'],
    ['home_exists', 'yes'],
    ['credentials_file', 'no'],
    ['deepseek_key_env', 'no'],
    ['provider_env_keys', ''],
    ['run_registry', ''],
  ]
  return lines.map(([key, value]) => `${key}\t${value}\n`).join('')
}

/**
 * @typedef {{
 *   json: string,
 *   fixturePath: string | null,
 *   workspaceCount: number,
 *   sessionCount: number,
 * }} WorkspaceAnswer
 */

/** Registry served when the caller names no fixture. */
const DEFAULT_WORKSPACE_REGISTRY = {
  version: 2,
  global: { initialized: true, defaultWorkspaceId: 'ws-sim', workspaceIds: ['ws-sim'] },
  tables: {
    workspaces: {
      'ws-sim': {
        path: '/home/sim/project',
        title: 'sim-project',
        sessionIds: ['sess-sim-1', 'sess-sim-2'],
        createdAt: '2026-11-11T00:00:00Z',
        updatedAt: '2026-11-11T00:00:00Z',
      },
    },
  },
}

/**
 * Summarize a registry for the startup log and the state file. The bytes served
 * to the plugin are the registry itself, so `readRemoteWorkspaces()` parses
 * exactly what the test wrote.
 * @param {any} registry
 * @param {string | null} fixturePath
 * @returns {WorkspaceAnswer}
 */
function describeWorkspaceRegistry(registry, fixturePath) {
  const table = registry?.tables?.workspaces
  const entries = table && typeof table === 'object' && !Array.isArray(table) ? Object.values(table) : []
  const workspaces = entries.filter((entry) => entry && typeof entry === 'object')
  const sessionCount = workspaces.reduce(
    (total, entry) => total + (Array.isArray(entry.sessionIds) ? entry.sessionIds.length : 0),
    0,
  )
  return { json: `${JSON.stringify(registry)}\n`, fixturePath, workspaceCount: workspaces.length, sessionCount }
}

/**
 * Resolve the `storages/workspace.json` answer: the built-in registry, or the
 * fixture file the caller named. A broken fixture exits loudly instead of
 * falling back, so a drifted test cannot silently "pass" against other sessions.
 * @returns {WorkspaceAnswer}
 */
function loadWorkspaceAnswer() {
  const requested = args['workspace-fixture'] ?? process.env.SIM_WORKSPACE_FIXTURE ?? null
  if (requested === null) return describeWorkspaceRegistry(DEFAULT_WORKSPACE_REGISTRY, null)
  if (typeof requested !== 'string' || requested.trim() === '') {
    console.error('[sim] --workspace-fixture needs a file path')
    process.exit(2)
  }
  const resolved = path.resolve(requested)
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    fatal(`workspace fixture ${resolved}`, error)
  }
  const table = parsed?.tables?.workspaces
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !table ||
    typeof table !== 'object' ||
    Array.isArray(table)
  ) {
    console.error(
      `[sim] workspace fixture ${resolved} is not a DSH Workspace registry (expected {"tables":{"workspaces":{...}}})`,
    )
    process.exit(2)
  }
  return describeWorkspaceRegistry(parsed, resolved)
}

const WORKSPACE = loadWorkspaceAnswer()

/** @param {SimState} sim @returns {string} */
function webLine(sim) {
  return `dsh web: http://127.0.0.1:${sim.remotePort}/?token=${sim.token}`
}

/** @param {SimState} sim @returns {string} */
function runRegistry(sim) {
  return JSON.stringify({
    pid: sim.pid,
    port: sim.remotePort,
    startedAt: '2026-11-11T00:00:00Z',
    profile: 'web',
    version: SIM.dshVersion,
  })
}

/**
 * The simulated remote `dsh web` is the stub HTTP server that is already
 * listening, so the start script only has to report it the way the real one
 * does: pid, readiness line, and the `DONE:` summary.
 * @param {SimState} sim @returns {string}
 */
function startScriptAnswer(sim) {
  if (sim.pid === 0) sim.pid = 40_000 + (sim.remotePort % 1_000)
  sim.started = true
  return `PID:${sim.pid}\nLINE:${webLine(sim)}\nDONE:${sim.pid}:${sim.remotePort}\n`
}

/**
 * Recognise one command by its leading tokens (never by a substring: the probe
 * script mentions `/etc/os-release`, `cat`, `curl` and friends all over its
 * body, so a substring test would hijack the whole script).
 * @param {string} command
 * @param {SimState} sim
 * @returns {CommandResult | null}
 */
function respond(command, sim) {
  const cmd = command.trim()
  /** @param {string} stdout @returns {CommandResult} */
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' })

  // 1. The one compound probe (src/probe.js buildProbeScript): its first line
  //    is `set -u` and the first assignment is DIR=.
  if (cmd.startsWith('set -u\nDIR=') || (cmd.startsWith('set -u\n') && cmd.includes('\ndsh_path\t'))) {
    return ok(probeOutput())
  }

  // 2. Detached remote web start (src/webapp.js buildStartScript).
  if (cmd.startsWith('set -eu\n') && cmd.includes('dsh web:') && cmd.includes('DONE:')) {
    return ok(startScriptAnswer(sim))
  }

  // 3. Remote web stop (src/webapp.js stopRemoteWeb).
  if (cmd.startsWith('set -u\nPID=') && cmd.includes('STOPPED')) {
    sim.started = false
    sim.pid = 0
    return ok('STOPPED\n')
  }

  // 4. Workspace registry read (src/workspaces.js readRemoteWorkspaces).
  if (/^cat '[^']*\/storages\/workspace\.json'/.test(cmd)) {
    return ok(WORKSPACE.json)
  }

  // 5. Run registry read (src/webapp.js readRunRegistry).
  if (/^cat '[^']*\/run\/web\.json'/.test(cmd)) {
    return ok(sim.started ? `${runRegistry(sim)}\n` : '')
  }

  // 6. Remote loopback HTTP status (src/webapp.js remoteHttpStatus).
  if (cmd.startsWith('curl ') && cmd.includes("-w '%{http_code}'")) {
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(cmd)?.[1] ?? 0)
    return ok(port === sim.remotePort ? '200' : '000')
  }

  // 7. Last readiness line from the remote log (src/webapp.js readWebLineFromLog).
  if (cmd.startsWith("grep 'dsh web:'")) {
    return ok(sim.started ? `${webLine(sim)}\n` : '')
  }

  // 8. Remote log tail (src/webapp.js tailRemoteLog).
  if (/^tail -n \d+ /.test(cmd)) {
    return ok(sim.started ? `${webLine(sim)}\n` : '')
  }

  // 9. Liveness check (src/webapp.js remotePidAlive).
  const pidProbe = /^kill -0 (\d+) 2>\/dev\/null && echo alive/.exec(cmd)
  if (pidProbe) {
    const alive = sim.started && Number(pidProbe[1]) === sim.pid
    return ok(alive ? 'alive\n' : '')
  }

  // 10. Single-command convenience answers (not used by the current plugin).
  if (/^uname -a$/.test(cmd)) {
    return ok('Linux simulated-remote 6.1.0 #1 SMP x86_64 GNU/Linux\n')
  }
  const tool = /^command -v ([\w-]+)$/.exec(cmd)
  if (tool) return ok(`/usr/local/bin/${tool[1]}\n`)
  const version = /^(node|npm|npx|dsh) --version$/.exec(cmd)
  if (version) {
    const value = version[1] === 'node' ? SIM.nodeVersion : version[1] === 'dsh' ? SIM.dshVersion : SIM.npmVersion
    return ok(`${value}\n`)
  }

  return null
}

/** One-line command summary for the loud unknown-command failure. */
function describeCommand(command) {
  const firstLine = command.trim().split('\n')[0] ?? ''
  const more = command.includes('\n') ? ` (+${command.split('\n').length - 1} more lines)` : ''
  return `${firstLine.slice(0, 120)}${more}`
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

/** @param {number} ms @param {string} label @returns {Promise<never>} */
function timeoutAfter(ms, label) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutAfter(ms, label)])
}

/**
 * Delete the state file only when it belongs to this process, so a second sim
 * started from the same shell is never clobbered.
 */
function removeOwnStateFile() {
  try {
    if (!existsSync(STATE_FILE)) return
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (Number(state?.pid) === process.pid) rmSync(STATE_FILE, { force: true })
  } catch {
    /* best effort: the state file is disposable */
  }
}

/** @param {string} what @param {unknown} error */
function fatal(what, error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[sim] ${what} failed: ${message}`)
  removeOwnStateFile()
  process.exit(2)
}

/** Stand-in for the remote DSH web UI: only what the smoke path touches. */
function startRemoteWeb() {
  const server = createHttpServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, simulated: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>simulated remote DSH</title><h1>simulated remote DSH</h1>')
  })
  // A port clash must not print a stack trace or leave a stale .state.json.
  server.once('error', (error) => fatal('remote-web listener', error))
  return new Promise((resolve) => {
    server.listen(Number(args['remote-port'] ?? 0), '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port })
    })
  })
}

/**
 * Start the simulated host.
 * @returns {Promise<{
 *   sshPort: number,
 *   remotePort: number,
 *   fingerprint: string,
 *   close: () => Promise<void>,
 *   sim: SimState,
 * }>}
 */
async function startSimulatedRemote() {
  const remote = await startRemoteWeb()
  const hostKey = utils.generateKeyPairSync('ed25519').private
  // Informational only: what a client would see as the host key fingerprint.
  const parsedKey = utils.parseKey(hostKey)
  const publicBlob = typeof parsedKey?.getPublicSSH === 'function' ? parsedKey.getPublicSSH() : Buffer.from(hostKey)
  const fingerprint = `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`

  /** @type {SimState} */
  const sim = { remotePort: remote.port, pid: 0, started: false, token: SIM.token }
  /**
   * ssh2's `Server` emits `connection` with its own ServerConnection wrapper
   * (it has `end()`, and a private `_sock` for the raw socket), so track those
   * and tear them down explicitly; otherwise `close()` can wait forever.
   * @type {Set<any>}
   */
  const connections = new Set()
  /** @type {Set<import('node:net').Socket>} */
  const tunnelSockets = new Set()
  let closed = false

  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      const matches = ctx.method === 'password' && ctx.username === SIM.username && ctx.password === SIM.password
      if (matches) return ctx.accept()
      // Only advertise the one method the simulator accepts; never log secrets.
      if (ctx.method === 'password') {
        console.warn(`[sim] rejected SSH authentication for user ${JSON.stringify(ctx.username)}`)
      }
      return ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          const result = respond(info.command, sim)
          if (result === null) {
            stream.stderr.write(`simulated-remote: command not simulated: ${describeCommand(info.command)}\n`)
            stream.exit(127)
            stream.end()
            return
          }
          if (result.stdout) stream.write(result.stdout)
          if (result.stderr) stream.stderr.write(result.stderr)
          stream.exit(result.code)
          stream.end()
        })
      })
      // The tunnel: a client forwardOut() arrives here as a `tcpip` request.
      // Only the simulated remote web port is reachable, so this endpoint can
      // never be used as a credential-free proxy to other local services.
      client.on('tcpip', (accept, reject, info) => {
        if (typeof accept !== 'function') return reject?.()
        const destIP = String(info.destIP ?? '')
        const destPort = Number(info.destPort)
        if (destIP !== '127.0.0.1' || destPort !== sim.remotePort) {
          console.warn(`[sim] rejected tunnel to ${destIP}:${destPort}; only 127.0.0.1:${sim.remotePort} is reachable`)
          return reject()
        }
        const stream = accept()
        const socket = netConnect(destPort, '127.0.0.1')
        socket.setTimeout(10_000, () => socket.destroy(new Error('tunnel socket idle timeout')))
        tunnelSockets.add(socket)
        socket.once('close', () => tunnelSockets.delete(socket))
        socket.on('error', () => stream.close())
        stream.on('error', () => socket.destroy())
        socket.pipe(stream).pipe(socket)
      })
    })
  })
  server.on('connection', (connection) => {
    connections.add(connection)
    connection.once('close', () => connections.delete(connection))
  })
  server.once('error', (error) => fatal('ssh listener', error))
  await new Promise((resolve) => server.listen(Number(args.port ?? 0), '127.0.0.1', resolve))
  const sshPort = server.address().port

  /** Close both listeners, destroying live connections so nothing can hang. */
  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of tunnelSockets) socket.destroy()
    tunnelSockets.clear()
    for (const connection of connections) {
      try {
        connection.end()
        // Guarded private access: ssh2 exposes no public socket teardown, and
        // `end()` alone can leave a half-open socket that keeps `close` waiting.
        connection._sock?.destroy?.()
      } catch {
        /* already gone */
      }
    }
    connections.clear()
    remote.server.closeAllConnections?.()
    await withTimeout(
      Promise.all([
        new Promise((resolve) => server.close(() => resolve(undefined))),
        new Promise((resolve) => remote.server.close(() => resolve(undefined))),
      ]),
      10_000,
      'shutdown',
    )
  }

  return { sshPort, remotePort: remote.port, fingerprint, close, sim }
}

// ---------------------------------------------------------------------------
// Self-test: drive the simulator with the plugin's own code paths.
// ---------------------------------------------------------------------------

/** @param {boolean} condition @param {string} message */
function expect(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * @param {number} sshPort
 * @param {{ username?: string, password?: string }} [credentials]
 * @returns {Promise<InstanceType<typeof SshClient>>}
 */
function connectClient(sshPort, credentials = {}) {
  const client = new SshClient()
  const ready = new Promise((resolve, reject) => {
    client
      .once('ready', resolve)
      .once('error', reject)
      .connect({
        host: '127.0.0.1',
        port: sshPort,
        username: credentials.username ?? SIM.username,
        password: credentials.password ?? SIM.password,
        readyTimeout: 8_000,
      })
  })
  return withTimeout(ready, 15_000, 'SSH connect').then(() => client)
}

/**
 * @param {InstanceType<typeof SshClient>} client
 * @param {string} command
 */
function execOver(client, command) {
  const call = new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk) => (stdout += chunk.toString('utf8')))
      stream.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
      stream.on('close', (code) => resolve({ code: code ?? null, stdout, stderr }))
      stream.on('error', reject)
    })
  })
  return withTimeout(call, 20_000, 'SSH exec')
}

/** @param {InstanceType<typeof SshClient>} client @param {number} destPort */
function forwardOver(client, destPort) {
  const call = new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 40_000, '127.0.0.1', destPort, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
  return withTimeout(call, 15_000, 'SSH forwardOut')
}

/**
 * @param {import('node:stream').Duplex} stream
 * @param {string} request
 * @returns {Promise<string>}
 */
function httpOver(stream, request) {
  const call = new Promise((resolve, reject) => {
    let response = ''
    stream.on('data', (chunk) => (response += chunk.toString('utf8')))
    stream.on('close', () => resolve(response))
    stream.on('error', reject)
    stream.write(request)
  })
  return withTimeout(call, 15_000, 'tunneled HTTP request')
}

/** Assert that a wrong password is refused. */
async function assertAuthRejected(sshPort) {
  const client = new SshClient()
  const outcome = new Promise((resolve) => {
    client.once('ready', () => resolve(new Error('the simulator accepted a wrong password')))
    client.once('error', (error) => resolve(error))
    client.connect({
      host: '127.0.0.1',
      port: sshPort,
      username: SIM.username,
      password: `${SIM.password}-wrong`,
      readyTimeout: 8_000,
    })
  })
  const error = await withTimeout(outcome, 20_000, 'expected SSH auth rejection')
  client.end()
  expect(error instanceof Error, 'wrong-password login produced no error')
  expect(/authentication|configured authentication/i.test(error.message), `unexpected auth error: ${error.message}`)
  return error.message
}

/** Assert that the tunnel only opens to the simulated remote web port. */
async function assertTunnelRejected(client, remotePort) {
  const outcome = new Promise((resolve) => {
    client.forwardOut('127.0.0.1', 40_000, '127.0.0.1', remotePort + 1, (error) => resolve(error ?? null))
  })
  const error = await withTimeout(outcome, 15_000, 'expected tunnel rejection')
  expect(error instanceof Error, 'a forwardOut to a foreign local port was accepted')
  return error.message
}

/** Run the smoke path against the simulated host with a real SSH client. */
async function runSelfTest(host) {
  const client = await connectClient(host.sshPort)

  // 1. The plugin's real probe script must produce supported facts.
  const probe = await execOver(client, buildProbeScript('~/.dsh/remote-go'))
  expect(probe.code === 0, `probe exited ${probe.code}: ${probe.stderr.trim()}`)
  const facts = toProbeFacts(parseProbeOutput(probe.stdout))
  expect(facts.os === 'Linux', `probe os = ${JSON.stringify(facts.os)}`)
  expect(facts.arch === 'x86_64', `probe arch = ${JSON.stringify(facts.arch)}`)
  expect(facts.sshConnection === true, 'probe did not report an SSH session')
  expect(facts.home === SIM.home, `probe home = ${JSON.stringify(facts.home)}`)
  expect(facts.nodePath === SIM.nodePath, `probe node_path = ${JSON.stringify(facts.nodePath)}`)
  assertSupportedRemote(facts)

  // 2. The tunnel must reach the simulated remote web.
  const stream = await forwardOver(client, host.remotePort)
  const health = await httpOver(stream, 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
  expect(health.includes('"simulated":true'), `unexpected tunnel response: ${JSON.stringify(health.slice(0, 120))}`)

  // 3. Both isolation guards must reject.
  const tunnelError = await assertTunnelRejected(client, host.remotePort)
  const authError = await assertAuthRejected(host.sshPort)

  client.end()
  return {
    probe: `os=${facts.os} arch=${facts.arch} ssh=${facts.sshConnection}`,
    tunnel: 'GET /api/health 200',
    authGuard: authError,
    tunnelGuard: tunnelError,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (serve || selfTest) {
  const host = await startSimulatedRemote()
  mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ simulated: true, sshHost: '127.0.0.1', sshPort: host.sshPort, remotePort: host.remotePort, fingerprint: host.fingerprint, pid: process.pid, workspaceFixture: WORKSPACE.fixturePath }, null, 2)}\n`,
    'utf8',
  )
  console.log('[sim] SIMULATED remote host — not a real machine; touches only its state file and the workspace fixture')
  console.log(`[sim] ssh 127.0.0.1:${host.sshPort}  remote-web 127.0.0.1:${host.remotePort}  ${host.fingerprint}`)
  console.log(
    `[sim] workspace registry: ${WORKSPACE.fixturePath ?? 'built-in'} — ${WORKSPACE.workspaceCount} workspace(s), ${WORKSPACE.sessionCount} session(s)`,
  )
  console.log(`[sim] state file: ${STATE_FILE}`)
  console.log(`[sim] E2E_SSH_ADDRESS=127.0.0.1:${host.sshPort}   (use it in a dedicated shell only)`)

  // Every exit path must leave no stale state file behind.
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    removeOwnStateFile()
  }
  process.once('exit', cleanup)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanup()
      console.log(`[sim] ${signal}: closing the simulated host`)
      const hardExit = setTimeout(() => process.exit(0), 3_000)
      hardExit.unref?.()
      void host.close().finally(() => process.exit(0))
    })
  }

  if (selfTest) {
    const result = await runSelfTest(host)
    console.log(`[sim] self-test probe (plugin buildProbeScript): ${result.probe}`)
    console.log(`[sim] self-test tunnel (plugin forwardOut):       ${result.tunnel}`)
    console.log(`[sim] self-test auth guard:   rejected → ${result.authGuard}`)
    console.log(`[sim] self-test tunnel guard: rejected → ${result.tunnelGuard}`)
    await host.close()
    console.log('[sim] PASS')
    process.exit(0)
  }

  console.log('[sim] serving; Ctrl+C to stop')
}

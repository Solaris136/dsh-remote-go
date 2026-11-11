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
// While serving it writes e2e/sim/.state.json (ports, host key fingerprint) so
// other tooling can point at it: E2E_SSH_ADDRESS=127.0.0.1:<sshPort>.
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const { Server: SshServer, Client: SshClient, utils } = ssh2

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE = path.join(HERE, '.state.json')

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
  return new Promise((resolve) => {
    server.listen(Number(args['remote-port'] ?? 0), '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port })
    })
  })
}

/**
 * Fixed, whitelisted answers for the probe commands the plugin actually runs.
 * Anything unknown fails loudly so a drifted command set shows up immediately
 * instead of silently "passing" against a permissive fake.
 * @param {string} command
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function respond(command) {
  const cmd = command.trim()
  if (/^uname\b/.test(cmd))
    return { code: 0, stdout: 'Linux simulated-remote 6.1.0 #1 SMP x86_64 GNU/Linux\n', stderr: '' }
  if (/\/etc\/os-release/.test(cmd)) {
    return { code: 0, stdout: 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n', stderr: '' }
  }
  if (/command -v (node|npm|npx|curl|tar|sha256sum|dsh)\b/.test(cmd)) {
    const tool = cmd.match(/command -v (\w+)/)?.[1] ?? ''
    return { code: 0, stdout: `/usr/local/bin/${tool}\n`, stderr: '' }
  }
  if (/^(node|npm|npx|dsh) --version$/.test(cmd)) {
    const tool = cmd.split(' ')[0]
    const version = tool === 'node' ? 'v24.9.0' : tool === 'dsh' ? '0.2.2-rc.1' : '11.0.0'
    return { code: 0, stdout: `${version}\n`, stderr: '' }
  }
  return { code: 127, stdout: '', stderr: `simulated-remote: command not simulated: ${cmd}\n` }
}

/**
 * Start the simulated host.
 * @returns {Promise<{ sshPort: number, remotePort: number, fingerprint: string, close: () => Promise<void> }>}
 */
async function startSimulatedRemote() {
  const remote = await startRemoteWeb()
  const hostKey = utils.generateKeyPairSync('ed25519').private
  // Informational only: what a client would see as the host key fingerprint.
  const parsedKey = utils.parseKey(hostKey)
  const publicBlob = typeof parsedKey?.getPublicSSH === 'function' ? parsedKey.getPublicSSH() : Buffer.from(hostKey)
  const fingerprint = `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`

  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          const result = respond(info.command)
          if (result.stdout) stream.write(result.stdout)
          if (result.stderr) stream.stderr.write(result.stderr)
          stream.exit(result.code)
          stream.end()
        })
      })
      // The tunnel: a client forwardOut() arrives here as a `tcpip` request.
      client.on('tcpip', (accept, reject, info) => {
        if (typeof accept !== 'function') return reject?.()
        const stream = accept()
        const socket = netConnect(Number(info.destPort), '127.0.0.1')
        socket.on('error', () => stream.close())
        stream.on('error', () => socket.destroy())
        socket.pipe(stream).pipe(socket)
      })
    })
  })
  await new Promise((resolve) => server.listen(Number(args.port ?? 0), '127.0.0.1', resolve))
  const sshPort = server.address().port

  /** @type {{ close: () => Promise<void> }} */
  const close = async () => {
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => remote.server.close(resolve))
  }

  return { sshPort, remotePort: remote.port, fingerprint, close }
}

/** Run the smoke path against the simulated host with a real SSH client. */
async function runSelfTest(host) {
  const client = new SshClient()
  const execOutput = await new Promise((resolve, reject) => {
    client
      .on('ready', () => {
        client.exec('uname -a', (error, stream) => {
          if (error) return reject(error)
          let stdout = ''
          stream.on('data', (chunk) => (stdout += chunk.toString('utf8')))
          stream.on('close', () => resolve(stdout))
        })
      })
      .on('error', reject)
      .connect({ host: '127.0.0.1', port: host.sshPort, username: 'sim', password: 'sim', readyTimeout: 8000 })
  })
  if (!/Linux simulated-remote/.test(execOutput))
    throw new Error(`unexpected exec output: ${JSON.stringify(execOutput)}`)

  // Prove the tunnel: forwardOut to the "remote" web, then speak HTTP over it.
  const health = await new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 40000, '127.0.0.1', host.remotePort, (error, stream) => {
      if (error) return reject(error)
      let response = ''
      stream.on('data', (chunk) => (response += chunk.toString('utf8')))
      stream.on('close', () => resolve(response))
      stream.on('error', reject)
      stream.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    })
  })
  client.end()
  if (!health.includes('"simulated":true'))
    throw new Error(`unexpected tunnel response: ${JSON.stringify(health.slice(0, 120))}`)
  return { exec: execOutput.trim(), tunnel: 'GET /api/health 200' }
}

if (serve || selfTest) {
  const host = await startSimulatedRemote()
  mkdirSync(HERE, { recursive: true })
  writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ simulated: true, sshHost: '127.0.0.1', sshPort: host.sshPort, remotePort: host.remotePort, fingerprint: host.fingerprint, pid: process.pid }, null, 2)}\n`,
    'utf8',
  )
  console.log(`[sim] SIMULATED remote host — not a real machine, writes nothing outside e2e/sim/`)
  console.log(`[sim] ssh 127.0.0.1:${host.sshPort}  remote-web 127.0.0.1:${host.remotePort}  ${host.fingerprint}`)
  console.log(`[sim] E2E_SSH_ADDRESS=127.0.0.1:${host.sshPort}   (use it in a dedicated shell only)`)

  if (selfTest) {
    const result = await runSelfTest(host)
    console.log(`[sim] self-test exec:   ${result.exec}`)
    console.log(`[sim] self-test tunnel: ${result.tunnel}`)
    await host.close()
    if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, '{}\n', 'utf8')
    console.log('[sim] PASS')
    process.exit(0)
  }

  console.log('[sim] serving; Ctrl+C to stop')
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SshConnection } from '../../dist/src/ssh.js'
import { buildProbeScript, parseProbeOutput, probeRemote, toProbeFacts } from '../../dist/src/probe.js'
import { assertSupportedRemote, planNpx } from '../../dist/src/bootstrap.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SIM_SCRIPT = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')
const STATE_FILE = path.join(ROOT, 'e2e', 'sim', '.state.json')
const CREDENTIALS = { username: 'sim', password: 'sim' }
function tail(lines) {
  return lines.slice(-12).join('')
}
function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
async function waitForState(child, logs, timeoutMs = 30_000) {
  const started = Date.now()
  while (true) {
    if (child.exitCode !== null) throw new Error(`simulator exited early (${child.exitCode})\n${tail(logs)}`)
    if (existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
        if (Number(state.pid) === child.pid && Number(state.sshPort) > 0 && Number(state.remotePort) > 0) {
          return state
        }
      } catch {}
    }
    if (Date.now() - started > timeoutMs) throw new Error(`simulator state never appeared\n${tail(logs)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
async function startSimulator() {
  rmSync(STATE_FILE, { force: true })
  const logs = []
  const child = spawn(process.execPath, [SIM_SCRIPT, '--serve'], {
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
  const state = await waitForState(child, logs)
  return { child, state, logs }
}
async function stopSimulator(child) {
  if (child.exitCode !== null) return true
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let stopped = false
  try {
    child.kill('SIGTERM')
    stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
    ])
    if (!stopped) {
      child.kill('SIGKILL')
      stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])
    }
  } catch {
    stopped = child.exitCode !== null
  }
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (Number(state.pid) === child.pid) rmSync(STATE_FILE, { force: true })
  } catch {}
  return stopped || child.exitCode !== null
}
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

test('simulated remote host serves the plugin probe and the loopback tunnel', { timeout: 180_000 }, async (t) => {
  const { child, state, logs } = await startSimulator()
  const ssh = new SshConnection({
    host: '127.0.0.1',
    port: state.sshPort,
    username: CREDENTIALS.username,
    auth: { type: 'password', password: CREDENTIALS.password },
    acceptUnknownHostKey: true,
    readyTimeoutMs: 10_000,
    keepaliveIntervalMs: 15_000,
  })
  try {
    await ssh.connect()
    await t.test('answers the real probe script with supported facts', async () => {
      const result = await ssh.exec(buildProbeScript(), { timeoutMs: 30_000 })
      assert.equal(result.code, 0, `probe exited ${result.code}: ${result.stderr}`)
      const facts = toProbeFacts(parseProbeOutput(result.stdout))
      assert.equal(facts.os, 'Linux')
      assert.equal(facts.arch, 'x86_64')
      assert.equal(facts.user, 'sim')
      assert.equal(facts.home, '/home/sim')
      assert.equal(facts.sshConnection, true)
      assert.ok(facts.nodePath, 'node_path was empty')
      assert.ok(facts.npxPath, 'npx_path was empty')
      assert.ok(facts.curlPath, 'curl_path was empty')
      assert.doesNotThrow(() => assertSupportedRemote(facts))
      const plan = planNpx({ facts, targetVersion: '0.2.2-rc.1', profile: 'web' })
      assert.equal(plan.level, 'npx')
      const remote = await probeRemote(ssh, { timeoutMs: 30_000 })
      assert.equal(remote.os, 'Linux')
      assert.equal(remote.arch, 'x86_64')
      assert.equal(remote.sshConnection, true)
    })
    await t.test('forwardOut to the simulated remote port reaches the stub web', async () => {
      const stream = await withTimeout(ssh.forwardOut('127.0.0.1', state.remotePort), 15_000, 'forwardOut')
      try {
        const response = await httpOver(
          stream,
          'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
        )
        assert.match(response, /HTTP\/1\.1 200/)
        assert.match(response, /"simulated":true/)
      } finally {
        stream.destroy()
      }
    })
    await t.test('refuses any destination outside the single allowed loopback port', async () => {
      const forbidden = [
        { host: '127.0.0.1', port: state.remotePort + 1, label: 'foreign-port forwardOut' },
        { host: '192.0.2.1', port: state.remotePort, label: 'foreign-host forwardOut' },
      ]
      for (const destination of forbidden) {
        await assert.rejects(
          withTimeout(ssh.forwardOut(destination.host, destination.port), 15_000, destination.label),
          `forwardOut to ${destination.host}:${destination.port} should have been refused`,
        )
      }
    })
    await t.test('refuses a wrong password', async () => {
      const rogue = new SshConnection({
        host: '127.0.0.1',
        port: state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password', password: `${CREDENTIALS.password}-wrong` },
        acceptUnknownHostKey: true,
        readyTimeoutMs: 10_000,
      })
      try {
        await assert.rejects(rogue.connect(), (error) => {
          assert.ok(error instanceof Error)
          assert.equal(/** @type {any} */ error.code, 'auth')
          return true
        })
      } finally {
        await rogue.dispose()
      }
    })
  } finally {
    await ssh.dispose()
    const stopped = await stopSimulator(child)
    assert.equal(stopped, true, `the simulator was not stopped\n${tail(logs)}`)
  }
})

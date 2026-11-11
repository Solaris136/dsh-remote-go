/**
 * End-to-end coverage for "remote sessions appear as local sessions": the P0 L1
 * directory mirror, driven through the plugin's real code paths against the
 * repository's simulated remote host (e2e/sim) — no real SSH machine required.
 *
 * Proven here: a real ssh2 client → the simulated sshd → the real probe → the
 * real detached remote start → the real loopback tunnel → the real token
 * exchange → the real `readRemoteWorkspaces()` of a configurable fixture →
 * `planMirror()` → `MirrorStore` (mirrors.json) → `listHostMirrors()` →
 * `GET /hosts/:id/mirrors`, plus the local landing of those mirrors: one
 * `ctx.sessions` session per descriptor and one `ctx.workspaceRegistry`
 * workspace per host whose canonical-cwd membership lists exactly those
 * sessions.
 *
 * Not provable here: that a real DSH sidebar renders the group (the sidebar is a
 * browser component of a real DSH Host and the simulator only stubs the remote
 * web). What is proven is the registry state the sidebar reads: a workspace at
 * the mirror directory whose `sessionIds` is the set of mirrored sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createApi } from '../../src/api.js'
import { DEFAULT_REMOTE_DIR } from '../../src/constants.js'
import { remoteLayout } from '../../src/layout.js'
import { l1Capabilities, mirrorSessionId, planMirror } from '../../src/mirror.js'
import { MirrorStore, MIRROR_STORE_VERSION } from '../../src/mirror-store.js'
import { probeRemote } from '../../src/probe.js'
import { RemoteGoService } from '../../src/service.js'
import { canonicalMirrorRoot, createSessionAdapter } from '../../src/session-adapter.js'
import { SshConnection } from '../../src/ssh.js'
import { HostStore } from '../../src/store.js'
import { createWorkspaceAdapter } from '../../src/workspace-adapter.js'
import { readRemoteWorkspaces, remoteWorkspaceStoragePath } from '../../src/workspaces.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SIM_SCRIPT = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')
const FIXTURE_FILE = path.join(ROOT, 'e2e', 'sim', 'fixtures', 'workspace.two-workspaces.json')

/** The single credential pair the simulator accepts (its defaults). */
const CREDENTIALS = { username: 'sim', password: 'sim' }

/** The canonical L1 capability set: the directory was read, nothing more. */
const L1_CAPABILITIES = { list: true, history: false, stream: false, input: false, approve: false }

/**
 * The remote sessions the fixture declares, in the canonical mirror order
 * (workspaceId, then remoteSessionId). `baseTitle` is what the workspace
 * registry itself provides: an explicit title, or the path basename.
 * @type {{ workspaceId: string, remoteSessionId: string, baseTitle: string }[]}
 */
const FIXTURE_SESSIONS = [
  { workspaceId: 'ws-sim-alpha', remoteSessionId: 'sess-alpha-one', baseTitle: 'Alpha project' },
  { workspaceId: 'ws-sim-alpha', remoteSessionId: 'sess-omega-two', baseTitle: 'Alpha project' },
  { workspaceId: 'ws-sim-beta', remoteSessionId: 'sess-beta-three', baseTitle: 'beta' },
]

/** @param {string[]} lines */
function tail(lines) {
  return lines.slice(-16).join('')
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Collect plugin log lines instead of writing them to the test output; a failure
 * message can then include the tail that explains it.
 * @param {string[]} lines
 */
function createLogger(lines) {
  /**
   * @param {string} level
   * @returns {(...args: unknown[]) => void}
   */
  const write =
    (level) =>
    (...args) => {
      const text = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
      lines.push(`[${level}] ${text}`)
    }
  return { info: write('info'), warn: write('warn'), debug: write('debug'), error: write('error') }
}

/**
 * Wait until the child has published its state file (ports, pid). Reading the
 * published state is what real tooling does, so the test exercises that path.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string[]} logs
 * @param {string} stateFile
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function waitForState(child, logs, stateFile, timeoutMs = 30_000) {
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (child.exitCode !== null) throw new Error(`simulator exited early (${child.exitCode})\n${tail(logs)}`)
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (Number(state.pid) === child.pid && Number(state.sshPort) > 0 && Number(state.remotePort) > 0) {
          return state
        }
      } catch {
        // The child may be mid-write; retry until the timeout.
      }
    }
    if (Date.now() - started > timeoutMs) throw new Error(`simulator state never appeared\n${tail(logs)}`)
    await sleep(25)
  }
}

/**
 * Stop the child and remove the state file it owned. Never throws: a failure to
 * stop is asserted by the test body, so cleanup must not mask the real error.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} stateFile
 * @returns {Promise<boolean>}
 */
async function stopSimulator(child, stateFile) {
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
  // Only remove the state file this child published, never a concurrent sim's.
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (Number(state.pid) === child.pid) rmSync(stateFile, { force: true })
  } catch {
    /* nothing published, or already gone */
  }
  return stopped || child.exitCode !== null
}

/**
 * Start `--serve` mode with the configurable workspace fixture and wait for its
 * published ports. The private state file keeps this simulator from racing the
 * other integration file, which runs in parallel and owns the default path.
 * @param {string} stateFile
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, state: any, logs: string[] }>}
 */
async function startSimulator(stateFile) {
  rmSync(stateFile, { force: true })
  /** @type {string[]} */
  const logs = []
  const child = spawn(
    process.execPath,
    [SIM_SCRIPT, '--serve', '--workspace-fixture', FIXTURE_FILE, '--state-file', stateFile],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // The local test host has no `node` on PATH and runs the harness binary
        // as Node instead; real Node ignores this variable.
        ELECTRON_RUN_AS_NODE: '1',
        SIM_SSH_USER: CREDENTIALS.username,
        SIM_SSH_PASSWORD: CREDENTIALS.password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  try {
    const state = await waitForState(child, logs, stateFile)
    return { child, state, logs }
  } catch (error) {
    await stopSimulator(child, stateFile)
    throw error
  }
}

/**
 * One JSON request through the plugin's real API handler, with the local plugin
 * header the browser half sends.
 * @param {string} base
 * @param {string} route
 * @param {RequestInit} [init]
 */
async function callApi(base, route, init = {}) {
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: { 'x-dsh-remote-go': '1', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/**
 * Serve the plugin API on an ephemeral loopback port.
 * @param {import('../../src/service.js').RemoteGoService} service
 * @param {string[]} logs
 */
async function startApi(service, logs) {
  /** @type {import('node:http').Server} */
  let server
  const logger = createLogger(logs)
  const api = createApi({
    service,
    getOrigin: () => {
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    logger,
  })
  server = http.createServer(api.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the API listener exposed no TCP address')
  return {
    base: `http://127.0.0.1:${address.port}/dsh-remote-go/api`,
    async close() {
      api.dispose()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

/**
 * Build one service over the test's temporary state home. Two inputs are stubbed:
 * the local `~/.ssh` discovery (so the developer's real config cannot change the
 * destination) and the target-version resolver (so no network/target lookup is
 * needed). Everything else — SSH transport, probe, remote start and tunnel — is
 * real. Because `resolveTarget` returns the probed remote version, version parity
 * is true by construction and is therefore NOT asserted anywhere below.
 * @param {{ stateDir: string, home: string, localVersion: string, logs: string[], adapter?: any, workspaceAdapter?: any }} options
 */
function createService(options) {
  const logger = createLogger(options.logs)
  return new RemoteGoService({
    store: new HostStore({ dir: options.stateDir, logger }),
    home: options.home,
    localVersion: options.localVersion,
    logger,
    loadSshMaterial: async () => ({ configText: '', knownHostsText: '' }),
    resolveTarget: () => ({ targetVersion: options.localVersion, source: 'test' }),
    sessionAdapter: options.adapter ?? null,
    workspaceAdapter: options.workspaceAdapter ?? null,
  })
}

/**
 * @param {import('../../src/service.js').RemoteGoService} service
 * @param {string} hostId
 */
function hostView(service, hostId) {
  const view = service.snapshot().hosts.find((host) => host.id === hostId)
  assert.ok(view, `host ${hostId} disappeared from the service snapshot`)
  return view
}

/**
 * Drive the real connect pipeline and answer the host-key prompt the way the
 * user does, then wait until the host is usable (or report why it is not).
 * @param {import('../../src/service.js').RemoteGoService} service
 * @param {string} hostId
 * @param {string} password
 * @param {string[]} logs
 * @param {number} [timeoutMs]
 */
async function connectHost(service, hostId, password, logs, timeoutMs = 90_000) {
  const accepted = await service.connect(hostId, { password })
  assert.equal(accepted.accepted, true, `connect() was not accepted: ${JSON.stringify(accepted)}`)
  let confirmed = false
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const view = hostView(service, hostId)
    if (!confirmed && view.status === 'fingerprint-pending') {
      confirmed = true
      await service.confirmFingerprint(hostId, { accept: true, remember: false })
    }
    if (view.status === 'connected') return { view, confirmed }
    if (view.status === 'error') {
      throw new Error(`the connect pipeline failed: ${JSON.stringify(view.error)}\n${tail(logs)}`)
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`the connect pipeline never became usable (status ${view.status})\n${tail(logs)}`)
    }
    await sleep(25)
  }
}

/**
 * Wait for the mirror sync the connect pipeline starts after the host becomes
 * usable. The pipeline publishes `connected` first and syncs in the background,
 * so a plain panel read must eventually show the remote sessions without any
 * explicit sync call.
 * @param {import('../../src/service.js').RemoteGoService} service
 * @param {string} hostId
 * @param {string[]} logs
 * @param {number} expectedCount
 * @param {number} [timeoutMs]
 */
async function waitForMirrors(service, hostId, logs, expectedCount, timeoutMs = 30_000) {
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const listed = await service.listHostMirrors(hostId)
    if (listed.mirrors.length === expectedCount) return listed
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `the connect pipeline never mirrored the directory (${listed.mirrors.length}/${expectedCount} descriptor(s))\n${tail(logs)}`,
      )
    }
    await sleep(25)
  }
}

/** The descriptor fields that must not change across a successful re-sync. */
function stablePart(mirrors) {
  return mirrors.map(({ mirroredAt, ...rest }) => rest)
}

/**
 * A `workspaceRegistry` double that reproduces the one behaviour the sidebar
 * depends on: every workspace's `sessionIds` is a canonical-cwd header index
 * (the real registry filters the getter that way), so membership follows the
 * session header's `meta.cwd` rather than an explicit attach call.
 *
 * `create`/`resolveByPath`/`delete` mirror the real service's contract:
 * idempotent per canonical path, non-creating lookup, registration-only delete.
 * @param {Map<string, any>} live session id → `{ id, cwd }`
 */
function createFakeWorkspaceRegistry(live) {
  /** @type {Map<string, any>} */
  const byPath = new Map()
  /** @type {{ create: { path: string, title: string | undefined }[], delete: string[] }} */
  const calls = { create: [], delete: [] }
  let seq = 0
  /** @param {unknown} value */
  const canonical = (value) => (typeof value === 'string' && value !== '' ? path.resolve(value) : null)
  const registry = {
    calls,
    async create(dir, title) {
      calls.create.push({ path: dir, title })
      const key = canonical(dir)
      const existing = byPath.get(key)
      if (existing) return existing
      const workspace = {
        id: `ws_${(seq += 1)}`,
        path: key,
        title: title ?? path.basename(String(dir)),
        get sessionIds() {
          return [...live.values()]
            .filter((session) => canonical(session.cwd) === workspace.path)
            .map((session) => session.id)
        },
        async setTitle(next) {
          workspace.title = next
        },
      }
      byPath.set(key, workspace)
      return workspace
    },
    async resolveByPath(dir) {
      return byPath.get(canonical(dir))
    },
    async delete(id) {
      calls.delete.push(id)
      for (const [key, workspace] of byPath) {
        if (workspace.id === id) {
          byPath.delete(key)
          return true
        }
      }
      return false
    },
    list() {
      return [...byPath.values()]
    },
  }
  return registry
}

test('remote sessions appear as local mirror sessions, end to end', { timeout: 180_000 }, async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'dsh-mirror-e2e-'))
  const stateFile = path.join(temp, 'sim.state.json')
  /** @type {Awaited<ReturnType<typeof startSimulator>> | null} */
  let simulator = null
  /** @type {import('../../src/service.js').RemoteGoService | null} */
  let service = null
  /** @type {import('../../src/service.js').RemoteGoService | null} */
  let reloaded = null
  /** @type {Awaited<ReturnType<typeof startApi>> | null} */
  let api = null
  /** @type {SshConnection | null} */
  let ssh = null
  const serviceLogs = []
  /** @type {any} */
  const ctx = { workspaces: null, remoteVersion: null, hostId: null }

  try {
    simulator = await startSimulator(stateFile)
    ssh = new SshConnection({
      host: '127.0.0.1',
      port: simulator.state.sshPort,
      username: CREDENTIALS.username,
      auth: { type: 'password', password: CREDENTIALS.password },
      acceptUnknownHostKey: true,
      readyTimeoutMs: 10_000,
      keepaliveIntervalMs: 15_000,
    })
    await ssh.connect()

    await t.test('the simulator serves the configurable remote workspace fixture', async () => {
      const facts = await probeRemote(ssh, { remoteDir: DEFAULT_REMOTE_DIR, timeoutMs: 30_000 })
      assert.equal(facts.os, 'Linux')
      assert.equal(facts.sshConnection, true)
      assert.ok(facts.dshVersion, 'the probe reported no remote DSH version')
      ctx.remoteVersion = facts.dshVersion

      // The plugin reads `<remote DSH home>/storages/workspace.json`; prove the
      // answer is the fixture this test asked for, not the built-in registry.
      assert.equal(simulator.state.workspaceFixture, FIXTURE_FILE)
      const layout = remoteLayout(DEFAULT_REMOTE_DIR, facts.home)
      const workspaces = await readRemoteWorkspaces(ssh, layout.home)
      assert.equal(workspaces.ok, true, `workspace read failed: ${workspaces.reason ?? 'unknown'}`)
      assert.equal(workspaces.file, remoteWorkspaceStoragePath(layout.home))
      assert.equal(workspaces.initialized, true)
      assert.equal(workspaces.defaultWorkspaceId, 'ws-sim-alpha')
      assert.deepEqual(
        workspaces.workspaces.map((workspace) => workspace.id),
        ['ws-sim-alpha', 'ws-sim-beta'],
      )
      assert.deepEqual(
        workspaces.workspaces.map((workspace) => workspace.sessionIds),
        [['sess-alpha-one', 'sess-omega-two'], ['sess-beta-three']],
      )
      assert.equal(workspaces.workspaces[0].title, 'Alpha project')
      assert.equal(workspaces.workspaces[0].path, '/home/sim/work/alpha')
      // No explicit title on the second workspace: the registry derives it from
      // the path, which is what the mirror title must build on.
      assert.equal(workspaces.workspaces[1].title, 'beta')
      ctx.workspaces = workspaces
    })

    await t.test('the plugin connects through the real SSH, probe, start and tunnel path', async () => {
      assert.ok(ctx.remoteVersion, 'the remote version is unknown; the fixture subtest did not run')
      const stateDir = path.join(temp, 'state')
      service = createService({
        stateDir,
        home: path.join(temp, 'dsh-home'),
        localVersion: ctx.remoteVersion,
        logs: serviceLogs,
      })
      await service.init()
      const host = await service.saveHost({
        name: 'simulated-remote',
        address: '127.0.0.1',
        port: simulator.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      ctx.hostId = host.id

      const outcome = await connectHost(service, host.id, CREDENTIALS.password, serviceLogs)
      assert.equal(outcome.confirmed, true, 'the host-key prompt was never shown')
      const view = hostView(service, host.id)
      assert.equal(view.status, 'connected')
      assert.equal(view.phase, 'ready')
      assert.equal(view.remote.version, ctx.remoteVersion)
      assert.equal(view.remote.port, simulator.state.remotePort)
      assert.equal(view.remote.uiReady, true)
      assert.ok(Number(view.remote.localPort) > 0, 'the loopback tunnel exposed no local port')
      // `resolveTarget` is stubbed (see createService), so version parity would be
      // true by construction: the real check is the probed remote version above.
      assert.equal(view.fingerprint.sha256, simulator.state.fingerprint)
    })

    await t.test('one L1 mirror is planned per remote session', async () => {
      assert.ok(service && ctx.hostId, 'the connect subtest did not run')
      // Connecting already mirrors the directory (the pipeline starts the sync
      // without awaiting it), so a plain panel read must show the remote sessions.
      const afterConnect = await waitForMirrors(service, ctx.hostId, serviceLogs, FIXTURE_SESSIONS.length)
      assert.equal(afterConnect.connected, true)
      assert.equal(afterConnect.level, 'L1')
      assert.deepEqual(afterConnect.capabilities, L1_CAPABILITIES)
      assert.equal(afterConnect.sessionsAvailable, false)
      assert.equal(afterConnect.mirrors.length, FIXTURE_SESSIONS.length)

      const synced = await service.syncHostMirrors(ctx.hostId)
      assert.equal(synced.synced, true)
      assert.equal(synced.level, 'L1')
      assert.equal(synced.reason.code, 'history-unavailable')
      assert.equal(synced.sessionsAvailable, false)
      assert.deepEqual(synced.markedDeleted, [])
      assert.deepEqual(synced.revived, [])
      // No `sessions` service is published here: the adapter is absent, not fake.
      assert.deepEqual(synced.sessions, [])
      assert.equal(synced.resyncRequired, 0)
      assert.equal(synced.notice, null)
      // Nothing changed remotely, so an explicit sync keeps the same set; the
      // only moving field is `mirroredAt` (last successful sync time).
      assert.deepEqual(stablePart(synced.mirrors), stablePart(afterConnect.mirrors))

      assert.equal(synced.mirrors.length, FIXTURE_SESSIONS.length, 'one mirror per remote session')
      assert.deepEqual(
        synced.mirrors.map((descriptor) => descriptor.remoteSessionId),
        FIXTURE_SESSIONS.map((session) => session.remoteSessionId),
      )
      const ids = synced.mirrors.map((descriptor) => descriptor.localSessionId)
      assert.equal(new Set(ids).size, ids.length, 'mirror ids are not unique')
      const byRemoteSession = new Map(synced.mirrors.map((descriptor) => [descriptor.remoteSessionId, descriptor]))
      for (const expected of FIXTURE_SESSIONS) {
        const descriptor = byRemoteSession.get(expected.remoteSessionId)
        assert.ok(descriptor, `no mirror for remote session ${expected.remoteSessionId}`)
        assert.match(descriptor.localSessionId, /^mirror_[0-9a-z]{25}$/)
        assert.equal(descriptor.localSessionId, mirrorSessionId(ctx.hostId, expected.remoteSessionId))
        assert.equal(descriptor.hostId, ctx.hostId)
        assert.equal(descriptor.workspaceId, expected.workspaceId)
        assert.equal(descriptor.remoteSessionId, expected.remoteSessionId)
        assert.equal(descriptor.title, `${expected.baseTitle} · ${expected.remoteSessionId.slice(0, 8)}`)
        assert.equal(descriptor.cursor, 0)
        assert.equal(descriptor.status, 'active')
        assert.deepEqual(descriptor.capabilities, L1_CAPABILITIES)
        assert.match(String(descriptor.mirroredAt), /^\d{4}-\d{2}-\d{2}T/)
      }
    })

    await t.test('mirror ids are stable across re-planning, re-sync and a restart', async () => {
      assert.ok(service && ctx.hostId && ctx.workspaces, 'the earlier subtests did not run')
      const first = await service.listHostMirrors(ctx.hostId)
      const ids = first.mirrors.map((descriptor) => descriptor.localSessionId)

      const again = await service.syncHostMirrors(ctx.hostId)
      assert.deepEqual(
        again.mirrors.map((descriptor) => descriptor.localSessionId),
        ids,
      )
      // A second sync must not reset the sync position; only `mirroredAt`
      // (last successful sync time) may move.
      assert.deepEqual(stablePart(again.mirrors), stablePart(first.mirrors))
      for (const [index, mirror] of again.mirrors.entries()) {
        assert.ok(
          Date.parse(mirror.mirroredAt) >= Date.parse(first.mirrors[index].mirroredAt),
          'mirroredAt must not go backwards',
        )
      }

      // Same input ⇒ same ids, independent of the registry's entry order.
      const reversed = { ...ctx.workspaces, workspaces: [...ctx.workspaces.workspaces].reverse() }
      for (const input of [ctx.workspaces, reversed]) {
        const planned = planMirror({
          host: { id: ctx.hostId, name: 'simulated-remote' },
          remoteWorkspaces: input,
          capabilities: l1Capabilities(),
          existing: null,
          now: '2026-01-02T00:00:00Z',
        })
        assert.deepEqual(
          planned.map((descriptor) => descriptor.localSessionId),
          ids,
        )
      }
    })

    await t.test('descriptors are served from the persisted mirrors.json', async () => {
      assert.ok(service && ctx.hostId, 'the connect subtest did not run')
      const stateDir = path.join(temp, 'state')
      const file = path.join(stateDir, 'mirrors.json')
      const raw = JSON.parse(await readFile(file, 'utf8'))
      const listed = await service.listHostMirrors(ctx.hostId)
      assert.equal(raw.version, MIRROR_STORE_VERSION)
      assert.deepEqual(raw.mirrors, listed.mirrors)

      // A fresh store and a fresh service reload only the file on disk; the
      // set must survive without any remote call.
      const store = new MirrorStore({ dir: stateDir, logger: createLogger(serviceLogs) })
      const loaded = await store.load()
      assert.deepEqual(loaded.mirrors, listed.mirrors)

      reloaded = createService({
        stateDir,
        home: path.join(temp, 'dsh-home'),
        localVersion: ctx.remoteVersion,
        logs: serviceLogs,
      })
      await reloaded.init()
      const restored = await reloaded.listHostMirrors(ctx.hostId)
      assert.equal(restored.connected, false)
      assert.equal(restored.level, 'L1')
      assert.equal(restored.sessionsAvailable, false)
      assert.deepEqual(restored.mirrors, listed.mirrors)
    })

    await t.test('GET /hosts/:id/mirrors returns the same set', async () => {
      assert.ok(service && ctx.hostId, 'the connect subtest did not run')
      api = await startApi(service, serviceLogs)
      const listed = await service.listHostMirrors(ctx.hostId)
      const result = await callApi(api.base, `/hosts/${encodeURIComponent(ctx.hostId)}/mirrors`)
      assert.equal(result.status, 200, `unexpected status: ${result.text}`)
      assert.ok(result.json && result.json.ok === true)
      assert.equal(result.json.hostId, ctx.hostId)
      assert.equal(result.json.level, 'L1')
      assert.deepEqual(result.json.capabilities, L1_CAPABILITIES)
      assert.equal(result.json.sessionsAvailable, false)
      assert.deepEqual(result.json.mirrors, listed.mirrors)
      // The API answer equals the durable file, so a restart cannot change it.
      const onDisk = JSON.parse(await readFile(path.join(temp, 'state', 'mirrors.json'), 'utf8'))
      assert.deepEqual(result.json.mirrors, onDisk.mirrors)

      // The refresh endpoint is what the panel calls; it re-reads the remote and
      // returns the persisted set without creating anything locally.
      const refreshed = await callApi(api.base, `/hosts/${encodeURIComponent(ctx.hostId)}/mirrors/sync`, {
        method: 'POST',
      })
      assert.equal(refreshed.status, 200, `unexpected status: ${refreshed.text}`)
      assert.equal(refreshed.json.synced, true)
      assert.equal(refreshed.json.level, 'L1')
      assert.equal(refreshed.json.sessionsAvailable, false)
      assert.equal(refreshed.json.resyncRequired, 0)
      assert.equal(refreshed.json.notice, null)
      // The refresh is authoritative: it returns exactly what it just persisted,
      // and the only field that moved is the last successful sync time.
      const onDiskAfter = JSON.parse(await readFile(path.join(temp, 'state', 'mirrors.json'), 'utf8'))
      assert.deepEqual(refreshed.json.mirrors, onDiskAfter.mirrors)
      assert.deepEqual(stablePart(refreshed.json.mirrors), stablePart(onDisk.mirrors))
      for (const [index, mirror] of refreshed.json.mirrors.entries()) {
        assert.ok(Date.parse(mirror.mirroredAt) >= Date.parse(onDisk.mirrors[index].mirroredAt))
      }
    })

    await t.test('an injected sessions service gets one created local session per descriptor', async () => {
      assert.ok(simulator && ctx.remoteVersion, 'the simulator subtest did not run')
      const stateDir = path.join(temp, 'state-adapter')
      // Production builds exactly this root (src/index.js): `$DSH_HOME/remote-go/mirrors`.
      const mirrorRoot = path.join(stateDir, 'mirrors')
      /** @type {Map<string, any>} */
      const live = new Map()
      /** @type {{ id: string, options: any }[]} */
      const createCalls = []
      const sessions = {
        create(id, options) {
          createCalls.push({ id, options })
          const session = { id, append() {} }
          live.set(id, session)
          return session
        },
        get(id) {
          return live.get(id)
        },
      }
      const adapter = createSessionAdapter({ sessions, logger: createLogger(serviceLogs), mirrorRoot })
      const withAdapter = createService({
        stateDir,
        home: path.join(temp, 'dsh-home-adapter'),
        localVersion: ctx.remoteVersion,
        logs: serviceLogs,
        adapter,
      })
      await withAdapter.init()
      const host = await withAdapter.saveHost({
        name: 'simulated-remote-adapter',
        address: '127.0.0.1',
        port: simulator.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      try {
        await connectHost(withAdapter, host.id, CREDENTIALS.password, serviceLogs)
        const listed = await waitForMirrors(withAdapter, host.id, serviceLogs, FIXTURE_SESSIONS.length)
        assert.equal(listed.sessionsAvailable, true)
        // Wait for the background sync's session creation, which follows the
        // descriptor write.
        const deadline = Date.now() + 30_000
        while (createCalls.length < FIXTURE_SESSIONS.length && Date.now() < deadline) await sleep(25)
        assert.equal(createCalls.length, FIXTURE_SESSIONS.length, 'one create per mirror descriptor')
        assert.equal(live.size, FIXTURE_SESSIONS.length, 'one live session per mirror descriptor')

        const cwd = path.join(mirrorRoot, host.id)
        assert.equal((await stat(cwd)).isDirectory(), true, 'the per-host mirror cwd must exist')
        for (const call of createCalls) {
          assert.deepEqual(call.options, { meta: { isSeeded: true, cwd } })
        }
        // Descriptor ids are the ids handed to the sessions service.
        const descriptorIds = listed.mirrors.map((mirror) => mirror.localSessionId).sort()
        assert.deepEqual(createCalls.map((call) => call.id).sort(), descriptorIds)
      } finally {
        await withAdapter.shutdown()
      }
    })

    await t.test('the sidebar workspace groups exactly the mirrored sessions', async () => {
      assert.ok(simulator && ctx.remoteVersion, 'the simulator subtest did not run')
      const stateDir = path.join(temp, 'state-sidebar')
      // A symlinked/junctioned root: the real plugin canonicalizes it once
      // (src/index.js) and feeds that value to both adapters, so the workspace
      // path and the session `meta.cwd` cannot disagree (session-design §4.3).
      const realRoot = path.join(stateDir, 'mirrors-real')
      const linkRoot = path.join(stateDir, 'mirrors')
      await mkdir(realRoot, { recursive: true })
      await symlink(realRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir')
      const mirrorRoot = canonicalMirrorRoot(linkRoot)
      // A junction may keep the 8.3 short spelling of its target (GitHub's Windows
      // runner does), so compare the resolved physical directories, not the strings.
      assert.equal(await realpath(mirrorRoot), await realpath(realRoot), 'the mirror root is canonicalized')

      /** @type {Map<string, any>} */
      const live = new Map()
      const sessions = {
        create(id, options) {
          const session = { id, cwd: options?.meta?.cwd ?? null, append() {} }
          live.set(id, session)
          return session
        },
        get(id) {
          return live.get(id)
        },
      }
      const registry = createFakeWorkspaceRegistry(live)
      const logger = createLogger(serviceLogs)
      const sessionAdapter = createSessionAdapter({ sessions, logger, mirrorRoot })
      const workspaceAdapter = createWorkspaceAdapter({ registry, logger, mirrorRoot })
      const withSidebar = createService({
        stateDir,
        home: path.join(temp, 'dsh-home-sidebar'),
        localVersion: ctx.remoteVersion,
        logs: serviceLogs,
        adapter: sessionAdapter,
        workspaceAdapter,
      })
      await withSidebar.init()
      const host = await withSidebar.saveHost({
        name: 'simulated-remote-sidebar',
        address: '127.0.0.1',
        port: simulator.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      try {
        await connectHost(withSidebar, host.id, CREDENTIALS.password, serviceLogs)
        const listed = await waitForMirrors(withSidebar, host.id, serviceLogs, FIXTURE_SESSIONS.length)
        // Both follow the descriptor write in the background connect sync.
        const deadline = Date.now() + 30_000
        while ((live.size < FIXTURE_SESSIONS.length || registry.list().length !== 1) && Date.now() < deadline) {
          await sleep(25)
        }

        const workspaces = registry.list()
        assert.equal(workspaces.length, 1, 'exactly one sidebar workspace per host')
        const workspace = workspaces[0]
        const mirrorCwd = path.join(mirrorRoot, host.id)
        assert.equal(workspace.path, path.resolve(mirrorCwd), 'the workspace owns the mirror sessions cwd')
        assert.equal(path.dirname(workspace.path), mirrorRoot, 'the registered directory is the canonical root')
        assert.equal(workspace.title, `Remote: ${host.name}`, 'the title names the remote host')
        // Membership is derived from the canonical cwd, so this is the number the
        // sidebar will actually render — and it must equal the mirrored sessions.
        assert.equal(workspace.sessionIds.length, FIXTURE_SESSIONS.length)
        assert.equal(workspace.sessionIds.length, listed.mirrors.length)
        assert.deepEqual([...workspace.sessionIds].sort(), listed.mirrors.map((mirror) => mirror.localSessionId).sort())
        // Every live mirror session really is keyed off that one directory.
        for (const session of live.values()) assert.equal(path.resolve(session.cwd), workspace.path)

        // The sync payload reports the registration the sidebar just gained, and
        // a re-sync reuses it instead of creating a duplicate.
        const synced = await withSidebar.syncHostMirrors(host.id)
        assert.equal(synced.sidebar.ok, true)
        assert.equal(synced.sidebar.workspaceId, workspace.id)
        assert.equal(synced.sidebar.created, false, 'a re-sync must reuse the registration')
        assert.equal(synced.sidebar.title, `Remote: ${host.name}`)
        assert.equal(synced.sidebar.path, workspace.path, 'the payload reports the canonical path')
        assert.equal(registry.calls.create.length, 1, 'the registry was asked to create exactly once')
        assert.equal(registry.list().length, 1)

        // Turning the toggle off must remove the group (not merely stop creating).
        await withSidebar.saveSettings({ mirrorToSidebar: false })
        const disabled = await withSidebar.syncHostMirrors(host.id)
        assert.equal(disabled.sidebar.reason, 'disabled')
        assert.equal(disabled.sidebar.removed, true)
        assert.deepEqual(registry.list(), [], 'the "Remote: …" group is gone from the sidebar')

        // Re-enabling restores it on the next sync, with the same sessions grouped.
        await withSidebar.saveSettings({ mirrorToSidebar: true })
        const restored = await withSidebar.syncHostMirrors(host.id)
        assert.equal(restored.sidebar.ok, true)
        assert.equal(restored.sidebar.created, true)
        assert.equal(registry.list().length, 1)
        assert.equal(registry.list()[0].sessionIds.length, FIXTURE_SESSIONS.length)

        // Deleting the host removes the registration; the directory is retained.
        await withSidebar.removeHost(host.id)
        assert.deepEqual(registry.list(), [])
        assert.equal((await stat(mirrorCwd)).isDirectory(), true, 'the mirror directory is retained')
      } finally {
        await withSidebar.shutdown()
      }
    })

    await t.test('the sessions service absent path keeps listing working without throwing', async () => {
      assert.ok(service && ctx.hostId, 'the connect subtest did not run')
      assert.equal(service.sessionAdapter, null)
      const listed = await service.listHostMirrors(ctx.hostId)
      assert.equal(listed.mirrors.length, FIXTURE_SESSIONS.length)

      // A host that never connected must degrade to typed values, never throw.
      const idle = await service.saveHost({
        name: 'simulated-remote-offline',
        address: '127.0.0.1',
        port: 1,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
      })
      const synced = await service.syncHostMirrors(idle.id)
      assert.equal(synced.synced, false)
      assert.equal(synced.reason, 'not-connected')
      assert.deepEqual(synced.mirrors, [])
      const idleListing = await service.listHostMirrors(idle.id)
      assert.equal(idleListing.connected, false)
      assert.equal(idleListing.level, 'L1')
      assert.deepEqual(idleListing.capabilities, L1_CAPABILITIES)
      assert.deepEqual(idleListing.mirrors, [])
    })
  } finally {
    // The child must die even when a cleanup step throws, or the runner (and CI)
    // waits on its pipes forever.
    try {
      if (api) await api.close()
      if (reloaded) await reloaded.shutdown()
      if (service) await service.shutdown()
      if (ssh) await ssh.dispose()
    } finally {
      const stopped = simulator ? await stopSimulator(simulator.child, stateFile) : true
      const stateGone = !existsSync(stateFile)
      await rm(temp, { recursive: true, force: true })
      if (simulator) {
        assert.equal(stopped, true, `the simulator was not stopped\n${tail(simulator.logs)}`)
        assert.equal(stateGone, true, 'the simulator left its state file behind')
      }
    }
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionAdapter } from '../../src/session-adapter.js'
import { RemoteGoService } from '../../src/service.js'
import { HostStore } from '../../src/store.js'

// L3 prerequisite (design §6.2): a *fenced* writer must stop, keep the mirror readable, and
// resume only after acquiring a newer epoch. The competing authority is served by the
// simulated remote over the real SSH `exec` transport, so this exercises the whole path.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SIM_SCRIPT = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')
const CREDENTIALS = { username: 'sim', password: 'sim-lease-password' }

/** @type {Record<string, any>} */
const WORKSPACE_FIXTURE = {
  version: 2,
  global: { initialized: true, defaultWorkspaceId: 'ws', workspaceIds: ['ws'] },
  tables: {
    workspaces: {
      ws: { path: '/home/sim/project', title: 'project', sessionIds: ['sess-lease-1'] },
    },
  },
}

const HISTORY_SESSIONS = ['sess-lease-1']

/** Five records, so the cursor has somewhere to advance to. */
function historyFixture() {
  /** @type {Record<string, { events: any[] }>} */
  const sessions = {}
  for (const id of HISTORY_SESSIONS) {
    /** @type {any[]} */
    const events = []
    for (let seq = 1; seq <= 5; seq += 1) {
      events.push({
        seq,
        role: seq % 2 === 0 ? 'assistant' : 'user',
        text: `${id} ${seq}`,
        at: `2026-11-11T00:00:0${seq}Z`,
      })
    }
    sessions[id] = { events }
  }
  return { sessions }
}

/** @param {string[]} logs */
function createLogger(logs) {
  /** @param {...any} parts */
  const line = (...parts) => parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
  return {
    debug: (...parts) => logs.push(`D ${line(...parts)}`),
    info: (...parts) => logs.push(`I ${line(...parts)}`),
    warn: (...parts) => logs.push(`W ${line(...parts)}`),
    error: (...parts) => logs.push(`E ${line(...parts)}`),
  }
}

/**
 * @param {{ stateFile: string, lease: { writer: string, epoch: number } | null, readFail?: boolean }} options
 */
async function startSimulator(options) {
  rmSync(options.stateFile, { force: true })
  /** @type {string[]} */
  const logs = []
  /** @type {string[]} */
  const argv = [
    SIM_SCRIPT,
    '--serve',
    '--workspace-fixture',
    path.join(path.dirname(options.stateFile), 'workspace.json'),
    '--history-fixture',
    path.join(path.dirname(options.stateFile), 'history.json'),
    '--state-file',
    options.stateFile,
  ]
  if (options.readFail === true) argv.push('--lease-read-fail')
  if (options.lease !== null) {
    const leaseFile = path.join(path.dirname(options.stateFile), 'lease.json')
    writeFileSync(leaseFile, `${JSON.stringify(options.lease)}\n`, 'utf8')
    argv.push('--lease-fixture', leaseFile)
  }
  const child = spawn(process.execPath, argv, {
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
  /** @type {any} */
  let state = null
  for (let attempt = 0; attempt < 300 && state === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      state = JSON.parse(readFileSync(options.stateFile, 'utf8'))
    } catch {
      state = null
    }
  }
  if (state === null) {
    child.kill('SIGKILL')
    throw new Error(`simulator did not publish a state file; logs:\n${logs.join('')}`)
  }
  return { child, state, logs }
}

/** @param {import('node:child_process').ChildProcess} child */
async function stopSimulator(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (!stopped) child.kill('SIGKILL')
}

/**
 * @param {{ stateDir: string, home: string, localVersion: string, logs: string[], adapter: any,
 *   clock?: () => number }} options
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
    sessionAdapter: options.adapter,
    workspaceAdapter: null,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
}

function createSessionsService() {
  /** @type {Map<string, any>} */
  const live = new Map()
  /** @type {{ id: string, type: string, data: any }[]} */
  const appends = []
  const sessions = {
    create(id) {
      /** @type {{ type: string, seq: number, data: any }[]} */
      let committed = []
      const session = {
        id,
        get seq() {
          return committed.length
        },
        append(type, data) {
          const event = { type, seq: committed.length + 1, data }
          committed = [...committed, event]
          appends.push({ id, type, data })
          return event
        },
        snapshotEvents() {
          return committed
        },
        ownEvents() {
          return committed
        },
        eventAt(seq) {
          return committed.find((event) => event.seq === seq)
        },
      }
      live.set(id, session)
      return session
    },
    get(id) {
      return live.get(id)
    },
  }
  return { sessions, live, appends }
}

/** @param {RemoteGoService} service @param {string} hostId */
async function mirrorsOf(service, hostId) {
  const listed = await service.listHostMirrors(hostId)
  return listed.mirrors ?? []
}

/**
 * @param {RemoteGoService} service @param {string} hostId @param {string[]} logs
 */
async function connectHost(service, hostId, logs, timeoutMs = 90_000) {
  await service.connect(hostId, { password: CREDENTIALS.password })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const view = service.snapshot().hosts.find((entry) => entry.id === hostId)
    if (view?.status === 'fingerprint-pending') {
      await service.confirmFingerprint(hostId, { accept: true, remember: false })
      continue
    }
    if (view?.status === 'connected') return view
    if (view?.status === 'error') throw new Error(`connect failed: ${JSON.stringify(view.error)}\n${logs.join('\n')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`connect timed out\n${logs.join('\n')}`)
}

/** @param {string[]} logs @param {string} needle */
function logContains(logs, needle) {
  return logs.some((line) => line.includes(needle))
}

/**
 * Wait for the descriptor to satisfy a predicate (polling the public API, never a sleep).
 * @param {RemoteGoService} service @param {string} hostId
 * @param {(mirrors: any[]) => boolean} predicate @param {number} [timeoutMs]
 */
async function waitForMirrors(service, hostId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  /** @type {any[]} */
  let mirrors = []
  while (Date.now() < deadline) {
    mirrors = await mirrorsOf(service, hostId)
    if (mirrors.length > 0 && predicate(mirrors)) return mirrors
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return mirrors
}

test(
  'a fenced writer stops writing, keeps its history, and resumes with a newer epoch',
  { timeout: 600_000 },
  async (t) => {
    const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lease-fence-'))
    const stateFile = path.join(temp, 'sim-state.json')
    writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
    writeFileSync(path.join(temp, 'history.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
    // The remote announces a competing writer holding a much newer epoch.
    const sim = await startSimulator({ stateFile, lease: { writer: 'remote-owner', epoch: 900 } })
    /** @type {RemoteGoService | null} */
    let service = null
    try {
      const logs = []
      const { sessions, appends } = createSessionsService()
      const stateDir = path.join(temp, 'state')
      const adapter = createSessionAdapter({
        sessions,
        logger: createLogger(logs),
        mirrorRoot: path.join(stateDir, 'mirrors'),
      })
      service = createService({ stateDir, home: path.join(temp, 'home'), localVersion: '0.2.2-rc.1', logs, adapter })
      await service.init()
      const host = await service.saveHost({
        name: 'sim-lease',
        address: '127.0.0.1',
        port: sim.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      await connectHost(service, host.id, logs)

      await t.test('the fenced mirror is read-only with a typed reason and does not advance', async () => {
        const mirrors = await waitForMirrors(service, host.id, (list) =>
          list.every((mirror) => mirror.reason?.code === 'fenced'),
        )
        assert.equal(mirrors.length, HISTORY_SESSIONS.length)
        for (const mirror of mirrors) {
          assert.equal(mirror.readOnly, true, 'a fenced writer must be presented as read-only')
          assert.equal(mirror.reason?.code, 'fenced')
          assert.ok(mirror.reason?.message?.zh && mirror.reason?.message?.en, 'the reason is bilingual')
          assert.equal(mirror.cursor, 0, 'a fenced writer must not advance the cursor')
          assert.equal(mirror.level, 'L1', 'a fenced mirror must not claim L2')
          // The epoch was adopted, so our own next write is refused locally too.
          assert.ok(mirror.epoch >= 900, `the descriptor must adopt the newer epoch, got ${mirror.epoch}`)
        }
        assert.equal(logContains(logs, 'fenced') || mirrors[0].reason?.code === 'fenced', true)
      })

      await t.test('it writes nothing while fenced', async () => {
        const before = appends.length
        await service.syncHostMirrors(host.id).catch(() => null)
        await service.syncHostMirrors(host.id).catch(() => null)
        assert.equal(
          appends.length,
          before,
          `a fenced writer must not append history: ${JSON.stringify(appends.map((a) => a.type))}`,
        )
        const mirrors = await mirrorsOf(service, host.id)
        assert.equal(
          mirrors.every((mirror) => mirror.cursor === 0 && mirror.reason?.code === 'fenced'),
          true,
          'repeated syncs stay fenced without advancing',
        )
      })

      await t.test('the fencing notice is announced once, not per sync', async () => {
        const notices = appends.filter((entry) => entry.type === 'mirror/fenced')
        assert.equal(notices.length, HISTORY_SESSIONS.length, 'exactly one notice per mirrored session')
        for (const notice of notices) {
          assert.equal(notice.data.readOnly, true)
          assert.ok(notice.data.epoch >= 900)
          assert.equal(notice.data.remoteWriter, 'remote-owner')
        }
      })
    } finally {
      if (service) await service.shutdown?.().catch?.(() => null)
      await stopSimulator(sim.child)
      rmSync(temp, { recursive: true, force: true })
    }
  },
)

test('a mirror that is not fenced keeps writing and holds its own epoch', { timeout: 600_000 }, async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lease-free-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(temp, 'history.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
  // No authority published at all: the normal case for an unmodified remote.
  const sim = await startSimulator({ stateFile, lease: null })
  /** @type {RemoteGoService | null} */
  let service = null
  try {
    const logs = []
    const { sessions, appends } = createSessionsService()
    const stateDir = path.join(temp, 'state-free')
    const adapter = createSessionAdapter({
      sessions,
      logger: createLogger(logs),
      mirrorRoot: path.join(stateDir, 'mirrors'),
    })
    service = createService({ stateDir, home: path.join(temp, 'home-free'), localVersion: '0.2.2-rc.1', logs, adapter })
    await service.init()
    const host = await service.saveHost({
      name: 'sim-lease-free',
      address: '127.0.0.1',
      port: sim.state.sshPort,
      username: CREDENTIALS.username,
      auth: { type: 'password' },
      keepAlive: 'keep',
      bootstrap: { mode: 'reuse' },
    })
    await connectHost(service, host.id, logs)

    // Predicate = the asserted end state, not a proxy: "cursor === 5" is also true mid-sync
    // (before the lease is persisted), so waiting on it alone can read a half-settled mirror.
    const mirrors = await waitForMirrors(service, host.id, (list) =>
      list.every(
        (mirror) =>
          mirror.cursor === 5 &&
          mirror.level === 'L2' &&
          mirror.reason === null &&
          mirror.writable === true &&
          mirror.lease !== null,
      ),
    )
    for (const mirror of mirrors) {
      assert.equal(mirror.cursor, 5, 'an unfenced mirror replays as usual')
      assert.equal(mirror.level, 'L2')
      assert.equal(mirror.reason, null)
      assert.equal(mirror.writable, true, 'it holds the write lease')
      assert.ok(mirror.epoch >= 1, 'it was issued a fencing epoch')
      assert.ok(mirror.lease && typeof mirror.lease.owner === 'string', 'the lease is persisted with the descriptor')
    }
    // Every replayed event is still there: fencing machinery must not disturb history.
    assert.equal(appends.filter((entry) => entry.type.endsWith('/message')).length, HISTORY_SESSIONS.length * 5)

    // A restart resumes its own lease instead of looking like a competing writer.
    const epochBefore = mirrors[0].epoch
    await service.syncHostMirrors(host.id)
    const after = await mirrorsOf(service, host.id)
    assert.equal(after[0].epoch, epochBefore, 'renewing must not move the epoch')
    assert.equal(after[0].reason, null, 'a restart is not a fencing event')
  } finally {
    if (service) await service.shutdown?.().catch?.(() => null)
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('a fenced mirror resumes once it can re-acquire a newer epoch', { timeout: 600_000 }, async () => {
  // §6.2: fencing is not permanent. Once the competing grant is gone, the local side takes a
  // new (higher) epoch and continues from the cursor it had — the history it already showed is
  // never thrown away.
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lease-resume-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(temp, 'history.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
  const stateDir = path.join(temp, 'state')
  const mirrorsFile = path.join(stateDir, 'mirrors.json')

  // Phase 1: a remote that fences us.
  let sim = await startSimulator({ stateFile, lease: { writer: 'remote-owner', epoch: 900 } })
  /** @type {RemoteGoService | null} */
  let service = null
  try {
    const logs = []
    const { sessions } = createSessionsService()
    const adapter = createSessionAdapter({
      sessions,
      logger: createLogger(logs),
      mirrorRoot: path.join(stateDir, 'mirrors'),
    })
    service = createService({ stateDir, home: path.join(temp, 'home'), localVersion: '0.2.2-rc.1', logs, adapter })
    await service.init()
    const host = await service.saveHost({
      name: 'sim-lease-resume',
      address: '127.0.0.1',
      port: sim.state.sshPort,
      username: CREDENTIALS.username,
      auth: { type: 'password' },
      keepAlive: 'keep',
      bootstrap: { mode: 'reuse' },
    })
    await connectHost(service, host.id, logs)
    const fenced = await waitForMirrors(service, host.id, (list) =>
      list.every((mirror) => mirror.reason?.code === 'fenced'),
    )
    assert.equal(fenced[0].reason?.code, 'fenced')
    assert.equal(fenced[0].cursor, 0)

    // Phase 2: the competitor is gone. A *restart* now re-reads the persisted descriptor and
    // must re-acquire from the epoch it stored, which is exactly the property that matters
    // (a restart must not look like a fresh writer, nor forget that it was fenced).
    await stopSimulator(sim.child)
    rmSync(stateFile, { force: true })
    sim = await startSimulator({ stateFile, lease: null })
    await service.shutdown?.().catch?.(() => null)

    const resumedLogs = []
    const resumedSessions = createSessionsService()
    const resumedAdapter = createSessionAdapter({
      sessions: resumedSessions.sessions,
      logger: createLogger(resumedLogs),
      mirrorRoot: path.join(stateDir, 'mirrors'),
    })
    service = createService({
      stateDir,
      home: path.join(temp, 'home'),
      localVersion: '0.2.2-rc.1',
      logs: resumedLogs,
      adapter: resumedAdapter,
    })
    await service.init()
    const existing = service.snapshot().hosts.find((entry) => entry.name === 'sim-lease-resume')
    assert.ok(existing, 'the host record must survive the restart')
    await service.updateHostPolicy(existing.id, { keepAlive: 'keep' })
    const repointed = await service.runtimes.get(existing.id)
    repointed.entry.port = sim.state.sshPort
    await connectHost(service, existing.id, resumedLogs)
    await service.syncHostMirrors(existing.id).catch(() => null)
    // The assertions below also require a writable lease and the resumed cursor, so the wait
    // must require them too — "reason === null" is satisfied before the lease is re-acquired.
    const resumed = await waitForMirrors(service, existing.id, (list) =>
      list.every((mirror) => mirror.reason === null && mirror.writable === true && mirror.cursor === 5),
    )
    assert.equal(
      resumed.every((mirror) => mirror.reason === null),
      true,
      `the mirror must stop reporting fencing once it re-acquires, got ${JSON.stringify(resumed.map((m) => m.reason?.code))}`,
    )
    assert.equal(
      resumed.every((mirror) => mirror.writable === true),
      true,
      'it holds the write lease again',
    )
    assert.ok(resumed[0].epoch > fenced[0].epoch, 'the re-acquisition issues a newer epoch')
    assert.equal(resumed[0].cursor, 5, 'history resumes and the cursor advances')

    // The fencing epoch never regressed, and the descriptor survived a restart on disk.
    const persisted = JSON.parse(readFileSync(mirrorsFile, 'utf8'))
    const stored = persisted.mirrors.find((mirror) => mirror.hostId === host.id)
    assert.ok(stored.epoch >= resumed[0].epoch, 'the epoch is persisted, not recomputed')
  } finally {
    if (service) await service.shutdown?.().catch?.(() => null)
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('the simulator contract for the lease fixture is still served', async () => {
  const source = readFileSync(SIM_SCRIPT, 'utf8')
  for (const needle of ['--lease-fixture', 'remote-go/lease.json', 'leaseReads']) {
    assert.ok(source.includes(needle), `the simulator no longer serves ${JSON.stringify(needle)}`)
  }
})

test('a lease that expires during a slow sync refuses the write batch', { timeout: 600_000 }, async () => {
  // §6.2: the first check runs before the bounded SSH reads, and those can outlast a 30 s
  // TTL. The gate is therefore re-run immediately before appending, against a fresh clock.
  // The clock advances 60 s per call, so the pre-read check passes and the pre-append one
  // cannot: nothing may be written.
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lease-late-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(temp, 'history.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
  const sim = await startSimulator({ stateFile, lease: null })
  /** @type {RemoteGoService | null} */
  let service = null
  try {
    const logs = []
    const { sessions, appends } = createSessionsService()
    const stateDir = path.join(temp, 'state-late')
    const adapter = createSessionAdapter({
      sessions,
      logger: createLogger(logs),
      mirrorRoot: path.join(stateDir, 'mirrors'),
    })
    // Each call jumps 60 s, i.e. well past the default 30 s TTL.
    let ticks = 0
    service = createService({
      stateDir,
      home: path.join(temp, 'home-late'),
      localVersion: '0.2.2-rc.1',
      logs,
      adapter,
      clock: () => {
        ticks += 1
        return 1_000_000 + ticks * 60_000
      },
    })
    await service.init()
    const host = await service.saveHost({
      name: 'sim-lease-late',
      address: '127.0.0.1',
      port: sim.state.sshPort,
      username: CREDENTIALS.username,
      auth: { type: 'password' },
      keepAlive: 'keep',
      bootstrap: { mode: 'reuse' },
    })
    await connectHost(service, host.id, logs)
    await service.syncHostMirrors(host.id).catch(() => null)

    const mirrors = await waitForMirrors(service, host.id, (list) =>
      list.every((mirror) => mirror.reason?.code === 'fenced'),
    )
    assert.equal(
      mirrors.every((mirror) => mirror.reason?.code === 'fenced'),
      true,
      `a lease that expired mid-sync must refuse the batch, got ${JSON.stringify(mirrors.map((m) => m.reason?.code))}`,
    )
    assert.equal(
      appends.filter((entry) => entry.type.endsWith('/message')).length,
      0,
      'nothing may be appended once the lease has expired',
    )
    assert.equal(
      mirrors.every((mirror) => mirror.cursor === 0),
      true,
      'and the cursor must not advance',
    )
  } finally {
    if (service) await service.shutdown?.().catch?.(() => null)
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

test(
  'two clients against one remote: exactly one writes, the other is fenced by the remote',
  { timeout: 900_000 },
  async () => {
    // The decisive case §11 #10 said was missing: two *independent* descriptor stores. They both
    // start at epoch 0 locally, but the remote only honours one authority record, so the second
    // acquirer is refused by the remote — not merely by its own local check.
    const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lease-two-'))
    const stateFile = path.join(temp, 'sim-state.json')
    writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
    writeFileSync(path.join(temp, 'history.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
    const sim = await startSimulator({ stateFile, lease: null })
    /** @type {RemoteGoService[]} */
    const services = []
    try {
      /** @param {string} name */
      const makeClient = async (name) => {
        const logs = []
        const { sessions, appends } = createSessionsService()
        const stateDir = path.join(temp, `state-${name}`)
        const adapter = createSessionAdapter({
          sessions,
          logger: createLogger(logs),
          mirrorRoot: path.join(stateDir, 'mirrors'),
        })
        const service = createService({
          stateDir,
          home: path.join(temp, `home-${name}`),
          localVersion: '0.2.2-rc.1',
          logs,
          adapter,
        })
        await service.init()
        services.push(service)
        const host = await service.saveHost({
          name: `client-${name}`,
          address: '127.0.0.1',
          port: sim.state.sshPort,
          username: CREDENTIALS.username,
          auth: { type: 'password' },
          keepAlive: 'keep',
          bootstrap: { mode: 'reuse' },
        })
        await connectHost(service, host.id, logs)
        return { service, host, appends, logs, stateDir }
      }

      // Client A claims the lease and writes normally.
      const a = await makeClient('a')
      const aMirrors = await waitForMirrors(a.service, a.host.id, (list) => list.every((m) => m.cursor === 5))
      assert.equal(
        aMirrors.every((mirror) => mirror.cursor === 5 && mirror.reason === null),
        true,
        'the first client must be able to write',
      )
      assert.equal(
        aMirrors.every((mirror) => mirror.writable === true),
        true,
      )
      const aAppends = a.appends.filter((entry) => entry.type.endsWith('/message')).length
      assert.equal(aAppends, HISTORY_SESSIONS.length * 5)

      // Client B starts from its own epoch 0 and is *refused by the remote*: it may not take a
      // lease A still holds, so it stays L1/read-only and appends nothing.
      const b = await makeClient('b')
      // "reason !== null" was the proxy that cost a CI round: `stream-unavailable` is a normal
      // non-null L2 reason, so the wait resolved on B's pre-fence state. Wait for the fence itself.
      const bMirrors = await waitForMirrors(b.service, b.host.id, (list) =>
        list.every((mirror) => mirror.reason?.code === 'fenced' && mirror.readOnly === true),
      )
      assert.equal(
        bMirrors.every((mirror) => mirror.reason?.code === 'fenced'),
        true,
        `the second client must be fenced, got ${JSON.stringify(bMirrors.map((m) => ({ code: m.reason?.code, epoch: m.epoch, cursor: m.cursor })))}`,
      )
      assert.equal(
        bMirrors.every((mirror) => mirror.readOnly === true),
        true,
      )
      assert.equal(
        bMirrors.every((mirror) => mirror.cursor === 0),
        true,
        'and must not advance a cursor',
      )
      assert.equal(
        b.appends.filter((entry) => entry.type.endsWith('/message')).length,
        0,
        'the second client must append nothing',
      )

      // Only one writer ever succeeded, and it was A.
      assert.equal(a.appends.filter((entry) => entry.type.endsWith('/message')).length, aAppends)
    } finally {
      for (const service of services) await service.shutdown?.().catch?.(() => null)
      await stopSimulator(sim.child)
      rmSync(temp, { recursive: true, force: true })
    }
  },
)

test('a writer that cannot see the authority is still refused by the remote', { timeout: 900_000 }, async () => {
  // The partition shape §11 #10 described: the writer cannot read the authority (permission
  // denied, network path gone), so its local check passes and it believes it may write. Only
  // the remote's refusal stops it — which is precisely what "enforced remotely" has to mean.
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lease-blind-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(temp, 'history.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
  // A live, unexpired lease held by somebody else; reads are refused to us.
  const sim = await startSimulator({
    stateFile,
    lease: { writer: 'other-client', epoch: 40, sessionKey: 'sk_other', expiresAt: Date.now() + 600_000 },
    readFail: true,
  })
  /** @type {RemoteGoService | null} */
  let service = null
  try {
    const logs = []
    const { sessions, appends } = createSessionsService()
    const stateDir = path.join(temp, 'state-blind')
    const adapter = createSessionAdapter({
      sessions,
      logger: createLogger(logs),
      mirrorRoot: path.join(stateDir, 'mirrors'),
    })
    service = createService({
      stateDir,
      home: path.join(temp, 'home-blind'),
      localVersion: '0.2.2-rc.1',
      logs,
      adapter,
    })
    await service.init()
    const host = await service.saveHost({
      name: 'sim-lease-blind',
      address: '127.0.0.1',
      port: sim.state.sshPort,
      username: CREDENTIALS.username,
      auth: { type: 'password' },
      keepAlive: 'keep',
      bootstrap: { mode: 'reuse' },
    })
    await connectHost(service, host.id, logs)
    await service.syncHostMirrors(host.id).catch(() => null)

    // Same defect class: wait for the refusal, not for "any reason" (L2 has its own non-null
    // reasons, which this test must not mistake for the remote's refusal).
    const mirrors = await waitForMirrors(service, host.id, (list) =>
      list.every((mirror) => mirror.reason?.code === 'fenced'),
    )
    assert.equal(
      mirrors.every((mirror) => mirror.reason?.code === 'fenced'),
      true,
      `the remote must refuse the blind writer, got ${JSON.stringify(mirrors.map((m) => m.reason?.code))}`,
    )
    assert.equal(
      appends.filter((entry) => entry.type.endsWith('/message')).length,
      0,
      'and nothing may be appended locally either',
    )
    assert.equal(
      mirrors.every((mirror) => mirror.cursor === 0),
      true,
    )
    // The refusal is visible as a typed reason in the sync log, not just an internal flag.
    assert.ok(
      logContains(logs, 'publish refused') || logContains(logs, 'stale-epoch'),
      `the remote refusal must be reported, got: ${logs
        .filter((l) => /lease/i.test(l))
        .slice(-3)
        .join(' | ')}`,
    )
  } finally {
    if (service) await service.shutdown?.().catch?.(() => null)
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

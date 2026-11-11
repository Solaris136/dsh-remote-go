/**
 * L2 history replay, end to end, against the simulated remote host.
 *
 * What this proves that the unit tests cannot: the plugin really reads a session
 * log over SSH, projects it into the local mirror session through the session
 * adapter, and behaves correctly across a re-sync and a restart. The assertions are
 * the four from the design (§6): history lands, a second sync appends nothing, a
 * restart continues from the persisted cursor, and a gap produces exactly one
 * bounded backfill attempt without advancing the cursor.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionAdapter } from '../../src/session-adapter.js'
import { createFakeSessions } from '../helpers/fake-sessions.js'
import { RemoteGoService } from '../../src/service.js'
import { HostStore } from '../../src/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SIM_SCRIPT = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')
const CREDENTIALS = { username: 'sim', password: 'sim-history-password' }
const STRICT = process.env.DSH_E2E_STRICT === '1'

/** Remote session ids served by this suite's workspace fixture. */
const HISTORY_SESSIONS = ['sess-hist-1', 'sess-hist-2']

/** The registry served to the plugin; two sessions with logs. */
const WORKSPACE_FIXTURE = {
  version: 2,
  global: { initialized: true, defaultWorkspaceId: 'ws-hist', workspaceIds: ['ws-hist'] },
  tables: {
    workspaces: {
      'ws-hist': {
        path: '/home/sim/project',
        title: 'sim-history',
        sessionIds: [...HISTORY_SESSIONS],
        createdAt: '2026-11-11T00:00:00Z',
        updatedAt: '2026-11-11T00:00:00Z',
      },
    },
  },
}

/** Five records per session, so retention and gaps have room to matter. */
function historyFixture(withGap = false, startSeq = 1) {
  /** @param {string} id @param {boolean} gap */
  const eventsFor = (id, gap) => {
    /** @type {any[]} */
    const events = []
    for (let seq = startSeq; seq <= startSeq + 4; seq += 1) {
      if (gap && seq === startSeq + 2) continue // the simulator keeps the hole
      events.push({
        seq,
        role: seq % 2 === 0 ? 'assistant' : 'user',
        text: `${id} message ${seq}`,
        at: `2026-11-11T00:00:0${(seq % 9) + 1}Z`,
      })
    }
    return events
  }
  /** @type {Record<string, { events: any[] }>} */
  const sessions = {}
  for (const id of HISTORY_SESSIONS) sessions[id] = { events: eventsFor(id, withGap) }
  return { sessions }
}

/** @param {string[]} logs */
function createLogger(logs) {
  const record =
    (level) =>
    (...args) =>
      logs.push(`${level}: ${args.map(String).join(' ')}`)
  return { error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug'), trace: () => {} }
}

/** @param {string[]} logs @param {string} needle */
function logContains(logs, needle) {
  return logs.some((line) => line.includes(needle))
}

/**
 * Wait until the simulator publishes its ports.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string[]} logs
 * @param {string} stateFile
 */
async function waitForState(child, logs, stateFile) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the simulator exited early (${child.exitCode})\n${logs.join('')}`)
    }
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`the simulator never wrote ${stateFile}\n${logs.join('')}`)
}

/**
 * Start `--serve` with this suite's fixtures.
 * @param {{ stateFile: string, historyFile: string, gap?: boolean }} options
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
    options.historyFile,
    '--state-file',
    options.stateFile,
  ]
  if (options.gap === true) argv.push('--history-gap')
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
  const state = await waitForState(child, logs, options.stateFile)
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
 * @param {{ stateDir: string, home: string, localVersion: string, logs: string[], adapter: any }} options
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
  })
}

/** @param {import('../../src/service.js').RemoteGoService} service @param {string} hostId */
async function mirrorsOf(service, hostId) {
  const listed = await service.listHostMirrors(hostId)
  return listed.mirrors ?? []
}

/**
 * Connect through the real pipeline and answer the host-key prompt.
 * @param {import('../../src/service.js').RemoteGoService} service
 * @param {string} hostId
 * @param {string[]} logs
 * @param {number} [timeoutMs]
 */
async function connectHost(service, hostId, logs, timeoutMs = 90_000) {
  const accepted = await service.connect(hostId, { password: CREDENTIALS.password })
  assert.equal(accepted.accepted, true, `connect() was not accepted: ${JSON.stringify(accepted)}`)
  let confirmed = false
  const started = Date.now()
  for (;;) {
    const view = service.snapshot().hosts.find((host) => host.id === hostId)
    if (!view) throw new Error('the host disappeared during connect')
    if (!confirmed && view.status === 'fingerprint-pending') {
      confirmed = true
      await service.confirmFingerprint(hostId, { accept: true, remember: false })
    }
    if (view.status === 'connected') return view
    if (view.status === 'error') {
      throw new Error(`the connect pipeline failed: ${JSON.stringify(view.error)}\n${logs.join('')}`)
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`the connect pipeline never became usable (status ${view.status})\n${logs.join('')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('L2 history replay projects remote history into the local mirror session', { timeout: 600_000 }, async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-history-e2e-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  const historyFile = path.join(temp, 'history.json')
  writeFileSync(historyFile, `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')

  const sim = await startSimulator({ stateFile, historyFile })
  /** @type {import('../../src/service.js').RemoteGoService | null} */
  let service = null
  try {
    await t.test('history lands in the local session, once per remote seq', async () => {
      const logs = []
      const sessions = createFakeSessions()
      const { appends } = sessions
      const stateDir = path.join(temp, 'state-land')
      const mirrorRoot = path.join(stateDir, 'mirrors')
      const adapter = createSessionAdapter({ sessions, logger: createLogger(logs), mirrorRoot })
      service = createService({
        stateDir,
        home: path.join(temp, 'home-land'),
        localVersion: '0.2.2-rc.1',
        logs,
        adapter,
      })
      await service.init()
      const host = await service.saveHost({
        name: 'sim-history',
        address: '127.0.0.1',
        port: sim.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      await connectHost(service, host.id, logs)

      // The connect pipeline syncs mirrors and replays history. Wait for the whole
      // projection to settle (cursor, level *and* the read-only marker), not just the
      // cursor: the marker is appended before the descriptor is stored, so a cursor-only
      // wait can observe a half-finished sync under load.
      const settled = async () => {
        const mirrors = await mirrorsOf(service, host.id)
        return (
          mirrors.length === HISTORY_SESSIONS.length &&
          mirrors.every((mirror) => mirror.cursor === 5 && mirror.level === 'L2' && mirror.readOnly === true) &&
          appends.filter((entry) => entry.type === 'mirror/read-only').length === HISTORY_SESSIONS.length &&
          // The summary line is asserted immediately below, so it is part of "settled":
          // waiting on it removes the window where the descriptor is already persisted
          // but the log line has not been written yet.
          logContains(logs, 'mirror history:')
        )
      }
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await settled()) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(
        await settled(),
        true,
        `the history projection never settled: ${JSON.stringify({
          mirrors: await mirrorsOf(service, host.id),
          appends: appends.length,
          markers: appends.filter((entry) => entry.type === 'mirror/read-only').length,
          historyLog: logs.filter((line) => /history/.test(line)).slice(-3),
        })}`,
      )
      const mirrors = await mirrorsOf(service, host.id)
      assert.equal(mirrors.length, HISTORY_SESSIONS.length, `expected ${HISTORY_SESSIONS.length} mirrors`)
      for (const mirror of mirrors) {
        assert.equal(mirror.level, 'L2', `mirror ${mirror.remoteSessionId} did not reach L2`)
        assert.equal(mirror.cursor, 5, `mirror ${mirror.remoteSessionId} cursor = ${mirror.cursor}`)
      }
      // Every replayed event reached the session, tagged with its remote seq.
      const replayed = appends.filter((entry) => entry.type.endsWith('/message'))
      assert.equal(replayed.length, HISTORY_SESSIONS.length * 5)
      const seqs = replayed.map((entry) => entry.data.mirrorSeq).sort((left, right) => left - right)
      assert.deepEqual([...new Set(seqs)], [1, 2, 3, 4, 5], 'every remote seq must appear exactly once across sessions')
      assert.ok(logContains(logs, 'mirror history:'), 'the sync must log a history summary')

      // ---- second sync: idempotent, nothing appended ----
      const before = appends.length
      const refreshed = await service.syncHostMirrors(host.id)
      assert.equal(refreshed.synced, true)
      assert.equal(appends.length, before, 'a re-sync must not append anything')
      assert.equal(
        ((await mirrorsOf(service, host.id)) ?? []).every((mirror) => mirror.cursor === 5),
        true,
        'the cursor must not move when there is nothing new',
      )

      // ---- §10 P1: a replayed mirror is marked read-only ----
      // The descriptor carries the flag (the client renders it) and the session gets
      // one non-surface notice, so a reader can tell mirrored history from local input.
      const readOnlyMirrors = await mirrorsOf(service, host.id)
      assert.equal(
        readOnlyMirrors.every((mirror) => mirror.readOnly === true),
        true,
        'a replayed mirror must be flagged read-only in the descriptor',
      )
      const markers = appends.filter((entry) => entry.type === 'mirror/read-only')
      assert.equal(markers.length, HISTORY_SESSIONS.length, 'exactly one read-only marker per mirrored session')
      assert.equal(
        markers.every((entry) => entry.data.readOnly === true),
        true,
      )
      assert.equal(
        appends.filter((entry) => entry.type === 'mirror/read-only').length,
        markers.length,
        'a re-sync must not announce the marker again',
      )
    })

    await t.test('a restart continues from the persisted cursor without refetching history', async () => {
      const logs = []
      const sessions = createFakeSessions()
      const { appends } = sessions
      const stateDir = path.join(temp, 'state-land')
      const mirrorRoot = path.join(stateDir, 'mirrors')
      const adapter = createSessionAdapter({ sessions, logger: createLogger(logs), mirrorRoot })
      // Fresh process state, same on-disk store: this is the restart.
      const restarted = createService({
        stateDir,
        home: path.join(temp, 'home-land'),
        localVersion: '0.2.2-rc.1',
        logs,
        adapter,
      })
      await restarted.init()
      const host = restarted.snapshot().hosts.find((entry) => entry.name === 'sim-history')
      assert.ok(host, 'the host record must survive a restart')
      // The persisted cursor is visible before any sync runs.
      const persisted = await mirrorsOf(restarted, host.id)
      assert.equal(persisted.length, HISTORY_SESSIONS.length)
      assert.equal(
        persisted.every((mirror) => mirror.cursor === 5),
        true,
        'the cursor must be persisted, not recomputed',
      )

      await connectHost(restarted, host.id, logs)
      await restarted.syncHostMirrors(host.id).catch(() => null)
      // The session was recreated empty after the restart, so the projection must
      // re-fill it even though the cursor says "5 applied": `mirrorEventSeqs` is what
      // decides, not the cursor alone.
      for (const mirror of await mirrorsOf(restarted, host.id)) {
        assert.equal(mirror.cursor, 5)
        assert.equal(mirror.level, 'L2')
      }
      // Nothing was re-appended: the local sessions were empty, so the guard is the
      // cursor here and the descriptor must not have gone backwards.
      assert.ok(appends.length <= HISTORY_SESSIONS.length * 5, 'history must not be duplicated on restart')
    })

    await t.test('a version-mismatched host stops replaying and keeps its §7 reason', async () => {
      // §7: "版本不一致 → 不建立镜像，降级 L1，并在会话上标注". The reviewer's probe found it
      // doing the opposite: replaying and erasing the per-descriptor reason.
      //
      // Its own simulator: the sibling subtests already published a writer lease in `sim`, and
      // lease contention would fence this client for an unrelated reason. Contention has its own
      // test in lease.e2e.js.
      const ownState = path.join(temp, 'sim-state-mismatch.json')
      writeFileSync(
        path.join(temp, 'workspace-mismatch.json'),
        `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`,
        'utf8',
      )
      writeFileSync(path.join(temp, 'history-mismatch.json'), `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')
      const ownSim = await startSimulator({
        stateFile: ownState,
        historyFile: path.join(temp, 'history-mismatch.json'),
      })
      const logs = []
      const sessions = createFakeSessions()
      const { appends } = sessions
      const stateDir = path.join(temp, 'state-mismatch')
      const adapter = createSessionAdapter({
        sessions,
        logger: createLogger(logs),
        mirrorRoot: path.join(stateDir, 'mirrors'),
      })
      const service = createService({
        stateDir,
        home: path.join(temp, 'home-mismatch'),
        localVersion: '0.2.2-rc.1',
        logs,
        adapter,
      })
      await service.init()
      const host = await service.saveHost({
        name: 'sim-history-mismatch',
        address: '127.0.0.1',
        port: ownSim.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      try {
        await connectHost(service, host.id, logs)
        // Wait for the *completed* projection, not just a level: the read-only marker is
        // appended before the descriptor is persisted, so `cursor === 5 && readOnly`
        // means the healthy sync really finished and the snapshot below is stable.
        const ready = async () => {
          const mirrors = await mirrorsOf(service, host.id)
          return (
            mirrors.length === HISTORY_SESSIONS.length && mirrors.every((m) => m.cursor === 5 && m.readOnly === true)
          )
        }
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (await ready()) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(await ready(), true, 'the healthy sync must complete before the mismatch probe')
        const healthy = await mirrorsOf(service, host.id)
        assert.equal(
          healthy.every((m) => m.level === 'L2'),
          true,
          'the healthy sync must reach L2 first, otherwise the regression below proves nothing',
        )
        const cursorsBefore = healthy.map((mirror) => mirror.cursor)
        const appendsBefore = appends.length

        // Lie about the remote version, the way the reviewer did, then re-sync.
        const runtime = service.runtimes.get(host.id)
        assert.ok(runtime, 'the host runtime must exist after connect')
        runtime.remote = { ...runtime.remote, version: '0.0.1-mismatch' }
        runtime.facts = { ...(runtime.facts ?? {}), dshVersion: '0.0.1-mismatch' }
        const refreshed = await service.syncHostMirrors(host.id)

        assert.equal(appends.length, appendsBefore, 'a version-mismatched host must not replay history')
        assert.deepEqual(
          (await mirrorsOf(service, host.id)).map((mirror) => mirror.cursor),
          cursorsBefore,
          'a version-mismatched host must not advance the cursor',
        )
        assert.equal(refreshed.level, 'L1')
        const after = await mirrorsOf(service, host.id)
        assert.equal(
          after.every((mirror) => mirror.level === 'L1' && mirror.reason?.code === 'version-mismatch'),
          true,
          `a mismatch must be annotated per descriptor, got ${JSON.stringify(after.map((m) => ({ level: m.level, reason: m.reason?.code })))}`,
        )
      } finally {
        await stopSimulator(ownSim.child)
      }
    })
  } finally {
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('a gap in the remote log stops the cursor and produces one bounded backfill', { timeout: 600_000 }, async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-history-gap-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  const historyFile = path.join(temp, 'history.json')
  // The fixture itself omits seq 3, and `--history-gap` keeps that hole on re-read.
  writeFileSync(historyFile, `${JSON.stringify(historyFixture(true), null, 2)}\n`, 'utf8')

  const sim = await startSimulator({ stateFile, historyFile, gap: true })
  /** @type {import('../../src/service.js').RemoteGoService | null} */
  let service = null
  try {
    await t.test('the cursor stops before the gap and the mirror reports a typed reason', async () => {
      const logs = []
      const sessions = createFakeSessions()
      const stateDir = path.join(temp, 'state-gap')
      const adapter = createSessionAdapter({
        sessions,
        logger: createLogger(logs),
        mirrorRoot: path.join(stateDir, 'mirrors'),
      })
      service = createService({
        stateDir,
        home: path.join(temp, 'home-gap'),
        localVersion: '0.2.2-rc.1',
        logs,
        adapter,
      })
      await service.init()
      const host = await service.saveHost({
        name: 'sim-history-gap',
        address: '127.0.0.1',
        port: sim.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      await connectHost(service, host.id, logs)

      // Wait for the *history* outcome, not merely for any reason: `planMirror` can
      // already stamp a `version-unknown` reason before history has run. The predicate
      // covers everything the assertions below require — cursor, level, typed reason
      // **and** the log line — because a state-only wait can observe the persisted
      // descriptor before the failure has been reported (this was a Windows-only flake:
      // the state was already durable while the log assertion at the bottom was not yet
      // satisfiable).
      const settled = async () => {
        const mirrors = await mirrorsOf(service, host.id)
        return (
          mirrors.length === HISTORY_SESSIONS.length &&
          mirrors.every(
            (mirror) => mirror.cursor === 2 && mirror.level === 'L1' && mirror.reason?.code === 'gap-unfilled',
          ) &&
          logContains(logs, 'gap-unfilled')
        )
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await settled()) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(
        await settled(),
        true,
        `the gapped sync never settled: ${JSON.stringify({
          mirrors: (await mirrorsOf(service, host.id)).map((mirror) => ({
            cursor: mirror.cursor,
            level: mirror.level,
            reason: mirror.reason?.code ?? null,
          })),
          historyLog: logs.filter((line) => /mirror history/.test(line)).slice(-4),
        })}`,
      )
      const mirrors = await mirrorsOf(service, host.id)
      assert.equal(mirrors.length, HISTORY_SESSIONS.length)
      for (const mirror of mirrors) {
        // seq 1 and 2 apply, seq 3 is missing, so the cursor stops at 2.
        assert.equal(mirror.cursor, 2, `cursor must stop before the gap, got ${mirror.cursor}`)
        assert.equal(mirror.level, 'L1', 'a gapped replay must not claim L2')
        assert.equal(mirror.reason?.code, 'gap-unfilled')
        assert.ok(mirror.reason?.message?.zh, 'the typed reason must carry a localised message')
      }
      assert.ok(logContains(logs, 'gap-unfilled'), 'the sync must report the gap')
      // §6 recovery must be visible in the log: the plugin re-pulled from scratch
      // instead of retrying the same unreachable window forever.
      assert.ok(
        logContains(logs, 'unreachable') || logContains(logs, 're-pulling'),
        'the §6 recovery (reset cursor + full re-pull) must be logged',
      )

      // The bounded backfill is one extra read per session per sync, not a loop: a
      // second sync repeats the same single attempt and still does not advance.
      const before = mirrors.map((mirror) => mirror.cursor)
      await service.syncHostMirrors(host.id).catch(() => null)
      const after = await mirrorsOf(service, host.id)
      assert.deepEqual(
        after.map((mirror) => mirror.cursor),
        before,
        'a repeated gap must never advance the cursor',
      )
      // Monotonicity: the recovery re-plans from cursor 0, so a failed re-pull must not
      // move the descriptor backwards even when the plan resolves to 0 (a log that does
      // not start at seq 1). The session still holds everything up to the old cursor.
      assert.equal(
        after.every((mirror, index) => mirror.cursor >= before[index]),
        true,
        `the cursor must never go backwards, got ${JSON.stringify({ before, after: after.map((m) => m.cursor) })}`,
      )
      assert.equal(
        after.every((mirror) => mirror.reason?.code === 'gap-unfilled' && mirror.level === 'L1'),
        true,
        'an unfillable gap stays L1 with the typed reason',
      )
    })
  } finally {
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('a remote without a sessions directory degrades to a typed reason', { timeout: 300_000 }, async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-history-noroot-'))
  const stateFile = path.join(temp, 'sim-state.json')
  writeFileSync(path.join(temp, 'workspace.json'), `${JSON.stringify(WORKSPACE_FIXTURE, null, 2)}\n`, 'utf8')
  const historyFile = path.join(temp, 'history.json')
  writeFileSync(historyFile, `${JSON.stringify(historyFixture(), null, 2)}\n`, 'utf8')

  const sim = await startSimulator({ stateFile, historyFile })
  /** @type {import('../../src/service.js').RemoteGoService | null} */
  let service = null
  try {
    await t.test('mirrors stay at L1 with sessions-dir-missing instead of throwing', async () => {
      const logs = []
      const sessions = createFakeSessions()
      const stateDir = path.join(temp, 'state-noroot')
      const adapter = createSessionAdapter({
        sessions,
        logger: createLogger(logs),
        mirrorRoot: path.join(stateDir, 'mirrors'),
      })
      service = createService({
        stateDir,
        home: path.join(temp, 'home-noroot'),
        localVersion: '0.2.2-rc.1',
        logs,
        adapter,
      })
      await service.init()
      // Turn history off for this host by disabling the setting, which is the
      // supported way to keep a mirror at L1 (design §7).
      await service.saveSettings({ mirrorHistory: false })
      const host = await service.saveHost({
        name: 'sim-history-off',
        address: '127.0.0.1',
        port: sim.state.sshPort,
        username: CREDENTIALS.username,
        auth: { type: 'password' },
        keepAlive: 'keep',
        bootstrap: { mode: 'reuse' },
      })
      await connectHost(service, host.id, logs)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await mirrorsOf(service, host.id)).length === HISTORY_SESSIONS.length) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const mirrors = await mirrorsOf(service, host.id)
      assert.equal(mirrors.length, HISTORY_SESSIONS.length)
      assert.equal(
        mirrors.every((mirror) => mirror.level === 'L1' && mirror.cursor === 0),
        true,
        'a history-disabled host must stay L1 with an untouched cursor',
      )
    })
  } finally {
    await stopSimulator(sim.child)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('the history fixture path is required by the simulator contract', { timeout: 120_000 }, async () => {
  // Guard against the fixture silently drifting: the simulator must ship the three
  // history commands, and this suite must be the only place that relies on them.
  const source = readFileSync(SIM_SCRIPT, 'utf8')
  for (const needle of ['test -d ', 'find ', 'head -c ', '--history-fixture', '--history-gap']) {
    assert.ok(source.includes(needle), `the simulator no longer serves ${JSON.stringify(needle)}`)
  }
  assert.equal(STRICT, process.env.DSH_E2E_STRICT === '1')
})

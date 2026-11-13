import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionAdapter } from '../../src/session-adapter.js'
import { RemoteGoService } from '../../src/service.js'
import { HostStore } from '../../src/store.js'

// L3 activated (design §6.4). These are the tests the first attempt never ran: the transport was
// fixed twice and never re-tested, which is why a dead subsystem nearly shipped.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SIM = path.join(ROOT, 'e2e', 'sim', 'simulated-remote.mjs')
const SESSION = 'sess-stream-1'
const WORKSPACE = {
  version: 2,
  global: { initialized: true, defaultWorkspaceId: 'ws', workspaceIds: ['ws'] },
  tables: { workspaces: { ws: { path: '/home/sim/project', title: 'project', sessionIds: [SESSION] } } },
}

/** Three records already on disk at connect; two more land afterwards. */
function writeFixtures(dir) {
  writeFileSync(path.join(dir, 'workspace.json'), `${JSON.stringify(WORKSPACE, null, 2)}\n`, 'utf8')
  writeFileSync(
    path.join(dir, 'history.json'),
    `${JSON.stringify(
      {
        sessions: {
          [SESSION]: {
            events: [1, 2, 3].map((seq) => ({
              seq,
              at: `2026-11-12T00:00:0${seq}Z`,
              type: 'message',
              data: { text: `base ${seq}` },
            })),
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(dir, 'stream.json'),
    `${JSON.stringify(
      {
        sessions: {
          [SESSION]: [4, 5].map((seq) => ({
            seq,
            at: `2026-11-12T00:01:0${seq}Z`,
            type: 'message',
            data: { text: `live ${seq}` },
          })),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function startSim(dir, fence) {
  const stateFile = path.join(dir, 'state.json')
  rmSync(stateFile, { force: true })
  const argv = [
    SIM,
    '--serve',
    '--workspace-fixture',
    path.join(dir, 'workspace.json'),
    '--history-fixture',
    path.join(dir, 'history.json'),
    '--stream-fixture',
    path.join(dir, 'stream.json'),
    '--state-file',
    stateFile,
  ]
  if (fence === true) argv.push('--stream-fence')
  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIM_SSH_USER: 'sim', SIM_SSH_PASSWORD: 'sim-pw' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  /** @type {string[]} */
  const logs = []
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)))
  /** @type {any} */
  let state = null
  for (let attempt = 0; attempt < 300 && state === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch {
      state = null
    }
  }
  if (state === null) {
    child.kill('SIGKILL')
    throw new Error(`sim never published state\n${logs.join('')}`)
  }
  return { child, state, logs }
}

async function stopSim(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const done = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (!done) child.kill('SIGKILL')
}

/** A `sessions` fake shaped after the real host Session (no `events` property). */
function fakeSessions() {
  /** @type {Map<string, any>} */
  const live = new Map()
  /** @type {Map<string, Set<number>>} */
  const seqs = new Map()
  return {
    live,
    create(id) {
      /** @type {any[]} */
      let committed = []
      const session = {
        id,
        get seq() {
          return committed.length
        },
        append(type, data) {
          const event = { type, seq: committed.length + 1, data }
          committed = [...committed, event]
          const seen = seqs.get(id) ?? new Set()
          if (Number.isInteger(data?.mirrorSeq)) seen.add(data.mirrorSeq)
          seqs.set(id, seen)
          return event
        },
        snapshotEvents() {
          return committed
        },
        mirrorEventSeqs() {
          return seqs.get(id) ?? new Set()
        },
      }
      live.set(id, session)
      return session
    },
    get(id) {
      return live.get(id)
    },
  }
}

/**
 * Poll for the asserted end state. The predicate covers every field the assertions read.
 * @param {RemoteGoService} service @param {string} hostId
 * @param {(mirrors: any[]) => boolean} predicate
 */
async function waitFor(service, hostId, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  /** @type {any[]} */
  let mirrors = []
  while (Date.now() < deadline) {
    mirrors = (await service.listHostMirrors(hostId)).mirrors ?? []
    if (mirrors.length > 0 && predicate(mirrors)) return mirrors
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return mirrors
}

async function harness({ mirrorStream, fence = false, logLevel }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-stream-'))
  writeFixtures(dir)
  const sim = await startSim(dir, fence)
  /** Every line that actually reached the logger, with its level. @type {{level: string, line: string}[]} */
  const captured = []
  /** @param {string} level */
  const recorder =
    (level) =>
    (...parts) => {
      const line = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      captured.push({ level, line })
    }
  const quiet = { warn: recorder('warn'), info: recorder('info'), debug: recorder('debug'), error: recorder('error') }
  const sessions = fakeSessions()
  const stateDir = path.join(dir, 'state')
  const adapter = createSessionAdapter({ sessions, logger: quiet, mirrorRoot: path.join(stateDir, 'mirrors') })
  const service = new RemoteGoService({
    store: new HostStore({ dir: stateDir, logger: quiet }),
    home: path.join(dir, 'home'),
    localVersion: '0.2.2-rc.1',
    logger: quiet,
    // Only set when a test asks: the default path must be the shipped one.
    ...(typeof logLevel === 'string' ? { logLevel } : {}),
    loadSshMaterial: async () => ({ configText: '', knownHostsText: '' }),
    sessionAdapter: adapter,
    workspaceAdapter: null,
  })
  await service.init()
  await service.saveSettings({ mirrorStream, mirrorHistory: true })
  const host = await service.saveHost({
    name: 'sim-stream',
    address: '127.0.0.1',
    port: sim.state.sshPort,
    username: 'sim',
    auth: { type: 'password' },
    keepAlive: 'keep',
  })
  return {
    service,
    host,
    sessions,
    sim,
    captured,
    async close() {
      await service.shutdown?.().catch?.(() => null)
      await stopSim(sim.child)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Connect, tolerating the fingerprint prompt. @param {RemoteGoService} service @param {string} id */
async function connect(service, id, logs) {
  await service.connect(id, { password: 'sim-pw' })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const view = service.snapshot().hosts.find((entry) => entry.id === id)
    if (view?.status === 'fingerprint-pending') {
      await service.confirmFingerprint(id, { accept: true, remember: false })
      continue
    }
    if (view?.status === 'connected') return view
    if (view?.status === 'error') throw new Error(`connect failed: ${JSON.stringify(view.error)}\n${logs.join('')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`connect timed out\n${logs.join('')}`)
}

test(
  'records appended while connected arrive through the follower, without another sync',
  { timeout: 600_000 },
  async () => {
    const h = await harness({ mirrorStream: true })
    try {
      await connect(h.service, h.host.id, h.sim.logs)
      // Count syncs now: any further syncHostMirrors call would let the test pass for the wrong
      // reason (a background sync delivering the records instead of the follower).
      const syncCalls = { count: 0 }
      const original = h.service.syncHostMirrors.bind(h.service)
      h.service.syncHostMirrors = async (...args) => {
        syncCalls.count += 1
        return original(...args)
      }

      const mirrors = await waitFor(h.service, h.host.id, (list) =>
        list.every((mirror) => mirror.cursor === 5 && mirror.level === 'L2' && mirror.reason === null),
      )
      assert.equal(
        mirrors.every((mirror) => mirror.cursor === 5),
        true,
        `the follower must advance the cursor to 5, got ${JSON.stringify(
          mirrors.map((mirror) => ({ cursor: mirror.cursor, level: mirror.level, reason: mirror.reason?.code })),
        )}`,
      )
      assert.equal(syncCalls.count, 0, 'no manual or background sync may have delivered these records')

      const session = [...h.sessions.live.values()][0]
      const seqs = [...(session?.mirrorEventSeqs?.() ?? [])].sort((left, right) => left - right)
      assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'every remote record appears')
      // Count mirrored records, not every event: replay can add a bookkeeping event that carries no
      // `mirrorSeq` (folding/notice), and asserting a raw total would conflate the two.
      const all = session?.snapshotEvents?.() ?? []
      const mirrored = all.filter((event) => Number.isInteger(event?.data?.mirrorSeq))
      const mirroredSeqs = mirrored.map((event) => event.data.mirrorSeq).sort((left, right) => left - right)
      assert.deepEqual(mirroredSeqs, [1, 2, 3, 4, 5], 'each remote record is applied exactly once')
      assert.equal(mirrored.length, 5, 'no record is applied twice — no duplication between log and stream')
      assert.equal(
        all.length - mirrored.length <= 1,
        true,
        `at most one bookkeeping event may accompany the records, got ${all.length - mirrored.length}`,
      )
    } finally {
      await h.close()
    }
  },
)

test(
  'with the setting off nothing is appended, so the follower is what did the work',
  { timeout: 600_000 },
  async () => {
    // The negative control. Without it, a background sync could be delivering the records and the
    // activation test above would pass for the wrong reason.
    const h = await harness({ mirrorStream: false })
    try {
      await connect(h.service, h.host.id, h.sim.logs)
      const mirrors = await waitFor(h.service, h.host.id, (list) => list.every((mirror) => mirror.cursor === 3), 20_000)
      assert.equal(
        mirrors.every((mirror) => mirror.cursor === 3),
        true,
        'with the follower off the cursor must stay at the log-read position (3)',
      )
      const session = [...h.sessions.live.values()][0]
      const seqs = [...(session?.mirrorEventSeqs?.() ?? [])].sort((left, right) => left - right)
      assert.deepEqual(seqs, [1, 2, 3], 'no streamed record may appear while the setting is off')
    } finally {
      await h.close()
    }
  },
)

test('a fenced host streams nothing and keeps its cursor where the log left it', { timeout: 600_000 }, async () => {
  const h = await harness({ mirrorStream: true, fence: true })
  try {
    await connect(h.service, h.host.id, h.sim.logs)
    // Wait for the fenced end state specifically: an L2 mirror also has a non-null reason.
    const mirrors = await waitFor(
      h.service,
      h.host.id,
      (list) => list.every((mirror) => mirror.reason?.code === 'fenced'),
      45_000,
    )
    assert.equal(
      mirrors.every((mirror) => mirror.reason?.code === 'fenced'),
      true,
      `the remote refusal must surface as \`fenced\`, got ${JSON.stringify(
        mirrors.map((mirror) => mirror.reason?.code),
      )}`,
    )
    assert.equal(
      mirrors.every((mirror) => mirror.cursor <= 3),
      true,
      'a fenced host must not consume streamed records',
    )
  } finally {
    await h.close()
  }
})

test('a reconnect resumes from the persisted cursor without duplicating records', { timeout: 600_000 }, async () => {
  const h = await harness({ mirrorStream: true })
  try {
    await connect(h.service, h.host.id, h.sim.logs)
    const mirrors = await waitFor(h.service, h.host.id, (list) =>
      list.every((mirror) => mirror.cursor === 5 && mirror.level === 'L2'),
    )
    const before = mirrors.every((mirror) => mirror.cursor === 5)
    assert.equal(before, true, 'the follower must reach the streamed records first')

    const countMirrored = () => {
      const session = [...h.sessions.live.values()][0]
      return (session?.snapshotEvents?.() ?? []).filter((event) => Number.isInteger(event?.data?.mirrorSeq)).length
    }
    const beforeCount = countMirrored()

    // Drop the connection and bring it back: the follower restarts with an empty offset, so the
    // only thing preventing duplicates is the persisted cursor plus `seq > cursor` / `mirrorSeq`.
    await h.service.disconnect(h.host.id).catch(() => null)
    await connect(h.service, h.host.id, h.sim.logs)
    const after = await waitFor(h.service, h.host.id, (list) =>
      list.every((mirror) => mirror.cursor === 5 && mirror.level === 'L2' && mirror.reason === null),
    )
    assert.equal(
      after.every((mirror) => mirror.cursor === 5),
      true,
      'the cursor must be where it was after reconnecting',
    )
    assert.equal(countMirrored(), beforeCount, 'a reconnect must not re-append records it already has')

    // (c) The instrument's own proof, at the **shipped** default log level with no override.
    // Reconnecting resets the ephemeral offset to 0, so the follower re-reads records it has
    // already applied: those polls legitimately do not advance the cursor, which is exactly the
    // branch that must be visible without enabling debugging.
    // Wait for the instrument, not for the cursor: the cursor is already where it was, so
    // asserting immediately would run before the first post-reconnect poll.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (h.captured.some((entry) => entry.level === 'info' && entry.line.includes('mirror stream: trace'))) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const traces = h.captured.filter((entry) => entry.line.includes('mirror stream: trace'))
    assert.equal(traces.length > 0, true, 'a non-advancing poll must emit a trace at the default level')
    const visible = traces.filter((entry) => entry.level === 'info')
    assert.equal(visible.length > 0, true, 'the no-advance trace must reach the logger at info, not debug')
    for (const field of [
      'sessionId',
      'offsetBefore',
      'rawBytes',
      'parsedEvents',
      'planCursor',
      'persistedCursor',
      'guard',
    ]) {
      assert.equal(visible[0].line.includes(`${field}:`), true, `the visible trace must report ${field}`)
    }
    // And the threshold is real in the other direction: at the default level no debug line reaches
    // the logger, so the info trace above was not simply "everything gets printed".
    assert.equal(
      h.captured.some((entry) => entry.level === 'debug'),
      false,
      'at the default level nothing at debug may reach the logger',
    )
  } finally {
    await h.close()
  }
})

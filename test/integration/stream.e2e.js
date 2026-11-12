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

async function harness({ mirrorStream, fence = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-stream-'))
  writeFixtures(dir)
  const sim = await startSim(dir, fence)
  /** @type {string[]} */
  const logLines = []
  const line = (...parts) => parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  const quiet = {
    warn: (...p) => logLines.push(`W ${line(...p)}`),
    info: (...p) => logLines.push(`I ${line(...p)}`),
    debug: (...p) => logLines.push(`D ${line(...p)}`),
    error: (...p) => logLines.push(`E ${line(...p)}`),
  }
  const sessions = fakeSessions()
  const stateDir = path.join(dir, 'state')
  const adapter = createSessionAdapter({ sessions, logger: quiet, mirrorRoot: path.join(stateDir, 'mirrors') })
  const service = new RemoteGoService({
    store: new HostStore({ dir: stateDir, logger: quiet }),
    home: path.join(dir, 'home'),
    localVersion: '0.2.2-rc.1',
    logger: quiet,
    loadSshMaterial: async () => ({ configText: '', knownHostsText: '' }),
    resolveTarget: () => ({ targetVersion: '0.2.2-rc.1', source: 'test' }),
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
    bootstrap: { mode: 'reuse' },
  })
  return {
    service,
    host,
    sessions,
    sim,
    logLines,
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

test('records appended while connected arrive through the follower, without another sync', { timeout: 600_000 }, async () => {
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
    if (mirrors.every((m) => m.cursor !== 5)) {
      throw new Error(`TRACE:
${h.logLines.filter((l) => l.includes('mirror stream')).slice(0, 12).join('\n')}`)
    }

    const session = [...h.sessions.live.values()][0]
    const seqs = [...(session?.mirrorEventSeqs?.() ?? [])].sort((left, right) => left - right)
    assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'every remote record appears')
    const all = session?.snapshotEvents?.() ?? []
    assert.equal(all.length, 5, 'and exactly once each — no duplication between log and stream')
  } finally {
    await h.close()
  }
})

test('with the setting off nothing is appended, so the follower is what did the work', { timeout: 600_000 }, async () => {
  // The negative control. Without it, a background sync could be delivering the records and the
  // activation test above would pass for the wrong reason.
  const h = await harness({ mirrorStream: false })
  try {
    await connect(h.service, h.host.id, h.sim.logs)
    const mirrors = await waitFor(
      h.service,
      h.host.id,
      (list) => list.every((mirror) => mirror.cursor === 3),
      20_000,
    )
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
})

test('a fenced host streams nothing and keeps its cursor where the log left it', { timeout: 600_000 }, async () => {
  const h = await harness({ mirrorStream: true, fence: true })
  try {
    await connect(h.service, h.host.id, h.sim.logs)
    // Wait for the fenced end state specifically: an L2 mirror also has a non-null reason.
    const mirrors = await waitFor(h.service, h.host.id, (list) =>
      list.every((mirror) => mirror.reason?.code === 'fenced'),
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

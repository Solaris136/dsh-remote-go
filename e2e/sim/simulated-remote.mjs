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
//   --history-fixture <file> (SIM_HISTORY_FIXTURE)              session logs served for
//                                                             `sessions/**/session-*.json[l]`
//                                                             (`{ sessions: { "<id>": { events } } }`)
//   --history-gap                                               drop a middle record, so the plugin must
//                                                             detect a seq hole and stop its cursor there
//   --history-no-root                                           model a remote with no `sessions/` dir
//                                                             (typed `sessions-dir-missing` path)
//   --lease-fixture <file> (SIM_LEASE_FIXTURE)                  seed the writer authority at
//                                                             `remote-go/lease.json` (`{ writer, epoch, expiresAt,
//                                                             sessionKey }`). The sim then VALIDATES publishes:
//                                                             stale epoch / session-key mismatch / implausible
//                                                             jump are refused, which is what makes the channel
//                                                             enforced rather than advisory
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
import { buildProbeScript, parseProbeOutput, toProbeFacts } from '../../src/probe.js'
import { assertSupportedRemote } from '../../src/bootstrap.js'
import { createHostKey } from './host-key.mjs'

const { Server: SshServer, Client: SshClient } = ssh2

/**
 * The installed `ssh2` version, for a host-key failure report.
 * @returns {string}
 */
function ssh2Version() {
  try {
    return JSON.parse(readFileSync(new URL('../../node_modules/ssh2/package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

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
/** @typedef {{ remotePort: number, pid: number, started: boolean, token: string, historyProbes?: number, historyDiscovery?: number, historyReads?: Record<string, number>, leaseReads?: number, leaseWrites?: number, leaseRefusals?: number, suspiciousJumps?: number, authority?: any, authorityHistory?: any[] }} SimState */

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

/**
 * Session-history answers served to the L2 replay path (`src/history.js`).
 *
 * Fixture shape (all optional):
 * `{ sessions: { "<remoteSessionId>": { events: [...] } }, default: { events: [...] } }`
 * Without a fixture the simulator invents a small, deterministic log per session so
 * a plain `--serve` still answers history reads.
 * @typedef {{ sessions: Record<string, any[]>, default: any[], gap: boolean, rootAvailable: boolean }} HistoryAnswer
 */

/** Deterministic fallback log, so history reads work without a fixture. */
function defaultHistoryEvents(remoteSessionId) {
  return [
    { seq: 1, role: 'user', text: `hello from ${remoteSessionId}`, at: '2026-11-11T00:00:01Z' },
    { seq: 2, role: 'assistant', text: 'acknowledged', at: '2026-11-11T00:00:02Z' },
  ]
}

/**
 * @returns {HistoryAnswer}
 */
function loadHistoryAnswer() {
  /** @type {{ sessions: Record<string, any[]>, default: any[], gap: boolean, rootAvailable: boolean }} */
  const answer = { sessions: {}, default: [], gap: args['history-gap'] === true, rootAvailable: true }
  // `--history-no-root` models a remote whose DSH_HOME has no session store yet;
  // the plugin must degrade to a typed reason instead of throwing.
  if (args['history-no-root'] === true) answer.rootAvailable = false
  const requested = args['history-fixture'] ?? process.env.SIM_HISTORY_FIXTURE ?? null
  if (requested === null) return answer
  if (typeof requested !== 'string' || requested.trim() === '') {
    console.error('[sim] --history-fixture needs a file path')
    process.exit(2)
  }
  const resolved = path.resolve(requested)
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    fatal(`history fixture ${resolved}`, error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[sim] history fixture ${resolved} must be an object`)
    process.exit(2)
  }
  if (parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      const events = Array.isArray(value) ? value : value?.events
      if (!Array.isArray(events)) {
        console.error(`[sim] history fixture session ${sessionId} needs an events array`)
        process.exit(2)
      }
      answer.sessions[sessionId] = events
    }
  }
  const fallback = Array.isArray(parsed) ? parsed : parsed.default?.events
  if (Array.isArray(fallback)) answer.default = fallback
  if (parsed.gap === true) answer.gap = true
  return answer
}

/**
 * Events served for one remote session. `--history-gap` removes one middle record
 * so the plugin must notice a missing `seq` and stop before it.
 * @param {HistoryAnswer} answer
 * @param {string} remoteSessionId
 * @param {{ reads?: number }} state
 * @returns {any[]}
 */
function historyEventsFor(answer, remoteSessionId, state) {
  const events =
    answer.sessions[remoteSessionId] ??
    (answer.default.length > 0 ? answer.default : defaultHistoryEvents(remoteSessionId))
  if (!answer.gap || events.length < 3) return events
  // Drop the second-to-last event: the log now has a hole the plugin must detect.
  return events.filter((_event, index) => index !== events.length - 2)
}

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
const HISTORY = loadHistoryAnswer()
/** Records served by the polled follower (design §6.4). @returns {Record<string, any[]>} */
function loadStreamAnswer() {
  const file = args['stream-fixture'] ?? process.env.SIM_STREAM_FIXTURE ?? null
  if (!file) return {}
  /** @type {any} */
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object') return {}
  return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
}
const STREAM = loadStreamAnswer()
const STREAM_FENCE = process.argv.includes('--stream-fence')

/**
 * The writer authority the simulated remote publishes (L3 prerequisite, design §6.2).
 *
 * `null` means "no authority file" — the normal state for an unmodified DSH. When set, the
 * plugin can observe a competing writer/epoch over the same SSH `exec` transport it already
 * uses for L1/L2, which is what makes a fencing scenario testable end to end.
 * @type {{ writer: string | null, epoch: number | null } | null}
 */
const LEASE = loadLeaseAnswer()

/**
 * @returns {{ writer: string | null, epoch: number | null } | null}
 */
/**
 * The authority record this remote currently recognises, or null when nobody holds it.
 *
 * A record whose `expiresAt` has passed is *not* returned: an expired lease is free, which is
 * what makes a crashed writer recoverable instead of blocking the mirror forever.
 * @param {any} sim
 * @returns {{ writer: string, epoch: number, expiresAt: number, sessionKey: string } | null}
 */
function currentAuthority(sim, file = '') {
  const keyed = sessionKeyOf(file)
  const map = sim?.authorities ?? null
  const current = map === null || map === undefined ? (sim?.authority ?? null) : (map[keyed] ?? null)
  if (current !== null) {
    if (Number(current.expiresAt) > Date.now()) return current
    return {
      writer: current.writer,
      epoch: current.epoch,
      expiresAt: current.expiresAt,
      sessionKey: current.sessionKey,
    }
  }
  return LEASE === null ? null : { ...LEASE }
}

/**
 * The remote-side acceptance rule for a published record (design §6.2).
 *
 * This is the half the plugin cannot do for itself: a partitioned writer that ignored its own
 * local check still cannot take the lease, because the authority refuses it here.
 *
 * Rules, in order:
 * - a record with no writer / epoch / sessionKey is malformed;
 * - a **jump** beyond the window is refused as `implausible-epoch` and never adopted — otherwise
 *   publishing a huge number would be a one-line denial of service;
 * - an epoch **below** the current one is refused as `stale-epoch` (this is the stale writer);
 * - the same epoch from a different session key is refused as `writer-changed`;
 * - an expired current record is free to take over;
 * - otherwise accepted (new grant, renewal, or tombstone).
 *
 * @param {any} record
 * @param {any} sim
 * @returns {{ ok: true, record: any } | { ok: false, reason: string, remoteEpoch: number | null }}
 */
function sessionKeyOf(file) {
  return /lease(?:-([^'/]*))?\.json$/.exec(String(file ?? ''))?.[1] ?? ''
}

function acceptAuthority(record, sim, fileOrKey = '') {
  const writer = typeof record?.writer === 'string' ? record.writer.trim() : ''
  const epoch = Number(record?.epoch)
  const sessionKey = typeof record?.sessionKey === 'string' ? record.sessionKey.trim() : ''
  if (writer === '' || !Number.isInteger(epoch) || epoch < 1 || sessionKey === '') {
    return { ok: false, reason: 'malformed', remoteEpoch: null }
  }
  const keyed = String(fileOrKey ?? '')
  const map = sim.authorities ?? null
  const current =
    map === null || map === undefined
      ? (sim.authority ?? (LEASE === null ? null : { ...LEASE, sessionKey: LEASE.sessionKey ?? '' }))
      : (map[keyed] ?? null)
  const normalized = {
    writer,
    epoch,
    expiresAt: Number(record?.expiresAt) || 0,
    sessionKey,
  }
  if (current === null || Number(current.expiresAt) <= Date.now()) return { ok: true, record: normalized }
  const window = Number(sim.epochJumpLimit) > 0 ? Number(sim.epochJumpLimit) : 1000
  if (epoch > Number(current.epoch) + window) {
    sim.suspiciousJumps = (sim.suspiciousJumps ?? 0) + 1
    return { ok: false, reason: 'implausible-epoch', remoteEpoch: Number(current.epoch) }
  }
  if (epoch < Number(current.epoch)) {
    return { ok: false, reason: 'stale-epoch', remoteEpoch: Number(current.epoch) }
  }
  // Same epoch from the SAME writer is a restart/renewal of its own lease, so it is accepted
  // and the record takes the new connection key. Only a *different* writer at the same epoch is
  // a real `writer-changed` — otherwise restarting the plugin would fence itself.
  if (epoch === Number(current.epoch) && writer !== current.writer && sessionKey !== (current.sessionKey ?? '')) {
    return { ok: false, reason: 'writer-changed', remoteEpoch: Number(current.epoch) }
  }
  return { ok: true, record: normalized }
}

/**
 * Answer a publish with the machine-readable refusal line the plugin classifies.
 * @param {any} sim @param {string} reason @param {number | null} remoteEpoch
 */
function refused(sim, reason, remoteEpoch) {
  sim.leaseRefusals = (sim.leaseRefusals ?? 0) + 1
  const suffix = remoteEpoch === null ? '' : ` ${remoteEpoch}`
  return { code: 3, stdout: `dsh-lease: ${reason}${suffix}\n`, stderr: '' }
}

function loadLeaseAnswer() {
  const requested = args['lease-fixture'] ?? process.env.SIM_LEASE_FIXTURE ?? null
  if (requested === null) return null
  if (typeof requested !== 'string' || requested.trim() === '') {
    console.error('[sim] --lease-fixture needs a file path')
    process.exit(2)
  }
  const resolved = path.resolve(requested)
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    fatal(`lease fixture ${resolved}`, error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[sim] lease fixture ${resolved} must be an object`)
    process.exit(2)
  }
  return {
    writer: typeof parsed.writer === 'string' ? parsed.writer : null,
    epoch: Number.isInteger(parsed.epoch) ? parsed.epoch : null,
    expiresAt: Number.isFinite(Number(parsed.expiresAt)) ? Number(parsed.expiresAt) : Date.now() + 60_000,
    sessionKey: typeof parsed.sessionKey === 'string' ? parsed.sessionKey : '',
  }
}
/**
 * Sessions that have a log on this simulated host: every id the served registry
 * advertises, plus anything the history fixture names. An id outside this set
 * answers "no log", which is how the plugin's `no-session-log` path is exercised.
 */
const HISTORY_SESSION_IDS = new Set()
{
  const table = JSON.parse(WORKSPACE.json)?.tables?.workspaces ?? {}
  for (const entry of Object.values(table)) {
    for (const id of Array.isArray(entry?.sessionIds) ? entry.sessionIds : []) HISTORY_SESSION_IDS.add(id)
  }
  for (const id of Object.keys(HISTORY.sessions)) HISTORY_SESSION_IDS.add(id)
}

/** @param {string} remoteSessionId @returns {boolean} */
function historySessionExists(remoteSessionId) {
  return HISTORY_SESSION_IDS.has(remoteSessionId)
}

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

  // 4c. The polled follower (src/mirror-stream.js). The install command is accepted and discarded:
  // the simulated remote has no filesystem to install into, and the plugin only requires exit 0.
  if (cmd.startsWith('mkdir -p ') && cmd.includes('follow.mjs')) return ok('')

  const follow = cmd.match(/^node '([^']*follow\.mjs)' '([A-Za-z0-9+/=]+)'$/)
  if (follow) {
    sim.streamPolls = (sim.streamPolls ?? 0) + 1
    if (STREAM_FENCE === true) {
      // The remote refuses on its own side of the boundary, exactly as the real helper does.
      sim.streamRefusals = (sim.streamRefusals ?? 0) + 1
      return ok(JSON.stringify({ ok: false, reason: 'stale-epoch', remoteEpoch: 9 }))
    }
    /** @type {any} */
    let args = null
    try {
      args = JSON.parse(Buffer.from(follow[2], 'base64').toString('utf8'))
    } catch {
      args = null
    }
    if (!args) return ok(JSON.stringify({ ok: false, reason: 'log-malformed' }))
    // The log is the history fixture plus whatever the scenario says landed after connect.
    /** @type {any[]} */
    const records = []
    for (const [sessionId, entry] of Object.entries(HISTORY)) {
      const own = Array.isArray(entry?.events) ? entry.events : []
      for (const event of own) records.push({ sessionId, event })
    }
    for (const [sessionId, extra] of Object.entries(STREAM)) {
      for (const event of Array.isArray(extra) ? extra : []) records.push({ sessionId, event, streamed: true })
    }
    const wanted = records
      .filter((record) => args.logPath.includes(record.sessionId))
      .sort((left, right) => Number(left.event.seq) - Number(right.event.seq))
    const body = wanted.map((record) => JSON.stringify(record.event)).join('\n')
    const bytes = Buffer.from(body + (body === '' ? '' : '\n'), 'utf8')
    const from = Math.min(Math.max(0, Number(args.offset) || 0), bytes.length)
    const slice = bytes.subarray(from)
    const text = slice.toString('utf8')
    const cut = text.lastIndexOf('\n')
    const usable = cut < 0 ? '' : text.slice(0, cut + 1)
    /** @type {any[]} */
    const events = []
    for (const line of usable.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      events.push(JSON.parse(trimmed))
    }
    return ok(
      JSON.stringify({
        ok: true,
        offset: from + Buffer.byteLength(usable, 'utf8'),
        bytes: bytes.length,
        events,
        truncated: false,
      }),
    )
  }

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

  // 4b. L2 history replay (src/history.js fetchRemoteHistory): directory probe,
  //     discovery and the bounded read. Counters live on `sim` so a test can prove
  //     "exactly one bounded backfill".
  if (/^test -d '[^']*\/sessions' && echo yes \|\| echo no$/.test(cmd)) {
    sim.historyProbes = (sim.historyProbes ?? 0) + 1
    return ok(HISTORY.rootAvailable ? 'yes\n' : 'no\n')
  }
  const discovery =
    /^find '[^']*\/sessions' -maxdepth \d+ -type f -name '\*([^']*)\*' 2>\/dev\/null \| head -n \d+$/.exec(cmd)
  if (discovery) {
    sim.historyDiscovery = (sim.historyDiscovery ?? 0) + 1
    const sessionId = discovery[1]
    if (!HISTORY.rootAvailable) return ok('')
    if (!historySessionExists(sessionId)) return ok('')
    // Both shapes exist in the wild; serve the JSONL stream as the live log.
    return ok(
      `/home/sim/.dsh/sessions/ws-sim/session-${sessionId}.jsonl\n/home/sim/.dsh/sessions/ws-sim/session-${sessionId}.json\n`,
    )
  }
  const historyRead = /^head -c (\d+) '([^']*\/sessions\/[^']*)' 2>&1 \|\| true$/.exec(cmd)
  if (historyRead) {
    const sessionId = /session-([^./]+)\./.exec(historyRead[2])?.[1] ?? ''
    sim.historyReads = sim.historyReads ?? {}
    sim.historyReads[sessionId] = (sim.historyReads[sessionId] ?? 0) + 1
    const events = historyEventsFor(HISTORY, sessionId, sim)
    if (HISTORY.gap && sim.historyReads[sessionId] > 1) {
      // A backfill attempt for a gapped log still leaves the hole: the plugin must
      // report `gap-unfilled` and keep its cursor.
      return ok(`${JSON.stringify({ version: 1, session: { id: sessionId }, events })}\n`)
    }
    return ok(`${JSON.stringify({ version: 1, session: { id: sessionId }, events })}\n`)
  }

  // 4b. Writer authority: read + publish (src/lease.js, design §6.2).
  //
  // The simulated remote plays the authority the plugin does not have: it validates a
  // published record and REFUSES a stale epoch, a mismatched session key, or an implausible
  // jump. That refusal is what makes the channel enforced rather than advisory.
  const leaseRead = /^head -c (\d+) '([^']*\/remote-go\/lease(?:-[^'\/]*)?\.json)' 2>&1 \|\| true$/.exec(cmd)
  if (leaseRead) {
    sim.leaseReads = (sim.leaseReads ?? 0) + 1
    // `--lease-read-fail` models a writer that cannot see the authority (partition, permission
    // change). It must still be refused on publish — that is the point of the channel.
    if (args['lease-read-fail'] === true) return { code: 1, stdout: 'head: Permission denied\n', stderr: '' }
    const current = currentAuthority(sim, leaseRead[2])
    // No record means the remote has never been claimed: answered the way an absent file is
    // (empty output, not an error).
    if (current === null) return ok('')
    return ok(`${JSON.stringify(current)}\n`)
  }

  const leaseWrite = /^mkdir -p .+; printf '%s' '([A-Za-z0-9+/=]+)' \| \(base64 -d/.exec(cmd)
  if (leaseWrite) {
    sim.leaseWrites = (sim.leaseWrites ?? 0) + 1
    let record
    try {
      record = JSON.parse(Buffer.from(leaseWrite[1], 'base64').toString('utf8'))
    } catch {
      return refused(sim, 'malformed', null)
    }
    const verdict = acceptAuthority(record, sim, /lease(?:-([^'\/]*))?\.json$/.exec(cmd)?.[1] ?? '')
    if (verdict.ok !== true) return refused(sim, verdict.reason, verdict.remoteEpoch)
    const slot = /lease(?:-([^'/]*))?\.json$/.exec(cmd)?.[1] ?? ''
    sim.authorities = sim.authorities ?? {}
    sim.authorities[slot] = verdict.record
    sim.authority = verdict.record
    sim.authorityHistory = sim.authorityHistory ?? []
    sim.authorityHistory.push({ writer: verdict.record.writer, epoch: verdict.record.epoch })
    return ok('')
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

  // 8. Remote log tail: a `tail -n <lines> <logFile>` read of the log file.
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
  // The host key is generated in memory and validated before anything listens: a
  // key that ssh2 cannot parse (e.g. after a CRLF round-trip) must fail here, with
  // the reason, instead of leaving the client to fail at handshake time.
  /** @type {import('./host-key.mjs').HostKey} */
  let hostKey
  try {
    hostKey = createHostKey()
  } catch (error) {
    console.error(`[sim] cannot build the SSH host key: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`[sim] node ${process.version}, ssh2 ${ssh2Version()}`)
    console.error('[sim] the key is generated in memory and never written to disk; report this with the versions above')
    await withTimeout(new Promise((resolve) => remote.server.close(() => resolve(undefined))), 5_000, 'shutdown').catch(
      () => {},
    )
    process.exit(2)
  }
  const fingerprint = hostKey.fingerprint

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

  /** @type {import('ssh2').Server} */
  let server
  try {
    server = new SshServer({ hostKeys: [hostKey.material] }, (client) => {
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
            console.warn(
              `[sim] rejected tunnel to ${destIP}:${destPort}; only 127.0.0.1:${sim.remotePort} is reachable`,
            )
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
  } catch (error) {
    // Server construction is where ssh2 parses the host key: fail with the
    // fingerprint and versions so a broken key is diagnosable from the log alone.
    console.error(
      `[sim] ssh2 refused the host key (${hostKey.fingerprint}): ${error instanceof Error ? error.message : String(error)}`,
    )
    console.error(`[sim] node ${process.version}, ssh2 ${ssh2Version()}, keyType ${hostKey.keyType}`)
    remote.server.closeAllConnections?.()
    await withTimeout(new Promise((resolve) => remote.server.close(() => resolve(undefined))), 5_000, 'shutdown').catch(
      () => {},
    )
    process.exit(2)
  }
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
  console.log(
    `[sim] session history: ${HISTORY.rootAvailable ? 'sessions/ served' : 'no sessions/ directory (typed failure path)'}` +
      `${HISTORY.gap ? ' — with a deliberate seq gap' : ''}` +
      ` — ${Object.keys(HISTORY.sessions).length} fixture session(s)`,
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

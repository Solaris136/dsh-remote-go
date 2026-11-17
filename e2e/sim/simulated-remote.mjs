// A local stand-in for an SSH-reachable remote host: ssh2's *server* API exposes a real SSH
// endpoint on 127.0.0.1 plus a local HTTP server playing the remote DSH web, so the real
// client code runs with no container, VM or external machine.
//
//   node e2e/sim/simulated-remote.mjs --self-test   # start, verify, exit
//   node e2e/sim/simulated-remote.mjs --serve       # stay up for manual use
//
// Options (environment fallbacks in parentheses):
//   --ssh-user/--ssh-password (SIM_SSH_USER/SIM_SSH_PASSWORD)  the one credential pair accepted
//   --workspace-fixture <file> (SIM_WORKSPACE_FIXTURE)          body served for `storages/workspace.json`
//   --history-fixture <file> (SIM_HISTORY_FIXTURE)              session logs for `sessions/**/session-*.json[l]`
//   --history-gap                                               drop a middle record so the plugin must detect a seq hole
//   --history-no-root                                           model a remote with no `sessions/` dir
//   --lease-fixture <file> (SIM_LEASE_FIXTURE)                  seed `remote-go/lease.json`; the sim then
//                                                             VALIDATES publishes, which makes the channel enforced
//   --state-file <file> (SIM_STATE_FILE)                        where ports/pid are published
//
// A restart of the remote DSH itself is modelled too, because the plugin has to survive one:
//   ssh ... "sim-internal restart-web"     in-place restart: same pid, new random port, stale
//                                          run/web.json until the plugin rewrites it
// Every later `[start]` (a plugin restart) also picks a new random port, exactly like `--port 0`.
//
// Not a permissive fake: commands are matched by leading tokens, anything else exits 127.
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
import { buildProbeScript, parseProbeOutput, toProbeFacts } from '../../src/probe.js'
import { createHostKey } from './host-key.mjs'

const { Server: SshServer, Client: SshClient } = ssh2

/** The installed `ssh2` version, for a host-key failure report. */
function ssh2Version() {
  try {
    return JSON.parse(readFileSync(new URL('../../node_modules/ssh2/package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_STATE_FILE = path.join(HERE, '.state.json')

function parseArgs(argv) {
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
 * The state file: the repository default, or the path the caller chose so two simulators
 * (e.g. test files running in parallel) never race on one file.
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
 * The single credential pair the simulator accepts. Anything else is rejected: the
 * listener is a simulator, not a credential-free proxy.
 */
const SIM = {
  username: String(args['ssh-user'] ?? process.env.SIM_SSH_USER ?? 'sim'),
  password: String(args['ssh-password'] ?? process.env.SIM_SSH_PASSWORD ?? 'sim'),
  home: '/home/sim',
  shell: '/bin/bash',
  nodeVersion: 'v24.21.0',
  nodePath: '/home/sim/.nvm/versions/node/v24.21.0/bin/node',
  dshVersion: '0.2.2-rc.1',
  dshHome: '/home/sim/.dsh',
  curlPath: '/usr/bin/curl',
  /** The plugin-managed Node the simulator pretends is already installed. */
  managedNodeVersion: '24.9.0',
  managedNodeDir: '/home/sim/.dsh/remote-go/node/v24.9.0',
  diskFreeKb: '35000000',
  /** Launch token printed in the simulated `dsh web:` readiness line. */
  token: 'sim-token-0123456789abcdef',
}

function fatal(what, error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[sim] ${what} failed: ${message}`)
  removeOwnStateFile()
  process.exit(2)
}

// Isolation guards: this is a simulator that must never be mistaken for, or interfere
// with, the developer's real environment.
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

// Command answers

/**
 * Exactly the `key<TAB>value` lines `buildProbeScript()` prints, with values that satisfy
 * the plugin's own parsing and OS gate.
 */
function probeOutput() {
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
    ['npx_path', '/home/sim/.nvm/versions/node/v24.21.0/bin/npx'],
    ['curl_path', SIM.curlPath],
    ['wget_path', '/usr/bin/wget'],
    ['libc', 'glibc'],
    ['glibc_version', '2.39'],
    ['disk_free_kb', SIM.diskFreeKb],
    ['ssh_connection', 'yes'],
    ['credentials_file', 'no'],
    ['deepseek_key_env', 'no'],
    ['provider_env_keys', ''],
  ]
  return lines.map(([key, value]) => `${key}\t${value}\n`).join('')
}

/** Read a fixture named by `--<flag>` or its env var; a broken one exits (2) rather than falling back. */
function readFixture(flag, env) {
  const requested = args[flag] ?? process.env[env] ?? null
  if (requested === null) return null
  if (typeof requested !== 'string' || requested.trim() === '') {
    console.error(`[sim] --${flag} needs a file path`)
    process.exit(2)
  }
  const resolved = path.resolve(requested)
  try {
    return { path: resolved, value: JSON.parse(readFileSync(resolved, 'utf8')) }
  } catch (error) {
    fatal(`${flag.replace(/-fixture$/, '')} fixture ${resolved}`, error)
  }
}

/** Deterministic fallback log, so history reads work without a fixture. */
function defaultHistoryEvents(remoteSessionId) {
  return [
    { seq: 1, role: 'user', text: `hello from ${remoteSessionId}`, at: '2026-11-11T00:00:01Z' },
    { seq: 2, role: 'assistant', text: 'acknowledged', at: '2026-11-11T00:00:02Z' },
  ]
}

function loadHistoryAnswer() {
  const answer = {
    sessions: {},
    default: [],
    gap: args['history-gap'] === true,
    // `--history-no-root` models a remote whose DSH_HOME has no session store yet; the
    // plugin must degrade to a typed reason instead of throwing.
    rootAvailable: args['history-no-root'] !== true,
  }
  const fixture = readFixture('history-fixture', 'SIM_HISTORY_FIXTURE')
  if (fixture === null) return answer
  const parsed = fixture.value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[sim] history fixture ${fixture.path} must be an object`)
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
  const fallback = parsed.default?.events
  if (Array.isArray(fallback)) answer.default = fallback
  if (parsed.gap === true) answer.gap = true
  return answer
}

/** Events served for one session; `--history-gap` removes one middle record. */
function historyEventsFor(answer, remoteSessionId) {
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

/** The `storages/workspace.json` answer: the built-in registry, or the caller's fixture. */
function loadWorkspaceAnswer() {
  const fixture = readFixture('workspace-fixture', 'SIM_WORKSPACE_FIXTURE')
  const registry = fixture === null ? DEFAULT_WORKSPACE_REGISTRY : fixture.value
  const table = registry?.tables?.workspaces
  if (fixture !== null && (!table || typeof table !== 'object' || Array.isArray(table))) {
    console.error(
      `[sim] workspace fixture ${fixture.path} is not a DSH Workspace registry (expected {"tables":{"workspaces":{...}}})`,
    )
    process.exit(2)
  }
  const entries = table && typeof table === 'object' && !Array.isArray(table) ? Object.values(table) : []
  const workspaces = entries.filter((entry) => entry && typeof entry === 'object')
  const sessionCount = workspaces.reduce(
    (total, entry) => total + (Array.isArray(entry.sessionIds) ? entry.sessionIds.length : 0),
    0,
  )
  return {
    json: `${JSON.stringify(registry)}\n`,
    fixturePath: fixture === null ? null : fixture.path,
    workspaceCount: workspaces.length,
    sessionCount,
  }
}

const WORKSPACE = loadWorkspaceAnswer()
const HISTORY = loadHistoryAnswer()

/** Records served by the polled follower (design §6.4). */
function loadStreamAnswer() {
  const file = args['stream-fixture'] ?? process.env.SIM_STREAM_FIXTURE ?? null
  if (!file) return {}
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  return parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
}

const STREAM = loadStreamAnswer()
const STREAM_FENCE = process.argv.includes('--stream-fence')

/** The writer authority published for L3 (design §6.2); `null` means no authority file. */
const LEASE = loadLeaseAnswer()

function sessionKeyOf(file) {
  return /lease(?:-([^'/]*))?\.json$/.exec(String(file ?? ''))?.[1] ?? ''
}

/** The authority record this remote currently recognises, or null when nobody holds it. */
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
 * The remote-side acceptance rule for a published record (design §6.2). This is the half the
 * plugin cannot do for itself: a partitioned writer that ignored its own local check still
 * cannot take the lease, because the authority refuses it here.
 *
 * In order: a record without writer/epoch/sessionKey is `malformed`; a **jump** beyond the
 * window is `implausible-epoch` and never adopted (otherwise publishing a huge number would
 * be a one-line denial of service); an epoch **below** the current one is `stale-epoch` (the
 * stale writer); the same epoch from a different session key is `writer-changed`; an expired
 * current record is free to take over; otherwise the record is accepted.
 */
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
  const normalized = { writer, epoch, expiresAt: Number(record?.expiresAt) || 0, sessionKey }
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
  // and takes the new connection key; only a *different* writer at the same epoch is a real
  // `writer-changed` — otherwise restarting the plugin would fence itself.
  if (epoch === Number(current.epoch) && writer !== current.writer && sessionKey !== (current.sessionKey ?? '')) {
    return { ok: false, reason: 'writer-changed', remoteEpoch: Number(current.epoch) }
  }
  return { ok: true, record: normalized }
}

/** Answer a publish with the machine-readable refusal line the plugin classifies. */
function refused(sim, reason, remoteEpoch) {
  sim.leaseRefusals = (sim.leaseRefusals ?? 0) + 1
  const suffix = remoteEpoch === null ? '' : ` ${remoteEpoch}`
  return { code: 3, stdout: `dsh-lease: ${reason}${suffix}\n`, stderr: '' }
}

function loadLeaseAnswer() {
  const fixture = readFixture('lease-fixture', 'SIM_LEASE_FIXTURE')
  if (fixture === null) return null
  const parsed = fixture.value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[sim] lease fixture ${fixture.path} must be an object`)
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
 * Sessions that have a log on this simulated host: every id the served registry advertises
 * plus anything the history fixture names. An id outside this set answers "no log", which is
 * how the plugin's `no-session-log` path is exercised.
 */
const HISTORY_SESSION_IDS = new Set()
for (const entry of Object.values(JSON.parse(WORKSPACE.json)?.tables?.workspaces ?? {})) {
  for (const id of Array.isArray(entry?.sessionIds) ? entry.sessionIds : []) HISTORY_SESSION_IDS.add(id)
}
for (const id of Object.keys(HISTORY.sessions)) HISTORY_SESSION_IDS.add(id)

function webLine(sim) {
  return `dsh web: http://127.0.0.1:${sim.remotePort}/?token=${sim.token}`
}

/** The registry a real launch writes; the plugin may rewrite it after a re-attach. */
function runRegistryRecord(sim) {
  return {
    pid: sim.pid,
    port: sim.remotePort,
    startedAt: '2026-11-11T00:00:00Z',
    profile: 'web',
    version: SIM.dshVersion,
    dshHome: SIM.dshHome,
    // The simulator emulates a current launch, so adoption is allowed.
    launch: 'browser-carrier-v1',
    // A launch record, not a re-attach: the next connection may grant kill rights.
    origin: 'launch',
  }
}

function runRegistry(sim) {
  // A written registry wins (that is what a re-attach does); a stale one models the market
  // restart that re-execs the process without going through the plugin's launch script.
  const record = sim.registryOverride ?? sim.staleRegistry ?? runRegistryRecord(sim)
  return JSON.stringify(record)
}

/**
 * Replace the simulated remote web with a fresh listener on a random port, the way
 * `--port 0` does on a real relaunch. Returns the new port.
 */
async function replaceRemoteWeb(sim) {
  const previous = sim.remoteServer
  const next = await startRemoteWeb(0)
  if (previous) {
    previous.closeAllConnections?.()
    await closeServer(previous)
  }
  sim.remoteServer = next.server
  sim.remotePort = next.port
  sim.token = `sim-token-${String(sim.generation).padStart(2, '0')}`
  sim.registryOverride = null
  return next.port
}

/** Report the already-listening stub the way a real start script does (pid, line, DONE). */
async function startScriptAnswer(sim) {
  sim.launches = (sim.launches ?? 0) + 1
  if (sim.launches > 1) {
    // A relaunch is a new process generation on the remote: a new random port and a new
    // launch token, exactly like the real `--port 0` start (after a stop or a restart).
    sim.generation = (sim.generation ?? 1) + 1
    await replaceRemoteWeb(sim)
    sim.staleRegistry = null
  }
  if (sim.pid === 0) sim.pid = 40_000 + (sim.remotePort % 1_000)
  sim.started = true
  publishState(sim)
  return `PID:${sim.pid}\nLINE:${webLine(sim)}\nDONE:${sim.pid}:${sim.remotePort}\n`
}

/**
 * Recognise one command by its leading tokens. Async because a simulated relaunch really
 * binds a new listener before it answers.
 */
async function respond(command, sim) {
  const cmd = command.trim()
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' })

  // Test control: model the remote DSH restarting itself (plugin-market update, supervisor).
  // The process stays the same pid, picks a new random port, and the plugin's run registry
  // is left stale until the plugin rewrites it.
  if (cmd === 'sim-internal restart-web') {
    sim.generation = (sim.generation ?? 1) + 1
    sim.staleRegistry = runRegistryRecord(sim)
    sim.registryOverride = null
    const port = await replaceRemoteWeb(sim)
    sim.started = true
    publishState(sim)
    return ok(`RESTARTED:${port}\n`)
  }

  // 4c. The polled follower (src/mirror-stream.js). The install command is accepted and
  // discarded: the simulated remote has no filesystem to install into, and only exit 0 counts.
  if (cmd.startsWith('mkdir -p ') && cmd.includes('follow.mjs')) return ok('')

  const follow = cmd.match(/^node '([^']*follow\.mjs)' '([A-Za-z0-9+/=]+)'$/)
  if (follow) {
    sim.streamPolls = (sim.streamPolls ?? 0) + 1
    if (STREAM_FENCE === true) {
      // The remote refuses on its own side of the boundary, exactly as the real helper does.
      sim.streamRefusals = (sim.streamRefusals ?? 0) + 1
      return ok(JSON.stringify({ ok: false, reason: 'stale-epoch', remoteEpoch: 9 }))
    }
    let payload = null
    try {
      payload = JSON.parse(Buffer.from(follow[2], 'base64').toString('utf8'))
    } catch {
      payload = null
    }
    if (!payload) return ok(JSON.stringify({ ok: false, reason: 'log-malformed' }))
    // The log is the history fixture plus whatever the scenario says landed after connect.
    const records = []
    for (const [sessionId, entry] of Object.entries(HISTORY)) {
      const own = Array.isArray(entry?.events) ? entry.events : []
      for (const event of own) records.push({ sessionId, event })
    }
    for (const [sessionId, extra] of Object.entries(STREAM)) {
      for (const event of Array.isArray(extra) ? extra : []) records.push({ sessionId, event, streamed: true })
    }
    const wanted = records
      .filter((record) => payload.logPath.includes(record.sessionId))
      .sort((left, right) => Number(left.event.seq) - Number(right.event.seq))
    const body = wanted.map((record) => JSON.stringify(record.event)).join('\n')
    const bytes = Buffer.from(body + (body === '' ? '' : '\n'), 'utf8')
    const from = Math.min(Math.max(0, Number(payload.offset) || 0), bytes.length)
    const text = bytes.subarray(from).toString('utf8')
    const cut = text.lastIndexOf('\n')
    const usable = cut < 0 ? '' : text.slice(0, cut + 1)
    const events = usable
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
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

  // 1. The one compound probe (src/probe.js buildProbeScript).
  if (cmd.startsWith('set -u\n') && cmd.includes('ssh_connection\t') && cmd.includes('provider_env_keys\t')) {
    return ok(probeOutput())
  }

  // 1b. Managed Node scan (src/node-runtime.js buildNodeScanScript): the simulator pretends
  //     the pinned build is already installed, so connecting exercises the real reuse path.
  if (cmd.startsWith('set -u\nNODE_DIR=')) {
    return ok(`NODE\t${SIM.managedNodeVersion}\t${SIM.managedNodeDir}\n`)
  }

  // 1c. Managed Node checksum (buildNodeChecksumScript) and install (buildNodeInstallScript):
  //     only reached when the scan did not report the pinned build.
  if (cmd.includes('SHASUMS256.txt')) {
    return ok(`CHECKSUM\thttps://nodejs.org/dist\t${'a'.repeat(64)}\n`)
  }
  if (cmd.startsWith('set -eu\nNODE_DIR=') && cmd.includes('tar -xzf')) {
    const nodeDir = /NODE_DIR='([^']+)'/.exec(cmd)?.[1] ?? ''
    const version = /VERSION='([^']+)'/.exec(cmd)?.[1] ?? ''
    return ok(`STEP\textract\nREADY\t${nodeDir}/v${version}\n`)
  }

  // 2a. npx preflight (src/bootstrap.js buildPreflightCommand).
  if (/npx.*-y @deepseek-ai\/dsh@[0-9][^\s]* --version/.test(cmd)) {
    return ok(`${SIM.dshVersion}\n`)
  }

  // 2b. Browser-carrier probe (src/remote-web/start.js buildBrowserCarrierProbe): the simulated profile
  //     does not disable api-remotes, so the launch stays patch-free (unit tests cover PATCH).
  if (cmd.includes('--dump-config')) {
    return ok('CLEAR\n')
  }

  // 2. Detached remote web start (src/remote-web/start.js buildStartScript): every relaunch binds a
  //    new random port, like the real `--port 0`.
  if (cmd.startsWith('set -eu\n') && cmd.includes('dsh web:') && cmd.includes('DONE:')) {
    return ok(await startScriptAnswer(sim))
  }

  // 2c. Run registry rewrite after a restart / re-attach (src/remote-web/registry.js writeRunRegistry).
  //     The script creates its directories under `umask 077` and renames a temp file into
  //     place, so match it structurally instead of by its first line.
  if (cmd.startsWith('set -eu\n') && cmd.includes('REGISTRY-WRITTEN') && cmd.includes('mv -f "$TMP" "$RUN"')) {
    const payload = /printf '%s\\n' '(\{[^\n]*\})' >/.exec(cmd)
    if (!payload) return { code: 1, stdout: '', stderr: 'simulated-remote: unreadable registry payload' }
    try {
      const record = JSON.parse(payload[1])
      sim.registryOverride = record
      sim.staleRegistry = null
      sim.remotePort = Number(record.port) || sim.remotePort
      sim.pid = Number(record.pid) || sim.pid
    } catch {
      return { code: 1, stdout: '', stderr: 'simulated-remote: registry payload is not JSON' }
    }
    return ok('REGISTRY-WRITTEN\n')
  }

  // 2d. Process identity read before a kill decision (src/remote-proc.js remoteProcessIdentity):
  //     a stable start time per pid, the npx launch line, and the DSH home it was started with.
  //     Note: the simulator uses one pid for both the npx wrapper and the listener. The real
  //     `$!` != listener shape (after a re-attach the kill right no longer covers the listener)
  //     is covered by test/unit/remote-restart.test.js's re-attach tests.
  if (cmd.startsWith('set -u\nPID=') && cmd.includes('/proc/$PID/stat')) {
    const pid = Number(/^PID=(\d+)$/m.exec(cmd)?.[1] ?? 0)
    if (pid !== sim.pid) return ok('MISSING\n')
    return ok(
      `START:${50_000 + sim.pid}\n` +
        `CMD:${SIM.managedNodeDir}/bin/npx -y @deepseek-ai/dsh@${SIM.dshVersion} --profile web --no-open --port 0\n` +
        `DSH_HOME:${SIM.dshHome}\n`,
    )
  }

  // 2e. Listening ports of a pid (src/remote-proc.js remoteListenPorts): report the stub.
  if (cmd.startsWith('set -u\nPID=') && cmd.includes('/net/tcp')) {
    const portHex = sim.remotePort.toString(16).toUpperCase().padStart(4, '0')
    return ok(`INODE:77\nLISTEN:0100007F:${portHex}:77\n`)
  }

  // 2f. The pid behind a listening port (remotePortOwnerPid): this simulator's single pid.
  if (cmd.startsWith('set -u\nPORT_HEX=')) {
    const port = Number(/printf '%04X' (\d+)/.exec(cmd)?.[1] ?? 0)
    return ok(port === sim.remotePort ? `PID:${sim.pid}\n` : '')
  }

  // 3. Remote web stop (src/remote-web/stop.js stopRemoteWeb). The simulated process really goes away:
  //    its listener is closed, its pid stops answering and run/web.json is left empty, which is
  //    what a stopped remote DSH looks like to the next connect. The script also reports
  //    NO-TARGET / GONE / ALIVE, so match it structurally and mirror those branches.
  if (cmd.startsWith('set -u\n') && cmd.includes('kill -TERM') && cmd.includes('echo "STOPPED:$PID"')) {
    const requested = Number(/^PID=(\d+)$/m.exec(cmd)?.[1] ?? 0)
    if (!sim.started || (requested !== 0 && requested !== sim.pid)) {
      return ok(`GONE:${requested || sim.pid}\n`)
    }
    const previous = sim.remoteServer
    const stoppedPid = sim.pid
    sim.stops = (sim.stops ?? 0) + 1
    sim.started = false
    sim.pid = 0
    sim.token = ''
    sim.remoteServer = null
    if (previous) {
      previous.closeAllConnections?.()
      await closeServer(previous)
    }
    publishState(sim)
    return ok(`STOPPED:${stoppedPid}\n`)
  }

  // 4. Workspace registry read (src/workspaces.js readRemoteWorkspaces).
  if (/^cat '[^']*\/storages\/workspace\.json'/.test(cmd)) {
    return ok(WORKSPACE.json)
  }

  // 4b. L2 history replay (src/history.js fetchRemoteHistory): directory probe, discovery and
  //     the bounded read. Counters live on `sim` so a test can prove "exactly one backfill".
  if (/^test -d '[^']*\/sessions' && echo yes \|\| echo no$/.test(cmd)) {
    sim.historyProbes = (sim.historyProbes ?? 0) + 1
    return ok(HISTORY.rootAvailable ? 'yes\n' : 'no\n')
  }
  const discovery =
    /^find '[^']*\/sessions' -maxdepth \d+ -type f -name '\*([^']*)\*' 2>\/dev\/null \| head -n \d+$/.exec(cmd)
  if (discovery) {
    sim.historyDiscovery = (sim.historyDiscovery ?? 0) + 1
    const sessionId = discovery[1]
    if (!HISTORY.rootAvailable || !HISTORY_SESSION_IDS.has(sessionId)) return ok('')
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
    // A backfill attempt for a gapped log still leaves the hole: the plugin must report
    // `gap-unfilled` and keep its cursor, so the same events are served again.
    const events = historyEventsFor(HISTORY, sessionId)
    return ok(`${JSON.stringify({ version: 1, session: { id: sessionId }, events })}\n`)
  }

  // 4b. Writer authority: read + publish (src/lease.js, design §6.2). The simulated remote
  //     plays the authority the plugin does not have: it validates a published record and
  //     REFUSES a stale epoch, a mismatched session key or an implausible jump, which is what
  //     makes the channel enforced rather than advisory.
  const leaseRead = /^head -c (\d+) '([^']*\/remote-go\/lease(?:-[^'\/]*)?\.json)' 2>&1 \|\| true$/.exec(cmd)
  if (leaseRead) {
    sim.leaseReads = (sim.leaseReads ?? 0) + 1
    // `--lease-read-fail` models a writer that cannot see the authority (partition, permission
    // change). It must still be refused on publish — that is the point of the channel.
    if (args['lease-read-fail'] === true) return { code: 1, stdout: 'head: Permission denied\n', stderr: '' }
    const current = currentAuthority(sim, leaseRead[2])
    // No record means the remote has never been claimed: answered the way an absent file is.
    return current === null ? ok('') : ok(`${JSON.stringify(current)}\n`)
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
    const slot = /lease(?:-([^'/]*))?\.json$/.exec(cmd)?.[1] ?? ''
    const verdict = acceptAuthority(record, sim, slot)
    if (verdict.ok !== true) return refused(sim, verdict.reason, verdict.remoteEpoch)
    sim.authorities = sim.authorities ?? {}
    sim.authorities[slot] = verdict.record
    sim.authority = verdict.record
    sim.authorityHistory = sim.authorityHistory ?? []
    sim.authorityHistory.push({ writer: verdict.record.writer, epoch: verdict.record.epoch })
    return ok('')
  }

  // 5. Run registry read (src/remote-web/registry.js readRunRegistry).
  if (/^cat '[^']*\/run\/web\.json'/.test(cmd)) {
    return ok(sim.started ? `${runRegistry(sim)}\n` : '')
  }

  // 6. Remote loopback HTTP status (src/remote-proc.js remoteHttpStatus): curl first, wget as the
  //    fallback, so the script does not necessarily start with `curl `.
  if (cmd.includes("-w '%{http_code}'") || cmd.includes('--server-response')) {
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(cmd)?.[1] ?? 0)
    return ok(port === sim.remotePort ? '200' : '000')
  }

  // 7. Last readiness line from the remote log (src/remote-web/resolve.js readWebLineFromLog).
  if (cmd.startsWith("grep 'dsh web:'")) {
    return ok(sim.started ? `${webLine(sim)}\n` : '')
  }

  // 8. Remote log tail: a `tail -n <lines> <logFile>` read of the log file.
  if (/^tail -n \d+ /.test(cmd)) {
    return ok(sim.started ? `${webLine(sim)}\n` : '')
  }

  // 9. Liveness check (src/remote-web/resolve.js remotePidAlive).
  const pidProbe = /^kill -0 (\d+) 2>\/dev\/null && echo alive/.exec(cmd)
  if (pidProbe) {
    const alive = sim.started && Number(pidProbe[1]) === sim.pid
    return ok(alive ? 'alive\n' : '')
  }

  // 9b. Foreign / managed DSH process scans. The simulator owns exactly one DSH, so the
  //     "other processes" scan is empty; the command line of its own pid names the pins.
  if (cmd.startsWith('set -u\nIGNORE=" ')) return ok('')
  const argsOf = /^ps -p (\d+) -o args=/.exec(cmd)
  if (argsOf) {
    const pinned = `${SIM.managedNodeDir}/bin/node /home/sim/.npm/_npx/x/node_modules/@deepseek-ai/dsh/lib/bin.js`
    return ok(Number(argsOf[1]) === sim.pid ? `${pinned} --profile web --no-open --port 0\n` : '')
  }

  // 10. Single-command convenience answers (not used by the current plugin).
  if (/^uname -a$/.test(cmd)) {
    return ok('Linux simulated-remote 6.1.0 #1 SMP x86_64 GNU/Linux\n')
  }
  const tool = /^command -v ([\w-]+)$/.exec(cmd)
  if (tool) return ok(`/usr/local/bin/${tool[1]}\n`)
  const version = /^(node|npm|npx) --version$/.exec(cmd)
  if (version) {
    const value = version[1] === 'node' ? SIM.nodeVersion : '11.28.9'
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

// Servers

function timeoutAfter(ms, label) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutAfter(ms, label)])
}

/** Close one listener without ever waiting on it forever. */
const closeServer = (server, ms = 5_000) =>
  withTimeout(new Promise((resolve) => server.close(() => resolve(undefined))), ms, 'shutdown').catch(() => {})

/**
 * Delete the state file only when it belongs to this process, so a second sim started from
 * the same shell is never clobbered.
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

/**
 * Publish what the tests need to find this simulated host. Re-published after a restart so
 * a test can watch the remote port change without racing the plugin.
 */
function publishState(sim) {
  const published = {
    simulated: true,
    sshHost: '127.0.0.1',
    sshPort: sim.sshPort,
    remotePort: sim.remotePort,
    fingerprint: sim.fingerprint ?? null,
    pid: process.pid,
    workspaceFixture: WORKSPACE.fixturePath,
    dshVersion: SIM.dshVersion,
    generation: sim.generation ?? 1,
    launch: sim.launches ?? 0,
    // The simulated remote web's own state, so a test can watch it stop and come back.
    started: sim.started === true,
    stops: sim.stops ?? 0,
    token: sim.token ?? '',
  }
  mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, `${JSON.stringify(published, null, 2)}\n`, 'utf8')
}

/** Stand-in for the remote DSH web UI: only what the smoke path touches. */
function startRemoteWeb(portOption = undefined) {
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
    server.listen(Number(portOption ?? args['remote-port'] ?? 0), '127.0.0.1', () =>
      resolve({ server, port: server.address().port }),
    )
  })
}

/** Start the simulated host. */
async function startSimulatedRemote() {
  const remote = await startRemoteWeb()
  const shutRemoteWeb = async () => {
    remote.server.closeAllConnections?.()
    await closeServer(remote.server)
  }
  // The host key is generated in memory and validated before anything listens: a key ssh2
  // cannot parse (e.g. after a CRLF round-trip) must fail here, with the reason, instead of
  // leaving the client to fail at handshake time.
  let hostKey
  try {
    hostKey = createHostKey()
  } catch (error) {
    console.error(`[sim] cannot build the SSH host key: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`[sim] node ${process.version}, ssh2 ${ssh2Version()}`)
    console.error('[sim] the key is generated in memory and never written to disk; report this with the versions above')
    await shutRemoteWeb()
    process.exit(2)
  }

  const sim = {
    remotePort: remote.port,
    remoteServer: remote.server,
    pid: 0,
    started: false,
    token: SIM.token,
    generation: 1,
    launches: 0,
  }
  // ssh2's `Server` emits `connection` with its own ServerConnection wrapper (it has `end()`,
  // and a private `_sock` for the raw socket), so track those and tear them down explicitly;
  // otherwise `close()` can wait forever.
  const connections = new Set()
  const tunnelSockets = new Set()
  let closed = false

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
            void (async () => {
              let result = null
              try {
                result = await respond(info.command, sim)
              } catch (error) {
                stream.stderr.write(`simulated-remote: handler failed: ${error?.message ?? error}\n`)
                stream.exit(1)
                stream.end()
                return
              }
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
            })()
          })
        })
        // The tunnel: a client forwardOut() arrives here as a `tcpip` request. Only the
        // simulated remote web port is reachable, so this endpoint can never be used as a
        // credential-free proxy to other local services.
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
    // Server construction is where ssh2 parses the host key: fail with the fingerprint and
    // versions so a broken key is diagnosable from the log alone.
    console.error(
      `[sim] ssh2 refused the host key (${hostKey.fingerprint}): ${error instanceof Error ? error.message : String(error)}`,
    )
    console.error(`[sim] node ${process.version}, ssh2 ${ssh2Version()}, keyType ${hostKey.keyType}`)
    await shutRemoteWeb()
    process.exit(2)
  }
  server.on('connection', (connection) => {
    connections.add(connection)
    connection.once('close', () => connections.delete(connection))
  })
  server.once('error', (error) => fatal('ssh listener', error))
  await new Promise((resolve) => server.listen(Number(args.port ?? 0), '127.0.0.1', resolve))
  const sshPort = server.address().port
  sim.sshPort = sshPort
  sim.fingerprint = hostKey.fingerprint

  /** Close both listeners, destroying live connections so nothing can hang. */
  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of tunnelSockets) socket.destroy()
    tunnelSockets.clear()
    for (const connection of connections) {
      try {
        connection.end()
        // Guarded private access: ssh2 exposes no public socket teardown, and `end()` alone
        // can leave a half-open socket that keeps `close` waiting.
        connection._sock?.destroy?.()
      } catch {
        /* already gone */
      }
    }
    connections.clear()
    sim.remoteServer?.closeAllConnections?.()
    await withTimeout(
      Promise.all([
        new Promise((resolve) => server.close(() => resolve(undefined))),
        new Promise((resolve) => sim.remoteServer?.close(() => resolve(undefined))),
      ]),
      10_000,
      'shutdown',
    )
  }

  return { sshPort, remotePort: remote.port, fingerprint: hostKey.fingerprint, close, sim }
}

// Self-test: drive the simulator with the plugin's own code paths.

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

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

function forwardOver(client, destPort) {
  const call = new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 40_000, '127.0.0.1', destPort, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
  return withTimeout(call, 15_000, 'SSH forwardOut')
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
  const probe = await execOver(client, buildProbeScript())
  expect(probe.code === 0, `probe exited ${probe.code}: ${probe.stderr.trim()}`)
  const facts = toProbeFacts(parseProbeOutput(probe.stdout))
  expect(facts.os === 'Linux', `probe os = ${JSON.stringify(facts.os)}`)
  expect(facts.arch === 'x86_64', `probe arch = ${JSON.stringify(facts.arch)}`)
  expect(facts.sshConnection === true, 'probe did not report an SSH session')
  expect(facts.home === SIM.home, `probe home = ${JSON.stringify(facts.home)}`)
  expect(facts.nodePath === SIM.nodePath, `probe node_path = ${JSON.stringify(facts.nodePath)}`)
  expect(Boolean(facts.npxPath), 'probe npx_path was empty')

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

// Entry point

if (serve || selfTest) {
  const host = await startSimulatedRemote()
  publishState(host.sim)
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

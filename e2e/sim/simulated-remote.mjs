// A local stand-in for an SSH-reachable remote host: ssh2's *server* API serves a real SSH endpoint on 127.0.0.1 plus
// a local HTTP server playing the remote DSH web, so the real client runs with no container, VM or machine.
//
//   node e2e/sim/simulated-remote.mjs --self-test    # start, verify, exit
//   node e2e/sim/simulated-remote.mjs --serve        # stay up for manual use
//
// Options (environment fallback in parentheses): --ssh-user/--ssh-password (SIM_SSH_USER/SIM_SSH_PASSWORD) the one
// accepted pair; --workspace-fixture (SIM_WORKSPACE_FIXTURE) `storages/workspace.json`; --history-fixture
// (SIM_HISTORY_FIXTURE) `sessions/**/session-*.json[l]`, with --history-gap / --history-no-root; --lease-fixture
// (SIM_LEASE_FIXTURE) `remote-go/lease.json`, after which the sim VALIDATES publishes; --state-file (SIM_STATE_FILE) the
// published ports/pid.
//
// `ssh ... "sim-internal restart-web"` restarts the remote DSH in place (same pid, new port, run/web.json left stale),
// because the plugin has to survive one; every later `[start]` also binds a new random port like `--port 0`.
// Commands are matched by leading tokens; anything else exits 127.
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
// The product code is build output now (`pnpm build` -> dist/): the simulator loads the modules the Host loads.
import { buildProbeScript, parseProbeOutput, toProbeFacts } from '../../dist/src/probe.js'
import { createHostKey } from './host-key.mjs'
const { Server: SshServer, Client: SshClient } = ssh2
const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const INDEX_HTML = '<!doctype html><title>simulated remote DSH</title><h1>simulated remote DSH</h1>'
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
    if (!argv[i].startsWith('--')) continue
    const next = argv[i + 1]
    const take = next !== undefined && !next.startsWith('--')
    out[argv[i].slice(2)] = take ? next : true
    if (take) i += 1
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const flag = (name) => args[name] === true
const selfTest = flag('self-test')
const serve = flag('serve') || !selfTest
function resolveStateFile() {
  const requested = args['state-file'] ?? process.env.SIM_STATE_FILE ?? null
  if (requested === null) return DEFAULT_STATE_FILE
  if (typeof requested === 'string' && requested.trim() !== '') return path.resolve(requested)
  console.error('[sim] --state-file needs a file path')
  process.exit(2)
}
const STATE_FILE = resolveStateFile()

/** The one credential pair accepted; anything else is rejected, so the listener is not a credential-free proxy. */
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
  managedNodeVersion: '24.9.0',
  managedNodeDir: '/home/sim/.dsh/remote-go/node/v24.9.0',
  diskFreeKb: '35000000',
  token: 'sim-token-0123456789abcdef',
}
function fatal(what, error) {
  console.error(`[sim] ${what} failed: ${messageOf(error)}`)
  removeOwnStateFile()
  process.exit(2)
}
// Isolation guards: a simulator must never be mistaken for, or interfere with, the developer's real environment.
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

/** Count one kind of request on the sim, so a test can prove "exactly one backfill" or "one refused publish". */
function bump(sim, key) {
  sim[key] = (sim[key] ?? 0) + 1
  return sim[key]
}

// Command answers

/** Exactly the `key<TAB>value` lines `buildProbeScript()` prints, with values that pass the plugin's own OS gate. */
function probeOutput() {
  const bin = '/home/sim/.nvm/versions/node/v24.21.0/bin'
  return (
    'os\tLinux\narch\tx86_64\nos_name\tUbuntu 24.04.1 LTS\n' +
    `user\t${SIM.username}\nhome\t${SIM.home}\nshell\t${SIM.shell}\n` +
    `node_path\t${SIM.nodePath}\nnode_version\t${SIM.nodeVersion}\n` +
    `npm_path\t${bin}/npm\nnpx_path\t${bin}/npx\n` +
    `curl_path\t${SIM.curlPath}\nwget_path\t/usr/bin/wget\n` +
    'libc\tglibc\nglibc_version\t2.39\n' +
    `disk_free_kb\t${SIM.diskFreeKb}\n` +
    'ssh_connection\tyes\ncredentials_file\tno\ndeepseek_key_env\tno\nprovider_env_keys\t\n'
  )
}

/** Read a fixture named by `--<flag>` or its env var (exit 2 when unreadable); `label` also requires an object. */
function readFixture(flag, env, label = null) {
  const requested = args[flag] ?? process.env[env] ?? null
  if (requested === null) return null
  if (typeof requested !== 'string' || requested.trim() === '') {
    console.error(`[sim] --${flag} needs a file path`)
    process.exit(2)
  }
  const resolved = path.resolve(requested)
  let value
  try {
    value = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    fatal(`${flag.replace(/-fixture$/, '')} fixture ${resolved}`, error)
  }
  if (label !== null && (!value || typeof value !== 'object' || Array.isArray(value))) {
    console.error(`[sim] ${label} fixture ${resolved} must be an object`)
    process.exit(2)
  }
  return { path: resolved, value }
}
function loadHistoryAnswer() {
  const fixture = readFixture('history-fixture', 'SIM_HISTORY_FIXTURE', 'history')
  // `--history-no-root` models a remote whose DSH_HOME has no session store: the plugin must degrade, not throw.
  const answer = { sessions: {}, default: [], gap: flag('history-gap'), rootAvailable: !flag('history-no-root') }
  if (fixture === null) return answer
  const sessions = fixture.value.sessions
  const named = sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? Object.entries(sessions) : []
  for (const [sessionId, value] of named) {
    const events = Array.isArray(value) ? value : value?.events
    if (!Array.isArray(events)) {
      console.error(`[sim] history fixture session ${sessionId} needs an events array`)
      process.exit(2)
    }
    answer.sessions[sessionId] = events
  }
  if (Array.isArray(fixture.value.default?.events)) answer.default = fixture.value.default.events
  if (fixture.value.gap === true) answer.gap = true
  return answer
}
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
  const workspaces = Object.values(table ?? {}).filter((entry) => entry && typeof entry === 'object')
  const count = (entry) => (Array.isArray(entry.sessionIds) ? entry.sessionIds.length : 0)
  return {
    json: `${JSON.stringify(registry)}\n`,
    fixturePath: fixture === null ? null : fixture.path,
    workspaceCount: workspaces.length,
    sessionCount: workspaces.reduce((total, entry) => total + count(entry), 0),
  }
}
const WORKSPACE = loadWorkspaceAnswer()
const HISTORY = loadHistoryAnswer()
function loadStreamAnswer() {
  const file = args['stream-fixture'] ?? process.env.SIM_STREAM_FIXTURE ?? null
  if (!file) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
  } catch {
    return {}
  }
}
const STREAM = loadStreamAnswer()
const STREAM_FENCE = process.argv.includes('--stream-fence')

/** The writer authority published for L3; `null` means no authority file. */
const LEASE = loadLeaseAnswer()
function currentAuthority(sim, file = '') {
  const keyed = /lease(?:-([^'/]*))?\.json$/.exec(String(file ?? ''))?.[1] ?? ''
  const map = sim?.authorities ?? null
  const current = map === null || map === undefined ? (sim?.authority ?? null) : (map[keyed] ?? null)
  if (current === null) return LEASE === null ? null : { ...LEASE }
  if (Number(current.expiresAt) > Date.now()) return current
  return { writer: current.writer, epoch: current.epoch, expiresAt: current.expiresAt, sessionKey: current.sessionKey }
}

/** The remote-side acceptance rule the plugin cannot give itself: a partitioned writer that ignored its local check
 * still cannot take the lease. Refusals, in order: `malformed`, `implausible-epoch` (a huge jump must not be a
 * one-line denial of service), `stale-epoch`, `writer-changed` (the same writer may renew, or a restart would fence
 * itself). An expired record is free to take over; otherwise the record is accepted. */
function acceptAuthority(record, sim, fileOrKey = '') {
  const writer = typeof record?.writer === 'string' ? record.writer.trim() : ''
  const epoch = Number(record?.epoch)
  const sessionKey = typeof record?.sessionKey === 'string' ? record.sessionKey.trim() : ''
  if (writer === '' || !Number.isInteger(epoch) || epoch < 1 || sessionKey === '') {
    return { ok: false, reason: 'malformed', remoteEpoch: null }
  }
  const map = sim.authorities ?? null
  const current =
    map === null || map === undefined
      ? (sim.authority ?? (LEASE === null ? null : { ...LEASE, sessionKey: LEASE.sessionKey ?? '' }))
      : (map[String(fileOrKey ?? '')] ?? null)
  const normalized = { writer, epoch, expiresAt: Number(record?.expiresAt) || 0, sessionKey }
  if (current === null || Number(current.expiresAt) <= Date.now()) return { ok: true, record: normalized }
  const window = Number(sim.epochJumpLimit) > 0 ? Number(sim.epochJumpLimit) : 1000
  if (epoch > Number(current.epoch) + window) {
    bump(sim, 'suspiciousJumps')
    return { ok: false, reason: 'implausible-epoch', remoteEpoch: Number(current.epoch) }
  }
  if (epoch < Number(current.epoch)) return { ok: false, reason: 'stale-epoch', remoteEpoch: Number(current.epoch) }
  if (epoch === Number(current.epoch) && writer !== current.writer && sessionKey !== (current.sessionKey ?? '')) {
    return { ok: false, reason: 'writer-changed', remoteEpoch: Number(current.epoch) }
  }
  return { ok: true, record: normalized }
}
function refused(sim, reason, remoteEpoch) {
  bump(sim, 'leaseRefusals')
  const suffix = remoteEpoch === null ? '' : ` ${remoteEpoch}`
  return { code: 3, stdout: `dsh-lease: ${reason}${suffix}\n`, stderr: '' }
}
function loadLeaseAnswer() {
  const fixture = readFixture('lease-fixture', 'SIM_LEASE_FIXTURE', 'lease')
  if (fixture === null) return null
  const parsed = fixture.value
  return {
    writer: typeof parsed.writer === 'string' ? parsed.writer : null,
    epoch: Number.isInteger(parsed.epoch) ? parsed.epoch : null,
    expiresAt: Number.isFinite(Number(parsed.expiresAt)) ? Number(parsed.expiresAt) : Date.now() + 60_000,
    sessionKey: typeof parsed.sessionKey === 'string' ? parsed.sessionKey : '',
  }
}
// Sessions with a log here: the served registry's ids plus the history fixture's; any other id answers "no log".
const HISTORY_SESSION_IDS = new Set()
for (const entry of Object.values(JSON.parse(WORKSPACE.json)?.tables?.workspaces ?? {})) {
  for (const id of Array.isArray(entry?.sessionIds) ? entry.sessionIds : []) HISTORY_SESSION_IDS.add(id)
}
for (const id of Object.keys(HISTORY.sessions)) HISTORY_SESSION_IDS.add(id)
const webLine = (sim) => `dsh web: http://127.0.0.1:${sim.remotePort}/?token=${sim.token}`
function runRegistryRecord(sim) {
  return {
    pid: sim.pid,
    port: sim.remotePort,
    startedAt: '2026-11-11T00:00:00Z',
    profile: 'web',
    version: SIM.dshVersion,
    dshHome: SIM.dshHome,
    // A current launch, so adoption is allowed; `origin: launch` (not a re-attach) grants the next connect kill rights.
    launch: 'browser-carrier-v1',
    origin: 'launch',
  }
}
// A written registry wins (a re-attach); a stale one models the market restart that re-execs without the launch script.
const runRegistry = (sim) => JSON.stringify(sim.registryOverride ?? sim.staleRegistry ?? runRegistryRecord(sim))
async function replaceRemoteWeb(sim) {
  const previous = sim.remoteServer
  const next = await startRemoteWeb(0)
  await retireWeb(previous)
  sim.remoteServer = next.server
  sim.remotePort = next.port
  sim.token = `sim-token-${String(sim.generation).padStart(2, '0')}`
  sim.registryOverride = null
  return next.port
}

async function respond(command, sim) {
  const cmd = command.trim()
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' })
  // Test control: the remote DSH restarting itself (market update, supervisor), with the run registry left stale.
  if (cmd === 'sim-internal restart-web') {
    sim.generation = (sim.generation ?? 1) + 1
    sim.staleRegistry = runRegistryRecord(sim)
    sim.registryOverride = null
    const port = await replaceRemoteWeb(sim)
    sim.started = true
    publishState(sim)
    return ok(`RESTARTED:${port}\n`)
  }
  // The follower: the install command is discarded (no filesystem, only exit 0 counts); the refusal is the remote's own.
  if (cmd.startsWith('mkdir -p ') && cmd.includes('follow.mjs')) return ok('')
  const follow = cmd.match(/^node '([^']*follow\.mjs)' '([A-Za-z0-9+/=]+)'$/)
  if (follow) {
    bump(sim, 'streamPolls')
    if (STREAM_FENCE === true) {
      bump(sim, 'streamRefusals')
      return ok(JSON.stringify({ ok: false, reason: 'stale-epoch', remoteEpoch: 9 }))
    }
    let payload = null
    try {
      payload = JSON.parse(Buffer.from(follow[2], 'base64').toString('utf8'))
    } catch {
      payload = null
    }
    if (!payload) return ok(JSON.stringify({ ok: false, reason: 'log-malformed' }))
    const records = []
    for (const [sessionId, entry] of Object.entries(HISTORY)) {
      for (const event of Array.isArray(entry?.events) ? entry.events : []) records.push({ sessionId, event })
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
  // Bootstrap, in connect order: probe (probe.js), managed-Node scan/checksum/install (node-runtime.js), npx preflight,
  // carrier probe (the simulated profile keeps api-remotes enabled, so the launch stays patch-free).
  if (cmd.startsWith('set -u\n') && cmd.includes('ssh_connection\t') && cmd.includes('provider_env_keys\t')) {
    return ok(probeOutput())
  }
  if (cmd.startsWith('set -u\nNODE_DIR=')) return ok(`NODE\t${SIM.managedNodeVersion}\t${SIM.managedNodeDir}\n`)
  if (cmd.includes('SHASUMS256.txt')) return ok(`CHECKSUM\thttps://nodejs.org/dist\t${'a'.repeat(64)}\n`)
  if (cmd.startsWith('set -eu\nNODE_DIR=') && cmd.includes('tar -xzf')) {
    const nodeDir = /NODE_DIR='([^']+)'/.exec(cmd)?.[1] ?? ''
    const version = /VERSION='([^']+)'/.exec(cmd)?.[1] ?? ''
    return ok(`STEP\textract\nREADY\t${nodeDir}/v${version}\n`)
  }
  if (/npx.*-y @deepseek-ai\/dsh@[0-9][^\s]* --version/.test(cmd)) return ok(`${SIM.dshVersion}\n`)
  if (cmd.includes('--dump-config')) return ok('CLEAR\n')
  // Detached start (remote-web/start.js): each relaunch binds a new port and token like `--port 0`; the first launch
  // sets the pid. The registry rewrite (registry.js) renames a temp file under `umask 077`.
  if (cmd.startsWith('set -eu\n') && cmd.includes('dsh web:') && cmd.includes('DONE:')) {
    if (bump(sim, 'launches') > 1) {
      sim.generation = (sim.generation ?? 1) + 1
      await replaceRemoteWeb(sim)
      sim.staleRegistry = null
    }
    if (sim.pid === 0) sim.pid = 40_000 + (sim.remotePort % 1_000)
    sim.started = true
    publishState(sim)
    return ok(`PID:${sim.pid}\nLINE:${webLine(sim)}\nDONE:${sim.pid}:${sim.remotePort}\n`)
  }
  if (cmd.startsWith('set -eu\n') && cmd.includes('REGISTRY-WRITTEN') && cmd.includes('mv -f "$TMP" "$RUN"')) {
    const payload = /printf '%s\\n' '(\{[^\n]*\})' >/.exec(cmd)
    if (!payload) return { code: 1, stdout: '', stderr: 'simulated-remote: unreadable registry payload' }
    let record
    try {
      record = JSON.parse(payload[1])
    } catch {
      return { code: 1, stdout: '', stderr: 'simulated-remote: registry payload is not JSON' }
    }
    sim.registryOverride = record
    sim.staleRegistry = null
    sim.remotePort = Number(record.port) || sim.remotePort
    sim.pid = Number(record.pid) || sim.pid
    return ok('REGISTRY-WRITTEN\n')
  }
  // Process identity (remoteProcessIdentity) and the port reads (remoteListenPorts / remotePortOwnerPid); one pid stands
  // for the npx wrapper and the listener here, the real `$!` != listener shape being covered by the unit tests.
  if (cmd.startsWith('set -u\nPID=') && cmd.includes('/proc/$PID/stat')) {
    const pid = Number(/^PID=(\d+)$/m.exec(cmd)?.[1] ?? 0)
    if (pid !== sim.pid) return ok('MISSING\n')
    return ok(
      `START:${50_000 + sim.pid}\n` +
        `CMD:${SIM.managedNodeDir}/bin/npx -y @deepseek-ai/dsh@${SIM.dshVersion} --profile web --no-open --port 0\n` +
        `DSH_HOME:${SIM.dshHome}\n`,
    )
  }
  if (cmd.startsWith('set -u\nPID=') && cmd.includes('/net/tcp')) {
    const portHex = sim.remotePort.toString(16).toUpperCase().padStart(4, '0')
    return ok(`INODE:77\nLISTEN:0100007F:${portHex}:77\n`)
  }
  if (cmd.startsWith('set -u\nPORT_HEX=')) {
    const port = Number(/printf '%04X' (\d+)/.exec(cmd)?.[1] ?? 0)
    return ok(port === sim.remotePort ? `PID:${sim.pid}\n` : '')
  }
  // Stop (remote-web/stop.js): the process really goes away — listener closed, pid gone, run/web.json empty.
  if (cmd.startsWith('set -u\n') && cmd.includes('kill -TERM') && cmd.includes('echo "STOPPED:$PID"')) {
    const requested = Number(/^PID=(\d+)$/m.exec(cmd)?.[1] ?? 0)
    if (!sim.started || (requested !== 0 && requested !== sim.pid)) return ok(`GONE:${requested || sim.pid}\n`)
    const previous = sim.remoteServer
    const stoppedPid = sim.pid
    bump(sim, 'stops')
    sim.started = false
    sim.pid = 0
    sim.token = ''
    sim.remoteServer = null
    await retireWeb(previous)
    publishState(sim)
    return ok(`STOPPED:${stoppedPid}\n`)
  }
  // Registry reads, the L2 history replay (probe, discovery, bounded read) and the writer authority — which refuses a
  // stale epoch, a mismatched key or an implausible jump, making the channel enforced rather than advisory.
  if (/^cat '[^']*\/storages\/workspace\.json'/.test(cmd)) return ok(WORKSPACE.json)
  if (/^test -d '[^']*\/sessions' && echo yes \|\| echo no$/.test(cmd)) {
    bump(sim, 'historyProbes')
    return ok(HISTORY.rootAvailable ? 'yes\n' : 'no\n')
  }
  const discovery =
    /^find '[^']*\/sessions' -maxdepth \d+ -type f -name '\*([^']*)\*' 2>\/dev\/null \| head -n \d+$/.exec(cmd)
  if (discovery) {
    bump(sim, 'historyDiscovery')
    const sessionId = discovery[1]
    if (!HISTORY.rootAvailable || !HISTORY_SESSION_IDS.has(sessionId)) return ok('')
    return ok(
      `/home/sim/.dsh/sessions/ws-sim/session-${sessionId}.jsonl\n/home/sim/.dsh/sessions/ws-sim/session-${sessionId}.json\n`,
    )
  }
  const historyRead = /^head -c (\d+) '([^']*\/sessions\/[^']*)' 2>&1 \|\| true$/.exec(cmd)
  if (historyRead) {
    const sessionId = /session-([^./]+)\./.exec(historyRead[2])?.[1] ?? ''
    sim.historyReads = sim.historyReads ?? {}
    sim.historyReads[sessionId] = (sim.historyReads[sessionId] ?? 0) + 1
    // Events: the fixture, its default, or a deterministic fallback; `--history-gap` drops the second-to-last record.
    const fallback = [
      { seq: 1, role: 'user', text: `hello from ${sessionId}`, at: '2026-11-11T00:00:01Z' },
      { seq: 2, role: 'assistant', text: 'acknowledged', at: '2026-11-11T00:00:02Z' },
    ]
    let events = HISTORY.sessions[sessionId] ?? (HISTORY.default.length > 0 ? HISTORY.default : fallback)
    if (HISTORY.gap && events.length >= 3) events = events.filter((_event, index) => index !== events.length - 2)
    return ok(`${JSON.stringify({ version: 1, session: { id: sessionId }, events })}\n`)
  }
  const leaseRead = /^head -c (\d+) '([^']*\/remote-go\/lease(?:-[^'\/]*)?\.json)' 2>&1 \|\| true$/.exec(cmd)
  if (leaseRead) {
    bump(sim, 'leaseReads')
    // `--lease-read-fail` models a writer that cannot see the authority (partition): it must still be refused on publish.
    if (flag('lease-read-fail')) return { code: 1, stdout: 'head: Permission denied\n', stderr: '' }
    const current = currentAuthority(sim, leaseRead[2])
    return current === null ? ok('') : ok(`${JSON.stringify(current)}\n`)
  }
  const leaseWrite = /^mkdir -p .+; printf '%s' '([A-Za-z0-9+/=]+)' \| \(base64 -d/.exec(cmd)
  if (leaseWrite) {
    bump(sim, 'leaseWrites')
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
  // Run registry read (registry.js), then the loopback HTTP status (curl first, wget fallback, so not starting with `curl `).
  if (/^cat '[^']*\/run\/web\.json'/.test(cmd)) return ok(sim.started ? `${runRegistry(sim)}\n` : '')
  if (cmd.includes("-w '%{http_code}'") || cmd.includes('--server-response')) {
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(cmd)?.[1] ?? 0)
    return ok(port === sim.remotePort ? '200' : '000')
  }
  // The last readiness line: `grep 'dsh web:' <log>` and `tail -n <lines> <log>` both answer with it.
  if (cmd.startsWith("grep 'dsh web:'") || /^tail -n \d+ /.test(cmd)) {
    return ok(sim.started ? `${webLine(sim)}\n` : '')
  }
  const pidProbe = /^kill -0 (\d+) 2>\/dev\/null && echo alive/.exec(cmd)
  if (pidProbe) return ok(sim.started && Number(pidProbe[1]) === sim.pid ? 'alive\n' : '')
  // Process scans: exactly one DSH, so the "other processes" scan is empty and its own pid's command line names the pins.
  if (cmd.startsWith('set -u\nIGNORE=" ')) return ok('')
  const argsOf = /^ps -p (\d+) -o args=/.exec(cmd)
  if (argsOf) {
    const pinned = `${SIM.managedNodeDir}/bin/node /home/sim/.npm/_npx/x/node_modules/@deepseek-ai/dsh/lib/bin.js`
    return ok(Number(argsOf[1]) === sim.pid ? `${pinned} --profile web --no-open --port 0\n` : '')
  }
  if (/^uname -a$/.test(cmd)) return ok('Linux simulated-remote 6.1.0 #1 SMP x86_64 GNU/Linux\n')
  const tool = /^command -v ([\w-]+)$/.exec(cmd)
  if (tool) return ok(`/usr/local/bin/${tool[1]}\n`)
  const version = /^(node|npm|npx) --version$/.exec(cmd)
  if (version) return ok(`${version[1] === 'node' ? SIM.nodeVersion : '11.28.9'}\n`)
  return null
}
function describeCommand(command) {
  const firstLine = command.trim().split('\n')[0] ?? ''
  const more = command.includes('\n') ? ` (+${command.split('\n').length - 1} more lines)` : ''
  return `${firstLine.slice(0, 120)}${more}`
}

// Servers

function withTimeout(promise, ms, label) {
  const expired = new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, expired])
}
const cap = (ms, label, run) => withTimeout(new Promise((resolve, reject) => run(resolve, reject)), ms, label)
const closeServer = (server, ms = 5_000) =>
  cap(ms, 'shutdown', (resolve) => server.close(() => resolve(undefined))).catch(() => {})

async function retireWeb(server) {
  if (!server) return
  server.closeAllConnections?.()
  await closeServer(server)
}

/** Delete the state file only when it belongs to this process, so a second sim from the same shell is never clobbered. */
function removeOwnStateFile() {
  try {
    const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null
    if (Number(state?.pid) === process.pid) rmSync(STATE_FILE, { force: true })
  } catch {
    /* best effort: the state file is disposable */
  }
}
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
    started: sim.started === true,
    stops: sim.stops ?? 0,
    token: sim.token ?? '',
  }
  mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, `${JSON.stringify(published, null, 2)}\n`, 'utf8')
}
function startRemoteWeb(portOption = undefined) {
  const server = createHttpServer((req, res) => {
    const health = req.url === '/api/health'
    res.writeHead(200, { 'content-type': health ? 'application/json' : 'text/html; charset=utf-8' })
    res.end(health ? JSON.stringify({ ok: true, simulated: true }) : INDEX_HTML)
  })
  // A port clash must not print a stack trace or leave a stale .state.json.
  server.once('error', (error) => fatal('remote-web listener', error))
  return new Promise((resolve) => {
    server.listen(Number(portOption ?? args['remote-port'] ?? 0), '127.0.0.1', () =>
      resolve({ server, port: server.address().port }),
    )
  })
}
async function startSimulatedRemote() {
  const remote = await startRemoteWeb()
  const failStart = async (...lines) => {
    for (const line of lines) console.error(line)
    await retireWeb(remote.server)
    process.exit(2)
  }
  // The host key is generated in memory and validated before anything listens, so a key ssh2 cannot parse fails here.
  let hostKey
  try {
    hostKey = createHostKey()
  } catch (error) {
    await failStart(
      `[sim] cannot build the SSH host key: ${messageOf(error)}`,
      `[sim] node ${process.version}, ssh2 ${ssh2Version()}`,
      '[sim] the key is generated in memory and never written to disk; report this with the versions above',
    )
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
  // ssh2's `Server` emits `connection` with its own wrapper (it has `end()` and a private `_sock`), so track those and
  // tear them down explicitly; otherwise `close()` can wait forever.
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
          accept().on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec()
            const fail = (message, code) => {
              stream.stderr.write(`${message}\n`)
              stream.exit(code)
              stream.end()
            }
            void (async () => {
              let result = null
              try {
                result = await respond(info.command, sim)
              } catch (error) {
                return fail(`simulated-remote: handler failed: ${error?.message ?? error}`, 1)
              }
              if (result === null) {
                return fail(`simulated-remote: command not simulated: ${describeCommand(info.command)}`, 127)
              }
              if (result.stdout) stream.write(result.stdout)
              if (result.stderr) stream.stderr.write(result.stderr)
              stream.exit(result.code)
              stream.end()
            })()
          })
        })
        // The tunnel (forwardOut -> `tcpip`): only the simulated remote web port is reachable, so this can never be a
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
    // Server construction is where ssh2 parses the host key: fail with the fingerprint and versions, diagnosable from the log.
    await failStart(
      `[sim] ssh2 refused the host key (${hostKey.fingerprint}): ${messageOf(error)}`,
      `[sim] node ${process.version}, ssh2 ${ssh2Version()}, keyType ${hostKey.keyType}`,
    )
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
  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of tunnelSockets) socket.destroy()
    tunnelSockets.clear()
    for (const connection of connections) {
      try {
        connection.end()
        // Guarded private access: ssh2 has no public socket teardown and `end()` alone can leave `close` waiting.
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
const sshOptions = (port, password, username = SIM.username) => ({
  host: '127.0.0.1',
  port,
  username,
  password,
  readyTimeout: 8_000,
})
const connectClient = (sshPort, credentials = {}) =>
  cap(15_000, 'SSH connect', (resolve, reject) => {
    const client = new SshClient()
    client
      .once('ready', () => resolve(client))
      .once('error', reject)
      .connect(sshOptions(sshPort, credentials.password ?? SIM.password, credentials.username ?? SIM.username))
  })

const execOver = (client, command) =>
  cap(20_000, 'SSH exec', (resolve, reject) => {
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

const forwardOver = (client, destPort) =>
  cap(15_000, 'SSH forwardOut', (resolve, reject) => {
    client.forwardOut('127.0.0.1', 40_000, '127.0.0.1', destPort, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })

const httpOver = (stream, request) =>
  cap(15_000, 'tunneled HTTP request', (resolve, reject) => {
    let response = ''
    stream.on('data', (chunk) => (response += chunk.toString('utf8')))
    stream.on('close', () => resolve(response))
    stream.on('error', reject)
    stream.write(request)
  })

async function assertAuthRejected(sshPort) {
  const client = new SshClient()
  const error = await cap(20_000, 'expected SSH auth rejection', (resolve) => {
    client
      .once('ready', () => resolve(new Error('the simulator accepted a wrong password')))
      .once('error', resolve)
      .connect(sshOptions(sshPort, `${SIM.password}-wrong`))
  })
  client.end()
  expect(error instanceof Error, 'wrong-password login produced no error')
  expect(/authentication|configured authentication/i.test(error.message), `unexpected auth error: ${error.message}`)
  return error.message
}
async function assertTunnelRejected(client, remotePort) {
  const error = await cap(15_000, 'expected tunnel rejection', (resolve) => {
    client.forwardOut('127.0.0.1', 40_000, '127.0.0.1', remotePort + 1, (failure) => resolve(failure ?? null))
  })
  expect(error instanceof Error, 'a forwardOut to a foreign local port was accepted')
  return error.message
}
async function runSelfTest(host) {
  const client = await connectClient(host.sshPort)
  const probe = await execOver(client, buildProbeScript())
  expect(probe.code === 0, `probe exited ${probe.code}: ${probe.stderr.trim()}`)
  const facts = toProbeFacts(parseProbeOutput(probe.stdout))
  expect(facts.os === 'Linux', `probe os = ${JSON.stringify(facts.os)}`)
  expect(facts.arch === 'x86_64', `probe arch = ${JSON.stringify(facts.arch)}`)
  expect(facts.sshConnection === true, 'probe did not report an SSH session')
  expect(facts.home === SIM.home, `probe home = ${JSON.stringify(facts.home)}`)
  expect(facts.nodePath === SIM.nodePath, `probe node_path = ${JSON.stringify(facts.nodePath)}`)
  expect(Boolean(facts.npxPath), 'probe npx_path was empty')
  const stream = await forwardOver(client, host.remotePort)
  const health = await httpOver(stream, 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
  expect(health.includes('"simulated":true'), `unexpected tunnel response: ${JSON.stringify(health.slice(0, 120))}`)
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
  const historyLine = HISTORY.rootAvailable ? 'sessions/ served' : 'no sessions/ directory (typed failure path)'
  console.log(
    [
      '[sim] SIMULATED remote host — not a real machine; touches only its state file and the workspace fixture',
      `[sim] ssh 127.0.0.1:${host.sshPort}  remote-web 127.0.0.1:${host.remotePort}  ${host.fingerprint}`,
      `[sim] workspace registry: ${WORKSPACE.fixturePath ?? 'built-in'} — ${WORKSPACE.workspaceCount} workspace(s), ${WORKSPACE.sessionCount} session(s)`,
      `[sim] session history: ${historyLine}${HISTORY.gap ? ' — with a deliberate seq gap' : ''} — ${Object.keys(HISTORY.sessions).length} fixture session(s)`,
      `[sim] state file: ${STATE_FILE}`,
      `[sim] E2E_SSH_ADDRESS=127.0.0.1:${host.sshPort}   (use it in a dedicated shell only)`,
    ].join('\n'),
  )
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

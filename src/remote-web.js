/**
 * Remote DSH web lifecycle — start (detached, logged), parse the `dsh web:` URL, stop, adopt; the launch token stays in memory.
 */
import { DEFAULT_REMOTE_PROFILE, REMOTE_START_TIMEOUT_MS } from './constants.js'
import { errors } from './errors.js'
import { remoteLayout } from './layout.js'
import { headTail, isLoopbackHost, isPid, messageOf, nowIso, shellQuote } from './util.js'
import { normalizeVersion } from './version.js'
import {
  findForeignDshProcesses,
  isUiUp,
  remoteHttpStatus,
  remoteListenPorts,
  remotePortOwnerPid,
} from './remote-proc.js'

const WEB_LINE_RE = /dsh web:\s*(https?:\/\/[^\s]+)/

/**
 * Version tag written into the run registry. Bumping it invalidates adoption of
 * instances started by an older launch path (they may lack the browser-carrier
 * overlay, which would leave the in-window page stuck at "failed to load plugins").
 */
export const LAUNCH_MARKER = 'browser-carrier-v1'

/** Overlay file the launch passes with `--patch` when the profile disables the carrier. */
export const BROWSER_CARRIER_PATCH_FILE = 'browser-carrier.patch.yml'

/**
 * The window shows the remote DSH *web* UI, so the `api-remotes` Remote-Event
 * carrier must stay mounted. A profile bundle aimed at a native companion can
 * disable that row (e.g. goldenpigeon's patch does), which leaves the browser
 * client with `typert gateway: $events: forwarded Remote event source is
 * unavailable` and a blank "failed to load plugins" page. Re-enable the row with
 * a launch-only overlay instead of editing the user's profile.
 */
const BROWSER_CARRIER_PATCH = `# Written by dsh-remote-go. The remote window is a browser client, so the
# Remote-Event carrier (api-remotes) must stay enabled even when a profile
# bundle disables it for a native-UI companion.
- id: api-remotes
  disabled: false`

export function parseWebLine(text) {
  const match = WEB_LINE_RE.exec(String(text ?? ''))
  if (!match) return null
  const rawUrl = match[1]
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  const token = url.searchParams.get('token') ?? ''
  if (!isPid(port)) return null
  return { url: rawUrl, host, port, token, rawLine: match[0] }
}

export function buildStartCommand(plan, layout, options = {}) {
  const profile = options.profile ?? plan.profile ?? DEFAULT_REMOTE_PROFILE
  const patch = options.patchPath ? `--patch ${shellQuote(options.patchPath)} ` : ''
  const args = `${patch}--profile ${shellQuote(profile)} --no-open --port 0`
  const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
  return `env DSH_HOME=${shellQuote(layout.dshHome)} ${pathPrefix}${shellQuote(plan.start.npxPath ?? 'npx')} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} ${args}`
}

export function buildBrowserCarrierProbe(plan, layout, profile) {
  const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
  const dumpFile = shellQuote(`${layout.root}/profile-dump.yml`)
  const patchFile = shellQuote(`${layout.root}/${BROWSER_CARRIER_PATCH_FILE}`)
  return `set -u
mkdir -p ${shellQuote(layout.root)}
DUMP=${dumpFile}
if ! env DSH_HOME=${shellQuote(layout.dshHome)} ${pathPrefix}${shellQuote(plan.start.npxPath ?? 'npx')} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} --profile ${shellQuote(profile)} --dump-config > "$DUMP" 2>/dev/null; then
  echo "DUMP-FAILED"
  exit 0
fi
if grep -A6 'id: api-remotes' "$DUMP" | grep -q 'disabled: true'; then
  cat > ${patchFile} <<'DSH_REMOTE_GO_PATCH'
${BROWSER_CARRIER_PATCH}
DSH_REMOTE_GO_PATCH
  echo "PATCH"
else
  echo "CLEAR"
fi`
}

export async function ensureBrowserCarrier(ssh, options) {
  try {
    const result = await ssh.exec(buildBrowserCarrierProbe(options.plan, options.layout, options.profile), {
      timeoutMs: 60_000,
      maxBytes: 64_000,
    })
    if (result.code === 0 && result.stdout.includes('PATCH')) {
      options.onLine?.('browser carrier: the profile disables api-remotes; re-enabling it for this launch')
      return {
        status: 'patched',
        patchPath: `${options.layout.root}/${BROWSER_CARRIER_PATCH_FILE}`,
      }
    }
    if (result.code === 0 && result.stdout.includes('CLEAR')) {
      options.onLine?.('browser carrier: api-remotes is enabled by the profile')
      return { status: 'clear', patchPath: null }
    }
    options.onLine?.(`browser carrier: profile probe failed (${headTail(result.stdout + result.stderr, 300)})`)
    return { status: 'unknown', patchPath: null }
  } catch (error) {
    // swallow-ok: probe failure — launching without the overlay keeps the start
    // error (missing profile, npx failure) as the actionable one.
    options.onLine?.(`browser carrier: probe failed (${messageOf(error)})`)
    return { status: 'unknown', patchPath: null }
  }
}

export function buildStartScript(startCommand, layout, options = {}) {
  const waitSeconds = options.waitSeconds ?? Math.ceil(REMOTE_START_TIMEOUT_MS / 1000)
  const version = normalizeVersion(options.version ?? '')
  const profile = options.profile ?? DEFAULT_REMOTE_PROFILE
  const logFile = shellQuote(layout.logFile)
  const runFile = shellQuote(layout.runFile)
  const startedAtPlaceholder = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
  return `set -eu
mkdir -p ${shellQuote(layout.logsDir)} ${shellQuote(layout.runDir)} ${shellQuote(layout.stateHome)}
LOG=${logFile}
: > "$LOG"
cd "$HOME"
setsid nohup bash -lc ${shellQuote(startCommand)} >> "$LOG" 2>&1 < /dev/null &
PID=$!
echo "PID:$PID"
i=0
while [ "$i" -lt ${waitSeconds} ]; do
  if grep -q 'dsh web:' "$LOG" 2>/dev/null; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "EXITED:$PID"
    echo "---LOG---"
    tail -n 60 "$LOG" 2>/dev/null || true
    exit 3
  fi
  i=$((i+1))
  sleep 1
done
LINE=$(grep -m1 'dsh web:' "$LOG" 2>/dev/null || true)
if [ -z "$LINE" ]; then
  echo "TIMEOUT"
  echo "---LOG---"
  tail -n 60 "$LOG" 2>/dev/null || true
  exit 4
fi
echo "LINE:$LINE"
PORT=$(printf '%s' "$LINE" | sed -n 's#.*127\\.0\\.0\\.1:\\([0-9][0-9]*\\)/.*#\\1#p')
if [ -z "$PORT" ]; then PORT=$(printf '%s' "$LINE" | sed -n 's#.*:\\([0-9][0-9]*\\)/.*#\\1#p'); fi
printf '{"pid":%s,"port":%s,"startedAt":"%s","profile":%s,"version":%s,"dshHome":%s,"launch":"${LAUNCH_MARKER}"}\\n' "$PID" "\${PORT:-0}" "${startedAtPlaceholder}" ${shellQuote(JSON.stringify(profile))} ${shellQuote(JSON.stringify(version))} ${shellQuote(JSON.stringify(layout.dshHome))} > ${runFile}
echo "DONE:$PID:$PORT"
`
}

export async function startRemoteWeb(ssh, options) {
  const layout = options.layout ?? remoteLayout(options.home ?? null)
  const profile = options.profile ?? options.plan.profile ?? DEFAULT_REMOTE_PROFILE
  const carrier = await ensureBrowserCarrier(ssh, { plan: options.plan, layout, profile, onLine: options.onLine })
  const startCommand = buildStartCommand(options.plan, layout, { profile, patchPath: carrier.patchPath })
  const script = buildStartScript(startCommand, layout, {
    waitSeconds: Math.ceil((options.timeoutMs ?? REMOTE_START_TIMEOUT_MS) / 1000),
    version: options.plan.start.targetVersion,
    profile,
  })
  const lines = []
  const result = await ssh.exec(script, {
    timeoutMs: (options.timeoutMs ?? REMOTE_START_TIMEOUT_MS) + 30_000,
    maxBytes: 200_000,
    onStdout: (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line !== '') {
          lines.push(line)
          options.onLine?.(line)
        }
      }
    },
  })
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0) {
    throw errors.remoteDshStartFailed(headTail(combined, 1500))
  }
  const parsed = parseWebLine(combined)
  if (!parsed) throw errors.remoteDshStartFailed(headTail(combined, 1500))
  if (!isLoopbackHost(parsed.host)) {
    throw errors.remoteUiUnreachable({
      zh: `远端 DSH 宣布的地址不是回环地址（${parsed.host}），无法安全地经 SSH 隧道访问。`,
      en: `The remote DSH advertised a non-loopback host (${parsed.host}); it cannot be reached safely through the SSH tunnel.`,
    })
  }
  const pidMatch = /DONE:(\d+):(\d+)/.exec(combined)
  const pid = pidMatch ? Number(pidMatch[1]) : 0
  const startedAt = new Date().toISOString()
  return {
    pid,
    port: parsed.port,
    token: parsed.token,
    url: parsed.url,
    logPath: layout.logFile,
    startedAt,
    rawLine: parsed.rawLine,
    profile,
    dshHome: layout.dshHome,
    browserCarrier: carrier.status,
  }
}

export async function stopRemoteWeb(ssh, layout, options = {}) {
  const pid = Number(options.pid ?? 0)
  const script = `set -u
PID=${isPid(pid) ? pid : 0}
if [ "$PID" -eq 0 ] && [ -f ${shellQuote(layout.runFile)} ]; then
  PID=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' ${shellQuote(layout.runFile)} | head -n 1)
fi
if [ -n "\${PID:-}" ] && [ "$PID" -ne 0 ]; then
  kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
  n=0
  while [ "$n" -lt 20 ]; do
    kill -0 "$PID" 2>/dev/null || break
    n=$((n+1))
    sleep 0.5
  done
  kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
fi
rm -f ${shellQuote(layout.runFile)}
echo "STOPPED"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 30_000 })
    return { ok: result.code === 0, output: result.stdout.trim() }
  } catch (error) {
    return { ok: false, output: messageOf(error) }
  }
}

export async function readRunRegistry(ssh, layout) {
  try {
    const result = await ssh.exec(`cat ${shellQuote(layout.runFile)} 2>/dev/null || true`, { timeoutMs: 10_000 })
    if (result.code !== 0 || result.stdout.trim() === '') return null
    const parsed = JSON.parse(result.stdout.trim())
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export async function readWebLineFromLog(ssh, layout) {
  try {
    const result = await ssh.exec(`grep 'dsh web:' ${shellQuote(layout.logFile)} 2>/dev/null | tail -n 1 || true`, {
      timeoutMs: 15_000,
    })
    if (result.code !== 0 || !result.stdout.trim()) return null
    return parseWebLine(result.stdout)
  } catch {
    return null
  }
}

export async function remotePidAlive(ssh, pid) {
  if (!isPid(pid)) return false
  try {
    const result = await ssh.exec(`kill -0 ${pid} 2>/dev/null && echo alive || true`, { timeoutMs: 10_000 })
    return result.stdout.includes('alive')
  } catch {
    return false
  }
}

/**
 * Try to adopt a still-running remote web instance from a previous local
 * process: registry pid alive + last log line parseable + loopback HTTP alive.
 *
 * The registry must name the same DSH home and profile this connection is about
 * to use; a process left over from another home or profile would show a
 * different DSH state than the user asked for.
 */
export async function adoptRemoteWeb(ssh, layout, options = {}) {
  const profile = options.profile ?? DEFAULT_REMOTE_PROFILE
  const registry = await readRunRegistry(ssh, layout)
  // Instances from a launch path that did not apply the browser-carrier overlay
  // cannot be adopted: the page they serve may be stuck at "failed to load
  // plugins", and nothing on the server side reveals that.
  if (registry?.launch !== LAUNCH_MARKER) return null
  if (registry?.dshHome !== layout.dshHome) return null
  if (registry?.profile !== profile) return null
  const pid = Number(registry?.pid ?? 0)
  if (!(await remotePidAlive(ssh, pid))) return null
  const line = await readWebLineFromLog(ssh, layout)
  if (!line) return null
  const status = await remoteHttpStatus(ssh, line.port)
  if (!isUiUp(status)) return null
  const version =
    typeof registry?.version === 'string' && registry.version !== '' ? normalizeVersion(registry.version) : null
  return {
    pid,
    port: line.port,
    token: line.token,
    url: line.url,
    version,
    profile,
    dshHome: layout.dshHome,
    adopted: true,
  }
}

/**
 * The pid/port record the plugin writes to `run/web.json` (the same shape the
 * launch script writes). Kept pure so a re-attach can be tested without SSH.
 * @param {object} input - pid, port, profile, dshHome, version, startedAt.
 * @returns {object} the registry record.
 */
export function buildRunRegistryRecord(input = {}) {
  const pid = Number(input.pid ?? 0)
  const port = Number(input.port ?? 0)
  if (!isPid(pid)) throw errors.invalidInput('pid', { zh: 'pid 不合法。', en: 'The pid is invalid.' })
  if (!isPid(port) || port > 65535)
    throw errors.invalidInput('port', { zh: '端口不合法。', en: 'The port is invalid.' })
  const dshHome = String(input.dshHome ?? '').trim()
  if (dshHome === '') {
    throw errors.invalidInput('dshHome', { zh: '远端 DSH_HOME 未知。', en: 'The remote DSH_HOME is unknown.' })
  }
  return {
    pid,
    port,
    startedAt: typeof input.startedAt === 'string' && input.startedAt !== '' ? input.startedAt : nowIso(),
    profile: typeof input.profile === 'string' && input.profile !== '' ? input.profile : DEFAULT_REMOTE_PROFILE,
    version: normalizeVersion(input.version ?? ''),
    dshHome,
    launch: LAUNCH_MARKER,
  }
}

/**
 * Rewrite `run/web.json` after a re-attach: the remote restarted on a new port
 * (and possibly a new pid) without going through the launch script, so the stale
 * record would mislead the next connect's adopt step.
 * @param {object} ssh - SSH transport.
 * @param {object} layout - remote layout.
 * @param {object} record - validated record from {@link buildRunRegistryRecord}.
 * @returns {Promise<{ ok: boolean, output: string }>} whether the write was acknowledged.
 */
export async function writeRunRegistry(ssh, layout, record) {
  const payload = JSON.stringify(record)
  const script = `set -eu
mkdir -p ${shellQuote(layout.runDir)}
printf '%s\\n' ${shellQuote(payload)} > ${shellQuote(layout.runFile)}
echo "REGISTRY-WRITTEN"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 15_000, maxBytes: 8_000 })
    return { ok: result.code === 0 && result.stdout.includes('REGISTRY-WRITTEN'), output: result.stdout.trim() }
  } catch (error) {
    // A registry write failure is reported to the caller, which logs it and carries on:
    // the live tunnel is what matters, the next connect re-adopts from the log line.
    return { ok: false, output: messageOf(error) }
  }
}

/** Whether a `ps` command line is the DSH process for this profile. */
export function commandMatchesProfile(command, profile) {
  const wanted = String(profile ?? '')
  if (wanted === '') return false
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`--profile[=\\s]+${escaped}(?:\\s|$)`).test(String(command ?? ''))
}

/** The pinned `@deepseek-ai/dsh@<version>` an npx command line names, if any. */
export function versionFromCommand(command) {
  const match = /@deepseek-ai\/dsh@([^\s'"]+)/.exec(String(command ?? ''))
  return match ? normalizeVersion(match[1]) : null
}

async function readProcessArgs(ssh, pid) {
  if (!isPid(pid)) return ''
  try {
    const result = await ssh.exec(
      `ps -p ${pid} -o args= 2>/dev/null || tr '\\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true`,
      { timeoutMs: 10_000 },
    )
    return String(result.stdout ?? '').trim()
  } catch {
    // swallow-ok: the command line is only used for the version check, never for a decision to kill
    return ''
  }
}

/**
 * Re-read the remote's real web state after it restarted: the same pid on a new
 * random port (in-place exec), a new pid from a supervisor, or the market's own
 * restart that never writes the plugin's registry. The run registry is only a
 * starting point; the truth is "a live DSH on this ~/.dsh + profile with a
 * listening loopback port that answers HTTP".
 *
 * @param {object} ssh - SSH transport.
 * @param {object} layout - remote layout (`~/.dsh/remote-go`).
 * @param {{ profile?: string }} [options]
 * @returns {Promise<{ ok: true, pid: number, port: number, token: string, url: string,
 *   version: string | null, profile: string, dshHome: string, source: string } |
 *   { ok: false, reason: string }>}
 */
export async function resolveRemoteWeb(ssh, layout, options = {}) {
  const profile = options.profile ?? DEFAULT_REMOTE_PROFILE
  const registry = await readRunRegistry(ssh, layout)
  const line = await readWebLineFromLog(ssh, layout)
  const registryMatches =
    registry !== null &&
    registry.dshHome === layout.dshHome &&
    registry.profile === profile &&
    registry.launch === LAUNCH_MARKER
  const registryPid = Number(registry?.pid ?? 0)
  const registryVersion =
    typeof registry?.version === 'string' && registry.version !== '' ? normalizeVersion(registry.version) : null
  const alive = registryMatches && isPid(registryPid) && (await remotePidAlive(ssh, registryPid))
  const web = async (pid, port, source) => ({
    ok: true,
    pid,
    port,
    token: line !== null && line.port === port ? line.token : '',
    url: line !== null && line.port === port ? line.url : `http://127.0.0.1:${port}/`,
    // The registry names the version of the instance this plugin launched; a process the
    // remote restarted itself is asked for the npx pins in its own command line.
    version:
      pid === registryPid && registryVersion !== null
        ? registryVersion
        : versionFromCommand(await readProcessArgs(ssh, pid)),
    profile,
    dshHome: layout.dshHome,
    source,
  })

  // 1. The instance this plugin started: the registry still names a live pid, and the
  //    port is whatever the newest readiness line (or the pid's own socket) says.
  if (alive) {
    const candidates = []
    if (line !== null) candidates.push(line.port)
    candidates.push(Number(registry?.port ?? 0))
    candidates.push(...(await remoteListenPorts(ssh, registryPid)))
    for (const port of [...new Set(candidates.filter((value) => isPid(value) && value <= 65535))]) {
      if (isUiUp(await remoteHttpStatus(ssh, port))) return web(registryPid, port, 'registry')
    }
  }

  // 2. A readiness line newer than the registry: the market restart re-execs in place
  //    (same pid, new port) or is re-launched by a supervisor. Recover the pid from the port.
  if (line !== null && isPid(line.port) && isUiUp(await remoteHttpStatus(ssh, line.port))) {
    let pid = alive ? registryPid : 0
    if (!isPid(pid)) pid = await remotePortOwnerPid(ssh, line.port)
    if (!isPid(pid)) return { ok: false, reason: 'pid-unknown' }
    return web(pid, line.port, 'log')
  }

  // 3. No usable readiness line (a supervisor may redirect stdout): find the DSH process
  //    for this profile and read its listening port from /proc.
  const scanned = await findForeignDshProcesses(ssh, {
    ignorePids: alive ? [registryPid] : [],
    timeoutMs: options.timeoutMs ?? 20_000,
  })
  if (scanned.ok === true) {
    for (const process of scanned.processes) {
      if (!commandMatchesProfile(process.command, profile)) continue
      for (const port of await remoteListenPorts(ssh, process.pid)) {
        if (isUiUp(await remoteHttpStatus(ssh, port))) return web(process.pid, port, 'process')
      }
    }
  }
  return { ok: false, reason: alive ? 'no-listener' : 'no-running-web' }
}

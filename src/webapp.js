/**
 * Remote DSH web lifecycle: start (detached, log in the plugin's remote directory),
 * parse the `dsh web:` URL line, stop, and verify reachability through the
 * loopback tunnel. The launch token stays in memory (design §16.8).
 *
 * The remote runtime is always npx pinned to the local DSH version and always
 * uses the remote user's real DSH home (`~/.dsh`); this module no longer knows
 * about isolated installs.
 */
import http from 'node:http'
import { DEFAULT_REMOTE_PROFILE, REMOTE_START_TIMEOUT_MS, TUNNEL_PROBE_TIMEOUT_MS } from './constants.js'
import { errors } from './errors.js'
import { remoteLayout } from './layout.js'
import { headTail, isLoopbackHost, shellQuote } from './util.js'
import { normalizeVersion } from './version.js'

/**
 * @typedef {{
 *   url: string,
 *   host: string,
 *   port: number,
 *   token: string,
 *   rawLine: string,
 * }} ParsedWebLine
 */

const WEB_LINE_RE = /dsh web:\s*(https?:\/\/[^\s]+)/

/**
 * Version tag written into the run registry. Bumping it invalidates adoption of
 * instances started by an older launch path (they may lack the browser-carrier
 * overlay, which would leave the in-window page stuck at "failed to load
 * plugins"). One restart after a plugin upgrade is the cost of correctness.
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

/**
 * Parse the readiness line printed by `dsh web` (design §15.2 P3): the plugin
 * owns the remote process, so it reads the URL from stdout instead of guessing
 * a systemd unit.
 * @param {string} text
 * @returns {ParsedWebLine | null}
 */
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
  if (!Number.isInteger(port) || port <= 0) return null
  return { url: rawUrl, host, port, token, rawLine: match[0] }
}

/**
 * @param {import('./bootstrap.js').RuntimePlan} plan
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {{ profile?: string }} [options]
 */
export function buildStartCommand(plan, layout, options = {}) {
  const profile = options.profile ?? plan.profile ?? DEFAULT_REMOTE_PROFILE
  const patch = options.patchPath ? `--patch ${shellQuote(options.patchPath)} ` : ''
  const args = `${patch}--profile ${shellQuote(profile)} --no-open --port 0`
  const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
  return `env DSH_HOME=${shellQuote(layout.dshHome)} ${pathPrefix}${shellQuote(plan.start.npxPath ?? 'npx')} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} ${args}`
}

/**
 * Compose the profile without booting it and check whether a bundle disabled the
 * browser carrier. When it did, write the launch-only overlay and report PATCH;
 * a profile that composes cleanly reports CLEAR. A failed compose (e.g. the
 * profile does not exist yet) reports DUMP-FAILED and the launch proceeds
 * without an overlay, leaving the real error to the start step.
 * @param {import('./bootstrap.js').RuntimePlan} plan
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {string} profile
 */
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

/**
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ plan: import('./bootstrap.js').RuntimePlan, layout: ReturnType<typeof remoteLayout>, profile: string, onLine?: (line: string) => void }} options
 * @returns {Promise<{ status: 'patched' | 'clear' | 'unknown', patchPath: string | null }>}
 */
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
    options.onLine?.(`browser carrier: probe failed (${error instanceof Error ? error.message : String(error)})`)
    return { status: 'unknown', patchPath: null }
  }
}

/**
 * Detached start script: setsid + nohup, waits for the readiness line, logs to
 * the plugin's remote log directory, and records a pid/port/profile registry file.
 * @param {string} startCommand
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {{ waitSeconds?: number, version?: string, profile?: string }} [options]
 */
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

/**
 * @typedef {{
 *   pid: number,
 *   port: number,
 *   token: string,
 *   url: string,
 *   logPath: string,
 *   startedAt: string,
 *   rawLine: string,
 *   profile: string,
 *   dshHome: string,
 *   browserCarrier: 'patched' | 'clear' | 'unknown',
 * }} RemoteWebInfo
 */

/**
 * Start the remote web app and parse its readiness line.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ plan: import('./bootstrap.js').RuntimePlan, layout?: ReturnType<typeof remoteLayout>, home?: string | null, profile?: string, timeoutMs?: number, onLine?: (line: string) => void }} options
 * @returns {Promise<RemoteWebInfo>}
 */
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
  /** @type {string[]} */
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

/**
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {{ pid?: number }} [options]
 */
export async function stopRemoteWeb(ssh, layout, options = {}) {
  const pid = Number(options.pid ?? 0)
  const script = `set -u
PID=${Number.isInteger(pid) && pid > 0 ? pid : 0}
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
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {ReturnType<typeof remoteLayout>} layout
 */
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

/**
 * Read the last `dsh web:` line from the remote log. Used to adopt an instance
 * started by an earlier local DSH process (design §15.1 tunnel adoption).
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {ReturnType<typeof remoteLayout>} layout
 * @returns {Promise<ParsedWebLine | null>}
 */
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

/**
 * Is a remote pid still alive?
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {number} pid
 */
export async function remotePidAlive(ssh, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
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
 * to use. A process left over from the old isolated home (or another profile) is
 * not adopted: it would show a different DSH state than the user asked for.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {{ profile?: string }} [options]
 * @returns {Promise<{
 *   pid: number, port: number, token: string, url: string, version: string | null,
 *   profile: string, dshHome: string, adopted: true,
 * } | null>}
 */
export async function adoptRemoteWeb(ssh, layout, options = {}) {
  const profile = options.profile ?? DEFAULT_REMOTE_PROFILE
  const registry = await readRunRegistry(ssh, layout)
  // Instances from a launch path that did not apply the browser-carrier overlay
  // cannot be adopted: the page they serve may be stuck at "failed to load
  // plugins", and nothing on the server side reveals that.
  if (registry?.launch !== LAUNCH_MARKER) return null
  // The old isolated-home process wrote a registry without (or with another)
  // dshHome; adopting it would silently ignore the `~/.dsh` switch.
  if (registry?.dshHome !== layout.dshHome) return null
  if (registry?.profile !== profile) return null
  const pid = Number(registry?.pid ?? 0)
  if (!(await remotePidAlive(ssh, pid))) return null
  const line = await readWebLineFromLog(ssh, layout)
  if (!line) return null
  const status = await remoteHttpStatus(ssh, line.port)
  if (!(status === 200 || status === 302 || status === 401)) return null
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
 * The shell probe for DSH processes the plugin did not start.
 *
 * It deliberately scans `ps` instead of `pgrep`: the command string itself lives
 * in the `bash -lc` process, and a naive `pgrep -f` would match its own shell.
 * Only real runtime executables (`node`, `dsh`, `npm`, `npx`) are considered,
 * and a process whose `DSH_HOME` points somewhere other than `~/.dsh` is not a
 * conflict for this connection.
 * @param {number[]} [ignorePids]
 * @returns {string}
 */
export function buildForeignDshCommand(ignorePids = []) {
  const ignore = (Array.isArray(ignorePids) ? ignorePids : [])
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .join(' ')
  return `set -u
IGNORE=" ${ignore} "
PS_OUT=$(ps -eww -o pid=,comm=,args= 2>/dev/null || ps -eo pid=,comm=,args= 2>/dev/null || true)
printf '%s\\n' "$PS_OUT" | while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue
  set -- $LINE
  PID=$1
  COMM=$2
  shift 2
  ARGS="$*"
  [ -z "$PID" ] && continue
  case "$IGNORE" in *" $PID "*) continue ;; esac
  case "$COMM" in node|dsh|npm|npx) ;; *) continue ;; esac
  case "$ARGS" in
    *"@deepseek-ai/dsh"*|*"/bin/dsh "*|*" dsh "*) ;;
    *) continue ;;
  esac
  case "$ARGS" in
    *"ps -eww"*|*"PS_OUT"*|*"IGNORE"*) continue ;;
  esac
  ENV_HOME=$(tr '\\0' '\\n' < "/proc/$PID/environ" 2>/dev/null | sed -n 's/^DSH_HOME=//p' | tail -n 1)
  if [ -n "\${ENV_HOME:-}" ] && [ "$ENV_HOME" != "$HOME/.dsh" ]; then continue; fi
  printf '%s\\t%s\\n' "$PID" "$ARGS"
done`
}

/**
 * @param {string} stdout
 * @returns {{ pid: number, command: string }[]}
 */
export function parseForeignDshOutput(stdout) {
  /** @type {{ pid: number, command: string }[]} */
  const processes = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const tab = rawLine.indexOf('\t')
    if (tab <= 0) continue
    const pid = Number(rawLine.slice(0, tab).trim())
    const command = rawLine.slice(tab + 1).trim()
    if (!Number.isInteger(pid) || pid <= 0 || command === '') continue
    processes.push({ pid, command })
  }
  return processes
}

/**
 * Find DSH processes on the remote that this plugin did not start.
 *
 * Never throws: a failed scan is reported as `{ ok: false }`, and the caller
 * proceeds without a conflict prompt (a broken scan must not block connecting).
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ ignorePids?: number[], timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, processes: { pid: number, command: string }[], reason?: string, technical?: string }>}
 */
export async function findForeignDshProcesses(ssh, options = {}) {
  try {
    const result = await ssh.exec(buildForeignDshCommand(options.ignorePids ?? []), {
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: 200_000,
    })
    if (result.code !== 0) {
      return { ok: false, processes: [], reason: 'exec-failed', technical: String(result.stderr ?? '').slice(0, 500) }
    }
    return { ok: true, processes: parseForeignDshOutput(result.stdout) }
  } catch (error) {
    // swallow-ok: a scan failure is surfaced as ok:false and the caller proceeds without a prompt
    return {
      ok: false,
      processes: [],
      reason: 'exec-failed',
      technical: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Stop the processes the user explicitly approved. Numeric pids only, SIGTERM
 * first, SIGKILL after a bounded wait, then confirm they are gone.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ pid: number }[]} processes
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, alive: number[], output: string }>}
 */
export async function stopForeignDshProcesses(ssh, processes, options = {}) {
  const pids = [
    ...new Set(
      (Array.isArray(processes) ? processes : [])
        .map((process) => Number(process?.pid))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ]
  if (pids.length === 0) return { ok: true, alive: [], output: '' }
  const script = `set -u
PIDS="${pids.join(' ')}"
for PID in $PIDS; do kill -TERM "$PID" 2>/dev/null || true; done
i=0
while [ "$i" -lt 20 ]; do
  ALIVE=0
  for PID in $PIDS; do
    if kill -0 "$PID" 2>/dev/null; then ALIVE=1; fi
  done
  if [ "$ALIVE" -eq 0 ]; then break; fi
  i=$((i+1))
  sleep 0.5
done
for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID" 2>/dev/null || true; fi
done
sleep 0.2
for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then echo "ALIVE:$PID"; fi
done
echo "STOPPED"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: options.timeoutMs ?? 30_000 })
    const output = String(result.stdout ?? '')
    const alive = [...output.matchAll(/ALIVE:(\d+)/g)].map((match) => Number(match[1]))
    return { ok: result.code === 0 && alive.length === 0, alive, output }
  } catch (error) {
    // swallow-ok: a stop failure is returned to the caller with the original message
    return { ok: false, alive: pids, output: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Check the remote UI locally on the remote loopback (server alive check).
 * `curl` is preferred; `wget` is the fallback so a minimal host still works.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {number} port
 */
export async function remoteHttpStatus(ssh, port) {
  if (!Number.isInteger(port) || port <= 0) return null
  const script = `URL="http://127.0.0.1:${port}/"
if command -v curl >/dev/null 2>&1; then
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" 2>/dev/null || true
elif command -v wget >/dev/null 2>&1; then
  wget -S -O /dev/null --max-time 5 "$URL" 2>&1 | sed -n 's/.*HTTP\\/[0-9.]* \\([0-9][0-9][0-9]\\).*/\\1/p' | head -n 1
fi
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 15_000 })
    const code = Number(String(result.stdout ?? '').trim())
    return Number.isInteger(code) && code > 0 ? code : null
  } catch {
    return null
  }
}

/**
 * Poll until the remote web answers (200 on the root means the server is up;
 * 401 without a cookie is also expected and proves the listener is alive).
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {number} port
 * @param {{ attempts?: number, intervalMs?: number }} [options]
 */
export async function waitForRemoteUi(ssh, port, options = {}) {
  const attempts = options.attempts ?? 20
  const intervalMs = options.intervalMs ?? 500
  let last = null
  for (let i = 0; i < attempts; i += 1) {
    last = await remoteHttpStatus(ssh, port)
    if (last === 200 || last === 302 || last === 401) return { ok: true, status: last }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { ok: false, status: last }
}

/**
 * @typedef {{
 *   ok: boolean,
 *   firstStatus: number,
 *   cookieNames: string[],
 *   location: string | null,
 *   status: number,
 *   title: string | null,
 *   frameBlocked: boolean,
 *   xFrameOptions: string | null,
 *   csp: string | null,
 *   bodyLength: number,
 * }} TokenExchangeResult
 */

/**
 * Exchange the launch token for the authority-bound signing cookie through the
 * local tunnel, then fetch the clean root with that cookie. This proves the
 * loopback same-site path the guest will use (design §7.0 / §9.2).
 * @param {number} localPort
 * @param {string} token
 * @param {{ timeoutMs?: number, path?: string }} [options]
 * @returns {Promise<TokenExchangeResult>}
 */
export async function exchangeTokenOverTunnel(localPort, token, options = {}) {
  const timeoutMs = options.timeoutMs ?? TUNNEL_PROBE_TIMEOUT_MS
  const basePath = options.path ?? '/'
  const tokenPath = `/?token=${encodeURIComponent(token)}`
  const first = await httpRequest({
    port: localPort,
    path: basePath === '/' ? tokenPath : `${basePath}?token=${encodeURIComponent(token)}`,
    timeoutMs,
  })
  const setCookies = first.headers['set-cookie'] ?? []
  const cookieNames = setCookies.map((cookie) => String(cookie).split(';')[0].split('=')[0]).filter(Boolean)
  const cookieHeader = setCookies.map((cookie) => String(cookie).split(';')[0]).join('; ')
  const location = first.headers.location ?? null
  const second = await httpRequest({
    port: localPort,
    path: location && location.startsWith('/') ? location : '/',
    timeoutMs,
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(second.body)
  const xFrameOptions = second.headers['x-frame-options'] ?? null
  const csp = second.headers['content-security-policy'] ?? null
  const frameBlocked = Boolean(xFrameOptions) || (typeof csp === 'string' && /frame-ancestors/i.test(csp))
  return {
    ok: second.status === 200 && second.body.length > 0,
    firstStatus: first.status,
    cookieNames,
    location,
    status: second.status,
    title: titleMatch ? titleMatch[1].trim().slice(0, 200) : null,
    frameBlocked,
    xFrameOptions: typeof xFrameOptions === 'string' ? xFrameOptions : null,
    csp: typeof csp === 'string' ? csp : null,
    bodyLength: second.body.length,
  }
}

/**
 * @param {{ port: number, path: string, headers?: Record<string, string>, timeoutMs: number }} options
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: 'GET',
        headers: { 'user-agent': 'dsh-remote-go', ...options.headers },
        timeout: options.timeoutMs,
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('local tunnel probe timed out')))
    request.on('error', reject)
    request.end()
  })
}

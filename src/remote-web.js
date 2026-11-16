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
  remoteProcessIdentity,
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
  // The dump contains the profile's effective configuration: it is created 0600 and removed
  // again before this script returns, on both the success and the failure path (M3).
  return `set -u
umask 077
mkdir -p ${shellQuote(layout.root)}
DUMP=${dumpFile}
if ! env DSH_HOME=${shellQuote(layout.dshHome)} ${pathPrefix}${shellQuote(plan.start.npxPath ?? 'npx')} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} --profile ${shellQuote(profile)} --dump-config > "$DUMP" 2>/dev/null; then
  echo "DUMP-FAILED"
  rm -f "$DUMP"
  exit 0
fi
if grep -A6 'id: api-remotes' "$DUMP" | grep -q 'disabled: true'; then
  cat > ${patchFile} <<'DSH_REMOTE_GO_PATCH'
${BROWSER_CARRIER_PATCH}
DSH_REMOTE_GO_PATCH
  echo "PATCH"
else
  echo "CLEAR"
fi
rm -f "$DUMP"`
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
  // `umask 077` keeps the log (and the launch's state directory) private: the log carries the
  // launch URL with its token, and the default umask used to leave it world-readable (M3).
  // The run registry is written to a temp file and renamed, so a reader never sees a
  // half-written record (M4).
  return `set -eu
umask 077
mkdir -p ${shellQuote(layout.logsDir)} ${shellQuote(layout.runDir)} ${shellQuote(layout.stateHome)}
LOG=${logFile}
: > "$LOG"
chmod 600 "$LOG" 2>/dev/null || true
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
RUN=${runFile}
TMP="$RUN.tmp.$$"
printf '{"pid":%s,"port":%s,"startedAt":"%s","profile":%s,"version":%s,"dshHome":%s,"launch":"${LAUNCH_MARKER}"}\\n' "$PID" "\${PORT:-0}" "${startedAtPlaceholder}" ${shellQuote(JSON.stringify(profile))} ${shellQuote(JSON.stringify(version))} ${shellQuote(JSON.stringify(layout.dshHome))} > "$TMP"
mv -f "$TMP" "$RUN"
echo "DONE:$PID:$PORT"
`
}

/** The pid the launch script announced, from `DONE:` or the earlier `PID:` line. */
export function parseLaunchedPid(text) {
  const combined = String(text ?? '')
  const done = /DONE:(\d+):(\d+)/.exec(combined)
  if (done) return { pid: Number(done[1]), port: Number(done[2]) }
  const started = /(?:^|\n)PID:(\d+)\s*(?:\n|$)/.exec(combined)
  if (started) return { pid: Number(started[1]), port: 0 }
  return { pid: 0, port: 0 }
}

/**
 * Stop a launch that failed *after* it started: the detached process must not be left
 * running on the remote just because its readiness line never parsed (M2).
 * @param {object} ssh - SSH transport.
 * @param {object} layout - remote layout.
 * @param {number} startedPid - the pid the launch script printed.
 * @param {(line: string) => void} [onLine] - progress sink.
 * @returns {Promise<{ ok: boolean, pid: number | null, output?: string }>}
 */
async function stopFailedLaunch(ssh, layout, startedPid, onLine) {
  let target = 0
  if (isPid(startedPid) && (await remotePidAlive(ssh, startedPid))) target = startedPid
  if (!isPid(target)) {
    // The registry the launch script wrote (or an earlier instance's record) may name the
    // real process when the wrapper already exited: prefer that pid over signalling a
    // possibly reused one.
    const registry = await readRunRegistry(ssh, layout)
    const registryPid = Number(registry?.pid ?? 0)
    if (isPid(registryPid) && (await remotePidAlive(ssh, registryPid))) target = registryPid
  }
  if (!isPid(target)) return { ok: false, pid: null }
  const stopped = await stopRemoteWeb(ssh, layout, { pid: target })
  onLine?.(
    `start failed after pid ${target} was launched; ${stopped.ok === true ? 'it was stopped' : 'it could not be stopped'}`,
  )
  return { ok: stopped.ok === true, pid: target, output: stopped.output }
}

export async function startRemoteWeb(ssh, options) {
  const layout = options.layout ?? remoteLayout(options.home)
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
  // The launch script prints its pid before it waits for the readiness line: keep it even
  // when the wait itself fails, so a failure can stop what it started (M2).
  const launched = parseLaunchedPid(combined)
  const failed = async (error) => {
    await stopFailedLaunch(ssh, layout, launched.pid, options.onLine)
    return error
  }
  if (result.code !== 0) {
    throw await failed(errors.remoteDshStartFailed(headTail(combined, 1500)))
  }
  const parsed = parseWebLine(combined)
  if (!parsed) throw await failed(errors.remoteDshStartFailed(headTail(combined, 1500)))
  if (!isLoopbackHost(parsed.host)) {
    throw await failed(
      errors.remoteUiUnreachable({
        zh: `远端 DSH 宣布的地址不是回环地址（${parsed.host}），无法安全地经 SSH 隧道访问。`,
        en: `The remote DSH advertised a non-loopback host (${parsed.host}); it cannot be reached safely through the SSH tunnel.`,
      }),
    )
  }
  const pid = launched.pid
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
 * The pid a readiness line in the log belongs to, as a last resort for a stop whose pid is
 * unknown. The log only names the port; `/proc` proves which process listens on it (M4).
 */
async function pidFromReadinessLine(ssh, layout) {
  const line = await readWebLineFromLog(ssh, layout)
  if (!line || !isPid(line.port)) return 0
  const owner = await remotePortOwnerPid(ssh, line.port)
  return isPid(Number(owner)) ? Number(owner) : 0
}

export async function stopRemoteWeb(ssh, layout, options = {}) {
  let pid = Number(options.pid ?? 0)
  if (!isPid(pid)) {
    // The run registry is the primary record; a partially written one still names a pid, and
    // the readiness line's port owner is the last resort (M4).
    const registry = await readRunRegistry(ssh, layout)
    pid = Number(registry?.pid ?? 0)
  }
  if (!isPid(pid)) pid = await pidFromReadinessLine(ssh, layout)
  // The registry is removed only after the stop is confirmed: a failed stop must leave the
  // record in place, otherwise the next connect adopts nothing and a second instance starts
  // next to the surviving one (M4).
  const script = `set -u
umask 077
RUN=${shellQuote(layout.runFile)}
PID=${isPid(pid) ? pid : 0}
if [ "$PID" -eq 0 ] && [ -f "$RUN" ]; then
  PID=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$RUN" | head -n 1)
fi
PID="\${PID:-0}"
if [ "$PID" -eq 0 ]; then
  echo "NO-TARGET"
  exit 5
fi
if ! kill -0 "$PID" 2>/dev/null; then
  echo "GONE:$PID"
  rm -f "$RUN"
  exit 0
fi
kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
n=0
while [ "$n" -lt 20 ]; do
  kill -0 "$PID" 2>/dev/null || break
  n=$((n+1))
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  n=0
  while [ "$n" -lt 10 ]; do
    kill -0 "$PID" 2>/dev/null || break
    n=$((n+1))
    sleep 0.5
  done
fi
if kill -0 "$PID" 2>/dev/null; then
  echo "ALIVE:$PID"
  exit 6
fi
rm -f "$RUN"
echo "STOPPED:$PID"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 40_000 })
    const output = result.stdout.trim()
    // An explicit pid that is already gone means the same thing as no target at all: there
    // is nothing left to signal (the caller can clear the stale registry).
    if (output.includes('NO-TARGET')) return { ok: false, reason: 'no-target', output }
    if (output.includes('ALIVE:')) return { ok: false, reason: 'alive', output }
    if (result.code !== 0) return { ok: false, reason: 'not-confirmed', output }
    return { ok: true, output }
  } catch (error) {
    // swallow-ok: a throw here is a transport failure, reported as an unconfirmed stop so the
    // caller keeps the run registry instead of adopting nothing on the next connect
    return { ok: false, reason: 'error', output: messageOf(error) }
  }
}

/**
 * Read `run/web.json`. The record is written atomically (temp + rename), but a record from an
 * older launch path or a truncated file still names the process: parse what is there instead
 * of reporting "no record" and losing the only pid (M4).
 * @param {string} text - the raw file content.
 * @returns {object | null} the parsed record, or null when it names no pid.
 */
export function parseRunRegistry(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // swallow-ok: fall through to the field-by-field recovery below
  }
  const field = (name) => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)?.[1] ?? null
  const number = (name) => Number(new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(raw)?.[1] ?? 0)
  const pid = number('pid')
  if (!isPid(pid)) return null
  const port = number('port')
  return {
    pid,
    port: isPid(port) ? port : 0,
    startedAt: field('startedAt'),
    profile: field('profile'),
    version: field('version'),
    dshHome: field('dshHome'),
    launch: field('launch'),
    origin: field('origin'),
  }
}

export async function readRunRegistry(ssh, layout) {
  try {
    const result = await ssh.exec(`cat ${shellQuote(layout.runFile)} 2>/dev/null || true`, { timeoutMs: 10_000 })
    if (result.code !== 0 || result.stdout.trim() === '') return null
    return parseRunRegistry(result.stdout)
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
  if (!line || line.token === '') return null
  // An adopted instance is reached through the loopback tunnel only: a process that
  // advertises another host cannot be served safely and must not be adopted (adopt parity
  // with a fresh launch, which refuses a non-loopback URL).
  if (!isLoopbackHost(line.host)) return null
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
    // Only a record written by the launch script (or a local restart) proves the process was
    // started by this plugin; a re-attached record names a process the remote restarted itself
    // and must not grant kill rights to the next connection.
    origin: registry.origin === 'reattach' ? 'reattach' : 'launch',
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
    // `launch`: this plugin started the process; `reattach`: the plugin only took it over.
    // The next connection reads this so a re-attached process never gains kill rights.
    origin: input.origin === 'reattach' ? 'reattach' : 'launch',
  }
}

/**
 * Drop `run/web.json` without signalling anything: used when the bound process is already
 * gone (a stop) or the record is known stale. Never kills a pid.
 * @param {object} ssh - SSH transport.
 * @param {object} layout - remote layout.
 * @returns {Promise<{ ok: boolean, output: string }>} whether the removal was acknowledged.
 */
export async function clearRunRegistry(ssh, layout) {
  try {
    const result = await ssh.exec(`rm -f ${shellQuote(layout.runFile)}`, { timeoutMs: 10_000 })
    return { ok: result.code === 0, output: String(result.stdout ?? '').trim() }
  } catch (error) {
    // swallow-ok: a failed removal is returned as ok:false and the caller logs it; the next
    // connect still re-checks the registry, and a dead pid is never adopted
    return { ok: false, output: messageOf(error) }
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
  // Temp file + rename: a concurrent reader (`cat run/web.json`) sees the old record or the
  // new one, never a truncated line that makes the adopt step misread the pid (M4).
  const script = `set -eu
umask 077
mkdir -p ${shellQuote(layout.runDir)}
RUN=${shellQuote(layout.runFile)}
TMP="$RUN.tmp.$$"
printf '%s\\n' ${shellQuote(payload)} > "$TMP"
mv -f "$TMP" "$RUN"
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

/**
 * The installed package directory a real node argv names, e.g.
 * `/home/u/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh` or an app install path.
 * The version is read from that directory's `package.json` (the argv itself does not
 * carry one in the npx-cache and app-install shapes).
 */
export function dshPackageDirFromCommand(command) {
  const text = String(command ?? '')
  const marker = '/node_modules/@deepseek-ai/dsh'
  // Linear scan on purpose: a nested-quantifier regex over an argv with many `/` segments can be
  // made to backtrack exponentially, and the command line is remote input.
  let at = text.indexOf(marker)
  while (at !== -1) {
    const rest = text.slice(at + marker.length)
    if (/^(?:\/lib\/bin\.js|[\s'"]|$)/.test(rest)) {
      let start = at
      while (start > 0 && !/[\s'"]/.test(text[start - 1])) start -= 1
      const dir = text.slice(start, at + marker.length)
      if (dir.startsWith('/') && !dir.split('/').includes('..')) return dir
      return null
    }
    at = text.indexOf(marker, at + marker.length)
  }
  return null
}

/** Read the version of the DSH package a process actually loaded, over SFTP (no shell). */
async function packageVersionFromDir(ssh, dir) {
  if (!dir || typeof ssh.readRemoteFile !== 'function') return null
  try {
    const file = await ssh.readRemoteFile(`${dir}/package.json`, { maxBytes: 64 * 1024 })
    const text = Buffer.isBuffer(file?.data) ? file.data.toString('utf8') : String(file?.data ?? '')
    const parsed = JSON.parse(text)
    const version = typeof parsed?.version === 'string' ? normalizeVersion(parsed.version) : ''
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null
  } catch {
    // swallow-ok: an unreadable package.json only means the version stays unknown (never assumed)
    return null
  }
}

/**
 * The real version a remote DSH process runs: the pinned npx spec when there is one,
 * otherwise the `package.json` of the package its argv loaded. Null when it cannot be
 * proven - the caller must not fill in the local version.
 */
export async function remoteDshVersion(ssh, command) {
  const pinned = versionFromCommand(command)
  if (pinned) return pinned
  const dir = dshPackageDirFromCommand(command)
  return dir === null ? null : packageVersionFromDir(ssh, dir)
}

/**
 * Re-read the remote's real web state after it restarted: the same pid on a new
 * random port (in-place exec) or a new pid from a supervisor. The run registry is only
 * a hint; a candidate is accepted only when all of these hold:
 *
 * - the listening port belongs to the pid the plugin thinks it owns;
 * - that pid's `/proc` identity proves the same `DSH_HOME` and the same `--profile`;
 * - the newest `dsh web:` line names that exact port, so a launch token is available.
 *
 * A candidate that answers HTTP but has no token is **not** usable: a real DSH answers
 * `/?token=` with 401, so claiming success would be dishonest. The process-scan fallback
 * therefore never yields a takeover; it only turns the failure reason into `no-token`
 * ("still running, but no way to authenticate") so the user gets the right remedy.
 *
 * @param {object} ssh - SSH transport.
 * @param {object} layout - remote layout (`~/.dsh/remote-go`).
 * @param {{ profile?: string, timeoutMs?: number }} [options]
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
  let listeners = null
  const listenersOf = async (pid) => {
    if (listeners === null) listeners = await remoteListenPorts(ssh, pid)
    return listeners
  }
  let tokenlessPort = 0
  let firstFailure = null

  /**
   * Accept one reachable candidate only when its identity and its token both check out.
   * Returns null for "reachable but no token" and a typed failure for "wrong process".
   */
  const take = async (pid, port, source) => {
    const identity = await remoteProcessIdentity(ssh, pid)
    if (identity.ok !== true) return { ok: false, reason: `identity-${identity.reason}` }
    if (!commandMatchesProfile(identity.command, profile)) return { ok: false, reason: 'profile-mismatch' }
    if (identity.dshHome === '' || identity.dshHome !== layout.dshHome) {
      return { ok: false, reason: 'dsh-home-mismatch' }
    }
    const token = line !== null && line.port === port ? line.token : ''
    if (token === '') {
      tokenlessPort = port
      return null
    }
    const proven = await remoteDshVersion(ssh, identity.command)
    return {
      ok: true,
      pid,
      port,
      token,
      url: line.url,
      // Never backfill the local version: an unproven version stays null.
      version: proven ?? (pid === registryPid ? registryVersion : null),
      profile,
      dshHome: identity.dshHome,
      source,
    }
  }
  const rememberFailure = (candidate) => {
    if (candidate !== null && candidate.ok !== true && firstFailure === null) firstFailure = candidate
  }

  // 1. The instance this plugin started: the registry still names a live pid. Only ports
  //    that pid actually listens on are candidates, and the readiness line must name the
  //    same port for its launch token to be used.
  if (alive) {
    const candidates = [...(await listenersOf(registryPid))]
    if (isPid(Number(registry?.port ?? 0))) candidates.push(Number(registry.port))
    for (const port of [...new Set(candidates.filter((value) => isPid(value) && value <= 65535))]) {
      if (!isUiUp(await remoteHttpStatus(ssh, port))) continue
      // The port must belong to the pid whose identity we are about to trust. Without a
      // readable owner (restricted /proc) the candidate is refused: fail closed.
      const owner = await remotePortOwnerPid(ssh, port)
      if (!isPid(owner) || owner !== registryPid) continue
      const candidate = await take(registryPid, port, 'registry')
      if (candidate?.ok === true) return candidate
      rememberFailure(candidate)
    }
  }

  // 2. A readiness line for a port owned by some other pid (the market restart re-execs
  //    in place, or a supervisor re-launched it). The owner pid must prove itself.
  if (line !== null && isPid(line.port) && isUiUp(await remoteHttpStatus(ssh, line.port))) {
    let pid = 0
    if (alive && (await listenersOf(registryPid)).includes(line.port)) pid = registryPid
    // The owner lookup is authoritative even when the registry pid is alive: the newest line
    // may belong to another profile's process that shares this plugin's log file.
    if (!isPid(pid)) pid = await remotePortOwnerPid(ssh, line.port)
    if (isPid(pid)) {
      const candidate = await take(pid, line.port, 'log')
      if (candidate?.ok === true) return candidate
      rememberFailure(candidate)
    } else {
      firstFailure = { ok: false, reason: 'pid-unknown' }
    }
  }

  // 3. No usable readiness line (a supervisor may redirect stdout). Find the same-profile
  //    DSH process only to explain the failure: without its launch token it cannot be
  //    re-attached, so this path never returns ok.
  const scanned = await findForeignDshProcesses(ssh, { ignorePids: alive ? [registryPid] : [] })
  if (scanned.ok === true) {
    for (const process of scanned.processes) {
      if (!commandMatchesProfile(process.command, profile)) continue
      const ports = await remoteListenPorts(ssh, process.pid)
      for (const port of ports) {
        if (!isUiUp(await remoteHttpStatus(ssh, port))) continue
        const identity = await remoteProcessIdentity(ssh, process.pid)
        if (identity.ok === true && identity.dshHome === layout.dshHome) {
          return { ok: false, reason: 'no-token' }
        }
      }
    }
  }
  if (firstFailure !== null) return firstFailure
  if (tokenlessPort !== 0) return { ok: false, reason: 'no-token' }
  return { ok: false, reason: alive ? 'no-listener' : 'no-running-web' }
}

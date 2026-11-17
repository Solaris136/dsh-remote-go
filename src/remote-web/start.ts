/**
 * Starting the remote DSH web: the launch command, the browser-carrier overlay probe, the
 * detached launch script and the `dsh web:` handshake. A launch that fails after its process
 * started stops that pid, so a failed connect leaves nothing running (M2).
 */
import type { LaunchPlan } from '../bootstrap.js'
import { DEFAULT_REMOTE_PROFILE, REMOTE_START_TIMEOUT_MS } from '../constants.js'
import { errors } from '../errors.js'
import { remoteLayout } from '../layout.js'
import type { RemoteLayout } from '../layout.js'
import type { SshTransport } from '../ssh.js'
import { headTail, isLoopbackHost, isPid, messageOf, shellQuote } from '../util.js'
import { normalizeVersion } from '../version.js'
import { LAUNCH_MARKER } from './registry.js'
import { parseWebLine, remotePidAlive } from './resolve.js'
import { stopRemoteWeb } from './stop.js'

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

/** What the launch script announced about the process it started. */
export interface LaunchedPid {
  pid: number
  port: number
}

/** The browser-carrier probe's outcome: patched, not needed, or unproven. */
export interface BrowserCarrierResult {
  status: 'patched' | 'clear' | 'unknown'
  patchPath: string | null
}

/** One started remote web instance, as the connect pipeline records it. */
export interface StartedRemoteWeb {
  pid: number
  port: number
  token: string
  url: string
  logPath: string
  startedAt: string
  rawLine: string
  profile: string
  dshHome: string
  browserCarrier: BrowserCarrierResult['status']
}

export function buildStartCommand(
  plan: LaunchPlan,
  layout: RemoteLayout,
  options: { profile?: string; patchPath?: string | null } = {},
): string {
  const profile = options.profile ?? plan.profile ?? DEFAULT_REMOTE_PROFILE
  const patch = options.patchPath ? `--patch ${shellQuote(options.patchPath)} ` : ''
  const args = `${patch}--profile ${shellQuote(profile)} --no-open --port 0`
  const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
  return `env DSH_HOME=${shellQuote(layout.dshHome)} ${pathPrefix}${shellQuote(plan.start.npxPath ?? 'npx')} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} ${args}`
}

export function buildBrowserCarrierProbe(plan: LaunchPlan, layout: RemoteLayout, profile: string): string {
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

export async function ensureBrowserCarrier(
  ssh: SshTransport,
  options: { plan: LaunchPlan; layout: RemoteLayout; profile: string; onLine?: (line: string) => void },
): Promise<BrowserCarrierResult> {
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

export function buildStartScript(
  startCommand: string,
  layout: RemoteLayout,
  options: { waitSeconds?: number; version?: string; profile?: string } = {},
): string {
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
export function parseLaunchedPid(text: unknown): LaunchedPid {
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
 *
 * Only the pid this launch script printed is ours to stop. `run/web.json` may name another
 * instance (a re-attached process, or a previous launch), so it is deliberately not used as
 * a fallback here: killing that pid would be exactly the "a re-attached instance is not
 * stopped" rule the connect pipeline enforces (review blocker 2).
 */
async function stopFailedLaunch(
  ssh: SshTransport,
  layout: RemoteLayout,
  startedPid: number,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; pid: number | null; output?: string }> {
  if (!isPid(startedPid)) return { ok: false, pid: null }
  let alive = false
  try {
    alive = await remotePidAlive(ssh, startedPid)
  } catch {
    // swallow-ok: an unreadable liveness check means "cannot prove it is ours", so no signal
    return { ok: false, pid: null }
  }
  if (!alive) return { ok: false, pid: null }
  const stopped = await stopRemoteWeb(ssh, layout, { pid: startedPid })
  onLine?.(
    `start failed after pid ${startedPid} was launched; ${
      stopped.ok === true ? 'it was stopped' : 'it could not be stopped'
    }`,
  )
  return { ok: stopped.ok === true, pid: startedPid, output: stopped.output }
}

export async function startRemoteWeb(
  ssh: SshTransport,
  options: {
    plan: LaunchPlan
    layout?: RemoteLayout
    home?: string
    profile?: string
    timeoutMs?: number
    onLine?: (line: string) => void
  },
): Promise<StartedRemoteWeb> {
  const layout = options.layout ?? remoteLayout(options.home)
  const profile = options.profile ?? options.plan.profile ?? DEFAULT_REMOTE_PROFILE
  const carrier = await ensureBrowserCarrier(ssh, { plan: options.plan, layout, profile, onLine: options.onLine })
  const startCommand = buildStartCommand(options.plan, layout, { profile, patchPath: carrier.patchPath })
  const script = buildStartScript(startCommand, layout, {
    waitSeconds: Math.ceil((options.timeoutMs ?? REMOTE_START_TIMEOUT_MS) / 1000),
    version: options.plan.start.targetVersion,
    profile,
  })
  const lines: string[] = []
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
  const failed = async (error: unknown): Promise<unknown> => {
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

/** Starting the remote DSH web: the launch command, the browser-carrier overlay probe, the detached launch script
 * and the `dsh web:` handshake. A launch that fails after its process started stops that pid. */
import type { LaunchPlan } from '../bootstrap.js'
import { DEFAULT_REMOTE_PROFILE, REMOTE_START_TIMEOUT_MS } from '../constants.js'
import { errors } from '../errors.js'
import { remoteLayout } from '../layout.js'
import type { RemoteLayout } from '../layout.js'
import type { SshPort } from '../ssh-port.js'
import { headTail, isLoopbackHost, isPid, messageOf, shellQuote } from '../util.js'
import { normalizeVersion } from '../version.js'
import { LAUNCH_MARKER } from './registry.js'
import { parseWebLine, remotePidAlive } from './resolve.js'
import { stopRemoteWeb } from './stop.js'

export const BROWSER_CARRIER_PATCH_FILE = 'browser-carrier.patch.yml'

const BROWSER_CARRIER_PATCH = `# Written by dsh-remote-go. The remote window is a browser client, so the
# Remote-Event carrier (api-remotes) must stay enabled even when a profile
# bundle disables it for a native-UI companion.
- id: api-remotes
  disabled: false`

export interface LaunchedPid {
  pid: number
  port: number
}

export interface BrowserCarrierResult {
  status: 'patched' | 'clear' | 'unknown'
  patchPath: string | null
}

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
  ssh: SshPort,
  options: { plan: LaunchPlan; layout: RemoteLayout; profile: string; onLine?: (line: string) => void },
): Promise<BrowserCarrierResult> {
  try {
    const result = await ssh.exec(buildBrowserCarrierProbe(options.plan, options.layout, options.profile), {
      timeoutMs: 60_000,
      maxBytes: 64_000,
    })
    if (result.code === 0 && result.stdout.includes('PATCH')) {
      options.onLine?.('browser carrier: the profile disables api-remotes; re-enabling it for this launch')
      return { status: 'patched', patchPath: `${options.layout.root}/${BROWSER_CARRIER_PATCH_FILE}` }
    }
    if (result.code === 0 && result.stdout.includes('CLEAR')) {
      options.onLine?.('browser carrier: api-remotes is enabled by the profile')
      return { status: 'clear', patchPath: null }
    }
    options.onLine?.(`browser carrier: profile probe failed (${headTail(result.stdout + result.stderr, 300)})`)
    return { status: 'unknown', patchPath: null }
  } catch (error) {
    // swallow-ok: launching without the overlay keeps the start error (missing profile, npx failure)
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
  // `umask 077` keeps the log (which carries the launch URL with its token) private; the run registry is written to
  // a temp file and renamed, so a reader never sees a half-written record.
  const startedAtPlaceholder = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
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

export function parseLaunchedPid(text: unknown): LaunchedPid {
  const combined = String(text ?? '')
  const done = /DONE:(\d+):(\d+)/.exec(combined)
  if (done) return { pid: Number(done[1]), port: Number(done[2]) }
  const started = /(?:^|\n)PID:(\d+)\s*(?:\n|$)/.exec(combined)
  return started ? { pid: Number(started[1]), port: 0 } : { pid: 0, port: 0 }
}

export async function startRemoteWeb(
  ssh: SshPort,
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
        if (line === '') continue
        lines.push(line)
        options.onLine?.(line)
      }
    },
  })
  // The launch script prints its pid before it waits, so a failure can still stop what it started.
  const combined = `${result.stdout}\n${result.stderr}`
  const launched = parseLaunchedPid(combined)
  const failed = async (error: unknown): Promise<unknown> => {
    if (isPid(launched.pid)) {
      let alive = false
      try {
        alive = await remotePidAlive(ssh, launched.pid)
      } catch {
        // swallow-ok: an unreadable liveness check means "cannot prove it is ours", so no signal
      }
      if (alive) {
        const stopped = await stopRemoteWeb(ssh, layout, { pid: launched.pid })
        const outcome = stopped.ok === true ? 'it was stopped' : 'it could not be stopped'
        options.onLine?.(`start failed after pid ${launched.pid} was launched; ${outcome}`)
      }
    }
    return error
  }
  if (result.code !== 0) throw await failed(errors.remoteDshStartFailed(headTail(combined, 1500)))
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
  return {
    pid: launched.pid,
    port: parsed.port,
    token: parsed.token,
    url: parsed.url,
    logPath: layout.logFile,
    startedAt: new Date().toISOString(),
    rawLine: parsed.rawLine,
    profile,
    dshHome: layout.dshHome,
    browserCarrier: carrier.status,
  }
}

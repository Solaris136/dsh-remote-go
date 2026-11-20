/** Remote process and reachability primitives: find, stop and probe DSH processes on the remote, plus the one HTTP round-trip that proves the remote UI answers. */
import http from 'node:http'
import { TUNNEL_PROBE_TIMEOUT_MS } from './constants.js'
import { isPid, messageOf } from './util.js'
import type { SshPort } from './ssh-port.js'

export interface RemoteProcessRef {
  pid: number
  command: string
}

/** The scan outcome: a failed scan is a value, never a throw. */
export type ForeignDshScan =
  | { ok: true; processes: RemoteProcessRef[] }
  | { ok: false; processes: RemoteProcessRef[]; reason: 'exec-failed'; technical: string }

export type ProcessIdentity =
  | { ok: true; startTime: string; command: string; dshHome: string }
  | { ok: false; reason: 'invalid-pid' | 'missing' | 'unreadable' }

/** A listener answering 200, 302 or 401 is up: 401 without the launch cookie still proves it serves. */
export function isUiUp(status: number | null): boolean {
  return status === 200 || status === 302 || status === 401
}

export function buildForeignDshCommand(ignorePids: unknown[] = []): string {
  const ignore = (Array.isArray(ignorePids) ? ignorePids : [])
    .map((pid) => Number(pid))
    .filter((pid) => isPid(pid))
    .join(' ')
  return `set -u
IGNORE=" ${ignore} "
PS_OUT=$(ps -eww -o pid=,comm=,args= 2>/dev/null || ps -eo pid=,comm=,args= 2>/dev/null || true)
printf '%s\\n' "$PS_OUT" | while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue
  set -- $LINE
  PID=$1 COMM=$2
  shift 2; ARGS="$*"
  [ -z "$PID" ] && continue
  case "$IGNORE" in *" $PID "*) continue ;; esac
  case "$COMM" in node|dsh|npm|npx) ;; *) continue ;; esac
  case "$ARGS" in *"@deepseek-ai/dsh"*|*"/bin/dsh "*|*" dsh "*) ;; *) continue ;; esac
  case "$ARGS" in *"ps -eww"*|*"PS_OUT"*|*"IGNORE"*) continue ;; esac
  ENV_HOME=$(tr '\\0' '\\n' < "/proc/$PID/environ" 2>/dev/null | sed -n 's/^DSH_HOME=//p' | tail -n 1)
  if [ -n "\${ENV_HOME:-}" ] && [ "$ENV_HOME" != "$HOME/.dsh" ]; then continue; fi
  printf '%s\\t%s\\n' "$PID" "$ARGS"
done`
}

export function parseForeignDshOutput(stdout: unknown): RemoteProcessRef[] {
  const processes: RemoteProcessRef[] = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const tab = rawLine.indexOf('\t')
    if (tab <= 0) continue
    const pid = Number(rawLine.slice(0, tab).trim())
    const command = rawLine.slice(tab + 1).trim()
    if (!isPid(pid) || command === '') continue
    processes.push({ pid, command })
  }
  return processes
}

/** Find DSH processes on the remote that this plugin did not start; never throws, because a broken scan must not block connecting. */
export async function findForeignDshProcesses(
  ssh: SshPort,
  options: { ignorePids?: unknown[]; timeoutMs?: number } = {},
): Promise<ForeignDshScan> {
  const failed = (technical: string): ForeignDshScan => ({
    ok: false,
    processes: [],
    reason: 'exec-failed',
    technical,
  })
  try {
    const result = await ssh.exec(buildForeignDshCommand(options.ignorePids ?? []), {
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: 200_000,
    })
    if (result.code !== 0) return failed(String(result.stderr ?? '').slice(0, 500))
    return { ok: true, processes: parseForeignDshOutput(result.stdout) }
  } catch (error) {
    // swallow-ok: a scan failure is surfaced as ok:false and the caller proceeds without a prompt
    return failed(messageOf(error))
  }
}

export async function stopForeignDshProcesses(
  ssh: SshPort,
  processes: ReadonlyArray<{ pid?: unknown }> | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; alive: number[]; output: string }> {
  const pids = [
    ...new Set(
      (Array.isArray(processes) ? processes : []).map((process) => Number(process?.pid)).filter((pid) => isPid(pid)),
    ),
  ]
  if (pids.length === 0) return { ok: true, alive: [], output: '' }
  const script = `set -u
PIDS="${pids.join(' ')}"
for PID in $PIDS; do kill -TERM "$PID" 2>/dev/null || true; done
i=0
while [ "$i" -lt 20 ]; do
  ALIVE=0; for PID in $PIDS; do if kill -0 "$PID" 2>/dev/null; then ALIVE=1; fi; done
  if [ "$ALIVE" -eq 0 ]; then break; fi
  i=$((i+1)); sleep 0.5
done
for PID in $PIDS; do if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID" 2>/dev/null || true; fi; done
sleep 0.2
for PID in $PIDS; do if kill -0 "$PID" 2>/dev/null; then echo "ALIVE:$PID"; fi; done
echo "STOPPED"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: options.timeoutMs ?? 30_000 })
    const output = String(result.stdout ?? '')
    const alive = [...output.matchAll(/ALIVE:(\d+)/g)].map((match) => Number(match[1]))
    return { ok: result.code === 0 && alive.length === 0, alive, output }
  } catch (error) {
    // swallow-ok: a stop failure is returned to the caller with the original message
    return { ok: false, alive: pids, output: messageOf(error) }
  }
}

/** TCP ports a pid is listening on, read from its own `/proc` network tables and matched against the socket inodes it holds. */
export async function remoteListenPorts(ssh: SshPort, pid: number): Promise<number[]> {
  if (!isPid(pid)) return []
  const script = `set -u
PID=${pid}
[ -d "/proc/$PID" ] || exit 0
ls -l "/proc/$PID/fd" 2>/dev/null | sed -n 's/.*socket:\\[\\([0-9][0-9]*\\)\\].*/INODE:\\1/p' | sort -u
for NET in "/proc/$PID/net/tcp" "/proc/$PID/net/tcp6"; do [ -r "$NET" ] && awk 'NR > 1 && $4 == "0A" { print "LISTEN:" $2 ":" $10 }' "$NET" 2>/dev/null; done
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 15_000 })
    return parseListenPorts(result.stdout)
  } catch {
    // swallow-ok: an unreadable /proc directory yields no candidate ports
    return []
  }
}

export function parseListenPorts(stdout: unknown): number[] {
  const inodes = new Set<string>()
  const ports: Array<{ port: number; inode: string }> = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const inode = /^INODE:(\d+)$/.exec(line)
    if (inode) {
      inodes.add(inode[1])
      continue
    }
    const listen = /^LISTEN:[0-9A-Fa-f]+:([0-9A-Fa-f]{1,4}):(\d+)$/.exec(line)
    if (!listen) continue
    const port = Number.parseInt(listen[1], 16)
    if (isPid(port) && port <= 65535) ports.push({ port, inode: listen[2] })
  }
  return [...new Set(ports.filter((entry) => inodes.has(entry.inode)).map((entry) => entry.port))].sort(
    (left, right) => left - right,
  )
}

/** The pid behind one listening loopback port, found by matching the port's socket inode against every `/proc/<pid>/fd`; needed when the remote restarted into a pid the run registry does not know yet. */
export async function remotePortOwnerPid(ssh: SshPort, port: number): Promise<number | null> {
  if (!isPid(port) || port > 65535) return null
  const script = `set -u
PORT_HEX=$(printf '%04X' ${port})
INODE=$(awk -v p=":$PORT_HEX" '$2 ~ p"$" && $4 == "0A" { print $10; exit }' /proc/net/tcp 2>/dev/null)
[ -n "\${INODE:-}" ] || exit 0
for D in /proc/[0-9]*; do
  if ls -l "$D/fd" 2>/dev/null | grep -q "socket:\\[\${INODE}\\]"; then echo "PID:\${D#/proc/}"; exit 0; fi
done
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 20_000 })
    const match = /^PID:(\d+)$/m.exec(String(result.stdout ?? ''))
    const pid = match ? Number(match[1]) : 0
    return isPid(pid) ? pid : null
  } catch {
    // swallow-ok: an unreadable /proc scan means the pid is unknown, the caller falls back
    return null
  }
}

/** The identity of one remote process, read from `/proc` before the plugin ever signals it: the kernel start time is stable across `exec` (so an in-place DSH restart keeps it) and changes when a pid is reused, which is exactly what a kill decision must rule out. */
export async function remoteProcessIdentity(ssh: SshPort, pid: number): Promise<ProcessIdentity> {
  if (!isPid(pid)) return { ok: false, reason: 'invalid-pid' }
  const script = `set -u
PID=${pid}
[ -d "/proc/$PID" ] || { echo "MISSING"; exit 0; }
RAW=$(cat "/proc/$PID/stat" 2>/dev/null || true); [ -n "$RAW" ] || { echo "NO-STAT"; exit 0; }
REST=$(printf '%s' "$RAW" | sed 's/^.*) //'); set -- $REST
printf 'START:%s\\n' "\${20}"
CMD=$(tr '\\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true); printf 'CMD:%s\\n' "$CMD"
HOME_LINE=$(tr '\\0' '\\n' < "/proc/$PID/environ" 2>/dev/null | sed -n 's/^DSH_HOME=//p' | tail -n 1)
printf 'DSH_HOME:%s\\n' "\${HOME_LINE:-}"
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 10_000, maxBytes: 32_000 })
    return parseProcessIdentity(result.stdout)
  } catch {
    // swallow-ok: an unreadable /proc means the pid cannot be proven, and callers fail closed
    return { ok: false, reason: 'unreadable' }
  }
}

export function parseProcessIdentity(stdout: unknown): ProcessIdentity {
  const text = String(stdout ?? '')
  // Matched anywhere in the output deliberately: a command line containing MISSING/NO-STAT must not read as an identity.
  if (text.includes('MISSING')) return { ok: false, reason: 'missing' }
  if (text.includes('NO-STAT')) return { ok: false, reason: 'unreadable' }
  const start = /^START:(\d+)$/m.exec(text)
  const command = /^CMD:(.*)$/m.exec(text)
  if (!start || !command) return { ok: false, reason: 'unreadable' }
  const home = /^DSH_HOME:(.*)$/m.exec(text)
  return { ok: true, startTime: start[1], command: command[1].trim(), dshHome: home === null ? '' : home[1].trim() }
}

export async function remoteHttpStatus(ssh: SshPort, port: number): Promise<number | null> {
  if (!isPid(port)) return null
  const script = `URL="http://127.0.0.1:${port}/"
if command -v curl >/dev/null 2>&1; then curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" 2>/dev/null || true
elif command -v wget >/dev/null 2>&1; then wget -S -O /dev/null --max-time 5 "$URL" 2>&1 | sed -n 's/.*HTTP\\/[0-9.]* \\([0-9][0-9][0-9]\\).*/\\1/p' | head -n 1; fi
`
  try {
    const result = await ssh.exec(script, { timeoutMs: 15_000 })
    const code = Number(String(result.stdout ?? '').trim())
    return Number.isInteger(code) && code > 0 ? code : null
  } catch {
    return null
  }
}

export async function waitForRemoteUi(
  ssh: SshPort,
  port: number,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<{ ok: boolean; status: number | null }> {
  const attempts = options.attempts ?? 20
  const intervalMs = options.intervalMs ?? 500
  let last: number | null = null
  for (let i = 0; i < attempts; i += 1) {
    last = await remoteHttpStatus(ssh, port)
    if (isUiUp(last)) return { ok: true, status: last }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  return { ok: false, status: last }
}

export interface ExchangeOptions {
  timeoutMs?: number
  path?: string
}

export interface ExchangeResult {
  ok: boolean
  firstStatus: number
  status: number
  title: string | null
}

export async function exchangeTokenOverTunnel(
  localPort: number,
  token: string,
  options: ExchangeOptions = {},
): Promise<ExchangeResult> {
  const timeoutMs = options.timeoutMs ?? TUNNEL_PROBE_TIMEOUT_MS
  const basePath = options.path ?? '/'
  const tokenPath = `/?token=${encodeURIComponent(token)}`
  const path = basePath === '/' ? tokenPath : `${basePath}?token=${encodeURIComponent(token)}`
  const first = await httpRequest({ port: localPort, path, timeoutMs })
  const setCookies = first.headers['set-cookie'] ?? []
  const cookieHeader = setCookies.map((cookie) => String(cookie).split(';')[0]).join('; ')
  const back = first.headers.location?.startsWith('/') ? first.headers.location : '/'
  const second = await httpRequest({
    port: localPort,
    path: back,
    timeoutMs,
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(second.body)
  return {
    ok: second.status === 200 && second.body.length > 0,
    firstStatus: first.status,
    status: second.status,
    title: titleMatch ? titleMatch[1].trim().slice(0, 200) : null,
  }
}

type HttpRequestOptions = { port: number; path: string; timeoutMs: number; headers?: Record<string, string> }

type HttpResponse = { status: number; headers: http.IncomingHttpHeaders; body: string }

function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
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
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
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

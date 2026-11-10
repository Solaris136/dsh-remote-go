/**
 * Remote DSH web lifecycle: start (detached, log in the user's remote dir),
 * parse the `dsh web:` URL line, stop, and verify reachability through the
 * loopback tunnel. The launch token stays in memory (design §16.8).
 */
import http from 'node:http'
import { REMOTE_PROFILE, REMOTE_START_TIMEOUT_MS, TUNNEL_PROBE_TIMEOUT_MS } from './constants.js'
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
 * @param {import('./bootstrap.js').BootstrapPlan} plan
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {{ profile?: string }} [options]
 */
export function buildStartCommand(plan, layout, options = {}) {
  const profile = options.profile ?? REMOTE_PROFILE
  const args = `--profile ${profile} --no-open --port 0`
  if (plan.start.kind === 'dsh') {
    return `env DSH_HOME=${shellQuote(layout.home)} ${shellQuote(plan.start.dshPath ?? 'dsh')} ${args}`
  }
  if (plan.start.kind === 'node-bin') {
    return `env DSH_HOME=${shellQuote(layout.home)} ${shellQuote(plan.start.nodePath ?? layout.nodeBin)} ${shellQuote(plan.start.dshBinPath ?? layout.dshBin)} ${args}`
  }
  if (plan.start.kind === 'npx') {
    const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
    return `env DSH_HOME=${shellQuote(layout.home)} ${pathPrefix}${shellQuote(plan.start.npxPath ?? 'npx')} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} ${args}`
  }
  throw errors.internal(`unknown start plan kind: ${plan.start.kind}`)
}

/**
 * Detached start script: setsid + nohup, waits for the readiness line, logs to
 * the plugin's remote log directory, and records a pid/port registry file.
 * @param {string} startCommand
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {{ waitSeconds?: number }} [options]
 */
export function buildStartScript(startCommand, layout, options = {}) {
  const waitSeconds = options.waitSeconds ?? Math.ceil(REMOTE_START_TIMEOUT_MS / 1000)
  const version = normalizeVersion(options.version ?? '')
  const logFile = shellQuote(layout.logFile)
  const runFile = shellQuote(layout.runFile)
  const startedAtPlaceholder = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
  return `set -eu
mkdir -p ${shellQuote(layout.logsDir)} ${shellQuote(layout.runDir)} ${shellQuote(layout.home)} ${shellQuote(layout.dshHome)}
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
printf '{"pid":%s,"port":%s,"startedAt":"%s","profile":"%s","version":"%s"}\\n' "$PID" "\${PORT:-0}" "${startedAtPlaceholder}" ${JSON.stringify(REMOTE_PROFILE)} ${JSON.stringify(version)} > ${runFile}
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
 * }} RemoteWebInfo
 */

/**
 * Start the remote web app and parse its readiness line.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {{ plan: import('./bootstrap.js').BootstrapPlan, layout?: ReturnType<typeof remoteLayout>, timeoutMs?: number, onLine?: (line: string) => void }} options
 * @returns {Promise<RemoteWebInfo>}
 */
export async function startRemoteWeb(ssh, options) {
  const layout = options.layout ?? remoteLayout(options.plan.layout.root)
  const startCommand = buildStartCommand(options.plan, layout)
  const script = buildStartScript(startCommand, layout, {
    waitSeconds: Math.ceil((options.timeoutMs ?? REMOTE_START_TIMEOUT_MS) / 1000),
    version: options.plan.start.targetVersion,
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
      zh: `远端 DSH 宣布的地址不是回环地址（${parsed.host}），无法安全地经 SSH 隧道嵌入。`,
      en: `The remote DSH advertised a non-loopback host (${parsed.host}); it cannot be embedded safely over SSH.`,
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
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {number} [lines]
 */
export async function tailRemoteLog(ssh, layout, lines = 80) {  try {
    const result = await ssh.exec(`tail -n ${Math.max(1, lines)} ${shellQuote(layout.logFile)} 2>/dev/null || true`, { timeoutMs: 15_000 })
    return headTail(result.stdout, 6000)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
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
    const result = await ssh.exec(`grep 'dsh web:' ${shellQuote(layout.logFile)} 2>/dev/null | tail -n 1 || true`, { timeoutMs: 15_000 })
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
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {ReturnType<typeof remoteLayout>} layout
 * @returns {Promise<{ pid: number, port: number, token: string, url: string, adopted: true } | null>}
 */
export async function adoptRemoteWeb(ssh, layout) {
  const registry = await readRunRegistry(ssh, layout)
  const pid = Number(registry?.pid ?? 0)
  if (!(await remotePidAlive(ssh, pid))) return null
  const line = await readWebLineFromLog(ssh, layout)
  if (!line) return null
  const status = await remoteHttpStatus(ssh, line.port)
  if (!(status === 200 || status === 302 || status === 401)) return null
  const version = typeof registry?.version === 'string' && registry.version !== '' ? normalizeVersion(registry.version) : null
  return { pid, port: line.port, token: line.token, url: line.url, version, adopted: true }
}

/**
 * Check the remote UI locally on the remote loopback (server alive check).
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {number} port
 */
export async function remoteHttpStatus(ssh, port) {
  if (!Number.isInteger(port) || port <= 0) return null
  const script = `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/ 2>/dev/null || true`
  try {
    const result = await ssh.exec(script, { timeoutMs: 15_000 })
    const code = Number(result.stdout.trim())
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
 * loopback same-site path the iframe will use (design §7.0 / §9.2).
 * @param {number} localPort
 * @param {string} token
 * @param {{ timeoutMs?: number, path?: string }} [options]
 * @returns {Promise<TokenExchangeResult>}
 */
export async function exchangeTokenOverTunnel(localPort, token, options = {}) {
  const timeoutMs = options.timeoutMs ?? TUNNEL_PROBE_TIMEOUT_MS
  const basePath = options.path ?? '/'
  const tokenPath = `/?token=${encodeURIComponent(token)}`
  const first = await httpRequest({ port: localPort, path: basePath === '/' ? tokenPath : `${basePath}?token=${encodeURIComponent(token)}`, timeoutMs })
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
  const frameBlocked =
    Boolean(xFrameOptions) ||
    (typeof csp === 'string' && /frame-ancestors/i.test(csp))
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

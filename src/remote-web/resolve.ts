/**
 * Probing the remote DSH web: the `dsh web:` readiness line, the pid liveness check, adoption of
 * an instance an earlier local run left behind, the real version a process runs, and the
 * re-attach probe that refuses a candidate it cannot prove (`no-token`, `identity-*`, …).
 *
 * Everything here answers "what is running, and may this connection talk to it?"; starting and
 * stopping live in `start.ts` / `stop.ts`, and the run-registry record in `registry.ts`.
 */
import { DEFAULT_REMOTE_PROFILE } from '../constants.js'
import type { RemoteLayout } from '../layout.js'
import {
  findForeignDshProcesses,
  isUiUp,
  remoteHttpStatus,
  remoteListenPorts,
  remotePortOwnerPid,
  remoteProcessIdentity,
} from '../remote-proc.js'
import type { SshPort } from '../ssh-port.js'
import { isLoopbackHost, isPid, shellQuote } from '../util.js'
import { normalizeVersion } from '../version.js'
import { LAUNCH_MARKER, isPlainObjectValue, readRunRegistry } from './registry.js'

const WEB_LINE_RE = /dsh web:\s*(https?:\/\/[^\s]+)/

/** The `dsh web:` readiness line: the launch URL and its parsed parts. */
export interface WebLine {
  url: string
  host: string
  port: number
  token: string
  rawLine: string
}

export function parseWebLine(text: unknown): WebLine | null {
  const match = WEB_LINE_RE.exec(String(text ?? ''))
  if (!match) return null
  const rawUrl = match[1]
  let url: URL
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

export async function readWebLineFromLog(ssh: SshPort, layout: RemoteLayout): Promise<WebLine | null> {
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

export async function remotePidAlive(ssh: SshPort, pid: number): Promise<boolean> {
  if (!isPid(pid)) return false
  try {
    const result = await ssh.exec(`kill -0 ${pid} 2>/dev/null && echo alive || true`, { timeoutMs: 10_000 })
    return result.stdout.includes('alive')
  } catch {
    return false
  }
}

/** One adopted remote web instance (a process left running by an earlier local run). */
export interface AdoptedRemoteWeb {
  pid: number
  port: number
  token: string
  url: string
  version: string | null
  profile: string
  dshHome: string
  adopted: true
  origin: 'launch' | 'reattach'
}

/**
 * Try to adopt a still-running remote web instance from a previous local
 * process: registry pid alive + last log line parseable + loopback HTTP alive.
 *
 * The registry must name the same DSH home and profile this connection is about
 * to use; a process left over from another home or profile would show a
 * different DSH state than the user asked for.
 */
export async function adoptRemoteWeb(
  ssh: SshPort,
  layout: RemoteLayout,
  options: { profile?: string } = {},
): Promise<AdoptedRemoteWeb | null> {
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

/** Whether a `ps` command line is the DSH process for this profile. */
export function commandMatchesProfile(command: unknown, profile: unknown): boolean {
  const wanted = String(profile ?? '')
  if (wanted === '') return false
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`--profile[=\\s]+${escaped}(?:\\s|$)`).test(String(command ?? ''))
}

/** The pinned `@deepseek-ai/dsh@<version>` an npx command line names, if any. */
export function versionFromCommand(command: unknown): string | null {
  const match = /@deepseek-ai\/dsh@([^\s'"]+)/.exec(String(command ?? ''))
  return match ? normalizeVersion(match[1]) : null
}

/**
 * The installed package directory a real node argv names, e.g.
 * `/home/u/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh` or an app install path.
 * The version is read from that directory's `package.json` (the argv itself does not
 * carry one in the npx-cache and app-install shapes).
 */
export function dshPackageDirFromCommand(command: unknown): string | null {
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
async function packageVersionFromDir(ssh: SshPort, dir: string): Promise<string | null> {
  if (!dir || typeof ssh.readRemoteFile !== 'function') return null
  try {
    const file = await ssh.readRemoteFile(`${dir}/package.json`, { maxBytes: 64 * 1024 })
    const text = Buffer.isBuffer(file?.data) ? file.data.toString('utf8') : String(file?.data ?? '')
    const parsed: unknown = JSON.parse(text)
    const version =
      isPlainObjectValue(parsed) && typeof parsed.version === 'string' ? normalizeVersion(parsed.version) : ''
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
export async function remoteDshVersion(ssh: SshPort, command: unknown): Promise<string | null> {
  const pinned = versionFromCommand(command)
  if (pinned) return pinned
  const dir = dshPackageDirFromCommand(command)
  return dir === null ? null : packageVersionFromDir(ssh, dir)
}

/** The re-attach probe: either the proven instance or the typed reason it was refused. */
export type ResolvedRemoteWeb =
  | {
      ok: true
      pid: number
      port: number
      token: string
      url: string
      version: string | null
      profile: string
      dshHome: string
      source: string
    }
  | { ok: false; reason: string }

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
 */
export async function resolveRemoteWeb(
  ssh: SshPort,
  layout: RemoteLayout,
  options: { profile?: string; timeoutMs?: number } = {},
): Promise<ResolvedRemoteWeb> {
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
  let listeners: number[] | null = null
  const listenersOf = async (pid: number): Promise<number[]> => {
    if (listeners === null) listeners = await remoteListenPorts(ssh, pid)
    return listeners
  }
  let tokenlessPort = 0
  let firstFailure: ResolvedRemoteWeb | null = null

  /**
   * Accept one reachable candidate only when its identity and its token both check out.
   * Returns null for "reachable but no token" and a typed failure for "wrong process".
   */
  const take = async (pid: number, port: number, source: string): Promise<ResolvedRemoteWeb | null> => {
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
  const rememberFailure = (candidate: ResolvedRemoteWeb | null): void => {
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

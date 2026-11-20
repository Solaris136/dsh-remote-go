/** Probing the remote DSH web: the `dsh web:` readiness line, pid liveness, adoption, the real version a process
 * runs, and the re-attach probe that refuses a candidate it cannot prove. */
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
import { LAUNCH_MARKER, isPlainObjectValue, readRunRegistry, registryNamesInstance } from './registry.js'

const WEB_LINE_RE = /dsh web:\s*(https?:\/\/[^\s]+)/

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

export async function adoptRemoteWeb(
  ssh: SshPort,
  layout: RemoteLayout,
  options: { profile?: string } = {},
): Promise<AdoptedRemoteWeb | null> {
  const profile = options.profile ?? DEFAULT_REMOTE_PROFILE
  const registry = await readRunRegistry(ssh, layout)
  // Instances from a launch path without the browser-carrier overlay could serve a stuck page: not adoptable.
  if (registry?.launch !== LAUNCH_MARKER) return null
  const pid = Number(registry?.pid ?? 0)
  if (!registryNamesInstance(registry, layout, profile, pid)) return null
  if (!(await remotePidAlive(ssh, pid))) return null
  const line = await readWebLineFromLog(ssh, layout)
  if (!line || line.token === '') return null
  // An adopted instance is reached through the loopback tunnel only, exactly like a fresh launch.
  if (!isLoopbackHost(line.host)) return null
  if (!isUiUp(await remoteHttpStatus(ssh, line.port))) return null
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
    origin: registry.origin === 'reattach' ? 'reattach' : 'launch',
  }
}

export function commandMatchesProfile(command: unknown, profile: unknown): boolean {
  const wanted = String(profile ?? '')
  if (wanted === '') return false
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`--profile[=\\s]+${escaped}(?:\\s|$)`).test(String(command ?? ''))
}

export function versionFromCommand(command: unknown): string | null {
  const match = /@deepseek-ai\/dsh@([^\s'"]+)/.exec(String(command ?? ''))
  return match ? normalizeVersion(match[1]) : null
}

export function dshPackageDirFromCommand(command: unknown): string | null {
  const text = String(command ?? '')
  const marker = '/node_modules/@deepseek-ai/dsh'
  let at = text.indexOf(marker)
  while (at !== -1) {
    if (/^(?:\/lib\/bin\.js|[\s'"]|$)/.test(text.slice(at + marker.length))) {
      let start = at
      while (start > 0 && !/[\s'"]/.test(text[start - 1])) start -= 1
      const dir = text.slice(start, at + marker.length)
      return dir.startsWith('/') && !dir.split('/').includes('..') ? dir : null
    }
    at = text.indexOf(marker, at + marker.length)
  }
  return null
}

export async function remoteDshVersion(ssh: SshPort, command: unknown): Promise<string | null> {
  const pinned = versionFromCommand(command)
  if (pinned) return pinned
  const dir = dshPackageDirFromCommand(command)
  if (dir === null || typeof ssh.readRemoteFile !== 'function') return null
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

export async function resolveRemoteWeb(
  ssh: SshPort,
  layout: RemoteLayout,
  options: { profile?: string; timeoutMs?: number } = {},
): Promise<ResolvedRemoteWeb> {
  const profile = options.profile ?? DEFAULT_REMOTE_PROFILE
  const registry = await readRunRegistry(ssh, layout)
  const line = await readWebLineFromLog(ssh, layout)
  const registryPid = Number(registry?.pid ?? 0)
  const registryVersion =
    typeof registry?.version === 'string' && registry.version !== '' ? normalizeVersion(registry.version) : null
  const alive =
    registryNamesInstance(registry, layout, profile, registryPid) &&
    registry?.launch === LAUNCH_MARKER &&
    (await remotePidAlive(ssh, registryPid))
  let listeners: number[] | null = null
  const listenersOf = async (pid: number): Promise<number[]> => {
    if (listeners === null) listeners = await remoteListenPorts(ssh, pid)
    return listeners
  }
  let tokenlessPort = 0
  let firstFailure: ResolvedRemoteWeb | null = null
  const take = async (pid: number, port: number, source: string): Promise<ResolvedRemoteWeb | null> => {
    const identity = await remoteProcessIdentity(ssh, pid)
    if (identity.ok !== true) return { ok: false, reason: `identity-${identity.reason}` }
    if (!commandMatchesProfile(identity.command, profile)) return { ok: false, reason: 'profile-mismatch' }
    if (identity.dshHome === '' || identity.dshHome !== layout.dshHome)
      return { ok: false, reason: 'dsh-home-mismatch' }
    const token = line !== null && line.port === port ? line.token : ''
    // A candidate that answers HTTP but has no token is not usable: a real DSH answers `/?token=` with 401.
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
      version: proven ?? (pid === registryPid ? registryVersion : null),
      profile,
      dshHome: identity.dshHome,
      source,
    }
  }
  const rememberFailure = (candidate: ResolvedRemoteWeb | null): void => {
    if (candidate !== null && candidate.ok !== true && firstFailure === null) firstFailure = candidate
  }
  if (alive) {
    const candidates = [...(await listenersOf(registryPid))]
    if (isPid(Number(registry?.port ?? 0))) candidates.push(Number(registry.port))
    for (const port of [...new Set(candidates.filter((value) => isPid(value) && value <= 65535))]) {
      if (!isUiUp(await remoteHttpStatus(ssh, port))) continue
      const owner = await remotePortOwnerPid(ssh, port)
      if (!isPid(owner) || owner !== registryPid) continue
      const candidate = await take(registryPid, port, 'registry')
      if (candidate?.ok === true) return candidate
      rememberFailure(candidate)
    }
  }
  if (line !== null && isPid(line.port) && isUiUp(await remoteHttpStatus(ssh, line.port))) {
    let pid = 0
    if (alive && (await listenersOf(registryPid)).includes(line.port)) pid = registryPid
    if (!isPid(pid)) pid = await remotePortOwnerPid(ssh, line.port)
    if (isPid(pid)) {
      const candidate = await take(pid, line.port, 'log')
      if (candidate?.ok === true) return candidate
      rememberFailure(candidate)
    } else {
      firstFailure = { ok: false, reason: 'pid-unknown' }
    }
  }
  const scanned = await findForeignDshProcesses(ssh, { ignorePids: alive ? [registryPid] : [] })
  if (scanned.ok === true) {
    for (const process of scanned.processes) {
      if (!commandMatchesProfile(process.command, profile)) continue
      for (const port of await remoteListenPorts(ssh, process.pid)) {
        if (!isUiUp(await remoteHttpStatus(ssh, port))) continue
        const identity = await remoteProcessIdentity(ssh, process.pid)
        if (identity.ok === true && identity.dshHome === layout.dshHome) return { ok: false, reason: 'no-token' }
      }
    }
  }
  if (firstFailure !== null) return firstFailure
  if (tokenlessPort !== 0) return { ok: false, reason: 'no-token' }
  return { ok: false, reason: alive ? 'no-listener' : 'no-running-web' }
}

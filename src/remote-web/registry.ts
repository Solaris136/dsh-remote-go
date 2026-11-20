/** The `run/web.json` record: the launch marker, the tolerant parser and the atomic writer. Every field is
 * untrusted and each consumer narrows the one it reads. */
import { DEFAULT_REMOTE_PROFILE } from '../constants.js'
import { errors } from '../errors.js'
import type { RemoteLayout } from '../layout.js'
import type { SshPort } from '../ssh-port.js'
import { isPid, messageOf, nowIso, shellQuote } from '../util.js'
import { normalizeVersion } from '../version.js'

export const LAUNCH_MARKER = 'browser-carrier-v1'

export interface RunRegistryRecord {
  pid?: unknown
  port?: unknown
  startedAt?: unknown
  profile?: unknown
  version?: unknown
  dshHome?: unknown
  launch?: unknown
  origin?: unknown
}

export interface PersistedRunRegistry {
  pid: number
  port: number
  startedAt: string
  profile: string
  version: string
  dshHome: string
  launch: string
  origin: 'launch' | 'reattach'
}

export interface RunRegistryInput extends RunRegistryRecord {}

export function parseRunRegistry(text: unknown): RunRegistryRecord | null {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObjectValue(parsed) ? parsed : null
  } catch {
    // swallow-ok: fall through to the field-by-field recovery below
  }
  const field = (name: string): string | null =>
    new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)?.[1] ?? null
  const number = (name: string): number => Number(new RegExp(`"${name}"\\s*:\\s*(\\d+)\\s*[,}]`).exec(raw)?.[1] ?? 0)
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

export function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export async function readRunRegistry(ssh: SshPort, layout: RemoteLayout): Promise<RunRegistryRecord | null> {
  try {
    const result = await ssh.exec(`cat ${shellQuote(layout.runFile)} 2>/dev/null || true`, { timeoutMs: 10_000 })
    if (result.code !== 0 || result.stdout.trim() === '') return null
    return parseRunRegistry(result.stdout)
  } catch {
    return null
  }
}

/** True when one `run/web.json` record names the instance of this layout/profile at `pid`: the one ownership rule the stop and restart proof, the launch pipeline and the re-attach/adopt probe all re-check. */
export function registryNamesInstance(
  record: RunRegistryRecord | null,
  layout: RemoteLayout,
  profile: string,
  pid: number,
): boolean {
  if (record === null || record.dshHome !== layout.dshHome || record.profile !== profile) return false
  return isPid(pid) && Number(record.pid) === pid
}

export function buildRunRegistryRecord(input: RunRegistryInput = {}): PersistedRunRegistry {
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
    origin: input.origin === 'reattach' ? 'reattach' : 'launch',
  }
}

export async function clearRunRegistry(ssh: SshPort, layout: RemoteLayout): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await ssh.exec(`rm -f ${shellQuote(layout.runFile)}`, { timeoutMs: 10_000 })
    return { ok: result.code === 0, output: String(result.stdout ?? '').trim() }
  } catch (error) {
    // swallow-ok: returned as ok:false and logged by the caller; the next connect re-checks the
    return { ok: false, output: messageOf(error) }
  }
}

export async function writeRunRegistry(
  ssh: SshPort,
  layout: RemoteLayout,
  record: RunRegistryRecord | PersistedRunRegistry,
): Promise<{ ok: boolean; output: string }> {
  const payload = JSON.stringify(record)
  // Temp file + rename: a concurrent reader sees the old record or the new one, never a truncated line.
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
    return { ok: false, output: messageOf(error) }
  }
}

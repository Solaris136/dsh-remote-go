/**
 * The `run/web.json` record: the marker a launch writes, the tolerant parser and the atomic
 * writer. Every field is untrusted — the parser hands back `unknown` values and each consumer
 * narrows the one it reads — and the write goes through a temp file + rename, so a concurrent
 * reader never sees a half-written record (M4). Reading and dropping the record live here too:
 * the file is one fact, so it has one owner.
 */
import { DEFAULT_REMOTE_PROFILE } from '../constants.js'
import { errors } from '../errors.js'
import type { RemoteLayout } from '../layout.js'
import type { SshTransport } from '../ssh.js'
import { isPid, messageOf, nowIso, shellQuote } from '../util.js'
import { normalizeVersion } from '../version.js'

/**
 * Version tag written into the run registry. Bumping it invalidates adoption of
 * instances started by an older launch path (they may lack the browser-carrier
 * overlay, which would leave the in-window page stuck at "failed to load plugins").
 */
export const LAUNCH_MARKER = 'browser-carrier-v1'

/**
 * The pid/port record under `run/web.json`. The file is read back through
 * `parseRunRegistry`, which cannot trust it: every field is `unknown` and each
 * consumer narrows the one it needs (`typeof … === 'string'`, `Number(…)`).
 */
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

/** What `buildRunRegistryRecord` writes: every field already resolved. */
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

/** The caller's raw fields for one registry record; each is validated/normalized below. */
export interface RunRegistryInput {
  pid?: unknown
  port?: unknown
  startedAt?: unknown
  profile?: unknown
  version?: unknown
  dshHome?: unknown
  origin?: unknown
}

/**
 * Read `run/web.json`. The record is written atomically (temp + rename), but a record from an
 * older launch path or a truncated file still names the process: parse what is there instead
 * of reporting "no record" and losing the only pid (M4).
 * @param text - the raw file content.
 * @returns the parsed record, or null when it names no pid.
 */
export function parseRunRegistry(text: unknown): RunRegistryRecord | null {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    // `isPlainObject` is the guard that makes the untrusted document a record of unknowns;
    // every consumer still narrows the individual field it reads.
    return isPlainObjectValue(parsed) ? parsed : null
  } catch {
    // swallow-ok: fall through to the field-by-field recovery below
  }
  const field = (name: string): string | null =>
    new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)?.[1] ?? null
  // A number must be terminated by the next field or the record end: `{"pid":42` is a
  // truncated record, not a pid of 42 (review: no prefix matches).
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

/** A JSON object (an array included): the shape `parseRunRegistry` accepts without inspection. */
export function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export async function readRunRegistry(ssh: SshTransport, layout: RemoteLayout): Promise<RunRegistryRecord | null> {
  try {
    const result = await ssh.exec(`cat ${shellQuote(layout.runFile)} 2>/dev/null || true`, { timeoutMs: 10_000 })
    if (result.code !== 0 || result.stdout.trim() === '') return null
    return parseRunRegistry(result.stdout)
  } catch {
    return null
  }
}

/**
 * The pid/port record the plugin writes to `run/web.json` (the same shape the
 * launch script writes). Kept pure so a re-attach can be tested without SSH.
 * @param input - pid, port, profile, dshHome, version, startedAt.
 * @returns the registry record.
 */
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
    // `launch`: this plugin started the process; `reattach`: the plugin only took it over.
    // The next connection reads this so a re-attached process never gains kill rights.
    origin: input.origin === 'reattach' ? 'reattach' : 'launch',
  }
}

/**
 * Drop `run/web.json` without signalling anything: used when the bound process is already
 * gone (a stop) or the record is known stale. Never kills a pid.
 * @returns whether the removal was acknowledged.
 */
export async function clearRunRegistry(
  ssh: SshTransport,
  layout: RemoteLayout,
): Promise<{ ok: boolean; output: string }> {
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
 * @param record - validated record from {@link buildRunRegistryRecord}.
 * @returns whether the write was acknowledged.
 */
export async function writeRunRegistry(
  ssh: SshTransport,
  layout: RemoteLayout,
  record: RunRegistryRecord | PersistedRunRegistry,
): Promise<{ ok: boolean; output: string }> {
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

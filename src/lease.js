/**
 * The remote writer authority (design §6.2, L3 prerequisite).
 *
 * L3 needs exactly one writer per mirror. The local side already has the pieces —
 * `acquireLease` issues a fencing `epoch`, and `assertWritable` refuses a write whose
 * epoch has been overtaken (`src/mirror.js`) — but a *stale* writer only learns it has
 * been fenced by reading what the remote side believes. This module is that read.
 *
 * Until L3 ships the real control channel, the authority is a small JSON file in the
 * remote's DSH home:
 *
 *     <DSH_HOME>/remote-go/lease.json   { "writer": "<id>", "epoch": <int>, "expiresAt": <ms> }
 *
 * It is read over the same SSH `exec` transport L1/L2 already use, with the same bounded
 * command shape, so it needs nothing new on the remote. The file is optional: an absent or
 * unreadable authority is *not* an error — it means "no competing writer is known", and
 * the mirror keeps its own lease. Both are typed so the caller never has to guess.
 *
 * @module
 */

/** Bounds for one authority read: it is a tiny file, so the limits are small. */
export const LEASE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024,
  timeoutMs: 10_000,
})

/**
 * The path of the remote authority file.
 * @param {string} remoteDshHome absolute POSIX path
 * @returns {string}
 */
export function remoteLeaseFile(remoteDshHome) {
  const home = String(remoteDshHome ?? '').replace(/\/+$/, '')
  return `${home}/remote-go/lease.json`
}

/**
 * The command that reads the authority.
 *
 * `2>&1` is deliberate (as in the history read): a permission problem must be
 * distinguishable from "the file is not there", and only the message makes that possible.
 * `|| true` keeps a missing file from failing the command.
 *
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function buildLeaseReadCommand(file, maxBytes = LEASE_LIMITS.maxBytes) {
  const limit = Math.max(1, Math.floor(maxBytes)) + 1
  return `head -c ${limit} ${quotePath(file)} 2>&1 || true`
}

/**
 * @param {string} value
 * @returns {string}
 */
function quotePath(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * Parse the authority file.
 *
 * Accepts `{ writer|owner, epoch, expiresAt }` and tolerates a string `epoch`. Anything
 * that is not an object with at least one usable field is `malformed` — the caller decides
 * whether that is fatal (it is not: an unusable authority means "keep your own lease").
 *
 * @param {string} text
 * @returns {{ ok: true, writer: string | null, epoch: number | null, expiresAt: number | null }
 *   | { ok: false, reason: 'malformed' }}
 */
export function parseRemoteLease(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: 'malformed' }
  /** @type {any} */
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' }
  const writer =
    typeof parsed.writer === 'string'
      ? parsed.writer.trim()
      : typeof parsed.owner === 'string'
        ? parsed.owner.trim()
        : ''
  const epoch = toInt(parsed.epoch)
  const expiresAt = toInt(parsed.expiresAt)
  if (writer === '' && epoch === null && expiresAt === null) return { ok: false, reason: 'malformed' }
  return { ok: true, writer: writer === '' ? null : writer, epoch, expiresAt }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

/**
 * Read the remote writer authority.
 *
 * Typed outcomes, never thrown:
 * - `{ ok: true, report: null }` — no authority published (the common case today).
 * - `{ ok: true, report: { writer, epoch, expiresAt } }` — a competing grant exists.
 * - `{ ok: false, reason: 'read-failed' | 'permission-denied' | 'lease-malformed' }` —
 *   the file exists but cannot be trusted. The caller keeps writing with its own lease
 *   and records the reason; a *malformed* authority must never be read as "nobody else
 *   is writing", so it is reported rather than swallowed.
 *
 * @param {{ exec?: Function } | null} ssh
 * @param {{ remoteDshHome: string, timeoutMs?: number, maxBytes?: number }} input
 * @returns {Promise<
 *   | { ok: true, report: { writer: string | null, epoch: number | null, expiresAt: number | null } | null, file: string }
 *   | { ok: false, reason: 'ssh-unavailable' | 'read-failed' | 'permission-denied' | 'lease-malformed' | 'log-truncated', file: string }
 * >}
 */
export async function fetchRemoteLease(ssh, input) {
  const file = remoteLeaseFile(input?.remoteDshHome)
  const maxBytes = Math.max(1, Math.floor(Number(input?.maxBytes ?? LEASE_LIMITS.maxBytes)))
  const timeoutMs = Math.max(1, Math.floor(Number(input?.timeoutMs ?? LEASE_LIMITS.timeoutMs)))
  if (!ssh || typeof ssh.exec !== 'function') return { ok: false, reason: 'ssh-unavailable', file }
  /** @type {{ code: number | null, stdout: string, stderr: string, timedOut?: boolean }} */
  let result
  try {
    result = await ssh.exec(buildLeaseReadCommand(file, maxBytes), { timeoutMs })
  } catch {
    return { ok: false, reason: 'read-failed', file }
  }
  const stdout = String(result?.stdout ?? '')
  const stderr = String(result?.stderr ?? '')
  const output = `${stderr}\n${stdout}`
  if (/permission denied/i.test(output)) return { ok: false, reason: 'permission-denied', file }
  // An empty answer — success or not — means no authority is published. That is the normal
  // state for a remote that does not run an L3 writer, so it is not an error.
  if (stdout.trim() === '') return { ok: true, report: null, file }
  if (/no such file/i.test(output)) return { ok: true, report: null, file }
  if (result?.code !== 0) return { ok: false, reason: 'read-failed', file }
  if (Buffer.byteLength(stdout, 'utf8') > maxBytes) return { ok: false, reason: 'log-truncated', file }
  const parsed = parseRemoteLease(stdout)
  if (!parsed.ok) return { ok: false, reason: 'lease-malformed', file }
  return { ok: true, report: { writer: parsed.writer, epoch: parsed.epoch, expiresAt: parsed.expiresAt }, file }
}

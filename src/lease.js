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
 * It is read **and written** over the same SSH `exec` transport L1/L2 already use, with the
 * same bounded command shape, so it needs nothing new on the remote. Both directions are
 * typed so the caller never has to guess:
 *
 * - read: absent/unreadable authority means "no competing writer is known", not an error.
 * - publish: the remote **validates** the record and rejects a stale epoch, a mismatched
 *   session key, or an implausible epoch jump. That rejection is the whole point — a
 *   partitioned writer that ignores its own local check still cannot write.
 *
 * @module
 */

/**
 * Longest session segment kept verbatim; longer ids keep a digest suffix so they stay distinct.
 * Comfortably below the usual 255-byte filename limit even after the `lease-`/`.json` wrapper.
 */
const SAFE_SEGMENT_LIMIT = 120

/** Bounds for one authority read: it is a tiny file, so the limits are small. */
export const LEASE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024,
  timeoutMs: 10_000,
  /**
   * How far an epoch may jump and still be believed.
   *
   * Fencing is a ratchet: a higher number wins. That is correct between honest writers and
   * a cheap denial of service against an honest one, because whoever publishes a huge number
   * takes the lease away from everybody. The remote only accepts a jump inside this window.
   */
  epochJumpLimit: 1000,
})

/**
 * The path of the remote authority file.
 * @param {string} remoteDshHome absolute POSIX path
 * @returns {string}
 */
export function remoteLeaseFile(remoteDshHome, remoteSessionId = null) {
  const home = String(remoteDshHome ?? '').replace(/\/+$/, '')
  const session = remoteSessionId === null ? '' : safeSegment(remoteSessionId)
  return session === '' ? `${home}/remote-go/lease.json` : `${home}/remote-go/lease-${session}.json`
}

/**
 * A filesystem-safe, **injective** segment for a remote session id.
 *
 * This must be a bijection on ids, not a "cleanup": two distinct ids that collapse onto one
 * file would share a lease and fence each other — the exact defect that made the authority
 * per-session in the first place.
 *
 * Two rules make it injective where a naive version is not:
 * - escapes are **zero-padded to 4 hex digits**, so `"\u0002" + "5"` (`%0002` + `5`) cannot
 *   collide with `"%25"` — without padding, `%2` + `5` equals `%25`;
 * - over-long ids keep a **hash suffix** rather than being truncated, so `"x"*130` and
 *   `"x"*131` stay distinct files.
 *
 * Traversal is impossible: `/`, `.` sequences outside the safe set are all escaped, so the
 * result never contains a path separator and never starts a `..` segment on its own.
 * @param {string} value
 * @returns {string}
 */
function safeSegment(value) {
  const text = String(value ?? '')
  let out = ''
  for (const char of text) {
    out += /[A-Za-z0-9_-]/.test(char) ? char : `%${char.codePointAt(0).toString(16).padStart(4, '0')}`
  }
  // Keep the name bounded without losing identity: the tail becomes a digest of the full id.
  if (out.length <= SAFE_SEGMENT_LIMIT) return out
  const suffix = `~${shortDigest(text)}`
  return `${out.slice(0, SAFE_SEGMENT_LIMIT - suffix.length)}${suffix}`
}

/**
 * A short, stable digest of an id (only used to keep truncated names distinct).
 * @param {string} text
 * @returns {string}
 */
function shortDigest(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
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
 * @returns {{ ok: true, writer: string | null, epoch: number | null, expiresAt: number | null, sessionKey: string | null }
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
  const sessionKey =
    typeof parsed.sessionKey === 'string' && parsed.sessionKey.trim() !== '' ? parsed.sessionKey.trim() : null
  if (writer === '' && epoch === null && expiresAt === null) return { ok: false, reason: 'malformed' }
  return { ok: true, writer: writer === '' ? null : writer, epoch, expiresAt, sessionKey }
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
 * @param {{ remoteDshHome: string, remoteSessionId?: string | null, timeoutMs?: number, maxBytes?: number }} input
 * @returns {Promise<
 *   | { ok: true, report: { writer: string | null, epoch: number | null, expiresAt: number | null } | null, file: string }
 *   | { ok: false, reason: 'ssh-unavailable' | 'read-failed' | 'permission-denied' | 'lease-malformed' | 'log-truncated', file: string }
 * >}
 */
export async function fetchRemoteLease(ssh, input) {
  const file = remoteLeaseFile(input?.remoteDshHome, input?.remoteSessionId ?? null)
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
  return {
    ok: true,
    report: { writer: parsed.writer, epoch: parsed.epoch, expiresAt: parsed.expiresAt, sessionKey: parsed.sessionKey },
    file,
  }
}

/**
 * Build the authority record the local writer publishes.
 *
 * `sessionKey` binds the record to **this connection**: whoever established the lease holds
 * the key, and the remote only lets that key renew it. That is the strongest binding this
 * transport honestly supports (see the limits in `docs/session-design.md` §11 #9): it stops a
 * second writer from silently continuing someone else's lease, and it stops a stale writer
 * from renewing a lease it no longer holds. It does **not** stop a party that can both read
 * and write the authority file, because nothing here is a secret from them.
 *
 * `expiresAt` is what makes a crashed writer recoverable: a record past its expiry is free
 * for anyone to take over, so a dead client cannot block the mirror forever.
 *
 * @param {{ writer: string, epoch: number, expiresAt: number, sessionKey: string }} input
 * @returns {{ writer: string, epoch: number, expiresAt: number, sessionKey: string, version: 1 }}
 */
export function buildLeaseRecord(input) {
  return {
    version: 1,
    writer: String(input.writer),
    epoch: Math.max(0, Math.floor(Number(input.epoch))),
    expiresAt: Math.max(0, Math.floor(Number(input.expiresAt))),
    sessionKey: String(input.sessionKey),
  }
}

/**
 * The command that publishes a record.
 *
 * The record travels as JSON in a single argument, quoted with the same rule the rest of the
 * plugin uses, so no character in it can break out of the shell word. `mkdir -p` makes the
 * first publish work on a remote that has never seen the plugin. No `|| true`: the exit code
 * is how the remote reports a refusal, and masking it would turn "rejected" into "accepted".
 *
 * @param {string} file
 * @param {ReturnType<typeof buildLeaseRecord>} record
 * @returns {string}
 */
export function buildLeasePublishCommand(file, record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64')
  // `base64 -d` is the GNU spelling; the fallback covers BSD/busybox mktemp'ed hosts.
  //
  // Written to a sibling temp file and renamed: `> file` truncates first, so a crash or a
  // concurrent read would see partial JSON. That is classified as `lease-malformed` and treated
  // as untrustworthy, which would turn a crash into a lockout instead of a recoverable lease.
  const temp = `${file}.tmp`
  return (
    `mkdir -p ${quotePath(dirOf(file))} 2>/dev/null; ` +
    `printf '%s' ${quotePath(payload)} | (base64 -d 2>/dev/null || base64 -D 2>/dev/null) > ${quotePath(temp)} && ` +
    `mv ${quotePath(temp)} ${quotePath(file)}`
  )
}

/**
 * The tombstone that releases the lease (fenced, expired, host deleted, plugin unloaded).
 *
 * It keeps the writer id and epoch but makes the record immediately expired, so another
 * client may take over at once instead of waiting out the TTL. Publishing a *lower* epoch is
 * never allowed — the caller passes the epoch it held.
 *
 * @param {string} file
 * @param {{ writer: string, epoch: number, sessionKey: string, now: number }} input
 * @returns {string}
 */
export function buildLeaseReleaseCommand(file, input) {
  const record = buildLeaseRecord({
    writer: input.writer,
    epoch: input.epoch,
    expiresAt: Math.max(0, Math.floor(Number(input.now))),
    sessionKey: input.sessionKey,
  })
  return buildLeasePublishCommand(file, record)
}

/**
 * @param {string} file
 * @returns {string}
 */
function dirOf(file) {
  const text = String(file ?? '')
  const at = text.lastIndexOf('/')
  return at <= 0 ? '/' : text.slice(0, at)
}

/**
 * `expiresAt` in the authority record is a wall clock on the remote, while the lease TTL is
 * measured on the local (injected) clock. The plugin therefore publishes `now + ttl` from the
 * value it just used, and the remote compares it against its own clock only for takeover
 * decisions — never for the local fencing decision, which stays local and monotonic.
 * @param {{ startedAt: number, ttlMs: number }} input
 * @returns {number}
 */
export function leaseExpiryFor(input) {
  return Math.max(0, Math.floor(Number(input.startedAt))) + Math.max(0, Math.floor(Number(input.ttlMs)))
}

/**
 * Classify the remote's answer to a publish.
 *
 * The remote is the authority for *whether this write may happen*, so its refusal is a typed
 * result rather than an exception: `stale-epoch` (someone newer holds it), `writer-changed`
 * (our session key no longer owns the lease), `unauthenticated` (the key does not match),
 * `implausible-epoch` (a jump too large to believe) and `rejected` (anything else).
 *
 * @param {{ code: number | null, stdout: string, stderr: string, timedOut?: boolean }} result
 * @returns {{ ok: true } | { ok: false, reason: string, remoteEpoch: number | null, message: string }}
 */
export function classifyPublishResult(result) {
  const stdout = String(result?.stdout ?? '').trim()
  const stderr = String(result?.stderr ?? '').trim()
  const output = `${stderr}\n${stdout}`.trim()
  if (result?.timedOut === true) {
    return { ok: false, reason: 'publish-timeout', remoteEpoch: null, message: 'the remote did not answer' }
  }
  // The remote answers with a single machine-readable line on refusal.
  const refusal = /dsh-lease:\s*([a-z-]+)(?:\s+(\d+))?/i.exec(output)
  if (refusal) {
    return {
      ok: false,
      reason: refusal[1].toLowerCase(),
      remoteEpoch: refusal[2] === undefined ? null : Number(refusal[2]),
      message: output,
    }
  }
  if (result?.code === 0) return { ok: true }
  if (/permission denied/i.test(output)) {
    return { ok: false, reason: 'permission-denied', remoteEpoch: null, message: output }
  }
  return { ok: false, reason: 'publish-failed', remoteEpoch: null, message: output || `exit ${result?.code}` }
}

/**
 * Publish (or release) the local writer authority.
 *
 * Never throws: a failed publish is reported, and the caller **must** treat it as "not
 * authorized" rather than falling back to writing anyway — otherwise the channel would be
 * decoration.
 *
 * @param {{ exec?: Function } | null} ssh
 * @param {{ remoteDshHome: string, remoteSessionId?: string | null, record: ReturnType<typeof buildLeaseRecord>, timeoutMs?: number }} input
 * @returns {Promise<{ ok: true, file: string } | { ok: false, reason: string, remoteEpoch: number | null, message: string, file: string }>}
 */
export async function publishRemoteLease(ssh, input) {
  const file = remoteLeaseFile(input?.remoteDshHome, input?.remoteSessionId ?? null)
  const timeoutMs = Math.max(1, Math.floor(Number(input?.timeoutMs ?? LEASE_LIMITS.timeoutMs)))
  if (!ssh || typeof ssh.exec !== 'function') {
    return { ok: false, reason: 'ssh-unavailable', remoteEpoch: null, message: 'no ssh', file }
  }
  /** @type {{ code: number | null, stdout: string, stderr: string, timedOut?: boolean }} */
  let result
  try {
    result = await ssh.exec(buildLeasePublishCommand(file, input.record), { timeoutMs })
  } catch (error) {
    return { ok: false, reason: 'publish-failed', remoteEpoch: null, message: String(error), file }
  }
  const verdict = classifyPublishResult(result)
  if (verdict.ok) return { ok: true, file }
  return { ...verdict, file }
}

/**
 * L2 history replay: read a remote session's log over SSH and project it into the
 * local mirror session (design §3 L2, §6 cursor, §7 failure modes).
 *
 * Why SSH `exec` and not an RPC: L2 must stay consistent with L1's promise of
 * "zero remote-only components" (design §5). L1 reads `${DSH_HOME}/storages/
 * workspace.json` with `cat`, so L2 reads the session log the same way. The remote
 * is an unmodified DSH.
 *
 * Everything here is offline-safe: a missing, unreadable, truncated or
 * unknown-version log produces a **typed reason** and leaves the mirror as it was.
 * Nothing in this module throws into the connect path (design §4: degrade
 * explicitly, never pretend).
 *
 * The discovery strategy is deliberately small and observable, because it is the
 * part most likely to break against a real remote:
 *
 * 1. `test -d <home>/sessions` — is there a session store at all?
 * 2. `find <home>/sessions -maxdepth 4 -type f -name '*<remoteSessionId>*'` — the
 *    layouts seen in practice are `sessions/<workspaceId>/session-<id>.json` and
 *    `sessions/<id>/events.jsonl`; matching the id inside the name covers both
 *    without assuming one.
 * 3. `head -c <maxBytes> <file>` — bound the read at the remote.
 *
 * A layout we do not recognise yields `no-session-log`, not an exception, and the
 * descriptor keeps its last cursor so a later run can retry.
 */
import { SURFACE_EVENT_TYPES } from './session-adapter.js'
import { applyEvents } from './mirror.js'

/**
 * Hard limits. Bounded reads are a safety boundary, not a tuning knob: the remote
 * log is remote-controlled input, so the amount we are willing to buffer, parse
 * and append must be fixed before we open the connection.
 */
export const HISTORY_LIMITS = Object.freeze({
  /** Bytes read from one remote log file (`head -c` and the SSH `maxBytes` guard). */
  maxBytes: 2 * 1024 * 1024,
  /** Events parsed out of one log file; the tail is kept, the rest is reported. */
  maxEvents: 2000,
  /** Discovery candidates, so a broad `find` cannot stream thousands of paths. */
  maxFiles: 5,
  /** Per-command timeout; the sync path runs this per session. */
  timeoutMs: 20_000,
  /** Maximum depth searched under `<DSH_HOME>/sessions`. */
  maxDepth: 4,
})

/**
 * Typed failure reasons (design §7). Each one is "keep the mirror, do not advance
 * the cursor, annotate the descriptor".
 * @typedef {'sessions-dir-missing' | 'no-session-log' | 'read-failed' | 'permission-denied'
 *   | 'log-truncated' | 'log-malformed' | 'unknown-version' | 'gap-unfilled' | 'history-disabled'} HistoryFailure
 */

/** Reasoning limits for the `sanitizeValue` projection of unknown record types. */
const SANITIZE = Object.freeze({ depth: 3, maxKeys: 24, maxString: 500 })

/**
 * Quote a value for a POSIX shell (same rule as `src/workspaces.js`).
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * `<DSH_HOME>/sessions` on the remote.
 * @param {string} remoteDshHome absolute POSIX path
 * @returns {string}
 */
export function remoteSessionsRoot(remoteDshHome) {
  return `${String(remoteDshHome ?? '').replace(/\/+$/, '')}/sessions`
}

/** @param {string} root @returns {string} */
export function buildDirProbeCommand(root) {
  return `test -d ${quote(root)} && echo yes || echo no`
}

/**
 * @param {string} root
 * @param {string} remoteSessionId
 * @returns {string}
 */
export function buildDiscoveryCommand(root, remoteSessionId) {
  return (
    `find ${quote(root)} -maxdepth ${HISTORY_LIMITS.maxDepth} -type f ` +
    `-name ${quote(`*${remoteSessionId}*`)} 2>/dev/null | head -n ${HISTORY_LIMITS.maxFiles}`
  )
}

/**
 * Read at most `maxBytes + 1` of a remote file.
 *
 * The extra byte is what distinguishes "the file is exactly at the cap" from "there
 * is more": asking for one byte past the limit means a complete log whose size is
 * exactly `maxBytes` is not misreported as truncated.
 *
 * `2>/dev/null` is deliberately **not** used here (unlike discovery): an unreadable
 * log must surface `Permission denied` on stderr so it can be classified as
 * `permission-denied` instead of looking like a missing log. `|| true` still keeps a
 * non-zero exit from failing the command, so the empty stdout is classified by the
 * caller rather than by the shell.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function buildReadCommand(file, maxBytes = HISTORY_LIMITS.maxBytes) {
  const limit = Math.max(1, Math.floor(maxBytes)) + 1
  return `head -c ${limit} ${quote(file)} 2>&1 || true`
}

/**
 * Classify a failed read from the remote's combined output.
 *
 * The read redirects stderr into stdout (`2>&1`), so a permission error arrives on
 * stdout; both streams are inspected anyway because an SSH layer may separate them.
 * @param {{ code: number | null, stdout: string, stderr: string }} result
 * @returns {HistoryFailure | null}
 */
export function classifyReadFailure(result) {
  const stdout = String(result?.stdout ?? '')
  const output = `${String(result?.stderr ?? '')}\n${stdout}`
  if (/permission denied/i.test(output)) return 'permission-denied'
  // A successful command's stdout is the log itself, so "no such file" is only
  // meaningful when the command actually failed.
  if (result?.code !== 0 && /no such file/i.test(output)) return 'no-session-log'
  if (result?.code !== 0 && stdout.trim() === '') return 'read-failed'
  return null
}

/**
 * Pick the most log-like candidate from a discovery listing.
 *
 * Preference order is explicit and deterministic: a whole-log JSON file first,
 * then a JSONL event stream, then any remaining JSON. Candidates that are clearly
 * not logs (lock files, snapshots, binary sidecars) are skipped.
 * @param {string} listing newline-separated absolute paths
 * @returns {string | null}
 */
export function pickLogFile(listing) {
  const files = String(listing ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  /** @type {string[]} */
  const usable = []
  for (const file of files) {
    const name = file.split('/').pop() ?? ''
    // Sidecars that are never the event log: locks, snapshots, attachments.
    if (/\.(?:lock|tmp|png|jpe?g|gif|webp|pdf|zip|gz|tgz|sqlite|db)$/i.test(name)) continue
    if (!/\.(?:json|jsonl|ndjson)$/i.test(name)) continue
    usable.push(file)
  }
  // The event stream (JSONL) is the authoritative, append-only log; a
  // `session-*.json` is usually a snapshot of the same session and may lag it.
  const rank = (file) => (/\.(?:jsonl|ndjson)$/i.test(file) ? 0 : /session[^/]*\.json$/i.test(file) ? 1 : 2)
  return usable.sort((left, right) => rank(left) - rank(right))[0] ?? null
}

/**
 * Parse a remote session log.
 *
 * Accepted shapes, in order: a JSON array of records; an object carrying
 * `events`/`records`/`messages`/`history`; a single session object with a `turns`
 * array; or JSONL/NDJSON (one record per line). An explicit `version` other than
 * 1 is reported as `unknown-version` without attempting to interpret the records,
 * because a newer schema must not be silently mis-mapped.
 *
 * @param {string} text
 * @returns {{ ok: true, records: unknown[], version: number } | { ok: false, reason: HistoryFailure, version: number | null }}
 */
export function parseRemoteSessionLog(text) {
  const raw = typeof text === 'string' ? text : ''
  if (raw.trim() === '') return { ok: false, reason: 'log-malformed', version: null }

  /** @type {unknown} */
  let value = null
  let jsonParsed = true
  try {
    value = JSON.parse(raw)
  } catch {
    jsonParsed = false
  }

  if (!jsonParsed) {
    // JSONL / NDJSON: parse line by line, ignore blank and non-object lines.
    /** @type {unknown[]} */
    const records = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('//')) continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        return { ok: false, reason: 'log-malformed', version: null }
      }
    }
    if (records.length === 0) return { ok: false, reason: 'log-malformed', version: null }
    return { ok: true, records, version: 1 }
  }

  const version = readVersion(value)
  if (version !== null && version !== 1) return { ok: false, reason: 'unknown-version', version }

  if (Array.isArray(value)) return { ok: true, records: value, version: version ?? 1 }
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    for (const key of ['events', 'records', 'messages', 'history', 'turns']) {
      if (Array.isArray(record[key]))
        return { ok: true, records: /** @type {unknown[]} */ (record[key]), version: version ?? 1 }
    }
  }
  return { ok: false, reason: 'log-malformed', version }
}

/** @param {unknown} value @returns {number | null} */
function readVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = /** @type {Record<string, unknown>} */ (value).version
  const num = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(num) && num > 0 ? num : null
}

/**
 * `at` timestamp of a record, as ISO, or `null`.
 * @param {Record<string, unknown>} record
 * @returns {string | null}
 */
function recordTime(record) {
  for (const key of ['at', 'timestamp', 'createdAt', 'time', 'ts']) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = new Date(raw)
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const parsed = new Date(raw < 1e12 ? raw * 1000 : raw)
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
  }
  return null
}

/**
 * Project an arbitrary JSON value onto something a session event may safely carry.
 *
 * Unknown record types are **preserved**, not dropped: a remote schema we do not
 * know yet must still replay as *something*, otherwise a version bump would look
 * like data loss. The projection is deterministic — depth, key count and string
 * length are capped, arrays keep their head, and binary-ish values are replaced by
 * a marker — so the same record always maps to the same event.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (/^data:[^,]*;base64,/i.test(value)) return '[binary omitted]'
    return value.length > SANITIZE.maxString ? `${value.slice(0, SANITIZE.maxString)}…` : value
  }
  if (depth >= SANITIZE.depth) return '[truncated]'
  if (Array.isArray(value)) {
    return value.slice(0, SANITIZE.maxKeys).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    for (const [key, entry] of entries.slice(0, SANITIZE.maxKeys)) {
      // Model-internal and binary fields are dropped by name, everywhere.
      if (DROPPED_FIELDS.has(key)) continue
      out[key] = sanitizeValue(entry, depth + 1)
    }
    return out
  }
  return null
}

/**
 * Fields that are never projected: binary payloads and model-internal bookkeeping
 * (design §3 "what is dropped").
 */
const DROPPED_FIELDS = new Set([
  'logprobs',
  'usage',
  'raw',
  'base64',
  'blob',
  'image',
  'images',
  'attachment',
  'attachments',
  'binary',
  'buffer',
  'embedding',
  'embeddings',
  'reasoningTokens',
  'providerMetadata',
])

/**
 * Text of a message record: `text`, a string `content`, or the text parts of a
 * content array. Non-text parts (images, binaries) are dropped by design.
 * @param {Record<string, unknown>} record
 * @returns {{ text: string, droppedParts: number }}
 */
function recordText(record) {
  const direct = record.text ?? record.content
  if (typeof direct === 'string') return { text: direct, droppedParts: 0 }
  const candidate = record.parts ?? record.content
  if (Array.isArray(candidate)) {
    let droppedParts = 0
    const texts = []
    for (const part of candidate) {
      if (typeof part === 'string') {
        texts.push(part)
        continue
      }
      if (part && typeof part === 'object') {
        const entry = /** @type {Record<string, unknown>} */ (part)
        if (typeof entry.text === 'string') {
          texts.push(entry.text)
          continue
        }
        if (typeof entry.content === 'string' && /text/.test(String(entry.type ?? 'text'))) {
          texts.push(entry.content)
          continue
        }
      }
      // Anything that is not text (image/tool-call/binary) is not part of the text.
      droppedParts += 1
    }
    return { text: texts.join('\n'), droppedParts }
  }
  return { text: '', droppedParts: 0 }
}

/** Roles DSH renders as messages. */
const ROLE_TYPES = Object.freeze({
  user: 'user/message',
  assistant: 'assistant/message',
  system: 'system/message',
  developer: 'developer/message',
  tool: 'tool/result',
})

/**
 * Map one remote record to our event model `{ seq, type, data, at }`.
 *
 * What is preserved: the role/type, the text, tool-call names with a bounded
 * argument summary, tool results with their `toolCallId` and error flag, and the
 * timestamp. What is dropped: binary attachments, model-internal fields (see
 * `DROPPED_FIELDS`) and non-text content parts.
 *
 * Unknown record types are preserved with a sanitized projection of their payload,
 * so a newer remote schema replays as an opaque event instead of vanishing.
 *
 * @param {unknown} raw
 * @param {number} fallbackSeq 1-based position, used when the record carries no seq
 * @returns {{ event: { seq: number, type: string, data: Record<string, unknown>, at: string | null } | null, droppedParts: number }}
 */
export function mapRemoteRecord(raw, fallbackSeq) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { event: null, droppedParts: 0 }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const explicitSeq = Number(record.seq)
  const seq = Number.isInteger(explicitSeq) && explicitSeq > 0 ? explicitSeq : fallbackSeq
  if (!Number.isInteger(seq) || seq <= 0) return { event: null, droppedParts: 0 }

  const declared = typeof record.type === 'string' ? record.type.trim() : ''
  const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : ''
  const { text, droppedParts } = recordText(record)
  const at = recordTime(record)

  // A declared DSH event type wins; otherwise infer from the role.
  const type = declared !== '' ? declared : (ROLE_TYPES[role] ?? '')

  if (type !== '' && (SURFACE_EVENT_TYPES.includes(type) || role !== '' || text !== '')) {
    /** @type {Record<string, unknown>} */
    const data = {}
    if (text !== '') data.text = text
    if (role !== '') data.role = role
    const toolCallId = record.toolCallId ?? record.tool_call_id ?? record.callId
    if (typeof toolCallId === 'string' && toolCallId !== '') data.toolCallId = toolCallId
    if (typeof record.isError === 'boolean') data.isError = record.isError
    const calls = summarizeToolCalls(record.toolCalls ?? record.tool_calls ?? record.calls)
    if (calls.length > 0) data.toolCalls = calls
    if (Object.keys(data).length === 0) data.text = text
    return { event: { seq, type, data, at }, droppedParts }
  }

  // Unknown type: preserve the payload, minus the never-projected fields. A record
  // with no type, no role and no text is not a session record at all (an index
  // blob, a lock body): drop it rather than replaying an opaque anonymous event.
  if (declared === '') {
    const hasContent = text !== '' || role !== '' || record.toolCalls !== undefined || record.tool_calls !== undefined
    if (!hasContent) return { event: null, droppedParts }
  }
  const type2 = declared !== '' ? declared : 'mirror/unknown'
  return {
    event: { seq, type: type2, data: { record: sanitizeValue(record) }, at },
    droppedParts,
  }
}

/**
 * Bounded summary of tool calls: the name, the call id and a short argument
 * preview. Full arguments can carry secrets and are not needed for replay.
 * @param {unknown} value
 * @returns {{ name: string, id: string | null, argumentsPreview: string }[]}
 */
function summarizeToolCalls(value) {
  if (!Array.isArray(value)) return []
  /** @type {{ name: string, id: string | null, argumentsPreview: string }[]} */
  const out = []
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== 'object') continue
    const call = /** @type {Record<string, unknown>} */ (entry)
    const name = typeof call.name === 'string' ? call.name : ''
    const id = typeof call.id === 'string' ? call.id : null
    const args = call.arguments ?? call.args ?? call.input
    let preview = ''
    if (typeof args === 'string') preview = args
    else if (args !== undefined) {
      try {
        preview = JSON.stringify(sanitizeValue(args))
      } catch {
        preview = ''
      }
    }
    if (preview.length > 200) preview = `${preview.slice(0, 200)}…`
    if (name === '' && preview === '') continue
    out.push({ name, id, argumentsPreview: preview })
  }
  return out
}

/**
 * Map a whole log to events, dropping unusable records and de-duplicating by seq
 * (first occurrence wins, matching `applyEvents`).
 * @param {unknown[]} records
 * @returns {{ events: { seq: number, type: string, data: Record<string, unknown>, at: string | null }[], droppedRecords: number, droppedParts: number }}
 */
export function mapRemoteRecords(records) {
  const list = Array.isArray(records) ? records : []
  /** @type {{ seq: number, type: string, data: Record<string, unknown>, at: string | null }[]} */
  const events = []
  const seen = new Set()
  let droppedRecords = 0
  let droppedParts = 0
  for (let index = 0; index < list.length; index += 1) {
    const { event, droppedParts: parts } = mapRemoteRecord(list[index], index + 1)
    if (!event) {
      droppedRecords += 1
      continue
    }
    if (seen.has(event.seq)) {
      droppedRecords += 1
      continue
    }
    seen.add(event.seq)
    droppedParts += parts
    events.push(event)
  }
  events.sort((left, right) => left.seq - right.seq)
  return { events, droppedRecords, droppedParts }
}

/**
 * Keep only the newest `maxEvents` events.
 *
 * Retention is "newest N", not "head + tail": a mirror is read top-down and the
 * most recent turns are what a user opens a session for, while a folded middle
 * would produce a session whose cursor says "complete" but whose text has a hole
 * in the middle. The fold is therefore always a **prefix**: the events before the
 * window are reported as `folded`, the caller announces them with one notice event
 * and moves the cursor to the window, so the projection stays gap-free.
 * @param {{ seq: number }[]} events
 * @param {number} maxEvents `0` or a negative value means unlimited
 * @returns {{ events: any[], folded: number }}
 */
export function retainEvents(events, maxEvents) {
  const list = Array.isArray(events) ? events.slice() : []
  const limit = Number.isFinite(maxEvents) ? Math.floor(Number(maxEvents)) : 0
  if (limit <= 0 || list.length <= limit) return { events: list, folded: 0 }
  const kept = list.slice(list.length - limit)
  return { events: kept, folded: list.length - kept.length }
}

/**
 * The seq range a fold notice should announce.
 *
 * The retained window is the **tail**, so the folded prefix is not `1..folded`
 * whenever the fetch itself already dropped records: `fetchRemoteHistory` keeps only
 * the newest `HISTORY_LIMITS.maxEvents`, and `mirrorMaxEvents` then keeps the newest
 * `N` of those. The honest range therefore runs from the first retained seq minus the
 * folded count, up to just before the first retained seq.
 *
 * @param {{ firstKeptSeq?: number, folded?: number }} input
 * @returns {{ from: number, to: number, folded: number }}
 */
export function foldNoticeRange(input) {
  const folded = Number.isFinite(Number(input?.folded)) ? Math.max(0, Math.floor(Number(input.folded))) : 0
  const firstKept = Number.isFinite(Number(input?.firstKeptSeq)) ? Math.floor(Number(input.firstKeptSeq)) : 1
  if (folded === 0) return { from: 0, to: 0, folded: 0 }
  const to = Math.max(0, firstKept - 1)
  const from = Math.max(1, firstKept - folded)
  return { from, to, folded }
}

/**
 * The cursor a descriptor keeps after a **failed** re-pull.
 *
 * §6 says the recovery "resets the cursor", but the *plan* it produces is computed from
 * 0, so for a log that does not start at seq 1 it can resolve below what the descriptor
 * already applied (the reviewer measured 5 → 0 while events 1..5 were still in the
 * session). The cursor is therefore kept **monotonic**: a recovery that cannot make the
 * log contiguous never rewrites the descriptor to claim fewer events were applied.
 *
 * @param {unknown} current the descriptor's cursor before the recovery
 * @param {unknown} planned the cursor the recovery plan resolved to
 * @returns {number}
 */
export function recoveredCursor(current, planned) {
  const before = Number.isInteger(Number(current)) && Number(current) > 0 ? Number(current) : 0
  const after = Number.isInteger(Number(planned)) && Number(planned) > 0 ? Number(planned) : 0
  return Math.max(before, after)
}

/**
 * Read one remote session's history over SSH.
 *
 * Three bounded commands, each of which can fail into a typed reason:
 * probe the directory, discover the file, read it. Nothing here throws: an SSH
 * error becomes `read-failed`, a missing layout becomes `no-session-log`, and an
 * over-size or unparseable file becomes `log-truncated` / `log-malformed`. The
 * caller keeps the mirror and retries on the next sync.
 *
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string, timedOut?: boolean }> }} ssh
 * @param {{ remoteDshHome: string, remoteSessionId: string, maxBytes?: number, maxEvents?: number, timeoutMs?: number }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   reason: HistoryFailure | null,
 *   file: string | null,
 *   version: number | null,
 *   events: { seq: number, type: string, data: Record<string, unknown>, at: string | null }[],
 *   total: number,
 *   droppedRecords: number,
 *   droppedParts: number,
 *   truncated: boolean,
 *   bytes: number,
 * }>}
 */
export async function fetchRemoteHistory(ssh, input) {
  const empty = {
    ok: false,
    reason: /** @type {HistoryFailure | null} */ (null),
    file: null,
    version: null,
    events: [],
    total: 0,
    droppedRecords: 0,
    droppedParts: 0,
    truncated: false,
    bytes: 0,
  }
  const root = remoteSessionsRoot(input?.remoteDshHome)
  if (root === '/sessions' || String(input?.remoteDshHome ?? '').trim() === '') {
    // No remote DSH_HOME: we cannot name a path, so this is a missing layout.
    return { ...empty, reason: 'sessions-dir-missing' }
  }
  if (!ssh || typeof ssh.exec !== 'function') return { ...empty, reason: 'read-failed' }
  const timeoutMs = input?.timeoutMs ?? HISTORY_LIMITS.timeoutMs
  const maxBytes = input?.maxBytes ?? HISTORY_LIMITS.maxBytes

  try {
    const probe = await ssh.exec(buildDirProbeCommand(root), { timeoutMs })
    if (String(probe?.stdout ?? '').trim() !== 'yes') {
      return { ...empty, reason: 'sessions-dir-missing' }
    }

    const listing = await ssh.exec(buildDiscoveryCommand(root, input.remoteSessionId), { timeoutMs })
    const file = pickLogFile(listing?.stdout ?? '')
    if (file === null) return { ...empty, reason: 'no-session-log' }

    const read = await ssh.exec(buildReadCommand(file, maxBytes), { timeoutMs, maxBytes })
    const failure = classifyReadFailure(read ?? {})
    if (failure !== null) return { ...empty, file, reason: failure }
    const text = String(read?.stdout ?? '')
    if (text.trim() === '') return { ...empty, file, reason: 'no-session-log' }

    // `head -c maxBytes + 1` was requested, so a length strictly greater than the cap
    // means there IS more data. Comparing `>=` would mark a complete log that is
    // exactly at the cap as permanently truncated.
    const bytes = Buffer.byteLength(text, 'utf8')
    const truncated = bytes > maxBytes || read?.timedOut === true
    if (truncated) return { ...empty, file, reason: 'log-truncated', truncated: true, bytes: maxBytes }

    const parsed = parseRemoteSessionLog(text)
    if (!parsed.ok) return { ...empty, file, reason: parsed.reason, version: parsed.version }

    const maxEvents = input?.maxEvents ?? HISTORY_LIMITS.maxEvents
    const capped = parsed.records.length > maxEvents ? parsed.records.slice(-maxEvents) : parsed.records
    const mapped = mapRemoteRecords(capped)
    return {
      ok: mapped.events.length > 0,
      reason: mapped.events.length > 0 ? null : 'log-malformed',
      file,
      version: parsed.version,
      events: mapped.events,
      total: mapped.events.length,
      droppedRecords: mapped.droppedRecords + (parsed.records.length - capped.length),
      droppedParts: mapped.droppedParts,
      truncated: parsed.records.length > maxEvents,
      bytes: Buffer.byteLength(text, 'utf8'),
    }
  } catch (error) {
    // A closed connection, a timeout or a protocol error: keep the mirror.
    return {
      ...empty,
      reason: /permission denied/i.test(String(error?.message ?? '')) ? 'permission-denied' : 'read-failed',
    }
  }
}

// --------------------------------------------------------------- window planning

/**
 * Plan the projection of one remote event window onto a descriptor cursor
 * (design §6). Pure: the caller owns I/O and persistence.
 *
 * Rules, in order:
 * 1. only `seq > cursor` is considered, so re-planning the same log is a no-op;
 * 2. the first sync folds the **prefix** when the log exceeds `maxEvents`
 *    (`foldBeforeCursor`): the window starts at `window[0].seq - 1`, so the
 *    projection is contiguous from the window's point of view and the cursor
 *    lands on the newest applied event without inventing a gap;
 * 3. later syncs never fold: an overflow is reported as a gap so continuity is
 *    never silently dropped;
 * 4. a gap (`backfill`) stops the cursor at the contiguous prefix and asks the
 *    caller for a bounded backfill of `[from, to]`.
 *
 * @param {{ cursor?: unknown, events?: unknown, maxEvents?: unknown, foldBeforeCursor?: unknown }} input
 * @returns {{
 *   append: any[],
 *   cursor: number,
 *   applied: number,
 *   backfill: { from: number, to: number } | null,
 *   folded: number,
 *   gap: boolean,
 *   total: number,
 * }}
 */
export function planHistoryWindow(input) {
  const cursor = Number.isInteger(input?.cursor) && Number(input.cursor) > 0 ? Number(input.cursor) : 0
  const all = Array.isArray(input?.events) ? input.events : []
  const limit = Number.isFinite(Number(input?.maxEvents)) ? Math.floor(Number(input?.maxEvents)) : 0

  const fresh = all.filter((event) => Number.isInteger(event?.seq) && event.seq > cursor)
  let windowed = fresh
  let folded = 0
  if (limit > 0 && fresh.length > limit && input?.foldBeforeCursor === true) {
    windowed = fresh.slice(fresh.length - limit)
    folded = fresh.length - windowed.length
  }
  const startCursor = folded > 0 ? (windowed[0]?.seq ?? cursor) - 1 : cursor
  // Seed `events: []` so `applyEvents` returns the applied window; with no `events`
  // key it only advances the cursor and reports the count.
  const applied = applyEvents({ cursor: startCursor, events: [] }, windowed)
  return {
    append: applied.state.events ?? [],
    cursor: applied.state.cursor,
    applied: applied.applied,
    backfill: applied.backfill,
    folded,
    gap: applied.backfill !== null,
    total: fresh.length,
  }
}

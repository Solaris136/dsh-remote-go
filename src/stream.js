/**
 * The live event stream, phase 1 of L3 (design §6.3).
 *
 * ## What this actually is
 *
 * The design wants one channel (`ws-mux`) carrying both lease operations and session events.
 * **This is not a mux.** The plugin's transport is request/response `ssh.exec`, so a
 * `tail -f`-style connection would just block until timeout and return nothing. What is
 * implemented instead is a **polled follow over SSH `exec`**: a long-lived channel object owns
 * a byte offset into the remote session log and re-invokes a small script on the remote that
 * emits whatever is new since that offset.
 *
 * The honest properties:
 * - **latency** ≈ the poll interval (`STREAM_LIMITS.pollMs`, default 1 s), not "instant";
 * - **ordering** is the log's order — frames are byte-offset delimited, and ingest reuses
 *   `applyEvents`, which sorts and de-duplicates by `seq`, so a partial or repeated frame
 *   cannot reorder the projection;
 * - **at-least-once** delivery with idempotent application: a frame may be re-delivered (the
 *   poller resumes from the last byte offset it committed), and `seq > cursor` plus
 *   `data.mirrorSeq` make that a no-op;
 * - **bounded**: one frame is capped by `maxBytes`, and the in-memory buffer is capped with a
 *   drop-oldest policy that reports a gap rather than growing.
 *
 * ## The enforcement point
 *
 * §11 #12 recorded that remote-side epoch rejection lived only in the simulator. The script
 * this module installs on the remote performs that check **for real**: it reads the authority
 * record and refuses to emit a frame when the caller's `epoch` is stale, so the refusal happens
 * on the remote side of the boundary. See `docs/session-design.md` §6.3 for exactly which
 * checks are enforced by shipped code and which remain modelled.
 *
 * @module
 */

import { applyEvents } from './mirror.js'
import { planHistoryWindow } from './history.js'

/** Bounds and cadence for the stream. */
export const STREAM_LIMITS = Object.freeze({
  /** How often the channel re-invokes the remote script when nothing new arrived. */
  pollMs: 1_000,
  /** Bytes per frame; a log that outgrew this in one poll interval is reported as a gap. */
  maxBytes: 256 * 1024,
  /** Events per frame; the tail is kept and the rest reported (same policy as L2). */
  maxEvents: 500,
  /** Frames buffered before the oldest is dropped and a gap is reported. */
  maxBuffered: 64,
  /** Per-invocation timeout for one poll. */
  timeoutMs: 20_000,
})

/** Typed stream failures (§7): keep the mirror, do not advance the cursor, annotate. */
export const STREAM_FAILURES = Object.freeze([
  'ssh-unavailable',
  'read-failed',
  'no-session-log',
  'log-malformed',
  'stream-fenced',
  'stream-truncated',
  'stream-backpressure',
])

/**
 * Where the remote helper script lives.
 * @param {string} remoteDshHome absolute POSIX path
 * @returns {string}
 */
export function remoteStreamScript(remoteDshHome) {
  const home = String(remoteDshHome ?? '').replace(/\/+$/, '')
  return `${home}/remote-go/follow.mjs`
}

/**
 * Quote a value for a POSIX shell.
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * The remote helper's source.
 *
 * Runs under the remote's own `node` (the probe already reports one) and uses only `node:fs`.
 * It is deliberately tiny: read the authority, refuse a stale epoch, then emit the log slice
 * after `offset` as newline-delimited JSON events. Any failure is one typed JSON line, never a
 * stack trace — the caller classifies it.
 *
 * `stdout` is the protocol; nothing else may be written to it.
 * @returns {string}
 */
export function remoteStreamScriptSource() {
  return [
    "import { readFileSync } from 'node:fs'",
    'const args = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8"))',
    '/** One typed line and exit; stdout is the protocol. */',
    'function emit(payload) {',
    '  process.stdout.write(JSON.stringify(payload) + "\\n")',
    '  process.exit(0)',
    '}',
    'let lease = null',
    'try {',
    '  lease = JSON.parse(readFileSync(args.leasePath, "utf8"))',
    '} catch {',
    '  lease = null',
    '}',
    '// The enforcement half: a stale caller never receives a frame. This runs on the remote side',
    '// of the boundary, so a partitioned writer that skipped its own local check still gets refused.',
    'if (lease !== null && Number(lease.expiresAt) > Date.now()) {',
    '  const ours = Number(args.epoch)',
    '  const theirs = Number(lease.epoch)',
    '  if (Number.isFinite(theirs) && ours < theirs) {',
    '    emit({ ok: false, reason: "stale-epoch", remoteEpoch: theirs })',
    '  }',
    '}',
    'let body',
    'try {',
    '  body = readFileSync(args.logPath)',
    '} catch {',
    '  emit({ ok: false, reason: "no-session-log" })',
    '}',
    'const from = Math.min(Math.max(0, Number(args.offset) || 0), body.length)',
    'const slice = body.subarray(from, from + Math.max(1, Number(args.maxBytes) || 65536))',
    'const text = slice.toString("utf8")',
    '// Only complete lines are consumed: a half-written record must not reach the parser.',
    'const cut = text.lastIndexOf("\\n")',
    'const usable = cut < 0 ? "" : text.slice(0, cut + 1)',
    'const nextOffset = from + Buffer.byteLength(usable, "utf8")',
    'const events = []',
    'for (const line of usable.split("\\n")) {',
    '  const trimmed = line.trim()',
    '  if (trimmed === "") continue',
    '  let record',
    '  try {',
    '    record = JSON.parse(trimmed)',
    '  } catch {',
    '    emit({ ok: false, reason: "log-malformed" })',
    '  }',
    '  events.push(record)',
    '}',
    'emit({',
    '  ok: true,',
    '  offset: nextOffset,',
    '  bytes: body.length,',
    '  events,',
    '  // A frame that filled its byte budget has more waiting: the caller reports a gap if it',
    '  // cannot keep up rather than pretending it saw everything.',
    '  truncated: slice.length >= Number(args.maxBytes),',
    '})',
  ].join('\n')
}

/**
 * The command that installs the helper on the remote.
 *
 * Base64 in one quoted word (same rule as the authority record), written to a sibling temp file
 * and renamed, so a reader never sees a half-written script.
 * @param {string} scriptPath
 * @returns {string}
 */
export function buildInstallStreamScriptCommand(scriptPath) {
  const payload = Buffer.from(remoteStreamScriptSource(), 'utf8').toString('base64')
  const dir = scriptPath.slice(0, scriptPath.lastIndexOf('/')) || '/'
  const temp = `${scriptPath}.tmp`
  return (
    `mkdir -p ${quote(dir)} 2>/dev/null; ` +
    `printf '%s' ${quote(payload)} | (base64 -d 2>/dev/null || base64 -D 2>/dev/null) > ${quote(temp)} && ` +
    `mv ${quote(temp)} ${quote(scriptPath)}`
  )
}

/**
 * The command that follows the log once.
 * @param {string} scriptPath
 * @param {{ logPath: string, leasePath: string, offset: number, epoch: number, maxBytes?: number }} input
 * @returns {string}
 */
export function buildFollowCommand(scriptPath, input) {
  const args = Buffer.from(
    JSON.stringify({
      logPath: String(input.logPath),
      leasePath: String(input.leasePath),
      offset: Math.max(0, Math.floor(Number(input.offset) || 0)),
      epoch: Math.max(0, Math.floor(Number(input.epoch) || 0)),
      maxBytes: Math.max(1, Math.floor(Number(input.maxBytes ?? STREAM_LIMITS.maxBytes))),
    }),
    'utf8',
  ).toString('base64')
  return `node ${quote(scriptPath)} ${quote(args)}`
}

/**
 * Parse one frame the helper printed.
 *
 * Tolerant by design: a remote that printed a stack trace or an unexpected shape is
 * `log-malformed`, not an exception.
 * @param {string} text
 * @returns {{ ok: true, offset: number, events: any[], truncated: boolean, bytes: number }
 *   | { ok: false, reason: string, remoteEpoch?: number }}
 */
export function parseFollowFrame(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: 'read-failed' }
  // The helper prints exactly one line; tolerate leading noise from a login shell.
  const line = raw.split('\n').find((entry) => entry.trim().startsWith('{')) ?? ''
  if (line === '') return { ok: false, reason: 'log-malformed' }
  /** @type {any} */
  let parsed = null
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'log-malformed' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'log-malformed' }
  if (parsed.ok !== true) {
    const reason =
      parsed.reason === 'stale-epoch'
        ? 'stream-fenced'
        : STREAM_FAILURES.includes(String(parsed.reason))
          ? String(parsed.reason)
          : 'log-malformed'
    return { ok: false, reason, remoteEpoch: Number.isInteger(parsed.remoteEpoch) ? parsed.remoteEpoch : undefined }
  }
  const offset = Number(parsed.offset)
  if (!Number.isFinite(offset) || offset < 0) return { ok: false, reason: 'log-malformed' }
  const events = Array.isArray(parsed.events) ? parsed.events : []
  return {
    ok: true,
    offset: Math.floor(offset),
    events,
    truncated: parsed.truncated === true,
    bytes: Number.isFinite(Number(parsed.bytes)) ? Math.floor(Number(parsed.bytes)) : 0,
  }
}

/**
 * A bounded buffer of pending frames.
 *
 * A slow consumer must not grow memory: pushing past the cap **drops the oldest** frame and
 * records that a gap occurred, which the caller surfaces as the existing typed gap rather than
 * as silence. "Drop oldest" is the right choice here because the newest events are the ones the
 * mirror is being watched for, and the dropped range is reported precisely.
 */
export class FrameBuffer {
  /** @param {number} [cap] */
  constructor(cap = STREAM_LIMITS.maxBuffered) {
    this.cap = Math.max(1, Math.floor(Number(cap) || STREAM_LIMITS.maxBuffered))
    /** @type {{ offset: number, events: any[] }[]} */
    this.frames = []
    /** Frames dropped since the last drain, and the event mass they carried. */
    this.dropped = 0
    this.droppedEvents = 0
  }

  /** @param {{ offset: number, events: any[] }} frame */
  push(frame) {
    this.frames.push(frame)
    while (this.frames.length > this.cap) {
      const lost = this.frames.shift()
      this.dropped += 1
      this.droppedEvents += Array.isArray(lost?.events) ? lost.events.length : 0
    }
    return this.frames.length
  }

  /** Take everything buffered, resetting the drop counters. */
  drain() {
    const frames = this.frames
    const report = { frames, dropped: this.dropped, droppedEvents: this.droppedEvents }
    this.frames = []
    this.dropped = 0
    this.droppedEvents = 0
    return report
  }

  get size() {
    return this.frames.length
  }
}

/**
 * Apply one batch of streamed records through the **existing** pipeline.
 *
 * This is deliberately the same code the L2 log read uses (`planHistoryWindow` →
 * `applyEvents`), so a streamed record and the same record fetched by a log read produce
 * identical state. There is no second merge path to drift.
 *
 * @param {{ cursor: number, events?: any[], conflicts?: any[], conflictCount?: number }} state
 * @param {any[]} events
 * @param {{ maxEvents?: number }} [options]
 * @returns {ReturnType<typeof planHistoryWindow>}
 */
export function ingestStreamEvents(state, events, options = {}) {
  return planHistoryWindow({
    cursor: Number.isInteger(state?.cursor) ? state.cursor : 0,
    events: Array.isArray(events) ? events : [],
    // No folding on the stream path: these are new events, not a re-read of history, so there is
    // no prefix to fold and `mirrorMaxEvents` retention is the history window's business.
    maxEvents: Number(options.maxEvents ?? 0),
    foldBeforeCursor: false,
  })
}

/**
 * Merge several frames into one batch in log order.
 *
 * Frames may arrive with overlapping or out-of-order records (a retried poll re-sends from an
 * earlier offset); `applyEvents` normalises that, so this only has to be a stable concatenation.
 * @param {{ events: any[] }[]} frames
 * @returns {any[]}
 */
export function mergeFrames(frames) {
  /** @type {any[]} */
  const out = []
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!frame || !Array.isArray(frame.events)) continue
    for (const event of frame.events) out.push(event)
  }
  return out
}

/**
 * Whether a host may stream at all.
 *
 * Read-only stays read-only (§7): a fenced host, a version-mismatched host and a host whose
 * history channel is unavailable all keep their history and must not stream or advance a cursor.
 * @param {{ level?: string, reason?: { code?: string } | null, readOnly?: boolean, writable?: boolean }} descriptor
 * @returns {{ ok: boolean, reason?: string }}
 */
export function streamAllowed(descriptor) {
  const code = descriptor?.reason?.code ?? null
  if (code === 'fenced' || code === 'version-mismatch' || code === 'version-unknown') {
    return { ok: false, reason: code }
  }
  if (descriptor?.writable === false) return { ok: false, reason: 'fenced' }
  return { ok: true }
}

/**
 * Advance a stream cursor without ever going backwards.
 *
 * A frame may be re-delivered from an earlier offset; the committed offset must be monotonic or
 * a reconnect would re-read and re-append events the mirror already has.
 * @param {number} committed
 * @param {number} candidate
 * @returns {number}
 */
export function nextStreamOffset(committed, candidate) {
  const before = Number.isFinite(Number(committed)) ? Math.max(0, Math.floor(Number(committed))) : 0
  const after = Number.isFinite(Number(candidate)) ? Math.max(0, Math.floor(Number(candidate))) : 0
  return Math.max(before, after)
}

/**
 * Classify a failed poll into the typed reasons the descriptor already carries.
 * @param {{ code: number | null, stdout: string, stderr: string, timedOut?: boolean }} result
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyFollowFailure(result) {
  const output = `${String(result?.stderr ?? '')}\n${String(result?.stdout ?? '')}`
  if (result?.timedOut === true) return { ok: false, reason: 'read-failed' }
  if (/permission denied/i.test(output)) return { ok: false, reason: 'read-failed' }
  if (/no such file/i.test(output)) return { ok: false, reason: 'no-session-log' }
  if (result?.code === 0) return { ok: true }
  return { ok: false, reason: 'read-failed' }
}

/**
 * Nothing here applies events to a session; that stays in the service so the append guard
 * (`data.mirrorSeq`) is shared with the log path. Exported for the equivalence test.
 */
export { applyEvents }

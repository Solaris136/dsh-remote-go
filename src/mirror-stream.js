/**
 * The polled event follower (design §6.4).
 *
 * **What this is, precisely.** The plugin's transport is request/response `ssh.exec`, so a
 * `tail -f`-style connection would block until timeout and return nothing. This is a **polled
 * follow**: a per-host timer re-invokes a small helper on the remote that emits the log slice
 * after a byte offset. Honest properties: latency ≈ `pollMs`, log ordering, at-least-once
 * delivery made idempotent by `seq > cursor` + `data.mirrorSeq`, one bounded frame, bounded memory.
 *
 * **Where state lives (§6.4 (a) of the retry design note).**
 * - `cursor` is the **only durable truth**: it lives in the descriptor and is written exclusively
 *   through `withMirrorWriter`.
 * - `offset` is an **ephemeral per-session runtime optimisation**, never persisted. Two persisted
 *   numbers that must agree is a drift bug, and the cursor already answers "what is applied".
 *
 * **The asymmetric rule.** The offset advances only after the descriptor write resolves *and* the
 * persisted cursor actually advanced. Offset-behind-cursor merely re-reads applied bytes, which
 * `seq > cursor` makes a no-op; offset-ahead-of-cursor would skip never-applied events, which is
 * permanent data loss. So the offset never advances early.
 *
 * @module
 */

import { applyEvents } from './mirror.js'
import { planHistoryWindow } from './history.js'

/** Bounds and cadence. */
export const STREAM_LIMITS = Object.freeze({
  /** How often the follower re-invokes the remote helper. Latency ≈ this value. */
  pollMs: 1_000,
  /** Bytes per frame. A log that outgrew this within one interval is reported as a gap. */
  maxBytes: 256 * 1024,
  /** Records per frame; the tail is kept and the remainder reported (same policy as L2). */
  maxEvents: 500,
  /** Frames buffered before the oldest is dropped and a gap reported. */
  maxBuffered: 64,
  /** Per-invocation timeout for one poll. */
  timeoutMs: 20_000,
})

/**
 * Where the remote helper lives. Installed lazily, once, after the probe has reported a home
 * (see `#ensureStreamHelper` — installing at connect time was the previous attempt's silent
 * failure: `runtime.facts` was not populated yet, the helper path stayed `undefined`, and the
 * start guard bailed without saying why).
 * @param {string} remoteDshHome absolute POSIX path
 * @returns {string}
 */
export function remoteStreamScript(remoteDshHome) {
  const home = String(remoteDshHome ?? '').replace(/\/+$/, '')
  return `${home}/remote-go/follow.mjs`
}

/** @param {string} value @returns {string} */
function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * The remote helper's source: `node:fs` only, so it runs on an unmodified remote.
 *
 * It reads the authority record and **refuses to emit a frame when the caller's epoch is stale** —
 * the enforcement happens on the far side of the boundary, not in the plugin. Every failure is one
 * typed JSON line on stdout; it never prints a stack trace, because stdout is the protocol.
 * @returns {string}
 */
export function remoteStreamScriptSource() {
  return [
    "import { readFileSync } from 'node:fs'",
    'const args = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8"))',
    'function emit(payload) {',
    '  process.stdout.write(JSON.stringify(payload) + "\\n")',
    '  process.exit(0)',
    '}',
    'function readLease(p) {',
    '  let out = null',
    '  let failed = false',
    '  try {',
    '    out = JSON.parse(readFileSync(p, "utf8"))',
    '  } catch {',
    '    failed = true',
    '  }',
    '  return failed ? null : out',
    '}',
    'const lease = readLease(args.leasePath)',
    'if (lease !== null && Number(lease.expiresAt) > Date.now()) {',
    '  const ours = Number(args.epoch)',
    '  const theirs = Number(lease.epoch)',
    '  if (Number.isFinite(theirs) && ours < theirs) emit({ ok: false, reason: "stale-epoch", remoteEpoch: theirs })',
    '}',
    'function readBody(p) {',
    '  let out = null',
    '  let failed = false',
    '  try {',
    '    out = readFileSync(p)',
    '  } catch {',
    '    failed = true',
    '  }',
    '  return failed ? null : out',
    '}',
    'const body = readBody(args.logPath)',
    'if (body === null) emit({ ok: false, reason: "no-session-log" })',
    'const from = Math.min(Math.max(0, Number(args.offset) || 0), body.length)',
    'const slice = body.subarray(from, from + Math.max(1, Number(args.maxBytes) || 65536))',
    'const text = slice.toString("utf8")',
    'const cut = text.lastIndexOf("\\n")',
    'const usable = cut < 0 ? "" : text.slice(0, cut + 1)',
    'const nextOffset = from + Buffer.byteLength(usable, "utf8")',
    'const events = []',
    'for (const line of usable.split("\\n")) {',
    '  const trimmed = line.trim()',
    '  if (trimmed === "") continue',
    '  let record = null',
    '  let bad = false',
    '  try {',
    '    record = JSON.parse(trimmed)',
    '  } catch {',
    '    bad = true',
    '  }',
    '  if (bad) emit({ ok: false, reason: "log-malformed" })',
    '  events.push(record)',
    '}',
    'emit({',
    '  ok: true,',
    '  offset: nextOffset,',
    '  bytes: body.length,',
    '  events,',
    '  truncated: slice.length >= Number(args.maxBytes),',
    '})',
  ].join('\n')
}

/**
 * Install the helper: base64 payload, sibling temp file, rename (atomic, same rule as the
 * authority record).
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
 * Follow the log once. Arguments travel base64-encoded inside one quoted word.
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
 * Parse one frame. Tolerant: an unexpected shape is `log-malformed`, never an exception.
 * @param {string} text
 * @returns {{ ok: true, offset: number, events: any[], truncated: boolean, bytes: number }
 *   | { ok: false, reason: string, remoteEpoch?: number }}
 */
export function parseFrame(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: 'no-session-log' }
  const line = raw.split('\n').find((entry) => entry.trim().startsWith('{')) ?? ''
  if (line === '') return { ok: false, reason: 'log-malformed' }
  /** @type {any} */
  let parsed = null
  let parseFailed = false
  try {
    parsed = JSON.parse(line)
  } catch {
    // No typed reason here on purpose: the assignment below is explicit control flow, so an
    // unexpected throw cannot masquerade as a legitimate `log-malformed` (the PR #24 lesson).
    parseFailed = true
  }
  if (parseFailed === true) return { ok: false, reason: 'log-malformed' }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'log-malformed' }
  if (parsed.ok !== true) {
    // A remote refusal reuses the existing typed vocabulary: `stale-epoch` is our `fenced`.
    if (parsed.reason === 'stale-epoch') {
      return { ok: false, reason: 'fenced', remoteEpoch: Number(parsed.remoteEpoch) || undefined }
    }
    if (parsed.reason === 'no-session-log' || parsed.reason === 'log-malformed') {
      return { ok: false, reason: String(parsed.reason) }
    }
    return { ok: false, reason: 'log-malformed' }
  }
  const offset = Number(parsed.offset)
  if (!Number.isFinite(offset) || offset < 0) return { ok: false, reason: 'log-malformed' }
  return {
    ok: true,
    offset: Math.floor(offset),
    events: Array.isArray(parsed.events) ? parsed.events : [],
    truncated: parsed.truncated === true,
    bytes: Number.isFinite(Number(parsed.bytes)) ? Math.floor(Number(parsed.bytes)) : 0,
  }
}

/**
 * A bounded buffer of pending frames.
 *
 * A slow consumer must not grow memory. Pushing past the cap **drops the oldest** and counts it,
 * because the newest events are what a watcher is looking at and the dropped range is then
 * reported precisely rather than silently lost.
 */
export class FrameBuffer {
  /** @param {number} [cap] */
  constructor(cap = STREAM_LIMITS.maxBuffered) {
    this.cap = Math.max(1, Math.floor(Number(cap) || STREAM_LIMITS.maxBuffered))
    /** @type {{ offset: number, events: any[] }[]} */
    this.frames = []
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

  drain() {
    const report = { frames: this.frames, dropped: this.dropped, droppedEvents: this.droppedEvents }
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
 * Apply streamed records through the **existing** pipeline.
 *
 * Same `planHistoryWindow` → `applyEvents` path the L2 log read uses, so a streamed record and the
 * same record fetched by a log read produce identical state. There is no second merge path.
 * @param {{ cursor: number }} state
 * @param {any[]} events
 * @param {{ maxEvents?: number }} [options]
 */
export function ingestStreamEvents(state, events, options = {}) {
  return planHistoryWindow({
    cursor: Number.isInteger(state?.cursor) ? state.cursor : 0,
    events: Array.isArray(events) ? events : [],
    // No folding on the stream path: these are new events, not a re-read of history.
    maxEvents: Number(options.maxEvents ?? 0),
    foldBeforeCursor: false,
  })
}

/**
 * The monotonic offset rule: a re-delivered frame must never move it backwards.
 * @param {number} committed @param {number} candidate
 * @returns {number}
 */
export function nextOffset(committed, candidate) {
  const before = Number.isFinite(Number(committed)) ? Math.max(0, Math.floor(Number(committed))) : 0
  const after = Number.isFinite(Number(candidate)) ? Math.max(0, Math.floor(Number(candidate))) : 0
  return Math.max(before, after)
}

/**
 * Whether a host may stream at all. Reuses the **existing** typed reasons — no parallel set.
 * @param {{ reason?: { code?: string } | null, writable?: boolean, level?: string }} descriptor
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
 * Why the follower may not run for this host.
 *
 * Returns the **name of the condition that fired** rather than a bare boolean: the previous
 * attempt returned early and silently, and there was no way to tell "setting off" from "helper
 * missing" without guessing. `ok: false` always carries a reason string that goes into the log and
 * into the poll trace.
 * @param {{ runtime: any, settings: any, hasAdapter: boolean }} input
 * @returns {{ ok: true } | { ok: false, guard: string }}
 */
export function streamGuard(input) {
  const { runtime, settings, hasAdapter } = input
  if (settings?.mirrorStream !== true) return { ok: false, guard: 'setting-off' }
  if (settings?.mirrorHistory === false) return { ok: false, guard: 'history-off' }
  if (hasAdapter !== true) return { ok: false, guard: 'no-session-adapter' }
  if (runtime?.closing === true) return { ok: false, guard: 'host-closing' }
  if (runtime?.ssh?.connected !== true) return { ok: false, guard: 'ssh-down' }
  return { ok: true }
}

export { applyEvents }

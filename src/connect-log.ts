/**
 * The connect log behind `HostView.logs`: the per-host ring, the per-connection reset, the structured failure lines, its bounded `/state` tail and which statuses print it.
 */
import { redactText } from './redact.js'
import { headTail, isPlainObject } from './util.js'
import type { BilingualText } from './util.js'

export const CONNECT_LOG_STATUSES = Object.freeze(['connecting', 'fingerprint-pending', 'error'])

/** One line of the per-host ring. */
export interface ConnectLogEntry {
  seq: number
  at: string
  level: string
  phase: string | null
  message: string
  line: string
  text?: BilingualText
  boundary?: boolean
}

/** What a caller may append: only `message` is required. */
export interface ConnectLogInput {
  message: unknown
  at?: string
  level?: string
  phase?: string | null
  text?: unknown
  boundary?: boolean
}

/** The mutable per-host log state this module owns; `host-runtime.ts` embeds it. */
export interface ConnectLogRuntime {
  id: string
  status?: string
  logs: ConnectLogEntry[]
  logSeq: number
  connectCount: number
}

/** One entry as it travels to the Client: the internal `line` is not part of the view. */
export interface ConnectLogTailItem {
  seq: number
  at: string
  level: string
  phase: string | null
  message: string
  text?: BilingualText
  boundary?: boolean
}

/** The `ErrorView` fields a failure line is built from. */
export interface ConnectFailureView {
  code?: string
  title?: unknown
  detail?: unknown
  nextSteps?: unknown[]
  technical?: string
}

export interface ConnectFailureOptions {
  phase?: string | null
  label?: BilingualText | null
}

/** One structured line for a failed connection. */
export interface ConnectFailureLine {
  level: string
  phase: string | null
  message: string
  text?: BilingualText
}

export const LOG_RING_LIMIT = 200

export const LOG_TAIL_LIMIT = 120

/** How much of one technical detail (redacted) the log prints before `headTail` elides it. */
export const LOG_TECHNICAL_LIMIT = 1200

/** How long a single remote-log / technical line may get before it is elided. */
export const LOG_LINE_LIMIT = 400

/** Cap on the remote-log lines a failed start prints, so a chatty tail cannot eat the ring. */
export const LOG_TAIL_LINES = 60

export function connectLogVisible(status: string | null | undefined): boolean {
  return typeof status === 'string' && CONNECT_LOG_STATUSES.includes(status)
}

/** A bilingual line: zh and en side by side, the shape the Client already resolves. */
function pair(zh: string, en: string): BilingualText {
  return { zh, en }
}

/** Accept only a complete { zh, en } pair; a half-resolved object would render as an empty line. */
function normalizeText(value: unknown): BilingualText | null {
  if (!isPlainObject(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh : ''
  const en = typeof value.en === 'string' ? value.en : ''
  if (zh === '' || en === '') return null
  return pair(zh, en)
}

export function appendConnectLog(runtime: ConnectLogRuntime, input: ConnectLogInput): ConnectLogEntry {
  const raw = typeof input.message === 'string' ? input.message : String(input.message ?? '')
  // The remote's own stdout arrives here (`remote-web/start.js` hands every start line to `onLine`,
  // and the first one is the launch URL with its session token). This ring is the second exit of
  // that text — `HostView.logs`, the SSE state frames and the diagnostics export all read it — so
  // it is redacted at write time, not only when the failure view is built.
  const message = headTail(redactText(raw), LOG_TECHNICAL_LIMIT)
  const entry: ConnectLogEntry = {
    seq: (typeof runtime.logSeq === 'number' ? runtime.logSeq : 0) + 1,
    at: typeof input.at === 'string' ? input.at : '',
    level: typeof input.level === 'string' ? input.level : 'info',
    phase: typeof input.phase === 'string' && input.phase !== '' ? input.phase : null,
    message,
    line: `[dsh-remote-go:${runtime.id}] ${message}`,
  }
  const text = normalizeText(input.text)
  if (text !== null) entry.text = text
  if (input.boundary === true) entry.boundary = true
  if (!Array.isArray(runtime.logs)) runtime.logs = []
  if (runtime.logs.length >= LOG_RING_LIMIT) runtime.logs.shift()
  runtime.logSeq = entry.seq
  runtime.logs.push(entry)
  return entry
}

/** Forget the previous connection's lines; the sequence restarts with this connection. */
export function resetConnectLog<T extends ConnectLogRuntime>(runtime: T): T {
  runtime.logs = []
  runtime.logSeq = 0
  return runtime
}

/** `YYYY-MM-DD HH:MM:SS` in the Host's own timezone — the clock the user reads. */
function localClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Start one connection's log: drop the previous attempt and write its boundary line, so the
 * panel opens on this attempt only and a copied log says which attempt it belongs to.
 */
export function beginConnectLog(runtime: ConnectLogRuntime, options: { at?: string } = {}): ConnectLogEntry {
  const at = typeof options.at === 'string' && options.at !== '' ? options.at : new Date().toISOString()
  const when = new Date(at)
  const attempt = (typeof runtime.connectCount === 'number' ? runtime.connectCount : 0) + 1
  runtime.connectCount = attempt
  resetConnectLog(runtime)
  const clock = Number.isNaN(when.getTime()) ? at : localClock(when)
  const text = pair(`— 第 ${attempt} 次连接 · ${clock} —`, `— Connection ${attempt} · ${clock} —`)
  return appendConnectLog(runtime, { at, level: 'info', message: text.en, text, boundary: true })
}

/** `{ zh, en }` from any bilingual value, filling a missing side from the other. */
function say(value: unknown): BilingualText | null {
  if (typeof value === 'string') return value === '' ? null : pair(value, value)
  if (!isPlainObject(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh : ''
  const en = typeof value.en === 'string' ? value.en : ''
  if (zh === '' && en === '') return null
  return { zh: zh === '' ? en : zh, en: en === '' ? zh : en }
}

/**
 * Turn an `ErrorView` into the lines the connect log prints for a failed connection:
 * the failed phase and code, the localized reason, every hint, then the redacted and
 * head-tail-truncated technical detail — the remote log tail line by line for a failed start.
 *
 * `options.label` replaces the first line for a one-shot action that is not a connect (the
 * explicit remote stop), so its failure is not announced as a connection failure.
 */
export function connectFailureLines(
  view: ConnectFailureView | null,
  options: ConnectFailureOptions = {},
): ConnectFailureLine[] {
  const code = typeof view?.code === 'string' && view.code !== '' ? view.code : 'internal'
  const phase = typeof options.phase === 'string' && options.phase !== '' ? options.phase : null
  const lines: ConnectFailureLine[] = []
  const push = (text: BilingualText) => lines.push({ level: 'error', phase, message: text.en, text })
  const raw = (message: string) => lines.push({ level: 'error', phase, message })

  const label = normalizeText(options.label)
  push(
    label ??
      (phase === null
        ? pair(`连接失败：${code}`, `Connect failed: ${code}`)
        : pair(`连接失败于 ${phase} 阶段：${code}`, `Connect failed in phase ${phase}: ${code}`)),
  )

  // The card explains the failure in one sentence; the log has to carry that sentence.
  const reason = say(view?.detail) ?? say(view?.title)
  if (reason !== null) push(pair(`原因：${reason.zh}`, `Reason: ${reason.en}`))

  const hints = Array.isArray(view?.nextSteps) ? view.nextSteps : []
  for (const hint of hints) {
    const step = say(hint)
    if (step !== null) push(pair(`建议：${step.zh}`, `Next: ${step.en}`))
  }

  const technical = typeof view?.technical === 'string' ? view.technical : ''
  if (technical.trim() !== '') {
    const tail = code === 'remote-dsh-start-failed'
    push(tail ? pair('远端日志尾部：', 'Remote log tail:') : pair('技术细节：', 'Details:'))
    // Redaction is the contract of anything copied out of the log; `headTail` keeps both the
    // start of the message (what failed) and its end (the error itself) when it is too long.
    let printed = 0
    for (const line of headTail(redactText(technical), LOG_TECHNICAL_LIMIT).split(/\r?\n/)) {
      if (printed >= LOG_TAIL_LINES) break
      if (line.trim() === '') continue
      raw(headTail(line, LOG_LINE_LIMIT))
      printed += 1
    }
  }
  return lines
}

export function connectLogTail(runtime: ConnectLogRuntime | null | undefined): ConnectLogTailItem[] {
  const entries = runtime && Array.isArray(runtime.logs) ? runtime.logs : []
  return entries.slice(-LOG_TAIL_LIMIT).map((entry) => {
    const item: ConnectLogTailItem = {
      seq: typeof entry.seq === 'number' ? entry.seq : 0,
      at: typeof entry.at === 'string' ? entry.at : '',
      level: typeof entry.level === 'string' ? entry.level : 'info',
      phase: typeof entry.phase === 'string' && entry.phase !== '' ? entry.phase : null,
      message: typeof entry.message === 'string' ? entry.message : String(entry.line ?? ''),
    }
    const text = normalizeText(entry.text)
    if (text !== null) item.text = text
    if (entry.boundary === true) item.boundary = true
    return item
  })
}

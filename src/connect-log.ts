/** The connect log behind `HostView.logs`: the per-host ring, the per-connection reset, the structured failure lines,
 * its bounded `/state` tail and which statuses print it. */
import { redactText } from './redact.js'
import { headTail, isPlainObject, type BilingualText } from './util.js'
export const CONNECT_LOG_STATUSES = Object.freeze(['connecting', 'fingerprint-pending', 'error'])
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
export interface ConnectLogInput {
  message: unknown
  at?: string
  level?: string
  phase?: string | null
  text?: unknown
  boundary?: boolean
}
export interface ConnectLogRuntime {
  id: string
  status?: string
  logs: ConnectLogEntry[]
  logSeq: number
  connectCount: number
}
export interface ConnectLogTailItem {
  seq: number
  at: string
  level: string
  phase: string | null
  message: string
  text?: BilingualText
  boundary?: boolean
}
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
export interface ConnectFailureLine {
  level: string
  phase: string | null
  message: string
  text?: BilingualText
}
export const LOG_RING_LIMIT = 200
export const LOG_TAIL_LIMIT = 120
export const LOG_TECHNICAL_LIMIT = 1200
export const LOG_LINE_LIMIT = 400
export const LOG_TAIL_LINES = 60

export function connectLogVisible(status: string | null | undefined): boolean {
  return typeof status === 'string' && CONNECT_LOG_STATUSES.includes(status)
}

function normalizeText(value: unknown): BilingualText | null {
  if (!isPlainObject(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh : ''
  const en = typeof value.en === 'string' ? value.en : ''
  if (zh === '' || en === '') return null
  return { zh, en }
}

export function appendConnectLog(runtime: ConnectLogRuntime, input: ConnectLogInput): ConnectLogEntry {
  const raw = typeof input.message === 'string' ? input.message : String(input.message ?? '')
  // The remote's own stdout lands here (the first launch line carries its session token) and this
  // ring is the second exit of that text, so it is redacted at write time, not only in the view.
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

export function resetConnectLog<T extends ConnectLogRuntime>(runtime: T): T {
  runtime.logs = []
  runtime.logSeq = 0
  return runtime
}

function localClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
/** Start one connection's log: drop the previous attempt and write its boundary line, so the panel opens on this
 * attempt only and a copied log says which attempt it belongs to. */
export function beginConnectLog(runtime: ConnectLogRuntime, options: { at?: string } = {}): ConnectLogEntry {
  const at = typeof options.at === 'string' && options.at !== '' ? options.at : new Date().toISOString()
  const when = new Date(at)
  const attempt = (typeof runtime.connectCount === 'number' ? runtime.connectCount : 0) + 1
  runtime.connectCount = attempt
  resetConnectLog(runtime)
  const clock = Number.isNaN(when.getTime()) ? at : localClock(when)
  const text = { zh: `— 第 ${attempt} 次连接 · ${clock} —`, en: `— Connection ${attempt} · ${clock} —` }
  return appendConnectLog(runtime, { at, level: 'info', message: text.en, text, boundary: true })
}

function say(value: unknown): BilingualText | null {
  if (typeof value === 'string') return value === '' ? null : { zh: value, en: value }
  if (!isPlainObject(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh : ''
  const en = typeof value.en === 'string' ? value.en : ''
  if (zh === '' && en === '') return null
  return { zh: zh === '' ? en : zh, en: en === '' ? zh : en }
}
/** The lines the log prints for a failed connection: phase/code, the localized reason, every hint, then the redacted
 * head-tail-truncated technical detail. `options.label` replaces the first line for a one-shot action (remote stop). */
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
        ? { zh: `连接失败：${code}`, en: `Connect failed: ${code}` }
        : { zh: `连接失败于 ${phase} 阶段：${code}`, en: `Connect failed in phase ${phase}: ${code}` }),
  )
  const reason = say(view?.detail) ?? say(view?.title)

  if (reason !== null) push({ zh: `原因：${reason.zh}`, en: `Reason: ${reason.en}` })
  const hints = Array.isArray(view?.nextSteps) ? view.nextSteps : []
  for (const hint of hints) {
    const step = say(hint)
    if (step !== null) push({ zh: `建议：${step.zh}`, en: `Next: ${step.en}` })
  }
  const technical = typeof view?.technical === 'string' ? view.technical : ''
  if (technical.trim() !== '') {
    const tail = code === 'remote-dsh-start-failed'
    push(tail ? { zh: '远端日志尾部：', en: 'Remote log tail:' } : { zh: '技术细节：', en: 'Details:' })
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

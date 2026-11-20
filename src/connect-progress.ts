/** Connect progress: the staged progress line (published on the state channel) and the log rows (published on the log
 * channel); it never sets a host status. */
import { appendConnectLog, connectFailureLines, connectLogVisible } from './connect-log.js'
import type { ConnectFailureView, ConnectLogEntry, ConnectLogInput, ConnectLogRuntime } from './connect-log.js'
import type { ConnectPhase } from './host-runtime.js'
import { logVisible, nowIso, type BilingualText } from './util.js'
const REPORT_MIN_INTERVAL_MS = 700
/** One interpolation value of a progress code; booleans are part of the contract (`ssh` carries `{ jump: true }`). */
export type ProgressParams = Record<string, string | number | boolean>
export interface ConnectProgressState {
  code: string
  params?: ProgressParams
}
export interface ConnectProgressRuntime extends ConnectLogRuntime {
  status?: string
  phase?: ConnectPhase | null
  progress?: ConnectProgressState
}
export interface NodeProgressEvent {
  step?: string
  version?: string
  bytes?: unknown
}
export interface ConnectProgressOptions {
  logger: Record<string, ((...args: unknown[]) => void) | undefined>
  emitState: () => void
  emitLogs?: (runtime: ConnectProgressRuntime) => void
  getSettings?: () => { logLevel?: string } | undefined
  logLevel?: string
}
export interface PreflightEvent {
  code: string
  params?: Record<string, string | number>
}

function stripAnsi(text: unknown): string {
  return String(text ?? '').replace(/\u001B\[[0-9;]*m/g, '')
}
/** Turn one npm/npx output line into a progress event: known shapes get a localized code (the package's own `--version`
 * output is the success signal, not progress), anything else is kept truncated as a detail. */
export function describePreflightEvent(line: unknown, version: string): PreflightEvent | null {
  const text = stripAnsi(line).trim()

  if (text === '') return null
  if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text)) return null
  if (/The following package was not found and will be installed/i.test(text)) {
    return { code: 'bootstrap-first-run', params: { version } }
  }

  if (/^npm (http fetch|http request)/i.test(text)) return { code: 'bootstrap-fetching' }
  if (/added \d+ packages? in/i.test(text)) return { code: 'bootstrap-installed' }
  return { code: 'bootstrap-progress', params: { detail: text.slice(0, 160) } }
}

export function createConnectProgress(options: ConnectProgressOptions) {
  function write(runtime: ConnectProgressRuntime, input: ConnectLogInput): ConnectLogEntry {
    const entry = appendConnectLog(runtime, { at: nowIso(), ...input })
    // Verbosity is a runtime decision: `options.logLevel` (tests, diagnostics) or settings.
    const threshold = options.logLevel ?? options.getSettings()?.logLevel ?? 'info'
    if (!logVisible(entry.level, threshold)) return entry
    const method = options.logger[entry.level] ?? options.logger.info
    method?.(entry.line)
    return entry
  }
  /** Hand the appended rows to the log channel; a log line is not a state change (docs/api.md v2.12). */
  function publish(runtime: ConnectProgressRuntime): void {
    if (!connectLogVisible(runtime.status)) return
    options.emitLogs?.(runtime)
  }

  function log(runtime: ConnectProgressRuntime, level: string, ...args: unknown[]): ConnectLogEntry {
    const message = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
    const entry = write(runtime, { level, message, phase: runtime.phase })
    publish(runtime)
    return entry
  }
  /** Print a failed connection as the lines that explain it; `context.label` replaces the leading line for a stop. */
  function logFailure(
    runtime: ConnectProgressRuntime,
    view: ConnectFailureView | null | undefined,
    context: { phase?: string | null; label?: BilingualText | null } = {},
  ): void {
    const phase = typeof context.phase === 'string' && context.phase !== '' ? context.phase : null
    for (const line of connectFailureLines(view, { phase, label: context.label })) {
      write(runtime, { level: line.level, message: line.message, text: line.text, phase: line.phase })
    }
    publish(runtime)
  }

  function phase(runtime: ConnectProgressRuntime, phaseName: ConnectPhase, code: string, params?: ProgressParams) {
    runtime.phase = phaseName
    runtime.progress = { code, ...(params ? { params } : {}) }
    options.emitState()
  }

  function nodeProgress(runtime: ConnectProgressRuntime, event: NodeProgressEvent): void {
    if (event.step === 'check') return
    if (event.step === 'download') {
      const mb = Math.max(0, Math.round(Number(event.bytes ?? 0) / (1024 * 1024)))
      log(runtime, 'info', `downloading managed Node v${event.version} (${mb} MB so far)`)
      phase(runtime, 'bootstrap', 'downloading-node', { version: event.version, mb })
      return
    }
    if (event.step === 'ready') {
      log(runtime, 'info', `managed Node v${event.version} is ready`)
      return
    }
    log(runtime, 'info', `installing managed Node v${event.version}`)
    phase(runtime, 'bootstrap', 'installing-node', { version: event.version })
  }
  /** Stream one channel of the npx preflight into the progress line: each line becomes a short detail, throttled so the
   * SSE stream is not flooded (npm has no TTY over SSH). */
  function bootstrapReporter(runtime: ConnectProgressRuntime, version: string): (chunk: unknown) => void {
    let buffer = ''
    let lastAt = 0
    let lastKey = ''
    return (chunk) => {
      buffer += String(chunk ?? '')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const text = stripAnsi(rawLine).trim()
        // npx is the slowest step on a cold cache: print what it says at debug level.
        if (text !== '') log(runtime, 'debug', `npx: ${text}`)
        const event = describePreflightEvent(rawLine, version)
        if (!event) continue
        const key = `${event.code}:${event.params?.detail ?? ''}`
        if (key === lastKey) continue
        const now = Date.now()
        if (now - lastAt < REPORT_MIN_INTERVAL_MS) continue
        lastAt = now
        lastKey = key
        phase(runtime, 'bootstrap', event.code, event.params)
      }
    }
  }

  function dispose(): void {}
  return { log, logFailure, phase, nodeProgress, bootstrapReporter, dispose }
}

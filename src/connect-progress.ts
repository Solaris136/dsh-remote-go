/**
 * Connect progress: the staged progress line (published on the state channel) and the log rows
 * (published on the log channel); it never sets a status.
 */
import { appendConnectLog, connectFailureLines, connectLogVisible } from './connect-log.js'
import type { ConnectFailureView, ConnectLogEntry, ConnectLogInput, ConnectLogRuntime } from './connect-log.js'
import type { ConnectPhase } from './host-runtime.js'
import { logVisible, nowIso } from './util.js'
import type { BilingualText } from './util.js'

/** Throttle for the npx reporter: one progress frame per 700 ms at most. */
const REPORT_MIN_INTERVAL_MS = 700

/**
 * One interpolation value of a progress code, rendered verbatim by the Client. Booleans are
 * part of the contract: the `ssh` phase already carries `{ jump: true }` for a jump-host dial.
 */
export type ProgressParams = Record<string, string | number | boolean>

/** The progress line the Client renders: a code plus its interpolation values. */
export interface ConnectProgressState {
  code: string
  params?: ProgressParams
}

/** The slice of a host runtime the connect progress writes (`host-runtime.ts`). */
export interface ConnectProgressRuntime extends ConnectLogRuntime {
  status?: string
  phase?: ConnectPhase | null
  progress?: ConnectProgressState
}

/** One managed-Node installer event, as the installer reports it. */
export interface NodeProgressEvent {
  step?: string
  version?: string
  bytes?: unknown
}

/**
 * What a caller has to supply: a logger, the two publishers (state model / log rows) and the
 * settings lookup.
 */
export interface ConnectProgressOptions {
  logger: Record<string, ((...args: unknown[]) => void) | undefined>
  /** A state-model change (phase/progress): bumps the revision and broadcasts the state frame. */
  emitState: () => void
  /** Log rows were appended: publish them on the log channel, never on the state channel. */
  emitLogs?: (runtime: ConnectProgressRuntime) => void
  getSettings?: () => { logLevel?: string } | undefined
  logLevel?: string
}

/** A localized progress code derived from one line of npm/npx output. */
export interface PreflightEvent {
  code: string
  params?: Record<string, string | number>
}

function stripAnsi(text: unknown): string {
  return String(text ?? '').replace(/\u001B\[[0-9;]*m/g, '')
}

/**
 * Turn one npm/npx output line into a progress event for the connect line.
 * `npm_config_loglevel=http` makes npm report fetches without a TTY; known shapes
 * get a localized progress code, anything else is kept (truncated) as a detail.
 */
export function describePreflightEvent(line: unknown, version: string): PreflightEvent | null {
  const text = stripAnsi(line).trim()
  if (text === '') return null
  // The package's own `--version` output is the success signal, not progress.
  if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text)) return null
  if (/The following package was not found and will be installed/i.test(text)) {
    return { code: 'bootstrap-first-run', params: { version } }
  }
  if (/^npm (http fetch|http request)/i.test(text)) return { code: 'bootstrap-fetching' }
  if (/added \d+ packages? in/i.test(text)) return { code: 'bootstrap-installed' }
  return { code: 'bootstrap-progress', params: { detail: text.slice(0, 160) } }
}

export function createConnectProgress(options: ConnectProgressOptions) {
  /** Append one line and echo it to the Host logger at the same level. */
  function write(runtime: ConnectProgressRuntime, input: ConnectLogInput): ConnectLogEntry {
    const entry = appendConnectLog(runtime, { at: nowIso(), ...input })
    // Verbosity is a runtime decision: `options.logLevel` (tests, diagnostics) or settings.
    const threshold = options.logLevel ?? options.getSettings()?.logLevel ?? 'info'
    if (!logVisible(entry.level, threshold)) return entry
    const method = options.logger[entry.level] ?? options.logger.info
    method?.(entry.line)
    return entry
  }

  function log(runtime: ConnectProgressRuntime, level: string, ...args: unknown[]): ConnectLogEntry {
    const message = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
    const entry = write(runtime, { level, message, phase: runtime.phase })
    publish(runtime)
    return entry
  }

  /**
   * Print a failed connection as the lines that explain it (phase, code, localized reason,
   * hints, redacted details), instead of one line of code plus a raw message. `context.label`
   * replaces the leading line for a one-shot action that is not a connect (the remote stop).
   */
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

  /**
   * Hand the appended rows to the log channel. The state channel is not touched: a log line is
   * not a state change (docs/api.md v2.12). Coalescing (150 ms) belongs to the event hub, so this
   * is one cheap notification per row and the hub decides how many frames leave the process.
   */
  function publish(runtime: ConnectProgressRuntime): void {
    if (!connectLogVisible(runtime.status)) return
    options.emitLogs?.(runtime)
  }

  /**
   * The staged progress line (pure UI): it never changes the host status, which is why it is not a
   * transition. The connect pipeline is its only caller.
   */
  function phase(
    runtime: ConnectProgressRuntime,
    phaseName: ConnectPhase,
    code: string,
    params?: ProgressParams,
  ): void {
    runtime.phase = phaseName
    runtime.progress = { code, ...(params ? { params } : {}) }
    options.emitState()
  }

  /**
   * Managed-Node provisioning reports coarse steps; surface them in the same
   * progress line the rest of the pipeline uses (the installer already bundles
   * byte progress into ~5s/8 MB events).
   */
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

  /**
   * Stream one channel of the npx preflight into the connect progress line. npm
   * has no TTY over SSH, so the command enables `npm_config_loglevel=http`; each
   * line becomes a short detail, throttled so the SSE stream is not flooded.
   */
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

  /**
   * Nothing to release: the 150 ms window moved into the event hub with the channel itself. The
   * call stays because `service.shutdown()` has always made it (docs/api.md v2.12).
   */
  function dispose(): void {}

  return { log, logFailure, phase, nodeProgress, bootstrapReporter, dispose }
}

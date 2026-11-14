/**
 * The connect log the Client prints under the staged progress (docs/api.md
 * `HostView.logs`).
 *
 * One module owns the whole shape: the per-host ring the runtime keeps, the
 * bounded tail that travels in `/state`, and which statuses have a window that
 * prints it. The service only writes lines; the view only reads them — neither
 * one has to know how many are kept or how a line is tagged.
 *
 * The lines are local content the user produced (SSH / npx / remote stdout), so
 * they travel as they were written; redaction is the diagnostics bundle's job,
 * not this one's.
 */

export const CONNECT_LOG_STATUSES = Object.freeze(['connecting', 'fingerprint-pending', 'error'])

export const LOG_RING_LIMIT = 200

export const LOG_TAIL_LIMIT = 120

export function connectLogVisible(status) {
  return typeof status === 'string' && CONNECT_LOG_STATUSES.includes(status)
}

export function appendConnectLog(runtime, input) {
  const message = typeof input.message === 'string' ? input.message : String(input.message ?? '')
  const entry = {
    seq: (typeof runtime.logSeq === 'number' ? runtime.logSeq : 0) + 1,
    at: typeof input.at === 'string' ? input.at : '',
    level: typeof input.level === 'string' ? input.level : 'info',
    message,
    line: `[dsh-remote-go:${runtime.id}] ${message}`,
  }
  if (!Array.isArray(runtime.logs)) runtime.logs = []
  if (runtime.logs.length >= LOG_RING_LIMIT) runtime.logs.shift()
  runtime.logSeq = entry.seq
  runtime.logs.push(entry)
  return entry
}

export function connectLogTail(runtime) {
  const entries = runtime && Array.isArray(runtime.logs) ? runtime.logs : []
  return entries.slice(-LOG_TAIL_LIMIT).map((entry) => ({
    seq: typeof entry.seq === 'number' ? entry.seq : 0,
    at: typeof entry.at === 'string' ? entry.at : '',
    level: typeof entry.level === 'string' ? entry.level : 'info',
    message: typeof entry.message === 'string' ? entry.message : String(entry.line ?? ''),
  }))
}

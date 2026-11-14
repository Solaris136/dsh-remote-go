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

/** Statuses whose window prints the connect log, in the order they occur. */
export const CONNECT_LOG_STATUSES = Object.freeze(['connecting', 'fingerprint-pending', 'error'])

/** Entries kept per host in the ring; older lines fall out. */
export const LOG_RING_LIMIT = 200

/** Entries shipped to the Client per `/state` frame (the console scrolls, it does not keep history). */
export const LOG_TAIL_LIMIT = 120

/**
 * Whether this status has a window that prints the log.
 * @param {string | null | undefined} status - HostStatus.
 * @returns {boolean} true when the connect window is the surface on screen.
 */
export function connectLogVisible(status) {
  return typeof status === 'string' && CONNECT_LOG_STATUSES.includes(status)
}

/**
 * Append one line to a runtime's ring and return the stored entry.
 *
 * `seq` is monotonic per host so the Client can key lines and notice new ones;
 * `line` is the same text tagged for this process's own logger and the
 * diagnostics bundle, while `message` is what the connect window prints.
 * @param {any} runtime - host runtime (owns `logs` / `logSeq`).
 * @param {{ at: string, level: string, message: string }} input - the new line.
 * @returns {{ seq: number, at: string, level: string, message: string, line: string }} stored entry.
 */
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

/**
 * The bounded tail a HostView carries, newest last.
 * @param {any} runtime - host runtime.
 * @returns {{seq: number, at: string, level: string, message: string}[]} log entries.
 */
export function connectLogTail(runtime) {
  const entries = runtime && Array.isArray(runtime.logs) ? runtime.logs : []
  return entries.slice(-LOG_TAIL_LIMIT).map((entry) => ({
    seq: typeof entry.seq === 'number' ? entry.seq : 0,
    at: typeof entry.at === 'string' ? entry.at : '',
    level: typeof entry.level === 'string' ? entry.level : 'info',
    message: typeof entry.message === 'string' ? entry.message : String(entry.line ?? ''),
  }))
}

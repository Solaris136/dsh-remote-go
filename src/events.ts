/** The two client-facing SSE channels: the low-rate authoritative state channel (`GET /events`) and the connect-log
 * channel (`GET /events/logs`), which carries rows plus a per-host `(instance, hostId, attempt, seq)` cursor. One frame
 * used to do both jobs, shipping the whole `/state` snapshot per log line; this module owns the subscriber sets, caps,
 * heartbeat, 150 ms coalescing and cursor replay, and owns no state. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectLogTailItem } from './connect-log.js'
import type { DownloadJobView } from './download-jobs.js'
import type { ConnectLogView, StateView } from './service.js'
/** At most this many live state streams; a new one evicts the oldest, so a leaking page cannot grow the set. */
export const MAX_SSE_CLIENTS = 8
export const MAX_SSE_LOG_CLIENTS = 8
const MAX_SSE_FRAME_BYTES = 1 * 1024 * 1024
const MAX_SSE_BUFFERED_BYTES = 1 * 1024 * 1024
export const MAX_LOG_FRAME_BYTES = 64 * 1024
export const MAX_LOG_FRAME_ENTRIES = 120
export const LOG_FLUSH_MS = 150
const HEARTBEAT_MS = 15_000
const SSE_COLON = ':'
export interface LogCursor {
  instance: string
  hostId: string
  attempt: number
  seq: number
}
export interface ConnectLogFrame {
  hostId: string
  instance: string
  attempt: number
  seq: number
  reset?: true
  visible: boolean
  entries: ConnectLogTailItem[]
}
export interface ConnectLogEnd {
  hostId: string
  attempt: number
}
interface EventHubLogger {
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}
/** The narrow service surface the hub reads, declared here so the hub cannot reach into host state. The listener
 * parameter is `unknown[]` rather than `any[]`: every listener this module subscribes takes a payload. */
export interface EventHubService {
  snapshot(options?: { logs?: boolean }): StateView
  readonly stateInstance: string
  logView(hostId: string): ConnectLogView | null
  logHostIds(): string[]
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}
export interface EventHubOptions {
  service: EventHubService
  logger?: EventHubLogger
}
interface LogClient {
  res: ServerResponse
  cursors: Map<string, LogCursor>
}
interface LogPlan {
  entries: ConnectLogTailItem[]
  reset: boolean
  seq: number
}
export interface EventHub {
  handleState(req: IncomingMessage, res: ServerResponse): void
  handleLogs(req: IncomingMessage, res: ServerResponse): void
  dispose(): void
}
/** Parse a `Last-Event-ID` header into a cursor: anything but exactly `instance:hostId:attempt:seq` with two safe
 * integers is "no cursor", and the Client then gets a `reset` frame — always correct, if larger. */
export function parseEventId(value: string | undefined): LogCursor | null {
  if (typeof value !== 'string') return null
  const parts = value.split(SSE_COLON)

  if (parts.length !== 4) return null
  const [instance, hostId, attempt, seq] = parts
  const parsedAttempt = Number(attempt)
  const parsedSeq = Number(seq)

  if (instance === '' || hostId === '') return null
  if (!Number.isSafeInteger(parsedAttempt) || !Number.isSafeInteger(parsedSeq)) return null
  return { instance, hostId, attempt: parsedAttempt, seq: parsedSeq }
}

export function formatEventId(cursor: LogCursor): string {
  return [cursor.instance, cursor.hostId, cursor.attempt, cursor.seq].join(SSE_COLON)
}

function planFor(view: ConnectLogView, cursor: LogCursor | null, instance: string): LogPlan | null {
  // Every "cannot continue" case answers with the whole tail rather than a gap protocol: no cursor, another
  // generation/host, another attempt (seq restarts at 1), or a cursor older than the oldest retained row (ring: 200).
  const stale =
    cursor === null ||
    cursor.instance !== instance ||
    cursor.hostId !== view.hostId ||
    cursor.attempt !== view.attempt ||
    cursor.seq < view.firstSeq - 1
  if (stale) return { entries: view.entries, reset: true, seq: view.seq }
  const entries = view.entries.filter((entry) => typeof entry.seq === 'number' && entry.seq > cursor.seq)

  if (entries.length === 0) return null
  return { entries, reset: false, seq: entries[entries.length - 1].seq }
}

export function createEventHub(options: EventHubOptions): EventHub {
  const { service, logger = console } = options
  const stateClients = new Set<ServerResponse>()
  const logClients = new Set<LogClient>()
  const dirtyHosts = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  function openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
  }

  function writeTo(res: ServerResponse, frame: string): boolean {
    if (res.writableEnded === true || res.destroyed === true) return false
    if (res.writableLength > MAX_SSE_BUFFERED_BYTES) {
      try {
        res.end()
      } catch {
        // swallow-ok: the response is already gone; the subscriber is dropped either way
      }
      return false
    }
    try {
      res.write(frame)
      return true
    } catch {
      return false
    }
  }

  function broadcastStateChannel(frame: string): void {
    const bytes = Buffer.byteLength(frame)
    if (bytes > MAX_SSE_FRAME_BYTES) {
      logger.warn?.(`[dsh-remote-go] dropped an ${bytes}-byte SSE frame`)
      return
    }
    for (const res of [...stateClients]) {
      if (!writeTo(res, frame)) stateClients.delete(res)
    }
  }

  function sendLog(client: LogClient, frame: string): boolean {
    const bytes = Buffer.byteLength(frame)
    if (bytes > MAX_LOG_FRAME_BYTES) {
      // The packer splits by size, so this is a defect rather than a load: log it and skip the frame
      // instead of letting it grow the 1 MiB global gate.
      logger.warn?.(`[dsh-remote-go] dropped an oversized ${bytes}-byte log frame`)
      return true
    }
    if (!writeTo(client.res, frame)) {
      logClients.delete(client)
      return false
    }
    return true
  }
  const logEndFrame = (hostId: string, attempt: number): string =>
    `event: log-end\ndata: ${JSON.stringify({ hostId, attempt } satisfies ConnectLogEnd)}\n\n`
  function logFrame(
    view: ConnectLogView,
    instance: string,
    seq: number,
    reset: boolean,
    entries: ConnectLogTailItem[],
  ): string {
    const frame: ConnectLogFrame = {
      hostId: view.hostId,
      instance,
      attempt: view.attempt,
      seq,
      ...(reset ? { reset: true as const } : {}),
      visible: view.visible,
      entries,
    }
    const id = formatEventId({ instance, hostId: view.hostId, attempt: view.attempt, seq })
    return `event: log\nid: ${id}\ndata: ${JSON.stringify(frame)}\n\n`
  }
  /** Split one host's rows into frames that respect both log caps (rows are already bounded by the ring, so the count
   * cap is usually enough; the byte cap keeps long lines from crossing the global gate). */
  function packFrames(view: ConnectLogView, plan: LogPlan): string[] {
    const instance = service.stateInstance
    if (plan.entries.length === 0) return [logFrame(view, instance, plan.seq, plan.reset, [])]
    const frames: string[] = []
    let index = 0
    let first = true
    while (index < plan.entries.length) {
      const chunk: ConnectLogTailItem[] = []
      let bytes = 0
      while (index < plan.entries.length && chunk.length < MAX_LOG_FRAME_ENTRIES) {
        const entry = plan.entries[index]
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1
        const envelope = 320 + 2 * String(entry.seq).length
        if (chunk.length > 0 && bytes + size + envelope > MAX_LOG_FRAME_BYTES) break
        chunk.push(entry)
        bytes += size
        index += 1
      }
      const last = chunk[chunk.length - 1]
      const seq = last !== undefined ? last.seq : view.seq
      frames.push(logFrame(view, instance, seq, plan.reset && first, chunk))
      first = false
    }
    return frames
  }

  function publishTo(client: LogClient, view: ConnectLogView): void {
    const cursor = client.cursors.get(view.hostId) ?? null
    const instance = service.stateInstance
    const plan = planFor(view, cursor, instance)
    if (plan !== null) {
      for (const frame of packFrames(view, plan)) {
        if (!sendLog(client, frame)) return
      }
      if (view.visible) {
        client.cursors.set(view.hostId, { instance, hostId: view.hostId, attempt: view.attempt, seq: plan.seq })
        return
      }
      client.cursors.delete(view.hostId)
      sendLog(client, logEndFrame(view.hostId, view.attempt))
      return
    }
    if (!view.visible && cursor !== null) {
      sendLog(client, logFrame(view, instance, view.seq, false, []))
      client.cursors.delete(view.hostId)
      sendLog(client, logEndFrame(view.hostId, view.attempt))
    }
  }

  function publishHost(hostId: string): void {
    const visible = service.logView(hostId)
    if (visible === null) return
    for (const client of [...logClients]) publishTo(client, visible)
  }
  /** A state change can move hosts in and out of the log-visible set: both directions are discovered here. */
  function reconcileLogs(): void {
    const visible = new Set(service.logHostIds())
    const ids = new Set<string>(visible)
    for (const client of logClients) {
      for (const hostId of client.cursors.keys()) ids.add(hostId)
    }
    for (const hostId of ids) {
      const view = service.logView(hostId)
      if (view !== null) {
        for (const client of [...logClients]) {
          if (!visible.has(hostId) && !client.cursors.has(hostId)) continue
          publishTo(client, view)
        }
        continue
      }
      for (const client of [...logClients]) {
        const cursor = client.cursors.get(hostId)
        if (cursor === undefined) continue
        client.cursors.delete(hostId)
        sendLog(client, logEndFrame(hostId, cursor.attempt))
      }
    }
  }

  function broadcastState(): void {
    broadcastStateChannel(`event: state\ndata: ${JSON.stringify(service.snapshot({ logs: false }))}\n\n`)
    reconcileLogs()
  }

  function markDirty(hostId: string): void {
    if (disposed) return
    dirtyHosts.add(hostId)
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      const hosts = [...dirtyHosts]
      dirtyHosts.clear()
      for (const hostId of hosts) publishHost(hostId)
    }, LOG_FLUSH_MS)
    flushTimer.unref?.()
  }
  const onState = (): void => broadcastState()
  const onLogs = (payload: { hostId: string }): void => markDirty(payload.hostId)
  const onDownload = (job: DownloadJobView): void =>
    broadcastStateChannel(`event: download\ndata: ${JSON.stringify(job)}\n\n`)
  const onRemoteUnreachable = (event: unknown): void =>
    broadcastStateChannel(`event: remote-unreachable\ndata: ${JSON.stringify(event)}\n\n`)
  service.on('state', onState)
  service.on('logs', onLogs)
  service.on('download', onDownload)
  service.on('remote-unreachable', onRemoteUnreachable)
  const heartbeat = setInterval(() => {
    broadcastStateChannel('event: ping\ndata: {}\n\n')
    for (const client of [...logClients]) {
      if (!writeTo(client.res, 'event: ping\ndata: {}\n\n')) logClients.delete(client)
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  function evictOldest<T>(clients: Set<T>, cap: number, close: (client: T) => void): void {
    while (clients.size >= cap) {
      const oldest: T | undefined = clients.values().next().value
      if (oldest === undefined) break
      clients.delete(oldest)
      close(oldest)
    }
  }
  return {
    handleState(req: IncomingMessage, res: ServerResponse): void {
      evictOldest(stateClients, MAX_SSE_CLIENTS, (client) => {
        try {
          client.end()
        } catch {
          // swallow-ok: eviction closes a stream the browser already dropped
        }
      })
      openStream(res)
      res.write(`event: state\ndata: ${JSON.stringify(service.snapshot({ logs: false }))}\n\n`)
      stateClients.add(res)
      req.on('close', () => {
        stateClients.delete(res)
      })
    },
    handleLogs(req: IncomingMessage, res: ServerResponse): void {
      evictOldest(logClients, MAX_SSE_LOG_CLIENTS, (client) => {
        try {
          client.res.end()
        } catch {
          // swallow-ok: same eviction as the state channel; the stream is already gone
        }
      })
      openStream(res)
      const client: LogClient = { res, cursors: new Map() }
      const resume = parseEventId(req.headers['last-event-id'] as string | undefined)
      if (resume !== null) client.cursors.set(resume.hostId, resume)
      logClients.add(client)
      for (const hostId of service.logHostIds()) {
        const view = service.logView(hostId)
        if (view !== null) publishTo(client, view)
      }
      req.on('close', () => {
        logClients.delete(client)
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      service.removeListener('state', onState)
      service.removeListener('logs', onLogs)
      service.removeListener('download', onDownload)
      service.removeListener('remote-unreachable', onRemoteUnreachable)
      clearInterval(heartbeat)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      dirtyHosts.clear()
      for (const res of stateClients) {
        try {
          res.end()
        } catch {
          // swallow-ok: dispose ends streams the browser may already have closed
        }
      }
      stateClients.clear()
      for (const client of logClients) {
        try {
          client.res.end()
        } catch {
          // swallow-ok: the same dispose sweep on the log channel
        }
      }
      logClients.clear()
    },
  }
}

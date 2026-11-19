/**
 * The two client-facing SSE channels (docs/api.md): the state channel (`GET /events`) and the
 * connect-log channel (`GET /events/logs`).
 *
 * The split exists because one frame did two jobs at wildly different rates: every connect log
 * line shipped the whole `/state` snapshot (up to 120 log rows per host, 100–300 KB) and bumped
 * the state revision, which made the Client throw away in-flight `GET /state` reads and repaint
 * the whole tree. Here the state channel stays low-rate and authoritative (`rev` / `instance`),
 * and the log channel carries only rows, with a per-host `(instance, hostId, attempt, seq)`
 * cursor so a reconnect, a duplicate frame or a replay cannot render a line twice.
 *
 * This module owns the subscriber sets, the caps, the heartbeat, the 150 ms coalescing window and
 * the cursor replay; it owns no state. Everything it reads comes from the service's narrow log
 * view (`logView` / `logHostIds`) and `snapshot({ logs: false })`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectLogTailItem } from './connect-log.js'
import type { DownloadJobView } from './download-jobs.js'
import type { ConnectLogView, StateView } from './service.js'

/**
 * At most this many live state streams are served; a new one evicts the oldest, so a page that
 * leaks EventSources cannot grow this set without bound. The log channel has its own cap
 * (`MAX_SSE_LOG_CLIENTS`) because one page now opens two streams: sharing a counter would let
 * four tabs evict each other's state stream.
 */
export const MAX_SSE_CLIENTS = 8

/** At most this many live `/events/logs` streams, counted independently of the state channel. */
export const MAX_SSE_LOG_CLIENTS = 8

/** One SSE frame may not exceed this many bytes (a runaway snapshot is dropped, not buffered). */
const MAX_SSE_FRAME_BYTES = 1 * 1024 * 1024

/** A subscriber whose unsent backlog passes this is gone: drop it instead of buffering forever. */
const MAX_SSE_BUFFERED_BYTES = 1 * 1024 * 1024

/** One log frame may not exceed this many bytes; a frame is split before it would cross the cap. */
export const MAX_LOG_FRAME_BYTES = 64 * 1024

/** Rows per log frame: the same bound as the `/state` tail, so one frame can rebuild the panel. */
export const MAX_LOG_FRAME_ENTRIES = 120

/** Coalescing window for log frames (the console can print dozens of lines a second). */
export const LOG_FLUSH_MS = 150

/** Liveness ping on both channels; a buffering middlebox then cannot look like a quiet stream. */
const HEARTBEAT_MS = 15_000

/** `readyState` of an `EventSource`-style client that will not be retried; kept for the Client. */
const SSE_COLON = ':'

/** The cursor a log frame's `id:` carries: one host of one publish generation of one attempt. */
export interface LogCursor {
  instance: string
  hostId: string
  attempt: number
  seq: number
}

/** One frame of the log channel (docs/api.md `ConnectLogFrame`). */
export interface ConnectLogFrame {
  hostId: string
  /** The publish generation (= `StateView.instance`) the rows belong to. */
  instance: string
  /** The connection attempt (the N of the boundary line's "第 N 次连接"). */
  attempt: number
  /** The cursor of the last row in this frame; equals the host cursor for an empty frame. */
  seq: number
  /** The Client replaces this host's rows with `entries` (first frame, or replay impossible). */
  reset?: true
  /** `false` means the host left the log-visible set; a `log-end` follows. */
  visible: boolean
  entries: ConnectLogTailItem[]
}

/** The final frame for one host leaving the log-visible set (docs/api.md `ConnectLogEnd`). */
export interface ConnectLogEnd {
  hostId: string
  attempt: number
}

/** The logger this module reports through; both methods are optional (a test passes `{}`). */
interface EventHubLogger {
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/**
 * The narrow service surface the hub reads. Declared here (not taken from the facade) so the hub
 * cannot reach into host state: it publishes frames from a snapshot and a per-host log view.
 * The listener parameter is `unknown[]` rather than the emitter's `any[]`: every listener this
 * module subscribes takes a concrete payload, and an unknown-typed slot keeps that honest.
 */
export interface EventHubService {
  snapshot(options?: { logs?: boolean }): StateView
  readonly stateInstance: string
  logView(hostId: string): ConnectLogView | null
  logHostIds(): string[]
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Everything `createEventHub` needs. */
export interface EventHubOptions {
  service: EventHubService
  logger?: EventHubLogger
}

/** One `/events/logs` subscriber: its response plus the per-host cursor it has been sent up to. */
interface LogClient {
  res: ServerResponse
  cursors: Map<string, LogCursor>
}

/** What one publish owes one subscriber for one host. */
interface LogPlan {
  entries: ConnectLogTailItem[]
  reset: boolean
  seq: number
}

/** What one mounted pair of channels exposes; both handlers assume admission already passed. */
export interface EventHub {
  /** State channel (`GET /events`): the caller has already passed admission and the fence. */
  handleState(req: IncomingMessage, res: ServerResponse): void
  /** Connect-log channel (`GET /events/logs`): same pre-condition as `handleState`. */
  handleLogs(req: IncomingMessage, res: ServerResponse): void
  /** One-shot teardown: unsubscribe, clear the timers, end every stream. Idempotent. */
  dispose(): void
}

/**
 * Parse a `Last-Event-ID` header back into a cursor. Anything that is not exactly
 * `instance:hostId:attempt:seq` with two safe integers is "no cursor": the Client then gets a
 * `reset` frame, which is always a correct (if larger) answer.
 * @param value - the raw header value, when the request carried one.
 * @returns the cursor, or null.
 */
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

/** The `id:` of one log frame; the inverse of `parseEventId`. */
export function formatEventId(cursor: LogCursor): string {
  return [cursor.instance, cursor.hostId, cursor.attempt, cursor.seq].join(SSE_COLON)
}

/** One host's pending rows for one subscriber: what a reset must carry, or only the new tail. */
function planFor(view: ConnectLogView, cursor: LogCursor | null, instance: string): LogPlan | null {
  // Every "cannot continue" case answers with the whole tail: the Client does not need to know
  // what it missed, and a reset of at most one frame is a cheaper contract than a gap protocol.
  if (cursor === null) return { entries: view.entries, reset: true, seq: view.seq }
  if (cursor.instance !== instance || cursor.hostId !== view.hostId) {
    return { entries: view.entries, reset: true, seq: view.seq }
  }
  // A new attempt starts its own `seq` from 1, so a cursor from the previous attempt would either
  // drop every new row (seq went backwards) or mix two attempts; reset either way.
  if (cursor.attempt !== view.attempt) return { entries: view.entries, reset: true, seq: view.seq }
  // The ring only keeps 200 rows: a cursor older than the oldest retained row has a gap, and a
  // partial replay would hide it.
  if (cursor.seq < view.firstSeq - 1) return { entries: view.entries, reset: true, seq: view.seq }
  const entries = view.entries.filter((entry) => typeof entry.seq === 'number' && entry.seq > cursor.seq)
  if (entries.length === 0) return null
  return { entries, reset: false, seq: entries[entries.length - 1].seq }
}

export function createEventHub(options: EventHubOptions): EventHub {
  const { service } = options
  const logger = options.logger ?? console
  const stateClients = new Set<ServerResponse>()
  const logClients = new Set<LogClient>()
  const dirtyHosts = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  /** The documented SSE response head; both channels answer with exactly these headers. */
  function openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Flush the head now: the state channel writes its first frame immediately, but the log
    // channel can legitimately stay silent (no host is connecting), and Node would otherwise hold
    // the response head until the first write — leaving the browser's EventSource in CONNECTING.
    res.flushHeaders?.()
  }

  /**
   * Write one frame, or report that the subscriber is gone (a slow consumer must not grow the
   * process heap: once its queue is too deep it is dropped, and the browser reconnects).
   * @returns false when the caller should remove the subscriber from its set.
   */
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

  /** Broadcast one state-channel frame; a frame no browser could render is dropped whole. */
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

  /** Send one log frame to one subscriber, honoring the per-frame byte cap. */
  function sendLog(client: LogClient, frame: string): boolean {
    const bytes = Buffer.byteLength(frame)
    if (bytes > MAX_LOG_FRAME_BYTES) {
      // The packer splits by size, so this is a defect rather than a load: log it and skip the
      // frame instead of letting it grow the 1 MiB global gate.
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

  /** One `log` frame; `id:` is what a reconnecting EventSource sends back as `Last-Event-ID`. */
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

  /**
   * Split one host's rows into frames that respect both log caps. Rows are already bounded by the
   * ring (each message is redacted and head-tail truncated at write time), so the count cap alone
   * is usually enough; the byte cap keeps a run of long lines from crossing the global gate.
   */
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
        // Envelope: the fixed field names plus an id whose tail is the last row's `seq`.
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

  /** Send one host's pending rows to one subscriber, advancing (or dropping) its cursor. */
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
      // The host left the log-visible set: the frame said `visible: false`, now close this host.
      client.cursors.delete(view.hostId)
      sendLog(client, logEndFrame(view.hostId, view.attempt))
      return
    }
    if (!view.visible && cursor !== null) {
      // Nothing new to send, but the host left the set: it still gets one closing frame (the
      // explicit `visible: false` the contract promises) and then its `log-end`.
      sendLog(client, logFrame(view, instance, view.seq, false, []))
      client.cursors.delete(view.hostId)
      sendLog(client, logEndFrame(view.hostId, view.attempt))
    }
  }

  /** Send one host's pending rows to every log subscriber (each sliced by its own cursor). */
  function publishHost(hostId: string): void {
    const visible = service.logView(hostId)
    if (visible === null) return
    for (const client of [...logClients]) publishTo(client, visible)
  }

  /**
   * A state change can move hosts in and out of the log-visible set, and a host that just started
   * connecting has no cursor anywhere yet: both are discovered here, from the same event that
   * paints the state frame.
   */
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
      // The host was deleted: close every cursor that still names it.
      for (const client of [...logClients]) {
        const cursor = client.cursors.get(hostId)
        if (cursor === undefined) continue
        client.cursors.delete(hostId)
        sendLog(client, logEndFrame(hostId, cursor.attempt))
      }
    }
  }

  /** The state model changed once: one frame carrying no log rows (docs/api.md v2.12). */
  function broadcastState(): void {
    const frame = `event: state\ndata: ${JSON.stringify(service.snapshot({ logs: false }))}\n\n`
    broadcastStateChannel(frame)
    reconcileLogs()
  }

  /** Both channels carry the download job and liveness-episode events of the state contract. */
  const broadcastDownload = (job: DownloadJobView): void =>
    broadcastStateChannel(`event: download\ndata: ${JSON.stringify(job)}\n\n`)
  const broadcastRemoteUnreachable = (event: unknown): void =>
    broadcastStateChannel(`event: remote-unreachable\ndata: ${JSON.stringify(event)}\n\n`)

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
    // A pending log frame must never keep the process alive on its own.
    flushTimer.unref?.()
  }

  const onState = (): void => broadcastState()
  const onLogs = (payload: { hostId: string }): void => markDirty(payload.hostId)
  const onDownload = (job: DownloadJobView): void => broadcastDownload(job)
  const onRemoteUnreachable = (event: unknown): void => broadcastRemoteUnreachable(event)
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

  /** Close the oldest stream until one more fits; the page reconnects to a fresh one. */
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
      // The first frame is the current snapshot, exactly as a fresh `GET /state` would read it;
      // the Client drops it when it already painted that revision.
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
      // `Last-Event-ID` can only name one host (an EventSource remembers one `id`): the host it
      // names continues from its cursor, every other host gets a reset frame.
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

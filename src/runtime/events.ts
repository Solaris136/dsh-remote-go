/** The session state machine, type side: the 31 events, their effects, and the read-only scope `transition()` reads.
 * Liveness is absent on purpose: the watchdog owns it and publishes its own bus events, so no FSM event duplicates it.
 */
import type { BilingualText } from '../util.js'
import type { ErrorView } from '../errors.js'
import type { ConnectProgressState } from '../connect-progress.js'
import type { Activity, ConnectPhase, EpisodeSource, HostStatus } from '../host-runtime.js'
import type { KeepAlive } from '../settings.js'
import type { SshPort } from '../ssh-port.js'

/** The host key a prompt is about, as an event carries it: the minimal projection, so a caller that only saw a
 * fingerprint may omit the type. */
export interface HostKeyInfo {
  sha256: string
  keyType?: string
}

/** `arm()`/`disarm()` name a timer of the `timers` block. */
export type TimerName = 'reconnect' | 'idle' | 'heartbeat' | 'remoteCheck'
/** The timers a rule may arm. `remoteCheck` is the watchdog's own confirm probe: no rule arms it, but `shutdown`
 * still disarms it, so the name stays in `TimerName` and out of this union. */
export type ArmableTimer = Exclude<TimerName, 'remoteCheck'>
/** The four levels the connect log understands (`connect-progress.ts` writes them). */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
/** The watchdog bus message: it replaces the two reverse callbacks the watchdog used to call. */
export type WatchdogEvent =
  { kind: 'confirmed'; reason: string; source: EpisodeSource } | { kind: 'recovered'; source: EpisodeSource }

/** What a failed stop has to put back exactly as it found it (`restoreStopState`). */
export interface StopSnapshot {
  status: HostStatus
  phase: ConnectPhase | null
  progress: ConnectProgressState | null
  error: ErrorView | null
  uiReady: boolean
  localPort: number | null
}

/** What one teardown may keep alive; every flag defaults to a full release. */
export interface TeardownEffectOptions {
  stopRemote: boolean
  keepRemote?: boolean
  keepSshForIdle?: boolean
  stopped?: boolean
  shutdown?: boolean
}

/** The data half of an effect: the FSM never writes another block directly, it asks that block's owner to apply a
 * named patch. */
export type RuntimePatch =
  // The attach also resets the link block's repair budget (today's `markConnected`), which the FSM cannot write.
  | { kind: 'mark-attached' } // remote-state: uiReady = true, viewRev += 1, repair budget reset
  | { kind: 'mark-detached' } // remote-state: uiReady = false, localPort = null
  | { kind: 'mark-ui-up' } // remote-state: uiReady = true
  | { kind: 'clear-conflict' } // prompts: conflict = null
  | { kind: 'publish-active-host'; hostId: string | null } // host-registry: activeHostId
  // The canonical union has no seat for the two `remote` fields `restoreStopState` puts back, and the `stop.refused`
  // row requires them; this member is that seat.
  | { kind: 'restore-stop'; uiReady: boolean; localPort: number | null }

/** Everything an event may ask the executor to do; `transition()` returns these, never performs them. */
export type Effect =
  | { type: 'emit' }
  | { type: 'flushLogs' }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'logFailure'; phase: string | null; label?: BilingualText; view?: ErrorView }
  | { type: 'arm'; timer: ArmableTimer; ms: number }
  | { type: 'disarm'; timer: TimerName }
  | { type: 'settlePrompts' }
  | { type: 'closeLink' }
  | { type: 'teardown'; options: TeardownEffectOptions }
  | { type: 'apply'; patch: RuntimePatch }
  | { type: 'run'; activity: Activity; token: number }

/** The payload of an event that carries nothing: `Record<string, never>` would make the intersection with `{ type }`
 * uninhabitable (the literal discriminant is not `never`), so an empty payload is the empty record type. */
type NoPayload = Record<never, never>
/** One payload per event type; the union below adds the discriminant. */
export interface EventPayloads {
  // `retry` marks a scheduled re-entry: the spent budget must survive it (only a user connect resets it).
  'connect.requested': { token: number; retry?: boolean }
  'step.entered': { phase: ConnectPhase; code: string; params?: Record<string, string | number | boolean> }
  'step.done': {
    step: 'probe' | 'bootstrap-node' | 'start-adopt' | 'bootstrap-npx' | 'start-launch' | 'tunnel' | 'verify'
  }
  'transport.ready': NoPayload
  // The transport that closed. The pure function cannot compare identity with `state.ssh` (the link block is not part
  // of SessionState), so `EventScope.transportIsCurrent` carries the verdict for this payload.
  'transport.closed': { transport: SshPort | null }
  'hostkey.pending': { info: HostKeyInfo; role: 'target' | 'jump'; host: string | null; port: number }
  'hostkey.answered': { accept: boolean }
  // The bilingual `error=hostKeyUnknown` view can only be built where the key material is, so it arrives as a payload.
  'hostkey.timeout': { view: ErrorView }
  'conflict.pending': { count: number }
  'conflict.answered': { action: 'stop' | 'alongside' | 'cancel'; timedOut?: boolean }
  'connect.succeeded': NoPayload
  'connect.cancelled': NoPayload
  'connect.failed': { view: ErrorView; phase: ConnectPhase | null }
  'disconnect.requested': { stopped?: boolean; stopRemote?: boolean }
  'idle.elapsed': NoPayload
  'repair.requested': { token: number }
  'repair.finished': { ok: boolean }
  'restart.requested': { token: number; pid: number | null; port: number | null }
  // `resumeConnected` serves three callers, but only the "the old instance was kept" one warns: the flag keeps that.
  'restart.resumed': { keptInstance?: boolean }
  'restart.failed': { view: ErrorView; phase: ConnectPhase | null }
  'stop.requested': { token: number; pid: number | null; port: number | null }
  // `unrestorable` is the "cannot be put back, so land on error" branch: the link went away while the stop was failing.
  'stop.refused': { view: ErrorView; phase: ConnectPhase | null; previous: StopSnapshot; unrestorable?: boolean }
  'stop.succeeded': NoPayload
  'reattach.requested': { token: number; reason: string }
  'reattach.failed': { view: ErrorView }
  'reconnect.scheduled': { attempt: number; max: number; delayMs: number }
  'reconnect.gaveup': { maxAttempts: number; view: ErrorView }
  'reconnect.skipped': NoPayload
  'link.cancelled': NoPayload
  shutdown: NoPayload
  'host.removed': { keepAlive: KeepAlive }
}

/** The 31 event names, in table order (minus the three dead `remote.*`). */
export const EVENT_TYPES = [
  'connect.requested',
  'step.entered',
  'step.done',
  'transport.ready',
  'transport.closed',
  'hostkey.pending',
  'hostkey.answered',
  'hostkey.timeout',
  'conflict.pending',
  'conflict.answered',
  'connect.succeeded',
  'connect.cancelled',
  'connect.failed',
  'disconnect.requested',
  'idle.elapsed',
  'repair.requested',
  'repair.finished',
  'restart.requested',
  'restart.resumed',
  'restart.failed',
  'stop.requested',
  'stop.refused',
  'stop.succeeded',
  'reattach.requested',
  'reattach.failed',
  'reconnect.scheduled',
  'reconnect.gaveup',
  'reconnect.skipped',
  'link.cancelled',
  'shutdown',
  'host.removed',
] as const

export type EventType = (typeof EVENT_TYPES)[number]
/** Compile-time proof that the payload map and the runtime tuple name the same 31 events: a mismatch either way is a
 * type error here, before any test runs. */
type EventTypeParity = [Exclude<EventType, keyof EventPayloads>, Exclude<keyof EventPayloads, EventType>] extends [
  never,
  never,
]
  ? true
  : never
export const EVENT_TYPE_PARITY: EventTypeParity = true

/** One event of the state machine: the discriminated union the table drives. */
export type Event = { [K in EventType]: { type: K } & EventPayloads[K] }[EventType]
/** The non-state facts `transition()` needs: all read by the executor and passed in, so the pure function never touches
 * a runtime, a clock or the settings store. The first five follow from the state; the rest live outside `SessionState`.
 */
export interface EventScope {
  readonly disposed: boolean
  readonly runtimeExists: boolean
  readonly linkAlive: boolean
  readonly tunnelAlive: boolean
  readonly promptsPending: boolean
  /** `runtime.ssh === event.transport || runtime.jumpSsh === event.transport`. */
  readonly transportIsCurrent: boolean
  /** `runtime.id`: the `publish-active-host` patch needs it. */
  readonly hostId: string
  /** `entry.keepAlive`: the teardown options depend on it. */
  readonly keepAlive: KeepAlive
  /** `remote.pid !== null || remote.port !== null`: a remote may already be running. */
  readonly remoteStarted: boolean
  /** `status === 'error' && error.code === 'remote-unreachable' && linkAlive && facts !== null`. */
  readonly recoverable: boolean
  /** Configured delays: a pure function cannot read the settings store or the clock. */
  readonly delays: {
    readonly reconnectMs: number
    readonly idleMs: number
    readonly heartbeatMs: number
  }
}

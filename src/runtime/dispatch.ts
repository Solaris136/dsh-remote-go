/** The executor half of the `HostRuntime.session` state machine (`fsm.ts` decides, this file stores and performs the
 * effects through `DispatchHost`, hence no service import and no import cycle with the modules that call it back). */
import { IllegalTransition, isRefusal, transition, writeBack } from './fsm.js'
import type { RefusalReason, SessionState, TransitionResult } from './fsm.js'
import {
  DEFAULT_IDLE_MINUTES,
  REMOTE_HEARTBEAT_DEFAULT_SEC,
  REMOTE_HEARTBEAT_MAX_SEC,
  REMOTE_HEARTBEAT_MIN_SEC,
} from '../constants.js'
import type { WatchdogCtx } from '../context.js'
import type { ErrorView } from '../errors.js'
import type { Activity, HostRuntime, Progress, RuntimeSession } from '../host-runtime.js'
import type { BilingualText } from '../util.js'
import type { Effect, Event, EventScope, LogLevel, RuntimePatch, TeardownEffectOptions, TimerName } from './events.js'

/** The five activity kinds `host-lifecycle.ts#beginLinkWork` may store (`Activity`). */
const ACTIVITIES: readonly string[] = ['connect', 'restart', 'reattach', 'stop', 'repair']

/** `linkBusy`'s storage form: the declared type stays the wide `string | null`, and an unknown kind from an older
 * caller means "no one-shot action" (what the token checks assume), so it must not reach the FSM as an activity. */
export function isActivity(value: string | null): value is Activity {
  return typeof value === 'string' && ACTIVITIES.includes(value)
}

/** Read the session block out of the flat runtime: the only adapter between storage and the pure machine. The four
 * liveness fields are not read — `watchdog.ts` owns them and never dispatches, so a read would round-trip the value. */
export function readSession(runtime: RuntimeSession): SessionState {
  const progress: Progress | null = runtime.progress ?? null
  return {
    status: runtime.status,
    desired: runtime.desired,
    activity: isActivity(runtime.linkBusy) ? runtime.linkBusy : null,
    phase: runtime.phase,
    progress,
    error: runtime.error,
    warning: runtime.warning,
    warningSource: runtime.warningSource,
    closing: runtime.closing === true,
    connectCancelled: runtime.connectCancelled === true,
    transportLost: runtime.transportLost === true,
    reconnectAttempts: Number(runtime.reconnectAttempts) || 0,
    epoch: Number(runtime.linkToken) || 0,
  }
}

/** Everything a rule's effects need, bound to one caller's context: splitting this out is what keeps `dispatch.ts` free
 * of service imports. A method may be called once per effect and must not touch the session block. */
export interface DispatchHost {
  /** `emit`: publish one `/state` frame (the facade bumps `rev`). */
  emit(): void
  /** `log`: one connect-log line. */
  log(runtime: HostRuntime, level: LogLevel, message: string): void
  /** `logFailure`: the structured "connect failed" lines for a failure view. */
  logFailure(runtime: HostRuntime, phase: string | null, label?: BilingualText, view?: ErrorView): void
  /** `arm(idle)`/`arm(heartbeat)`: the two watchdog-owned timers. */
  arm(runtime: HostRuntime, timer: 'idle' | 'heartbeat', ms: number): void
  /** `disarm`: stop one timer (and its bookkeeping) of the `timers` block. */
  disarm(runtime: HostRuntime, timer: TimerName): void
  /** `settlePrompts`: resolve a parked host-key/conflict prompt with "no". */
  settlePrompts(runtime: HostRuntime): void
  /** `closeLink`: release the loopback listener (the transport stays). */
  closeLink(runtime: HostRuntime): void
  /** `teardown`: the single teardown path. */
  teardown(runtime: HostRuntime, options: TeardownEffectOptions, event: Event): Promise<void>
  /** `apply`: hand one named data patch to the block's owner. */
  apply(runtime: HostRuntime, patch: RuntimePatch): void
  /** `flushLogs`: the flush timer lives inside `connect-progress`; nothing else to do. */
  flushLogs(runtime: HostRuntime): void
}

/** Where the caller sits, which decides what a refused transition means. */
export type DispatchCaller = 'script' | 'callback' | 'timer' | 'silent'
/** Per-call hooks the caller supplies for the effects that start work or arm the retry. */
export interface DispatchOptions {
  /** Default `'script'`. */
  caller?: DispatchCaller
  /** Default `true`; `false` defers publication to the caller, keeping its old frame order (after arming a retry). */
  emit?: boolean
  /** `run`: start the action script this event owns (connect/restart/stop/reattach/repair). */
  run?: (activity: Activity, token: number) => void
  /** `arm(reconnect)` from `reconnect.scheduled`: the one place a retry timer may be created. */
  armReconnect?: (ms: number) => void
  /** The caller keeps the current link on purpose: skip `mark-detached`, `closeLink` and `teardown`. Today's restart
   * publishes a failure while the old tunnel stays usable, and `restart.failed` would otherwise tear the link down. */
  keepLink?: boolean
  /** Replace the rule's teardown options for this call: today's restart stops the remote only when *this action*
   * started it (`started && keepAlive === 'stop'`), which the rule cannot know, so the caller passes its verdict. */
  teardown?: TeardownEffectOptions
}

/** The service facts `EventScope` needs, as the executor sees them (no settings/timers object, no host id). */
export type DispatchScopeFacts = Omit<EventScope, 'hostId'>

/** The scope facts of the two prompt events (`hostkey.*`, `conflict.*`). Their rules read one scope field —
 * `promptsPending` — because a prompt answer is only about the slot it belongs to, and the prompt module has no
 * deps/settings slice: the neutral values below are unconsumed, so a future rule reading one would be a wiring bug. */
export function promptScopeFacts(runtime: HostRuntime): DispatchScopeFacts {
  return {
    disposed: false,
    runtimeExists: true,
    linkAlive: runtime.ssh?.connected === true,
    tunnelAlive: runtime.tunnel !== null,
    transportIsCurrent: true,
    promptsPending: runtime.pendingHostKey !== null || runtime.pendingConflict !== null,
    keepAlive: runtime.entry.keepAlive,
    remoteStarted: runtime.remote.pid !== null || runtime.remote.port !== null,
    recoverable: false,
    delays: { reconnectMs: 0, idleMs: 0, heartbeatMs: 0 },
  }
}

/** The heartbeat interval the watchdog would use, clamped exactly like `host-lifecycle.ts#remoteHeartbeatIntervalSec`
 * (a pure rule cannot read settings). Duplicated on purpose: importing the lifecycle function would close a cycle. */
function heartbeatMs(raw: { intervalSec?: number } | undefined): number {
  const seconds = Number(raw?.intervalSec)
  if (!Number.isFinite(seconds)) return REMOTE_HEARTBEAT_DEFAULT_SEC * 1000
  return Math.min(REMOTE_HEARTBEAT_MAX_SEC, Math.max(REMOTE_HEARTBEAT_MIN_SEC, Math.round(seconds))) * 1000
}

/** One event's scope facts, read from the caller's context; every value is a read, the executor's half of the split. */
export function scopeFactsFor(ctx: WatchdogCtx, runtime: HostRuntime, event: Event): DispatchScopeFacts {
  const settings = ctx.settings()
  const linkAlive = runtime.ssh?.connected === true
  const keepAlive = runtime.entry.keepAlive
  const idleMinutes = Math.max(1, runtime.entry.idleMinutes ?? DEFAULT_IDLE_MINUTES)
  return {
    disposed: ctx.state.disposed === true,
    runtimeExists: ctx.state.runtimes.has(runtime.id),
    linkAlive,
    tunnelAlive: runtime.tunnel !== null,
    transportIsCurrent:
      event.type === 'transport.closed' ? runtime.ssh === event.transport || runtime.jumpSsh === event.transport : true,
    promptsPending: runtime.pendingHostKey !== null || runtime.pendingConflict !== null,
    keepAlive,
    remoteStarted: runtime.remote.pid !== null || runtime.remote.port !== null,
    recoverable:
      runtime.status === 'error' && runtime.error?.code === 'remote-unreachable' && linkAlive && runtime.facts !== null,
    delays: {
      reconnectMs: Number(settings.autoReconnect.baseDelayMs) || 0,
      idleMs: idleMinutes * 60_000,
      heartbeatMs: heartbeatMs(settings.remoteHeartbeat),
    },
  }
}

/** Build the read-only scope of one event. `promptsPending` is event-specific on purpose: a `hostkey.*` answer goes
 * stale when the host-key slot is gone, a `conflict.*` answer when the conflict slot is, and one shared "any prompt"
 * flag would let a conflict answer satisfy a host-key rule. */
export function scopeFor(event: Event, runtime: HostRuntime, facts: DispatchScopeFacts): EventScope {
  const promptsPending =
    event.type === 'hostkey.pending' || event.type === 'hostkey.answered' || event.type === 'hostkey.timeout'
      ? runtime.pendingHostKey !== null
      : event.type === 'conflict.pending' || event.type === 'conflict.answered'
        ? runtime.pendingConflict !== null
        : runtime.pendingHostKey !== null || runtime.pendingConflict !== null
  return {
    disposed: facts.disposed,
    runtimeExists: facts.runtimeExists,
    linkAlive: facts.linkAlive,
    tunnelAlive: facts.tunnelAlive,
    promptsPending,
    transportIsCurrent: facts.transportIsCurrent,
    hostId: runtime.id,
    keepAlive: facts.keepAlive,
    remoteStarted: facts.remoteStarted,
    recoverable: facts.recoverable,
    delays: facts.delays,
  }
}

/** What a refusal means for this caller, as the three-tier rule states it. */
function reportRefusal(
  host: DispatchHost,
  runtime: HostRuntime,
  event: Event,
  reason: RefusalReason,
  caller: DispatchCaller,
): void {
  if (caller === 'script') throw new IllegalTransition(reason, event.type)
  // The idle timer firing for a host that is wanted again is the normal race: it keeps today's exact debug wording.
  if (event.type === 'idle.elapsed') {
    host.log(runtime, 'debug', 'idle stop skipped: the host is connected again')
    return
  }
  if (caller === 'silent') return
  // A callback that lost the race is a warning; a timer (reconnected host, stale retry) must not warn.
  host.log(runtime, caller === 'timer' ? 'debug' : 'warn', `state transition refused (${event.type}: ${reason})`)
}

/** The teardown options one event really uses: the `connect.cancelled` row says `{stopRemote:false, keepRemote:true}`,
 * but today's cancel branch releases like a failure (`stopRemote` only under the `stop` policy), and a cancellation
 * after the remote started under `keepAlive: 'stop'` must still stop it, so behavior freeze keeps the failure's. */
function teardownOptions(
  effect: Extract<Effect, { type: 'teardown' }>,
  event: Event,
  scope: EventScope,
): TeardownEffectOptions {
  if (event.type !== 'connect.cancelled') return effect.options
  return {
    stopRemote: scope.remoteStarted && scope.keepAlive === 'stop',
    keepRemote: scope.remoteStarted && scope.keepAlive !== 'stop',
  }
}

/** Execute the effects of one accepted transition, in the order the rule lists them. */
async function runEffects(
  host: DispatchHost,
  runtime: HostRuntime,
  event: Event,
  scope: EventScope,
  effects: readonly Effect[],
  options: DispatchOptions,
): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case 'emit':
        if (options.emit !== false) host.emit()
        break
      case 'flushLogs':
        host.flushLogs(runtime)
        break
      case 'log':
        host.log(runtime, effect.level, effect.message)
        break
      case 'logFailure':
        host.logFailure(runtime, effect.phase, effect.label, effect.view)
        break
      case 'arm':
        if (effect.timer === 'reconnect') {
          // Single source: only `reconnect.scheduled` owns the retry timer; one created here would run a second loop.
          if (event.type === 'reconnect.scheduled') options.armReconnect?.(effect.ms)
        } else {
          host.arm(runtime, effect.timer, effect.ms)
        }
        break
      case 'disarm':
        host.disarm(runtime, effect.timer)
        break
      case 'settlePrompts':
        host.settlePrompts(runtime)
        break
      case 'closeLink':
        if (options.keepLink !== true) host.closeLink(runtime)
        break
      case 'teardown':
        if (options.keepLink !== true) {
          const chosen = options.teardown ?? teardownOptions(effect, event, scope)
          await host.teardown(runtime, chosen, event)
        }
        break
      case 'apply':
        // `mark-detached` describes a released link: a caller keeping the link must not publish `uiReady:false`.
        if (options.keepLink === true && effect.patch.kind === 'mark-detached') break
        host.apply(runtime, effect.patch)
        break
      case 'run':
        if (options.run === undefined) {
          // Only request events carry `run` and every entry point supplies it, so reaching this is a wiring bug.
          throw new Error(`dispatch: the ${event.type} event needs a run hook`)
        }
        options.run(effect.activity, effect.token)
        break
    }
  }
}

/** Apply one event to a runtime's session block and perform its effects. The state write happens before the first
 * effect, so a script resuming after an `await` sees the table's state (the connect catch classifies from it). */
export async function dispatch(
  host: DispatchHost,
  runtime: HostRuntime,
  event: Event,
  facts: DispatchScopeFacts,
  options: DispatchOptions = {},
): Promise<TransitionResult> {
  const caller = options.caller ?? 'script'
  const scope = scopeFor(event, runtime, facts)
  const result = transition(readSession(runtime), event, scope)
  if (isRefusal(result)) {
    reportRefusal(host, runtime, event, result.reason, caller)
    return result
  }
  writeBack(runtime, result.state)
  await runEffects(host, runtime, event, scope, result.effects, options)
  return result
}

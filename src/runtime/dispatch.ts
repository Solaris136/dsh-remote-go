/**
 * The executor half of the `HostRuntime.session` state machine.
 *
 * `fsm.ts` decides *what* the session block becomes; this file turns that decision into the
 * block's storage form and performs the effects the rule asked for (design-arch §2.4.2/§7.6).
 * It is deliberately free of service imports: every action arrives through the `DispatchHost`
 * the calling module builds from its own context, so `dispatch.ts` creates no import cycle with
 * `host-lifecycle.ts`/`prompts.ts` (both of which call back into `dispatch`).
 *
 * Wiring rules this executor implements (from the design and the P2b hand-off):
 *
 * - **One transition, then one write.** The state is read with `readSession`, computed by the
 *   pure `transition`, and written back with `writeBack` before any effect runs. Effects never
 *   mutate the session block; they only act on the rest of the runtime and publish.
 * - **`emit` is the only publication.** `options.emit === false` suppresses it for the callers
 *   whose old code published later in the same routine (the connect/restart/re-attach catches,
 *   which emit after deciding whether a retry is armed), so the frame sequence stays what it was.
 * - **`arm(reconnect)` has a single source.** `connect.failed`/`transport.closed` ask for a retry
 *   timer with the *base* delay, but the randomized delay, the budget and the settings switch live
 *   in `host-lifecycle.ts#scheduleReconnect`. Creating a timer here would run two retry loops, so
 *   only `reconnect.scheduled` — the event `scheduleReconnect` dispatches once it has decided —
 *   may arm it. Every other `arm(reconnect)` means "a retry makes sense" and is left to the
 *   caller's policy (`scheduleConnectRetry`), never turned into a second timer.
 * - **Refusals are graded by caller.** A one-shot script treats a refusal as a bug
 *   (`IllegalTransition`); a transport/proxy callback only logs; a timer logs at debug (the idle
 *   stop in particular must not warn: a host that is connected again is the normal race, not a
 *   fault).
 * - **`connect.cancelled`'s teardown options are the failure's, not the table's.** The §2.4.2 row
 *   says `{stopRemote:false, keepRemote:true}`, but today's cancel branch releases with
 *   `stopRemote: remoteStarted && keepAlive === 'stop'` and `keepRemote: remoteStarted &&
 *   keepAlive !== 'stop'`; behavior freeze wins (reported as a deviation).
 */
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
import type { Activity, EpisodeState, HostRuntime, Progress, RuntimeSession } from '../host-runtime.js'
import type { BilingualText } from '../util.js'
import type {
  Effect,
  EpisodeInfo,
  Event,
  EventScope,
  LogLevel,
  RuntimePatch,
  TeardownEffectOptions,
  TimerName,
  WatchdogEvent,
} from './events.js'

/* ── storage form ↔ pure state ───────────────────────────────────────────────────────────── */

/** The five activity kinds `host-lifecycle.ts#beginLinkWork` may store (`Activity`). */
const ACTIVITIES: readonly string[] = ['connect', 'restart', 'reattach', 'stop', 'repair']

/**
 * `linkBusy` is the `activity` storage form. Its declared type stays the wide `string | null`
 * (§7.4), so a value written by an older caller must not be handed to the FSM as an activity it
 * does not know: an unknown kind means "no one-shot action", which is what the token checks
 * already assume.
 * @param value - the stored `linkBusy` value.
 * @returns whether it is one of the five activities the machine models.
 */
export function isActivity(value: string | null): value is Activity {
  return typeof value === 'string' && ACTIVITIES.includes(value)
}

/**
 * Read the session block out of the flat runtime (design-arch §2.2 keeps the fields flat; this is
 * the only adapter between storage and the pure machine).
 *
 * `episodeSource`/`episodeCooldownUntil` are the storage form of `episode`: the machine keeps a
 * single object, the runtime three fields. The episode's phase is not persisted today, so the read
 * uses `'suspected'`; it only matters for an in-flight `remote.*` transition, which this step does
 * not dispatch (the watchdog keeps its own episode code until the bus lands in P2 step 9).
 * @param runtime - the session block of one host.
 * @returns the pure session state.
 */
export function readSession(runtime: RuntimeSession): SessionState {
  const episode: EpisodeState | null =
    runtime.remoteEpisode === true && typeof runtime.episodeSource === 'string'
      ? { source: runtime.episodeSource, phase: 'suspected', cooldownUntil: Number(runtime.episodeCooldownUntil) || 0 }
      : null
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
    remoteFailures: Number(runtime.remoteFailures) || 0,
    epoch: Number(runtime.linkToken) || 0,
    episode,
  }
}

/* ── the effects the caller must supply ──────────────────────────────────────────────────── */

/**
 * Everything a rule's effects need, bound to one caller's context.
 *
 * Splitting this out is what keeps `dispatch.ts` free of imports from `host-lifecycle`/`prompts`:
 * the module that owns an effect also builds the object. Every method may be called once per
 * effect and must not touch the session block.
 */
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
  /** `episode`: publish a liveness episode (the SSE `remote-unreachable` event). */
  episode(runtime: HostRuntime, info: EpisodeInfo): void
  /** `bus`: the watchdog event the retired reverse callbacks become (P2 step 9). */
  bus(runtime: HostRuntime, event: WatchdogEvent): void
  /** `flushLogs`: the flush timer lives inside `connect-progress`; nothing else to do. */
  flushLogs(runtime: HostRuntime): void
}

/** Where the caller sits, which decides what a refused transition means (§2.4.4 "严格度"). */
export type DispatchCaller = 'script' | 'callback' | 'timer' | 'silent'

/** Per-call hooks the caller supplies for the effects that start work or arm the retry. */
export interface DispatchOptions {
  /** Default `'script'`. */
  caller?: DispatchCaller
  /** Default `true`; `false` leaves publication to the caller (same frame order as before). */
  emit?: boolean
  /** `run`: start the action script this event owns (connect/restart/stop/reattach/repair). */
  run?: (activity: Activity, token: number) => void
  /** `arm(reconnect)` from `reconnect.scheduled`: the one place a retry timer may be created. */
  armReconnect?: (ms: number) => void
  /** `arm(remoteCheck)`: the watchdog's confirm probe (P2 step 9 routes the events that need it). */
  armRemoteCheck?: (ms: number) => void
  /**
   * The caller keeps the current link on purpose: skip `mark-detached`, `closeLink` and
   * `teardown`. Today's restart has one branch that publishes a failure while the old tunnel
   * stays usable ("never publish a fake connected state, explain instead"), and the §2.4.2
   * `restart.failed` row tears the link down. Behavior freeze wins for that branch.
   */
  keepLink?: boolean
  /**
   * Replace the rule's teardown options for this call. Today's restart only stops the remote when
   * *this action* started it (`started && keepAlive === 'stop'`), which the rule cannot know (the
   * scope only says a remote exists). The caller passes its own verdict.
   */
  teardown?: TeardownEffectOptions
}

/* ── scope ───────────────────────────────────────────────────────────────────────────────── */

/** The service facts `EventScope` needs, as the executor sees them (no settings/timers object). */
export interface DispatchScopeFacts {
  disposed: boolean
  runtimeExists: boolean
  linkAlive: boolean
  tunnelAlive: boolean
  transportIsCurrent: boolean
  promptsPending: boolean
  keepAlive: EventScope['keepAlive']
  remoteStarted: boolean
  recoverable: boolean
  delays: EventScope['delays']
}

/**
 * The heartbeat interval the watchdog would use, clamped exactly like
 * `host-lifecycle.ts#remoteHeartbeatIntervalSec` (a pure rule cannot read settings, so the delay
 * arrives in the scope). Duplicated here on purpose: importing the lifecycle function would make
 * `dispatch.ts` depend on a module that depends on `dispatch.ts`.
 * @param raw - the configured `remoteHeartbeat` setting.
 * @returns the interval in milliseconds.
 */
function heartbeatMs(raw: { intervalSec?: number } | undefined): number {
  const seconds = Number(raw?.intervalSec)
  if (!Number.isFinite(seconds)) return REMOTE_HEARTBEAT_DEFAULT_SEC * 1000
  return Math.min(REMOTE_HEARTBEAT_MAX_SEC, Math.max(REMOTE_HEARTBEAT_MIN_SEC, Math.round(seconds))) * 1000
}

/**
 * The scope facts of the two prompt events (`hostkey.*`, `conflict.*`).
 *
 * Their rules read exactly one scope field — `promptsPending` — because a prompt answer is only
 * about the slot it belongs to. The prompt module has no deps/settings slice (design-arch §1.2
 * keeps it narrow), so the unrelated facts are the neutral values: none of these rules consumes
 * them, and a future rule that tried to would be a wiring bug the tests would catch.
 * @param runtime - the host runtime the prompt belongs to.
 * @returns the facts `dispatch()` freezes for a prompt event.
 */
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
    delays: { reconnectMs: 0, idleMs: 0, heartbeatMs: 0, remoteConfirmMs: 0 },
  }
}

/**
 * Read the scope facts of one event from the caller's context. Every value is a read: this is the
 * executor's half of §2.4.4's "the pure function never touches a runtime".
 * @param ctx - the caller's context (the watchdog slice is the widest one the facts need).
 * @param runtime - the host runtime.
 * @param event - the event about to be applied (its transport, if any, decides `transportIsCurrent`).
 * @returns the facts `dispatch()` freezes into an `EventScope`.
 */
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
      remoteConfirmMs: Number(ctx.timers.remoteConfirmDelayMs) || 0,
    },
  }
}

/**
 * Build the read-only scope of one event.
 *
 * `promptsPending` is event-specific on purpose: a `hostkey.*` answer is stale once the host-key
 * slot is gone, a `conflict.*` answer once the conflict slot is gone. One shared "any prompt"
 * flag would let a conflict answer satisfy a host-key rule.
 * @param event - the event about to be applied (its payload names the transport, if any).
 * @param runtime - the host runtime (only for the identity fields the patches need).
 * @param facts - the caller's read of what the context can see.
 * @returns the frozen scope the pure machine reads.
 */
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

/* ── refusal handling ───────────────────────────────────────────────────────────────────── */

/** What a refusal means for this caller, as the design's three-tier rule states it. */
function reportRefusal(
  host: DispatchHost,
  runtime: HostRuntime,
  event: Event,
  reason: RefusalReason,
  caller: DispatchCaller,
): void {
  if (caller === 'script') throw new IllegalTransition(reason, event.type)
  // The idle timer firing for a host that is wanted again is the normal race, not a fault: it
  // keeps today's debug line (and its exact wording), which is what the operator's log shows.
  if (event.type === 'idle.elapsed') {
    host.log(runtime, 'debug', 'idle stop skipped: the host is connected again')
    return
  }
  if (caller === 'silent') return
  // A callback that lost the race is a warning; a timer is expected (a reconnected host's idle
  // timer, a retry a user disconnect made stale) and must not warn.
  host.log(runtime, caller === 'timer' ? 'debug' : 'warn', `state transition refused (${event.type}: ${reason})`)
}

/* ── effect execution ───────────────────────────────────────────────────────────────────── */

/**
 * The teardown options one event really uses.
 *
 * §2.4.2's `connect.cancelled` row says `{stopRemote:false, keepRemote:true}`; today's cancel
 * branch releases exactly like a failure (`stopRemote` only under the `stop` keep-alive policy,
 * `keepRemote` otherwise). Behavior freeze keeps the failure's options — a cancellation after the
 * remote was started under `keepAlive: 'stop'` must still stop it.
 * @param effect - the rule's teardown effect.
 * @param event - the event being executed.
 * @param scope - the read-only facts (remote started? which keep-alive policy?).
 * @returns the options to hand to the teardown path.
 */
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

/**
 * Execute the effects of one accepted transition, in the order the rule lists them.
 * @param host - the effect owner bound to this caller's context.
 * @param runtime - the host runtime the transition was computed for.
 * @param event - the event that produced the effects.
 * @param scope - the read-only facts of that event.
 * @param effects - the rule's effect list.
 * @param options - per-call hooks.
 */
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
          // Single source: see the module comment. Only `reconnect.scheduled` owns the timer.
          if (event.type === 'reconnect.scheduled') options.armReconnect?.(effect.ms)
        } else if (effect.timer === 'remoteCheck') {
          options.armRemoteCheck?.(effect.ms)
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
        // `mark-detached` describes a released link; a caller that keeps the link must not
        // publish `uiReady:false`/`localPort:null` for a listener that is still serving.
        if (options.keepLink === true && effect.patch.kind === 'mark-detached') break
        host.apply(runtime, effect.patch)
        break
      case 'run':
        if (options.run === undefined) {
          // Only the request events carry `run`, and every entry point supplies it. Reaching this
          // branch is a wiring bug, not a runtime condition.
          throw new Error(`dispatch: the ${event.type} event needs a run hook`)
        }
        options.run(effect.activity, effect.token)
        break
      case 'episode':
        host.episode(runtime, effect.info)
        break
      case 'bus':
        host.bus(runtime, effect.event)
        break
    }
  }
}

/* ── the dispatcher ─────────────────────────────────────────────────────────────────────── */

/**
 * Apply one event to a runtime's session block and perform its effects.
 *
 * The state write happens before the first effect, so a script that resumes after an `await`
 * inside an effect list sees the state the table produced (the connect catch depends on this to
 * classify a failure).
 * @param host - the effects, bound to the caller's service context.
 * @param runtime - the host runtime.
 * @param event - one of the 34 events.
 * @param facts - the read-only scope facts.
 * @param options - caller semantics and the per-call effect hooks.
 * @returns the transition result: `ok:true` after the effects ran, or the refusal (state unchanged).
 * @throws IllegalTransition only for a `script` caller, i.e. inside a one-shot action.
 */
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

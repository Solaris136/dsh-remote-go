/** The transition table of the `HostRuntime.session` state machine: one `Record<EventType, Rule>` row per event with
 * its guards, effects and shared pure helpers. `fsm.ts` looks a row up and applies it, and together they are the only
 * place deciding what a session block becomes; nothing here performs I/O, and a refusal returns the state it got. */
import type { ErrorView } from '../errors.js'
import type { BilingualText } from '../util.js'
import type { Activity, Progress } from '../host-runtime.js'
import type { ArmableTimer, Effect, Event, EventScope, EventType, StopSnapshot, TimerName } from './events.js'
import { stillWanted, type RefusalReason, type SessionState } from './fsm.js'

/** The two bilingual texts the FSM itself owns. */
export const RESTART_STOP_WARNING: BilingualText = {
  zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试，或先断开再重连。',
  en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly, or disconnect and reconnect.',
}

export const STOP_FAILED_LABEL: BilingualText = {
  zh: '关闭远端 DSH 失败',
  en: 'Stopping the remote DSH failed',
}

type GuardVerdict = true | RefusalReason
type NarrowEvent<K extends EventType> = Extract<Event, { type: K }>

export interface RuleOf<K extends EventType> {
  guard(state: SessionState, event: NarrowEvent<K>, scope: EventScope): GuardVerdict
  apply(state: SessionState, event: NarrowEvent<K>, scope: EventScope): SessionState
  effects(state: SessionState, event: NarrowEvent<K>, scope: EventScope): readonly Effect[]
}

/** One rule per declared event; `Record` over the union makes a missing event a type error. */
type RuleTable = { readonly [K in EventType]: RuleOf<K> }

function move(state: SessionState, changes: Partial<SessionState>): SessionState {
  return { ...state, ...changes }
}

/** Adopt a caller's token without ever rewinding the epoch: `beginLinkWork` passes `epoch + 1`, so a stale timer
 * token can never take ownership back. */
function epochAfter(state: SessionState, token: number): number {
  return Math.max(state.epoch, token)
}

/** One progress card: the code plus the values the Client renders next to it. */
function progressOf(code: string, params?: Record<string, string | number | boolean>): Progress {
  return params === undefined ? { code } : { code, params }
}

/* Effect constructors: a rule reads as the event table row it implements. */
const emit = (): Effect => ({ type: 'emit' })
const settlePrompts = (): Effect => ({ type: 'settlePrompts' })
const closeLink = (): Effect => ({ type: 'closeLink' })
const disarm = (timer: TimerName): Effect => ({ type: 'disarm', timer })
const arm = (timer: ArmableTimer, ms: number): Effect => ({ type: 'arm', timer, ms })
const log = (level: 'error' | 'warn' | 'info' | 'debug', message: string): Effect => ({ type: 'log', level, message })
const logFailure = (phase: string | null, label?: BilingualText, view?: ErrorView): Effect => ({
  type: 'logFailure',
  phase,
  ...(label === undefined ? {} : { label }),
  // Only a rule that restores a *previous* error names the failure it reports; otherwise the executor logs the error
  // the transition just wrote.
  ...(view === undefined ? {} : { view }),
})
const apply = (patch: Extract<Effect, { type: 'apply' }>['patch']): Effect => ({ type: 'apply', patch })
const teardown = (options: Extract<Effect, { type: 'teardown' }>['options']): Effect => ({ type: 'teardown', options })
const run = (activity: Activity, token: number): Effect => ({ type: 'run', activity, token })
// Frozen shared effect lists: freezing stops a caller that sorted/pushed a result from corrupting later transitions.
const EMIT_ONLY: readonly Effect[] = Object.freeze([emit()])
const NO_EFFECTS: readonly Effect[] = Object.freeze([])
const needsActivity = (state: SessionState): GuardVerdict => (state.activity === null ? 'illegal-transition' : true)
const ownsActivity =
  (activity: Activity) =>
  (state: SessionState): GuardVerdict =>
    state.activity === activity ? true : 'illegal-transition'
const promptGuard =
  (status: SessionState['status']) =>
  (state: SessionState, _event: unknown, scope: EventScope): GuardVerdict =>
    !scope.promptsPending ? 'stale-prompt' : state.status === status ? true : 'prompt-not-pending'
/** The shared effect list of the four request events: stop every timer, publish the `connecting` card (today's
 * `progress.set` published it) and start the action script. */
const requestEffects = (state: SessionState, token: number, activity: Activity): readonly Effect[] => [
  disarm('heartbeat'),
  disarm('reconnect'),
  disarm('idle'),
  emit(),
  run(activity, epochAfter(state, token)),
]
/** Enter one one-shot action: it takes the link lock, adopts the token, and clears the previous error on entry. */
const enter = (
  state: SessionState,
  activity: Activity,
  token: number,
  progress: Progress,
  extra: Partial<SessionState> = {},
): SessionState =>
  move(state, {
    activity,
    epoch: epochAfter(state, token),
    status: 'connecting',
    phase: 'start',
    progress,
    error: null,
    ...extra,
  })
const released = (state: SessionState): SessionState =>
  move(state, {
    status: 'disconnected',
    desired: 'idle',
    epoch: state.epoch + 1,
    phase: null,
    progress: null,
    activity: null,
  })
const toError = (state: SessionState, view: ErrorView): SessionState =>
  move(state, { status: 'error', error: view, phase: null, progress: null, activity: null })

/** The `transport.closed` branches: today's `connect/pipeline.ts#watchTransport`, verbatim. */
type TransportCloseBranch = 'ignored' | 'stale' | 'dropped' | 'handshake' | 'idle'

function transportCloseBranch(state: SessionState, scope: EventScope): TransportCloseBranch {
  // This close is a teardown's own closing, or the user already let go: nothing to report.
  if (state.closing || state.desired !== 'connected') return 'ignored'
  // A newer transport owns the link; this one is the previous attempt's.
  if (!scope.transportIsCurrent) return 'stale'
  // `live` mirrors today's `status === 'connected' || linkBusy !== null`; a connect attempt has its own branch below.
  if (state.status === 'connected' || (state.activity !== null && state.activity !== 'connect')) return 'dropped'
  if (state.activity === 'connect') return 'handshake'
  return 'idle'
}

/** The restart/stop entry guard: connected now, or a `remote-unreachable` error that can recover. */
function entryGuard(state: SessionState, _event: unknown, scope: EventScope): GuardVerdict {
  if (state.activity !== null) return 'busy'
  if (state.status === 'connected') return true
  if (state.status === 'error') return scope.recoverable ? true : 'not-recoverable'
  return 'not-connected'
}

export const TABLE: RuleTable = {
  'connect.requested': {
    guard(state, _event, scope) {
      if (state.activity === 'connect') return 'already-connecting'
      if (state.activity !== null) return 'already-restarting'
      if (state.status === 'connected' && scope.linkAlive) return 'already-connected'
      return true
    },
    apply: (state, event) =>
      move(state, {
        status: 'connecting',
        desired: 'connected',
        activity: 'connect',
        epoch: epochAfter(state, event.token),
        // A scheduled retry re-enters the pipeline; only a user-requested connect resets the budget.
        reconnectAttempts: event.retry === true ? state.reconnectAttempts : 0,
        connectCancelled: false,
        transportLost: false,
        error: null,
        warning: null,
        warningSource: null,
        phase: null,
        progress: null,
        closing: false,
      }),
    effects: (state, event) => [
      disarm('idle'),
      disarm('reconnect'),
      disarm('heartbeat'),
      emit(),
      run('connect', epochAfter(state, event.token)),
    ],
  },
  'step.entered': {
    guard: needsActivity,
    apply: (state, event) => move(state, { phase: event.phase, progress: progressOf(event.code, event.params) }),
    effects: () => EMIT_ONLY,
  },
  'step.done': {
    guard: needsActivity,
    apply: (state) => state,
    // Today probe/node/tunnel/verify completions only log; they do not publish a frame.
    effects: (_state, event) => [log('debug', `step done: ${event.step}`)],
  },
  'transport.ready': {
    guard: needsActivity,
    apply: (state) => move(state, { transportLost: false }),
    effects: () => NO_EFFECTS,
  },
  'transport.closed': {
    guard: () => true,
    apply: (state, _event, scope) => {
      const branch = transportCloseBranch(state, scope)
      if (branch === 'dropped') return move(state, transportDropPatch(state))
      if (branch === 'handshake') return move(state, { transportLost: true })
      return state
    },
    effects: (state, _event, scope) => {
      const branch = transportCloseBranch(state, scope)
      if (branch === 'dropped') {
        return [
          apply({ kind: 'mark-detached' }),
          settlePrompts(),
          disarm('heartbeat'),
          closeLink(),
          arm('reconnect', scope.delays.reconnectMs),
          emit(),
        ]
      }
      if (branch === 'handshake') {
        return [settlePrompts(), log('warn', 'the SSH transport closed while the connection was being set up')]
      }
      return NO_EFFECTS
    },
  },
  'hostkey.pending': {
    guard: (state) => (state.status === 'connecting' ? true : 'illegal-transition'),
    apply: (state, event) => {
      // The same keys `prompts.ts` publishes, including the jump identity (never the target's).
      const params = { sha256: event.info.sha256, keyType: event.info.keyType }
      const progress =
        event.role === 'jump'
          ? progressOf('host-key-confirm', { ...params, role: 'jump', host: event.host })
          : progressOf('host-key-confirm', params)
      return move(state, { status: 'fingerprint-pending', phase: 'ssh', progress })
    },
    effects: () => EMIT_ONLY,
  },
  'hostkey.answered': {
    guard: promptGuard('fingerprint-pending'),
    apply: (state, event) =>
      move(state, { status: 'connecting', progress: progressOf('auth-checking'), connectCancelled: !event.accept }),
    effects: () => EMIT_ONLY,
  },
  'hostkey.timeout': {
    guard: promptGuard('fingerprint-pending'),
    apply: (state, event) =>
      move(state, { status: 'error', error: event.view, phase: null, progress: null, connectCancelled: true }),
    effects: () => EMIT_ONLY,
  },
  'conflict.pending': {
    guard: (state) => (state.status === 'connecting' ? true : 'illegal-transition'),
    apply: (state, event) =>
      move(state, { status: 'conflict-pending', progress: progressOf('remote-dsh-running', { count: event.count }) }),
    effects: () => EMIT_ONLY,
  },
  'conflict.answered': {
    guard: promptGuard('conflict-pending'),
    apply: (state, event) =>
      move(state, {
        status: 'connecting',
        progress: progressOf('probing'),
        // The user said "no": a retry would ask again, so the failure that follows must not schedule one.
        connectCancelled: event.action === 'cancel' ? true : state.connectCancelled,
      }),
    effects: () => [apply({ kind: 'clear-conflict' }), emit()],
  },
  'connect.succeeded': {
    guard: (state) => {
      const mine = state.activity === 'connect' || state.activity === 'restart' || state.activity === 'reattach'
      return mine && state.status === 'connecting' ? true : 'illegal-transition'
    },
    apply: (state) => {
      // A fresh attach clears a stale restart-stop warning; an `alongside` warning describes a running process.
      const clearsWarning = state.warningSource === 'restart-stop'
      return move(state, {
        status: 'connected',
        phase: 'ready',
        progress: progressOf('ready'),
        error: null,
        reconnectAttempts: 0,
        connectCancelled: false,
        activity: null,
        warning: clearsWarning ? null : state.warning,
        warningSource: clearsWarning ? null : state.warningSource,
      })
    },
    effects: (_state, _event, scope) => [
      disarm('idle'),
      arm('heartbeat', scope.delays.heartbeatMs),
      apply({ kind: 'mark-attached' }),
      apply({ kind: 'publish-active-host', hostId: scope.hostId }),
      emit(),
    ],
  },
  'connect.cancelled': {
    guard: needsActivity,
    apply: (state) => move(state, { status: 'disconnected', error: null, phase: null, progress: null, activity: null }),
    // Today's cancel branch published `uiReady:false`/`localPort:null` too: a cancelled attempt that had already set
    // `uiReady` must not leave a half-attached remote view behind.
    effects: () => [teardown({ stopRemote: false, keepRemote: true }), apply({ kind: 'mark-detached' }), emit()],
  },
  'connect.failed': {
    // The one explicit idempotent self-transition: the host-key timeout and the pipeline catch report the same failure,
    // so `error` → `error` is allowed, and any status may fail (a transport closing under a parked prompt).
    // `activity !== null` is the real guard: a failure belongs to the script that owns the link.
    guard: needsActivity,
    apply: (state, event) =>
      move(state, {
        status: 'error',
        error: event.view,
        phase: null,
        progress: null,
        activity: null,
        // Today's pipeline clears the flag after the retry decision; the next attempt starts "not cancelled".
        connectCancelled: false,
      }),
    effects: (state, event, scope) => [
      apply({ kind: 'mark-detached' }),
      logFailure(event.phase),
      teardown({
        stopRemote: scope.remoteStarted && scope.keepAlive === 'stop',
        keepRemote: scope.remoteStarted && scope.keepAlive !== 'stop',
      }),
      // The retry decision (policy, budget, delay) stays in the executor; this only says a retry makes sense.
      ...(state.desired === 'connected' && !state.connectCancelled ? [arm('reconnect', scope.delays.reconnectMs)] : []),
      emit(),
    ],
  },
  'disconnect.requested': {
    // Total on purpose: the user may cancel during any connect step, and a repeat disconnect is idempotent.
    guard: () => true,
    apply: (state) => move(state, { ...released(state), closing: false }),
    effects: (_state, event, scope) => {
      const alreadyStopped = event.stopped === true
      const stopRemote = alreadyStopped ? false : event.stopRemote === true || scope.keepAlive === 'stop'
      const keepSshForIdle = scope.keepAlive === 'idle' && !stopRemote && !alreadyStopped
      return [
        disarm('reconnect'),
        disarm('idle'),
        disarm('heartbeat'),
        settlePrompts(),
        teardown({ stopRemote, keepSshForIdle }),
        apply({ kind: 'mark-detached' }),
        ...(keepSshForIdle ? [arm('idle', scope.delays.idleMs)] : []),
        emit(),
      ]
    },
  },
  'idle.elapsed': {
    // A timer that fires for a host the user wants again is stale. Refusing keeps "run the idle script" unambiguous;
    // the script re-checks `stillWanted`, and this refusal is logged at debug, not the generic warn level.
    guard: (state, _event, scope) => (stillWanted(state, scope) ? 'illegal-transition' : true),
    apply: (state) => state,
    effects: () => NO_EFFECTS,
  },
  'repair.requested': {
    guard: (state, _event, scope) => {
      if (state.activity !== null) return 'busy'
      if (state.status !== 'connected' || !scope.tunnelAlive) return 'not-connected'
      return true
    },
    apply: (state, event) => move(state, { activity: 'repair', epoch: epochAfter(state, event.token) }),
    effects: (state, event) => [run('repair', epochAfter(state, event.token))],
  },
  'repair.finished': {
    guard: ownsActivity('repair'),
    apply: (state) => move(state, { activity: null }),
    // Today a successful rebuild publishes the frame and marks the UI up; a failed one is silent (the repair script
    // logs its own reason).
    effects: (_state, event) => (event.ok ? [apply({ kind: 'mark-ui-up' }), emit()] : NO_EFFECTS),
  },
  'restart.requested': {
    guard: entryGuard,
    apply: (state, event) =>
      enter(
        state,
        'restart',
        event.token,
        progressOf('restarting-remote', { pid: Number(event.pid) || 0, port: Number(event.port) || 0 }),
        {
          desired: 'connected',
        },
      ),
    effects: (state, event) => requestEffects(state, event.token, 'restart'),
  },
  'restart.resumed': {
    guard: ownsActivity('restart'),
    apply: (state, event) => {
      // Only the "managed stop was not confirmed" caller warns; a restart cancelled before that resumes plainly.
      const keptInstance = event.keptInstance === true
      return move(state, {
        status: 'connected',
        warning: keptInstance ? RESTART_STOP_WARNING : state.warning,
        warningSource: keptInstance ? 'restart-stop' : state.warningSource,
        phase: 'ready',
        progress: progressOf('ready'),
        error: null,
        activity: null,
      })
    },
    effects: (_state, _event, scope) => [
      apply({ kind: 'mark-ui-up' }),
      arm('heartbeat', scope.delays.heartbeatMs),
      emit(),
    ],
  },
  'restart.failed': {
    guard: ownsActivity('restart'),
    apply: (state, event) => toError(state, event.view),
    effects: (_state, event, scope) => [
      apply({ kind: 'mark-detached' }),
      logFailure(event.phase),
      teardown({ stopRemote: scope.keepAlive === 'stop' }),
      emit(),
    ],
  },
  'stop.requested': {
    guard: entryGuard,
    apply: (state, event) =>
      enter(
        state,
        'stop',
        event.token,
        progressOf('stopping-remote', { pid: Number(event.pid) || 0, port: Number(event.port) || 0 }),
      ),
    effects: (state, event) => requestEffects(state, event.token, 'stop'),
  },
  'stop.refused': {
    guard: ownsActivity('stop'),
    apply(state, event) {
      // Unrestorable: the link vanished while the stop was failing, so publish the coded failure, not a fake state.
      if (event.unrestorable === true) return toError(state, event.view)
      const previous: StopSnapshot = event.previous
      return move(state, {
        status: previous.status,
        error: previous.error,
        phase: previous.phase,
        progress: previous.progress,
        activity: null,
      })
    },
    effects: (_state, event, scope) => [
      event.unrestorable === true
        ? apply({ kind: 'mark-detached' })
        : apply({ kind: 'restore-stop', uiReady: event.previous.uiReady, localPort: event.previous.localPort }),
      // A restored `connected` link is live again: `resumeConnected` restarted the heartbeat the stop disarmed.
      ...(event.unrestorable === true || event.previous.status !== 'connected'
        ? []
        : [arm('heartbeat', scope.delays.heartbeatMs)]),
      logFailure(event.phase, STOP_FAILED_LABEL, event.view),
      emit(),
    ],
  },
  'stop.succeeded': {
    guard: ownsActivity('stop'),
    apply: (state) => released(state),
    effects: () => [teardown({ stopRemote: false, stopped: true }), apply({ kind: 'mark-detached' }), emit()],
  },
  'reattach.requested': {
    guard: (state, _event, scope) => {
      if (state.activity !== null) return 'busy'
      if (state.status !== 'connected' || !scope.tunnelAlive) return 'not-connected'
      return true
    },
    apply: (state, event) =>
      enter(state, 'reattach', event.token, progressOf('restarting-remote', { reason: event.reason })),
    effects: (state, event) => requestEffects(state, event.token, 'reattach'),
  },
  'reattach.failed': {
    guard: ownsActivity('reattach'),
    apply: (state, event) => toError(state, event.view),
    effects: (state) => [
      apply({ kind: 'mark-detached' }),
      closeLink(),
      disarm('heartbeat'),
      logFailure(state.phase),
      emit(),
    ],
  },
  'reconnect.scheduled': {
    guard: (state) => (state.desired === 'connected' ? true : 'illegal-transition'),
    apply: (state, event) =>
      move(state, {
        reconnectAttempts: event.attempt,
        progress: progressOf('reconnecting', { attempt: event.attempt, max: event.max }),
      }),
    effects: (_state, event) => [arm('reconnect', event.delayMs), emit()],
  },
  'reconnect.gaveup': {
    guard: (state) => (state.desired === 'connected' ? true : 'illegal-transition'),
    apply: (state, event) => move(state, { status: 'error', error: event.view, progress: null }),
    effects: () => EMIT_ONLY,
  },
  'reconnect.skipped': {
    // The executor already took the policy decision; the machine only records the outcome the Client renders.
    // `progress` is deliberately left alone: today's `scheduleReconnect` patched only the status, so a dropped link
    // that was not retried keeps the `reconnecting` line it had published.
    guard: () => true,
    apply: (state) => move(state, { status: 'disconnected' }),
    effects: () => EMIT_ONLY,
  },
  'link.cancelled': {
    guard: () => true,
    // Today's `cancelLinkWork` clears unconditionally; the event carries no token, so nothing can be checked here.
    apply: (state) => move(state, { epoch: state.epoch + 1, activity: null }),
    effects: () => [log('debug', 'link work cancelled')],
  },
  shutdown: {
    guard: () => true,
    // `activity: null` is today's `cancelLinkWork`; a leftover action name would describe work that no longer runs.
    apply: (state) => move(state, { closing: true, desired: 'idle', epoch: state.epoch + 1, activity: null }),
    effects: (_state, _event, scope) => [
      disarm('reconnect'),
      disarm('idle'),
      disarm('heartbeat'),
      disarm('remoteCheck'),
      settlePrompts(),
      teardown({ stopRemote: scope.keepAlive === 'stop', shutdown: true }),
    ],
  },
  'host.removed': {
    guard: () => true,
    apply: (state) => move(state, { desired: 'idle', activity: null, epoch: state.epoch + 1 }),
    effects: (_state, event) => [
      disarm('reconnect'),
      disarm('idle'),
      settlePrompts(),
      teardown({ stopRemote: event.keepAlive === 'stop' }),
      emit(),
    ],
  },
}

/** The state the "the transport dropped under a live link" branch produces. */
function transportDropPatch(state: SessionState): Partial<SessionState> {
  return {
    status: 'disconnected',
    transportLost: true,
    activity: null,
    epoch: state.epoch + 1,
    phase: null,
    progress: progressOf('reconnecting', { attempt: state.reconnectAttempts + 1 }),
  }
}

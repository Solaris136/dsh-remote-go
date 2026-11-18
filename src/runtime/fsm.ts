/**
 * The `HostRuntime.session` state machine: a pure `transition(state, event, scope)`.
 *
 * This file is the only place allowed to decide what a host runtime's session block becomes next
 * (design-arch §2.4). It imports **no I/O**: no runtime object, no clock, no settings, no timers.
 * Everything outside the state arrives as a frozen `EventScope`; everything the executor has to do
 * arrives as an `Effect` it performs itself. `test/unit/fsm.test.ts` drives all
 * 8 statuses × 6 activities × 2 desires × 2 closing flags = 192 representative states against all
 * 31 events (5,952 pairs) and asserts every pair has an explicit outcome: `ok: true` with effects,
 * or `ok: false` with a `RefusalReason` — never an "unhandled" third shape.
 *
 * This table does **not** own liveness. `remote.suspected/confirmed/recovered` used to live here and
 * were never dispatched (nothing in `src/` ever emitted one); the watchdog (`watchdog.ts`) owns
 * `remoteEpisode`/`episodeSource`/`remoteFailures`/`episodeCooldownUntil` and publishes its own
 * bus events, so a second liveness writer in the FSM would have been a second source of truth.
 *
 * The table is a `Record<EventType, Rule>` over the 31 names `events.ts` declares, so a missing
 * event is a compile error and an unlisted event cannot reach a rule. A refused transition returns
 * the *same* state object: "invalid transitions never modify the state" is structural, not a
 * promise the implementation has to remember.
 *
 * Semantics worth calling out (all from §2.4.5):
 * - `activity` is the single flight lock. `null` means no one-shot action owns the link, so every
 *   entry point except `connect.requested` requires it; `connect.requested` refuses with
 *   `already-connecting`/`already-restarting`/`already-connected`, the strings `api.ts` passes on.
 * - `epoch` (== the storage field `linkToken`) is the late-write filter. Request events adopt the
 *   caller's token through `epochAfter()`, which never lets the number go backwards; cancel events
 *   bump it. A late script compares `state.epoch` with its own token and stops writing.
 * - `desired` is what the user wants, `status` is what is observed; they are deliberately not
 *   derived from each other.
 */
import type { ErrorView } from '../errors.js'
import type { BilingualText } from '../util.js'
import type {
  Activity,
  Desired,
  ConnectPhase,
  HostStatus,
  Progress,
  RuntimeSession,
  WarningSource,
} from '../host-runtime.js'
import type { ArmableTimer, Effect, Event, EventScope, EventType, StopSnapshot, TimerName } from './events.js'

/* ── state ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The pure rendition of the session block (design-arch §2.4.1).
 *
 * It carries `activity`/`epoch` where the storage form carries `linkBusy`/`linkToken`, and it drops
 * the three executor-held promises. The liveness fields are **not** part of it: the watchdog owns
 * them (see the module comment). `writeBack()` converts on the way out.
 */
export interface SessionState {
  status: HostStatus
  desired: Desired
  activity: Activity | null
  phase: ConnectPhase | null
  progress: Progress | null
  error: ErrorView | null
  warning: BilingualText | null
  warningSource: WarningSource | null
  closing: boolean
  /** (H2) the user said "no": no automatic retry, because a retry would ask the same question. */
  connectCancelled: boolean
  /** (H3) the transport dropped during this attempt; the failure is a lost link, not a decision. */
  transportLost: boolean
  /** (H2) the retry budget; only `connect.requested` and `connect.succeeded` reset it. */
  reconnectAttempts: number
  /** (R10) the one-shot action token. Monotone; compared, never decremented. */
  epoch: number
}

/* ── results ─────────────────────────────────────────────────────────────────────────────── */

/** Why a dispatch was refused. `api.ts` forwards the three `already-*`/`busy` strings verbatim. */
export type RefusalReason =
  | 'illegal-transition'
  | 'unknown-event'
  | 'already-connecting'
  | 'already-restarting'
  | 'already-connected'
  | 'not-connected'
  | 'not-recoverable'
  | 'busy'
  | 'prompt-not-pending'
  | 'stale-prompt'

/** The exhaustive list of refusals, for tests that assert "no third outcome" (§7.6). */
export const REFUSALS = [
  'illegal-transition',
  'unknown-event',
  'already-connecting',
  'already-restarting',
  'already-connected',
  'not-connected',
  'not-recoverable',
  'busy',
  'prompt-not-pending',
  'stale-prompt',
] as const satisfies readonly RefusalReason[]

/**
 * `ok` is the only discriminant: a caller narrows with `if (!result.ok)`. A refusal carries the
 * input state unchanged (same reference), so nothing can have observed a half-applied move.
 */
export type TransitionResult =
  | { ok: true; state: SessionState; effects: readonly Effect[] }
  | { ok: false; reason: RefusalReason; state: SessionState }

export function isRefusal(result: TransitionResult): result is Extract<TransitionResult, { ok: false }> {
  return result.ok === false
}

/** Never reaches `ErrorView`: only a script that ran into a refusal treats it as a bug (§7.6). */
export class IllegalTransition extends Error {
  readonly code = 'illegal-transition' as const
  readonly eventType: EventType

  constructor(reason: RefusalReason, eventType: EventType) {
    super(`illegal transition: ${eventType} refused (${reason})`)
    this.name = 'IllegalTransition'
    this.eventType = eventType
  }
}

/* ── the two shared predicates (single implementation, §2.4.4) ────────────────────────────── */

/** "The user still wants this link, and this process still owns the runtime." */
export function stillWanted(state: SessionState, scope: EventScope): boolean {
  return state.desired === 'connected' && !state.closing && scope.runtimeExists && !scope.disposed
}

/** `state.epoch === token`: a one-shot action may write (R4). */
export function isActivityCurrent(state: SessionState, token: number): boolean {
  return state.epoch === token
}

/* ── executor helpers ────────────────────────────────────────────────────────────────────── */

/** The two bilingual texts the FSM itself owns; step 4 removes the pipeline's copies. */
export const RESTART_STOP_WARNING: BilingualText = {
  zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试，或先断开再重连。',
  en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly, or disconnect and reconnect.',
}

export const STOP_FAILED_LABEL: BilingualText = {
  zh: '关闭远端 DSH 失败',
  en: 'Stopping the remote DSH failed',
}

/** Put the session block of a runtime back to the state the machine produced (§7.6). */
export function writeBack(runtime: RuntimeSession, state: SessionState): void {
  runtime.status = state.status
  runtime.desired = state.desired
  runtime.linkBusy = state.activity
  runtime.linkToken = state.epoch
  runtime.phase = state.phase
  runtime.progress = state.progress
  runtime.error = state.error
  runtime.warning = state.warning
  runtime.warningSource = state.warningSource
  runtime.closing = state.closing
  runtime.connectCancelled = state.connectCancelled
  runtime.transportLost = state.transportLost
  runtime.reconnectAttempts = state.reconnectAttempts
  // The liveness fields (`remoteFailures`/`remoteEpisode`/`episodeSource`/`episodeCooldownUntil`)
  // are deliberately absent: `watchdog.ts` is their only writer (B9); see docs/invariants.md.
}

/* ── rule plumbing ───────────────────────────────────────────────────────────────────────── */

type GuardVerdict = true | RefusalReason
type NarrowEvent<K extends EventType> = Extract<Event, { type: K }>

interface RuleOf<K extends EventType> {
  guard(state: SessionState, event: NarrowEvent<K>, scope: EventScope): GuardVerdict
  apply(state: SessionState, event: NarrowEvent<K>, scope: EventScope): SessionState
  effects(state: SessionState, event: NarrowEvent<K>, scope: EventScope): readonly Effect[]
}

/** One rule per declared event; `Record` over the union makes a missing event a type error. */
type RuleTable = { readonly [K in EventType]: RuleOf<K> }

function move(state: SessionState, changes: Partial<SessionState>): SessionState {
  return { ...state, ...changes }
}

/**
 * Adopt a caller's token without ever rewinding the epoch. `beginLinkWork` passes `epoch + 1`; a
 * stale token (a timer that fired after a cancel) can then never take ownership back.
 */
function epochAfter(state: SessionState, token: number): number {
  return Math.max(state.epoch, token)
}

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
  // Only a rule that restores a *previous* error needs to name the failure it reports: the
  // executor otherwise logs the error the transition just wrote.
  ...(view === undefined ? {} : { view }),
})
const apply = (patch: Extract<Effect, { type: 'apply' }>['patch']): Effect => ({ type: 'apply', patch })
const teardown = (options: Extract<Effect, { type: 'teardown' }>['options']): Effect => ({ type: 'teardown', options })
const run = (activity: Activity, token: number): Effect => ({ type: 'run', activity, token })

/** The `transport.closed` branches (§2.4.2): today's `connect/pipeline.ts#watchTransport`, verbatim. */
type TransportCloseBranch = 'ignored' | 'stale' | 'dropped' | 'handshake' | 'idle'

function transportCloseBranch(state: SessionState, scope: EventScope): TransportCloseBranch {
  // This close is a teardown's own closing, or the user already let go: nothing to report.
  if (state.closing || state.desired !== 'connected') return 'ignored'
  // A newer transport owns the link; this one is the previous attempt's.
  if (!scope.transportIsCurrent) return 'stale'
  // `live` mirrors today's `status === 'connected' || linkBusy !== null`: a connect attempt is
  // tracked by `activity === 'connect'` and has its own branch below (it must not schedule the
  // retry twice — the pipeline's single exit reports it, H2/H3).
  if (state.status === 'connected' || (state.activity !== null && state.activity !== 'connect')) return 'dropped'
  if (state.activity === 'connect') return 'handshake'
  return 'idle'
}

/** The restart/stop entry guard: connected now, or a `remote-unreachable` error that can recover. */
function entryGuard(state: SessionState, scope: EventScope): GuardVerdict {
  if (state.activity !== null) return 'busy'
  if (state.status === 'connected') return true
  if (state.status === 'error') return scope.recoverable ? true : 'not-recoverable'
  return 'not-connected'
}

/* ── the table (one row per event, design-arch §2.4.2) ───────────────────────────────────── */

const TABLE: RuleTable = {
  'connect.requested': {
    guard(state, _event, scope) {
      // `promises.connect === null` from the design is `activity === null` here: §2.4.5 makes the
      // promise executor-held and the activity its authoritative lock.
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
        // A scheduled retry re-enters the pipeline without the user asking; only a user-requested
        // connect gets a fresh budget (R5/H2, design-arch §2.4.5).
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
    guard: (state) => (state.activity === null ? 'illegal-transition' : true),
    apply: (state, event) => move(state, { phase: event.phase, progress: progressOf(event.code, event.params) }),
    effects: () => [emit()],
  },
  'step.done': {
    guard: (state) => (state.activity === null ? 'illegal-transition' : true),
    apply: (state) => state,
    // Today probe/node/tunnel/verify completions only log; they do not publish a frame.
    effects: (_state, event) => [log('debug', `step done: ${event.step}`)],
  },
  'transport.ready': {
    guard: (state) => (state.activity === null ? 'illegal-transition' : true),
    apply: (state) => move(state, { transportLost: false }),
    effects: () => [],
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
      return []
    },
  },
  'hostkey.pending': {
    guard: (state) => (state.status === 'connecting' ? true : 'illegal-transition'),
    apply: (state, event) =>
      move(state, {
        status: 'fingerprint-pending',
        phase: 'ssh',
        // Same keys `prompts.ts` publishes today, including the jump-specific identity so a jump
        // pin can never be shown as the target's (B1).
        progress:
          event.role === 'jump'
            ? progressOf('host-key-confirm', {
                sha256: event.info.sha256,
                keyType: event.info.keyType,
                role: 'jump',
                host: event.host,
              })
            : progressOf('host-key-confirm', { sha256: event.info.sha256, keyType: event.info.keyType }),
      }),
    effects: () => [emit()],
  },
  'hostkey.answered': {
    guard: (state, _event, scope) => {
      if (!scope.promptsPending) return 'stale-prompt'
      return state.status === 'fingerprint-pending' ? true : 'prompt-not-pending'
    },
    apply: (state, event) =>
      move(state, {
        status: 'connecting',
        progress: progressOf('auth-checking'),
        connectCancelled: !event.accept,
      }),
    effects: () => [emit()],
  },
  'hostkey.timeout': {
    guard: (state, _event, scope) => {
      if (!scope.promptsPending) return 'stale-prompt'
      return state.status === 'fingerprint-pending' ? true : 'prompt-not-pending'
    },
    apply: (state, event) =>
      move(state, {
        status: 'error',
        error: event.view,
        phase: null,
        progress: null,
        connectCancelled: true,
      }),
    effects: () => [emit()],
  },
  'conflict.pending': {
    guard: (state) => (state.status === 'connecting' ? true : 'illegal-transition'),
    apply: (state, event) =>
      move(state, {
        status: 'conflict-pending',
        progress: progressOf('remote-dsh-running', { count: event.count }),
      }),
    effects: () => [emit()],
  },
  'conflict.answered': {
    guard: (state, _event, scope) => {
      if (!scope.promptsPending) return 'stale-prompt'
      return state.status === 'conflict-pending' ? true : 'prompt-not-pending'
    },
    apply: (state, event) =>
      move(state, {
        status: 'connecting',
        progress: progressOf('probing'),
        // The user said "no": a retry would ask the same question, so the failure that follows must
        // not schedule one (today's `resolveForeignConflict` sets this flag next to the throw; the
        // decision itself is the transition that knows it).
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
      // A fresh attach makes a stale "stop not confirmed" warning go away; an `alongside` warning
      // still describes a process that is running, so it survives (see `warningSource`).
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
    guard: (state) => (state.activity === null ? 'illegal-transition' : true),
    apply: (state) => move(state, { status: 'disconnected', error: null, phase: null, progress: null, activity: null }),
    // Today's cancel branch published `uiReady:false`/`localPort:null` next to the status (the
    // §2.4.2 row only names the teardown); a cancelled attempt that had already set `uiReady`
    // must not leave a half-attached remote view behind.
    effects: () => [teardown({ stopRemote: false, keepRemote: true }), apply({ kind: 'mark-detached' }), emit()],
  },
  'connect.failed': {
    // The one explicit idempotent self-transition: the host-key timeout and the pipeline catch both
    // report the same failure, so `error` → `error` must be allowed (§2.4.2).
    //
    // Any status: the attempt can fail while it is parked on a prompt (`fingerprint-pending`,
    // `conflict-pending`) — the transport closing under a parked host-key prompt is exactly H3's
    // "dropped link", and today's pipeline catch reports it as a connection failure from there.
    // `activity !== null` is the real guard: a failure belongs to the script that owns the link.
    guard: (state) => (state.activity === null ? 'illegal-transition' : true),
    apply: (state, event) =>
      move(state, {
        status: 'error',
        error: event.view,
        phase: null,
        progress: null,
        activity: null,
        // Today's pipeline clears the flag after it has made the retry decision; keeping the same
        // storage means the next attempt (which may be a retry) starts with "not cancelled".
        connectCancelled: false,
      }),
    effects: (state, event, scope) => [
      apply({ kind: 'mark-detached' }),
      logFailure(event.phase),
      teardown({
        stopRemote: scope.remoteStarted && scope.keepAlive === 'stop',
        keepRemote: scope.remoteStarted && scope.keepAlive !== 'stop',
      }),
      // The retry decision itself (policy switch, budget, randomized delay) stays in the executor's
      // scheduleReconnect; here only "does a retry even make sense" is decided.
      ...(state.desired === 'connected' && !state.connectCancelled ? [arm('reconnect', scope.delays.reconnectMs)] : []),
      emit(),
    ],
  },
  'disconnect.requested': {
    // Total on purpose: the user may cancel during any connect step (M1/H4), and a repeat
    // disconnect on an already disconnected host is idempotent today (§2.4.2's third exception).
    guard: () => true,
    apply: (state) =>
      move(state, {
        status: 'disconnected',
        desired: 'idle',
        epoch: state.epoch + 1,
        activity: null,
        phase: null,
        progress: null,
        closing: false,
      }),
    effects: (state, event, scope) => {
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
    // A timer that fires for a host the user wants again is stale. Refusing keeps the "run the idle
    // script" path unambiguous; the script re-checks `stillWanted` anyway (H1). Step 4 must log
    // this refusal at debug ("idle stop skipped: the host is connected again"), not at the generic
    // warn level the other out-of-script refusals get — today's `stopRemoteForIdle` says debug.
    guard: (state, _event, scope) => (stillWanted(state, scope) ? 'illegal-transition' : true),
    apply: (state) => state,
    effects: () => [],
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
    guard: (state) => (state.activity === 'repair' ? true : 'illegal-transition'),
    apply: (state) => move(state, { activity: null }),
    // Today a successful rebuild publishes the frame and marks the UI up; a failed one is silent
    // (the repair script logs its own reason).
    effects: (_state, event) => (event.ok ? [apply({ kind: 'mark-ui-up' }), emit()] : []),
  },
  'restart.requested': {
    guard: (state, _event, scope) => entryGuard(state, scope),
    apply: (state, event) =>
      move(state, {
        activity: 'restart',
        epoch: epochAfter(state, event.token),
        status: 'connecting',
        desired: 'connected',
        phase: 'start',
        progress: progressOf('restarting-remote', {
          pid: Number(event.pid) || 0,
          port: Number(event.port) || 0,
        }),
        error: null,
      }),
    effects: (state, event) => [
      disarm('heartbeat'),
      disarm('reconnect'),
      disarm('idle'),
      // Today's request event emitted the new `connecting` card from `progress.set`; the rule owns
      // that publication now (the design row listed only the disarms and `run`).
      emit(),
      run('restart', epochAfter(state, event.token)),
    ],
  },
  'restart.resumed': {
    guard: (state) => (state.activity === 'restart' ? true : 'illegal-transition'),
    apply: (state, event) => {
      // Only the "the managed stop was not confirmed, so the old instance was kept" caller warns;
      // a restart that was cancelled before touching anything resumes without a warning.
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
    guard: (state) => (state.activity === 'restart' ? true : 'illegal-transition'),
    apply: (state, event) =>
      move(state, { status: 'error', error: event.view, phase: null, progress: null, activity: null }),
    effects: (_state, event, scope) => [
      apply({ kind: 'mark-detached' }),
      logFailure(event.phase),
      teardown({ stopRemote: scope.keepAlive === 'stop' }),
      emit(),
    ],
  },
  'stop.requested': {
    guard: (state, _event, scope) => entryGuard(state, scope),
    apply: (state, event) =>
      move(state, {
        activity: 'stop',
        epoch: epochAfter(state, event.token),
        status: 'connecting',
        phase: 'start',
        progress: progressOf('stopping-remote', {
          pid: Number(event.pid) || 0,
          port: Number(event.port) || 0,
        }),
        // Today's `runStopRemote` clears the previous error as it enters the action.
        error: null,
      }),
    effects: (state, event) => [
      disarm('heartbeat'),
      disarm('reconnect'),
      disarm('idle'),
      // Today's `progress.set` published the "stopping" card; the rule owns it now.
      emit(),
      run('stop', epochAfter(state, event.token)),
    ],
  },
  'stop.refused': {
    guard: (state) => (state.activity === 'stop' ? true : 'illegal-transition'),
    apply(state, event) {
      if (event.unrestorable === true) {
        // §2.4.2's "恢复不了则落 error": the link vanished (or was replaced) while the stop was
        // failing, so `resumeConnected` refused and the coded failure is published instead of a
        // fake connected state.
        return move(state, {
          status: 'error',
          error: event.view,
          phase: null,
          progress: null,
          activity: null,
        })
      }
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
      // A restored `connected` means the link is live again: today's `resumeConnected` restarted
      // the heartbeat the stop had disarmed. The §2.4.2 row omits it; without it a host left in
      // `connected` would never be probed again (behavior freeze wins).
      ...(event.unrestorable === true || event.previous.status !== 'connected'
        ? []
        : [arm('heartbeat', scope.delays.heartbeatMs)]),
      logFailure(event.phase, STOP_FAILED_LABEL, event.view),
      emit(),
    ],
  },
  'stop.succeeded': {
    guard: (state) => (state.activity === 'stop' ? true : 'illegal-transition'),
    apply: (state) =>
      move(state, {
        status: 'disconnected',
        desired: 'idle',
        epoch: state.epoch + 1,
        phase: null,
        progress: null,
        activity: null,
      }),
    effects: () => [teardown({ stopRemote: false, stopped: true }), apply({ kind: 'mark-detached' }), emit()],
  },
  'reattach.requested': {
    guard: (state, _event, scope) => {
      if (state.activity !== null) return 'busy'
      if (state.status !== 'connected' || !scope.tunnelAlive) return 'not-connected'
      return true
    },
    apply: (state, event) =>
      move(state, {
        activity: 'reattach',
        epoch: epochAfter(state, event.token),
        status: 'connecting',
        phase: 'start',
        progress: progressOf('restarting-remote', { reason: event.reason }),
        error: null,
      }),
    effects: (state, event) => [
      disarm('heartbeat'),
      disarm('reconnect'),
      disarm('idle'),
      // Today's `progress.set` published the "re-attaching" card; the rule owns it now.
      emit(),
      run('reattach', epochAfter(state, event.token)),
    ],
  },
  'reattach.failed': {
    guard: (state) => (state.activity === 'reattach' ? true : 'illegal-transition'),
    apply: (state, event) =>
      move(state, { status: 'error', error: event.view, phase: null, progress: null, activity: null }),
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
    effects: () => [emit()],
  },
  'reconnect.skipped': {
    // The executor already took the policy decision (no auto-reconnect, or the user let go); the
    // machine only records the outcome the Client renders.
    //
    // `progress` is deliberately left alone: today's `scheduleReconnect` patched only the status
    // here, so a dropped link that was not retried keeps the `reconnecting` line it had just
    // published. The §2.4.2 row says `progress=null`; behaviour freeze wins.
    guard: () => true,
    apply: (state) => move(state, { status: 'disconnected' }),
    effects: () => [emit()],
  },
  'link.cancelled': {
    guard: () => true,
    // Today's `cancelLinkWork` clears unconditionally; the canonical event carries no token, so
    // "was it this epoch's action" cannot be answered here (documented deviation).
    apply: (state) => move(state, { epoch: state.epoch + 1, activity: null }),
    effects: () => [log('debug', 'link work cancelled')],
  },
  shutdown: {
    guard: () => true,
    // `activity: null` is today's `cancelLinkWork` (the shutdown walks the registry after marking
    // every link dead); leaving an action name behind would make the block describe work that no
    // longer runs.
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

/** The state the "the transport dropped under a live link" branch produces (§2.4.2 row 3). */
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

/* ── the pure function ───────────────────────────────────────────────────────────────────── */

/**
 * Look one rule up by its event name. Generic on the key so the returned rule keeps the *narrow*
 * event payload of that row: `TABLE[event.type]` in `transition` would otherwise be a union of 31
 * rule types with 31 different parameter types, which TypeScript cannot correlate with the event
 * it was indexed by.
 */
function ruleFor<K extends EventType>(type: K): RuleOf<K> {
  return TABLE[type]
}

/**
 * Compute the next state and the effects of one event. Never mutates, never throws, never reads
 * anything but its three arguments.
 * @param state - the session state before the event.
 * @param event - the event to apply (one of the 31 declared types).
 * @param scope - read-only facts the guards and effects need.
 * @returns `{ok:true,state,effects}` for an accepted move; `{ok:false,reason,state}` (same state
 * object) for a refused one.
 */
export function transition(state: SessionState, event: Event, scope: EventScope): TransitionResult {
  // The table is a record over the 31 declared names, so this lookup cannot miss for a typed
  // caller; the `unknown-event` branch only protects a JavaScript caller from a name the types
  // forbid (and the completeness test asserts it never fires for a declared event).
  const rule: RuleOf<EventType> | undefined = ruleFor(event.type)
  if (rule === undefined) return { ok: false, reason: 'unknown-event', state }
  const verdict = rule.guard(state, event, scope)
  if (verdict !== true) return { ok: false, reason: verdict, state }
  return { ok: true, state: rule.apply(state, event, scope), effects: rule.effects(state, event, scope) }
}

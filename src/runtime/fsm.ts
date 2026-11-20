/** The `HostRuntime.session` state machine: a pure `transition(state, event, scope)` whose table lives in `rules.ts`.
 * No I/O and no runtime object; a refusal returns the *same* state. `activity` is the single-flight lock, `epoch` the
 * late-write filter, and liveness stays with the watchdog. `desired`/`status` are not derived from each other. */
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
import type { Effect, Event, EventScope, EventType } from './events.js'
import { TABLE, type RuleOf } from './rules.js'

/** The pure rendition of the session block: `activity`/`epoch` where storage has `linkBusy`/`linkToken`, and none of
 * the three executor-held promises; `writeBack()` converts on the way out. */
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
  /** The user said "no": no automatic retry, because a retry would ask the same question. */
  connectCancelled: boolean
  /** The transport dropped during this attempt; the failure is a lost link, not a decision. */
  transportLost: boolean
  /** The retry budget; only `connect.requested` and `connect.succeeded` reset it. */
  reconnectAttempts: number
  /** The one-shot action token. Monotone; compared, never decremented. */
  epoch: number
}

/** The exhaustive list of refusals, for tests that assert "no third outcome": every pair is `ok` or a refusal. */
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
] as const
/** Why a dispatch was refused; `api.ts` forwards the `already-*`/`busy` strings to the Client verbatim. */
export type RefusalReason = (typeof REFUSALS)[number]
/** `ok` is the only discriminant (narrow with `if (!result.ok)`); a refusal carries the input state unchanged, so
 * nothing can have observed a half-applied move. */
export type TransitionResult =
  | { ok: true; state: SessionState; effects: readonly Effect[] }
  | { ok: false; reason: RefusalReason; state: SessionState }

export function isRefusal(result: TransitionResult): result is Extract<TransitionResult, { ok: false }> {
  return result.ok === false
}

/** Never reaches `ErrorView`: only a script that ran into a refusal treats it as a bug. */
export class IllegalTransition extends Error {
  readonly code = 'illegal-transition' as const
  readonly eventType: EventType

  constructor(reason: RefusalReason, eventType: EventType) {
    super(`illegal transition: ${eventType} refused (${reason})`)
    this.name = 'IllegalTransition'
    this.eventType = eventType
  }
}

/** "The user still wants this link, and this process still owns the runtime." */
export function stillWanted(state: SessionState, scope: EventScope): boolean {
  return state.desired === 'connected' && !state.closing && scope.runtimeExists && !scope.disposed
}

/** `state.epoch === token`: a one-shot action may write. */
export function isActivityCurrent(state: SessionState, token: number): boolean {
  return state.epoch === token
}

/** Put the session block of a runtime back to the state the machine produced. */
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
  // The liveness fields (`remoteFailures`/`remoteEpisode`/`episodeSource`/`episodeCooldownUntil`) are deliberately
  // absent: `watchdog.ts` is their only writer.
}

/** Look one rule up by its event name, generic on the key so the returned rule keeps the *narrow* payload of that row:
 * `TABLE[event.type]` in `transition` would otherwise be a union of 31 rule types with 31 parameter types, which
 * TypeScript cannot correlate with the event it was indexed by. */
function ruleFor<K extends EventType>(type: K): RuleOf<K> {
  return TABLE[type]
}

/** Compute one event's next state and effects: never mutates, never throws, reads only its three arguments. */
export function transition(state: SessionState, event: Event, scope: EventScope): TransitionResult {
  // The table covers the 31 declared names, so a typed caller cannot miss; `unknown-event` only guards a JS caller.
  const rule: RuleOf<EventType> | undefined = ruleFor(event.type)
  if (rule === undefined) return { ok: false, reason: 'unknown-event', state }
  const verdict = rule.guard(state, event, scope)
  if (verdict !== true) return { ok: false, reason: verdict, state }
  return { ok: true, state: rule.apply(state, event, scope), effects: rule.effects(state, event, scope) }
}

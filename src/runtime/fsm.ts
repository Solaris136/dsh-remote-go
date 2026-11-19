/**
 * The `HostRuntime.session` state machine: a pure `transition(state, event, scope)`, plus the
 * types and the write-back the executor uses.
 *
 * The transition table itself (one `Record<EventType, Rule>` row per event, its guards and its
 * effects) lives in `rules.ts` next door; this file is the engine that looks a row up and applies
 * it. Both halves together are the only place allowed to decide what a host runtime's session block
 * becomes next (design-arch §2.4). Neither imports I/O: no runtime object, no clock, no settings,
 * no timers. Everything outside the state arrives as a frozen `EventScope`; everything the
 * executor has to do arrives as an `Effect` it performs itself. `test/unit/fsm.test.ts` drives all
 * 8 statuses × 6 activities × 2 desires × 2 closing flags = 192 representative states against all
 * 31 events (5,952 pairs) and asserts every pair has an explicit outcome: `ok: true` with effects,
 * or `ok: false` with a `RefusalReason` — never an "unhandled" third shape.
 *
 * The machine does **not** own liveness. `remote.suspected/confirmed/recovered` used to live here
 * and were never dispatched (nothing in `src/` ever emitted one); the watchdog (`watchdog.ts`) owns
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
import type { Effect, Event, EventScope, EventType } from './events.js'
import { TABLE, type RuleOf } from './rules.js'

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

/* ── write-back ─────────────────────────────────────────────────────────────────────────── */

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

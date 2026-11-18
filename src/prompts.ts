/**
 * The two prompts a connection can pause on (unknown host key, foreign DSH already running) and the answers the Client sends back; each settles exactly once.
 *
 * The status/phase/progress writes are transitions now (`hostkey.pending` / `hostkey.answered` /
 * `hostkey.timeout` / `conflict.pending` / `conflict.answered`); this module only owns the two
 * deferred slots and the fingerprint/conflict data.
 */
import { errors, toErrorView } from './errors.js'
import type { PromptCtx } from './context.js'
import type { HostRuntime, RuntimeFingerprint } from './host-runtime.js'
import type { RemoteProcessRef } from './remote-proc.js'
import { dispatch, promptScopeFacts } from './runtime/dispatch.js'
import type { DispatchHost } from './runtime/dispatch.js'
import { createDecision, nowIso } from './util.js'

/** Which security context a host-key answer belongs to: the saved target, or the jump host dialling it. */
export type HostKeyRole = 'target' | 'jump'

/** The Client's answer to the host-key prompt: accept it, remember it, or refuse it. */
export interface FingerprintDecision {
  accept?: boolean
  remember?: boolean
  sha256?: string
}

/** The Client's answer to the foreign-DSH conflict prompt. */
export interface ConflictDecision {
  action?: unknown
}

/** The host key a prompt is about; a caller that only saw a fingerprint may omit the type. */
export interface AdvertisedHostKey {
  sha256: string
  keyType?: string
}

/** Where the answer belongs: the role always, the jump host's own identity when there is one. */
export interface HostKeyPromptOptions {
  role?: HostKeyRole
  host?: string | null
  port?: number
}

/**
 * The deferred one open host-key prompt holds.
 *
 * `resolve` is the deferred's settle seat (`createDecision`): it is idempotent, so a late answer
 * from the Client, the prompt's own timeout and a teardown can all reach it and the parked SSH
 * handshake still resolves exactly once. It is `null` only for the instant between building this
 * record and installing the decision, before the prompt is published to the runtime.
 */
export interface PendingHostKey {
  sha256: string
  keyType: string | undefined
  role: HostKeyRole
  host: string | null
  port: number
  resolve: ((accepted: boolean) => void) | null
}

/** The answers the conflict prompt accepts; anything else is refused as invalid input. */
export type ConflictAction = 'stop' | 'alongside' | 'cancel'

/** What the conflict prompt resolves with: the user's choice, or the timeout's own `cancel`. */
export interface ConflictAnswer {
  action: ConflictAction
  timedOut?: boolean
}

/**
 * The deferred one open conflict prompt holds. `resolve` is `createDecision`'s idempotent settle,
 * so the timeout and a late answer cannot both resolve the stalled pipeline.
 */
export interface PendingConflict {
  processes: ReadonlyArray<RemoteProcessRef>
  resolve: ((answer: ConflictAnswer) => void) | null
}

/**
 * The effect owner of this module.
 *
 * A prompt transition publishes a frame and (for `conflict.answered`) clears the conflict card;
 * it never arms a timer, touches the link or tears anything down. The heavy effects are declared so
 * the interface stays one shape, and throw if a future rule ever asks this module to perform one
 * (that would be a wiring bug: the prompt module has no deps slice).
 * @param ctx - the prompt context (settings, reporter, store).
 * @returns the effect owner for one prompt transition.
 */
function promptEffects(ctx: PromptCtx): DispatchHost {
  const noEffect = (name: string): never => {
    throw new Error(`dispatch: the prompt module cannot perform the ${name} effect`)
  }
  return {
    emit: () => ctx.emitState(),
    log: (runtime, level, message) => ctx.progress.log(runtime, level, message),
    logFailure: (runtime, phase, label, view) =>
      ctx.progress.logFailure(runtime, view ?? runtime.error, { phase, label }),
    arm: () => noEffect('arm'),
    disarm: () => noEffect('disarm'),
    settlePrompts: (runtime) => {
      cancelHostKeyPrompt(runtime)
      cancelConflict(runtime)
    },
    closeLink: () => noEffect('closeLink'),
    teardown: async () => noEffect('teardown'),
    apply: (runtime, patch) => {
      if (patch.kind === 'clear-conflict') {
        runtime.conflict = null
        return
      }
      noEffect('apply')
    },
    flushLogs: () => {
      // No prompt rule flushes the log ring.
    },
  }
}

/**
 * Park the SSH handshake until the user answers the fingerprint prompt.
 *
 * A jump host and the target are different machines with different keys: the `role`
 * decides which context the answer belongs to, so a jump-host confirmation can never be
 * mistaken for the target's (B1).
 *
 * @returns whether the user accepted the key.
 */
export function requestHostKey(
  ctx: PromptCtx,
  runtime: HostRuntime,
  info: AdvertisedHostKey,
  options: HostKeyPromptOptions = {},
): Promise<boolean> {
  const role: HostKeyRole = options.role === 'jump' ? 'jump' : 'target'
  const isJump = role === 'jump'
  // A per-host policy describes the target the user saved. A jump host has its own
  // security context, so only the global policy applies to it.
  const policy = isJump
    ? (ctx.settings()?.hostKeyPolicy ?? 'first-use')
    : (runtime.entry.hostKeyPolicy ?? ctx.settings()?.hostKeyPolicy ?? 'first-use')
  if (policy === 'strict') throw errors.hostKeyUnknown(info.sha256)
  const hostLabel = isJump && options.host ? ` ${options.host}` : ''
  ctx.progress.log(
    runtime,
    'info',
    `waiting for the ${isJump ? `jump host${hostLabel}` : 'host'} key to be confirmed (${
      info.keyType
    } ${info.sha256}); the SSH handshake is paused`,
  )
  const pending: PendingHostKey = {
    sha256: info.sha256,
    keyType: info.keyType,
    role,
    host: typeof options.host === 'string' && options.host !== '' ? options.host : null,
    port: Number(options.port) || 22,
    resolve: null,
  }
  const decision = createDecision<boolean>(
    ctx.timers.hostKeyConfirmMs,
    () => {
      // A prompt whose link already went away must not overwrite the state of that teardown.
      if (runtime.pendingHostKey !== pending) return false
      if (runtime.desired !== 'connected' || runtime.closing === true) return false
      // `hostkey.timeout` owns the `error` card and the "do not retry" flag; the slot itself is
      // cleared here (the settle hook below is idempotent).
      void dispatch(
        promptEffects(ctx),
        runtime,
        { type: 'hostkey.timeout', view: toErrorView(errors.hostKeyUnknown(info.sha256)) },
        promptScopeFacts(runtime),
        { caller: 'timer' },
      )
      runtime.pendingHostKey = null
      return false
    },
    () => {
      if (runtime.pendingHostKey === pending) runtime.pendingHostKey = null
    },
  )
  pending.resolve = decision.settle
  runtime.pendingHostKey = pending
  // The card shows this while the prompt is open: nothing is pinned yet, so `pinned` stays null.
  const fingerprint: RuntimeFingerprint = {
    sha256: info.sha256,
    keyType: info.keyType,
    status: 'pending',
    pinned: null,
  }
  if (isJump) {
    // The jump pin belongs to *this* jump host: an edited `jumpHost` must not be checked
    // against the previous machine's key (review blocker 3).
    runtime.jumpFingerprint = { ...fingerprint, host: pending.host, port: pending.port }
    // The Client's dialog renders `HostView.fingerprint`, so the key being confirmed right now
    // has to be the one shown there - even though the pin it may produce stays separate (B1).
    runtime.fingerprint = { ...fingerprint }
  } else {
    runtime.fingerprint = fingerprint
  }
  // The dialog data is in place before the transition publishes the frame that shows it.
  void dispatch(
    promptEffects(ctx),
    runtime,
    {
      type: 'hostkey.pending',
      info: { sha256: info.sha256, keyType: info.keyType },
      role,
      host: pending.host,
      port: pending.port,
    },
    promptScopeFacts(runtime),
    { caller: 'callback' },
  )
  return decision.promise
}

/**
 * Answer the host-key prompt. Pinning is written straight through to the store so
 * a failed first attempt still remembers the key the user accepted.
 *
 * A jump host's key is remembered in memory only (`runtime.jumpFingerprint`): the store's
 * `pinnedFingerprint` describes the target, and writing a jump key there would pin the
 * target to the wrong machine forever (B1).
 */
export async function confirmHostKey(
  ctx: PromptCtx,
  runtime: HostRuntime,
  decision: FingerprintDecision,
): Promise<{ ok: boolean }> {
  // `unknown` on `host-runtime.ts`; this module is the slot's only writer (see PendingHostKey).
  const pending = runtime.pendingHostKey as PendingHostKey | null
  if (!pending) {
    throw errors.invalidInput('fingerprint', {
      zh: '没有待确认的主机指纹。',
      en: 'No host key is pending confirmation.',
    })
  }
  // A prompt is only answerable while it is the live one: a timeout, a disconnect or a
  // replacement attempt already settled it, and a late answer must not revive it (M1).
  if (runtime.status !== 'fingerprint-pending') {
    throw errors.invalidInput('fingerprint', {
      zh: '这个指纹提示已经失效，请在下次连接时重新确认。',
      en: 'This host-key prompt is no longer active; confirm the key on the next connection.',
    })
  }
  if (decision.sha256 && pending.sha256 && decision.sha256 !== pending.sha256) {
    throw errors.invalidInput('fingerprint', {
      zh: '确认的指纹与待确认的不一致。',
      en: 'The confirmed fingerprint does not match the pending one.',
    })
  }
  if (decision.accept && decision.remember && pending.role !== 'jump') {
    await ctx.store.patchHost(runtime.id, { pinnedFingerprint: pending.sha256 })
    runtime.entry = { ...runtime.entry, pinnedFingerprint: pending.sha256 }
  }
  const fingerprint = {
    sha256: pending.sha256,
    keyType: pending.keyType,
    status: 'pinned',
    pinned: decision.remember ? pending.sha256 : null,
  }
  if (pending.role === 'jump') {
    // Keep the identity with the pin: the same remembered pin may only be used for the same
    // jump host and port (review blocker 3).
    runtime.jumpFingerprint = { ...fingerprint, host: pending.host, port: pending.port }
    // The dialog that asked about the jump host must not start describing the target as soon
    // as it is answered: keep showing what was confirmed until the target is dialled.
    runtime.fingerprint = { ...fingerprint }
    ctx.progress.log(
      runtime,
      'info',
      `jump host key accepted${decision.remember ? ' and remembered for this session' : ''} (${
        pending.host ?? 'jump host'
      }: ${pending.sha256})`,
    )
  } else {
    runtime.fingerprint = fingerprint
  }
  // `hostkey.answered` owns the `connecting` card and the "user said no" flag. The slot is still
  // installed here (the rule's guard reads it) and is cleared right after, as before.
  void dispatch(
    promptEffects(ctx),
    runtime,
    { type: 'hostkey.answered', accept: decision.accept === true },
    promptScopeFacts(runtime),
    { caller: 'callback' },
  )
  runtime.pendingHostKey = null
  pending.resolve(decision.accept === true)
  return { ok: true }
}

/**
 * Abandon a pending host-key prompt (teardown, host removal, lost transport). Resolving it
 * with `false` makes the stalled `verifyHostKey` throw instead of holding the connect
 * promise open until the prompt times out (M1).
 */
export function cancelHostKeyPrompt(runtime: HostRuntime): void {
  // `unknown` on `host-runtime.ts`; this module is the slot's only writer (see PendingHostKey).
  const pending = runtime.pendingHostKey as PendingHostKey | null
  runtime.pendingHostKey = null
  if (pending) pending.resolve(false)
}

/**
 * Pause the pipeline for a decision about foreign remote processes.
 * Mirrors the host-key prompt: a status, a promise, and a bounded timeout.
 */
export function askConflict(
  ctx: PromptCtx,
  runtime: HostRuntime,
  processes: RemoteProcessRef[],
): Promise<ConflictAnswer> {
  // The card data is in place before the transition publishes the frame that renders it.
  runtime.conflict = {
    detectedAt: nowIso(),
    processes: processes.slice(0, 20).map((process) => ({
      pid: process.pid,
      command: String(process.command ?? '').slice(0, 400),
    })),
  }
  // A prompt the user never sees (the link was cancelled in the same tick) must not throw into
  // the pipeline; the refusal is logged and the caller's own guard reports the cancellation.
  void dispatch(
    promptEffects(ctx),
    runtime,
    { type: 'conflict.pending', count: processes.length },
    promptScopeFacts(runtime),
    { caller: 'callback' },
  )
  const decision = createDecision<ConflictAnswer>(
    ctx.timers.conflictConfirmMs,
    () => ({ action: 'cancel', timedOut: true }),
    (value) => {
      // The transition owns the `probing` card, the "user said no" flag and the conflict card.
      // A settlement that arrives after the link was torn down has no state to publish (the
      // teardown's own frame follows), so only the card is cleared here — the same guard today's
      // `desired === 'connected'` test provided, expressed on the status the rule checks.
      if (runtime.status === 'conflict-pending') {
        void dispatch(
          promptEffects(ctx),
          runtime,
          {
            type: 'conflict.answered',
            action: value.action,
            ...(value.timedOut === true ? { timedOut: true } : {}),
          },
          promptScopeFacts(runtime),
          { caller: 'silent' },
        )
      } else {
        runtime.conflict = null
      }
      // `unknown` on `host-runtime.ts`; this module is the slot's only writer (see PendingConflict).
      if ((runtime.pendingConflict as PendingConflict | null)?.resolve === decision.settle) {
        runtime.pendingConflict = null
      }
    },
  )
  runtime.pendingConflict = { processes, resolve: decision.settle }
  return decision.promise
}

export function confirmConflict(runtime: HostRuntime, decision?: ConflictDecision): { ok: boolean } {
  // `unknown` on `host-runtime.ts`; this module is the slot's only writer (see PendingConflict).
  const pending = runtime.pendingConflict as PendingConflict | null
  if (!pending) {
    throw errors.invalidInput('conflict', {
      zh: '没有待确认的远端 DSH 冲突。',
      en: 'No remote DSH conflict is pending confirmation.',
    })
  }
  const action = decision?.action
  if (action !== 'stop' && action !== 'alongside' && action !== 'cancel') {
    throw errors.invalidInput('conflict', {
      zh: '请选择停止手工实例、与它并存，或取消连接。',
      en: 'Choose whether to stop the manual instance, keep it alongside, or cancel.',
    })
  }
  // The three-way guard directly above is the runtime proof; `ConflictDecision.action` is
  // `unknown` on purpose (it is the Client's body) and inequality cannot narrow `unknown`, so the
  // assertion names the type the guard already established. It erases at emit time.
  pending.resolve({ action } as ConflictAnswer)
  return { ok: true }
}

/**
 * Abandon a pending conflict prompt (teardown). Resolving it with `cancel` makes
 * the stalled `askConflict` call return instead of holding the pipeline open.
 */
export function cancelConflict(runtime: HostRuntime): void {
  // `unknown` on `host-runtime.ts`; this module is the slot's only writer (see PendingConflict).
  const pending = runtime.pendingConflict as PendingConflict | null
  // The answer is delivered while the slot is still installed: the settlement hook's
  // `conflict.answered` guard reads it. Both the hook and this function clear the slot, and both
  // clears are idempotent (M1).
  if (pending) pending.resolve({ action: 'cancel' })
  runtime.pendingConflict = null
  runtime.conflict = null
}

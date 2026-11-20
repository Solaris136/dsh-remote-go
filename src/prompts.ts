/** The two prompts a connection can pause on (unknown host key, foreign DSH running) and the Client's answers; each
 * settles exactly once. Only the deferred slots and card data live here — the state writes belong to `dispatch.ts`. */
import { errors, toErrorView } from './errors.js'
import type { PromptCtx } from './context.js'
import type { HostRuntime, RuntimeFingerprint } from './host-runtime.js'
import type { RemoteProcessRef } from './remote-proc.js'
import { dispatch, promptScopeFacts } from './runtime/dispatch.js'
import type { DispatchCaller, DispatchHost } from './runtime/dispatch.js'
import type { Event } from './runtime/events.js'
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
export interface PendingHostKey {
  sha256: string
  keyType: string | undefined
  role: HostKeyRole
  host: string | null
  port: number
  resolve: ((accepted: boolean) => void) | null // `createDecision`'s idempotent settle seat
}
/** The answers the conflict prompt accepts; anything else is refused as invalid input. */
export type ConflictAction = 'stop' | 'alongside' | 'cancel'
/** What the conflict prompt resolves with: the user's choice, or the timeout's own `cancel`. */
export interface ConflictAnswer {
  action: ConflictAction
  timedOut?: boolean
}
export interface PendingConflict {
  processes: ReadonlyArray<RemoteProcessRef>
  resolve: ((answer: ConflictAnswer) => void) | null // idempotent, so a timeout and a late answer cannot both settle
}
/** The effect owner of this module: a prompt transition publishes a frame and, for `conflict.answered`, clears the
 * conflict card. The heavy effects are declared for one shape and throw if a rule asks this module to perform one. */
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
/** Publish one prompt transition through this module's effect owner. */
function publish(ctx: PromptCtx, runtime: HostRuntime, event: Event, caller: DispatchCaller): void {
  void dispatch(promptEffects(ctx), runtime, event, promptScopeFacts(runtime), { caller })
}
/** The two prompt slots are `unknown` on the runtime, and this module is their only writer. */
const pendingHostKeyOf = (runtime: HostRuntime): PendingHostKey | null =>
  runtime.pendingHostKey as PendingHostKey | null
const pendingConflictOf = (runtime: HostRuntime): PendingConflict | null =>
  runtime.pendingConflict as PendingConflict | null
/** A refusal the Client renders: the field it names and the bilingual reason. */
const reject = (field: string, zh: string, en: string) => errors.invalidInput(field, { zh, en })
/** Park the SSH handshake until the user answers the fingerprint prompt. The `role` decides which context the answer
 * belongs to: a jump host and the target are different machines with different keys, so neither can cross over. */
export function requestHostKey(
  ctx: PromptCtx,
  runtime: HostRuntime,
  info: AdvertisedHostKey,
  options: HostKeyPromptOptions = {},
): Promise<boolean> {
  const role: HostKeyRole = options.role === 'jump' ? 'jump' : 'target'
  const isJump = role === 'jump'
  // A per-host policy describes the saved target; a jump host has its own security context, so only the global applies.
  const policy = isJump
    ? (ctx.settings()?.hostKeyPolicy ?? 'first-use')
    : (runtime.entry.hostKeyPolicy ?? ctx.settings()?.hostKeyPolicy ?? 'first-use')
  if (policy === 'strict') throw errors.hostKeyUnknown(info.sha256)
  const where = isJump ? `jump host${options.host ? ` ${options.host}` : ''}` : 'host'
  ctx.progress.log(
    runtime,
    'info',
    `waiting for the ${where} key to be confirmed (${info.keyType} ${info.sha256}); the SSH handshake is paused`,
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
      // `hostkey.timeout` owns the `error` card and the "do not retry" flag; the slot is cleared here.
      publish(ctx, runtime, { type: 'hostkey.timeout', view: toErrorView(errors.hostKeyUnknown(info.sha256)) }, 'timer')
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
  // The jump pin belongs to *this* jump host: an edited `jumpHost` must not be checked against the previous key.
  // The dialog renders `HostView.fingerprint`, so it shows this pin now.
  runtime.fingerprint = { ...fingerprint }
  if (isJump) runtime.jumpFingerprint = { ...fingerprint, host: pending.host, port: pending.port }
  // The dialog data is in place before the transition publishes the frame that shows it.
  publish(
    ctx,
    runtime,
    {
      type: 'hostkey.pending',
      info: { sha256: info.sha256, keyType: info.keyType },
      role,
      host: pending.host,
      port: pending.port,
    },
    'callback',
  )
  return decision.promise
}
/** Answer the host-key prompt. Pinning is written straight through, so a failed attempt still remembers the accepted
 * key; a jump key stays in memory — the store's `pinnedFingerprint` describes the target and would pin it wrongly. */
export async function confirmHostKey(
  ctx: PromptCtx,
  runtime: HostRuntime,
  decision: FingerprintDecision,
): Promise<{ ok: boolean }> {
  const pending = pendingHostKeyOf(runtime)
  if (!pending) throw reject('fingerprint', '没有待确认的主机指纹。', 'No host key is pending confirmation.')
  // A prompt is answerable only while it is the live one: a timeout, a disconnect or a replacement already settled it.
  if (runtime.status !== 'fingerprint-pending') {
    throw reject(
      'fingerprint',
      '这个指纹提示已经失效，请在下次连接时重新确认。',
      'This host-key prompt is no longer active; confirm the key on the next connection.',
    )
  }
  if (decision.sha256 && pending.sha256 && decision.sha256 !== pending.sha256) {
    throw reject(
      'fingerprint',
      '确认的指纹与待确认的不一致。',
      'The confirmed fingerprint does not match the pending one.',
    )
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
    // Keep the identity with the pin (it serves only the same jump host and port) and keep showing it until the dial.
    runtime.jumpFingerprint = { ...fingerprint, host: pending.host, port: pending.port }
    runtime.fingerprint = { ...fingerprint }
    ctx.progress.log(
      runtime,
      'info',
      `jump host key accepted${decision.remember ? ' and remembered for this session' : ''} (${pending.host ?? 'jump host'}: ${pending.sha256})`,
    )
  } else {
    runtime.fingerprint = fingerprint
  }
  // `hostkey.answered` owns the `connecting` card and the "no" flag; its guard reads the slot, cleared after dispatch.
  publish(ctx, runtime, { type: 'hostkey.answered', accept: decision.accept === true }, 'callback')
  runtime.pendingHostKey = null
  pending.resolve(decision.accept === true)
  return { ok: true }
}
/** Abandon a pending host-key prompt (teardown, host removal, lost transport): resolving `false` makes the stalled
 * `verifyHostKey` throw instead of holding the connect promise open until the prompt times out. */
export function cancelHostKeyPrompt(runtime: HostRuntime): void {
  const pending = pendingHostKeyOf(runtime)
  runtime.pendingHostKey = null
  if (pending) pending.resolve(false)
}
/** Pause the pipeline for a decision about foreign remote processes: a status, a promise, a bounded timeout. */
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
  // A prompt the user never sees (link cancelled just now) must not throw: its refusal is logged, the caller guards.
  publish(ctx, runtime, { type: 'conflict.pending', count: processes.length }, 'callback')
  const decision = createDecision<ConflictAnswer>(
    ctx.timers.conflictConfirmMs,
    () => ({ action: 'cancel', timedOut: true }),
    (value) => {
      // The transition owns the cards and the "user said no" flag; a settlement after a teardown only clears the card.
      if (runtime.status === 'conflict-pending') {
        publish(
          ctx,
          runtime,
          { type: 'conflict.answered', action: value.action, ...(value.timedOut === true ? { timedOut: true } : {}) },
          'silent',
        )
      } else {
        runtime.conflict = null
      }
      if (pendingConflictOf(runtime)?.resolve === decision.settle) runtime.pendingConflict = null
    },
  )
  runtime.pendingConflict = { processes, resolve: decision.settle }
  return decision.promise
}
export function confirmConflict(runtime: HostRuntime, decision?: ConflictDecision): { ok: boolean } {
  const pending = pendingConflictOf(runtime)
  if (!pending)
    throw reject('conflict', '没有待确认的远端 DSH 冲突。', 'No remote DSH conflict is pending confirmation.')
  const action = decision?.action
  if (action !== 'stop' && action !== 'alongside' && action !== 'cancel') {
    throw reject(
      'conflict',
      '请选择停止手工实例、与它并存，或取消连接。',
      'Choose whether to stop the manual instance, keep it alongside, or cancel.',
    )
  }
  // The three-way guard above is the runtime proof; `ConflictDecision.action` is `unknown` on purpose (the Client's
  // body), and inequality cannot narrow `unknown`, so this assertion only names the type the guard established.
  pending.resolve({ action } as ConflictAnswer)
  return { ok: true }
}
/** Abandon a pending conflict prompt (teardown): resolving `cancel` makes the stalled `askConflict` call return
 * instead of holding the pipeline open. */
export function cancelConflict(runtime: HostRuntime): void {
  const pending = pendingConflictOf(runtime)
  // The answer is delivered while the slot is still installed (the settle hook reads it); both clears are idempotent.
  if (pending) pending.resolve({ action: 'cancel' })
  runtime.pendingConflict = null
  runtime.conflict = null
}

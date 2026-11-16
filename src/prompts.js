/**
 * The two prompts a connection can pause on (unknown host key, foreign DSH already running) and the answers the Client sends back; each settles exactly once.
 */
import { errors, toErrorView } from './errors.js'
import { createDecision, nowIso } from './util.js'

/**
 * Park the SSH handshake until the user answers the fingerprint prompt.
 *
 * A jump host and the target are different machines with different keys: the `role`
 * decides which context the answer belongs to, so a jump-host confirmation can never be
 * mistaken for the target's (B1).
 *
 * @param {object} ctx - service context.
 * @param {object} runtime - host runtime.
 * @param {{ sha256: string, keyType?: string }} info - the advertised host key.
 * @param {{ role?: 'target' | 'jump', host?: string | null }} [options]
 * @returns {Promise<boolean>} whether the user accepted the key.
 */
export function requestHostKey(ctx, runtime, info, options = {}) {
  const role = options.role === 'jump' ? 'jump' : 'target'
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
  const pending = {
    sha256: info.sha256,
    keyType: info.keyType,
    role,
    host: typeof options.host === 'string' && options.host !== '' ? options.host : null,
    port: Number(options.port) || 22,
    resolve: null,
  }
  const decision = createDecision(
    ctx.timers.hostKeyConfirmMs,
    () => {
      // A prompt whose link already went away must not overwrite the state of that teardown.
      if (runtime.pendingHostKey !== pending) return false
      runtime.pendingHostKey = null
      if (runtime.desired !== 'connected' || runtime.closing === true) return false
      runtime.connectCancelled = true
      ctx.progress.set(runtime, {
        status: 'error',
        phase: null,
        progress: null,
        error: toErrorView(errors.hostKeyUnknown(info.sha256)),
      })
      return false
    },
    () => {
      if (runtime.pendingHostKey === pending) runtime.pendingHostKey = null
    },
  )
  pending.resolve = decision.settle
  runtime.pendingHostKey = pending
  const fingerprint = { sha256: info.sha256, keyType: info.keyType, status: 'pending', pinned: null }
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
  runtime.status = 'fingerprint-pending'
  runtime.phase = 'ssh'
  // The role only travels for a jump host: the target prompt keeps its original shape.
  runtime.progress = isJump
    ? {
        code: 'host-key-confirm',
        params: { sha256: info.sha256, keyType: info.keyType, role: 'jump', host: pending.host },
      }
    : { code: 'host-key-confirm', params: { sha256: info.sha256, keyType: info.keyType } }
  ctx.emitState()
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
export async function confirmHostKey(ctx, runtime, decision) {
  const pending = runtime.pendingHostKey
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
  if (decision.accept !== true) runtime.connectCancelled = true
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
  runtime.pendingHostKey = null
  runtime.status = 'connecting'
  runtime.progress = { code: 'auth-checking' }
  pending.resolve(decision.accept === true)
  ctx.emitState()
  return { ok: true }
}

/**
 * Abandon a pending host-key prompt (teardown, host removal, lost transport). Resolving it
 * with `false` makes the stalled `verifyHostKey` throw instead of holding the connect
 * promise open until the prompt times out (M1).
 * @param {object} runtime - host runtime.
 */
export function cancelHostKeyPrompt(runtime) {
  const pending = runtime.pendingHostKey
  runtime.pendingHostKey = null
  if (pending) pending.resolve(false)
}

/**
 * Pause the pipeline for a decision about foreign remote processes.
 * Mirrors the host-key prompt: a status, a promise, and a bounded timeout.
 */
export function askConflict(ctx, runtime, processes) {
  runtime.status = 'conflict-pending'
  runtime.progress = { code: 'remote-dsh-running', params: { count: processes.length } }
  runtime.conflict = {
    detectedAt: nowIso(),
    processes: processes.slice(0, 20).map((process) => ({
      pid: process.pid,
      command: String(process.command ?? '').slice(0, 400),
    })),
  }
  ctx.emitState()
  const decision = createDecision(
    ctx.timers.conflictConfirmMs,
    () => ({ action: 'cancel', timedOut: true }),
    () => {
      if (runtime.pendingConflict?.resolve === decision.settle) runtime.pendingConflict = null
      runtime.conflict = null
      if (runtime.desired === 'connected') {
        runtime.status = 'connecting'
        runtime.progress = { code: 'probing' }
      }
      ctx.emitState()
    },
  )
  runtime.pendingConflict = { processes, resolve: decision.settle }
  return decision.promise
}

export function confirmConflict(runtime, decision) {
  const pending = runtime.pendingConflict
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
  pending.resolve({ action })
  return { ok: true }
}

/**
 * Abandon a pending conflict prompt (teardown). Resolving it with `cancel` makes
 * the stalled `askConflict` call return instead of holding the pipeline open.
 */
export function cancelConflict(runtime) {
  const pending = runtime.pendingConflict
  runtime.pendingConflict = null
  runtime.conflict = null
  if (pending) pending.resolve({ action: 'cancel' })
}

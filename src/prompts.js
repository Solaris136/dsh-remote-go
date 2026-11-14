/**
 * The two prompts a connection can pause on — an unknown host key and a foreign
 * DSH already running on the remote — and the answers the Client sends back.
 *
 * Both are the same shape: install a `{ resolve }` slot on the runtime, stall the
 * pipeline on a promise, and settle exactly once (user answer, timeout, or
 * teardown). The slot on the runtime is the only channel between this module and
 * the facade; neither imports the other.
 */
import { errors, toErrorView } from './errors.js'
import { createDecision, nowIso } from './util.js'

/**
 * Park the SSH handshake until the user answers the fingerprint prompt.
 * @param {any} ctx
 * @param {any} runtime
 * @param {{ sha256: string, keyType: string }} info
 */
export function requestHostKey(ctx, runtime, info) {
  const policy = runtime.entry.hostKeyPolicy ?? ctx.settings().hostKeyPolicy
  if (policy === 'strict') throw errors.hostKeyUnknown(info.sha256)
  ctx.progress.log(
    runtime,
    'info',
    `waiting for the host key to be confirmed (${info.keyType} ${info.sha256}); the SSH handshake is paused`,
  )
  const decision = createDecision(ctx.timers.hostKeyConfirmMs, () => {
    ctx.progress.set(runtime, {
      status: 'error',
      phase: null,
      progress: null,
      error: toErrorView(errors.hostKeyUnknown(info.sha256)),
    })
    return false
  })
  runtime.pendingHostKey = { sha256: info.sha256, keyType: info.keyType, resolve: decision.settle }
  runtime.fingerprint = { sha256: info.sha256, keyType: info.keyType, status: 'pending', pinned: null }
  runtime.status = 'fingerprint-pending'
  runtime.phase = 'ssh'
  runtime.progress = { code: 'host-key-confirm', params: { sha256: info.sha256, keyType: info.keyType } }
  ctx.emitState()
  return decision.promise
}

/**
 * Answer the host-key prompt. Pinning is written straight through to the store so
 * a failed first attempt still remembers the key the user accepted.
 */
export async function confirmHostKey(ctx, runtime, decision) {
  const pending = runtime.pendingHostKey
  if (!pending) {
    throw errors.invalidInput('fingerprint', {
      zh: '没有待确认的主机指纹。',
      en: 'No host key is pending confirmation.',
    })
  }
  if (decision.sha256 && pending.sha256 && decision.sha256 !== pending.sha256) {
    throw errors.invalidInput('fingerprint', {
      zh: '确认的指纹与待确认的不一致。',
      en: 'The confirmed fingerprint does not match the pending one.',
    })
  }
  if (decision.accept && decision.remember) {
    await ctx.store.patchHost(runtime.id, { pinnedFingerprint: pending.sha256 })
    runtime.entry = { ...runtime.entry, pinnedFingerprint: pending.sha256 }
  }
  runtime.fingerprint = {
    sha256: pending.sha256,
    keyType: pending.keyType,
    status: 'pinned',
    pinned: decision.remember ? pending.sha256 : null,
  }
  runtime.pendingHostKey = null
  runtime.status = 'connecting'
  runtime.progress = { code: 'auth-checking' }
  pending.resolve(decision.accept === true)
  ctx.emitState()
  return { ok: true }
}

/**
 * Pause the pipeline for a decision about foreign remote processes.
 * Mirrors the host-key prompt: a status, a promise, and a bounded timeout.
 * @returns {Promise<{ action: 'stop'|'alongside'|'cancel', timedOut?: boolean }>}
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
 * @param {any} runtime
 */
export function cancelConflict(runtime) {
  const pending = runtime.pendingConflict
  runtime.pendingConflict = null
  runtime.conflict = null
  if (pending) pending.resolve({ action: 'cancel' })
}

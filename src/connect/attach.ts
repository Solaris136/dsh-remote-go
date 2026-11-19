/**
 * The shared tail of every attach: publish `connect.succeeded` (one transition owns the card, the
 * retry budget and the link half), resume a kept instance without pretending the launch URL
 * changed, and keep the bounded restart trail the diagnostics read.
 */
import type { WatchdogCtx } from '../context.js'
import type { HostRuntime, RestartRecord } from '../host-runtime.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { nowIso } from '../util.js'

/**
 * Publish the connected state and start watching the remote for its own restarts.
 *
 * The whole attach is one `connect.succeeded` transition: status/phase/progress/error, the
 * retry-budget reset, the stale "stop not confirmed" warning, the idle disarm, the heartbeat arm,
 * `uiReady`/`viewRev`, the link-block repair-budget reset and `activeHostId`.
 * @param ctx - service context.
 * @param runtime - the runtime that just reached `ready`.
 */
export async function markConnected(ctx: WatchdogCtx, runtime: HostRuntime): Promise<void> {
  const event = { type: 'connect.succeeded' as const }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    caller: 'script',
  })
}

/** Bounded diagnostics trail of restarts and re-attached ports (never sent to the client). */
export function recordRestart(runtime: HostRuntime, entry: Omit<RestartRecord, 'at'>): void {
  const history = Array.isArray(runtime.restarts) ? runtime.restarts : []
  history.push({ at: nowIso(), ...entry })
  runtime.restarts = history.slice(-10)
}

/**
 * Put a host back into its connected state without pretending the launch URL changed.
 *
 * One `restart.resumed` transition (`keptInstance` when the managed stop was not confirmed, which
 * is what puts the "no new instance was started" warning back on the card).
 * @param ctx - service context.
 * @param runtime - the runtime the restart action owns.
 * @param keptInstance - whether the old remote instance was kept on purpose.
 * @returns whether the link was still there to resume.
 */
export async function resumeConnected(ctx: WatchdogCtx, runtime: HostRuntime, keptInstance = false): Promise<boolean> {
  // A late action must never resurrect a link that was torn down or replaced while it waited:
  // the token is checked by callers, and these are the other three proofs that it still exists.
  if (runtime.desired !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) return false
  const event = { type: 'restart.resumed' as const, ...(keptInstance ? { keptInstance: true } : {}) }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'script' })
  return true
}

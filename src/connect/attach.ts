/** The shared tail of every attach: publish `connect.succeeded` (one transition owns the card, the retry budget and the link half), resume a kept instance without pretending the launch URL changed, and keep the bounded restart trail the diagnostics read. */
import type { WatchdogCtx } from '../context.js'
import type { HostRuntime, RestartRecord } from '../host-runtime.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { nowIso } from '../util.js'

/** Publish the connected state: one transition owns status/phase/progress/error, the retry-budget reset, the idle disarm, the heartbeat arm and `activeHostId`. */
export async function markConnected(ctx: WatchdogCtx, runtime: HostRuntime): Promise<void> {
  const event = { type: 'connect.succeeded' as const }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'script' })
}

export function recordRestart(runtime: HostRuntime, entry: Omit<RestartRecord, 'at'>): void {
  const history = Array.isArray(runtime.restarts) ? runtime.restarts : []
  history.push({ at: nowIso(), ...entry })
  runtime.restarts = history.slice(-10)
}

/** Put a host back into its connected state without pretending the launch URL changed: one `restart.resumed` transition (`keptInstance` restores the "no new instance was started" warning). */
export async function resumeConnected(ctx: WatchdogCtx, runtime: HostRuntime, keptInstance = false): Promise<boolean> {
  if (runtime.desired !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) return false
  const event = { type: 'restart.resumed' as const, ...(keptInstance ? { keptInstance: true } : {}) }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'script' })
  return true
}

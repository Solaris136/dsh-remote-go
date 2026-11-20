/** The watchdog's only actor: it subscribes to the action bus once per service and runs the two one-shot actions the liveness code asks for. It is the one module allowed to know both halves — `watchdog.ts` publishes, this file acts — so the dependency arrow stays one-way, and the facade owns the subscription. */
import type { HostState, ReattachRequest, Reporter, Transport } from '../context.js'
import type { LifecycleVerdict } from '../host-lifecycle.js'
import type { EpisodeSource, HostRuntime } from '../host-runtime.js'
import { messageOf } from '../util.js'
import { watchable } from '../watchdog.js'
import type { WatchdogBusEvent } from '../watchdog-bus.js'

export type WatchdogActorCtx = HostState & Transport & Reporter

export interface WatchdogEntries {
  reattach(runtime: HostRuntime, info: ReattachRequest): Promise<unknown>
  repair(runtime: HostRuntime): Promise<LifecycleVerdict>
}

/** A liveness episode recovered: the remote answers the SSH probe again, so the local listener is what may still be broken. Probe the listener first — one failed upstream connection is not a broken tunnel, and rebuilding drops live WebSockets — then rebuild it when it really is down. */
async function onRecovered(
  ctx: WatchdogActorCtx,
  entries: WatchdogEntries,
  runtime: HostRuntime,
  source: EpisodeSource,
): Promise<void> {
  if (source === 'proxy' || source === 'tunnel') {
    let healthy = false
    try {
      healthy = (await ctx.deps.tunnelProbe?.(runtime.tunnel?.localPort ?? null)) === true
    } catch {
      // swallow-ok: a probe error means "not healthy"; the rebuild path reports its own failure
    }
    if (healthy) {
      ctx.progress.log(runtime, 'debug', 'the local tunnel still answers; keeping the listener')
    } else {
      try {
        const repaired = await entries.repair(runtime)
        if (repaired && repaired.ok !== true)
          ctx.progress.log(runtime, 'debug', `tunnel rebuild skipped (${repaired.reason ?? 'unknown'})`)
      } catch (error) {
        // swallow-ok: a failed repair is reported by the helper; the episode still recovers
        ctx.progress.log(runtime, 'warn', 'tunnel rebuild failed:', messageOf(error))
      }
    }
  }
  ctx.progress.log(runtime, 'info', `remote heartbeat: the remote UI answers again (${source})`)
  if (!watchable(ctx, runtime)) return
  ctx.onRemoteUnreachable?.(runtime, { phase: 'recovered', source })
}

function runWatchdogEvent(ctx: WatchdogActorCtx, entries: WatchdogEntries, event: WatchdogBusEvent): void {
  const runtime = ctx.state.runtimes.get(event.hostId)
  if (!runtime) return
  if (event.kind === 'confirmed') void entries.reattach(runtime, { reason: event.reason, source: event.source })
  else void onRecovered(ctx, entries, runtime, event.source)
}

export function installWatchdog(ctx: WatchdogActorCtx, entries: WatchdogEntries): () => void {
  return ctx.bus.subscribe((event) => runWatchdogEvent(ctx, entries, event))
}

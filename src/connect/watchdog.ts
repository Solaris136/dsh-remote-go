/**
 * The watchdog's only actor: it subscribes to the action bus once per service and runs the two
 * one-shot actions the liveness code asks for (design-arch §1.7).
 *
 * This is the one module allowed to know both halves — `watchdog.ts` publishes, this file acts —
 * so the dependency arrow stays one-way: `watchdog.ts → (bus) ← connect/watchdog.ts → connect/*`.
 * It is installed by `service.ts` (the facade owns the lifecycle: subscribe in the constructor,
 * unsubscribe on shutdown) and is the bus's only subscriber, which is what makes "who reacts to a
 * confirmed/recovered episode" a single answer.
 */
import type { HostState, ReattachRequest, Reporter, Transport } from '../context.js'
import type { LifecycleVerdict } from '../host-lifecycle.js'
import type { EpisodeSource, HostRuntime } from '../host-runtime.js'
import { messageOf } from '../util.js'
import { watchable } from '../watchdog.js'
import type { WatchdogBusEvent } from '../watchdog-bus.js'

/**
 * The slices the watchdog actor reads: the runtime table, the transport probe and the reporting
 * half. Deliberately narrower than the orchestration context (`ConnectCtx`) — this module is not
 * an entry point, it runs the entries the facade binds for it (see {@link WatchdogEntries}).
 */
export type WatchdogActorCtx = HostState & Transport & Reporter

/**
 * The two orchestration entries, bound by the facade that owns them.
 *
 * The actor cannot import `connect/{reattach,repair}` itself without taking the whole context, and
 * taking the whole context outside the six entries is exactly what the god-ctx gate forbids
 * (design-contract §4.3). Binding them keeps the dependency arrow in the facade, where the context
 * lives, and leaves this module with the three slices it actually reads.
 */
export interface WatchdogEntries {
  /** `reattachHost`: re-read the remote and rebuild the link after a `confirmed` episode. */
  reattach(runtime: HostRuntime, info: ReattachRequest): Promise<unknown>
  /** `repairTunnel`: rebuild only the local listener after a `recovered` episode. */
  repair(runtime: HostRuntime): Promise<LifecycleVerdict>
}

/**
 * A liveness episode recovered. The remote answers the SSH probe again, so the local listener is
 * what may still be broken (B8): ask the listener first — one failed upstream connection is not a
 * broken tunnel, and rebuilding would drop live WebSockets for nothing — then rebuild it when it
 * really is down. The `recovered` event is announced once the link is usable again, which is the
 * point in the sequence the pre-bus code announced it at.
 * @param ctx - the actor's three slices.
 * @param entries - the bound orchestration entries.
 * @param runtime - the host whose episode closed.
 * @param source - which reporter saw the remote fail.
 */
async function onRecovered(
  ctx: WatchdogActorCtx,
  entries: WatchdogEntries,
  runtime: HostRuntime,
  source: EpisodeSource,
): Promise<void> {
  const transient = source === 'proxy' || source === 'tunnel'
  if (transient) {
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
        if (repaired && repaired.ok !== true) {
          ctx.progress.log(runtime, 'debug', `tunnel rebuild skipped (${repaired.reason ?? 'unknown'})`)
        }
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

/**
 * One bus event, dispatched to the runtime it names.
 * @param ctx - the actor's three slices.
 * @param entries - the bound orchestration entries.
 * @param event - the action request the liveness detector published.
 */
function runWatchdogEvent(ctx: WatchdogActorCtx, entries: WatchdogEntries, event: WatchdogBusEvent): void {
  const runtime = ctx.state.runtimes.get(event.hostId)
  // A host removed between the probe and the event has nothing to act on.
  if (!runtime) return
  if (event.kind === 'confirmed') {
    void entries.reattach(runtime, { reason: event.reason, source: event.source })
    return
  }
  void onRecovered(ctx, entries, runtime, event.source)
}

/**
 * Subscribe this service instance to the watchdog bus.
 *
 * `confirmed` means the probes agreed the remote UI is gone: re-read the remote, refresh the run
 * registry and rebuild the tunnel (`reattachHost`). `recovered` means it answers again: fix the
 * listener and announce the episode (see {@link onRecovered}).
 *
 * @param ctx - the actor's three slices (the subscriber drives orchestration, so the facade binds
 *   the entries rather than handing over the whole context).
 * @param entries - the two orchestration entries, bound to the facade's context.
 * @returns the unsubscribe function; `service.shutdown()` must call it before tearing hosts down.
 */
export function installWatchdog(ctx: WatchdogActorCtx, entries: WatchdogEntries): () => void {
  return ctx.bus.subscribe((event) => runWatchdogEvent(ctx, entries, event))
}

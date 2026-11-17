/**
 * The effect owner for the modules that hold a full service context (`connect/pipeline.ts`,
 * `host-registry`): it binds every `DispatchHost` action to the function that already performed it
 * before the FSM was wired.
 *
 * It lives beside `dispatch.ts` (which imports nothing from the service) so the dependency arrow
 * points one way: `connect/pipeline.ts` → `runtime/effects.ts` → `host-lifecycle.ts`/`prompts.ts`.
 * `host-lifecycle.ts` builds the same object from its own functions (it owns the timers and the
 * teardown path), which keeps the token plumbing in one module instead of an import cycle.
 */
import type { DispatchHost } from './dispatch.js'
import type { TeardownEffectOptions } from './events.js'
import type { WatchdogCtx } from '../context.js'
import type { HostRuntime } from '../host-runtime.js'
import { cancelConflict, cancelHostKeyPrompt } from '../prompts.js'
import {
  cancelIdleStop,
  cancelReconnect,
  closeTunnel,
  releaseRuntimeForShutdown,
  scheduleIdleStop,
  startRemoteHeartbeat,
  stopRemoteHeartbeat,
  teardownRuntime,
} from '../host-lifecycle.js'

/**
 * `mark-attached` also resets the link block's repair budget: today's `markConnected` owns both
 * halves of the same fact, and until `connect/link.ts#markAttached` exists (P2 step 7) this patch
 * is where the link half lands.
 * @param runtime - the host runtime being attached.
 */
function markAttached(runtime: HostRuntime): void {
  runtime.remote.uiReady = true
  runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1
  runtime.tunnelRepairFailures = 0
  runtime.nextTunnelRepairAt = 0
}

/**
 * Build the effect owner for one caller.
 * @param ctx - the reporter, and the state/deps a teardown needs.
 * @returns the actions `dispatch()` performs.
 */
export function createRuntimeEffects(ctx: WatchdogCtx): DispatchHost {
  return {
    emit: () => ctx.emitState(),
    log: (runtime, level, message) => ctx.progress.log(runtime, level, message),
    logFailure: (runtime, phase, label, view) =>
      ctx.progress.logFailure(runtime, view ?? runtime.error, { phase, label }),
    arm: (runtime, timer, _ms) => {
      if (timer === 'idle') {
        scheduleIdleStop(ctx, runtime)
        return
      }
      startRemoteHeartbeat(ctx, runtime)
    },
    disarm: (runtime, timer) => {
      if (timer === 'reconnect') cancelReconnect(runtime)
      else if (timer === 'idle') cancelIdleStop(runtime)
      else stopRemoteHeartbeat(runtime)
    },
    settlePrompts: (runtime) => {
      // The teardown path does the same pair first; both are idempotent by contract (M1).
      cancelHostKeyPrompt(runtime)
      cancelConflict(runtime)
    },
    closeLink: (runtime) => {
      void closeTunnel(runtime)
    },
    teardown: async (runtime, options: TeardownEffectOptions) => {
      if (options.shutdown === true) {
        await releaseRuntimeForShutdown(ctx, runtime, options.stopRemote === true)
        return
      }
      await teardownRuntime(ctx, runtime, {
        stopRemote: options.stopRemote === true,
        ...(options.keepRemote === true ? { keepRemote: true } : {}),
        ...(options.keepSshForIdle === true ? { keepSshForIdle: true } : {}),
      })
    },
    apply: (runtime, patch) => {
      if (patch.kind === 'mark-attached') {
        markAttached(runtime)
        return
      }
      if (patch.kind === 'mark-detached') {
        runtime.remote.uiReady = false
        runtime.remote.localPort = null
        return
      }
      if (patch.kind === 'mark-ui-up') {
        runtime.remote.uiReady = true
        return
      }
      if (patch.kind === 'clear-conflict') {
        runtime.conflict = null
        return
      }
      if (patch.kind === 'publish-active-host') {
        ctx.state.activeHostId = patch.hostId
        return
      }
      // `restore-stop`: the two `remote` fields a failed stop has to put back.
      runtime.remote.uiReady = patch.uiReady === true
      runtime.remote.localPort = patch.localPort
    },
    episode: (runtime, info) => {
      ctx.onRemoteUnreachable?.(runtime, info)
    },
    bus: (runtime, event) => {
      // The two reverse callbacks the watchdog still calls directly; P2 step 9 routes the
      // watchdog through these events instead.
      if (event.kind === 'confirmed') {
        ctx.requestReattach?.(runtime, { reason: event.reason, source: event.source })
        return
      }
      const repair = ctx.repairTunnel
      if (repair) void repair(runtime).catch(() => {})
    },
    flushLogs: () => {
      // `connect-progress` owns the coalescing flush timer; `log()` already scheduled it. No rule
      // emits `flushLogs` today, and this stays a no-op instead of reaching into that module.
    },
  }
}

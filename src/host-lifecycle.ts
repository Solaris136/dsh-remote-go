/** Per-host lifecycle: the reconnect backoff, the idle-stop timer and the single teardown path. The reconnect timer is
 * created through a callback, so this module never imports the pipeline; only the timer primitives live here. */
import { DEFAULT_IDLE_MINUTES, REMOTE_TUNNEL_REPAIR_SETTLE_MS } from './constants.js'
import { OWNERSHIP_OPTIONS, proveOwnership } from './connect/ownership.js'
import { errors, toErrorView } from './errors.js'
import { emptyRemote, type Activity, type HostRuntime } from './host-runtime.js'
import { layoutForRuntime } from './layout.js'
import { cancelConflict, cancelHostKeyPrompt } from './prompts.js'
import { dispatch, scopeFactsFor, type DispatchHost } from './runtime/dispatch.js'
import type { TeardownEffectOptions } from './runtime/events.js'
import { isPid, messageOf, randomDelay } from './util.js'
import type { Config, Reporter, TeardownCtx, WatchdogCtx } from './context.js'
export interface LifecycleVerdict {
  ok: boolean
  reason?: string
}

export function cancelReconnect(runtime: HostRuntime): void {
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = null
  }
}

export function cancelIdleStop(runtime: HostRuntime): void {
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
  }
}

export function beginLinkWork(runtime: HostRuntime, kind: Activity): number {
  runtime.linkToken = (Number(runtime.linkToken) || 0) + 1
  runtime.linkBusy = kind
  return runtime.linkToken
}

export function isLinkWorkCurrent(runtime: HostRuntime, token: number): boolean {
  return runtime.linkToken === token
}

export function endLinkWork(runtime: HostRuntime, token: number): void {
  if (!isLinkWorkCurrent(runtime, token)) return
  runtime.linkBusy = null
}

export function cancelLinkWork(runtime: HostRuntime): void {
  runtime.linkToken = (Number(runtime.linkToken) || 0) + 1
  runtime.linkBusy = null
}

export function cancelRemoteCheck(runtime: HostRuntime): void {
  if (runtime.remoteCheckTimer) {
    clearTimeout(runtime.remoteCheckTimer)
    runtime.remoteCheckTimer = null
  }
}

export function stopRemoteHeartbeat(runtime: HostRuntime): void {
  if (runtime.heartbeatTimer) {
    clearInterval(runtime.heartbeatTimer)
    runtime.heartbeatTimer = null
  }

  cancelRemoteCheck(runtime)
  runtime.remoteFailures = 0
  runtime.remoteEpisode = false
  runtime.episodeSource = null
  runtime.episodeCooldownUntil = 0
}

export function scheduleReconnect(ctx: WatchdogCtx, runtime: HostRuntime, onDue: () => void): void {
  cancelReconnect(runtime)
  // Only `reconnect.scheduled` may arm the one retry timer: the connect-failure paths also ask for a
  // retry, and honouring those here would run a second loop.
  const skipped = { type: 'reconnect.skipped' as const }
  const skip = (): void => {
    void dispatch(effectsOf(ctx), runtime, skipped, scopeFactsFor(ctx, runtime, skipped), { caller: 'timer' })
  }

  if (ctx.state.disposed === true || runtime.desired !== 'connected') return skip()
  const settings = ctx.settings()

  if (!runtime.entry.autoReconnect || !settings.autoReconnect.enabled) return skip()
  const maxAttempts = settings.autoReconnect.maxAttempts
  if (runtime.reconnectAttempts >= maxAttempts) {
    const view = toErrorView(
      errors.network({
        zh: `连接已断开，自动重连 ${maxAttempts} 次均失败。远端任务可能仍在运行。`,
        en: `The connection dropped and ${maxAttempts} automatic retries failed. Remote tasks may still be running.`,
      }),
    )
    const event = { type: 'reconnect.gaveup' as const, maxAttempts, view }
    void dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'timer' })
    return
  }
  const attempt = runtime.reconnectAttempts + 1
  const baseDelayMs = settings.autoReconnect.baseDelayMs
  const delay = randomDelay(baseDelayMs, baseDelayMs * 2 ** Math.min(attempt, 4))
  const seconds = Math.round(delay / 100) / 10
  ctx.progress.log(runtime, 'warn', `link lost; retrying in ${seconds}s (attempt ${attempt}/${maxAttempts})`)
  const scheduled = { type: 'reconnect.scheduled' as const, attempt, max: maxAttempts, delayMs: delay }
  void dispatch(effectsOf(ctx), runtime, scheduled, scopeFactsFor(ctx, runtime, scheduled), {
    caller: 'timer',
    armReconnect: (ms) => {
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = null
        onDue()
      }, ms)
      runtime.reconnectTimer.unref?.()
    },
  })
}

export function scheduleIdleStop(ctx: WatchdogCtx, runtime: HostRuntime): void {
  cancelIdleStop(runtime)
  const minutes = Math.max(1, runtime.entry.idleMinutes ?? DEFAULT_IDLE_MINUTES)
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null
    const event = { type: 'idle.elapsed' as const }
    void dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'timer' }).then(
      (result) => (result.ok ? stopRemoteForIdle(ctx, runtime) : undefined),
    )
  }, minutes * 60_000)
  runtime.idleTimer.unref?.()
}

export async function stopRemoteForIdle(
  ctx: WatchdogCtx,
  runtime: HostRuntime,
  options: { shutdown?: boolean } = {},
): Promise<LifecycleVerdict> {
  // The timer is a policy for an idle host, never authority over a live link: a manual reconnect
  // must not be torn down by the timer armed before it.
  const linkLive = runtime.desired === 'connected' || runtime.status === 'connected' || runtime.tunnel !== null
  if (linkLive && options.shutdown !== true) {
    ctx.progress.log(runtime, 'debug', 'idle stop skipped: the host is connected again')
    return { ok: false, reason: 'still-wanted' }
  }
  const capturedSsh = runtime.ssh
  // The identity proof below awaits and the user may connect in that window: only this session may
  // be released afterwards, never the new one.
  const stillWanted = () =>
    runtime.ssh !== capturedSsh ||
    runtime.desired === 'connected' ||
    runtime.status === 'connected' ||
    runtime.tunnel !== null
  try {
    if (capturedSsh?.connected !== true) return { ok: false, reason: 'no-transport' }
    const home = runtime.facts?.home ?? runtime.remoteHome ?? null
    if (typeof home !== 'string' || home.trim() === '') {
      ctx.progress.log(runtime, 'warn', 'idle stop skipped: the remote home directory is unknown')
      return { ok: false, reason: 'no-home' }
    }
    const layout = layoutForRuntime(runtime)
    const pid = Number(runtime.remote.pid ?? runtime.remotePid ?? 0)
    if (!isPid(pid)) return { ok: false, reason: 'pid-unknown' }
    const proof = await proveOwnership(ctx, runtime, {
      ...OWNERSHIP_OPTIONS.idle,
      pid,
      layout,
      profile: runtime.remote.profile ?? runtime.remoteProfile ?? '',
    })
    if (proof.ok !== true) {
      ctx.progress.log(runtime, 'warn', `idle stop skipped: ${proof.reason}`)
      return { ok: false, reason: proof.reason }
    }
    if (options.shutdown !== true && stillWanted()) {
      ctx.progress.log(runtime, 'debug', 'idle stop skipped: the host is connected again')
      return { ok: false, reason: 'still-wanted' }
    }
    const stopped = await ctx.deps.stopWeb(capturedSsh, layout, { pid })
    if (stopped?.ok !== true) {
      const why = stopped?.reason ?? 'unknown'
      ctx.progress.log(runtime, 'warn', `idle stop did not confirm (${why}); the remote may still be running`)
      return { ok: false, reason: stopped?.reason ?? 'not-confirmed' }
    }
    runtime.remotePid = null
    return { ok: true }
  } catch (error) {
    // swallow-ok: the idle stop is best effort; its failure is only a warning and the timer is gone
    ctx.progress.log(runtime, 'warn', 'idle stop failed:', messageOf(error))
    return { ok: false, reason: 'error' }
  } finally {
    if (runtime.ssh === capturedSsh) await disposeSsh(runtime)
  }
}

export async function closeTunnel(runtime: HostRuntime): Promise<void> {
  const tunnel = runtime.tunnel
  runtime.tunnel = null
  runtime.remote.localPort = null
  if (tunnel) {
    try {
      await tunnel.close()
    } catch {
      // swallow-ok: teardown continues; a dead tunnel needs no second error
    }
  }
}

export async function disposeSsh(runtime: HostRuntime): Promise<void> {
  const ssh = runtime.ssh
  runtime.ssh = null
  const jump = runtime.jumpSsh
  runtime.jumpSsh = null
  if (ssh) {
    try {
      await ssh.dispose()
    } catch {
      // swallow-ok: disposal must not stop the rest of the teardown
    }
  }

  if (jump) {
    try {
      await jump.dispose()
    } catch {
      // swallow-ok: the same disposal rule as the target transport
    }
  }
}

async function settleTunnelRepair(ctx: Config & Reporter, runtime: HostRuntime): Promise<void> {
  const repair = runtime.tunnelRepair
  if (!repair) return
  const timeoutMs = Number(ctx.timers?.tunnelRepairSettleMs ?? REMOTE_TUNNEL_REPAIR_SETTLE_MS)
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs))
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([repair, timeout])
    if (outcome === 'timeout') {
      ctx.progress.log(runtime, 'warn', 'tunnel rebuild did not finish in time; abandoning it')
      runtime.tunnelRepair = null
    }
  } catch {
    // swallow-ok: the rebuild reports its own failure; teardown must still proceed
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
export interface TeardownOptions {
  stopRemote?: boolean
  keepSshForIdle?: boolean
  keepRemote?: boolean
}

export async function teardownRuntime(
  ctx: TeardownCtx,
  runtime: HostRuntime,
  options: TeardownOptions = {},
): Promise<void> {
  cancelConflict(runtime)

  cancelHostKeyPrompt(runtime)

  cancelLinkWork(runtime)

  stopRemoteHeartbeat(runtime)
  runtime.closing = true
  cancelIdleStop(runtime)
  await settleTunnelRepair(ctx, runtime)
  // Remember where the remote lives before the facts below are cleared: the idle policy and a later
  // stop still need the real home, never a literal `~`.
  if (typeof runtime.facts?.home === 'string' && runtime.facts.home.trim() !== '') {
    runtime.remoteHome = runtime.facts.home
  }

  if (typeof runtime.remote.profile === 'string' && runtime.remote.profile !== '') {
    runtime.remoteProfile = runtime.remote.profile
  }
  const boundPid = Number(runtime.remote.pid ?? 0)

  if (isPid(boundPid)) runtime.remotePid = boundPid
  let remoteStopped = false
  if (options.stopRemote && runtime.ssh?.connected) {
    try {
      const result = await ctx.deps.stopWeb(runtime.ssh, layoutForRuntime(runtime), {
        pid: runtime.remote.pid ?? undefined,
      })
      remoteStopped = result?.ok === true
    } catch (error) {
      ctx.progress.log(runtime, 'warn', 'stop remote failed:', messageOf(error))
    }
  }

  if (remoteStopped) runtime.remotePid = null
  await closeTunnel(runtime)

  if (!options.keepSshForIdle) await disposeSsh(runtime)

  if (!options.keepRemote) {
    runtime.remote = { ...emptyRemote(), version: runtime.remote.version }
    runtime.token = null
    runtime.facts = null
    runtime.exchange = null
  }
}
export interface DisconnectOptions {
  stopRemote?: boolean
  stopped?: boolean
}

export async function disconnectHost(
  ctx: TeardownCtx,
  runtime: HostRuntime,
  options: DisconnectOptions = {},
): Promise<{ ok: boolean }> {
  ctx.progress.log(runtime, 'info', `disconnect requested (keepAlive=${runtime.entry.keepAlive})`)
  const event = {
    type: 'disconnect.requested' as const,
    ...(options.stopRemote === true ? { stopRemote: true } : {}),
    ...(options.stopped === true ? { stopped: true } : {}),
  }
  await dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'script' })
  runtime.token = null
  return { ok: true }
}

export async function releaseRuntimeForShutdown(
  ctx: TeardownCtx,
  runtime: HostRuntime,
  stopRemote: boolean,
): Promise<void> {
  await settleTunnelRepair(ctx, runtime)
  try {
    if (stopRemote) {
      await stopRemoteForIdle(ctx, runtime, { shutdown: true })
      return
    }
    await closeTunnel(runtime)
    await disposeSsh(runtime)
  } catch {
    // swallow-ok: shutdown is best effort; every resource is released above
  }
}

export async function shutdownAll(ctx: TeardownCtx): Promise<void> {
  for (const runtime of ctx.state.runtimes.values()) {
    const event = { type: 'shutdown' as const }
    await dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'silent' })
  }
}
/** The effects of this module bound to one context: it owns the timers and the teardown path, so it builds the effect
 * object instead of importing `effects.ts` (which imports it); `run`/`flushLogs` are unreachable but required. */
function effectsOf(ctx: TeardownCtx): DispatchHost {
  return {
    emit: () => ctx.emitState(),
    log: (runtime, level, message) => ctx.progress.log(runtime, level, message),
    logFailure: (runtime, phase, label, view) =>
      ctx.progress.logFailure(runtime, view ?? runtime.error, { phase, label }),
    arm: (runtime, timer) => {
      if (timer === 'idle') scheduleIdleStop(ctx, runtime)
    },
    disarm: (runtime, timer) => {
      if (timer === 'reconnect') cancelReconnect(runtime)
      else if (timer === 'idle') cancelIdleStop(runtime)
      else stopRemoteHeartbeat(runtime)
    },
    settlePrompts: (runtime) => {
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
        keepRemote: options.keepRemote === true,
        keepSshForIdle: options.keepSshForIdle === true,
      })
    },
    apply: (runtime, patch) => {
      if (patch.kind === 'mark-detached') {
        runtime.remote.uiReady = false
        runtime.remote.localPort = null
        return
      }
      if (patch.kind === 'mark-ui-up') {
        runtime.remote.uiReady = true
        return
      }
      if (patch.kind === 'mark-attached') {
        runtime.remote.uiReady = true
        runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1
        runtime.tunnelRepairFailures = 0
        runtime.nextTunnelRepairAt = 0
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
      runtime.remote.uiReady = patch.uiReady === true
      runtime.remote.localPort = patch.localPort
    },
    flushLogs: () => {},
  }
}

/**
 * The liveness watchdog: the heartbeat probe, the episode it opens when the remote UI stops
 * answering, and the two action requests it turns into bus events (design-arch §1.7).
 *
 * It used to live inside `host-lifecycle.ts` and reach its one-shot actions back through `ctx`
 * (`requestReattach`/`repairTunnel`). Those reverse callbacks are gone: a confirmed or recovered
 * episode is published on `ctx.bus`, and `connect/watchdog.ts` — the bus's only subscriber — runs
 * the action. The dependency arrow therefore points one way only: this module never imports
 * `connect/*`, so the modules that dispatch `arm(heartbeat)` do not create a cycle.
 *
 * The two timer *primitives* (`stopRemoteHeartbeat`/`cancelRemoteCheck`) stay in
 * `host-lifecycle.ts`, the owner of the runtime's timer block; the policy that fills them lives
 * here.
 */
import {
  REMOTE_EPISODE_COOLDOWN_MS,
  REMOTE_HEARTBEAT_DEFAULT_SEC,
  REMOTE_HEARTBEAT_MAX_SEC,
  REMOTE_HEARTBEAT_MIN_SEC,
  REMOTE_UNREACHABLE_FAILURES,
} from './constants.js'
import type { Config, HostState, Reporter, WatchdogCtx } from './context.js'
import type { EpisodeSource, HostRuntime } from './host-runtime.js'
import { cancelRemoteCheck, stopRemoteHeartbeat } from './host-lifecycle.js'
import { isUiUp } from './remote-proc.js'

/** Milliseconds between liveness probes, from settings (default 30s, disabled allowed). */
export function remoteHeartbeatIntervalSec(ctx: Config): number {
  const raw = ctx.settings()?.remoteHeartbeat
  const seconds = Number(raw?.intervalSec)
  if (!Number.isFinite(seconds)) return REMOTE_HEARTBEAT_DEFAULT_SEC
  return Math.min(REMOTE_HEARTBEAT_MAX_SEC, Math.max(REMOTE_HEARTBEAT_MIN_SEC, Math.round(seconds)))
}

/** Start the light liveness probe for a host that just became connected. */
export function startRemoteHeartbeat(ctx: WatchdogCtx, runtime: HostRuntime): void {
  stopRemoteHeartbeat(runtime)
  const enabled = ctx.settings()?.remoteHeartbeat?.enabled !== false
  if (!enabled) {
    ctx.progress.log(runtime, 'debug', 'remote heartbeat: disabled by settings')
    return
  }
  const intervalSec = remoteHeartbeatIntervalSec(ctx)
  runtime.heartbeatTimer = setInterval(() => {
    void remoteHeartbeatTick(ctx, runtime)
  }, intervalSec * 1000)
  runtime.heartbeatTimer.unref?.()
  ctx.progress.log(runtime, 'debug', `remote heartbeat: probing every ${intervalSec}s`)
}

/** A host is watchable only while it is really up and no one-shot action owns the link. */
export function watchable(ctx: HostState, runtime: HostRuntime): boolean {
  return (
    ctx.state.disposed !== true &&
    runtime.desired === 'connected' &&
    runtime.status === 'connected' &&
    runtime.linkBusy === null &&
    runtime.ssh?.connected === true &&
    runtime.tunnel !== null
  )
}

/**
 * Open a liveness episode at most once. Transient reports (a proxy/tunnel failure) are
 * coalesced: after a confirmed-healthy episode the same kind of report is ignored for a
 * cooldown window, so a flapping tunnel cannot emit suspected/recovered on every request.
 * Returns whether a new episode was opened.
 */
function beginRemoteEpisode(ctx: Reporter, runtime: HostRuntime, source: EpisodeSource): boolean {
  if (runtime.remoteEpisode === true) return false
  const transient = source === 'proxy' || source === 'tunnel'
  if (transient && Date.now() < (Number(runtime.episodeCooldownUntil) || 0)) {
    ctx.progress.log(runtime, 'debug', `remote-unreachable reported again (${source}); episode cooldown, ignoring`)
    return false
  }
  runtime.remoteEpisode = true
  runtime.episodeSource = source
  ctx.progress.log(runtime, 'debug', `remote-unreachable suspected (${source}); confirming with probes`)
  ctx.onRemoteUnreachable?.(runtime, { phase: 'suspected', source })
  return true
}

/**
 * Reset the failure streak and close the episode. The recovery *action* (probe the local
 * listener, rebuild it when needed, announce the episode) belongs to the bus subscriber:
 * `connect/watchdog.ts` runs it and publishes `recovered` once the link is usable again, which is
 * the same point in the sequence the old inline code announced it at.
 */
function clearRemoteEpisode(ctx: Reporter, runtime: HostRuntime, source: EpisodeSource): void {
  const wasOpen = runtime.remoteEpisode === true
  const transient = runtime.episodeSource === 'proxy' || runtime.episodeSource === 'tunnel'
  runtime.remoteEpisode = false
  runtime.remoteFailures = 0
  if (!wasOpen) return
  runtime.episodeSource = null
  if (transient) runtime.episodeCooldownUntil = Date.now() + REMOTE_EPISODE_COOLDOWN_MS
  ctx.bus.publish({ kind: 'recovered', hostId: runtime.id, source })
}

function scheduleRemoteCheck(ctx: WatchdogCtx, runtime: HostRuntime, source: EpisodeSource, delayMs: number): void {
  if (runtime.remoteCheckTimer) return
  runtime.remoteCheckTimer = setTimeout(() => {
    runtime.remoteCheckTimer = null
    void checkRemoteNow(ctx, runtime, source)
  }, delayMs)
  runtime.remoteCheckTimer.unref?.()
}

/**
 * Probe the connected host once and feed the consecutive-failure counter. One
 * failed request is not a restart: the counter has to reach
 * {@link REMOTE_UNREACHABLE_FAILURES} before a re-attach is requested.
 */
async function checkRemoteNow(ctx: WatchdogCtx, runtime: HostRuntime, source: EpisodeSource): Promise<void> {
  if (!watchable(ctx, runtime) || typeof ctx.deps.remoteStatus !== 'function') return
  const ssh = runtime.ssh
  const port = runtime.remote.port
  let status: number | null = null
  try {
    status = await ctx.deps.remoteStatus(ssh, port)
  } catch {
    // swallow-ok: an unreachable probe is a failed probe, handled by the same counter
    status = null
  }
  // The transport may have gone away while the probe was in flight; the close handler owns that.
  if (!watchable(ctx, runtime) || runtime.ssh !== ssh) return
  if (isUiUp(status)) {
    clearRemoteEpisode(ctx, runtime, source)
    return
  }
  runtime.remoteFailures = (Number(runtime.remoteFailures) || 0) + 1
  ctx.progress.log(
    runtime,
    'debug',
    `remote heartbeat: probe failed (HTTP ${status ?? 'none'}), ${runtime.remoteFailures}/${REMOTE_UNREACHABLE_FAILURES} (${source})`,
  )
  beginRemoteEpisode(ctx, runtime, source)
  if (runtime.remoteFailures < REMOTE_UNREACHABLE_FAILURES) {
    scheduleRemoteCheck(ctx, runtime, source, ctx.timers.remoteRecheckMs)
    return
  }
  ctx.progress.log(
    runtime,
    'warn',
    `remote-unreachable: ${runtime.remoteFailures} consecutive probes failed (${source}); re-attaching`,
  )
  ctx.onRemoteUnreachable?.(runtime, {
    phase: 'confirmed',
    source,
    failures: runtime.remoteFailures,
  })
  cancelRemoteCheck(runtime)
  ctx.bus.publish({ kind: 'confirmed', hostId: runtime.id, reason: `probe-failed-${runtime.remoteFailures}`, source })
}

/** One scheduled heartbeat tick. */
export async function remoteHeartbeatTick(ctx: WatchdogCtx, runtime: HostRuntime): Promise<void> {
  if (!watchable(ctx, runtime)) return
  if (runtime.remoteCheckTimer) return
  await checkRemoteNow(ctx, runtime, 'heartbeat')
}

/**
 * A proxy or tunnel failure was observed: report the episode once and confirm it
 * with probes instead of treating one failed request as a remote restart.
 */
export function noteRemoteUnreachable(ctx: WatchdogCtx, runtime: HostRuntime, source: EpisodeSource): void {
  if (!watchable(ctx, runtime)) return
  if (!beginRemoteEpisode(ctx, runtime, source)) return
  scheduleRemoteCheck(ctx, runtime, source, ctx.timers.remoteConfirmDelayMs)
}

/**
 * Per-host lifecycle: the reconnect backoff, the idle-stop timer and the single teardown path; the reconnect timer gets a callback, so this never imports the pipeline.
 */
import {
  DEFAULT_IDLE_MINUTES,
  REMOTE_EPISODE_COOLDOWN_MS,
  REMOTE_HEARTBEAT_DEFAULT_SEC,
  REMOTE_HEARTBEAT_MAX_SEC,
  REMOTE_HEARTBEAT_MIN_SEC,
  REMOTE_TUNNEL_REPAIR_SETTLE_MS,
  REMOTE_UNREACHABLE_FAILURES,
} from './constants.js'
import { errors, toErrorView } from './errors.js'
import { emptyRemote } from './host-runtime.js'
import { remoteLayout } from './layout.js'
import { cancelConflict } from './prompts.js'
import { isUiUp } from './remote-proc.js'
import { messageOf, randomDelay } from './util.js'

export function cancelReconnect(runtime) {
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = null
  }
}

export function cancelIdleStop(runtime) {
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
  }
}

/**
 * One-shot link actions (a local restart, a remote re-attach, a tunnel rebuild) share a
 * token so a disconnect, a dropped transport or a newer action can invalidate an older one:
 * an action must never write state on top of whatever replaced it.
 * @param {object} runtime - host runtime.
 * @param {string} kind - `restart`, `reattach` or `repair`.
 * @returns {number} the token that owns the action.
 */
export function beginLinkWork(runtime, kind) {
  runtime.linkToken = (Number(runtime.linkToken) || 0) + 1
  runtime.linkBusy = kind
  return runtime.linkToken
}

export function isLinkWorkCurrent(runtime, token) {
  return runtime.linkToken === token
}

export function endLinkWork(runtime, token) {
  if (!isLinkWorkCurrent(runtime, token)) return
  runtime.linkBusy = null
}

/** Invalidate whatever one-shot action was running; safe when there is none. */
export function cancelLinkWork(runtime) {
  runtime.linkToken = (Number(runtime.linkToken) || 0) + 1
  runtime.linkBusy = null
}

/** Milliseconds between liveness probes, from settings (default 30s, disabled allowed). */
export function remoteHeartbeatIntervalSec(ctx) {
  const raw = ctx.settings()?.remoteHeartbeat
  const seconds = Number(raw?.intervalSec)
  if (!Number.isFinite(seconds)) return REMOTE_HEARTBEAT_DEFAULT_SEC
  return Math.min(REMOTE_HEARTBEAT_MAX_SEC, Math.max(REMOTE_HEARTBEAT_MIN_SEC, Math.round(seconds)))
}

function cancelRemoteCheck(runtime) {
  if (runtime.remoteCheckTimer) {
    clearTimeout(runtime.remoteCheckTimer)
    runtime.remoteCheckTimer = null
  }
}

/** Stop probing: called on connect, disconnect, re-attach and shutdown. */
export function stopRemoteHeartbeat(runtime) {
  if (runtime.heartbeatTimer) {
    clearInterval(runtime.heartbeatTimer)
    runtime.heartbeatTimer = null
  }
  cancelRemoteCheck(runtime)
  runtime.remoteFailures = 0
  runtime.remoteEpisode = false
  runtime.episodeSource = null
  // A new attach starts a new episode budget; the cooldown only exists to damp one connection.
  runtime.episodeCooldownUntil = 0
}

/** Start the light liveness probe for a host that just became connected. */
export function startRemoteHeartbeat(ctx, runtime) {
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
function watchable(ctx, runtime) {
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
function beginRemoteEpisode(ctx, runtime, source) {
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
 * Reset the failure streak; report the recovery once when an episode was open. A transient
 * episode also rebuilds the local listener: the remote answering the probe while the page
 * got a 502 usually means the tunnel, not the remote, is what broke.
 */
async function clearRemoteEpisode(ctx, runtime, source) {
  const wasOpen = runtime.remoteEpisode === true
  const transient = runtime.episodeSource === 'proxy' || runtime.episodeSource === 'tunnel'
  runtime.remoteEpisode = false
  runtime.remoteFailures = 0
  if (!wasOpen) return
  runtime.episodeSource = null
  if (transient) {
    runtime.episodeCooldownUntil = Date.now() + REMOTE_EPISODE_COOLDOWN_MS
    // The SSH probe only proves the remote side answers. Ask the local listener first: if it
    // still serves, a single failed upstream connection is not a broken tunnel and rebuilding
    // would drop live WebSockets for nothing.
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
        const repaired = await ctx.repairTunnel?.(runtime)
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

function scheduleRemoteCheck(ctx, runtime, source, delayMs) {
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
async function checkRemoteNow(ctx, runtime, source) {
  if (!watchable(ctx, runtime) || typeof ctx.deps.remoteStatus !== 'function') return
  const ssh = runtime.ssh
  const port = runtime.remote.port
  let status = null
  try {
    status = await ctx.deps.remoteStatus(ssh, port)
  } catch {
    // swallow-ok: an unreachable probe is a failed probe, handled by the same counter
    status = null
  }
  // The transport may have gone away while the probe was in flight; the close handler owns that.
  if (!watchable(ctx, runtime) || runtime.ssh !== ssh) return
  if (isUiUp(status)) {
    await clearRemoteEpisode(ctx, runtime, source)
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
  ctx.requestReattach?.(runtime, { reason: `probe-failed-${runtime.remoteFailures}`, source })
}

/** One scheduled heartbeat tick. */
export async function remoteHeartbeatTick(ctx, runtime) {
  if (!watchable(ctx, runtime)) return
  if (runtime.remoteCheckTimer) return
  await checkRemoteNow(ctx, runtime, 'heartbeat')
}

/**
 * A proxy or tunnel failure was observed: report the episode once and confirm it
 * with probes instead of treating one failed request as a remote restart.
 */
export function noteRemoteUnreachable(ctx, runtime, source) {
  if (!watchable(ctx, runtime)) return
  if (!beginRemoteEpisode(ctx, runtime, source)) return
  scheduleRemoteCheck(ctx, runtime, source, ctx.timers.remoteConfirmDelayMs)
}

/**
 * Arm the next reconnect attempt, or give up once the configured budget is spent.
 */
export function scheduleReconnect(ctx, runtime, onDue) {
  cancelReconnect(runtime)
  const settings = ctx.settings()
  if (!runtime.entry.autoReconnect || !settings.autoReconnect.enabled) {
    ctx.progress.set(runtime, { status: 'disconnected' })
    return
  }
  const maxAttempts = settings.autoReconnect.maxAttempts
  if (runtime.reconnectAttempts >= maxAttempts) {
    runtime.status = 'error'
    runtime.error = toErrorView(
      errors.network({
        zh: `连接已断开，自动重连 ${maxAttempts} 次均失败。远端任务可能仍在运行。`,
        en: `The connection dropped and ${maxAttempts} automatic retries failed. Remote tasks may still be running.`,
      }),
    )
    runtime.progress = null
    ctx.emitState()
    return
  }
  runtime.reconnectAttempts += 1
  const delay = randomDelay(
    settings.autoReconnect.baseDelayMs,
    settings.autoReconnect.baseDelayMs * 2 ** Math.min(runtime.reconnectAttempts, 4),
  )
  runtime.progress = { code: 'reconnecting', params: { attempt: runtime.reconnectAttempts, max: maxAttempts } }
  ctx.progress.log(
    runtime,
    'warn',
    `link lost; retrying in ${Math.round(delay / 100) / 10}s (attempt ${runtime.reconnectAttempts}/${maxAttempts})`,
  )
  ctx.emitState()
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null
    onDue()
  }, delay)
}

function scheduleIdleStop(ctx, runtime) {
  cancelIdleStop(runtime)
  const minutes = Math.max(1, runtime.entry.idleMinutes ?? DEFAULT_IDLE_MINUTES)
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null
    void stopRemoteQuietly(ctx, runtime)
  }, minutes * 60_000)
}

/** Best-effort stop of the remote web for the idle policy, then drop the transport. */
async function stopRemoteQuietly(ctx, runtime) {
  try {
    if (runtime.ssh?.connected) {
      await ctx.deps.stopWeb(runtime.ssh, remoteLayout(runtime.facts?.home ?? null), {
        pid: runtime.remote.pid ?? undefined,
      })
    }
  } catch (error) {
    ctx.progress.log(runtime, 'warn', 'idle stop failed:', messageOf(error))
  } finally {
    await disposeSsh(runtime)
  }
}

export async function closeTunnel(runtime) {
  const tunnel = runtime.tunnel
  runtime.tunnel = null
  // `localPort` is a view of the live listener: a closed tunnel must not leave a stale port
  // behind (the proxy and diagnostics read this field).
  runtime.remote.localPort = null
  if (tunnel) {
    try {
      await tunnel.close()
    } catch {}
  }
}

export async function disposeSsh(runtime) {
  const ssh = runtime.ssh
  runtime.ssh = null
  const jump = runtime.jumpSsh
  runtime.jumpSsh = null
  if (ssh) {
    try {
      await ssh.dispose()
    } catch {}
  }
  if (jump) {
    try {
      await jump.dispose()
    } catch {}
  }
}

/**
 * The single teardown path. `stopRemote` also stops the remote web (keep-alive
 * `stop`), `keepSshForIdle` leaves the transport up for a fast resume, and
 * `keepRemote` preserves the remote facts so the card still describes what is
 * running on the other side.
 */
/**
 * Wait for an in-flight tunnel rebuild (if any) after the caller cancelled link work.
 * The rebuild closes its own replacement in `finally` when its token is gone, so awaiting
 * here is what makes disconnect / removeHost / shutdown leak-free. Bounded: a stuck rebuild
 * must not delay teardown forever; its token is already cancelled, so it cannot publish.
 * @param {object} ctx - service context.
 * @param {object} runtime - host runtime.
 */
async function settleTunnelRepair(ctx, runtime) {
  const repair = runtime.tunnelRepair
  if (!repair) return
  const timeoutMs = Number(ctx.timers?.tunnelRepairSettleMs ?? REMOTE_TUNNEL_REPAIR_SETTLE_MS)
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs))
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([repair, timeout])
    if (outcome === 'timeout') {
      ctx.progress.log(runtime, 'warn', 'tunnel rebuild did not finish in time; abandoning it')
      // The rebuild was cancelled via cancelLinkWork; its own finally will close any listener
      // it creates. Clear the slot so teardown never waits on it again.
      runtime.tunnelRepair = null
    }
  } catch {
    // swallow-ok: the rebuild reports its own failure; teardown must still proceed
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export async function teardownRuntime(ctx, runtime, options = {}) {
  cancelConflict(runtime)
  cancelLinkWork(runtime)
  stopRemoteHeartbeat(runtime)
  runtime.closing = true
  cancelIdleStop(runtime)
  // A tunnel rebuild owns a listener it may be creating right now. Cancel it (above), then
  // wait for it to clean up: otherwise the listener would be assigned after this teardown.
  await settleTunnelRepair(ctx, runtime)
  if (options.stopRemote && runtime.ssh?.connected) {
    try {
      await ctx.deps.stopWeb(runtime.ssh, remoteLayout(runtime.facts?.home ?? null), {
        pid: runtime.remote.pid ?? undefined,
      })
    } catch (error) {
      ctx.progress.log(runtime, 'warn', 'stop remote failed:', messageOf(error))
    }
  }
  await closeTunnel(runtime)
  if (!options.keepSshForIdle) await disposeSsh(runtime)
  if (!options.keepRemote) {
    runtime.remote = { ...emptyRemote(), version: runtime.remote.version }
    runtime.token = null
    runtime.facts = null
    runtime.exchange = null
  }
}

/**
 * Tear one host down and leave it idle: the keep-alive policy decides whether the
 * remote web is stopped and whether the transport survives for a fast resume.
 */
export async function disconnectHost(ctx, runtime, options = {}) {
  ctx.progress.log(runtime, 'info', `disconnect requested (keepAlive=${runtime.entry.keepAlive})`)
  runtime.desired = 'idle'
  cancelReconnect(runtime)
  cancelLinkWork(runtime)
  stopRemoteHeartbeat(runtime)
  const policy = runtime.entry.keepAlive
  const stopRemote = options.stopRemote === true || policy === 'stop'
  await teardownRuntime(ctx, runtime, { stopRemote, keepSshForIdle: policy === 'idle' && !stopRemote })
  runtime.status = 'disconnected'
  runtime.phase = null
  runtime.progress = null
  runtime.remote.uiReady = false
  runtime.remote.localPort = null
  runtime.token = null
  ctx.progress.set(runtime, {})
  if (policy === 'idle' && !stopRemote) scheduleIdleStop(ctx, runtime)
  return { ok: true }
}

/**
 * Stop every host's timers and release its transport. The `stop` keep-alive
 * policy also stops the remote web so nothing is left running unowned.
 */
export async function shutdownAll(ctx) {
  for (const runtime of ctx.state.runtimes.values()) {
    cancelReconnect(runtime)
    cancelIdleStop(runtime)
    cancelLinkWork(runtime)
    stopRemoteHeartbeat(runtime)
    await settleTunnelRepair(ctx, runtime)
    try {
      if (runtime.entry.keepAlive === 'stop') {
        await stopRemoteQuietly(ctx, runtime)
      } else {
        await closeTunnel(runtime)
        await disposeSsh(runtime)
      }
    } catch {
      /* best effort on shutdown */
    }
  }
}

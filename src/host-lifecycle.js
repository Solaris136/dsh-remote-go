/**
 * Per-host lifecycle: the reconnect backoff, the idle-stop timer and the single teardown path; the reconnect timer gets a callback, so this never imports the pipeline.
 */
import { DEFAULT_IDLE_MINUTES } from './constants.js'
import { errors, toErrorView } from './errors.js'
import { emptyRemote } from './host-runtime.js'
import { remoteLayout } from './layout.js'
import { cancelConflict } from './prompts.js'
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

export function scheduleIdleStop(ctx, runtime) {
  cancelIdleStop(runtime)
  const minutes = Math.max(1, runtime.entry.idleMinutes ?? DEFAULT_IDLE_MINUTES)
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null
    void stopRemoteQuietly(ctx, runtime)
  }, minutes * 60_000)
}

/** Best-effort stop of the remote web for the idle policy, then drop the transport. */
export async function stopRemoteQuietly(ctx, runtime) {
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
export async function teardownRuntime(ctx, runtime, options = {}) {
  cancelConflict(runtime)
  runtime.closing = true
  cancelIdleStop(runtime)
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

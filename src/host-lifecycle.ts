/**
 * Per-host lifecycle: the reconnect backoff, the idle-stop timer and the single teardown path; the
 * reconnect timer gets a callback, so this never imports the pipeline. The liveness watchdog that
 * used to live here moved to `watchdog.ts` (P2 step 9); only the timer primitives it disarms stay,
 * because this module owns the runtime's timer block.
 */
import { DEFAULT_IDLE_MINUTES, REMOTE_TUNNEL_REPAIR_SETTLE_MS } from './constants.js'
import { OWNERSHIP_OPTIONS, proveOwnership } from './connect/ownership.js'
import { errors, toErrorView } from './errors.js'
import { emptyRemote } from './host-runtime.js'
import type { Activity, HostRuntime } from './host-runtime.js'
import { layoutForRuntime } from './layout.js'
import { cancelConflict, cancelHostKeyPrompt } from './prompts.js'
import { dispatch, scopeFactsFor } from './runtime/dispatch.js'
import type { DispatchHost } from './runtime/dispatch.js'
import type { TeardownEffectOptions } from './runtime/events.js'
import { isPid, messageOf, randomDelay } from './util.js'
import type { Config, Reporter, TeardownCtx, WatchdogCtx } from './context.js'

/** The verdict a best-effort action reports back to its caller (and to the connect log). */
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

/**
 * One-shot link actions (a local restart, a remote re-attach, a tunnel rebuild) share a
 * token so a disconnect, a dropped transport or a newer action can invalidate an older one:
 * an action must never write state on top of whatever replaced it.
 * @param runtime - host runtime.
 * @param kind - `restart`, `reattach`, `repair` or `stop`.
 * @returns the token that owns the action.
 */
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

/** Invalidate whatever one-shot action was running; safe when there is none. */
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

/** Stop probing: called on connect, disconnect, re-attach and shutdown. */
export function stopRemoteHeartbeat(runtime: HostRuntime): void {
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

/**
 * Arm the next reconnect attempt, or give up once the configured budget is spent.
 *
 * The timer is created through `reconnect.scheduled`; that event is the **only** `arm(reconnect)`
 * the executor turns into a timeout (the design's P2b hand-off: the connect-failure paths also ask
 * for a retry, and honouring those would run a second loop). The rule decides whether the attempt
 * is still wanted, the policy/budget/randomized delay stay here.
 */
export function scheduleReconnect(ctx: WatchdogCtx, runtime: HostRuntime, onDue: () => void): void {
  cancelReconnect(runtime)
  // A retry only makes sense while the user still wants the link: a disconnect, a host
  // removal or a shutdown that raced the timer must not resurrect the connection.
  if (ctx.state.disposed === true || runtime.desired !== 'connected') {
    void dispatch(
      effectsOf(ctx),
      runtime,
      { type: 'reconnect.skipped' },
      scopeFactsFor(ctx, runtime, { type: 'reconnect.skipped' }),
      {
        caller: 'timer',
      },
    )
    return
  }
  const settings = ctx.settings()
  if (!runtime.entry.autoReconnect || !settings.autoReconnect.enabled) {
    void dispatch(
      effectsOf(ctx),
      runtime,
      { type: 'reconnect.skipped' },
      scopeFactsFor(ctx, runtime, { type: 'reconnect.skipped' }),
      {
        caller: 'timer',
      },
    )
    return
  }
  const maxAttempts = settings.autoReconnect.maxAttempts
  if (runtime.reconnectAttempts >= maxAttempts) {
    const event = {
      type: 'reconnect.gaveup' as const,
      maxAttempts,
      view: toErrorView(
        errors.network({
          zh: `连接已断开，自动重连 ${maxAttempts} 次均失败。远端任务可能仍在运行。`,
          en: `The connection dropped and ${maxAttempts} automatic retries failed. Remote tasks may still be running.`,
        }),
      ),
    }
    void dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'timer' })
    return
  }
  const attempt = runtime.reconnectAttempts + 1
  const delay = randomDelay(
    settings.autoReconnect.baseDelayMs,
    settings.autoReconnect.baseDelayMs * 2 ** Math.min(attempt, 4),
  )
  ctx.progress.log(
    runtime,
    'warn',
    `link lost; retrying in ${Math.round(delay / 100) / 10}s (attempt ${attempt}/${maxAttempts})`,
  )
  void dispatch(
    effectsOf(ctx),
    runtime,
    { type: 'reconnect.scheduled', attempt, max: maxAttempts, delayMs: delay },
    scopeFactsFor(ctx, runtime, { type: 'reconnect.scheduled', attempt, max: maxAttempts, delayMs: delay }),
    {
      caller: 'timer',
      armReconnect: (ms) => {
        runtime.reconnectTimer = setTimeout(() => {
          runtime.reconnectTimer = null
          onDue()
        }, ms)
        // A pending retry must never keep the host process alive on its own.
        runtime.reconnectTimer.unref?.()
      },
    },
  )
}

/**
 * The idle policy's timer. It is a *guard* first and a stop second: `idle.elapsed` is the FSM's
 * statement that the host is no longer wanted (`stillWanted`), and a refusal — the user connected
 * again while the timer was armed — is logged at debug by the event itself, never as a warning.
 */
export function scheduleIdleStop(ctx: WatchdogCtx, runtime: HostRuntime): void {
  cancelIdleStop(runtime)
  const minutes = Math.max(1, runtime.entry.idleMinutes ?? DEFAULT_IDLE_MINUTES)
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null
    const event = { type: 'idle.elapsed' as const }
    void dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'timer' }).then(
      async (result) => {
        // The rule allows the stop only while the host is idle; `stopRemoteForIdle` re-checks the
        // same condition and remains the single implementation of the policy itself.
        if (result.ok) await stopRemoteForIdle(ctx, runtime)
      },
    )
  }, minutes * 60_000)
  runtime.idleTimer.unref?.()
}

/**
 * Best-effort stop of the remote web for the idle policy, then drop the transport.
 *
 * The teardown that armed this timer clears `facts` and `remote`, so the stop has to use the
 * home and pid remembered before that clearing: the old fallback built a layout with a
 * literal `~`, whose `kill -0` is a no-op that still reported success (H1).
 *
 * The timer is a *policy for an idle host*, never authority over a live link: the user may
 * have connected again (the timer would otherwise kill the link just brought up), and a pid
 * that answers `/proc` is not proof it is still the process this connection started
 * (review: idle-timer zombie / pid reuse). Shutdown is the one caller that deliberately
 * overrides the "still wanted" guard, because it is stopping the whole host process.
 *
 * @param ctx - service context.
 * @param runtime - host runtime that went idle.
 * @returns the stop verdict (best effort).
 */
export async function stopRemoteForIdle(
  ctx: WatchdogCtx,
  runtime: HostRuntime,
  options: { shutdown?: boolean } = {},
): Promise<LifecycleVerdict> {
  // A live link wins over the idle policy, whichever timer fired it. This is what keeps a
  // manual reconnect from being torn down by the timer armed before it.
  const linkLive = runtime.desired === 'connected' || runtime.status === 'connected' || runtime.tunnel !== null
  if (linkLive && options.shutdown !== true) {
    ctx.progress.log(runtime, 'debug', 'idle stop skipped: the host is connected again')
    return { ok: false, reason: 'still-wanted' }
  }
  // The transport this call owns: the identity proof below awaits, and the user may connect
  // in that window. Only this session may be released afterwards, never the new one.
  const capturedSsh = runtime.ssh
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
    // Without a pid there is nothing this policy may signal: `stopRemoteWeb` would fall back
    // to the run registry and could stop an instance this connection did not launch.
    if (!isPid(pid)) return { ok: false, reason: 'pid-unknown' }
    // Same `/proc` identity proof the explicit stop uses (`OWNERSHIP_OPTIONS.idle`): a reused
    // pid, another DSH home or another profile is not this connection's process and must not be
    // signalled — and unlike the stop, nobody pointed at it, only the timer fired.
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
    // The user may have connected while the identity was read: the link wins again.
    if (options.shutdown !== true && stillWanted()) {
      ctx.progress.log(runtime, 'debug', 'idle stop skipped: the host is connected again')
      return { ok: false, reason: 'still-wanted' }
    }
    const stopped = await ctx.deps.stopWeb(capturedSsh, layout, { pid })
    if (stopped?.ok !== true) {
      ctx.progress.log(
        runtime,
        'warn',
        `idle stop did not confirm (${stopped?.reason ?? 'unknown'}); the remote may still be running`,
      )
      return { ok: false, reason: stopped?.reason ?? 'not-confirmed' }
    }
    runtime.remotePid = null
    return { ok: true }
  } catch (error) {
    // swallow-ok: the idle stop is best effort; its failure is only a warning and the timer
    // is already gone, so the host stays idle either way
    ctx.progress.log(runtime, 'warn', 'idle stop failed:', messageOf(error))
    return { ok: false, reason: 'error' }
  } finally {
    // Release only the transport this call captured: when a new connection owns the link by
    // now, its session is not ours to dispose.
    if (runtime.ssh === capturedSsh) await disposeSsh(runtime)
  }
}

export async function closeTunnel(runtime: HostRuntime): Promise<void> {
  const tunnel = runtime.tunnel
  runtime.tunnel = null
  // `localPort` is a view of the live listener: a closed tunnel must not leave a stale port
  // behind (the proxy and diagnostics read this field).
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
 * @param ctx - service context.
 * @param runtime - host runtime.
 */
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

/** What one teardown may keep alive; every flag defaults to a full release. */
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
  // A prompt parked on the transport that is about to go away can never be answered: settle
  // it now instead of letting the connect promise wait for its 120s timeout (M1).
  cancelHostKeyPrompt(runtime)
  cancelLinkWork(runtime)
  stopRemoteHeartbeat(runtime)
  runtime.closing = true
  cancelIdleStop(runtime)
  // A tunnel rebuild owns a listener it may be creating right now. Cancel it (above), then
  // wait for it to clean up: otherwise the listener would be assigned after this teardown.
  await settleTunnelRepair(ctx, runtime)
  // Remember where the remote lives before the facts below are cleared: the idle policy and
  // a later stop still need the real home, never a literal `~` (H1).
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
      // Only a confirmed stop means the pid is gone; a refusal keeps the memory so a later
      // stop can try again instead of reporting a process that never stopped.
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

/** What a disconnect may assume the caller already did to the remote web. */
export interface DisconnectOptions {
  stopRemote?: boolean
  stopped?: boolean
}

/**
 * Tear one host down and leave it idle: the keep-alive policy decides whether the
 * remote web is stopped and whether the transport survives for a fast resume.
 * `stopped` says the caller already stopped the remote web itself (the explicit
 * "stop remote DSH" action): the policy must then neither arm an idle stop nor send
 * a second stop signal. That second signal would be based on a pid captured several
 * SSH round-trips earlier - a pid the action just proved is the right one (or that
 * it is already gone), so re-signalling it is at best redundant and at worst kills
 * an unrelated process after a pid reuse.
 *
 * The state write, the timer disarms, the prompt settlement, the teardown and the idle timer are
 * one transition (`disconnect.requested`); this function only keeps the log line and the event
 * arguments the API passes.
 */
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
  // The explicit stop action may have kept the transport for its own teardown; the disconnect
  // still releases the token (the teardown path already dropped it, this is the idempotent half).
  runtime.token = null
  return { ok: true }
}

/**
 * Release one runtime during shutdown. This is today's shutdown branch: the `stop` policy stops
 * the managed remote web through the idle-policy proof, every other policy just drops the
 * listener and the transport (the remote keeps running, and the runtime keeps its facts).
 * @param ctx - service context.
 * @param runtime - host runtime being released.
 * @param stopRemote - whether the keep-alive policy says "stop".
 */
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

/**
 * Stop every host's timers and release its transport. The `stop` keep-alive
 * policy also stops the remote web so nothing is left running unowned.
 */
export async function shutdownAll(ctx: TeardownCtx): Promise<void> {
  for (const runtime of ctx.state.runtimes.values()) {
    // One transition per runtime: it marks the link dead before the first await (a dependent
    // action must not start, or retry, while shutdown is still walking the list) and then
    // releases the transport through the same shutdown branch as before.
    const event = { type: 'shutdown' as const }
    await dispatch(effectsOf(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'silent' })
  }
}

/**
 * The effects of this module, bound to one context.
 *
 * `host-lifecycle` owns the timers and the teardown path, so it builds the effect object itself
 * instead of importing `runtime/effects.ts` (which imports this module). `run` is never reached
 * from here; it is declared because the interface requires it.
 * @param ctx - the watchdog/teardown context.
 * @returns the effect owner for one dispatch call.
 */
function effectsOf(ctx: TeardownCtx): DispatchHost {
  return {
    emit: () => ctx.emitState(),
    log: (runtime, level, message) => ctx.progress.log(runtime, level, message),
    logFailure: (runtime, phase, label, view) =>
      ctx.progress.logFailure(runtime, view ?? runtime.error, { phase, label }),
    arm: (runtime, timer) => {
      if (timer === 'idle') {
        scheduleIdleStop(ctx, runtime)
        return
      }
      // No rule reachable from this module arms the heartbeat: the events that do
      // (`connect.succeeded`, `restart.resumed`, `stop.refused`) are dispatched by `connect/*`,
      // whose effect owner is `runtime/effects.ts`. Importing `watchdog.ts` from here would close
      // the `host-lifecycle -> connect` edge the design forbids, so the branch stays a no-op —
      // declared because the interface requires it, like `run`/`flushLogs` below.
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
        ...(options.keepRemote === true ? { keepRemote: true } : {}),
        ...(options.keepSshForIdle === true ? { keepSshForIdle: true } : {}),
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
        // Kept in step with `runtime/effects.ts#markAttached` (the two effect owners cannot share
        // a module without an import cycle). `connect.succeeded` is the only producer.
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
    flushLogs: () => {
      // The coalescing flush belongs to `connect-progress`; no rule reached from this module emits it.
    },
  }
}

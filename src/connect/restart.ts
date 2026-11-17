/**
 * The local restart of the managed remote web on the same SSH transport: stop exactly the instance
 * this connection launched, `[start]` again on the same plan, rebuild the tunnel for the new
 * random port, verify and resume.
 */
import { REMOTE_START_TIMEOUT_MS } from '../constants.js'
import type { Config, ConnectCtx, HostState, RemoteDeps, Reporter, Store, Transport } from '../context.js'
import { errors, toErrorView } from '../errors.js'
import { closeTunnel, endLinkWork, isLinkWorkCurrent } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import { layoutForRuntime } from '../layout.js'
import { buildRunRegistryRecord, commandMatchesProfile } from '../remote-web.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { isPid, messageOf, nowIso } from '../util.js'
import { markConnected, recordRestart, resumeConnected } from './attach.js'
import { planForRuntime } from './bootstrap.js'
import { SSH_CLOSED_DETAIL } from './failures.js'
import { LinkCancelled } from './guards.js'
import type { ConnectLogWriter, PhaseWriter } from './guards.js'
import type { KnownProcess } from './launch.js'
import { resolveForeignConflict } from './launch.js'
import type { AcceptedResult } from './links.js'
import { OWNERSHIP_OPTIONS, proveOwnership, rememberLaunched } from './ownership.js'
import { readRegistryQuietly } from './registry.js'
import { openTunnelFor } from './transport.js'
import { verifyRemoteUi } from './verify.js'

/**
 * Restart the managed remote web on the same SSH transport: stop the pid the run
 * registry names, `[start]` again on the same plan, rebuild the tunnel for the new
 * random port and verify. `[ssh]` / `[probe]` / `[bootstrap]` are not re-run, so a
 * password or host-key prompt can never appear here.
 *
 * Only the instance this connection launched is stopped; a process the plugin did
 * not start goes through the ordinary conflict prompt instead of being killed.
 *
 * Available while connected, and also from the `remote-unreachable` error state: that
 * state deliberately keeps the SSH transport so the user can restart exactly when a
 * remote re-attach found nothing to adopt (docs/design.md §5.6).
 *
 * @param ctx - service context.
 * @param runtime - host runtime with a live transport.
 * @returns whether the restart started.
 */
export async function restartHost(ctx: ConnectCtx, runtime: HostRuntime): Promise<AcceptedResult> {
  await ctx.init()
  if (runtime.connectPromise || runtime.linkBusy !== null) return { accepted: false, reason: 'busy' }
  const connected = runtime.status === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null
  const recoverable =
    runtime.status === 'error' &&
    runtime.error?.code === 'remote-unreachable' &&
    runtime.ssh?.connected === true &&
    runtime.facts !== null
  if (!connected && !recoverable) {
    throw errors.restartUnavailable()
  }
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`).
  // The token is the old `beginLinkWork` one: the rule adopts it (`epochAfter`) and hands it to the
  // script, so the late-write filter keeps the exact semantics it had.
  const token = (Number(runtime.linkToken) || 0) + 1
  const event = {
    type: 'restart.requested' as const,
    token,
    pid: runtime.remote.pid,
    port: runtime.remote.port,
  }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    caller: 'script',
    run: (activity, started) => {
      if (activity !== 'restart') return
      const work = runRestart(ctx, runtime, started)
      runtime.restartPromise = work
      void work.finally(() => {
        endLinkWork(runtime, started)
        if (runtime.restartPromise === work) runtime.restartPromise = null
      })
    },
  })
  return { accepted: true }
}

async function runRestart(
  ctx: HostState & Config & Transport & RemoteDeps & Reporter & Store,
  runtime: HostRuntime,
  token: number,
): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const previousPort = runtime.remote.port
  // Restarting from the remote-unreachable error state has no tunnel to keep.
  const hadTunnel = runtime.tunnel !== null
  let killable = false
  let stoppedOwn = false
  let started = false
  let tunnelCreated = false
  try {
    // `restart.requested` already disarmed the heartbeat/reconnect/idle timers and published the
    // `start`/`restarting-remote` card.
    log('info', `restart requested (pid=${runtime.remote.pid ?? 'unknown'}, remote port=${previousPort ?? 'unknown'})`)

    // Whether the running pid is ours to stop needs two independent proofs here: the registry
    // names it (below) and this connection launched it with the same /proc identity
    // (`OWNERSHIP_OPTIONS.restart`). A pid that a re-attach discovered, or one kept alongside, is
    // hosted, never killed.
    const registry = await readRegistryQuietly(ctx, runtime, layout)
    const managedPid = Number(runtime.remote.pid ?? 0)
    const registeredPid = Number(registry?.pid ?? 0)
    const registered =
      registry !== null &&
      registry.dshHome === layout.dshHome &&
      registry.profile === profile &&
      isPid(managedPid) &&
      registeredPid === managedPid
    if (registered) {
      const verdict = await proveOwnership(ctx, runtime, {
        ...OWNERSHIP_OPTIONS.restart,
        pid: managedPid,
        layout,
        profile,
      })
      killable = verdict.ok === true
      if (verdict.ok !== true) {
        log(
          'warn',
          `restart: not stopping pid ${managedPid} (${verdict.reason}); only a process this connection launched is stopped`,
        )
      }
    } else {
      log(
        'warn',
        `restart: the run registry does not name this connection's pid (${
          isPid(managedPid) ? managedPid : 'unknown'
        }); leaving the running instance alone`,
      )
    }
    // A live instance this connection cannot stop and did not launch (typically the pid a
    // re-attach discovered) still occupies this ~/.dsh + profile. It goes through the conflict
    // prompt: restarting must never start a second instance silently next to it
    // (docs/design.md §5.5). Pids this connection launched are its own current instance; the
    // registry mismatch is the caller's existing "leave it alone" behavior, not a foreign one.
    let knownProcess: KnownProcess | null = null
    const launchedHere = runtime.launched instanceof Map && runtime.launched.has(managedPid)
    if (!killable && !launchedHere && isPid(managedPid) && runtime.ssh?.connected === true) {
      const identity = await ctx.deps.processIdentity(runtime.ssh, managedPid)
      if (identity.ok === true) {
        const sameHome = identity.dshHome === '' || identity.dshHome === layout.dshHome
        if (sameHome && commandMatchesProfile(identity.command, profile)) {
          knownProcess = { pid: managedPid, command: identity.command }
        }
      } else if (identity.reason === 'unreadable') {
        // Alive but not provable: asking is safer than starting a second instance.
        knownProcess = { pid: managedPid, command: `dsh --profile ${profile}` }
      }
    }
    if (!isLinkWorkCurrent(runtime, token)) return

    // Ask about foreign instances BEFORE anything is stopped: cancelling the prompt must not
    // destroy the instance the user is currently connected to (docs/design.md §5.5).
    const decision = await resolveForeignConflict(ctx, runtime, layout, profile, {
      ignoredPids: Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : [],
      knownProcess,
    })
    if (!isLinkWorkCurrent(runtime, token)) return
    // The prompt stopped the instance this connection was attached to: the old attachment is
    // gone, so a later failure must not "resume" it.
    if (decision === 'stop') stoppedOwn = true

    if (killable) {
      const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid: managedPid })
      // A stop can take seconds; the link may have been dropped or replaced in the meantime.
      // A late action must not write warning/connected state on top of that.
      if (!isLinkWorkCurrent(runtime, token)) return
      stoppedOwn = stopped?.ok === true
      if (stoppedOwn) {
        log('info', `restart: stopped the managed remote web pid=${managedPid}`)
        if (runtime.launched instanceof Map) runtime.launched.delete(managedPid)
      } else {
        // Never start a second instance next to one whose stop was not confirmed. The old
        // tunnel is still open, so the host stays usable and the user can retry. The warning is
        // action-scoped data with no transition of its own: it is set here and cleared by
        // `connect.succeeded` once a fresh attach replaces the stale instance.
        runtime.warning = {
          zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试，或先断开再重连。',
          en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly, or disconnect and reconnect.',
        }
        runtime.warningSource = 'restart-stop'
        log(
          'warn',
          `restart: the managed remote web did not confirm its stop; not launching a second instance (${
            String(stopped?.output ?? '').slice(0, 300) || 'no output'
          })`,
        )
        if (await resumeConnected(ctx, runtime, true)) return
        // The link changed under us, or there was no tunnel to keep (restart from the error
        // state): never publish a fake "connected" state; explain instead of staying stuck.
        if (isLinkWorkCurrent(runtime, token) && runtime.status === 'connecting') {
          const failure = {
            type: 'restart.failed' as const,
            phase: 'start' as const,
            view: toErrorView(
              errors.restartUnavailable({
                zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试。',
                en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly.',
              }),
            ),
          }
          await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
            caller: 'script',
            keepLink: true,
          })
        }
        return
      }
    }
    if (!isLinkWorkCurrent(runtime, token)) return

    const { plan, targetVersion, facts } = planForRuntime(ctx, runtime, profile)
    phase('start', 'restarting-remote', { level: plan.level })
    log('info', `restart: launching @deepseek-ai/dsh@${plan.start.targetVersion} with profile ${profile}`)
    const webInfo = await ctx.deps.startWeb(runtime.ssh, {
      plan,
      layout,
      profile,
      timeoutMs: REMOTE_START_TIMEOUT_MS,
      onLine: (line) => log('debug', `remote: ${line}`),
    })
    started = true
    if (!isLinkWorkCurrent(runtime, token)) return
    await rememberLaunched(ctx, runtime, webInfo.pid, layout, profile)
    if (webInfo.browserCarrier === 'patched') {
      log(
        'info',
        'the remote profile disables api-remotes (browser Remote-Event carrier); re-enabled it for this launch',
      )
    }
    log('info', `restart: remote DSH started pid ${webInfo.pid ?? '?'}, port ${webInfo.port}`)

    const record = buildRunRegistryRecord({
      pid: webInfo.pid,
      port: webInfo.port,
      version: targetVersion,
      profile,
      dshHome: layout.dshHome,
      startedAt: webInfo.startedAt,
    })
    const written = await ctx.deps.writeRegistry(runtime.ssh, layout, record)
    if (written.ok === true) log('info', `restart: run registry refreshed (pid ${record.pid}, port ${record.port})`)
    else log('warn', 'restart: the run registry could not be refreshed:', written.output)
    if (!isLinkWorkCurrent(runtime, token)) return

    // The remote picked a random port again, so the old tunnel points at a dead port.
    phase('tunnel', 'tunneling')
    await closeTunnel(runtime)
    runtime.token = webInfo.token
    runtime.remote = {
      ...runtime.remote,
      version: targetVersion,
      uiReady: false,
      localPort: null,
      port: webInfo.port,
      pid: webInfo.pid ?? null,
      dshHome: layout.dshHome,
      profile,
      bootstrapLevel: plan.level,
      nodeVersion: facts.nodeVersion,
      nodeSource: 'managed',
      startedAt: webInfo.startedAt ?? nowIso(),
    }
    const tunnel = await openTunnelFor(ctx, runtime, webInfo.port)
    tunnelCreated = true
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token, tunnel.localPort)
    if (!isLinkWorkCurrent(runtime, token)) return
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, webInfo.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    recordRestart(runtime, {
      kind: 'local-restart',
      fromPort: previousPort,
      toPort: webInfo.port,
      pid: webInfo.pid ?? null,
    })
    await markConnected(ctx, runtime)
    log(
      'info',
      `restart: connected again on 127.0.0.1:${runtime.tunnel?.localPort ?? tunnel.localPort} (remote port ${previousPort} -> ${webInfo.port})`,
    )
  } catch (error) {
    if (!isLinkWorkCurrent(runtime, token)) {
      log('debug', 'restart aborted: the link was replaced by a disconnect or reconnect')
      return
    }
    // Nothing this connection owned was stopped, so the previous attachment is still
    // valid: cancelling a conflict prompt (or a failed relaunch) keeps the host usable.
    if (!stoppedOwn && !started && hadTunnel && runtime.ssh?.connected === true && runtime.tunnel !== null) {
      log('warn', `restart cancelled: ${messageOf(error)}; keeping the current remote instance`)
      await resumeConnected(ctx, runtime)
      return
    }
    const view =
      error instanceof LinkCancelled
        ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during restart' }))
        : toErrorView(error)
    // Phase is cleared with the status; capture it first so the log says where it stopped.
    const failedPhase = runtime.phase
    // The transition owns the error state, the failure lines and the teardown; the caller keeps
    // its own publication point (`emit:false`, emitted below exactly where it always was).
    const failure = { type: 'restart.failed' as const, view, phase: failedPhase }
    await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
      caller: 'script',
      emit: false,
      // Only a remote this restart launched is stopped; a restart that failed before the launch
      // leaves the instance it never touched alone (the rule cannot tell the two apart).
      teardown: { stopRemote: started && runtime.entry.keepAlive === 'stop' },
    })
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action: a disconnect (or a host
    // removal) during the rebuild would otherwise leave it open with a disposed SSH channel.
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
}

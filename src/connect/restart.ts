/** The local restart of the managed remote web on the same SSH transport: stop exactly the instance this connection launched, `[start]` again on the same plan, rebuild the tunnel for the new random port, verify and resume. */
import { REMOTE_START_TIMEOUT_MS } from '../constants.js'
import type { ConnectCtx } from '../context.js'
import { errors, toErrorView } from '../errors.js'
import { closeTunnel, endLinkWork, isLinkWorkCurrent } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import { layoutForRuntime } from '../layout.js'
import { buildRunRegistryRecord, registryNamesInstance } from '../remote-web/registry.js'
import { commandMatchesProfile } from '../remote-web/resolve.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { isPid, messageOf, nowIso } from '../util.js'
import { markConnected, recordRestart, resumeConnected } from './attach.js'
import { planForRuntime } from './bootstrap.js'
import { SSH_CLOSED_DETAIL } from './failures.js'
import { LinkCancelled, linkActionState } from './guards.js'
import type { ConnectLogWriter, PhaseWriter } from './guards.js'
import { PATCHED_CARRIER_NOTE, resolveForeignConflict, type KnownProcess } from './launch.js'
import type { AcceptedResult } from './links.js'
import { OWNERSHIP_OPTIONS, proveOwnership, rememberLaunched } from './ownership.js'
import { readRegistryQuietly } from './registry.js'
import { openTunnelFor } from './transport.js'
import { verifyRemoteUi } from './verify.js'

/** Restart the managed remote web on the same SSH transport; `[ssh]`/`[probe]`/`[bootstrap]` are not re-run, so no password or host-key prompt can appear here. Also available from the `remote-unreachable` error state, which keeps the SSH transport on purpose. */
export async function restartHost(ctx: ConnectCtx, runtime: HostRuntime): Promise<AcceptedResult> {
  await ctx.init()
  if (runtime.connectPromise || runtime.linkBusy !== null) return { accepted: false, reason: 'busy' }
  // A live link, or the `remote-unreachable` error state that deliberately keeps the SSH transport.
  if (linkActionState(runtime) === null) throw errors.restartUnavailable()
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`), and adopts the token.
  const token = (Number(runtime.linkToken) || 0) + 1
  const event = { type: 'restart.requested' as const, token, pid: runtime.remote.pid, port: runtime.remote.port }
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

/** The action body: proof of ownership, the conflict prompt, stop/start, the registry rewrite, the tunnel and the verify step all read the same six slices as its entry point. */
async function runRestart(ctx: ConnectCtx, runtime: HostRuntime, token: number): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const previousPort = runtime.remote.port
  const hadTunnel = runtime.tunnel !== null
  let killable = false
  let stoppedOwn = false
  let started = false
  let tunnelCreated = false
  try {
    log('info', `restart requested (pid=${runtime.remote.pid ?? 'unknown'}, remote port=${previousPort ?? 'unknown'})`)
    // Stopping needs two independent proofs: the registry names this connection's pid, and this connection launched it
    // with the same /proc id. A pid a re-attach found, or one kept alongside, is hosted, never killed.
    const registry = await readRegistryQuietly(ctx, runtime, layout)
    const managedPid = Number(runtime.remote.pid ?? 0)
    if (registryNamesInstance(registry, layout, profile, managedPid)) {
      const verdict = await proveOwnership(ctx, runtime, {
        ...OWNERSHIP_OPTIONS.restart,
        pid: managedPid,
        layout,
        profile,
      })
      killable = verdict.ok === true
      if (verdict.ok !== true) {
        const why = `restart: not stopping pid ${managedPid} (${verdict.reason}); only a process this connection launched is stopped`
        log('warn', why)
      }
    } else {
      const which = isPid(managedPid) ? managedPid : 'unknown'
      log(
        'warn',
        `restart: the run registry does not name this connection's pid (${which}); leaving the running instance alone`,
      )
    }
    // A live instance this connection cannot stop and did not launch is hosted, not raced: it goes through the conflict prompt.
    let knownProcess: KnownProcess | null = null
    const launchedHere = runtime.launched instanceof Map && runtime.launched.has(managedPid)
    if (!killable && !launchedHere && isPid(managedPid) && runtime.ssh?.connected === true) {
      const identity = await ctx.deps.processIdentity(runtime.ssh, managedPid)
      if (identity.ok === true) {
        const sameHome = identity.dshHome === '' || identity.dshHome === layout.dshHome
        if (sameHome && commandMatchesProfile(identity.command, profile))
          knownProcess = { pid: managedPid, command: identity.command }
        // Alive but not provable: asking is safer than starting a second instance.
      } else if (identity.reason === 'unreadable') {
        knownProcess = { pid: managedPid, command: `dsh --profile ${profile}` }
      }
    }
    if (!isLinkWorkCurrent(runtime, token)) return
    // Ask about foreign instances BEFORE anything is stopped: cancelling the prompt must not destroy
    // the instance the user is currently connected to.
    const decision = await resolveForeignConflict(ctx, runtime, layout, profile, {
      ignoredPids: Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : [],
      knownProcess,
    })
    if (!isLinkWorkCurrent(runtime, token)) return
    if (decision === 'stop') stoppedOwn = true
    if (killable) {
      // A stop can take seconds; the link may have been dropped or replaced in the meantime.
      const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid: managedPid })
      if (!isLinkWorkCurrent(runtime, token)) return
      stoppedOwn = stopped?.ok === true
      if (stoppedOwn) {
        log('info', `restart: stopped the managed remote web pid=${managedPid}`)
        if (runtime.launched instanceof Map) runtime.launched.delete(managedPid)
      } else {
        // Never start a second instance next to one whose stop was not confirmed: the old tunnel still works, so the
        // host stays usable. The warning is action-scoped; `connect.succeeded` clears it once a fresh attach replaces.
        runtime.warning = {
          zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试，或先断开再重连。',
          en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly, or disconnect and reconnect.',
        }
        runtime.warningSource = 'restart-stop'
        log(
          'warn',
          `restart: the managed remote web did not confirm its stop; not launching a second instance (${String(stopped?.output ?? '').slice(0, 300) || 'no output'})`,
        )
        if (await resumeConnected(ctx, runtime, true)) return
        // The link changed under us, or there was no tunnel to keep (restart from the error state):
        // never publish a fake "connected" state; explain instead of staying stuck.
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
    if (webInfo.browserCarrier === 'patched') log('info', PATCHED_CARRIER_NOTE)
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
    // Nothing this connection owned was stopped, so the previous attachment is still valid:
    // cancelling a conflict prompt (or a failed relaunch) keeps the host usable.
    if (!stoppedOwn && !started && hadTunnel && runtime.ssh?.connected === true && runtime.tunnel !== null) {
      log('warn', `restart cancelled: ${messageOf(error)}; keeping the current remote instance`)
      await resumeConnected(ctx, runtime)
      return
    }
    const view =
      error instanceof LinkCancelled
        ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during restart' }))
        : toErrorView(error)
    const failure = { type: 'restart.failed' as const, view, phase: runtime.phase }
    await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
      caller: 'script',
      emit: false,
      // Only a remote this restart launched is stopped; a restart that failed before the launch leaves
      // the instance it never touched alone.
      teardown: { stopRemote: started && runtime.entry.keepAlive === 'stop' },
    })
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action: a disconnect during the rebuild
    // would leave it open with a disposed SSH channel.
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
}

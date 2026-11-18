/**
 * The re-attach to a remote web that restarted on its own (plugin-market update, supervisor,
 * remote reboot): re-read the real pid/port, refresh `run/web.json`, rebuild the tunnel, take the
 * new launch token and verify. The SSH session and the host entry are untouched.
 */
import { REMOTE_REATTACH_ATTEMPTS, REMOTE_REATTACH_INTERVAL_MS } from '../constants.js'
import type { ConnectCtx, ReattachRequest } from '../context.js'
import { errors, toErrorView } from '../errors.js'
import { closeTunnel, endLinkWork, isLinkWorkCurrent } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import { layoutForRuntime } from '../layout.js'
import { buildRunRegistryRecord } from '../remote-web/registry.js'
import type { ResolvedRemoteWeb } from '../remote-web/resolve.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { nowIso, sleep } from '../util.js'
import { normalizeVersion, versionsEqual } from '../version.js'
import { markConnected, recordRestart } from './attach.js'
import { SSH_CLOSED_DETAIL } from './failures.js'
import { LinkCancelled } from './guards.js'
import type { ConnectLogWriter, PhaseWriter } from './guards.js'
import type { AcceptedResult } from './links.js'
import { rememberBound } from './ownership.js'
import { openTunnelFor } from './transport.js'
import { verifyRemoteUi } from './verify.js'

/**
 * Re-attach to a remote web that restarted on its own (plugin-market update, supervisor,
 * remote reboot): re-read the real pid/port, refresh `run/web.json`, rebuild the tunnel,
 * take the new launch token and verify. The SSH session and the host entry are untouched.
 *
 * @param ctx - service context.
 * @param runtime - host runtime the watchdog decided is unreachable.
 * @param info - why the re-attach was requested.
 * @returns whether the re-attach started.
 */
export async function reattachHost(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  info: ReattachRequest = {},
): Promise<AcceptedResult> {
  if (runtime.status !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) {
    return { accepted: false, reason: 'not-connected' }
  }
  if (runtime.connectPromise || runtime.linkBusy !== null) return { accepted: false, reason: 'busy' }
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`);
  // the token is the old `beginLinkWork` one so the late-write filter keeps its semantics.
  const token = (Number(runtime.linkToken) || 0) + 1
  const reason = typeof info?.reason === 'string' && info.reason !== '' ? info.reason : 'remote-unreachable'
  const event = { type: 'reattach.requested' as const, token, reason }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    caller: 'script',
    run: (activity, started) => {
      if (activity !== 'reattach') return
      const work = runReattach(ctx, runtime, info, started)
      runtime.reattachPromise = work
      void work.finally(() => {
        endLinkWork(runtime, started)
        if (runtime.reattachPromise === work) runtime.reattachPromise = null
      })
    },
  })
  return { accepted: true }
}

/**
 * The action body: the re-attach re-reads the remote state, rewrites the run registry, rebuilds the
 * tunnel and verifies the UI, so it spans all six slices exactly like its entry point — the same
 * `ConnectCtx`, not a copied intersection (the gate's `godCtxParams` entries name it).
 */
async function runReattach(ctx: ConnectCtx, runtime: HostRuntime, info: ReattachRequest, token: number): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const fromPort = runtime.remote.port
  const reason = typeof info?.reason === 'string' && info.reason !== '' ? info.reason : 'remote-unreachable'
  let tunnelCreated = false
  try {
    // `reattach.requested` already disarmed the timers and published the `restarting-remote` card.
    log('info', `remote restart suspected: ${reason}; re-reading the remote state`)

    // A restart takes a moment to print its new readiness line: retry before giving up.
    const attempts = Math.max(1, Number(ctx.timers.reattachAttempts) || REMOTE_REATTACH_ATTEMPTS)
    const intervalMs = Math.max(0, Number(ctx.timers.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS) || 0)
    let resolved: ResolvedRemoteWeb | null = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!isLinkWorkCurrent(runtime, token)) return
      resolved = await ctx.deps.resolveRemote(runtime.ssh, layout, { profile })
      if (resolved?.ok === true) break
      log(
        'debug',
        `re-attach: remote state not ready yet (${resolved?.reason ?? 'unreadable'}), attempt ${attempt}/${attempts}`,
      )
      if (attempt < attempts && intervalMs > 0) await sleep(intervalMs)
    }
    if (!isLinkWorkCurrent(runtime, token)) return
    // `resolved?.ok !== true` is the same test as `!resolved || resolved.ok !== true`, and it is
    // the form the compiler can narrow: with `strictNullChecks` off the disjunction's `!resolved`
    // arm widens the branch back to the whole union.
    if (resolved?.ok !== true) {
      const detail =
        resolved?.reason === 'no-token'
          ? {
              zh: '远端 DSH 仍在运行，但它这次重启没有留下可用的 launch token，无法自动重新挂载；请点「重启」或「重连」。',
              en: 'The remote DSH is still running, but its restart left no usable launch token, so it cannot be re-attached; use "Restart" or Reconnect.',
            }
          : {
              zh: `远端 DSH 重启后没有找到可以重新挂载的实例（${resolved?.reason ?? 'unreadable'}）；主机与配置已保留。`,
              en: `No re-attachable remote DSH instance was found after the restart (${
                resolved?.reason ?? 'unreadable'
              }); the host and its settings are kept.`,
            }
      throw errors.remoteUnreachable(detail, {
        technical: `reason=${resolved?.reason ?? 'unknown'} fromPort=${fromPort ?? 'unknown'}`,
      })
    }
    // A takeover needs the new launch token: a real DSH rejects `/?token=` and a cookie-less
    // request, so an empty token can never be treated as success (B4).
    if (typeof resolved.token !== 'string' || resolved.token === '') {
      throw errors.remoteUnreachable(
        {
          zh: '远端 DSH 重启后没有留下可用的 launch token，无法自动重新挂载；请点「重启」或「重连」。',
          en: 'The restarted remote DSH left no usable launch token, so it cannot be re-attached; use "Restart" or Reconnect.',
        },
        { technical: `reason=no-token source=${resolved.source ?? 'unknown'} port=${resolved.port ?? 'unknown'}` },
      )
    }
    const targetVersion = ctx.localVersion()
    const remoteVersion =
      typeof resolved.version === 'string' && resolved.version !== '' ? normalizeVersion(resolved.version) : null
    if (remoteVersion && targetVersion && !versionsEqual(remoteVersion, targetVersion)) {
      // A different DSH under the same ~/.dsh would show a UI that does not match this machine;
      // the user's remedy is the explicit restart, which launches the pinned version.
      throw errors.versionMismatch(targetVersion, remoteVersion)
    }
    if (remoteVersion === null) {
      log(
        'warn',
        're-attach: the running DSH version could not be proven; keeping it unknown, not assuming the local one',
      )
    }
    // The pid that actually listens may differ from the wrapper this connection launched (npx
    // spawns the DSH). Keep the kill right only for the pid we are now attached to.
    if (runtime.launched instanceof Map) {
      for (const pid of [...runtime.launched.keys()]) {
        if (pid !== resolved.pid) runtime.launched.delete(pid)
      }
    }
    log(
      'info',
      `re-attach: found remote web pid=${resolved.pid} port=${resolved.port} (source=${resolved.source}); refreshing the run registry`,
    )
    const record = buildRunRegistryRecord({
      pid: resolved.pid,
      port: resolved.port,
      // Never launder an unproven version into the registry.
      version: remoteVersion ?? '',
      profile,
      dshHome: layout.dshHome,
      origin: 'reattach',
    })
    const written = await ctx.deps.writeRegistry(runtime.ssh, layout, record)
    if (written.ok === true) log('info', `re-attach: run registry refreshed (pid ${record.pid}, port ${record.port})`)
    else log('warn', 're-attach: the run registry could not be refreshed:', written.output)
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('tunnel', 'tunneling')
    await closeTunnel(runtime)
    runtime.token = resolved.token
    runtime.remote = {
      ...runtime.remote,
      version: remoteVersion,
      uiReady: false,
      localPort: null,
      port: resolved.port,
      pid: resolved.pid,
      dshHome: resolved.dshHome ?? layout.dshHome,
      profile: resolved.profile ?? profile,
      startedAt: nowIso(),
    }
    const tunnel = await openTunnelFor(ctx, runtime, resolved.port)
    tunnelCreated = true
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, resolved.port, resolved.token, tunnel.localPort)
    if (!isLinkWorkCurrent(runtime, token)) return
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, resolved.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    // The re-attached instance is now the one this connection is bound to. It stays out of
    // `launched` (a restart must not kill it), but the explicit stop action may end exactly it.
    await rememberBound(ctx, runtime, resolved.pid, layout, profile, 'reattach')
    if (!isLinkWorkCurrent(runtime, token)) return
    recordRestart(runtime, {
      kind: 'remote-reattach',
      fromPort,
      toPort: resolved.port,
      pid: resolved.pid,
      reason,
      source: resolved.source,
    })
    await markConnected(ctx, runtime)
    log(
      'info',
      `re-attached: remote ${runtime.remote.version ?? 'version unknown'} on 127.0.0.1:${
        runtime.tunnel?.localPort ?? tunnel.localPort
      } (remote port ${fromPort} -> ${resolved.port})`,
    )
  } catch (error) {
    if (!isLinkWorkCurrent(runtime, token)) {
      log('debug', 're-attach aborted: the link was replaced by a disconnect or reconnect')
      return
    }
    const view =
      error instanceof LinkCancelled
        ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during re-attach' }))
        : toErrorView(error)
    // The transition owns the error state, the listener release, the heartbeat disarm, the
    // failure lines (`logFailure` reads the phase it is about to clear) and the publication.
    const failure = { type: 'reattach.failed' as const, view }
    await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
      caller: 'script',
      emit: false,
    })
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action (see runRestart).
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
}

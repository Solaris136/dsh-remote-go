/**
 * The explicit "stop remote DSH": prove the pid is the instance this connection is bound to,
 * signal it, clear the stale record and release the link onto `disconnected` (settings and
 * credentials kept, no automatic reconnect).
 */
import type { ConnectProgressState } from '../connect-progress.js'
import type { Config, ConnectCtx, HostState, RemoteDeps, Reporter, Transport } from '../context.js'
import { errors, toErrorView } from '../errors.js'
import type { ErrorView } from '../errors.js'
import { endLinkWork, isLinkWorkCurrent } from '../host-lifecycle.js'
import type { ConnectPhase, HostRuntime, HostStatus } from '../host-runtime.js'
import { layoutForRuntime } from '../layout.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import type { BilingualText } from '../util.js'
import { isPid } from '../util.js'
import type { ConnectLogWriter } from './guards.js'
import { OWNERSHIP_OPTIONS, proveOwnership } from './ownership.js'

/** The remote web this connection stopped (null when it was already gone). */
export interface StopRemoteResult {
  ok: boolean
  pid: number | null
}

/** The state a failed stop has to put back exactly as it found it. */
interface StopState {
  status: HostStatus
  phase: ConnectPhase | null
  progress: ConnectProgressState | null
  error: ErrorView | null
  uiReady: boolean
  localPort: number | null
}

/** Why the explicit stop refused, as the bilingual `ErrorView.detail` the Client renders. */
function describeStopRefusal(reason: string, pid: number): BilingualText {
  const target = isPid(pid) ? `pid ${pid}` : 'pid unknown'
  switch (reason) {
    case 'kept-alongside':
      return {
        zh: `远端进程 ${target} 是你在冲突提示里选择「保留」的实例，不会被停止。`,
        en: `The remote process ${target} is the one you chose to keep alongside; it will not be stopped.`,
      }
    case 'not-launched-by-this-connection':
    case 'not-the-bound-instance':
      return {
        zh: '远端进程不是本连接启动或接管的实例，无法证明归属，因此没有停止它；可以点「重连」。',
        en: 'The remote process is not the instance this connection launched or took over, so its ownership cannot be proven and it was not stopped; use Reconnect.',
      }
    case 'registry-mismatch':
      return {
        zh: '远端 run/web.json 没有命名本连接的进程（或读不到），无法证明归属，因此没有停止它。',
        en: 'The remote run/web.json does not name this connection\u2019s process (or could not be read), so ownership cannot be proven and nothing was stopped.',
      }
    case 'pid-reused':
      return {
        zh: '这个 pid 已被另一个进程复用，不是本连接启动的 DSH；没有停止它。',
        en: 'This pid was reused by another process, not the DSH this connection launched; nothing was stopped.',
      }
    case 'dsh-home-mismatch':
    case 'profile-mismatch':
      return {
        zh: '远端进程的 DSH home / profile 与本连接不一致，没有停止它。',
        en: 'The remote process runs a different DSH home / profile than this connection; nothing was stopped.',
      }
    case 'pid-unknown':
      return {
        zh: '本连接没有记录远端 DSH 的 pid，无法定位要停止的进程。',
        en: 'This connection has no recorded remote DSH pid, so there is no process to stop.',
      }
    default:
      return {
        zh: `无法读取远端进程 ${target} 的身份（${reason}），没有停止它。`,
        en: `The identity of the remote process ${target} could not be proven (${reason}), so nothing was stopped.`,
      }
  }
}

/**
 * Stop the remote DSH this connection manages, then release the link: the tunnel closes,
 * the SSH session is released and the host lands on `disconnected` (settings and credentials
 * kept, no automatic reconnect) so the card offers Reconnect again. `run/web.json` is removed
 * by the stop itself, so the next connect starts a clean instance instead of raising the
 * "a manually started DSH is already running" conflict.
 *
 * Unlike the disconnect action this never kills a pid without an ownership proof: it reuses
 * the restart's `/proc` identity rules and additionally accepts the re-attached pid this
 * connection is bound to (docs/design.md §5.7). Available while connected and in the
 * `remote-unreachable` error state, which keeps the SSH session on purpose.
 *
 * @param ctx - service context.
 * @param runtime - host runtime.
 * @returns the stopped pid (null when already gone).
 */
export async function stopRemoteHost(ctx: ConnectCtx, runtime: HostRuntime): Promise<StopRemoteResult> {
  await ctx.init()
  if (runtime.connectPromise || runtime.linkBusy !== null) {
    throw errors.stopRemoteUnavailable(
      {
        zh: '这台主机正在执行另一个连接动作，请等它结束后再关闭远端 DSH。',
        en: 'This host is busy with another link action; wait for it to finish before stopping the remote DSH.',
      },
      { technical: 'reason=link-busy' },
    )
  }
  const connected = runtime.status === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null
  const recoverable =
    runtime.status === 'error' &&
    runtime.error?.code === 'remote-unreachable' &&
    runtime.ssh?.connected === true &&
    runtime.facts !== null
  if (!connected && !recoverable) throw errors.stopRemoteUnavailable()
  // The `previous` snapshot is what `stop.refused` restores; it is captured before the action
  // writes anything.
  const previous: StopState = {
    status: runtime.status,
    phase: runtime.phase,
    progress: runtime.progress,
    error: runtime.error,
    uiReady: runtime.remote.uiReady,
    localPort: runtime.remote.localPort,
  }
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`).
  // The token is the old `beginLinkWork` one (the rule adopts it), so `isLinkWorkCurrent` keeps
  // the exact late-write semantics.
  const token = (Number(runtime.linkToken) || 0) + 1
  const event = { type: 'stop.requested' as const, token, pid: runtime.remote.pid, port: runtime.remote.port }
  let started: Promise<StopRemoteResult> | null = null
  try {
    await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'script',
      run: (activity, actionToken) => {
        if (activity !== 'stop') return
        started = runStopRemote(ctx, runtime, actionToken)
      },
    })
    return await started
  } catch (error) {
    const view = toErrorView(error)
    const phase = typeof runtime.phase === 'string' ? runtime.phase : previous.phase
    if (isLinkWorkCurrent(runtime, token)) {
      // The rule restores the previous state itself; `unrestorable` is the design's "link went
      // away while the stop was failing" branch, which publishes the coded failure instead.
      const restorable =
        previous.status === 'error' ||
        (runtime.desired === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null)
      const refusal = {
        type: 'stop.refused' as const,
        view,
        phase,
        previous: {
          status: previous.status,
          phase: previous.phase,
          progress: previous.progress,
          error: previous.error,
          uiReady: previous.uiReady === true,
          localPort: previous.localPort ?? null,
        },
        ...(restorable ? {} : { unrestorable: true }),
      }
      await dispatch(createRuntimeEffects(ctx), runtime, refusal, scopeFactsFor(ctx, runtime, refusal), {
        caller: 'script',
      })
    }
    throw error
  } finally {
    endLinkWork(runtime, token)
  }
}

async function runStopRemote(
  ctx: HostState & Config & Transport & RemoteDeps & Reporter,
  runtime: HostRuntime,
  token: number,
): Promise<StopRemoteResult> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const pid = Number(runtime.remote.pid ?? 0)
  const port = Number(runtime.remote.port ?? 0)
  log(
    'info',
    `stop remote requested (pid=${isPid(pid) ? pid : 'unknown'}, remote port=${isPid(port) ? port : 'unknown'})`,
  )
  // `stop.requested` already disarmed the heartbeat/reconnect/idle timers and published the
  // `start`/`stopping-remote` card.

  const verdict = await proveOwnership(ctx, runtime, { ...OWNERSHIP_OPTIONS.stop, pid, layout, profile })
  if (!isLinkWorkCurrent(runtime, token)) {
    log('debug', 'stop remote aborted: the link was replaced by a disconnect or reconnect')
    return { ok: true, pid: null }
  }
  // A pid that is already gone is not a refusal for this action: there is nothing to signal, only
  // a stale registry to clear. Every other refusal is the coded error the card explains.
  const gone = verdict.ok !== true && verdict.reason === 'identity-missing'
  if (verdict.ok !== true && !gone) {
    throw errors.stopRemoteUnavailable(describeStopRefusal(verdict.reason, pid), {
      technical: `reason=${verdict.reason} pid=${isPid(pid) ? pid : 'unknown'}`,
    })
  }

  if (gone) {
    // Nothing to signal: the process is already gone. Only its stale record remains, and it
    // must go away or the next connect would try to stop/adopt a dead pid.
    log('info', `stop remote: the bound remote process pid=${pid} is already gone; clearing its run registry`)
    const cleared = await ctx.deps.clearRegistry(runtime.ssh, layout)
    if (cleared?.ok !== true) {
      log('warn', 'stop remote: the stale run registry could not be cleared:', cleared?.output ?? 'no output')
    }
  } else {
    const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid })
    if (stopped?.ok !== true) {
      throw errors.stopRemoteUnavailable(
        {
          zh: '远端 DSH 进程没有报告干净停止；连接保持原样，可以重试或点「重连」。',
          en: 'The remote DSH process did not report a clean stop; the connection is unchanged, so retry or use Reconnect.',
        },
        { technical: String(stopped?.output ?? '').slice(0, 1200) || 'no output' },
      )
    }
    log('info', `stop remote: stopped the managed remote web pid=${pid}`)
    if (runtime.launched instanceof Map) runtime.launched.delete(pid)
  }
  if (!isLinkWorkCurrent(runtime, token)) {
    log('debug', 'stop remote: the link was replaced after the stop; leaving the state to that action')
    return { ok: true, pid: isPid(pid) ? pid : null }
  }
  runtime.bound = null
  // One transition ends the action: `stop.succeeded` is the explicit stop's disconnect (the
  // `stopped:true` form keeps the idle policy from arming a second stop). The informational line
  // today's `disconnectHost` wrote is part of the operator log, so it stays, in its old position.
  ctx.progress.log(runtime, 'info', `disconnect requested (keepAlive=${runtime.entry.keepAlive})`)
  const done = { type: 'stop.succeeded' as const }
  await dispatch(createRuntimeEffects(ctx), runtime, done, scopeFactsFor(ctx, runtime, done), { caller: 'script' })
  runtime.bound = null
  log('info', 'stop remote: the remote DSH is stopped; the host is kept and can be reconnected')
  return { ok: true, pid: isPid(pid) ? pid : null }
}

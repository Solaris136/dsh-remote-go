/** The listener rebuild for a host whose remote UI answers the SSH probe but whose proxied requests fail: the tunnel, not the remote, is what broke. Single-flight per host and owned by a link-work token; the replacement is created before the old listener closes (no window without a listener) and its new random local port bumps `viewRev` so the carrier refetches. It reads five slices and never the persistence layer, so it takes `WatchdogCtx` rather than `ConnectCtx`. */
import { REMOTE_REPAIR_BACKOFF_MAX_MS, REMOTE_REPAIR_BACKOFF_MS } from '../constants.js'
import type { WatchdogCtx } from '../context.js'
import { errors } from '../errors.js'
import { beginLinkWork, endLinkWork, isLinkWorkCurrent } from '../host-lifecycle.js'
import type { LifecycleVerdict } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import type { Tunnel } from '../tunnel.js'
import { isPid, messageOf } from '../util.js'
import { noteRemoteUnreachable } from '../watchdog.js'

export async function repairTunnel(ctx: WatchdogCtx, runtime: HostRuntime): Promise<LifecycleVerdict> {
  if (
    ctx.state.disposed === true ||
    runtime.desired !== 'connected' ||
    runtime.status !== 'connected' ||
    runtime.linkBusy !== null ||
    runtime.tunnel === null
  ) {
    return { ok: false, reason: 'not-watchable' }
  }
  if (runtime.ssh?.connected !== true) return { ok: false, reason: 'no-transport' }
  if (runtime.tunnelRepair) return runtime.tunnelRepair
  if (Date.now() < (Number(runtime.nextTunnelRepairAt) || 0)) return { ok: false, reason: 'backoff' }
  const port = runtime.remote.port
  const previous = runtime.tunnel
  const token = beginLinkWork(runtime, 'repair')
  const stillCurrent = () =>
    isLinkWorkCurrent(runtime, token) &&
    ctx.state.disposed !== true &&
    runtime.desired === 'connected' &&
    runtime.status === 'connected' &&
    runtime.ssh?.connected === true
  let created: Tunnel | null = null
  const settled: Promise<LifecycleVerdict> = (async () => {
    try {
      if (runtime.ssh?.connected !== true) throw errors.internal(new Error('the SSH transport is gone'))
      if (!isPid(port) || port > 65535) throw errors.internal(new Error(`invalid remote port for the tunnel: ${port}`))
      const next = await ctx.deps.tunnelFactory({
        ssh: runtime.ssh,
        remotePort: port,
        onError: () => noteRemoteUnreachable(ctx, runtime, 'tunnel'),
      })
      created = next
      const nextPort = Number(next?.localPort)
      if (!Number.isInteger(nextPort) || !isPid(nextPort) || nextPort > 65535) {
        throw errors.internal(new Error(`the rebuilt tunnel has no usable local port (${next?.localPort})`))
      }
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      runtime.tunnel = next
      runtime.remote.localPort = nextPort
      try {
        await previous.close()
      } catch {
        // swallow-ok: the old listener could already be gone; the new one is what matters
      }
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1
      ctx.progress.log(
        runtime,
        'info',
        `tunnel rebuilt after a failed request (remote port ${port}, local port ${previous.localPort} -> ${nextPort})`,
      )
      runtime.tunnelRepairFailures = 0
      runtime.nextTunnelRepairAt = 0
      ctx.emitState()
      return { ok: true }
    } catch (error) {
      // swallow-ok: a failed rebuild is a typed, retryable reason (with backoff) for the caller; the
      // old listener is still serving, so this is not a connection failure.
      runtime.tunnelRepairFailures = (Number(runtime.tunnelRepairFailures) || 0) + 1
      const backoff = Math.min(
        REMOTE_REPAIR_BACKOFF_MAX_MS,
        REMOTE_REPAIR_BACKOFF_MS * 2 ** (runtime.tunnelRepairFailures - 1),
      )
      runtime.nextTunnelRepairAt = Date.now() + backoff
      ctx.progress.log(runtime, 'warn', 'tunnel rebuild failed:', messageOf(error))
      return { ok: false, reason: 'rebuild-failed' }
    } finally {
      // A listener this rebuild created must never outlive it: close it on a cancelled token (or if it
      // was never published), and clear the view only when it owned the slot.
      if (created !== null && (!isLinkWorkCurrent(runtime, token) || runtime.tunnel !== created)) {
        if (runtime.tunnel === created) {
          runtime.tunnel = null
          runtime.remote.localPort = null
        }
        try {
          await created.close()
        } catch {
          // swallow-ok: the unpublished listener is discarded; its close cannot fail the repair
        }
      }
      endLinkWork(runtime, token)
    }
  })().finally(() => {
    if (runtime.tunnelRepair === settled) runtime.tunnelRepair = null
  })
  runtime.tunnelRepair = settled
  return settled
}

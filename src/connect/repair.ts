/**
 * The listener rebuild for a host whose remote UI answers the SSH probe but whose proxied
 * requests fail (B8): the tunnel, not the remote, is what broke.
 */
import { REMOTE_REPAIR_BACKOFF_MAX_MS, REMOTE_REPAIR_BACKOFF_MS } from '../constants.js'
import type { ConnectCtx } from '../context.js'
import { errors } from '../errors.js'
import { beginLinkWork, endLinkWork, isLinkWorkCurrent } from '../host-lifecycle.js'
import type { LifecycleVerdict } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import type { Tunnel } from '../tunnel.js'
import { isPid, messageOf } from '../util.js'
import { noteRemoteUnreachable } from '../watchdog.js'

/**
 * Rebuild the local listener for a host whose remote UI answers the SSH probe but whose
 * proxied requests fail: the tunnel, not the remote, is what broke. Single-flight per host and
 * owned by a link-work token, like restart/reattach: a disconnect, host removal or shutdown
 * cancels it and the caller waits for `runtime.tunnelRepair` before tearing down.
 *
 * The replacement is created before the old listener closes, so there is no window without a
 * listener. Its local port is a new random one, so `viewRev` is bumped: the carrier refetches
 * `GET /hosts/:id/open` and navigates again (the desktop guest's URL is the loopback origin).
 * Existing WebSockets/downloads are dropped by closing the old listener - documented.
 *
 * @param ctx - service context.
 * @param runtime - connected host runtime.
 * @returns whether the listener was rebuilt.
 */
export async function repairTunnel(ctx: ConnectCtx, runtime: HostRuntime): Promise<LifecycleVerdict> {
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
  if (Date.now() < (Number(runtime.nextTunnelRepairAt) || 0)) {
    return { ok: false, reason: 'backoff' }
  }
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
  let work: Promise<LifecycleVerdict> | null = null
  let settled: Promise<LifecycleVerdict> | null = null
  work = (async () => {
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
      // Publish the replacement before closing the old listener: no no-listener window.
      runtime.tunnel = next
      runtime.remote.localPort = nextPort
      try {
        await previous.close()
      } catch {
        // swallow-ok: the old listener could already be gone; the new one is what matters
      }
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      // The local port changed, so the carrier's view of the host did too.
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
      // swallow-ok: a failed rebuild is a typed, retryable reason (with backoff) for the caller;
      // the old listener is still serving, so this is not a connection failure.
      runtime.tunnelRepairFailures = (Number(runtime.tunnelRepairFailures) || 0) + 1
      const backoff = Math.min(
        REMOTE_REPAIR_BACKOFF_MAX_MS,
        REMOTE_REPAIR_BACKOFF_MS * 2 ** (runtime.tunnelRepairFailures - 1),
      )
      runtime.nextTunnelRepairAt = Date.now() + backoff
      ctx.progress.log(runtime, 'warn', 'tunnel rebuild failed:', messageOf(error))
      return { ok: false, reason: 'rebuild-failed' }
    } finally {
      // A listener this rebuild created must never outlive it: on a cancelled token (or if it
      // was never published) close it here, and clear the view only when it owned the slot.
      if (created !== null && (!isLinkWorkCurrent(runtime, token) || runtime.tunnel !== created)) {
        if (runtime.tunnel === created) {
          runtime.tunnel = null
          runtime.remote.localPort = null
        }
        try {
          await created.close()
        } catch {}
      }
      endLinkWork(runtime, token)
    }
  })()
  settled = work.finally(() => {
    if (runtime.tunnelRepair === settled) runtime.tunnelRepair = null
  })
  runtime.tunnelRepair = settled
  return settled
}

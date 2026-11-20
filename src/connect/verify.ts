/** The `[verifying]` step: the remote UI answers through the new listener and the launch token exchanges for the cookie the carrier needs; both halves are guarded across their awaits. */
import { TUNNEL_PROBE_TIMEOUT_MS } from '../constants.js'
import type { HostState, RemoteDeps, Reporter } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import type { ExchangeResult } from '../remote-proc.js'
import { isPid } from '../util.js'
import { assertStillWanted, assertTransportOpen } from './guards.js'

export async function verifyRemoteUi(
  ctx: HostState & RemoteDeps & Reporter,
  runtime: HostRuntime,
  port: number,
  token: string,
  localPort: number,
): Promise<ExchangeResult> {
  const tunnelPort = Number(localPort)
  if (!Number.isInteger(tunnelPort) || !isPid(tunnelPort) || tunnelPort > 65535)
    throw errors.internal(new Error(`the tunnel has no local port to verify (${localPort ?? 'none'})`))
  ctx.progress.log(runtime, 'debug', `verifying the remote UI on 127.0.0.1:${tunnelPort}`)
  const ui = await ctx.deps.waitUi(runtime.ssh, port, { attempts: 20, intervalMs: 500 })
  assertStillWanted(ctx, runtime)
  assertTransportOpen(runtime)
  if (!ui.ok) {
    throw errors.remoteUiUnreachable({
      zh: `远端 DSH 的本地 127.0.0.1:${port} 没有响应（HTTP ${ui.status ?? '无'}）。`,
      en: `The remote DSH on 127.0.0.1:${port} did not respond (HTTP ${ui.status ?? 'none'}).`,
    })
  }
  ctx.progress.log(runtime, 'debug', `remote UI answered HTTP ${ui.status}; exchanging the launch token`)
  const exchange = await ctx.deps.exchange(tunnelPort, token, { timeoutMs: TUNNEL_PROBE_TIMEOUT_MS })
  runtime.exchange = exchange
  if (!exchange.ok) {
    throw errors.remoteUiUnreachable({
      zh: `本地隧道完成了 token 交换，但远端界面返回 HTTP ${exchange.status}（首次状态 ${exchange.firstStatus}）。`,
      en: `The tunnel exchanged the token but the remote UI answered HTTP ${exchange.status} (first ${exchange.firstStatus}).`,
    })
  }
  return exchange
}

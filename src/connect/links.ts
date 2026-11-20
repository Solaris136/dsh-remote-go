/** The two connect entries: a user connect (which owns the one-time inputs, the retry budget and the log boundary) and the "Reconnect" button's drop-and-redial. */
import { beginConnectLog } from '../connect-log.js'
import type { ConnectCtx } from '../context.js'
import { runtimeOf } from '../host-registry.js'
import { cancelIdleStop, disconnectHost, disposeSsh } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { isRefusal } from '../runtime/fsm.js'
import { startConnectPromise } from './pipeline.js'

export type StartConnectOptions = { password?: string; rememberPassword?: boolean }

export type AcceptedResult = { accepted: boolean; reason?: string }

/** Accept a connect request: apply the one-time inputs, stop any pending retry, and start the pipeline in the background. */
export async function startConnect(
  ctx: ConnectCtx,
  id: string,
  options: StartConnectOptions = {},
): Promise<AcceptedResult> {
  await ctx.init()
  const runtime = runtimeOf(ctx, id)
  if (runtime.connectPromise) return { accepted: false, reason: 'already-connecting' }
  if (runtime.linkBusy !== null) return { accepted: false, reason: 'already-restarting' }
  if (runtime.status === 'connected' && runtime.ssh?.connected) return { accepted: false, reason: 'already-connected' }
  runtime.alongsidePids = []
  const typedPassword = typeof options.password === 'string' && options.password !== '' ? options.password : null
  if (typedPassword !== null) runtime.password = typedPassword
  // Remembering is the default for a typed password; an explicit false means "this connection only" and
  // also forgets a previously saved record, while a retry carries no password and re-saves nothing.
  runtime.savePassword = typedPassword !== null && options.rememberPassword !== false
  runtime.forgetPassword = typedPassword !== null && options.rememberPassword === false
  // This connection starts its own log, so the panel and a copied log only ever show the live attempt.
  beginConnectLog(runtime)
  const { entry } = runtime
  const user = entry.username ? `${entry.username}@` : ''
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  ctx.progress.log(
    runtime,
    'info',
    `connect: ${user}${entry.address || '?'}${port} (auth=${entry.auth?.type ?? 'key'}${
      entry.jumpHost ? `, jump=${entry.jumpHost}` : ''
    })`,
  )
  const token = (Number(runtime.linkToken) || 0) + 1
  const event = { type: 'connect.requested' as const, token }
  const result = await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    run: () => startConnectPromise(ctx, runtime),
  })
  if (isRefusal(result)) {
    // The guards above are the API-visible ones; the machine refusing here means the two disagreed.
    ctx.progress.log(runtime, 'warn', `connect refused: ${result.reason}`)
    return { accepted: false, reason: result.reason === 'already-connecting' ? 'already-connecting' : 'busy' }
  }
  return { accepted: true }
}

/** Drop the current link and connect again from scratch (the "Reconnect" button). */
export async function reconnectHost(ctx: ConnectCtx, runtime: HostRuntime): Promise<AcceptedResult> {
  await disconnectHost(ctx, runtime, { stopRemote: false })
  cancelIdleStop(runtime)
  await disposeSsh(runtime)
  // A one-shot action cancelled by the disconnect resolves after its transport is gone; letting it
  // settle keeps the old code out of the new run.
  await Promise.allSettled(
    [runtime.restartPromise, runtime.reattachPromise].filter(
      (promise) => promise && typeof promise.then === 'function',
    ),
  )
  return startConnect(ctx, runtime.id, {})
}

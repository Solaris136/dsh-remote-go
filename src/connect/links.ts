/**
 * The two connect entries: a user connect (which owns the one-time inputs, the retry budget and
 * the log boundary) and the "Reconnect" button's drop-and-redial.
 */
import { beginConnectLog } from '../connect-log.js'
import type { ConnectCtx } from '../context.js'
import { runtimeOf } from '../host-registry.js'
import { cancelIdleStop, disconnectHost, disposeSsh } from '../host-lifecycle.js'
import type { HostRuntime } from '../host-runtime.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import { isRefusal } from '../runtime/fsm.js'
import type { HostEntry } from '../settings.js'
import { startConnectPromise } from './pipeline.js'

/** The knobs of one connect request, as the API hands them over. */
export interface StartConnectOptions {
  /** A password the user typed for this attempt alone; it is only stored when allowed. */
  password?: string
  rememberPassword?: boolean
}

/** The verdict the one-shot link actions report before they start running. */
export interface AcceptedResult {
  accepted: boolean
  reason?: string
}

function describeTarget(entry: HostEntry): string {
  const user = entry.username ? `${entry.username}@` : ''
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  return `${user}${entry.address || '?'}${port}`
}

/**
 * Accept a connect request: apply the one-time inputs, stop any pending retry,
 * and start the pipeline in the background. Progress travels on `state`.
 */
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
  // Remembering is the default for a password the user just typed (`POST /hosts/:id/connect`
  // treats an absent `rememberPassword` as true). An explicit false means "this connection
  // only" and also forgets a previously saved record, so an unchecked box cannot leave a stale
  // secret behind. A retry or auto-reconnect carries no password of its own and must not
  // re-save what the store already holds.
  runtime.savePassword = typedPassword !== null && options.rememberPassword !== false
  runtime.forgetPassword = typedPassword !== null && options.rememberPassword === false
  // This connection starts its own log: the previous attempt's lines are gone before the
  // first line of this one, so the panel and a copied log only ever show the live attempt.
  // The line keeps the previous attempt's `phase`, exactly as it did before the FSM owned it.
  beginConnectLog(runtime)
  ctx.progress.log(
    runtime,
    'info',
    `connect: ${describeTarget(runtime.entry)} (auth=${runtime.entry.auth?.type ?? 'key'}${
      runtime.entry.jumpHost ? `, jump=${runtime.entry.jumpHost}` : ''
    })`,
  )
  // One transition owns the whole entry: the retry budget and prompt history reset (a *user*
  // connect), the timer disarms, the desired flag and the pipeline start (`run`). The token
  // invalidates any older one-shot action, the same way the old `cancelLinkWork` did.
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
  // A one-shot action cancelled by the disconnect resolves after its transport is gone; it
  // can no longer write state, but letting it settle keeps the old code out of the new run.
  await Promise.allSettled(
    [runtime.restartPromise, runtime.reattachPromise].filter(
      (promise) => promise && typeof promise.then === 'function',
    ),
  )
  return startConnect(ctx, runtime.id, {})
}

/** Cross-await guards of the connect workflow (one implementation each): after every await the link must still be wanted and the transport must still be open, so a late write can never resurrect a link the user let go; `linkActionState` is the one test of the states a one-shot action may start from. The two writer aliases at the bottom describe a connect-progress line bound to one runtime, and live here because every module that binds one already imports this leaf. */
import type { ProgressParams } from '../connect-progress.js'
import type { HostState } from '../context.js'
import { errors } from '../errors.js'
import type { ConnectPhase, HostRuntime } from '../host-runtime.js'
import { SSH_CLOSED_DETAIL } from './failures.js'

/** Internal marker: a pipeline step ran after the user (or the host process) took the link away; it is not a connection failure, so it never reaches the Client as an error. */
export class LinkCancelled extends Error {
  declare code: string
  constructor(reason: string) {
    super(`connect aborted: ${reason}`)
    this.name = 'LinkCancelled'
    this.code = 'link-cancelled'
  }
}

export function linkTaken(ctx: HostState, runtime: HostRuntime): boolean {
  return (
    ctx.state.disposed === true ||
    runtime.closing === true ||
    runtime.desired !== 'connected' ||
    !ctx.state.runtimes.has(runtime.id)
  )
}

/** Throw unless this attempt may still write state. */
export function assertStillWanted(ctx: HostState, runtime: HostRuntime): void {
  if (linkTaken(ctx, runtime)) throw new LinkCancelled('the link is no longer wanted')
}

/** Throw a typed transport error unless the SSH transport is still open. */
export function assertTransportOpen(runtime: HostRuntime): void {
  if (runtime.ssh?.connected !== true) throw errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed' })
}

/** The state a one-shot link action may start from: a live link, or the `remote-unreachable` error state that keeps the SSH transport on purpose (so restart and stop also work from it). `null` means the action is not available; the caller names its own refusal. */
export function linkActionState(runtime: HostRuntime): 'connected' | 'recoverable' | null {
  const sshUp = runtime.ssh?.connected === true
  if (runtime.status === 'connected' && sshUp && runtime.tunnel !== null) return 'connected'
  if (runtime.status === 'error' && runtime.error?.code === 'remote-unreachable' && sshUp && runtime.facts !== null) {
    return 'recoverable'
  }
  return null
}

export type ConnectLogWriter = (level: string, ...args: unknown[]) => void

export type PhaseWriter = (name: ConnectPhase, code: string, params?: ProgressParams) => void

/**
 * Cross-await guards of the connect workflow (design-arch §3.3, one implementation each): after
 * every await the link must still be wanted (H4) and the transport must still be open (H3), so a
 * late write can never resurrect a link the user let go.
 *
 * The two writer aliases at the bottom describe a connect-progress line bound to one runtime. They
 * live here because every module that binds one already imports this leaf; §3.1 gives the package
 * no type module, and copying them per file would break §3.3's "no shared helper twice".
 */
import type { ProgressParams } from '../connect-progress.js'
import type { HostState } from '../context.js'
import { errors } from '../errors.js'
import type { ConnectPhase, HostRuntime } from '../host-runtime.js'
import { SSH_CLOSED_DETAIL } from './failures.js'

/**
 * Internal marker: a pipeline step ran after the user (or the host process) took the link
 * away. It is not a connection failure, so it never reaches the Client as an error.
 */
export class LinkCancelled extends Error {
  declare code: string

  constructor(reason: string) {
    super(`connect aborted: ${reason}`)
    this.name = 'LinkCancelled'
    this.code = 'link-cancelled'
  }
}

/** Whether the link is no longer wanted: disconnect, host removal, teardown or shutdown. */
export function linkTaken(ctx: HostState, runtime: HostRuntime): boolean {
  return (
    ctx.state.disposed === true ||
    runtime.closing === true ||
    runtime.desired !== 'connected' ||
    !ctx.state.runtimes.has(runtime.id)
  )
}

/** Throw unless this attempt may still write state (H4). */
export function assertStillWanted(ctx: HostState, runtime: HostRuntime): void {
  if (linkTaken(ctx, runtime)) throw new LinkCancelled('the link is no longer wanted')
}

/** Throw a typed transport error unless the SSH transport is still open (H3). */
export function assertTransportOpen(runtime: HostRuntime): void {
  if (runtime.ssh?.connected !== true) {
    throw errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed' })
  }
}

/** One connect-log line: the level plus the values `connect-progress` stringifies. */
export type ConnectLogWriter = (level: string, ...args: unknown[]) => void

/** One progress-line update: the stage name, the code and its interpolation values. */
export type PhaseWriter = (name: ConnectPhase, code: string, params?: ProgressParams) => void

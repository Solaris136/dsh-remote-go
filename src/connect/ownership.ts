/**
 * Who this connection may stop: the two records it keeps (a pid its own start script launched, a
 * pid it is merely bound to) and the `/proc` identity proofs that re-authorize them before any
 * signal. A reused pid, an adopted-only pid or a process kept alongside is never stopped silently.
 *
 * The two surfaces stay separate functions on purpose: merging them into `proveOwnership` is
 * design-arch §4 / P2 step 8 (P2e), not this stage's scope.
 */
import type { RemoteDeps, Reporter, Transport } from '../context.js'
import type { BoundProcess, HostRuntime, LaunchedProcess } from '../host-runtime.js'
import type { LifecycleVerdict } from '../host-lifecycle.js'
import type { RemoteLayout } from '../layout.js'
import { commandMatchesProfile } from '../remote-web.js'
import { isPid } from '../util.js'
import { readRegistryQuietly } from './registry.js'

/**
 * Record a pid this connection is allowed to stop later: it must have been launched by the
 * plugin's own start script (or adopted from a `launch` registry record) and its `/proc`
 * identity must show this DSH home and profile. Anything that fails this check is still
 * hosted and displayed, but never signalled.
 */
export async function rememberLaunched(
  ctx: Transport & Reporter,
  runtime: HostRuntime,
  pid: number,
  layout: RemoteLayout,
  profile: string,
): Promise<LaunchedProcess | null> {
  if (!isPid(pid)) return null
  if (!(runtime.launched instanceof Map)) runtime.launched = new Map<number, LaunchedProcess>()
  const identity = await ctx.deps.processIdentity(runtime.ssh, pid)
  if (identity.ok !== true) {
    ctx.progress.log(
      runtime,
      'debug',
      `launch: pid ${pid} identity unreadable (${identity.reason}); it will not be stopped`,
    )
    return null
  }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
    ctx.progress.log(runtime, 'debug', `launch: pid ${pid} runs with another DSH_HOME; it will not be stopped`)
    return null
  }
  if (!commandMatchesProfile(identity.command, profile)) {
    ctx.progress.log(runtime, 'debug', `launch: pid ${pid} does not run profile ${profile}; it will not be stopped`)
    return null
  }
  const record = {
    startTime: identity.startTime,
    command: identity.command,
    dshHome: identity.dshHome,
  }
  runtime.launched.set(pid, record)
  runtime.bound = { pid, startTime: identity.startTime, origin: 'launch' }
  return record
}

/**
 * Remember the remote web this connection is bound to without granting restart kill rights.
 * A re-attach (or the adoption of a re-attached record) names a process this plugin did not
 * launch: a restart must leave it running, but the user's explicit "Stop remote DSH" may stop
 * exactly this pid. The identity recorded here is what that action re-proves before signalling.
 * @param ctx - service context.
 * @param runtime - host runtime with a live transport.
 * @param pid - the bound remote web pid.
 * @param layout - remote layout.
 * @param profile - remote DSH profile.
 * @param origin - how this connection came to host the process.
 * @returns the recorded binding, or null when it cannot be proven.
 */
export async function rememberBound(
  ctx: Transport & Reporter,
  runtime: HostRuntime,
  pid: number,
  layout: RemoteLayout,
  profile: string,
  origin: 'launch' | 'reattach',
): Promise<BoundProcess | null> {
  if (!isPid(pid)) return null
  const identity = await ctx.deps.processIdentity(runtime.ssh, pid)
  if (identity.ok !== true) {
    ctx.progress.log(
      runtime,
      'debug',
      `bind: pid ${pid} identity unreadable (${identity.reason}); it will not be stopped on request`,
    )
    return null
  }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
    ctx.progress.log(runtime, 'debug', `bind: pid ${pid} runs with another DSH_HOME; it cannot be stopped here`)
    return null
  }
  if (!commandMatchesProfile(identity.command, profile)) {
    ctx.progress.log(runtime, 'debug', `bind: pid ${pid} does not run profile ${profile}; it cannot be stopped here`)
    return null
  }
  runtime.bound = { pid, startTime: identity.startTime, origin }
  return runtime.bound
}

/**
 * The only gate that authorizes a kill. All three must hold: the registry names the pid,
 * this connection launched it, and `/proc` still proves the same process (kernel start time)
 * with the same home and profile. A reused pid, an adopted-only pid, or a process kept
 * alongside therefore never gets stopped silently.
 */
export async function killAuthorized(
  ctx: Transport,
  runtime: HostRuntime,
  pid: number,
  layout: RemoteLayout,
  profile: string,
): Promise<LifecycleVerdict> {
  const record = runtime.launched instanceof Map ? runtime.launched.get(pid) : undefined
  if (!record) return { ok: false, reason: 'not-launched-by-this-connection' }
  if ((Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : []).includes(pid)) {
    return { ok: false, reason: 'kept-alongside' }
  }
  const identity = await ctx.deps.processIdentity(runtime.ssh, pid)
  if (identity.ok !== true) return { ok: false, reason: `identity-${identity.reason}` }
  if (identity.startTime !== record.startTime) return { ok: false, reason: 'pid-reused' }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
    return { ok: false, reason: 'dsh-home-mismatch' }
  }
  if (!commandMatchesProfile(identity.command, profile)) return { ok: false, reason: 'profile-mismatch' }
  return { ok: true }
}

/**
 * The explicit "stop remote DSH" authorization. A restart must never stop a process this
 * plugin did not launch; here the user is pointing at the instance this connection is bound
 * to, so a re-attached pid is stoppable too - with the same `/proc` proofs, re-read now:
 *
 * - the pid must be the one this connection is bound to (`remote.pid`);
 * - it must stay out of `alongsidePids` (the user asked to keep it);
 * - this connection must have recorded it: launched it, or bound to it after a re-attach;
 * - `run/web.json` must still name that pid with the same DSH home and profile;
 * - `/proc/<pid>` must still be the same process (kernel start time), same home, same profile.
 *
 * A pid that is already gone is not an error for this action: the caller clears the stale
 * registry and releases the link, which is exactly what "stop" means in that state.
 *
 * @param ctx - service context.
 * @param runtime - connected (or remote-unreachable) host runtime.
 * @param pid - the bound remote web pid.
 * @param layout - remote layout.
 * @param profile - remote DSH profile.
 * @returns the verdict.
 */
export async function closeAuthorized(
  ctx: Transport & RemoteDeps & Reporter,
  runtime: HostRuntime,
  pid: number,
  layout: RemoteLayout,
  profile: string,
): Promise<LifecycleVerdict> {
  if (!isPid(pid)) return { ok: false, reason: 'pid-unknown' }
  if (Number(runtime.remote.pid) !== pid) return { ok: false, reason: 'not-the-bound-instance' }
  if ((Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : []).includes(pid)) {
    return { ok: false, reason: 'kept-alongside' }
  }
  const launched = runtime.launched instanceof Map ? runtime.launched.get(pid) : undefined
  const bound = runtime.bound !== null && Number(runtime.bound?.pid) === pid ? runtime.bound : null
  const proof = launched ?? bound
  if (!proof) return { ok: false, reason: 'not-launched-by-this-connection' }
  const registry = await readRegistryQuietly(ctx, runtime, layout)
  const registered =
    registry !== null &&
    registry.dshHome === layout.dshHome &&
    registry.profile === profile &&
    Number(registry.pid) === pid
  if (!registered) return { ok: false, reason: 'registry-mismatch' }
  const identity = await ctx.deps.processIdentity(runtime.ssh, pid)
  if (identity.ok !== true) {
    // The process is gone: there is nothing to signal, only a stale registry to clear.
    if (identity.reason === 'missing') return { ok: false, reason: 'identity-missing' }
    return { ok: false, reason: `identity-${identity.reason}` }
  }
  if (typeof proof.startTime === 'string' && identity.startTime !== proof.startTime) {
    return { ok: false, reason: 'pid-reused' }
  }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
    return { ok: false, reason: 'dsh-home-mismatch' }
  }
  if (!commandMatchesProfile(identity.command, profile)) return { ok: false, reason: 'profile-mismatch' }
  return { ok: true }
}

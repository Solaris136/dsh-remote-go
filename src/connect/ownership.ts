/** Who this connection may stop: the two records it keeps (a pid its own start script launched, a pid it is merely bound to) and the `/proc` identity proofs that re-authorize them before any signal. A reused pid, an adopted-only pid or a process kept alongside is never stopped silently; every difference between the three call sites is a parameter of the single `proveOwnership` decision. */
import type { RemoteDeps, Reporter, Transport } from '../context.js'
import type { BoundProcess, HostRuntime, LaunchedProcess } from '../host-runtime.js'
import type { RemoteLayout } from '../layout.js'
import type { ProcessIdentity } from '../remote-proc.js'
import { registryNamesInstance, type RunRegistryRecord } from '../remote-web/registry.js'
import { commandMatchesProfile } from '../remote-web/resolve.js'
import { isPid } from '../util.js'
import { readRegistryQuietly } from './registry.js'

function deny(
  ctx: Transport & Reporter,
  runtime: HostRuntime,
  tag: string,
  pid: number,
  detail: string,
  tail: string,
): null {
  ctx.progress.log(runtime, 'debug', `${tag}: pid ${pid} ${detail}; ${tail}`)
  return null
}

/** Record a pid this connection may stop later: it must come from its own start script (or a `launch` registry record) and its `/proc` identity must show this DSH home and profile. Anything else is still displayed but never signalled. */
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
  if (identity.ok !== true)
    return deny(ctx, runtime, 'launch', pid, `identity unreadable (${identity.reason})`, 'it will not be stopped')
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome)
    return deny(ctx, runtime, 'launch', pid, 'runs with another DSH_HOME', 'it will not be stopped')
  if (!commandMatchesProfile(identity.command, profile))
    return deny(ctx, runtime, 'launch', pid, `does not run profile ${profile}`, 'it will not be stopped')
  const record = { startTime: identity.startTime, command: identity.command, dshHome: identity.dshHome }
  runtime.launched.set(pid, record)
  runtime.bound = { pid, startTime: identity.startTime, origin: 'launch' }
  return record
}

/** Remember a remote web this connection is bound to without granting restart kill rights: a restart must leave a re-attached process running, but the explicit "Stop remote DSH" may stop exactly this pid. */
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
  if (identity.ok !== true)
    return deny(
      ctx,
      runtime,
      'bind',
      pid,
      `identity unreadable (${identity.reason})`,
      'it will not be stopped on request',
    )
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome)
    return deny(ctx, runtime, 'bind', pid, 'runs with another DSH_HOME', 'it cannot be stopped here')
  if (!commandMatchesProfile(identity.command, profile))
    return deny(ctx, runtime, 'bind', pid, `does not run profile ${profile}`, 'it cannot be stopped here')
  runtime.bound = { pid, startTime: identity.startTime, origin }
  return runtime.bound
}

export type OwnershipSource = 'launched' | 'bound'
/** Every reason the gate may refuse with. The literals are frozen: they are the `technical: reason=<code>` payload of the stop error, the `(reason)` tail of the restart log line and the `reason` of the idle policy's verdict, so a new one must be added here rather than invented at a call site. */
export type OwnershipReason =
  | 'pid-unknown'
  | 'not-the-bound-instance'
  | 'kept-alongside'
  | 'not-launched-by-this-connection' // the restart/stop shape's "no record", keeping each caller's wording
  | 'not-owned' // the idle shape's "no record"
  | 'registry-mismatch'
  | 'identity-missing'
  | 'identity-unreadable'
  | `identity-${string}`
  | 'pid-reused'
  | 'dsh-home-mismatch'
  | 'profile-mismatch'

/** What the gate looked at, so a caller can log why it decided. */
export interface OwnershipEvidence {
  pid: number
  source: OwnershipSource | null
  recordedStartTime: string | null
  identity: ProcessIdentity | null
  registry: RunRegistryRecord | null
  layout: RemoteLayout
  profile: string
}

export type OwnershipVerdict =
  { ok: true; evidence: OwnershipEvidence } | { ok: false; reason: OwnershipReason; evidence: OwnershipEvidence }

/** The options of one authorization shape. `profile: ''` skips the profile comparison instead of refusing (the idle shape may have forgotten it in a teardown); `proofBeforeAlongside` keeps the restart shape's historic record-first refusal reason; `startTime: 'strict'` refuses a record without a start time while `'when-recorded'` compares only when it has one. */
export interface ProveOwnershipOptions {
  pid: number
  layout: RemoteLayout
  profile: string
  sources?: readonly OwnershipSource[]
  requireProfile?: boolean
  requireBoundPid?: boolean
  forbidAlongside?: boolean
  proofBeforeAlongside?: boolean
  requireRegistry?: boolean
  startTime?: 'strict' | 'when-recorded'
  noProofReason?: 'not-launched-by-this-connection' | 'not-owned'
  prefer?: 'launched-first' | 'bound-first'
}

export type OwnershipShape = Omit<ProveOwnershipOptions, 'pid' | 'layout' | 'profile'>

/** The three call sites' option sets, kept here as a table instead of three copies of the same nine checks. `restart` is an implicit kill: only what this connection launched, proven before `alongsidePids`, with a strict start time and a mandatory profile (its registry mismatch is the caller's conflict prompt, not a refusal). `stop` is the user pointing at the instance this connection is bound to: that exact pid, and only while `run/web.json` still names it with the same home and profile. `idle` has only a timer: no registry, but a record of its own, bound-first order, and an empty profile that skips the comparison. */
export const OWNERSHIP_OPTIONS = {
  restart: {
    sources: ['launched'],
    startTime: 'strict',
    noProofReason: 'not-launched-by-this-connection',
    proofBeforeAlongside: true,
    requireProfile: true,
  },
  stop: {
    sources: ['launched', 'bound'],
    requireBoundPid: true,
    requireRegistry: true,
    startTime: 'when-recorded',
    prefer: 'launched-first',
    noProofReason: 'not-launched-by-this-connection',
    requireProfile: true,
  },
  idle: {
    sources: ['launched', 'bound'],
    startTime: 'when-recorded',
    prefer: 'bound-first',
    noProofReason: 'not-owned',
  },
} as const satisfies Record<'restart' | 'stop' | 'idle', OwnershipShape>

/** Prove that this connection may signal `pid`, and say why not when it may not. The judgment order is part of the contract, and every step is a refusal that never signals anything: pid, profile, bound pid, alongside, record, alongside again, registry, `/proc` identity, start time, DSH home, profile. */
export async function proveOwnership(
  ctx: Transport & RemoteDeps & Reporter,
  runtime: HostRuntime,
  options: ProveOwnershipOptions,
): Promise<OwnershipVerdict> {
  const { pid, layout, profile } = options
  const sources = options.sources ?? ['launched']
  const prefer = options.prefer ?? 'launched-first'
  const startTimeMode = options.startTime ?? 'when-recorded'
  const noProofReason: OwnershipReason = options.noProofReason ?? 'not-launched-by-this-connection'
  const forbidAlongside = options.forbidAlongside !== false
  const alongside = Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : []
  const launched =
    sources.includes('launched') && runtime.launched instanceof Map ? runtime.launched.get(pid) : undefined
  const bound =
    sources.includes('bound') && runtime.bound != null && Number(runtime.bound.pid) === pid ? runtime.bound : null
  const launchedProof = launched ?? null
  const proof = prefer === 'bound-first' ? (bound ?? launchedProof) : (launchedProof ?? bound)
  const source: OwnershipSource | null = proof === null ? null : proof === launchedProof ? 'launched' : 'bound'
  const evidence: OwnershipEvidence = {
    pid,
    source,
    recordedStartTime: typeof proof?.startTime === 'string' ? proof.startTime : null,
    identity: null,
    registry: null,
    layout,
    profile,
  }
  const refuse = (reason: OwnershipReason): OwnershipVerdict => ({ ok: false, reason, evidence })
  if (!isPid(pid)) return refuse('pid-unknown')
  // Only the shapes that always know their profile enforce this; the idle timer may have lost it in
  // a teardown, which must stay "unknown" rather than become a refusal.
  if (options.requireProfile === true && profile === '') return refuse('profile-mismatch')
  if (options.requireBoundPid === true && Number(runtime.remote.pid) !== pid) return refuse('not-the-bound-instance')
  const keptAlongside = forbidAlongside && alongside.includes(pid)
  if (keptAlongside && options.proofBeforeAlongside !== true) return refuse('kept-alongside')
  if (proof === null) return refuse(noProofReason)
  if (keptAlongside) return refuse('kept-alongside')
  if (options.requireRegistry === true) {
    const registry = await readRegistryQuietly(ctx, runtime, layout)
    evidence.registry = registry
    if (!registryNamesInstance(registry, layout, profile, pid)) return refuse('registry-mismatch')
  }
  let identity: ProcessIdentity
  try {
    identity = await ctx.deps.processIdentity(runtime.ssh, pid)
  } catch {
    // swallow-ok: an identity read that throws cannot prove ownership either, so nothing is signalled
    return refuse('identity-unreadable')
  }
  evidence.identity = identity
  if (identity.ok !== true) {
    // "The process is gone" and "the process could not be read" are different refusals: the explicit
    // stop clears a stale registry only for the first one.
    return refuse(identity.reason === 'missing' ? 'identity-missing' : `identity-${identity.reason}`)
  }
  const recorded = typeof proof.startTime === 'string' ? proof.startTime : null
  if (startTimeMode === 'strict') {
    // A `launched` record always carries the start time; one without it is a broken record, so it refuses.
    if (identity.startTime !== recorded) return refuse('pid-reused')
  } else if (recorded !== null && identity.startTime !== recorded) {
    return refuse('pid-reused')
  }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) return refuse('dsh-home-mismatch')
  if (profile !== '' && !commandMatchesProfile(identity.command, profile)) return refuse('profile-mismatch')
  return { ok: true, evidence }
}

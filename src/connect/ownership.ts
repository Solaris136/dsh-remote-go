/**
 * Who this connection may stop: the two records it keeps (a pid its own start script launched, a
 * pid it is merely bound to) and the `/proc` identity proofs that re-authorize them before any
 * signal. A reused pid, an adopted-only pid or a process kept alongside is never stopped silently.
 *
 * There is exactly one decision here — `proveOwnership` — and three authorization shapes on top of
 * it (`OWNERSHIP_OPTIONS`): the restart's narrow "only what I launched", the explicit stop's
 * "the instance I am bound to, if the run registry still names it", and the idle timer's
 * "whatever this connection still has a record for, nobody pointed at it". Every difference is a
 * parameter; no caller re-implements the checks (design-arch §4, review item 4).
 */
import type { RemoteDeps, Reporter, Transport } from '../context.js'
import type { BoundProcess, HostRuntime, LaunchedProcess } from '../host-runtime.js'
import type { RemoteLayout } from '../layout.js'
import type { ProcessIdentity } from '../remote-proc.js'
import { commandMatchesProfile } from '../remote-web.js'
import type { RunRegistryRecord } from '../remote-web.js'
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

/* ── proveOwnership: the single authorization gate (design-arch §4) ───────────────────────── */

/** Which of the two records authorized (or failed to authorize) a pid. */
export type OwnershipSource = 'launched' | 'bound'

/**
 * Every reason the gate may refuse with. The literals are frozen (DECISIONS H5): they are the
 * `technical: reason=<code> pid=<n>` payload of the stop error, the `(reason)` tail of the
 * restart log line and the `reason` of the idle policy's verdict.
 *
 * `identity-${string}` carries any other `/proc` read failure verbatim, exactly like the three
 * implementations this replaced did.
 */
export type OwnershipReason =
  | 'pid-unknown'
  | 'not-the-bound-instance'
  | 'kept-alongside'
  /** The restart/stop shape's "no record": keeps each caller's historic wording. */
  | 'not-launched-by-this-connection'
  /** The idle shape's "no record". */
  | 'not-owned'
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
  /** The record that matched, or null when none did. */
  source: OwnershipSource | null
  /** The start time that record remembered, or null when there was no record. */
  recordedStartTime: string | null
  /** The `/proc` identity that was read (null when the gate refused before reading it). */
  identity: ProcessIdentity | null
  /** The run registry record, read only when `requireRegistry` asked for it. */
  registry: RunRegistryRecord | null
  layout: RemoteLayout
  profile: string
}

export type OwnershipVerdict =
  { ok: true; evidence: OwnershipEvidence } | { ok: false; reason: OwnershipReason; evidence: OwnershipEvidence }

/** The options of one authorization shape; everything except the two caller-specific strings. */
export interface ProveOwnershipOptions {
  /** The pid to prove. */
  pid: number
  /** The remote layout the identity must match (`dshHome`). */
  layout: RemoteLayout
  /**
   * The profile the command line must carry. An empty string means "this caller has no profile to
   * compare" (the idle policy after a teardown that forgot it): the check is then skipped.
   */
  profile: string
  /** Which records may authorize the pid; default `['launched']` (the restart shape). */
  sources?: readonly OwnershipSource[]
  /** The pid must be the instance this connection is bound to (`remote.pid`); default false. */
  requireBoundPid?: boolean
  /**
   * Refuse a pid the user asked to keep alongside; default true. The idle policy never targets
   * such a pid, so the check is a no-op there — it is passed for every caller so a future one
   * cannot be looser by omission.
   */
  forbidAlongside?: boolean
  /** `run/web.json` must name this pid with the same home and profile; default false. */
  requireRegistry?: boolean
  /**
   * `strict`: the record's start time must equal the live one (a record without one is a
   * contradiction, so the pid is not signalled); `when-recorded`: compare when it carries one.
   */
  startTime?: 'strict' | 'when-recorded'
  /** The reason for "no record authorizes this pid"; keeps each caller's frozen wording. */
  noProofReason?: 'not-launched-by-this-connection' | 'not-owned'
  /** Which record wins when both could authorize the pid; default `'launched-first'`. */
  prefer?: 'launched-first' | 'bound-first'
}

/** One authorization shape: the options minus the two caller-specific strings. */
export type OwnershipShape = Omit<ProveOwnershipOptions, 'pid' | 'layout' | 'profile'>

/**
 * The three call sites' option sets (design-arch §4.3). They live here so the differences are a
 * table the tests can read instead of three copies of the same nine checks:
 *
 * - `restart` is an *implicit* kill: only a process this connection launched may be stopped. The
 *   registry check belongs to the caller, because a registry mismatch is a conflict prompt, not a
 *   refusal (design.md §5.5). `strict` because a `launched` record always carries the `/proc`
 *   start time; one without it is a broken record, and an unprovable pid must not be stopped.
 * - `stop` is the user pointing at the instance this connection is bound to: it may stop a
 *   re-attached pid (design.md §5.7), but only that exact pid, and only while `run/web.json` still
 *   names it with the same home and profile — the written evidence of "the instance this
 *   connection manages".
 * - `idle` has nobody pointing at anything, only a timer: no registry (it may be stale by then),
 *   but it needs a record of its own; `bound-first` preserves the order the timer always used.
 *
 * `noProofReason` and `prefer` exist only to keep the existing wording and order (DECISIONS H5);
 * a fourth call site must be registered here with its reason.
 */
export const OWNERSHIP_OPTIONS = {
  restart: {
    sources: ['launched'],
    startTime: 'strict',
    noProofReason: 'not-launched-by-this-connection',
  },
  stop: {
    sources: ['launched', 'bound'],
    requireBoundPid: true,
    requireRegistry: true,
    startTime: 'when-recorded',
    prefer: 'launched-first',
    noProofReason: 'not-launched-by-this-connection',
  },
  idle: {
    sources: ['launched', 'bound'],
    startTime: 'when-recorded',
    prefer: 'bound-first',
    noProofReason: 'not-owned',
  },
} as const satisfies Record<'restart' | 'stop' | 'idle', OwnershipShape>

/**
 * Prove that this connection may signal `pid`, and say why not when it may not.
 *
 * The judgment order is itself part of the contract (§4.2), and every step is a refusal that
 * never signals anything:
 *
 * ```
 * 1 pid is a pid                                                   → pid-unknown
 * 2 requireBoundPid && remote.pid !== pid                           → not-the-bound-instance
 * 3 forbidAlongside && alongsidePids includes pid                   → kept-alongside
 * 4 no record of the allowed sources                                → noProofReason
 * 5 requireRegistry && the registry does not name it               → registry-mismatch
 * 6 /proc identity unreadable                                       → identity-unreadable
 *   /proc says it is gone                                           → identity-missing
 *   any other read failure                                          → identity-<reason>
 * 7 start time differs                                             → pid-reused
 * 8 the process runs under another DSH home                        → dsh-home-mismatch
 * 9 the command line carries another profile                       → profile-mismatch
 * ```
 *
 * @param ctx - transport (the `/proc` reader) and, when `requireRegistry` is set, the registry.
 * @param runtime - host runtime the records live on.
 * @param options - one of {@link OWNERSHIP_OPTIONS} plus the pid, layout and profile.
 * @returns `{ ok: true }` with the evidence, or the frozen reason it refused.
 */
export async function proveOwnership(
  ctx: Transport & RemoteDeps & Reporter,
  runtime: HostRuntime,
  options: ProveOwnershipOptions,
): Promise<OwnershipVerdict> {
  const { pid, layout, profile } = options
  const sources: readonly OwnershipSource[] = options.sources ?? ['launched']
  const prefer = options.prefer ?? 'launched-first'
  const startTimeMode = options.startTime ?? 'when-recorded'
  const noProofReason: OwnershipReason = options.noProofReason ?? 'not-launched-by-this-connection'
  const forbidAlongside = options.forbidAlongside !== false
  const alongside = Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : []
  const launched =
    sources.includes('launched') && runtime.launched instanceof Map ? runtime.launched.get(pid) : undefined
  const bound: BoundProcess | null =
    sources.includes('bound') &&
    runtime.bound !== null &&
    runtime.bound !== undefined &&
    Number(runtime.bound.pid) === pid
      ? runtime.bound
      : null
  const launchedProof = launched ?? null
  const proof = prefer === 'bound-first' ? (bound ?? launchedProof) : (launchedProof ?? bound)
  const source: OwnershipSource | null = proof === null ? null : proof === launchedProof ? 'launched' : 'bound'
  const evidence: OwnershipEvidence = {
    pid,
    source,
    recordedStartTime: proof === null ? null : typeof proof.startTime === 'string' ? proof.startTime : null,
    identity: null,
    registry: null,
    layout,
    profile,
  }
  const refuse = (reason: OwnershipReason): OwnershipVerdict => ({ ok: false, reason, evidence })

  if (!isPid(pid)) return refuse('pid-unknown')
  if (options.requireBoundPid === true && Number(runtime.remote.pid) !== pid) return refuse('not-the-bound-instance')
  if (forbidAlongside && alongside.includes(pid)) return refuse('kept-alongside')
  if (proof === null) return refuse(noProofReason)

  if (options.requireRegistry === true) {
    const registry = await readRegistryQuietly(ctx, runtime, layout)
    evidence.registry = registry
    const registered =
      registry !== null &&
      registry.dshHome === layout.dshHome &&
      registry.profile === profile &&
      Number(registry.pid) === pid
    if (!registered) return refuse('registry-mismatch')
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
    // "The process is gone" and "the process could not be read" are different refusals: the
    // explicit stop clears a stale registry only for the first one.
    return refuse(identity.reason === 'missing' ? 'identity-missing' : `identity-${identity.reason}`)
  }
  if (startTimeMode === 'strict') {
    if (identity.startTime !== proof.startTime) return refuse('pid-reused')
  } else if (typeof proof.startTime === 'string' && identity.startTime !== proof.startTime) {
    return refuse('pid-reused')
  }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) return refuse('dsh-home-mismatch')
  if (profile !== '' && !commandMatchesProfile(identity.command, profile)) return refuse('profile-mismatch')
  return { ok: true, evidence }
}

/**
 * The mutable per-host state — one flat object, eight type-level blocks.
 *
 * design-arch §2.2/§7.4 divide the 67 fields (66 declared + `warningSource`) into eight blocks and
 * name the **single module** allowed to write each one. The fields stay flat (decision H1): every
 * reader keeps `runtime.status` / `runtime.ssh` / `runtime.remote.uiReady`, because 136 unit-test
 * assertions, `host-view.ts` and `diagnostics.ts` read those paths. Splitting the *type* is what
 * buys the boundary; physical nesting is a separate, later change.
 *
 * | # | block        | fields | writer                                        |
 * |---|--------------|--------|-----------------------------------------------|
 * | 1 | `identity`   | 2      | `host-registry.ts` (`ensureRuntime`/`commitEntry`) |
 * | 2 | `session`    | 20     | `runtime/fsm.ts` — only through `dispatch()`/`writeBack()` |
 * | 3 | `link`       | 12     | `connect/link.ts`                             |
 * | 4 | `remote`     | 19     | `connect/remote-state.ts`                     |
 * | 5 | `authz`      | 3      | `connect/ownership.ts` (read-only elsewhere)  |
 * | 6 | `logs`       | 3      | `connect-log.ts`                              |
 * | 7 | `rendezvous` | 3      | `prompts.ts`                                  |
 * | 8 | `timers`     | 5      | `host-lifecycle.ts`                           |
 *
 * 2 + 20 + 12 + 19 + 3 + 3 + 3 + 5 = 67. The `remote` row counts the container plus its 12
 * sub-fields (1 + 12 + the six facts/home/exchange/restarts fields), which is why the block
 * interface itself declares seven properties.
 *
 * Deviation log for this stage (see the report): `phase`, `linkBusy`, `episodeSource`, `restarts`
 * and the three promise fields keep today's wider storage type, because narrowing them would force
 * edits in `connect/pipeline.ts`/`host-lifecycle.ts`, which this stage does not own. The FSM's own
 * `SessionState` (`runtime/fsm.ts`) uses the narrow types; `writeBack` converts on the way out.
 */
import type { BilingualText } from './util.js'
import type { ErrorView } from './errors.js'
import type { HostEntry } from './settings.js'
import type { ConnectLogEntry } from './connect-log.js'
import type { ConnectProgressState } from './connect-progress.js'
import type { RemoteFacts } from './probe.js'
import type { ExchangeResult } from './remote-proc.js'
import type { Tunnel } from './tunnel.js'
import type { SshPort } from './ssh-port.js'
// Type-only edge into `prompts.ts`, the same pattern `context.ts` already uses for
// `LifecycleVerdict`: the rendezvous block is *declared* from the payload types its only writer
// owns, and both edges erase at emit time, so nothing cycles at run time.
import type { PendingConflict, PendingHostKey } from './prompts.js'

/* ── block vocabulary (design-arch §2.4.1 / §7.2) ─────────────────────────────────────────── */

/** The eight statuses `HostView.status` may carry. `limited` is reserved: P2 never produces it. */
export type HostStatus =
  | 'unconfigured'
  | 'connecting'
  | 'fingerprint-pending'
  | 'conflict-pending'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'limited'

/** What the user wants, as opposed to what the transport currently sees. */
export type Desired = 'idle' | 'connected'

/** The one-shot link action that currently owns the runtime (§2.4.5 collapses four locks into this). */
export type Activity = 'connect' | 'restart' | 'reattach' | 'stop' | 'repair'

/** The staged connect line, in order. */
export type ConnectPhase = 'ssh' | 'probe' | 'bootstrap' | 'start' | 'tunnel' | 'verifying' | 'ready'

/** A progress line: the code the Client localizes plus its interpolation values. */
export type Progress = ConnectProgressState

/** Why `warning` is set; a successful attach clears only the `restart-stop` one. */
export type WarningSource = 'alongside' | 'restart-stop'

/**
 * Where a liveness episode was observed. The three reporters today: the heartbeat probe, the
 * same-origin proxy and the tunnel's own error callback. The storage field is narrowed to them so
 * a typo cannot silently disable the episode cooldown (the contract's `source` stays a string).
 */
export type EpisodeSource = 'heartbeat' | 'proxy' | 'tunnel'

/** One bounded diagnostics entry of a restart / re-attach; never sent to the Client. */
export interface RestartRecord {
  at: string
  kind: 'local-restart' | 'remote-reattach'
  fromPort: number | null
  toPort: number
  pid: number | null
  /** Re-attach only: why the watchdog asked for it, and which reporter saw the remote fail. */
  reason?: string
  source?: string
}

/** One open liveness episode (`heartbeat`/`tunnel`/`proxy` saw the remote UI fail). */
export interface EpisodeState {
  source: EpisodeSource
  phase: 'suspected' | 'confirmed'
  cooldownUntil: number
}

/** The `HostView.conflict` payload; §7.2 will move it to `src/contracts.ts` once that file exists. */
export interface ConflictView {
  detectedAt: string
  processes: { pid: number; command: string }[]
}

/* ── payload types the blocks are made of ─────────────────────────────────────────────────── */

/** The remote web this runtime currently knows about; cleared by every teardown. */
export interface RemoteRuntime {
  version: string | null
  uiReady: boolean
  localPort: number | null
  port: number | null
  pid: number | null
  dshHome: string | null
  profile: string | null
  bootstrapLevel: string | null
  nodeVersion: string | null
  nodeSource: string | null
  startedAt: string | null
  /**
   * Bumped on every successful attach (connect, local restart, remote re-attach).
   * The Client uses it to know that its warm carrier holds a launch URL and a
   * session cookie from the previous tunnel, so it must navigate again.
   */
  viewRev: number
}

/** §7.2 calls this `RemoteView`; the long-standing name stays because readers import it. */
export type RemoteView = RemoteRuntime

/** One process this connection launched, with the identity proved before the launch. */
export interface LaunchedProcess {
  startTime: string
  command: string
  dshHome: string
}

/**
 * The host-key context a runtime carries (target and, separately, its jump host).
 *
 * `host`/`port` are only set on the jump context: a remembered jump pin is valid for exactly one
 * machine, so it has to carry the identity it was confirmed for (see `prompts.ts`); the target
 * context is addressed by the host entry itself and leaves them unset.
 */
export interface RuntimeFingerprint {
  sha256: string
  keyType: string
  status: string
  pinned: string
  host?: string | null
  port?: number
}

/** The process this connection is bound to, with the `/proc` identity that proved it. */
export interface BoundProcess {
  pid: number
  startTime: string
  origin: string
}

/* ── 1/8 identity — writer: host-registry.ts ───────────────────────────────────────────────── */

/** The store-backed host this runtime belongs to. Written only by `host-registry.ts`. */
export interface RuntimeIdentity {
  id: string
  entry: HostEntry
}

/* ── 2/8 session — writer: runtime/fsm.ts (dispatch/writeBack only) ────────────────────────── */

/**
 * Everything the state machine owns: what the user wants, what the link is doing, and the counters
 * and flags that decide whether a late write may still land.
 *
 * No other module may assign into this block once the FSM is wired (P2 step 4); today the
 * pipeline/lifecycle/prompts still do, which is exactly the ownership this block retires.
 */
export interface RuntimeSession {
  status: HostStatus
  phase: ConnectPhase | null
  progress: Progress | null
  error: ErrorView | null
  warning: BilingualText | null
  /**
   * Why `warning` is set (`alongside` | `restart-stop`): a successful attach clears a stale
   * "stop not confirmed" warning but must keep describing a process that is still running, so
   * the reason has to travel with the text. `null` on a runtime that never warned.
   */
  warningSource: WarningSource | null
  desired: Desired
  closing: boolean
  /**
   * The user answered a prompt with "no" (or let it time out): the connection attempt must
   * not be retried automatically, because a retry would ask the same question again (H2).
   */
  connectCancelled: boolean
  /**
   * The transport this attempt was dialling closed under the pipeline (including while the
   * handshake was still waiting for a host-key answer). Such a failure is a dropped link,
   * not an auth/key decision (H3).
   */
  transportLost: boolean
  reconnectAttempts: number
  /** The in-flight connect/restart/re-attach, held by the executor (§2.4.5). */
  connectPromise: Promise<void> | null
  restartPromise: Promise<void> | null
  reattachPromise: Promise<void> | null
  /**
   * `activity`'s storage form. Narrowed to the five activities: `beginLinkWork` is the only
   * writer and it takes an `Activity`; `SessionState.activity` maps 1:1.
   */
  linkBusy: Activity | null
  /** `epoch`: the token a one-shot action must still hold to be allowed to write (R4/R10). */
  linkToken: number
  /** Consecutive failed liveness probes; a confirmed episode is two of them. */
  remoteFailures: number
  remoteEpisode: boolean
  /** `episode`'s storage form: which reporter saw the remote fail (see `EpisodeSource`). */
  episodeSource: EpisodeSource | null
  episodeCooldownUntil: number
}

/* ── 3/8 link — writer: connect/link.ts ────────────────────────────────────────────────────── */

/** The live transport, its tunnel, the launch token and everything credential-shaped. */
export interface RuntimeLink {
  ssh: SshPort | null
  jumpSsh: SshPort | null
  tunnel: Tunnel | null
  token: string | null
  password: string | null
  /**
   * What to do with `password` once SSH accepts it: write it to the credential store, or
   * remove the stored record (an explicit "this connection only"). Both reset per attempt.
   */
  savePassword: boolean
  forgetPassword: boolean
  /** Mirrors the credential store for `HostView.passwordSaved` (restored on load). */
  passwordSaved: boolean
  fingerprint: RuntimeFingerprint | null
  /**
   * The jump host's own host key context: `{ sha256, keyType, status, pinned }`. Kept apart
   * from `fingerprint` (the target) so a jump-host confirmation can never pin the target
   * and a target pin can never be checked against the jump host (B1).
   */
  jumpFingerprint: RuntimeFingerprint | null
  tunnelRepairFailures: number
  nextTunnelRepairAt: number
}

/* ── 4/8 remote — writer: connect/remote-state.ts ──────────────────────────────────────────── */

/** The remote web, the probe facts and the memories that must survive a teardown (H1/R9). */
export interface RuntimeRemote {
  remote: RemoteRuntime
  facts: RemoteFacts | null
  /**
   * The last known remote home, managed web pid and profile. `facts`/`remote` are cleared by
   * every teardown, but the idle policy still has to prove and stop the right process on the
   * right host path afterwards (H1).
   */
  remoteHome: string | null
  remotePid: number | null
  remoteProfile: string | null
  exchange: ExchangeResult | null
  /** Bounded diagnostics trail of restarts and re-attached ports (never sent to the Client). */
  restarts: RestartRecord[]
}

/* ── 5/8 authz — writer: connect/ownership.ts (everyone else: read-only) ───────────────────── */

/**
 * The kill rights this connection proved. `connect/ownership.ts` maintains the block and is the
 * only module that decides with it: every authorization read goes through `proveOwnership()`.
 * `restart`/`stop`/`reattach` still prune a record they just retired (a confirmed stop deletes the
 * pid, a re-attach drops the wrapper pid), but none of them re-implements the proof.
 */
export interface RuntimeAuthz {
  /**
   * Processes this connection actually launched (pid -> identity), plus pids adopted from a
   * registry record written by a launch. Only these may ever be stopped; a pid a re-attach
   * discovered gets display rights, never kill rights.
   */
  launched: Map<number, LaunchedProcess>
  /**
   * The remote web this connection is bound to, with the `/proc` identity proved when it bound:
   * `{ pid, startTime, origin: 'launch' | 'reattach' }`. A re-attached pid lives here (never in
   * `launched`), so the explicit "Stop remote DSH" action can stop exactly that one process
   * without granting the kill right to a restart.
   */
  bound: BoundProcess | null
  /** Processes kept alongside this connection (chosen in the conflict prompt). */
  alongsidePids: number[]
}

/* ── 6/8 logs — writer: connect-log.ts ─────────────────────────────────────────────────────── */

/** The per-host connect-log ring and its cursors. */
export interface RuntimeLogs {
  logs: ConnectLogEntry[]
  logSeq: number
  /** Which connection this runtime is on; the connect log starts at 1 and resets its ring. */
  connectCount: number
}

/* ── 7/8 rendezvous — writer: prompts.ts ───────────────────────────────────────────────────── */

/** The two paused-prompt slots and the conflict card the Client may be showing. */
export interface RuntimeRendezvous {
  pendingHostKey: PendingHostKey | null
  pendingConflict: PendingConflict | null
  conflict: ConflictView | null
}

/* ── 8/8 timers — writer: host-lifecycle.ts ────────────────────────────────────────────────── */

/** Every timer the watchdog owns, plus the in-flight listener rebuild teardown has to await. */
export interface RuntimeTimers {
  reconnectTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  remoteCheckTimer: ReturnType<typeof setTimeout> | null
  /** Current tunnel repair (a broken local listener under a healthy remote). */
  tunnelRepair: Promise<{ ok: boolean; reason?: string }> | null
}

/**
 * The per-host runtime object shared by the service and every helper: the eight blocks, flat.
 *
 * The intersection is not decoration — it is the compile-time proof that the object has exactly
 * these 67 field paths, and `createHostRuntime` below is checked against it field by field.
 */
export type HostRuntime = RuntimeIdentity &
  RuntimeSession &
  RuntimeLink &
  RuntimeRemote &
  RuntimeAuthz &
  RuntimeLogs &
  RuntimeRendezvous &
  RuntimeTimers

/** An empty `RemoteRuntime`; the teardown path resets to it while keeping the version. */
export function emptyRemote(): RemoteRuntime {
  return {
    version: null,
    uiReady: false,
    localPort: null,
    port: null,
    pid: null,
    dshHome: null,
    profile: null,
    bootstrapLevel: null,
    nodeVersion: null,
    nodeSource: null,
    startedAt: null,
    viewRev: 0,
  }
}

/**
 * Build the mutable state for one host. The entry always carries the id the store issued.
 *
 * The return annotation types the literal field by field, so an empty container needs no `as`
 * (contextual typing supplies its element type) and a missing or extra field is a compile error.
 * @param host - the stored host, already carrying its id.
 * @returns a fresh runtime in the `unconfigured` state.
 */
export function createHostRuntime(host: HostEntry & { id: string }): HostRuntime {
  return {
    id: host.id,
    entry: host,
    status: 'unconfigured',
    phase: null,
    progress: null,
    error: null,
    warning: null,
    warningSource: null,
    fingerprint: host.pinnedFingerprint
      ? { sha256: host.pinnedFingerprint, keyType: 'pinned', status: 'pinned', pinned: host.pinnedFingerprint }
      : null,
    jumpFingerprint: null,
    remote: emptyRemote(),
    ssh: null,
    jumpSsh: null,
    tunnel: null,
    token: null,
    password: null,
    savePassword: false,
    forgetPassword: false,
    passwordSaved: false,
    facts: null,
    remoteHome: null,
    remotePid: null,
    remoteProfile: null,
    exchange: null,
    pendingHostKey: null,
    pendingConflict: null,
    conflict: null,
    desired: 'idle',
    connectCancelled: false,
    transportLost: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    idleTimer: null,
    connectPromise: null,
    linkBusy: null,
    linkToken: 0,
    restartPromise: null,
    reattachPromise: null,
    launched: new Map<number, LaunchedProcess>(),
    bound: null,
    tunnelRepair: null,
    tunnelRepairFailures: 0,
    nextTunnelRepairAt: 0,
    heartbeatTimer: null,
    remoteCheckTimer: null,
    remoteFailures: 0,
    remoteEpisode: false,
    episodeSource: null,
    episodeCooldownUntil: 0,
    alongsidePids: [],
    restarts: [],
    closing: false,
    logs: [],
    logSeq: 0,
    connectCount: 0,
  }
}

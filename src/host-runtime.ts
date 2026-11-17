import type { BilingualText } from './util.js'
import type { ErrorView } from './errors.js'
import type { HostEntry } from './settings.js'
import type { ConnectLogEntry } from './connect-log.js'
import type { ConnectProgressState } from './connect-progress.js'
import type { RemoteFacts } from './probe.js'
import type { ExchangeResult } from './remote-proc.js'
import type { Tunnel } from './tunnel.js'
import type { SshConnection } from './ssh.js'

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

/**
 * The mutable per-host state. `service` owns the object; `connect-pipeline` drives it,
 * `connect-log`/`connect-progress` write their own slices, and `host-view`/`diagnostics`
 * only read it.
 */
export interface HostRuntime {
  id: string
  entry: HostEntry
  status: string
  phase: string | null
  progress: ConnectProgressState | null
  error: ErrorView | null
  warning: BilingualText | null
  /**
   * Why `warning` is set (`alongside` | `restart-stop`): a successful attach clears a stale
   * "stop not confirmed" warning but must keep describing a process that is still running, so
   * the reason has to travel with the text. Absent on a runtime that never warned.
   */
  warningSource?: string | null
  fingerprint: RuntimeFingerprint | null
  /**
   * The jump host's own host key context: `{ sha256, keyType, status, pinned }`. Kept apart
   * from `fingerprint` (the target) so a jump-host confirmation can never pin the target
   * and a target pin can never be checked against the jump host (B1).
   */
  jumpFingerprint: RuntimeFingerprint | null
  remote: RemoteRuntime
  ssh: SshConnection | null
  jumpSsh: SshConnection | null
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
  pendingHostKey: unknown
  pendingConflict: unknown
  conflict: unknown
  desired: string
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
  reconnectTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  connectPromise: Promise<unknown> | null
  /** One-shot link actions (local restart / remote re-attach / listener repair / stop) and their token. */
  linkBusy: string | null
  linkToken: number
  restartPromise: Promise<unknown> | null
  reattachPromise: Promise<unknown> | null
  /**
   * Processes this connection actually launched (pid -> start time), plus pids adopted from a
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
  /** Current tunnel repair (a broken local listener under a healthy remote). */
  tunnelRepair: Promise<{ ok: boolean; reason?: string }> | null
  tunnelRepairFailures: number
  nextTunnelRepairAt: number
  /** Liveness probes: a confirmed episode is two consecutive failed probes. */
  heartbeatTimer: ReturnType<typeof setInterval> | null
  remoteCheckTimer: ReturnType<typeof setTimeout> | null
  remoteFailures: number
  remoteEpisode: boolean
  episodeSource: string | null
  episodeCooldownUntil: number
  /** Processes kept alongside this connection (chosen in the conflict prompt). */
  alongsidePids: number[]
  /** Bounded, client-independent record of restarts / re-attaches for diagnostics. */
  restarts: Array<Record<string, unknown>>
  closing: boolean
  logs: ConnectLogEntry[]
  logSeq: number
  // Which connection this runtime is on; the connect log starts at 1 and resets its ring.
  connectCount: number
}

/**
 * The per-host runtime object shared by the service and every helper.
 */
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

/** Build the mutable state for one host. The entry always carries the id the store issued. */
export function createHostRuntime(host: HostEntry & { id: string }): HostRuntime {
  return {
    id: host.id,
    entry: host,
    status: 'unconfigured',
    phase: null,
    progress: null,
    error: null,
    warning: null,
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
    // The three containers start empty and are filled by `connect-pipeline`; the `as` fixes the
    // element type an empty literal cannot infer (it erases at emit time).
    alongsidePids: [] as number[],
    restarts: [] as Array<Record<string, unknown>>,
    closing: false,
    logs: [] as ConnectLogEntry[],
    logSeq: 0,
    connectCount: 0,
  }
}

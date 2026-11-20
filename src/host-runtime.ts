/** The mutable per-host state: one flat object in eight type-level blocks. The fields stay flat because tests,
 * `host-view.ts` and `diagnostics.ts` read them; each block names the module that owns its write policy. */
import type { BilingualText } from './util.js'
import type { ErrorView } from './errors.js'
import type { HostEntry } from './settings.js'
import type { ConnectLogEntry } from './connect-log.js'
import type { ConnectProgressState } from './connect-progress.js'
import type { RemoteFacts } from './probe.js'
import type { ExchangeResult } from './remote-proc.js'
import type { Tunnel } from './tunnel.js'
import type { SshPort } from './ssh-port.js'
import type { PendingConflict, PendingHostKey } from './prompts.js'
/** The eight statuses `HostView.status` may carry; `limited` is reserved. */
export type HostStatus =
  | 'unconfigured'
  | 'connecting'
  | 'fingerprint-pending'
  | 'conflict-pending'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'limited'
export type Desired = 'idle' | 'connected'
/** The one-shot link action that currently owns the runtime (four former locks collapsed into this). */
export type Activity = 'connect' | 'restart' | 'reattach' | 'stop' | 'repair'
export type ConnectPhase = 'ssh' | 'probe' | 'bootstrap' | 'start' | 'tunnel' | 'verifying' | 'ready'
export type Progress = ConnectProgressState
/** Why `warning` is set; a successful attach clears only the stale `restart-stop` one. */
export type WarningSource = 'alongside' | 'restart-stop'
/** Where a liveness episode was observed (typed so a typo cannot disable the cooldown). */
export type EpisodeSource = 'heartbeat' | 'proxy' | 'tunnel'
export interface RestartRecord {
  at: string
  kind: 'local-restart' | 'remote-reattach'
  fromPort: number | null
  toPort: number
  pid: number | null
  reason?: string
  source?: string
}
export interface ConflictView {
  detectedAt: string
  processes: { pid: number; command: string }[]
}
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
  viewRev: number
}
/** The published name of `RemoteRuntime` (`docs/api.md`, `HostView.remote`): readers import this one. */
export type RemoteView = RemoteRuntime
export interface LaunchedProcess {
  startTime: string
  command: string
  dshHome: string
}
export interface RuntimeFingerprint {
  sha256: string
  keyType: string
  status: string
  pinned: string
  host?: string | null
  port?: number
}
export interface BoundProcess {
  pid: number
  startTime: string
  origin: string
}
/** Identity block — written only by `host-registry.ts`. */
export interface RuntimeIdentity {
  id: string
  entry: HostEntry
}
/** Session block. `status` is the one single-writer field (`runtime/fsm.ts` writes it through `dispatch()`/
 * `writeBack()`); every other field's owners are the executable `SESSION_WRITERS` table in
 * `test/unit/guards.test.ts#runtime-writer-guard`, kept in step with this block. */
export interface RuntimeSession {
  status: HostStatus
  phase: ConnectPhase | null
  progress: Progress | null
  error: ErrorView | null
  warning: BilingualText | null
  warningSource: WarningSource | null
  desired: Desired
  closing: boolean
  connectCancelled: boolean
  transportLost: boolean
  reconnectAttempts: number
  connectPromise: Promise<void> | null
  restartPromise: Promise<void> | null
  reattachPromise: Promise<void> | null
  linkBusy: Activity | null
  linkToken: number
  remoteFailures: number
  remoteEpisode: boolean
  episodeSource: EpisodeSource | null
  episodeCooldownUntil: number
}

/** Link block — written by `connect/link.ts`: transport, tunnel, launch token and credentials. */
export interface RuntimeLink {
  ssh: SshPort | null
  jumpSsh: SshPort | null
  tunnel: Tunnel | null
  token: string | null
  password: string | null
  savePassword: boolean
  forgetPassword: boolean
  passwordSaved: boolean
  fingerprint: RuntimeFingerprint | null
  jumpFingerprint: RuntimeFingerprint | null
  tunnelRepairFailures: number
  nextTunnelRepairAt: number
}

/** Remote block — written by `connect/remote-state.ts`: the remote web, probe facts and teardown memory. */
export interface RuntimeRemote {
  remote: RemoteRuntime
  facts: RemoteFacts | null
  remoteHome: string | null
  remotePid: number | null
  remoteProfile: string | null
  exchange: ExchangeResult | null
  restarts: RestartRecord[]
}

/** Authz block — `connect/ownership.ts` maintains it and is the only module that decides with it. */
export interface RuntimeAuthz {
  launched: Map<number, LaunchedProcess>
  bound: BoundProcess | null
  alongsidePids: number[]
}

/** Logs block — written by `connect-log.ts`: the per-host ring and its cursors. */
export interface RuntimeLogs {
  logs: ConnectLogEntry[]
  logSeq: number
  connectCount: number
}

/** Rendezvous block — written by `prompts.ts`: the two paused prompts and the conflict card. */
export interface RuntimeRendezvous {
  pendingHostKey: PendingHostKey | null
  pendingConflict: PendingConflict | null
  conflict: ConflictView | null
}

/** Timers block — written by `host-lifecycle.ts`: every timer plus the in-flight listener rebuild. */
export interface RuntimeTimers {
  reconnectTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  remoteCheckTimer: ReturnType<typeof setTimeout> | null
  tunnelRepair: Promise<{ ok: boolean; reason?: string }> | null
}
/** The per-host runtime shared by the service and every helper: the eight blocks, flat. */
export type HostRuntime = RuntimeIdentity &
  RuntimeSession &
  RuntimeLink &
  RuntimeRemote &
  RuntimeAuthz &
  RuntimeLogs &
  RuntimeRendezvous &
  RuntimeTimers

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

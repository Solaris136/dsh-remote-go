/**
 * The connect pipeline: SSH -> probe -> managed Node -> plan -> adopt/conflict -> preflight -> start -> tunnel -> verify; the step order is the behavior and every step is injected.
 */
import {
  REMOTE_REATTACH_ATTEMPTS,
  REMOTE_REATTACH_INTERVAL_MS,
  REMOTE_REPAIR_BACKOFF_MAX_MS,
  REMOTE_REPAIR_BACKOFF_MS,
  REMOTE_START_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
  TUNNEL_PROBE_TIMEOUT_MS,
} from './constants.js'
import { beginConnectLog } from './connect-log.js'
import type { ConnectProgressState } from './connect-progress.js'
import type { ProgressParams } from './connect-progress.js'
import { errors, RemoteGoError, toErrorView } from './errors.js'
import type { ErrorView } from './errors.js'
import { runtimeOf } from './host-registry.js'
import {
  beginLinkWork,
  cancelIdleStop,
  closeTunnel,
  disconnectHost,
  disposeSsh,
  endLinkWork,
  isLinkWorkCurrent,
  scheduleReconnect,
} from './host-lifecycle.js'
import type { LifecycleVerdict } from './host-lifecycle.js'
import { dispatch, scopeFactsFor } from './runtime/dispatch.js'
import { createRuntimeEffects } from './runtime/effects.js'
import { isRefusal } from './runtime/fsm.js'
import type {
  ConnectPhase,
  HostRuntime,
  BoundProcess,
  LaunchedProcess,
  HostStatus,
  RestartRecord,
} from './host-runtime.js'
import { findKnownHostEntries, parseKnownHosts } from './known-hosts.js'
import { layoutForRuntime } from './layout.js'
import type { RemoteLayout } from './layout.js'
import { applyManagedNodeFacts, managedNodeVersionFromEngine } from './node-runtime.js'
import type { ManagedNode } from './node-runtime.js'
import { askConflict, requestHostKey } from './prompts.js'
import type { ExchangeResult, ProcessIdentity, RemoteProcessRef } from './remote-proc.js'
import { buildRunRegistryRecord, commandMatchesProfile } from './remote-web.js'
import type {
  AdoptedRemoteWeb,
  PersistedRunRegistry,
  ResolvedRemoteWeb,
  RunRegistryRecord,
  StartedRemoteWeb,
} from './remote-web.js'
import type { SshConnection } from './ssh.js'
import type { ClientChannel, HostKeyInfo, SshAuthConfig, SshConnectionOptions } from './ssh.js'
import type { HostEntry } from './settings.js'
import { resolveDestination } from './ssh-config.js'
import type { ResolvedDestination } from './ssh-config.js'
import type { Tunnel } from './tunnel.js'
import type { RemoteFacts } from './probe.js'
import type { LaunchPlan } from './bootstrap.js'
import type { BilingualText } from './util.js'
import { isPid, messageOf, nowIso, sleep } from './util.js'
import { normalizeVersion, versionsEqual } from './version.js'
import type { ConnectCtx, ReattachRequest } from './context.js'

/** A thrown value: the pipeline reads its message to classify a dropped transport. */
interface ThrownError {
  message?: unknown
}

/** A resolved dial target: what the host entry plus the local ssh config turned into. */
interface DialTarget {
  host: string
  port: number
  user?: string | null
  username: string | null
  identityFiles: string[]
  knownFingerprints: string[]
}

/** One resolved target, the entry it came from and (separately) its own jump host. */
interface ConnectTarget extends DialTarget {
  jumpHost: ResolvedDestination | null
  entry: HostEntry
}

/**
 * The remote web the pipeline is about to publish: one this connection started, or one it
 * adopted from a previous run. The two records differ (`startedAt`/`logPath` are pipeline-only,
 * `browserCarrier` only exists on a launch), so this is the union both are read through.
 */
interface WebInfo {
  pid: number
  port: number
  token: string
  logPath: string
  startedAt: string
  rawLine: string
  url?: string
  version?: string | null
  profile?: string
  dshHome?: string
  adopted?: boolean
  origin?: 'launch' | 'reattach'
  browserCarrier?: StartedRemoteWeb['browserCarrier']
}

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

/** The remote web this connection stopped (null when it was already gone). */
export interface StopRemoteResult {
  ok: boolean
  pid: number | null
}

/** One foreign DSH the conflict prompt describes. */
interface KnownProcess {
  pid: number
  command: string
}

/** What `resolveForeignConflict` may be told about pids the user already answered for. */
interface ForeignConflictOptions {
  ignoredPids?: number[]
  knownProcess?: KnownProcess | null
}

/** The state a failed stop has to put back exactly as it found it. */
interface StopState {
  status: HostStatus
  phase: ConnectPhase | null
  progress: ConnectProgressState | null
  error: ErrorView | null
  uiReady: boolean
  localPort: number | null
}

/** One connect-log line: the level plus the values `connect-progress` stringifies. */
type ConnectLogWriter = (level: string, ...args: unknown[]) => void

/** One progress-line update: the stage name, the code and its interpolation values. */
type PhaseWriter = (name: ConnectPhase, code: string, params?: ProgressParams) => void

function describeTarget(entry: HostEntry): string {
  const user = entry.username ? `${entry.username}@` : ''
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  return `${user}${entry.address || '?'}${port}`
}

/** The bilingual detail of "the transport this step needed is gone". */
const SSH_CLOSED_DETAIL: BilingualText = {
  zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
  en: 'SSH connection is not open; the transport closed before this step finished. Reconnect to continue.',
}

/**
 * Internal marker: a pipeline step ran after the user (or the host process) took the link
 * away. It is not a connection failure, so it never reaches the Client as an error.
 */
class LinkCancelled extends Error {
  declare code: string

  constructor(reason: string) {
    super(`connect aborted: ${reason}`)
    this.name = 'LinkCancelled'
    this.code = 'link-cancelled'
  }
}

/** Whether the link is no longer wanted: disconnect, host removal, teardown or shutdown. */
function linkTaken(ctx: ConnectCtx, runtime: HostRuntime): boolean {
  return (
    ctx.state.disposed === true ||
    runtime.closing === true ||
    runtime.desired !== 'connected' ||
    !ctx.state.runtimes.has(runtime.id)
  )
}

/** Throw unless this attempt may still write state (H4). */
function assertStillWanted(ctx: ConnectCtx, runtime: HostRuntime): void {
  if (linkTaken(ctx, runtime)) throw new LinkCancelled('the link is no longer wanted')
}

/** Throw a typed transport error unless the SSH transport is still open (H3). */
function assertTransportOpen(runtime: HostRuntime): void {
  if (runtime.ssh?.connected !== true) {
    throw errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed' })
  }
}

/**
 * Classify a pipeline failure. A step that raced the transport going away must read as a
 * dropped connection (`network`, retryable), never as a bare `internal` error or as a key
 * decision the user never made (H3).
 * @param runtime - host runtime.
 * @param error - the thrown value.
 * @returns the Client-facing error view.
 */
function normalizeConnectFailure(runtime: HostRuntime, error: ThrownError | null): ErrorView {
  const view = toErrorView(error)
  if (runtime.transportLost === true && runtime.ssh?.connected !== true) {
    // A prompt parked on the transport was resolved by the close itself: the user made no
    // decision, so this must not read as "confirm the host key" / "a manual DSH is running".
    if (view.code === 'host-key-unknown' || view.code === 'remote-dsh-running') {
      return toErrorView(
        errors.network(SSH_CLOSED_DETAIL, {
          technical: `reason=ssh-closed phase-code=${view.code}`,
        }),
      )
    }
  }
  if (runtime.ssh?.connected === true) {
    if (
      !(error instanceof RemoteGoError) &&
      /\b(?:not open|closed|ECONNRESET|EPIPE|Channel closed)\b/i.test(String(error?.message ?? ''))
    ) {
      return toErrorView(
        errors.network(SSH_CLOSED_DETAIL, { technical: `reason=ssh-closed cause=${error?.message ?? error}` }),
      )
    }
    return view
  }
  if (view.code === 'internal' || view.code === 'remote-dsh-missing' || view.code === 'remote-node-install-failed') {
    return toErrorView(
      errors.network(SSH_CLOSED_DETAIL, {
        technical: `reason=ssh-closed phase-code=${view.code} cause=${error instanceof Error ? error.message : String(error ?? '')}`,
      }),
    )
  }
  return view
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

/**
 * Start the pipeline in the background and make sure its promise never rejects: a listener
 * or a step outside the pipeline's own error handling must not become an unhandled
 * rejection that Node reports as a process-level failure (L).
 * @param ctx - service context.
 * @param runtime - host runtime.
 */
function startConnectPromise(ctx: ConnectCtx, runtime: HostRuntime): void {
  const run = connectPipeline(ctx, runtime).catch((error) => {
    ctx.progress.log(runtime, 'debug', 'connect pipeline stopped outside its error path:', messageOf(error))
  })
  runtime.connectPromise = run
  void run.finally(() => {
    if (runtime.connectPromise === run) runtime.connectPromise = null
  })
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

/**
 * Re-enter the pipeline after a dropped link. Lives here rather than in the
 * lifecycle module so `scheduleReconnect` stays a pure timer with a callback.
 *
 * The retry is a `connect.requested` with `retry: true`: it must publish `connecting` and clear
 * the previous failure, but it must **not** reset the retry budget the user's connect set (R5/H2),
 * so the event carries the one difference.
 */
async function reconnectNow(ctx: ConnectCtx, runtime: HostRuntime): Promise<void> {
  if (ctx.state.disposed || runtime.desired !== 'connected') return
  await disposeSsh(runtime)
  // A dropped link's retry is a new connection too: start from a clean log.
  beginConnectLog(runtime)
  const event = { type: 'connect.requested' as const, token: Number(runtime.linkToken) || 0, retry: true }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    run: () => startConnectPromise(ctx, runtime),
  })
}

/** A timer callback that starts a retry: report a throw instead of leaving it unhandled (L). */
function retryNow(ctx: ConnectCtx, runtime: HostRuntime): void {
  void reconnectNow(ctx, runtime).catch((error) => {
    ctx.progress.log(runtime, 'warn', 'the automatic retry could not start:', messageOf(error))
  })
}

/**
 * Watch one transport for its close. A close is one `transport.closed` event, and the rule
 * decides (design-arch §2.4.2) whether it was a stale listener, the teardown's own close, a
 * handshake that died (record the loss, settle the parked prompts, log) or a live link that
 * dropped (publish `disconnected`, close the listener, ask the retry policy for a timer).
 *
 * Attached as soon as the transport exists — before `connect()` — because a drop while the
 * handshake waits on a host-key prompt must resolve that prompt instead of parking the pipeline
 * until its 120 s timeout (H3/M1). This replaces the two listeners this module used to keep
 * (a silent handshake one and the live/in-flight one); their work is the event's effects now.
 * @param ctx - service context (the effect owner is bound to it).
 * @param runtime - host runtime.
 * @param ssh - the transport that was just created.
 */
function watchTransport(ctx: ConnectCtx, runtime: HostRuntime, ssh: SshConnection | null): void {
  if (!ssh || typeof ssh.on !== 'function') return
  ssh.on('close', () => {
    // A transport this runtime no longer dials (replaced, or disposed before a new attempt)
    // is not a lost link: its close is the teardown itself.
    if (runtime.ssh !== ssh && runtime.jumpSsh !== ssh) return
    if (runtime.closing || runtime.desired !== 'connected') return
    const event = { type: 'transport.closed' as const, transport: ssh }
    void dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'callback',
    }).then((result) => {
      // The rule said "a retry makes sense" (its `arm(reconnect)` effect); the randomized delay,
      // the budget and the settings switch stay in `scheduleReconnect`, the single place that
      // actually creates the retry timer (never a second loop here, P2b hand-off).
      const wantsRetry =
        result.ok && result.effects.some((effect) => effect.type === 'arm' && effect.timer === 'reconnect')
      if (wantsRetry) scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime))
    })
  })
}

/** Resolve the SSH destination from the entry + local ssh config, before dialling. */
async function resolveTargetForRuntime(ctx: ConnectCtx, runtime: HostRuntime): Promise<ConnectTarget> {
  const material = await ctx.deps.loadSshMaterial({ home: ctx.userHome() })
  const entry = runtime.entry
  const resolved = resolveDestination(entry.address, { configText: material.configText, home: ctx.userHome() })
  const host = resolved.host || entry.address
  const port = entry.port && entry.port !== 22 ? entry.port : (resolved.port ?? 22)
  const knownFingerprints = findKnownHostEntries(parseKnownHosts(material.knownHostsText), host, port).map(
    (item) => item.fingerprint,
  )
  return {
    host,
    port,
    username: entry.username || resolved.user || null,
    identityFiles: resolved.identityFiles ?? [],
    knownFingerprints,
    jumpHost: entry.jumpHost
      ? resolveDestination(entry.jumpHost, { configText: material.configText, home: ctx.userHome() })
      : null,
    entry,
  }
}

/**
 * Open the transport: direct, or through a jump host with a forwarded stream.
 *
 * The jump host and the target are separate security contexts. Each one gets its own
 * options — its own policy, its own pin and its own `onHostKey` role — so a key confirmed
 * for one can never be checked against, or written into, the other (B1).
 */
async function openTransport(ctx: ConnectCtx, runtime: HostRuntime, target: ConnectTarget): Promise<void> {
  const settings = ctx.settings()
  const auth = (): SshAuthConfig => ({
    type: runtime.entry.auth?.type ?? 'key',
    keyPath: runtime.entry.auth?.keyPath ?? null,
    password: runtime.password ?? null,
  })
  const buildOptions = (resolved: DialTarget, role: 'target' | 'jump', sock?: ClientChannel): SshConnectionOptions => {
    const isJump = role === 'jump'
    // A per-host policy and pin describe the saved target. A jump host only obeys the
    // global policy and, at most, a pin remembered for this session (it is not persisted).
    const hostKeyPolicy = isJump ? settings.hostKeyPolicy : (runtime.entry.hostKeyPolicy ?? settings.hostKeyPolicy)
    const resolvedPort = resolved.port ?? 22
    const jumpPinMatches =
      isJump &&
      runtime.jumpFingerprint?.host === resolved.host &&
      (Number(runtime.jumpFingerprint?.port) || 22) === resolvedPort
    const pinnedFingerprint = isJump
      ? jumpPinMatches
        ? (runtime.jumpFingerprint?.pinned ?? null)
        : null
      : (runtime.entry.pinnedFingerprint ?? null)
    return {
      host: resolved.host,
      port: resolvedPort,
      username: resolved.username ?? resolved.user ?? null,
      // The key path expands against the *user* home (`~/.ssh/...`), never against
      // DSH_HOME, so the SSH layer needs to know which one that is.
      home: ctx.userHome(),
      auth: auth(),
      identityFiles: resolved.identityFiles ?? [],
      hostKeyPolicy,
      pinnedFingerprint,
      knownHostFingerprints: resolved.knownFingerprints ?? [],
      acceptUnknownHostKey: false,
      readyTimeoutMs: settings.connectTimeoutSec * 1000 || SSH_READY_TIMEOUT_MS,
      ...(sock ? { sock } : {}),
      onHostKey: (info) => requestHostKey(ctx, runtime, info, { role, host: resolved.host, port: resolvedPort }),
    }
  }
  if (!target.jumpHost) {
    runtime.ssh = ctx.deps.sshFactory(buildOptions(target, 'target'))
    watchTransport(ctx, runtime, runtime.ssh)
    ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.host })
    captureFingerprint(ctx, runtime, await runtime.ssh.connect())
    return
  }
  ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.jumpHost.host, jump: true })
  const jumpTarget = {
    ...target.jumpHost,
    username: target.jumpHost.user ?? target.username,
    knownFingerprints: findKnownHostEntries(
      parseKnownHosts((await ctx.deps.loadSshMaterial({ home: ctx.userHome() })).knownHostsText),
      target.jumpHost.host,
      target.jumpHost.port ?? 22,
    ).map((item) => item.fingerprint),
  }
  // An edited `jumpHost` is a different machine: a pin remembered for the previous jump host
  // must not make the new one fail as `host-key-changed` (review blocker 3).
  const rememberedJump = runtime.jumpFingerprint
  const rememberedJumpPort = (Number(rememberedJump?.port) || 22) === (jumpTarget.port ?? 22)
  if (rememberedJump !== null && (!rememberedJumpPort || rememberedJump.host !== jumpTarget.host)) {
    ctx.progress.log(
      runtime,
      'info',
      `the jump host changed (${rememberedJump.host ?? 'unknown'} -> ${jumpTarget.host}); forgetting its previous host key`,
    )
    runtime.jumpFingerprint = null
  }
  runtime.jumpSsh = ctx.deps.sshFactory(buildOptions(jumpTarget, 'jump'))
  watchTransport(ctx, runtime, runtime.jumpSsh)
  await runtime.jumpSsh.connect()
  // The jump host's key is settled (its own context above); from here the fingerprint the host
  // card describes is the target's, which `captureFingerprint` fills once it answers.
  runtime.fingerprint = null
  ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.host, via: target.jumpHost.host })
  const stream = await runtime.jumpSsh.forwardOut(target.host, target.port ?? 22)
  runtime.ssh = ctx.deps.sshFactory(buildOptions(target, 'target', stream))
  watchTransport(ctx, runtime, runtime.ssh)
  captureFingerprint(ctx, runtime, await runtime.ssh.connect())
}

/** Remember the session fingerprint so the host card shows it even without a pin. */
function captureFingerprint(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  info: { fingerprint?: string; keyType?: string } | null,
): void {
  if (!info?.fingerprint) return
  const pinned = runtime.entry.pinnedFingerprint ?? null
  runtime.fingerprint = {
    sha256: info.fingerprint,
    keyType: info.keyType ?? 'unknown',
    status: pinned === info.fingerprint ? 'pinned' : pinned ? 'changed' : 'observed',
    pinned,
  }
  ctx.progress.log(
    runtime,
    pinned === info.fingerprint ? 'debug' : 'info',
    `host key ${info.keyType ?? 'unknown'}: ${info.fingerprint}${
      pinned === info.fingerprint ? ' (matches the pinned key)' : pinned ? ' (CHANGED from the pinned key)' : ''
    }`,
  )
  ctx.emitState()
}

/**
 * Warn when the remote already runs a DSH this plugin did not start, and let the
 * user decide: stop it, keep it alongside, or cancel.
 * @returns the decision, or null when no prompt was needed.
 */
async function resolveForeignConflict(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  layout: RemoteLayout,
  profile: string,
  options: ForeignConflictOptions = {},
): Promise<'stop' | 'alongside' | null> {
  // Processes the user already chose to keep alongside this connection are not asked
  // about again (a local restart must not turn that choice into a prompt every time).
  const ignorePids = (Array.isArray(options.ignoredPids) ? options.ignoredPids : []).filter((pid) => isPid(pid))
  try {
    const registry = await ctx.deps.readRegistry(runtime.ssh, layout)
    const pid = Number(registry?.pid)
    if (isPid(pid) && registry?.dshHome === layout.dshHome && registry?.profile === profile) ignorePids.push(pid)
  } catch (error) {
    // swallow-ok: registry absence is normal; the scan below still finds foreign processes
    ctx.progress.log(runtime, 'debug', 'foreign DSH: registry read failed:', messageOf(error))
  }
  const found = await ctx.deps.findForeign(runtime.ssh, { ignorePids })
  const processes = found.ok === true && Array.isArray(found.processes) ? [...found.processes] : []
  // The registry-named instance is normally ignored by the scan (it is this connection's own
  // process). When the caller cannot stop it - a pid a re-attach discovered - it still must be
  // put in front of the user: a second instance must never start silently next to it. Merge it
  // before failing open on a scan error: its identity came from /proc, not from the scan.
  const known = options.knownProcess
  const knownPid = Number(known?.pid)
  // A pid the user already chose to keep alongside is never asked about again; the
  // registry-named pid, however, must be shown when it could not be stopped.
  const keptAlongside = (Array.isArray(options.ignoredPids) ? options.ignoredPids : []).map(Number)
  if (
    isPid(knownPid) &&
    !keptAlongside.includes(knownPid) &&
    !processes.some((entry) => Number(entry?.pid) === knownPid)
  ) {
    processes.push({
      pid: knownPid,
      command: typeof known.command === 'string' && known.command !== '' ? known.command : `dsh --profile ${profile}`,
    })
  }
  if (found.ok !== true) {
    ctx.progress.log(runtime, 'debug', 'foreign DSH: scan failed:', found.reason ?? found.technical ?? 'unknown')
    // A broken scan must never allow a silent second instance: with a known live process we
    // still ask; with nothing known there is nothing to conflict with (the old behavior).
    if (processes.length === 0) return null
  }
  if (processes.length === 0) return null
  const pidList = processes.map((entry) => `pid ${entry.pid}`).join(', ')
  ctx.progress.log(
    runtime,
    'warn',
    `foreign DSH on the remote: ${processes.length} process(es) sharing this ~/.dsh (${pidList})`,
  )

  const decision = await askConflict(ctx, runtime, processes)
  if (decision.action === 'cancel') {
    // The user said no: retrying would ask the same question again. The `conflict.answered`
    // transition already recorded that (its rule owns `connectCancelled`); this is only the throw.
    throw errors.remoteDshRunning()
  }
  if (decision.action === 'alongside') {
    runtime.alongsidePids = processes.map((entry) => entry.pid).filter((pid) => isPid(pid))
    runtime.warning = {
      zh: '远端已有手工启动的 DSH；已按你的选择并存运行，两者共享 ~/.dsh，请避免同时操作同一会话。',
      en: 'A manually started DSH is already running; it was kept as you chose. Both share ~/.dsh, so avoid editing the same session in both.',
    }
    runtime.warningSource = 'alongside'
    return 'alongside'
  }
  const stopped = await ctx.deps.stopForeign(runtime.ssh, processes)
  if (stopped.ok !== true) {
    throw errors.remoteDshRunning(
      {
        zh: '远端的手工 DSH 进程没有停下来，连接已中止。',
        en: 'The manual remote DSH process did not stop, so the connection was aborted.',
      },
      {
        technical: `alive=${stopped.alive.join(',') || 'unknown'} output=${String(stopped.output ?? '').slice(0, 800)}`,
      },
    )
  }
  runtime.alongsidePids = []
  ctx.progress.log(runtime, 'info', `stopped ${processes.length} manual remote DSH process(es)`)
  return 'stop'
}

/** Open the loopback tunnel for one remote port; tunnel-level failures feed the liveness confirmation. */
async function openTunnelFor(ctx: ConnectCtx, runtime: HostRuntime, remotePort: number): Promise<Tunnel> {
  // Never hand the tunnel factory a missing transport: a listener created with no SSH channel
  // would crash the host process on the first connection (see tunnel.js's own guard).
  assertTransportOpen(runtime)
  if (!isPid(remotePort) || remotePort > 65535) {
    throw errors.internal(new Error(`invalid remote port for the tunnel: ${remotePort}`))
  }
  const onError = () => ctx.noteRemoteUnreachable?.(runtime, 'tunnel')
  const tunnel = await ctx.deps.tunnelFactory({ ssh: runtime.ssh, remotePort, onError })
  const localPort = Number(tunnel?.localPort)
  if (!Number.isInteger(localPort) || !isPid(localPort) || localPort > 65535) {
    try {
      await tunnel?.close?.()
    } catch {}
    throw errors.internal(new Error(`the tunnel factory returned no usable local port (${tunnel?.localPort})`))
  }
  // The listener was created while the caller awaited the factory: a disconnect or a host
  // removal in that window must close it instead of publishing it (H4).
  try {
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
  } catch (error) {
    try {
      await tunnel.close()
    } catch {}
    throw error
  }
  runtime.tunnel = tunnel
  runtime.remote.localPort = localPort
  ctx.progress.log(runtime, 'info', `tunnel open: 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort}`)
  return tunnel
}

/**
 * Record a pid this connection is allowed to stop later: it must have been launched by the
 * plugin's own start script (or adopted from a `launch` registry record) and its `/proc`
 * identity must show this DSH home and profile. Anything that fails this check is still
 * hosted and displayed, but never signalled.
 */
async function rememberLaunched(
  ctx: ConnectCtx,
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
async function rememberBound(
  ctx: ConnectCtx,
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
async function killAuthorized(
  ctx: ConnectCtx,
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
 * Rebuild the local listener for a host whose remote UI answers the SSH probe but whose
 * proxied requests fail: the tunnel, not the remote, is what broke. Single-flight per host and
 * owned by a link-work token, like restart/reattach: a disconnect, host removal or shutdown
 * cancels it and the caller waits for `runtime.tunnelRepair` before tearing down.
 *
 * The replacement is created before the old listener closes, so there is no window without a
 * listener. Its local port is a new random one, so `viewRev` is bumped: the carrier refetches
 * `GET /hosts/:id/open` and navigates again (the desktop guest's URL is the loopback origin).
 * Existing WebSockets/downloads are dropped by closing the old listener - documented.
 *
 * @param ctx - service context.
 * @param runtime - connected host runtime.
 * @returns whether the listener was rebuilt.
 */
export async function repairTunnel(ctx: ConnectCtx, runtime: HostRuntime): Promise<LifecycleVerdict> {
  if (
    ctx.state.disposed === true ||
    runtime.desired !== 'connected' ||
    runtime.status !== 'connected' ||
    runtime.linkBusy !== null ||
    runtime.tunnel === null
  ) {
    return { ok: false, reason: 'not-watchable' }
  }
  if (runtime.ssh?.connected !== true) return { ok: false, reason: 'no-transport' }
  if (runtime.tunnelRepair) return runtime.tunnelRepair
  if (Date.now() < (Number(runtime.nextTunnelRepairAt) || 0)) {
    return { ok: false, reason: 'backoff' }
  }
  const port = runtime.remote.port
  const previous = runtime.tunnel
  const token = beginLinkWork(runtime, 'repair')
  const stillCurrent = () =>
    isLinkWorkCurrent(runtime, token) &&
    ctx.state.disposed !== true &&
    runtime.desired === 'connected' &&
    runtime.status === 'connected' &&
    runtime.ssh?.connected === true
  let created: Tunnel | null = null
  let work: Promise<LifecycleVerdict> | null = null
  let settled: Promise<LifecycleVerdict> | null = null
  work = (async () => {
    try {
      if (runtime.ssh?.connected !== true) throw errors.internal(new Error('the SSH transport is gone'))
      if (!isPid(port) || port > 65535) throw errors.internal(new Error(`invalid remote port for the tunnel: ${port}`))
      const next = await ctx.deps.tunnelFactory({
        ssh: runtime.ssh,
        remotePort: port,
        onError: () => ctx.noteRemoteUnreachable?.(runtime, 'tunnel'),
      })
      created = next
      const nextPort = Number(next?.localPort)
      if (!Number.isInteger(nextPort) || !isPid(nextPort) || nextPort > 65535) {
        throw errors.internal(new Error(`the rebuilt tunnel has no usable local port (${next?.localPort})`))
      }
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      // Publish the replacement before closing the old listener: no no-listener window.
      runtime.tunnel = next
      runtime.remote.localPort = nextPort
      try {
        await previous.close()
      } catch {
        // swallow-ok: the old listener could already be gone; the new one is what matters
      }
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      // The local port changed, so the carrier's view of the host did too.
      runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1
      ctx.progress.log(
        runtime,
        'info',
        `tunnel rebuilt after a failed request (remote port ${port}, local port ${previous.localPort} -> ${nextPort})`,
      )
      runtime.tunnelRepairFailures = 0
      runtime.nextTunnelRepairAt = 0
      ctx.emitState()
      return { ok: true }
    } catch (error) {
      // swallow-ok: a failed rebuild is a typed, retryable reason (with backoff) for the caller;
      // the old listener is still serving, so this is not a connection failure.
      runtime.tunnelRepairFailures = (Number(runtime.tunnelRepairFailures) || 0) + 1
      const backoff = Math.min(
        REMOTE_REPAIR_BACKOFF_MAX_MS,
        REMOTE_REPAIR_BACKOFF_MS * 2 ** (runtime.tunnelRepairFailures - 1),
      )
      runtime.nextTunnelRepairAt = Date.now() + backoff
      ctx.progress.log(runtime, 'warn', 'tunnel rebuild failed:', messageOf(error))
      return { ok: false, reason: 'rebuild-failed' }
    } finally {
      // A listener this rebuild created must never outlive it: on a cancelled token (or if it
      // was never published) close it here, and clear the view only when it owned the slot.
      if (created !== null && (!isLinkWorkCurrent(runtime, token) || runtime.tunnel !== created)) {
        if (runtime.tunnel === created) {
          runtime.tunnel = null
          runtime.remote.localPort = null
        }
        try {
          await created.close()
        } catch {}
      }
      endLinkWork(runtime, token)
    }
  })()
  settled = work.finally(() => {
    if (runtime.tunnelRepair === settled) runtime.tunnelRepair = null
  })
  runtime.tunnelRepair = settled
  return settled
}

/** Prove the remote UI answers through the new tunnel and exchange this launch's token. */
async function verifyRemoteUi(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  port: number,
  token: string,
  localPort: number,
): Promise<ExchangeResult> {
  const tunnelPort = Number(localPort)
  if (!Number.isInteger(tunnelPort) || !isPid(tunnelPort) || tunnelPort > 65535) {
    throw errors.internal(new Error(`the tunnel has no local port to verify (${localPort ?? 'none'})`))
  }
  ctx.progress.log(runtime, 'debug', `verifying the remote UI on 127.0.0.1:${tunnelPort}`)
  const ui = await ctx.deps.waitUi(runtime.ssh, port, { attempts: 20, intervalMs: 500 })
  // The probe retries for up to ten seconds: the user may have cancelled in that window, and
  // the token exchange must not touch the (possibly closed) tunnel after it (H4).
  assertStillWanted(ctx, runtime)
  assertTransportOpen(runtime)
  if (!ui.ok) {
    throw errors.remoteUiUnreachable({
      zh: `远端 DSH 的本地 127.0.0.1:${port} 没有响应（HTTP ${ui.status ?? '无'}）。`,
      en: `The remote DSH on 127.0.0.1:${port} did not respond (HTTP ${ui.status ?? 'none'}).`,
    })
  }
  ctx.progress.log(runtime, 'debug', `remote UI answered HTTP ${ui.status}; exchanging the launch token`)
  const exchange = await ctx.deps.exchange(tunnelPort, token, {
    timeoutMs: TUNNEL_PROBE_TIMEOUT_MS,
  })
  runtime.exchange = exchange
  if (!exchange.ok) {
    throw errors.remoteUiUnreachable({
      zh: `本地隧道完成了 token 交换，但远端界面返回 HTTP ${exchange.status}（首次状态 ${exchange.firstStatus}）。`,
      en: `The tunnel exchanged the token but the remote UI answered HTTP ${exchange.status} (first ${exchange.firstStatus}).`,
    })
  }
  return exchange
}

/**
 * Publish the connected state and start watching the remote for its own restarts.
 *
 * The whole attach is one `connect.succeeded` transition: status/phase/progress/error, the
 * retry-budget reset, the stale "stop not confirmed" warning, the idle disarm, the heartbeat arm,
 * `uiReady`/`viewRev`, the link-block repair-budget reset and `activeHostId`.
 * @param ctx - service context.
 * @param runtime - the runtime that just reached `ready`.
 */
async function markConnected(ctx: ConnectCtx, runtime: HostRuntime): Promise<void> {
  const event = { type: 'connect.succeeded' as const }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    caller: 'script',
  })
}

/** Bounded diagnostics trail of restarts and re-attached ports (never sent to the client). */
function recordRestart(runtime: HostRuntime, entry: Omit<RestartRecord, 'at'>): void {
  const history = Array.isArray(runtime.restarts) ? runtime.restarts : []
  history.push({ at: nowIso(), ...entry })
  runtime.restarts = history.slice(-10)
}

/**
 * Persist (or forget) the SSH password now that the transport accepted it. Doing this right
 * after the handshake rather than after `connected` keeps a credential the server already
 * proved even when a later bootstrap step fails, so the next attempt does not ask again.
 * @param ctx - service context.
 * @param runtime - host runtime.
 * @param log - connect log writer.
 */
async function settlePasswordStorage(ctx: ConnectCtx, runtime: HostRuntime, log: ConnectLogWriter): Promise<void> {
  const save = runtime.savePassword === true
  const forget = runtime.forgetPassword === true
  runtime.savePassword = false
  runtime.forgetPassword = false
  if (!ctx.secrets || typeof runtime.password !== 'string' || runtime.password === '') return
  if (save) {
    runtime.passwordSaved = await ctx.secrets.set(runtime.id, runtime.password)
    if (runtime.passwordSaved) log('debug', 'saved the SSH password in the credential store')
    else log('warn', 'could not save the SSH password in the credential store')
    return
  }
  if (forget) {
    const removed = await ctx.secrets.remove(runtime.id)
    runtime.passwordSaved = !removed
  }
}

async function connectPipeline(ctx: ConnectCtx, runtime: HostRuntime): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  // Every attempt (a user connect or a scheduled retry) entered through `connect.requested`,
  // which owns `closing`, `transportLost`, the timer disarms and the `connecting` card.
  runtime.alongsidePids = []
  // Kill rights belong to this connection: a fresh connect starts with no launched pids.
  runtime.launched = new Map()
  runtime.bound = null
  runtime.tunnelRepairFailures = 0
  runtime.nextTunnelRepairAt = 0
  let remoteStarted = false
  let layout: RemoteLayout | null = null
  // Whether the SSH transport ever came up during this attempt: a link that was up and then
  // dropped is a connection event and is retried like one (H3).
  let transportUp = false
  try {
    const target = await resolveTargetForRuntime(ctx, runtime)
    assertStillWanted(ctx, runtime)
    const viaJump = target.jumpHost ? ` via ${target.jumpHost.host}` : ''
    log('debug', `target resolved: ${target.username ?? '(default)'}@${target.host}:${target.port}${viaJump}`)
    // A password-auth host may have one remembered: load it before the transport
    // is opened, so reconnect and background retries work without a prompt.
    if (runtime.entry.auth?.type === 'password' && !runtime.password && ctx.secrets) {
      const remembered = await ctx.secrets.get(runtime.id)
      if (remembered) {
        runtime.password = remembered
        runtime.passwordSaved = true
      }
      assertStillWanted(ctx, runtime)
    }
    phase('ssh', 'ssh-connecting', { host: runtime.entry.name })
    // An idle host keeps its SSH session for a fast resume; this attempt replaces it, so the
    // old one is released here instead of being overwritten (and leaked) by openTransport.
    if (runtime.ssh !== null || runtime.jumpSsh !== null) {
      log('debug', 'releasing the transport kept by the idle policy before dialling again')
      await disposeSsh(runtime)
      assertStillWanted(ctx, runtime)
    }
    await openTransport(ctx, runtime, target)
    // The transport is the link from here on: a drop during probe/bootstrap is a lost
    // connection too, so the close handler is attached before the remaining steps (H3).
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    transportUp = true
    log(
      'info',
      `SSH connected to ${target.host}:${target.port} as ${target.username ?? '(default)'} (fingerprint ${
        runtime.fingerprint?.sha256 ?? 'unknown'
      })`,
    )
    // SSH accepted the credential: this is the point the password is proven, before any
    // bootstrap step can fail and force the user to type it again.
    await settlePasswordStorage(ctx, runtime, log)
    assertStillWanted(ctx, runtime)

    phase('probe', 'probing')
    let facts = await ctx.deps.probe(runtime.ssh)
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    const freeGb = Math.round(Number(facts.diskFreeKb ?? 0) / 1_048_576)
    log(
      'debug',
      `probe: ${facts.os}/${facts.arch} · ${String(facts.osName ?? 'unknown OS')} · node ${
        facts.nodeVersion ?? 'not found'
      } · ${freeGb} GB free`,
    )
    // The runtime always runs on a plugin-owned Node (`~/.dsh/remote-go/node`),
    // whether or not the remote already has one: a shared system/nvm Node is
    // exactly what makes "works for my other project" break the remote DSH.
    // There is no system fallback on purpose, so this failure is the connection's.
    const profile = ctx.settings().bootstrap.profile
    const managedVersion = managedNodeVersionFromEngine(ctx.engineNodeRange())
    // A probe that did not report $HOME cannot address the remote layout: `remoteLayout`
    // throws instead of building a literal-tilde path (H1).
    const nodeLayout = layoutForRuntime({ facts })
    log('info', `managed Node: expecting v${managedVersion} in ${nodeLayout.nodeDir}`)
    const managed = await ctx.deps.ensureNode(runtime.ssh, {
      facts,
      layout: nodeLayout,
      version: managedVersion,
      onProgress: (event) => ctx.progress.nodeProgress(runtime, event),
    })
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    // The probe above reported every field, so the merged object is a full `RemoteFacts`; the
    // helper's own return type stays `Partial` because it also accepts a partial input.
    facts = applyManagedNodeFacts(facts, managed) as RemoteFacts
    log(
      'info',
      `managed Node ${managed.version}${managed.installed ? ' installed' : ' reused'} at ${managed.nodeBinDir}`,
    )
    runtime.facts = facts
    const targetVersion = ctx.localVersion()
    if (!targetVersion) {
      throw errors.invalidInput('version', {
        zh: '无法确定本机 DSH 版本，无法用 npx 固定同版本启动远端。请从 DSH 界面启动本插件，让 Host 读到本机版本。',
        en: 'The local DSH version is unknown, so the remote cannot be pinned to the same version. Start the plugin from the DSH UI so the Host can read the local version.',
      })
    }
    const plan = ctx.deps.plan({ facts, targetVersion, profile })
    log('info', `runtime plan ${plan.level}: ${plan.reason.en}`)

    phase('start', 'starting-remote', { level: plan.level })
    layout = layoutForRuntime(runtime)
    let webInfo: WebInfo | null = null
    // Adopt an instance left running by a previous local process (keep-alive).
    // Checked before the npx preflight: an adoptable instance should not require
    // registry access just to reconnect.
    try {
      const adopted = await ctx.deps.adopt(runtime.ssh, layout, { profile })
      const adoptedVersion = adopted?.version ? normalizeVersion(adopted.version) : null
      if (adopted && (!adoptedVersion || versionsEqual(adoptedVersion, targetVersion))) {
        webInfo = { ...adopted, logPath: layout.logFile, startedAt: nowIso(), rawLine: '' }
        log('info', `adopted running remote web pid=${adopted.pid} port=${adopted.port}`)
        // Only a record written by a launch script proves the process is ours to stop; a
        // re-attached record is hosted, not owned (B1). It is still the instance this
        // connection is bound to, so the explicit "Stop remote DSH" may stop it by identity.
        if (adopted.origin !== 'reattach') await rememberLaunched(ctx, runtime, adopted.pid, layout, profile)
        else await rememberBound(ctx, runtime, adopted.pid, layout, profile, 'reattach')
      } else if (adopted && adopted.origin !== 'reattach') {
        log(
          'info',
          `running remote web version ${adoptedVersion} != ${targetVersion}; stopping it and starting a matching instance`,
        )
        // The old process owns the same `~/.dsh` profile; leaving it running next
        // to the new one would share session files with a stale version.
        try {
          await ctx.deps.stopWeb(runtime.ssh, layout, { pid: adopted.pid })
        } catch (error) {
          log('warn', 'could not stop the stale remote web:', messageOf(error))
        }
      } else if (adopted) {
        log(
          'warn',
          `running remote web version ${adoptedVersion} != ${targetVersion}, but it was only re-attached; leaving it running`,
        )
      } else {
        log('debug', 'adopt: no running remote web to reuse')
      }
    } catch (error) {
      log('debug', 'adopt check failed:', messageOf(error))
    }
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    if (!webInfo) {
      // The registry row we refused to adopt (stale launch marker, unresponsive
      // HTTP, ...) still names a process on this ~/.dsh profile. Starting a second
      // one would let two clients write the same session files. A record written by a
      // re-attach names a process this plugin did not launch, so it is never stopped here.
      const leftover = await ctx.deps.readRegistry(runtime.ssh, layout)
      assertStillWanted(ctx, runtime)
      const leftoverPid = Number(leftover?.pid ?? 0)
      if (leftover?.origin === 'reattach') {
        log('info', `leaving a re-attached remote web instance alone (pid ${leftoverPid || 'unknown'})`)
      } else if (leftover?.dshHome === layout.dshHome && leftover?.profile === profile && isPid(leftoverPid)) {
        try {
          await ctx.deps.stopWeb(runtime.ssh, layout, { pid: leftoverPid })
          log('info', `stopped a non-adoptable remote web instance pid=${leftoverPid}`)
        } catch (error) {
          log('warn', 'could not stop the non-adoptable remote web:', messageOf(error))
        }
      }
      await resolveForeignConflict(ctx, runtime, layout, profile)
      assertStillWanted(ctx, runtime)
      assertTransportOpen(runtime)
      phase('bootstrap', 'bootstrapping', { level: plan.level })
      // Resolve the exact package in the foreground first: a cold npx download
      // belongs in the connect error, not in a detached process that only leaves a
      // log behind. This also warms the cache for the real start below.
      log('info', `npx preflight: resolving @deepseek-ai/dsh@${plan.start.targetVersion}`)
      const onStdout = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion)
      const onStderr = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion)
      await ctx.deps.preflight(runtime.ssh, plan, { onStdout, onStderr })
      assertStillWanted(ctx, runtime)
      assertTransportOpen(runtime)
      log('info', `npx preflight ready: @deepseek-ai/dsh@${plan.start.targetVersion}`)
      phase('start', 'starting-remote', { level: plan.level })
      webInfo = await ctx.deps.startWeb(runtime.ssh, {
        plan,
        layout,
        profile,
        timeoutMs: REMOTE_START_TIMEOUT_MS,
        onLine: (line) => log('debug', `remote: ${line}`),
      })
      log('info', `remote DSH started: pid ${webInfo.pid ?? '?'}, port ${webInfo.port}`)
    }
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    if (webInfo.browserCarrier === 'patched') {
      log(
        'info',
        'the remote profile disables api-remotes (browser Remote-Event carrier); re-enabled it for this launch',
      )
    }
    remoteStarted = true
    // Only the instance launched by this connection's start script may be stopped later;
    // an adopted one was already recorded above only when its record proves a launch.
    if (webInfo.adopted !== true) await rememberLaunched(ctx, runtime, webInfo.pid, layout, profile)
    assertStillWanted(ctx, runtime)
    runtime.token = webInfo.token
    runtime.remote = {
      version: targetVersion,
      uiReady: false,
      localPort: null,
      port: webInfo.port,
      pid: webInfo.pid ?? null,
      dshHome: layout.dshHome,
      profile,
      bootstrapLevel: plan.level,
      nodeVersion: facts.nodeVersion,
      nodeSource: 'managed',
      startedAt: webInfo.startedAt ?? nowIso(),
      viewRev: Number(runtime.remote.viewRev) || 0,
    }

    phase('tunnel', 'tunneling')
    const tunnel = await openTunnelFor(ctx, runtime, webInfo.port)
    assertStillWanted(ctx, runtime)

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token, tunnel.localPort)
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    // The remote UI is reachable both ways: the desktop half hands the loopback origin to a
    // Chromium guest, and the browser half frames it through the same-origin proxy (which strips
    // any X-Frame-Options). Either way this exchange proves the launch token works.
    runtime.remote.uiReady = true
    await ctx.store.patchHost(runtime.id, { lastOpenedAt: nowIso() })
    // The store write is an await: the user may have disconnected or deleted the host while
    // it was in flight, and a late write must not resurrect the link (H4).
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    runtime.entry = ctx.store.getHost(runtime.id) ?? runtime.entry
    if (ctx.settings().saveTokens) {
      await ctx.store.saveToken(runtime.id, webInfo.token)
      assertStillWanted(ctx, runtime)
    }
    // Last gate before publishing: never report a connected host that the user just removed
    // or disconnected (H4), and never dereference a tunnel this pipeline no longer owns.
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
    // `connect.succeeded` publishes `activeHostId` (the `publish-active-host` patch).
    await markConnected(ctx, runtime)
    const localPort = runtime.tunnel?.localPort ?? runtime.remote.localPort ?? '?'
    log('info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${localPort}`)
  } catch (error) {
    // Phase is cleared with the status; capture it first so the log says where it stopped.
    const failedPhase = runtime.phase
    // The transport was up earlier in this attempt and is gone now: the link dropped, which
    // is what the retry policy exists for, even while the remote was still being set up (H3).
    const droppedTransport = runtime.transportLost === true || (transportUp === true && runtime.ssh?.connected !== true)
    const cancelled = error instanceof LinkCancelled || linkTaken(ctx, runtime)
    // The user's "no" is read *before* the failure transition: `connect.failed` clears the flag
    // for the next attempt (today's catch reset it right after the decision), and the decision
    // itself still has to see it. This is the H2 "a refused prompt is final" rule.
    const saidNo = runtime.connectCancelled === true
    // The transition owns the state, the teardown and the failure lines; the caller only keeps
    // its own publication point (the retry decision below emits exactly like the old code) and
    // the one informational line the cancel branch used to write.
    const event = cancelled
      ? { type: 'connect.cancelled' as const }
      : { type: 'connect.failed' as const, view: normalizeConnectFailure(runtime, error), phase: failedPhase }
    await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'script',
      emit: false,
      // "A remote was started in this attempt" is this pipeline's own flag (it becomes true
      // before the remote block is written, and survives a failure inside the registry write);
      // the scope can only see the block. Pass the caller's verdict so a cancellation after the
      // remote started still honours the `stop` keep-alive policy.
      teardown: {
        stopRemote: remoteStarted && runtime.entry.keepAlive === 'stop',
        keepRemote: remoteStarted && runtime.entry.keepAlive !== 'stop',
      },
    })
    if (cancelled) log('info', 'connect cancelled by disconnect')
    // One place decides whether a failed attempt is retried, and the budget lives in
    // `scheduleReconnect` (H2). A user's "no" (host-key/conflict prompt) is final, and a
    // first manual connect that never reached the remote is reported instead of looping.
    if (!cancelled) {
      const retryable = runtime.error?.retryable !== false && !saidNo
      const repairAttempt = (Number(runtime.reconnectAttempts) || 0) > 0
      if (retryable && (repairAttempt || droppedTransport)) scheduleConnectRetry(ctx, runtime)
    }
    ctx.emitState()
  } finally {
    runtime.connectPromise = null
  }
}

/**
 * Arm the next automatic attempt after a failed connect/reconnect; `scheduleReconnect`
 * owns the settings gate and the attempt budget, so a spent budget is reported once.
 * @param {object} ctx - service context.
 * @param {object} runtime - host runtime.
 */
function scheduleConnectRetry(ctx: ConnectCtx, runtime: HostRuntime): void {
  if (ctx.state.disposed === true || runtime.desired !== 'connected') return
  if (!runtime.entry.autoReconnect || !ctx.settings().autoReconnect.enabled) return
  scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime))
}

async function readRegistryQuietly(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  layout: RemoteLayout,
): Promise<RunRegistryRecord | null> {
  try {
    return await ctx.deps.readRegistry(runtime.ssh, layout)
  } catch (error) {
    // swallow-ok: registry absence only means the restart cannot attribute the running pid
    ctx.progress.log(runtime, 'debug', 'restart: registry read failed:', messageOf(error))
    return null
  }
}

/**
 * Recompute the launch plan from the probe facts the connection already recorded. A
 * restart reuses the same managed Node, profile and pinned version, so `[ssh]`,
 * `[probe]` and `[bootstrap]` are deliberately not run again.
 */
function planForRuntime(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  profile: string,
): { plan: LaunchPlan; targetVersion: string; facts: RemoteFacts } {
  const facts = runtime.facts
  const targetVersion = ctx.localVersion()
  if (!facts || !targetVersion) {
    throw errors.internal(new Error('the connected host has no recorded probe facts or local version'))
  }
  return { plan: ctx.deps.plan({ facts, targetVersion, profile }), targetVersion, facts }
}

/**
 * Put a host back into its connected state without pretending the launch URL changed.
 *
 * One `restart.resumed` transition (`keptInstance` when the managed stop was not confirmed, which
 * is what puts the "no new instance was started" warning back on the card).
 * @param ctx - service context.
 * @param runtime - the runtime the restart action owns.
 * @param keptInstance - whether the old remote instance was kept on purpose.
 * @returns whether the link was still there to resume.
 */
async function resumeConnected(ctx: ConnectCtx, runtime: HostRuntime, keptInstance = false): Promise<boolean> {
  // A late action must never resurrect a link that was torn down or replaced while it waited:
  // the token is checked by callers, and these are the other three proofs that it still exists.
  if (runtime.desired !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) return false
  const event = { type: 'restart.resumed' as const, ...(keptInstance ? { keptInstance: true } : {}) }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), { caller: 'script' })
  return true
}

/**
 * Restart the managed remote web on the same SSH transport: stop the pid the run
 * registry names, `[start]` again on the same plan, rebuild the tunnel for the new
 * random port and verify. `[ssh]` / `[probe]` / `[bootstrap]` are not re-run, so a
 * password or host-key prompt can never appear here.
 *
 * Only the instance this connection launched is stopped; a process the plugin did
 * not start goes through the ordinary conflict prompt instead of being killed.
 *
 * Available while connected, and also from the `remote-unreachable` error state: that
 * state deliberately keeps the SSH transport so the user can restart exactly when a
 * remote re-attach found nothing to adopt (docs/design.md §5.6).
 *
 * @param ctx - service context.
 * @param runtime - host runtime with a live transport.
 * @returns whether the restart started.
 */
export async function restartHost(ctx: ConnectCtx, runtime: HostRuntime): Promise<AcceptedResult> {
  await ctx.init()
  if (runtime.connectPromise || runtime.linkBusy !== null) return { accepted: false, reason: 'busy' }
  const connected = runtime.status === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null
  const recoverable =
    runtime.status === 'error' &&
    runtime.error?.code === 'remote-unreachable' &&
    runtime.ssh?.connected === true &&
    runtime.facts !== null
  if (!connected && !recoverable) {
    throw errors.restartUnavailable()
  }
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`).
  // The token is the old `beginLinkWork` one: the rule adopts it (`epochAfter`) and hands it to the
  // script, so the late-write filter keeps the exact semantics it had.
  const token = (Number(runtime.linkToken) || 0) + 1
  const event = {
    type: 'restart.requested' as const,
    token,
    pid: runtime.remote.pid,
    port: runtime.remote.port,
  }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    caller: 'script',
    run: (activity, started) => {
      if (activity !== 'restart') return
      const work = runRestart(ctx, runtime, started)
      runtime.restartPromise = work
      void work.finally(() => {
        endLinkWork(runtime, started)
        if (runtime.restartPromise === work) runtime.restartPromise = null
      })
    },
  })
  return { accepted: true }
}

async function runRestart(ctx: ConnectCtx, runtime: HostRuntime, token: number): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const previousPort = runtime.remote.port
  // Restarting from the remote-unreachable error state has no tunnel to keep.
  const hadTunnel = runtime.tunnel !== null
  let killable = false
  let stoppedOwn = false
  let started = false
  let tunnelCreated = false
  try {
    // `restart.requested` already disarmed the heartbeat/reconnect/idle timers and published the
    // `start`/`restarting-remote` card.
    log('info', `restart requested (pid=${runtime.remote.pid ?? 'unknown'}, remote port=${previousPort ?? 'unknown'})`)

    // Whether the running pid is ours to stop needs three independent proofs: the registry
    // names it, this connection launched it, and /proc still shows the same process. A pid that
    // a re-attach discovered (or one kept alongside) is hosted, never killed.
    const registry = await readRegistryQuietly(ctx, runtime, layout)
    const managedPid = Number(runtime.remote.pid ?? 0)
    const registeredPid = Number(registry?.pid ?? 0)
    const registered =
      registry !== null &&
      registry.dshHome === layout.dshHome &&
      registry.profile === profile &&
      isPid(managedPid) &&
      registeredPid === managedPid
    if (registered) {
      const verdict = await killAuthorized(ctx, runtime, managedPid, layout, profile)
      killable = verdict.ok === true
      if (!killable) {
        log(
          'warn',
          `restart: not stopping pid ${managedPid} (${verdict.reason}); only a process this connection launched is stopped`,
        )
      }
    } else {
      log(
        'warn',
        `restart: the run registry does not name this connection's pid (${
          isPid(managedPid) ? managedPid : 'unknown'
        }); leaving the running instance alone`,
      )
    }
    // A live instance this connection cannot stop and did not launch (typically the pid a
    // re-attach discovered) still occupies this ~/.dsh + profile. It goes through the conflict
    // prompt: restarting must never start a second instance silently next to it
    // (docs/design.md §5.5). Pids this connection launched are its own current instance; the
    // registry mismatch is the caller's existing "leave it alone" behavior, not a foreign one.
    let knownProcess: KnownProcess | null = null
    const launchedHere = runtime.launched instanceof Map && runtime.launched.has(managedPid)
    if (!killable && !launchedHere && isPid(managedPid) && runtime.ssh?.connected === true) {
      const identity = await ctx.deps.processIdentity(runtime.ssh, managedPid)
      if (identity.ok === true) {
        const sameHome = identity.dshHome === '' || identity.dshHome === layout.dshHome
        if (sameHome && commandMatchesProfile(identity.command, profile)) {
          knownProcess = { pid: managedPid, command: identity.command }
        }
      } else if (identity.reason === 'unreadable') {
        // Alive but not provable: asking is safer than starting a second instance.
        knownProcess = { pid: managedPid, command: `dsh --profile ${profile}` }
      }
    }
    if (!isLinkWorkCurrent(runtime, token)) return

    // Ask about foreign instances BEFORE anything is stopped: cancelling the prompt must not
    // destroy the instance the user is currently connected to (docs/design.md §5.5).
    const decision = await resolveForeignConflict(ctx, runtime, layout, profile, {
      ignoredPids: Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : [],
      knownProcess,
    })
    if (!isLinkWorkCurrent(runtime, token)) return
    // The prompt stopped the instance this connection was attached to: the old attachment is
    // gone, so a later failure must not "resume" it.
    if (decision === 'stop') stoppedOwn = true

    if (killable) {
      const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid: managedPid })
      // A stop can take seconds; the link may have been dropped or replaced in the meantime.
      // A late action must not write warning/connected state on top of that.
      if (!isLinkWorkCurrent(runtime, token)) return
      stoppedOwn = stopped?.ok === true
      if (stoppedOwn) {
        log('info', `restart: stopped the managed remote web pid=${managedPid}`)
        if (runtime.launched instanceof Map) runtime.launched.delete(managedPid)
      } else {
        // Never start a second instance next to one whose stop was not confirmed. The old
        // tunnel is still open, so the host stays usable and the user can retry. The warning is
        // action-scoped data with no transition of its own: it is set here and cleared by
        // `connect.succeeded` once a fresh attach replaces the stale instance.
        runtime.warning = {
          zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试，或先断开再重连。',
          en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly, or disconnect and reconnect.',
        }
        runtime.warningSource = 'restart-stop'
        log(
          'warn',
          `restart: the managed remote web did not confirm its stop; not launching a second instance (${
            String(stopped?.output ?? '').slice(0, 300) || 'no output'
          })`,
        )
        if (await resumeConnected(ctx, runtime, true)) return
        // The link changed under us, or there was no tunnel to keep (restart from the error
        // state): never publish a fake "connected" state; explain instead of staying stuck.
        if (isLinkWorkCurrent(runtime, token) && runtime.status === 'connecting') {
          const failure = {
            type: 'restart.failed' as const,
            phase: 'start' as const,
            view: toErrorView(
              errors.restartUnavailable({
                zh: '远端受管 DSH 没有确认停止，本次没有启动新实例；请稍后重试。',
                en: 'The managed remote DSH did not confirm its stop, so no new instance was started; retry shortly.',
              }),
            ),
          }
          await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
            caller: 'script',
            keepLink: true,
          })
        }
        return
      }
    }
    if (!isLinkWorkCurrent(runtime, token)) return

    const { plan, targetVersion, facts } = planForRuntime(ctx, runtime, profile)
    phase('start', 'restarting-remote', { level: plan.level })
    log('info', `restart: launching @deepseek-ai/dsh@${plan.start.targetVersion} with profile ${profile}`)
    const webInfo = await ctx.deps.startWeb(runtime.ssh, {
      plan,
      layout,
      profile,
      timeoutMs: REMOTE_START_TIMEOUT_MS,
      onLine: (line) => log('debug', `remote: ${line}`),
    })
    started = true
    if (!isLinkWorkCurrent(runtime, token)) return
    await rememberLaunched(ctx, runtime, webInfo.pid, layout, profile)
    if (webInfo.browserCarrier === 'patched') {
      log(
        'info',
        'the remote profile disables api-remotes (browser Remote-Event carrier); re-enabled it for this launch',
      )
    }
    log('info', `restart: remote DSH started pid ${webInfo.pid ?? '?'}, port ${webInfo.port}`)

    const record = buildRunRegistryRecord({
      pid: webInfo.pid,
      port: webInfo.port,
      version: targetVersion,
      profile,
      dshHome: layout.dshHome,
      startedAt: webInfo.startedAt,
    })
    const written = await ctx.deps.writeRegistry(runtime.ssh, layout, record)
    if (written.ok === true) log('info', `restart: run registry refreshed (pid ${record.pid}, port ${record.port})`)
    else log('warn', 'restart: the run registry could not be refreshed:', written.output)
    if (!isLinkWorkCurrent(runtime, token)) return

    // The remote picked a random port again, so the old tunnel points at a dead port.
    phase('tunnel', 'tunneling')
    await closeTunnel(runtime)
    runtime.token = webInfo.token
    runtime.remote = {
      ...runtime.remote,
      version: targetVersion,
      uiReady: false,
      localPort: null,
      port: webInfo.port,
      pid: webInfo.pid ?? null,
      dshHome: layout.dshHome,
      profile,
      bootstrapLevel: plan.level,
      nodeVersion: facts.nodeVersion,
      nodeSource: 'managed',
      startedAt: webInfo.startedAt ?? nowIso(),
    }
    const tunnel = await openTunnelFor(ctx, runtime, webInfo.port)
    tunnelCreated = true
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token, tunnel.localPort)
    if (!isLinkWorkCurrent(runtime, token)) return
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, webInfo.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    recordRestart(runtime, {
      kind: 'local-restart',
      fromPort: previousPort,
      toPort: webInfo.port,
      pid: webInfo.pid ?? null,
    })
    await markConnected(ctx, runtime)
    log(
      'info',
      `restart: connected again on 127.0.0.1:${runtime.tunnel?.localPort ?? tunnel.localPort} (remote port ${previousPort} -> ${webInfo.port})`,
    )
  } catch (error) {
    if (!isLinkWorkCurrent(runtime, token)) {
      log('debug', 'restart aborted: the link was replaced by a disconnect or reconnect')
      return
    }
    // Nothing this connection owned was stopped, so the previous attachment is still
    // valid: cancelling a conflict prompt (or a failed relaunch) keeps the host usable.
    if (!stoppedOwn && !started && hadTunnel && runtime.ssh?.connected === true && runtime.tunnel !== null) {
      log('warn', `restart cancelled: ${messageOf(error)}; keeping the current remote instance`)
      await resumeConnected(ctx, runtime)
      return
    }
    const view =
      error instanceof LinkCancelled
        ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during restart' }))
        : toErrorView(error)
    // Phase is cleared with the status; capture it first so the log says where it stopped.
    const failedPhase = runtime.phase
    // The transition owns the error state, the failure lines and the teardown; the caller keeps
    // its own publication point (`emit:false`, emitted below exactly where it always was).
    const failure = { type: 'restart.failed' as const, view, phase: failedPhase }
    await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
      caller: 'script',
      emit: false,
      // Only a remote this restart launched is stopped; a restart that failed before the launch
      // leaves the instance it never touched alone (the rule cannot tell the two apart).
      teardown: { stopRemote: started && runtime.entry.keepAlive === 'stop' },
    })
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action: a disconnect (or a host
    // removal) during the rebuild would otherwise leave it open with a disposed SSH channel.
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
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
async function closeAuthorized(
  ctx: ConnectCtx,
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

/** Why the explicit stop refused, as the bilingual `ErrorView.detail` the Client renders. */
function describeStopRefusal(reason: string, pid: number): BilingualText {
  const target = isPid(pid) ? `pid ${pid}` : 'pid unknown'
  switch (reason) {
    case 'kept-alongside':
      return {
        zh: `远端进程 ${target} 是你在冲突提示里选择「保留」的实例，不会被停止。`,
        en: `The remote process ${target} is the one you chose to keep alongside; it will not be stopped.`,
      }
    case 'not-launched-by-this-connection':
    case 'not-the-bound-instance':
      return {
        zh: '远端进程不是本连接启动或接管的实例，无法证明归属，因此没有停止它；可以点「重连」。',
        en: 'The remote process is not the instance this connection launched or took over, so its ownership cannot be proven and it was not stopped; use Reconnect.',
      }
    case 'registry-mismatch':
      return {
        zh: '远端 run/web.json 没有命名本连接的进程（或读不到），无法证明归属，因此没有停止它。',
        en: 'The remote run/web.json does not name this connection\u2019s process (or could not be read), so ownership cannot be proven and nothing was stopped.',
      }
    case 'pid-reused':
      return {
        zh: '这个 pid 已被另一个进程复用，不是本连接启动的 DSH；没有停止它。',
        en: 'This pid was reused by another process, not the DSH this connection launched; nothing was stopped.',
      }
    case 'dsh-home-mismatch':
    case 'profile-mismatch':
      return {
        zh: '远端进程的 DSH home / profile 与本连接不一致，没有停止它。',
        en: 'The remote process runs a different DSH home / profile than this connection; nothing was stopped.',
      }
    case 'pid-unknown':
      return {
        zh: '本连接没有记录远端 DSH 的 pid，无法定位要停止的进程。',
        en: 'This connection has no recorded remote DSH pid, so there is no process to stop.',
      }
    default:
      return {
        zh: `无法读取远端进程 ${target} 的身份（${reason}），没有停止它。`,
        en: `The identity of the remote process ${target} could not be proven (${reason}), so nothing was stopped.`,
      }
  }
}

/**
 * Stop the remote DSH this connection manages, then release the link: the tunnel closes,
 * the SSH session is released and the host lands on `disconnected` (settings and credentials
 * kept, no automatic reconnect) so the card offers Reconnect again. `run/web.json` is removed
 * by the stop itself, so the next connect starts a clean instance instead of raising the
 * "a manually started DSH is already running" conflict.
 *
 * Unlike the disconnect action this never kills a pid without an ownership proof: it reuses
 * the restart's `/proc` identity rules and additionally accepts the re-attached pid this
 * connection is bound to (docs/design.md §5.7). Available while connected and in the
 * `remote-unreachable` error state, which keeps the SSH session on purpose.
 *
 * @param ctx - service context.
 * @param runtime - host runtime.
 * @returns the stopped pid (null when already gone).
 */
export async function stopRemoteHost(ctx: ConnectCtx, runtime: HostRuntime): Promise<StopRemoteResult> {
  await ctx.init()
  if (runtime.connectPromise || runtime.linkBusy !== null) {
    throw errors.stopRemoteUnavailable(
      {
        zh: '这台主机正在执行另一个连接动作，请等它结束后再关闭远端 DSH。',
        en: 'This host is busy with another link action; wait for it to finish before stopping the remote DSH.',
      },
      { technical: 'reason=link-busy' },
    )
  }
  const connected = runtime.status === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null
  const recoverable =
    runtime.status === 'error' &&
    runtime.error?.code === 'remote-unreachable' &&
    runtime.ssh?.connected === true &&
    runtime.facts !== null
  if (!connected && !recoverable) throw errors.stopRemoteUnavailable()
  // The `previous` snapshot is what `stop.refused` restores; it is captured before the action
  // writes anything.
  const previous: StopState = {
    status: runtime.status,
    phase: runtime.phase,
    progress: runtime.progress,
    error: runtime.error,
    uiReady: runtime.remote.uiReady,
    localPort: runtime.remote.localPort,
  }
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`).
  // The token is the old `beginLinkWork` one (the rule adopts it), so `isLinkWorkCurrent` keeps
  // the exact late-write semantics.
  const token = (Number(runtime.linkToken) || 0) + 1
  const event = { type: 'stop.requested' as const, token, pid: runtime.remote.pid, port: runtime.remote.port }
  let started: Promise<StopRemoteResult> | null = null
  try {
    await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'script',
      run: (activity, actionToken) => {
        if (activity !== 'stop') return
        started = runStopRemote(ctx, runtime, actionToken)
      },
    })
    return await started
  } catch (error) {
    const view = toErrorView(error)
    const phase = typeof runtime.phase === 'string' ? runtime.phase : previous.phase
    if (isLinkWorkCurrent(runtime, token)) {
      // The rule restores the previous state itself; `unrestorable` is the design's "link went
      // away while the stop was failing" branch, which publishes the coded failure instead.
      const restorable =
        previous.status === 'error' ||
        (runtime.desired === 'connected' && runtime.ssh?.connected === true && runtime.tunnel !== null)
      const refusal = {
        type: 'stop.refused' as const,
        view,
        phase,
        previous: {
          status: previous.status,
          phase: previous.phase,
          progress: previous.progress,
          error: previous.error,
          uiReady: previous.uiReady === true,
          localPort: previous.localPort ?? null,
        },
        ...(restorable ? {} : { unrestorable: true }),
      }
      await dispatch(createRuntimeEffects(ctx), runtime, refusal, scopeFactsFor(ctx, runtime, refusal), {
        caller: 'script',
      })
    }
    throw error
  } finally {
    endLinkWork(runtime, token)
  }
}

async function runStopRemote(ctx: ConnectCtx, runtime: HostRuntime, token: number): Promise<StopRemoteResult> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const pid = Number(runtime.remote.pid ?? 0)
  const port = Number(runtime.remote.port ?? 0)
  log(
    'info',
    `stop remote requested (pid=${isPid(pid) ? pid : 'unknown'}, remote port=${isPid(port) ? port : 'unknown'})`,
  )
  // `stop.requested` already disarmed the heartbeat/reconnect/idle timers and published the
  // `start`/`stopping-remote` card.

  const verdict = await closeAuthorized(ctx, runtime, pid, layout, profile)
  if (!isLinkWorkCurrent(runtime, token)) {
    log('debug', 'stop remote aborted: the link was replaced by a disconnect or reconnect')
    return { ok: true, pid: null }
  }
  if (verdict.ok !== true && verdict.reason !== 'identity-missing') {
    throw errors.stopRemoteUnavailable(describeStopRefusal(verdict.reason, pid), {
      technical: `reason=${verdict.reason} pid=${isPid(pid) ? pid : 'unknown'}`,
    })
  }

  if (verdict.reason === 'identity-missing') {
    // Nothing to signal: the process is already gone. Only its stale record remains, and it
    // must go away or the next connect would try to stop/adopt a dead pid.
    log('info', `stop remote: the bound remote process pid=${pid} is already gone; clearing its run registry`)
    const cleared = await ctx.deps.clearRegistry(runtime.ssh, layout)
    if (cleared?.ok !== true) {
      log('warn', 'stop remote: the stale run registry could not be cleared:', cleared?.output ?? 'no output')
    }
  } else {
    const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid })
    if (stopped?.ok !== true) {
      throw errors.stopRemoteUnavailable(
        {
          zh: '远端 DSH 进程没有报告干净停止；连接保持原样，可以重试或点「重连」。',
          en: 'The remote DSH process did not report a clean stop; the connection is unchanged, so retry or use Reconnect.',
        },
        { technical: String(stopped?.output ?? '').slice(0, 1200) || 'no output' },
      )
    }
    log('info', `stop remote: stopped the managed remote web pid=${pid}`)
    if (runtime.launched instanceof Map) runtime.launched.delete(pid)
  }
  if (!isLinkWorkCurrent(runtime, token)) {
    log('debug', 'stop remote: the link was replaced after the stop; leaving the state to that action')
    return { ok: true, pid: isPid(pid) ? pid : null }
  }
  runtime.bound = null
  // One transition ends the action: `stop.succeeded` is the explicit stop's disconnect (the
  // `stopped:true` form keeps the idle policy from arming a second stop). The informational line
  // today's `disconnectHost` wrote is part of the operator log, so it stays, in its old position.
  ctx.progress.log(runtime, 'info', `disconnect requested (keepAlive=${runtime.entry.keepAlive})`)
  const done = { type: 'stop.succeeded' as const }
  await dispatch(createRuntimeEffects(ctx), runtime, done, scopeFactsFor(ctx, runtime, done), { caller: 'script' })
  runtime.bound = null
  log('info', 'stop remote: the remote DSH is stopped; the host is kept and can be reconnected')
  return { ok: true, pid: isPid(pid) ? pid : null }
}

/**
 * Re-attach to a remote web that restarted on its own (plugin-market update, supervisor,
 * remote reboot): re-read the real pid/port, refresh `run/web.json`, rebuild the tunnel,
 * take the new launch token and verify. The SSH session and the host entry are untouched.
 *
 * @param ctx - service context.
 * @param runtime - host runtime the watchdog decided is unreachable.
 * @param info - why the re-attach was requested.
 * @returns whether the re-attach started.
 */
export async function reattachHost(
  ctx: ConnectCtx,
  runtime: HostRuntime,
  info: ReattachRequest = {},
): Promise<AcceptedResult> {
  if (runtime.status !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) {
    return { accepted: false, reason: 'not-connected' }
  }
  if (runtime.connectPromise || runtime.linkBusy !== null) return { accepted: false, reason: 'busy' }
  // One transition owns `activity`/`epoch`, the `connecting` card and the action start (`run`);
  // the token is the old `beginLinkWork` one so the late-write filter keeps its semantics.
  const token = (Number(runtime.linkToken) || 0) + 1
  const reason = typeof info?.reason === 'string' && info.reason !== '' ? info.reason : 'remote-unreachable'
  const event = { type: 'reattach.requested' as const, token, reason }
  await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
    caller: 'script',
    run: (activity, started) => {
      if (activity !== 'reattach') return
      const work = runReattach(ctx, runtime, info, started)
      runtime.reattachPromise = work
      void work.finally(() => {
        endLinkWork(runtime, started)
        if (runtime.reattachPromise === work) runtime.reattachPromise = null
      })
    },
  })
  return { accepted: true }
}

async function runReattach(ctx: ConnectCtx, runtime: HostRuntime, info: ReattachRequest, token: number): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = layoutForRuntime(runtime)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const fromPort = runtime.remote.port
  const reason = typeof info?.reason === 'string' && info.reason !== '' ? info.reason : 'remote-unreachable'
  let tunnelCreated = false
  try {
    // `reattach.requested` already disarmed the timers and published the `restarting-remote` card.
    log('info', `remote restart suspected: ${reason}; re-reading the remote state`)

    // A restart takes a moment to print its new readiness line: retry before giving up.
    const attempts = Math.max(1, Number(ctx.timers.reattachAttempts) || REMOTE_REATTACH_ATTEMPTS)
    const intervalMs = Math.max(0, Number(ctx.timers.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS) || 0)
    let resolved: ResolvedRemoteWeb | null = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!isLinkWorkCurrent(runtime, token)) return
      resolved = await ctx.deps.resolveRemote(runtime.ssh, layout, { profile })
      if (resolved?.ok === true) break
      log(
        'debug',
        `re-attach: remote state not ready yet (${resolved?.reason ?? 'unreadable'}), attempt ${attempt}/${attempts}`,
      )
      if (attempt < attempts && intervalMs > 0) await sleep(intervalMs)
    }
    if (!isLinkWorkCurrent(runtime, token)) return
    // `resolved?.ok !== true` is the same test as `!resolved || resolved.ok !== true`, and it is
    // the form the compiler can narrow: with `strictNullChecks` off the disjunction's `!resolved`
    // arm widens the branch back to the whole union.
    if (resolved?.ok !== true) {
      const detail =
        resolved?.reason === 'no-token'
          ? {
              zh: '远端 DSH 仍在运行，但它这次重启没有留下可用的 launch token，无法自动重新挂载；请点「重启」或「重连」。',
              en: 'The remote DSH is still running, but its restart left no usable launch token, so it cannot be re-attached; use "Restart" or Reconnect.',
            }
          : {
              zh: `远端 DSH 重启后没有找到可以重新挂载的实例（${resolved?.reason ?? 'unreadable'}）；主机与配置已保留。`,
              en: `No re-attachable remote DSH instance was found after the restart (${
                resolved?.reason ?? 'unreadable'
              }); the host and its settings are kept.`,
            }
      throw errors.remoteUnreachable(detail, {
        technical: `reason=${resolved?.reason ?? 'unknown'} fromPort=${fromPort ?? 'unknown'}`,
      })
    }
    // A takeover needs the new launch token: a real DSH rejects `/?token=` and a cookie-less
    // request, so an empty token can never be treated as success (B4).
    if (typeof resolved.token !== 'string' || resolved.token === '') {
      throw errors.remoteUnreachable(
        {
          zh: '远端 DSH 重启后没有留下可用的 launch token，无法自动重新挂载；请点「重启」或「重连」。',
          en: 'The restarted remote DSH left no usable launch token, so it cannot be re-attached; use "Restart" or Reconnect.',
        },
        { technical: `reason=no-token source=${resolved.source ?? 'unknown'} port=${resolved.port ?? 'unknown'}` },
      )
    }
    const targetVersion = ctx.localVersion()
    const remoteVersion =
      typeof resolved.version === 'string' && resolved.version !== '' ? normalizeVersion(resolved.version) : null
    if (remoteVersion && targetVersion && !versionsEqual(remoteVersion, targetVersion)) {
      // A different DSH under the same ~/.dsh would show a UI that does not match this machine;
      // the user's remedy is the explicit restart, which launches the pinned version.
      throw errors.versionMismatch(targetVersion, remoteVersion)
    }
    if (remoteVersion === null) {
      log(
        'warn',
        're-attach: the running DSH version could not be proven; keeping it unknown, not assuming the local one',
      )
    }
    // The pid that actually listens may differ from the wrapper this connection launched (npx
    // spawns the DSH). Keep the kill right only for the pid we are now attached to.
    if (runtime.launched instanceof Map) {
      for (const pid of [...runtime.launched.keys()]) {
        if (pid !== resolved.pid) runtime.launched.delete(pid)
      }
    }
    log(
      'info',
      `re-attach: found remote web pid=${resolved.pid} port=${resolved.port} (source=${resolved.source}); refreshing the run registry`,
    )
    const record = buildRunRegistryRecord({
      pid: resolved.pid,
      port: resolved.port,
      // Never launder an unproven version into the registry.
      version: remoteVersion ?? '',
      profile,
      dshHome: layout.dshHome,
      origin: 'reattach',
    })
    const written = await ctx.deps.writeRegistry(runtime.ssh, layout, record)
    if (written.ok === true) log('info', `re-attach: run registry refreshed (pid ${record.pid}, port ${record.port})`)
    else log('warn', 're-attach: the run registry could not be refreshed:', written.output)
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('tunnel', 'tunneling')
    await closeTunnel(runtime)
    runtime.token = resolved.token
    runtime.remote = {
      ...runtime.remote,
      version: remoteVersion,
      uiReady: false,
      localPort: null,
      port: resolved.port,
      pid: resolved.pid,
      dshHome: resolved.dshHome ?? layout.dshHome,
      profile: resolved.profile ?? profile,
      startedAt: nowIso(),
    }
    const tunnel = await openTunnelFor(ctx, runtime, resolved.port)
    tunnelCreated = true
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, resolved.port, resolved.token, tunnel.localPort)
    if (!isLinkWorkCurrent(runtime, token)) return
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, resolved.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    // The re-attached instance is now the one this connection is bound to. It stays out of
    // `launched` (a restart must not kill it), but the explicit stop action may end exactly it.
    await rememberBound(ctx, runtime, resolved.pid, layout, profile, 'reattach')
    if (!isLinkWorkCurrent(runtime, token)) return
    recordRestart(runtime, {
      kind: 'remote-reattach',
      fromPort,
      toPort: resolved.port,
      pid: resolved.pid,
      reason,
      source: resolved.source,
    })
    await markConnected(ctx, runtime)
    log(
      'info',
      `re-attached: remote ${runtime.remote.version ?? 'version unknown'} on 127.0.0.1:${
        runtime.tunnel?.localPort ?? tunnel.localPort
      } (remote port ${fromPort} -> ${resolved.port})`,
    )
  } catch (error) {
    if (!isLinkWorkCurrent(runtime, token)) {
      log('debug', 're-attach aborted: the link was replaced by a disconnect or reconnect')
      return
    }
    const view =
      error instanceof LinkCancelled
        ? toErrorView(errors.network(SSH_CLOSED_DETAIL, { technical: 'reason=ssh-closed during re-attach' }))
        : toErrorView(error)
    // The transition owns the error state, the listener release, the heartbeat disarm, the
    // failure lines (`logFailure` reads the phase it is about to clear) and the publication.
    const failure = { type: 'reattach.failed' as const, view }
    await dispatch(createRuntimeEffects(ctx), runtime, failure, scopeFactsFor(ctx, runtime, failure), {
      caller: 'script',
      emit: false,
    })
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action (see runRestart).
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
}

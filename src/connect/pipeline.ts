/**
 * The connect pipeline: SSH -> probe -> managed Node -> plan -> adopt/conflict -> preflight -> start -> tunnel -> verify; the step order is the behavior and every step is injected.
 *
 * This module also owns the two pieces that call *back* into the pipeline — the retry entry
 * (`scheduleConnectRetry`/`retryNow`/`reconnectNow`) and the dial with its close listener
 * (`openTransport`/`watchTransport`) — although design-arch §3.2 files them under `links.ts` and
 * `transport.ts`. They cannot move: the close listener and the failure path both ask the retry
 * policy to re-enter `connectPipeline`, so any other home would import this file and be imported
 * by it (a cycle between `src/connect/*`, which the P2d acceptance forbids). Splitting them out
 * would mean threading a retry callback through `connectPipeline`/`openTransport`, i.e. editing
 * bodies — the "verbatim move" rule wins.
 *
 * The effect owner is `runtime/effects.ts`; the state machine is `runtime/fsm.ts`.
 */
import type { Duplex } from 'node:stream'
import { REMOTE_START_TIMEOUT_MS, SSH_READY_TIMEOUT_MS } from '../constants.js'
import { beginConnectLog } from '../connect-log.js'
import type { Config, HostState, RemoteDeps, Reporter, Store, Transport } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import { disposeSsh, scheduleReconnect } from '../host-lifecycle.js'
import { findKnownHostEntries, parseKnownHosts } from '../known-hosts.js'
import { layoutForRuntime } from '../layout.js'
import type { RemoteLayout } from '../layout.js'
import { applyManagedNodeFacts, managedNodeVersionFromEngine } from '../node-runtime.js'
import type { RemoteFacts } from '../probe.js'
import { requestHostKey } from '../prompts.js'
import type { StartedRemoteWeb } from '../remote-web/start.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import type { SshAuthOptions, SshConnectOptions, SshPort } from '../ssh-port.js'
import { isPid, messageOf, nowIso } from '../util.js'
import { normalizeVersion, versionsEqual } from '../version.js'
import { markConnected } from './attach.js'
import { normalizeConnectFailure } from './failures.js'
import { LinkCancelled, assertStillWanted, assertTransportOpen, linkTaken } from './guards.js'
import type { ConnectLogWriter, PhaseWriter } from './guards.js'
import { resolveForeignConflict } from './launch.js'
import { rememberBound, rememberLaunched } from './ownership.js'
import { captureFingerprint, openTunnelFor, resolveTargetForRuntime, settlePasswordStorage } from './transport.js'
import type { ConnectTarget, DialTarget } from './transport.js'
import { verifyRemoteUi } from './verify.js'

/**
 * The workflow body crosses all six slices (design-arch §1.2's whitelist stops at the six entry
 * points): the steps need Transport, RemoteDeps, Reporter, Config and Store, and the guards need
 * HostState. Written out instead of aliasing `Ctx` so a reader sees *why* it is this wide.
 */
type PipelineCtx = HostState & Config & Transport & RemoteDeps & Reporter & Store

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

/**
 * Start the pipeline in the background and make sure its promise never rejects: a listener
 * or a step outside the pipeline's own error handling must not become an unhandled
 * rejection that Node reports as a process-level failure (L).
 * @param ctx - service context.
 * @param runtime - host runtime.
 */
export function startConnectPromise(ctx: PipelineCtx, runtime: HostRuntime): void {
  const run = connectPipeline(ctx, runtime).catch((error) => {
    ctx.progress.log(runtime, 'debug', 'connect pipeline stopped outside its error path:', messageOf(error))
  })
  runtime.connectPromise = run
  void run.finally(() => {
    if (runtime.connectPromise === run) runtime.connectPromise = null
  })
}

/**
 * Re-enter the pipeline after a dropped link. Lives here rather than in the
 * lifecycle module so `scheduleReconnect` stays a pure timer with a callback.
 *
 * The retry is a `connect.requested` with `retry: true`: it must publish `connecting` and clear
 * the previous failure, but it must **not** reset the retry budget the user's connect set (R5/H2),
 * so the event carries the one difference.
 */
async function reconnectNow(ctx: PipelineCtx, runtime: HostRuntime): Promise<void> {
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
function retryNow(ctx: PipelineCtx, runtime: HostRuntime): void {
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
function watchTransport(ctx: PipelineCtx, runtime: HostRuntime, ssh: SshPort | null): void {
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

/**
 * Open the transport: direct, or through a jump host with a forwarded stream.
 *
 * The jump host and the target are separate security contexts. Each one gets its own
 * options — its own policy, its own pin and its own `onHostKey` role — so a key confirmed
 * for one can never be checked against, or written into, the other (B1).
 */
async function openTransport(ctx: PipelineCtx, runtime: HostRuntime, target: ConnectTarget): Promise<void> {
  const settings = ctx.settings()
  const auth = (): SshAuthOptions => ({
    type: runtime.entry.auth?.type ?? 'key',
    keyPath: runtime.entry.auth?.keyPath ?? null,
    password: runtime.password ?? null,
  })
  const buildOptions = (resolved: DialTarget, role: 'target' | 'jump', sock?: Duplex): SshConnectOptions => {
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

async function connectPipeline(ctx: PipelineCtx, runtime: HostRuntime): Promise<void> {
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
function scheduleConnectRetry(ctx: PipelineCtx, runtime: HostRuntime): void {
  if (ctx.state.disposed === true || runtime.desired !== 'connected') return
  if (!runtime.entry.autoReconnect || !ctx.settings().autoReconnect.enabled) return
  scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime))
}

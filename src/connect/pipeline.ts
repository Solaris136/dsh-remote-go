/** The connect pipeline: SSH -> probe -> managed Node -> plan -> adopt/conflict -> preflight -> start -> tunnel -> verify; the step order is the behavior and every step is injected. It also owns the two pieces that call back into the pipeline — the retry entry (`scheduleConnectRetry`/`retryNow`/`reconnectNow`) and the dial with its close listener (`openTransport`/`watchTransport`) — because moving them would close an import cycle `pipeline -> connect/* -> pipeline`. */
import type { Duplex } from 'node:stream'
import { REMOTE_START_TIMEOUT_MS, SSH_READY_TIMEOUT_MS } from '../constants.js'
import { beginConnectLog } from '../connect-log.js'
import type { ConnectCtx } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import { disposeSsh, scheduleReconnect } from '../host-lifecycle.js'
import { layoutForRuntime, type RemoteLayout } from '../layout.js'
import { applyManagedNodeFacts, managedNodeVersionFromEngine } from '../node-runtime.js'
import type { RemoteFacts } from '../probe.js'
import { requestHostKey } from '../prompts.js'
import { registryNamesInstance } from '../remote-web/registry.js'
import type { AdoptedRemoteWeb } from '../remote-web/resolve.js'
import type { StartedRemoteWeb } from '../remote-web/start.js'
import { dispatch, scopeFactsFor } from '../runtime/dispatch.js'
import { createRuntimeEffects } from '../runtime/effects.js'
import type { SshAuthOptions, SshConnectOptions, SshPort } from '../ssh-port.js'
import { messageOf, nowIso } from '../util.js'
import { normalizeVersion, versionsEqual } from '../version.js'
import { markConnected } from './attach.js'
import { normalizeConnectFailure } from './failures.js'
import { LinkCancelled, assertStillWanted, assertTransportOpen, linkTaken } from './guards.js'
import type { ConnectLogWriter, PhaseWriter } from './guards.js'
import { PATCHED_CARRIER_NOTE, resolveForeignConflict } from './launch.js'
import { rememberBound, rememberLaunched } from './ownership.js'
import {
  captureFingerprint,
  knownFingerprintsFor,
  openTunnelFor,
  resolveTargetForRuntime,
  settlePasswordStorage,
  type ConnectTarget,
  type DialTarget,
} from './transport.js'
import { verifyRemoteUi } from './verify.js'

/** The remote web the pipeline is about to publish: one this connection started, or one adopted from a previous run.
 * The two records differ (`startedAt`/`logPath` are pipeline-only, `browserCarrier` only on a launch), so this is the
 * view both are read through — required what every reader needs, the rest derived from the records themselves. */
type WebInfo = Pick<StartedRemoteWeb, 'pid' | 'port' | 'token' | 'logPath' | 'startedAt' | 'rawLine'> & {
  browserCarrier?: StartedRemoteWeb['browserCarrier']
} & Partial<AdoptedRemoteWeb>

/** Start the pipeline in the background and keep its promise off the rejection path, so a listener or a step outside its error handling cannot become an unhandled rejection. */
export function startConnectPromise(ctx: ConnectCtx, runtime: HostRuntime): void {
  const run = connectPipeline(ctx, runtime).catch((error) => {
    ctx.progress.log(runtime, 'debug', 'connect pipeline stopped outside its error path:', messageOf(error))
  })
  runtime.connectPromise = run
  void run.finally(() => {
    if (runtime.connectPromise === run) runtime.connectPromise = null
  })
}

/** Re-enter the pipeline after a dropped link, as a `connect.requested` with `retry: true`: it publishes `connecting` and clears the previous failure but must not reset the retry budget the user's connect set. */
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

/** A timer callback that starts a retry: report a throw instead of leaving it unhandled. */
function retryNow(ctx: ConnectCtx, runtime: HostRuntime): void {
  void reconnectNow(ctx, runtime).catch((error) => {
    ctx.progress.log(runtime, 'warn', 'the automatic retry could not start:', messageOf(error))
  })
}

/** Watch one transport for its close; attached before `connect()` so a drop while a host-key prompt is parked resolves that prompt instead of stalling the pipeline. */
function watchTransport(ctx: ConnectCtx, runtime: HostRuntime, ssh: SshPort | null): void {
  if (!ssh || typeof ssh.on !== 'function') return
  ssh.on('close', () => {
    // A transport this runtime no longer dials (replaced, or disposed before a new attempt) is not a lost link.
    if (runtime.ssh !== ssh && runtime.jumpSsh !== ssh) return
    if (runtime.closing || runtime.desired !== 'connected') return
    const event = { type: 'transport.closed' as const, transport: ssh }
    void dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'callback',
    }).then((result) => {
      // The rule only says "a retry makes sense"; `scheduleReconnect` owns the delay, the budget and the switch.
      const wantsRetry =
        result.ok && result.effects.some((effect) => effect.type === 'arm' && effect.timer === 'reconnect')
      if (wantsRetry) scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime))
    })
  })
}

/** The dial: direct, or through a jump host with a forwarded stream. The two are separate security contexts, each with its own policy, pin and `onHostKey` role, so a key confirmed for one can never be checked against, or written into, the other. It reads only Config/Transport/Reporter/Store itself but hands `ctx` to `watchTransport`, whose close listener re-enters the pipeline, so the parameter cannot be narrowed. */
async function openTransport(ctx: ConnectCtx, runtime: HostRuntime, target: ConnectTarget): Promise<void> {
  const settings = ctx.settings()
  const auth = (): SshAuthOptions => ({
    type: runtime.entry.auth?.type ?? 'key',
    keyPath: runtime.entry.auth?.keyPath ?? null,
    password: runtime.password ?? null,
  })
  const buildOptions = (resolved: DialTarget, role: 'target' | 'jump', sock?: Duplex): SshConnectOptions => {
    const isJump = role === 'jump'
    const resolvedPort = resolved.port ?? 22
    const hostKeyPolicy = isJump ? settings.hostKeyPolicy : (runtime.entry.hostKeyPolicy ?? settings.hostKeyPolicy)
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
  const jumpMaterial = await ctx.deps.loadSshMaterial({ home: ctx.userHome() })
  const jumpTarget = {
    ...target.jumpHost,
    username: target.jumpHost.user ?? target.username,
    knownFingerprints: knownFingerprintsFor(jumpMaterial, target.jumpHost.host, target.jumpHost.port ?? 22),
  }
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
  runtime.fingerprint = null
  ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.host, via: target.jumpHost.host })
  const stream = await runtime.jumpSsh.forwardOut(target.host, target.port ?? 22)
  runtime.ssh = ctx.deps.sshFactory(buildOptions(target, 'target', stream))
  watchTransport(ctx, runtime, runtime.ssh)
  captureFingerprint(ctx, runtime, await runtime.ssh.connect())
}

async function connectPipeline(ctx: ConnectCtx, runtime: HostRuntime): Promise<void> {
  const log: ConnectLogWriter = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase: PhaseWriter = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  // Guards after every await: the link must still be wanted and the transport open, so a late write cannot revive it.
  const gate = () => {
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
  }
  // Every attempt entered through `connect.requested`, which owns `closing`, `transportLost`, the disarms and the card.
  runtime.alongsidePids = []
  runtime.launched = new Map()
  runtime.bound = null
  runtime.tunnelRepairFailures = 0
  runtime.nextTunnelRepairAt = 0
  let remoteStarted = false
  let layout: RemoteLayout | null = null
  let transportUp = false
  try {
    const target = await resolveTargetForRuntime(ctx, runtime)
    assertStillWanted(ctx, runtime)
    const { host: targetHost, port: targetPort, username } = target
    const viaJump = target.jumpHost ? ` via ${target.jumpHost.host}` : ''
    log('debug', `target resolved: ${username ?? '(default)'}@${targetHost}:${targetPort}${viaJump}`)
    if (runtime.entry.auth?.type === 'password' && !runtime.password && ctx.secrets) {
      const remembered = await ctx.secrets.get(runtime.id)
      if (remembered) {
        runtime.password = remembered
        runtime.passwordSaved = true
      }
      assertStillWanted(ctx, runtime)
    }
    phase('ssh', 'ssh-connecting', { host: runtime.entry.name })
    // An idle host keeps its SSH session for a fast resume; this attempt replaces it, so release it, do not leak it.
    if (runtime.ssh !== null || runtime.jumpSsh !== null) {
      log('debug', 'releasing the transport kept by the idle policy before dialling again')
      await disposeSsh(runtime)
      assertStillWanted(ctx, runtime)
    }
    await openTransport(ctx, runtime, target)
    gate()
    transportUp = true
    const fingerprint = runtime.fingerprint?.sha256 ?? 'unknown'
    log(
      'info',
      `SSH connected to ${targetHost}:${targetPort} as ${username ?? '(default)'} (fingerprint ${fingerprint})`,
    )
    // SSH accepted the credential: prove the password now, before a later bootstrap failure makes the user retype it.
    await settlePasswordStorage(ctx, runtime, log)
    assertStillWanted(ctx, runtime)
    phase('probe', 'probing')
    let facts = await ctx.deps.probe(runtime.ssh)
    gate()
    const freeGb = Math.round(Number(facts.diskFreeKb ?? 0) / 1_048_576)
    log(
      'debug',
      `probe: ${facts.os}/${facts.arch} · ${String(facts.osName ?? 'unknown OS')} · node ${
        facts.nodeVersion ?? 'not found'
      } · ${freeGb} GB free`,
    )
    const profile = ctx.settings().bootstrap.profile
    const managedVersion = managedNodeVersionFromEngine(ctx.engineNodeRange())
    // A probe that did not report $HOME cannot address the remote layout: `layoutForRuntime` throws.
    const nodeLayout = layoutForRuntime({ facts })
    log('info', `managed Node: expecting v${managedVersion} in ${nodeLayout.nodeDir}`)
    const managed = await ctx.deps.ensureNode(runtime.ssh, {
      facts,
      layout: nodeLayout,
      version: managedVersion,
      onProgress: (event) => ctx.progress.nodeProgress(runtime, event),
    })
    gate()
    // The probe reported every field, so the merged object is a full `RemoteFacts`.
    facts = applyManagedNodeFacts(facts, managed) as RemoteFacts
    const { version: nodeVersion, installed, nodeBinDir } = managed
    log('info', `managed Node ${nodeVersion}${installed ? ' installed' : ' reused'} at ${nodeBinDir}`)
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
    // Adopt an instance left by a previous local process before the npx preflight: adoption must not need the registry.
    let webInfo: WebInfo | null = null
    try {
      const adopted = await ctx.deps.adopt(runtime.ssh, layout, { profile })
      const adoptedVersion = adopted?.version ? normalizeVersion(adopted.version) : null
      const mismatch = `running remote web version ${adoptedVersion} != ${targetVersion}`
      if (adopted && (!adoptedVersion || versionsEqual(adoptedVersion, targetVersion))) {
        webInfo = { ...adopted, logPath: layout.logFile, startedAt: nowIso(), rawLine: '' }
        log('info', `adopted running remote web pid=${adopted.pid} port=${adopted.port}`)
        // Only a launch record proves the process is ours to stop; a re-attached one is merely hosted.
        if (adopted.origin !== 'reattach') await rememberLaunched(ctx, runtime, adopted.pid, layout, profile)
        else await rememberBound(ctx, runtime, adopted.pid, layout, profile, 'reattach')
      } else if (adopted && adopted.origin !== 'reattach') {
        log('info', `${mismatch}; stopping it and starting a matching instance`)
        try {
          // The old process owns the same `~/.dsh` profile: leaving it next to the new one would share session files.
          await ctx.deps.stopWeb(runtime.ssh, layout, { pid: adopted.pid })
        } catch (error) {
          log('warn', 'could not stop the stale remote web:', messageOf(error))
        }
      } else if (adopted) {
        log('warn', `${mismatch}, but it was only re-attached; leaving it running`)
      } else {
        log('debug', 'adopt: no running remote web to reuse')
      }
    } catch (error) {
      log('debug', 'adopt check failed:', messageOf(error))
    }
    gate()
    if (!webInfo) {
      // A row we refused to adopt still names a process on this ~/.dsh profile: two clients must not write the same session files.
      const leftover = await ctx.deps.readRegistry(runtime.ssh, layout)
      assertStillWanted(ctx, runtime)
      const leftoverPid = Number(leftover?.pid ?? 0)
      if (leftover?.origin === 'reattach') {
        log('info', `leaving a re-attached remote web instance alone (pid ${leftoverPid || 'unknown'})`)
      } else if (registryNamesInstance(leftover, layout, profile, leftoverPid)) {
        try {
          await ctx.deps.stopWeb(runtime.ssh, layout, { pid: leftoverPid })
          log('info', `stopped a non-adoptable remote web instance pid=${leftoverPid}`)
        } catch (error) {
          log('warn', 'could not stop the non-adoptable remote web:', messageOf(error))
        }
      }
      await resolveForeignConflict(ctx, runtime, layout, profile)
      gate()
      phase('bootstrap', 'bootstrapping', { level: plan.level })
      // Resolve the exact package in the foreground first: a cold npx download belongs in the connect error, not in a
      // detached process that only leaves a log behind.
      log('info', `npx preflight: resolving @deepseek-ai/dsh@${plan.start.targetVersion}`)
      const onStdout = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion)
      const onStderr = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion)
      await ctx.deps.preflight(runtime.ssh, plan, { onStdout, onStderr })
      gate()
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
    gate()
    if (webInfo.browserCarrier === 'patched') log('info', PATCHED_CARRIER_NOTE)
    remoteStarted = true
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
    gate()
    // The remote UI is reachable both ways (desktop guest and same-origin proxy): the exchange proves the launch token.
    runtime.remote.uiReady = true
    await ctx.store.patchHost(runtime.id, { lastOpenedAt: nowIso() })
    gate()
    // The store write is an await: a disconnect may land meanwhile, and a late write must not resurrect the link.
    runtime.entry = ctx.store.getHost(runtime.id) ?? runtime.entry
    if (ctx.settings().saveTokens) {
      await ctx.store.saveToken(runtime.id, webInfo.token)
      assertStillWanted(ctx, runtime)
    }
    gate()
    // Last gate before publishing: never report a host the user just removed or a tunnel this pipeline no longer owns.
    await markConnected(ctx, runtime)
    const localPort = runtime.tunnel?.localPort ?? runtime.remote.localPort ?? '?'
    log('info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${localPort}`)
  } catch (error) {
    // Phase is cleared with the status; capture it first so the log says where it stopped.
    const failedPhase = runtime.phase
    // The link was up earlier in this attempt and is gone now: it dropped, which is what the retry policy is for.
    const droppedTransport = runtime.transportLost === true || (transportUp === true && runtime.ssh?.connected !== true)
    // The transition owns the state, the teardown and the failure lines; the caller keeps only its own
    // publication point.
    const cancelled = error instanceof LinkCancelled || linkTaken(ctx, runtime)
    // The user's "no" is read before the failure transition clears the flag: a refused prompt is final.
    const saidNo = runtime.connectCancelled === true
    const event = cancelled
      ? { type: 'connect.cancelled' as const }
      : { type: 'connect.failed' as const, view: normalizeConnectFailure(runtime, error), phase: failedPhase }
    await dispatch(createRuntimeEffects(ctx), runtime, event, scopeFactsFor(ctx, runtime, event), {
      caller: 'script',
      emit: false,
      teardown: {
        stopRemote: remoteStarted && runtime.entry.keepAlive === 'stop',
        keepRemote: remoteStarted && runtime.entry.keepAlive !== 'stop',
      },
    })
    if (cancelled) log('info', 'connect cancelled by disconnect')
    // One place decides whether a failed attempt is retried, and the budget lives in `scheduleReconnect`.
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

/** Arm the next automatic attempt; `scheduleReconnect` owns the settings gate and the budget, so a spent budget is reported once. Exported for the one-shot actions whose failure leaves no usable transport (`reattach.ts`): they must hand the link back to the same retry loop instead of parking at an error card. */
export function scheduleConnectRetry(ctx: ConnectCtx, runtime: HostRuntime): void {
  if (ctx.state.disposed === true || runtime.desired !== 'connected') return
  if (!runtime.entry.autoReconnect || !ctx.settings().autoReconnect.enabled) return
  scheduleReconnect(ctx, runtime, () => retryNow(ctx, runtime))
}

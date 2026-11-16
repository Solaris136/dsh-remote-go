/**
 * The connect pipeline: SSH -> probe -> managed Node -> plan -> adopt/conflict -> preflight -> start -> tunnel -> verify; the step order is the behavior and every step is injected.
 */
import {
  REMOTE_REATTACH_ATTEMPTS,
  REMOTE_REATTACH_INTERVAL_MS,
  REMOTE_START_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
  TUNNEL_PROBE_TIMEOUT_MS,
} from './constants.js'
import { beginConnectLog } from './connect-log.js'
import { errors, toErrorView } from './errors.js'
import { runtimeOf } from './host-registry.js'
import {
  beginLinkWork,
  cancelIdleStop,
  cancelLinkWork,
  cancelReconnect,
  closeTunnel,
  disconnectHost,
  disposeSsh,
  endLinkWork,
  isLinkWorkCurrent,
  scheduleReconnect,
  startRemoteHeartbeat,
  stopRemoteHeartbeat,
  teardownRuntime,
} from './host-lifecycle.js'
import { findKnownHostEntries, parseKnownHosts } from './known-hosts.js'
import { remoteLayout } from './layout.js'
import { applyManagedNodeFacts, managedNodeVersionFromEngine } from './node-runtime.js'
import { askConflict, requestHostKey } from './prompts.js'
import { buildRunRegistryRecord, commandMatchesProfile } from './remote-web.js'
import { resolveDestination } from './ssh-config.js'
import { isPid, messageOf, nowIso, sleep } from './util.js'
import { normalizeVersion, versionsEqual } from './version.js'

function describeTarget(entry) {
  const user = entry.username ? `${entry.username}@` : ''
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  return `${user}${entry.address || '?'}${port}`
}

/**
 * Accept a connect request: apply the one-time inputs, stop any pending retry,
 * and start the pipeline in the background. Progress travels on `state`.
 */
export async function startConnect(ctx, id, options = {}) {
  await ctx.init()
  const runtime = runtimeOf(ctx, id)
  if (runtime.connectPromise) return { accepted: false, reason: 'already-connecting' }
  if (runtime.linkBusy !== null) return { accepted: false, reason: 'already-restarting' }
  if (runtime.status === 'connected' && runtime.ssh?.connected) return { accepted: false, reason: 'already-connected' }
  // A new connect owns the link from here on: any pending one-shot action is stale.
  cancelLinkWork(runtime)
  stopRemoteHeartbeat(runtime)
  runtime.alongsidePids = []
  runtime.password = options.password ?? runtime.password
  // A password the user asked to remember is written to the credential store the
  // moment it is known, so a failed first attempt still leaves it available.
  if (options.rememberPassword === true && typeof runtime.password === 'string' && runtime.password !== '') {
    runtime.savePassword = true
  }
  runtime.desired = 'connected'
  cancelReconnect(runtime)
  // This connection starts its own log: the previous attempt's lines are gone before the
  // first line of this one, so the panel and a copied log only ever show the live attempt.
  beginConnectLog(runtime)
  ctx.progress.log(
    runtime,
    'info',
    `connect: ${describeTarget(runtime.entry)} (auth=${runtime.entry.auth?.type ?? 'key'}${
      runtime.entry.jumpHost ? `, jump=${runtime.entry.jumpHost}` : ''
    })`,
  )
  runtime.connectPromise = connectPipeline(ctx, runtime).finally(() => {
    runtime.connectPromise = null
  })
  return { accepted: true }
}

/** Drop the current link and connect again from scratch (the "Reconnect" button). */
export async function reconnectHost(ctx, runtime) {
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
 */
async function reconnectNow(ctx, runtime) {
  if (ctx.state.disposed || runtime.desired !== 'connected') return
  await disposeSsh(runtime)
  // A dropped link's retry is a new connection too: start from a clean log.
  beginConnectLog(runtime)
  runtime.connectPromise = connectPipeline(ctx, runtime).finally(() => {
    runtime.connectPromise = null
  })
}

function attachDisconnectHandler(ctx, runtime) {
  const ssh = runtime.ssh
  if (!ssh) return
  ssh.on('close', () => {
    if (runtime.closing || runtime.desired !== 'connected') return
    // A one-shot link action rides the same transport: losing it is the same event as a
    // dropped connection, and the action that was in flight must not write state any more.
    const active = runtime.status === 'connected' || runtime.linkBusy !== null
    if (!active) return
    cancelLinkWork(runtime)
    stopRemoteHeartbeat(runtime)
    runtime.status = 'disconnected'
    runtime.phase = null
    runtime.remote.uiReady = false
    runtime.remote.localPort = null
    runtime.progress = { code: 'reconnecting', params: { attempt: runtime.reconnectAttempts + 1 } }
    ctx.emitState()
    void closeTunnel(runtime)
    scheduleReconnect(ctx, runtime, () => void reconnectNow(ctx, runtime))
  })
}

/** Resolve the SSH destination from the entry + local ssh config, before dialling. */
async function resolveTargetForRuntime(ctx, runtime) {
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

/** Open the transport: direct, or through a jump host with a forwarded stream. */
async function openTransport(ctx, runtime, target) {
  const settings = ctx.settings()
  const buildOptions = (resolved, sock) => ({
    host: resolved.host,
    port: resolved.port ?? 22,
    username: resolved.username ?? resolved.user ?? null,
    // The key path expands against the *user* home (`~/.ssh/...`), never against
    // DSH_HOME, so the SSH layer needs to know which one that is.
    home: ctx.userHome(),
    auth: {
      type: runtime.entry.auth?.type ?? 'key',
      keyPath: runtime.entry.auth?.keyPath ?? null,
      password: runtime.password ?? null,
    },
    identityFiles: resolved.identityFiles ?? [],
    hostKeyPolicy: runtime.entry.hostKeyPolicy ?? settings.hostKeyPolicy,
    pinnedFingerprint: runtime.entry.pinnedFingerprint ?? null,
    knownHostFingerprints: resolved.knownFingerprints ?? [],
    acceptUnknownHostKey: false,
    readyTimeoutMs: settings.connectTimeoutSec * 1000 || SSH_READY_TIMEOUT_MS,
    ...(sock ? { sock } : {}),
    onHostKey: (info) => requestHostKey(ctx, runtime, info),
  })
  if (!target.jumpHost) {
    runtime.ssh = ctx.deps.sshFactory(buildOptions(target))
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
  runtime.jumpSsh = ctx.deps.sshFactory(buildOptions(jumpTarget))
  await runtime.jumpSsh.connect()
  ctx.progress.phase(runtime, 'ssh', 'ssh-connecting', { host: target.host, via: target.jumpHost.host })
  const stream = await runtime.jumpSsh.forwardOut(target.host, target.port ?? 22)
  runtime.ssh = ctx.deps.sshFactory(buildOptions(target, stream))
  captureFingerprint(ctx, runtime, await runtime.ssh.connect())
}

/** Remember the session fingerprint so the host card shows it even without a pin. */
function captureFingerprint(ctx, runtime, info) {
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
 */
async function resolveForeignConflict(ctx, runtime, layout, profile, options = {}) {
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
  if (found.ok !== true) {
    ctx.progress.log(runtime, 'debug', 'foreign DSH: scan failed:', found.reason ?? found.technical ?? 'unknown')
    return
  }
  if (found.processes.length === 0) return
  const pidList = found.processes.map((entry) => `pid ${entry.pid}`).join(', ')
  ctx.progress.log(
    runtime,
    'warn',
    `foreign DSH on the remote: ${found.processes.length} process(es) sharing this ~/.dsh (${pidList})`,
  )

  const decision = await askConflict(ctx, runtime, found.processes)
  if (decision.action === 'cancel') throw errors.remoteDshRunning()
  if (decision.action === 'alongside') {
    runtime.alongsidePids = found.processes.map((entry) => entry.pid).filter((pid) => isPid(pid))
    runtime.warning = {
      zh: '远端已有手工启动的 DSH；已按你的选择并存运行，两者共享 ~/.dsh，请避免同时操作同一会话。',
      en: 'A manually started DSH is already running; it was kept as you chose. Both share ~/.dsh, so avoid editing the same session in both.',
    }
    return
  }
  const stopped = await ctx.deps.stopForeign(runtime.ssh, found.processes)
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
  ctx.progress.log(runtime, 'info', `stopped ${found.processes.length} manual remote DSH process(es)`)
}

/** Open the loopback tunnel for one remote port; tunnel-level failures feed the liveness confirmation. */
async function openTunnelFor(ctx, runtime, remotePort) {
  // Never hand the tunnel factory a missing transport: a listener created with no SSH channel
  // would crash the host process on the first connection (see tunnel.js's own guard).
  if (runtime.ssh?.connected !== true) {
    throw errors.internal(new Error('the SSH transport is gone before the tunnel could be opened'))
  }
  if (!isPid(remotePort) || remotePort > 65535) {
    throw errors.internal(new Error(`invalid remote port for the tunnel: ${remotePort}`))
  }
  const onError = () => ctx.noteRemoteUnreachable?.(runtime, 'tunnel')
  runtime.tunnel = await ctx.deps.tunnelFactory({ ssh: runtime.ssh, remotePort, onError })
  runtime.remote.localPort = runtime.tunnel.localPort
  ctx.progress.log(runtime, 'info', `tunnel open: 127.0.0.1:${runtime.tunnel.localPort} -> 127.0.0.1:${remotePort}`)
  return runtime.tunnel
}

/**
 * Record a pid this connection is allowed to stop later: it must have been launched by the
 * plugin's own start script (or adopted from a `launch` registry record) and its `/proc`
 * identity must show this DSH home and profile. Anything that fails this check is still
 * hosted and displayed, but never signalled.
 */
async function rememberLaunched(ctx, runtime, pid, layout, profile) {
  if (!isPid(pid)) return
  if (!(runtime.launched instanceof Map)) runtime.launched = new Map()
  const identity = await ctx.deps.processIdentity(runtime.ssh, pid)
  if (identity.ok !== true) {
    ctx.progress.log(
      runtime,
      'debug',
      `launch: pid ${pid} identity unreadable (${identity.reason}); it will not be stopped`,
    )
    return
  }
  if (identity.dshHome !== '' && identity.dshHome !== layout.dshHome) {
    ctx.progress.log(runtime, 'debug', `launch: pid ${pid} runs with another DSH_HOME; it will not be stopped`)
    return
  }
  if (!commandMatchesProfile(identity.command, profile)) {
    ctx.progress.log(runtime, 'debug', `launch: pid ${pid} does not run profile ${profile}; it will not be stopped`)
    return
  }
  runtime.launched.set(pid, {
    startTime: identity.startTime,
    command: identity.command,
    dshHome: identity.dshHome,
  })
}

/**
 * The only gate that authorizes a kill. All three must hold: the registry names the pid,
 * this connection launched it, and `/proc` still proves the same process (kernel start time)
 * with the same home and profile. A reused pid, an adopted-only pid, or a process kept
 * alongside therefore never gets stopped silently.
 */
async function killAuthorized(ctx, runtime, pid, layout, profile) {
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
 * proxied requests fail: the tunnel, not the remote, is what broke. Single-flight per host.
 * The launch token and the carrier URL stay valid, so no re-navigation is needed.
 *
 * @param {object} ctx - service context.
 * @param {object} runtime - connected host runtime.
 * @returns {Promise<{ ok: boolean, reason?: string }>} whether the listener was rebuilt.
 */
export async function repairTunnel(ctx, runtime) {
  if (
    ctx.state.disposed === true ||
    runtime.status !== 'connected' ||
    runtime.linkBusy !== null ||
    runtime.tunnel === null
  ) {
    return { ok: false, reason: 'not-watchable' }
  }
  if (runtime.ssh?.connected !== true) return { ok: false, reason: 'no-transport' }
  if (runtime.tunnelRepair) return runtime.tunnelRepair
  const port = runtime.remote.port
  let work = null
  work = (async () => {
    await closeTunnel(runtime)
    await openTunnelFor(ctx, runtime, port)
    ctx.progress.log(runtime, 'info', `tunnel rebuilt after a failed request (remote port ${port})`)
    ctx.emitState()
    return { ok: true }
  })()
    .catch((error) => {
      ctx.progress.log(runtime, 'warn', 'tunnel rebuild failed:', messageOf(error))
      return { ok: false, reason: 'rebuild-failed' }
    })
    .finally(() => {
      if (runtime.tunnelRepair === work) runtime.tunnelRepair = null
    })
  runtime.tunnelRepair = work
  return work
}

/** Prove the remote UI answers through the new tunnel and exchange this launch's token. */
async function verifyRemoteUi(ctx, runtime, port, token) {
  ctx.progress.log(runtime, 'debug', `verifying the remote UI on 127.0.0.1:${port}`)
  const ui = await ctx.deps.waitUi(runtime.ssh, port, { attempts: 20, intervalMs: 500 })
  if (!ui.ok) {
    throw errors.remoteUiUnreachable({
      zh: `远端 DSH 的本地 127.0.0.1:${port} 没有响应（HTTP ${ui.status ?? '无'}）。`,
      en: `The remote DSH on 127.0.0.1:${port} did not respond (HTTP ${ui.status ?? 'none'}).`,
    })
  }
  ctx.progress.log(runtime, 'debug', `remote UI answered HTTP ${ui.status}; exchanging the launch token`)
  const exchange = await ctx.deps.exchange(runtime.tunnel.localPort, token, {
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

/** Publish the connected state and start watching the remote for its own restarts. */
function markConnected(ctx, runtime) {
  runtime.status = 'connected'
  runtime.phase = 'ready'
  runtime.progress = { code: 'ready' }
  runtime.error = null
  runtime.remote.uiReady = true
  // Every attach invalidates the previous launch URL / cookie: the Client re-navigates its carrier.
  runtime.remote.viewRev = (Number(runtime.remote.viewRev) || 0) + 1
  startRemoteHeartbeat(ctx, runtime)
  ctx.emitState()
}

/** Bounded diagnostics trail of restarts and re-attached ports (never sent to the client). */
function recordRestart(runtime, entry) {
  const history = Array.isArray(runtime.restarts) ? runtime.restarts : []
  history.push({ at: nowIso(), ...entry })
  runtime.restarts = history.slice(-10)
}

async function connectPipeline(ctx, runtime) {
  const log = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  runtime.closing = false
  runtime.reconnectAttempts = 0
  runtime.alongsidePids = []
  // Kill rights belong to this connection: a fresh connect starts with no launched pids.
  runtime.launched = new Map()
  stopRemoteHeartbeat(runtime)
  ctx.progress.set(runtime, { status: 'connecting', error: null, warning: null })
  let remoteStarted = false
  try {
    const target = await resolveTargetForRuntime(ctx, runtime)
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
    }
    phase('ssh', 'ssh-connecting', { host: runtime.entry.name })
    await openTransport(ctx, runtime, target)
    log(
      'info',
      `SSH connected to ${target.host}:${target.port} as ${target.username ?? '(default)'} (fingerprint ${
        runtime.fingerprint?.sha256 ?? 'unknown'
      })`,
    )

    phase('probe', 'probing')
    let facts = await ctx.deps.probe(runtime.ssh)
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
    const nodeLayout = remoteLayout(facts.home)
    log('info', `managed Node: expecting v${managedVersion} in ${nodeLayout.nodeDir}`)
    const managed = await ctx.deps.ensureNode(runtime.ssh, {
      facts,
      layout: nodeLayout,
      version: managedVersion,
      onProgress: (event) => ctx.progress.nodeProgress(runtime, event),
    })
    facts = applyManagedNodeFacts(facts, managed)
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
    const layout = remoteLayout(runtime.facts?.home ?? null)
    let webInfo = null
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
        // re-attached record is hosted, not owned (B1).
        if (adopted.origin !== 'reattach') await rememberLaunched(ctx, runtime, adopted.pid, layout, profile)
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
    if (!webInfo) {
      // The registry row we refused to adopt (stale launch marker, unresponsive
      // HTTP, ...) still names a process on this ~/.dsh profile. Starting a second
      // one would let two clients write the same session files. A record written by a
      // re-attach names a process this plugin did not launch, so it is never stopped here.
      const leftover = await ctx.deps.readRegistry(runtime.ssh, layout)
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
      phase('bootstrap', 'bootstrapping', { level: plan.level })
      // Resolve the exact package in the foreground first: a cold npx download
      // belongs in the connect error, not in a detached process that only leaves a
      // log behind. This also warms the cache for the real start below.
      log('info', `npx preflight: resolving @deepseek-ai/dsh@${plan.start.targetVersion}`)
      const onStdout = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion)
      const onStderr = ctx.progress.bootstrapReporter(runtime, plan.start.targetVersion)
      await ctx.deps.preflight(runtime.ssh, plan, { onStdout, onStderr })
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
    await openTunnelFor(ctx, runtime, webInfo.port)

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token)
    // The remote UI is reachable both ways: the desktop half hands the loopback origin to a
    // Chromium guest, and the browser half frames it through the same-origin proxy (which strips
    // any X-Frame-Options). Either way this exchange proves the launch token works.
    runtime.remote.uiReady = true
    await ctx.store.patchHost(runtime.id, { lastOpenedAt: nowIso() })
    runtime.entry = ctx.store.getHost(runtime.id) ?? runtime.entry
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, webInfo.token)
    // Remember the password now that it is proven, if the user asked for that.
    if (runtime.savePassword === true && typeof runtime.password === 'string' && ctx.secrets) {
      runtime.passwordSaved = await ctx.secrets.set(runtime.id, runtime.password)
    }
    ctx.state.activeHostId = runtime.id
    attachDisconnectHandler(ctx, runtime)
    markConnected(ctx, runtime)
    log('info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${runtime.tunnel.localPort}`)
  } catch (error) {
    const view = toErrorView(error)
    // Phase is cleared with the status; capture it first so the log says where it stopped.
    const failedPhase = runtime.phase
    if (runtime.desired !== 'connected') {
      // A user-initiated disconnect/teardown resolved a pending prompt (or closed
      // the window) while the pipeline was in flight: this is not a failure.
      runtime.error = null
      runtime.status = 'disconnected'
      runtime.phase = null
      runtime.progress = null
      log('info', 'connect cancelled by disconnect')
    } else {
      runtime.error = view
      runtime.status = 'error'
      runtime.phase = null
      runtime.progress = null
      // The log has to explain the failure on its own: every line the card shows, plus the
      // redacted technical detail (and the remote log tail for a failed remote start).
      ctx.progress.logFailure(runtime, view, { phase: failedPhase })
    }
    runtime.remote.uiReady = false
    runtime.remote.localPort = null
    await teardownRuntime(ctx, runtime, {
      stopRemote: remoteStarted && runtime.entry.keepAlive === 'stop',
      keepRemote: remoteStarted && runtime.entry.keepAlive !== 'stop',
    })
    ctx.emitState()
  } finally {
    runtime.connectPromise = null
  }
}

async function readRegistryQuietly(ctx, runtime, layout) {
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
function planForRuntime(ctx, runtime, profile) {
  const facts = runtime.facts
  const targetVersion = ctx.localVersion()
  if (!facts || !targetVersion) {
    throw errors.internal(new Error('the connected host has no recorded probe facts or local version'))
  }
  return { plan: ctx.deps.plan({ facts, targetVersion, profile }), targetVersion, facts }
}

/** Put a host back into its connected state without pretending the launch URL changed. */
function resumeConnected(ctx, runtime) {
  runtime.status = 'connected'
  runtime.phase = 'ready'
  runtime.progress = { code: 'ready' }
  runtime.error = null
  runtime.remote.uiReady = true
  startRemoteHeartbeat(ctx, runtime)
  ctx.emitState()
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
 * @param {object} ctx - service context.
 * @param {object} runtime - host runtime with a live transport.
 * @returns {Promise<{ accepted: boolean, reason?: string }>} whether the restart started.
 */
export async function restartHost(ctx, runtime) {
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
  const token = beginLinkWork(runtime, 'restart')
  const work = runRestart(ctx, runtime, token)
  runtime.restartPromise = work
  void work.finally(() => {
    endLinkWork(runtime, token)
    if (runtime.restartPromise === work) runtime.restartPromise = null
  })
  return { accepted: true }
}

async function runRestart(ctx, runtime, token) {
  const log = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = remoteLayout(runtime.facts?.home ?? null)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const previousPort = runtime.remote.port
  // Restarting from the remote-unreachable error state has no tunnel to keep.
  const hadTunnel = runtime.tunnel !== null
  let killable = false
  let stoppedOwn = false
  let started = false
  let tunnelCreated = false
  try {
    stopRemoteHeartbeat(runtime)
    cancelIdleStop(runtime)
    log('info', `restart requested (pid=${runtime.remote.pid ?? 'unknown'}, remote port=${previousPort ?? 'unknown'})`)
    ctx.progress.set(runtime, { status: 'connecting', error: null, phase: 'start' })
    phase('start', 'restarting-remote', { pid: Number(runtime.remote.pid) || 0, port: Number(previousPort) || 0 })

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
    if (!isLinkWorkCurrent(runtime, token)) return

    // Ask about foreign instances BEFORE anything is stopped: cancelling the prompt must not
    // destroy the instance the user is currently connected to (docs/design.md §5.5).
    await resolveForeignConflict(ctx, runtime, layout, profile, {
      ignoredPids: Array.isArray(runtime.alongsidePids) ? runtime.alongsidePids : [],
    })
    if (!isLinkWorkCurrent(runtime, token)) return

    if (killable) {
      const stopped = await ctx.deps.stopWeb(runtime.ssh, layout, { pid: managedPid })
      stoppedOwn = stopped?.ok === true
      if (stoppedOwn) log('info', `restart: stopped the managed remote web pid=${managedPid}`)
      else {
        log(
          'warn',
          `restart: the managed remote web did not report a clean stop; launching a new instance anyway (${
            String(stopped?.output ?? '').slice(0, 300) || 'no output'
          })`,
        )
      }
      if (runtime.launched instanceof Map) runtime.launched.delete(managedPid)
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
    await openTunnelFor(ctx, runtime, webInfo.port)
    tunnelCreated = true
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, webInfo.port, webInfo.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, webInfo.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    recordRestart(runtime, {
      kind: 'local-restart',
      fromPort: previousPort,
      toPort: webInfo.port,
      pid: webInfo.pid ?? null,
    })
    markConnected(ctx, runtime)
    log(
      'info',
      `restart: connected again on 127.0.0.1:${runtime.tunnel.localPort} (remote port ${previousPort} -> ${webInfo.port})`,
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
      resumeConnected(ctx, runtime)
      return
    }
    const view = toErrorView(error)
    runtime.error = view
    runtime.status = 'error'
    runtime.phase = null
    runtime.progress = null
    runtime.remote.uiReady = false
    runtime.remote.localPort = null
    log('warn', `restart failed: ${view.code}`, messageOf(error))
    await teardownRuntime(ctx, runtime, { stopRemote: started && runtime.entry.keepAlive === 'stop' })
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action: a disconnect (or a host
    // removal) during the rebuild would otherwise leave it open with a disposed SSH channel.
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
}

/**
 * Re-attach to a remote web that restarted on its own (plugin-market update, supervisor,
 * remote reboot): re-read the real pid/port, refresh `run/web.json`, rebuild the tunnel,
 * take the new launch token and verify. The SSH session and the host entry are untouched.
 *
 * @param {object} ctx - service context.
 * @param {object} runtime - host runtime the watchdog decided is unreachable.
 * @param {{ reason?: string, source?: string }} [info] - why the re-attach was requested.
 * @returns {Promise<{ accepted: boolean, reason?: string }>} whether the re-attach started.
 */
export async function reattachHost(ctx, runtime, info = {}) {
  if (runtime.status !== 'connected' || runtime.ssh?.connected !== true || runtime.tunnel === null) {
    return { accepted: false, reason: 'not-connected' }
  }
  if (runtime.connectPromise || runtime.linkBusy !== null) return { accepted: false, reason: 'busy' }
  const token = beginLinkWork(runtime, 'reattach')
  const work = runReattach(ctx, runtime, info, token)
  runtime.reattachPromise = work
  void work.finally(() => {
    endLinkWork(runtime, token)
    if (runtime.reattachPromise === work) runtime.reattachPromise = null
  })
  return { accepted: true }
}

async function runReattach(ctx, runtime, info, token) {
  const log = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  const layout = remoteLayout(runtime.facts?.home ?? null)
  const profile = runtime.remote.profile ?? ctx.settings().bootstrap.profile
  const fromPort = runtime.remote.port
  const reason = typeof info?.reason === 'string' && info.reason !== '' ? info.reason : 'remote-unreachable'
  let tunnelCreated = false
  try {
    stopRemoteHeartbeat(runtime)
    cancelReconnect(runtime)
    cancelIdleStop(runtime)
    log('info', `remote restart suspected: ${reason}; re-reading the remote state`)
    ctx.progress.set(runtime, { status: 'connecting', error: null, phase: 'start' })
    phase('start', 'restarting-remote', { reason })

    // A restart takes a moment to print its new readiness line: retry before giving up.
    const attempts = Math.max(1, Number(ctx.timers.reattachAttempts) || REMOTE_REATTACH_ATTEMPTS)
    const intervalMs = Math.max(0, Number(ctx.timers.reattachIntervalMs) || 0)
    let resolved = null
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
    if (!resolved || resolved.ok !== true) {
      const detail =
        resolved?.reason === 'no-token'
          ? {
              zh: '远端 DSH 仍在运行，但它这次重启没有留下可用的 launch token，无法自动重新挂载；请点「重启远端 DSH」或「重连」。',
              en: 'The remote DSH is still running, but its restart left no usable launch token, so it cannot be re-attached; use "Restart remote DSH" or Reconnect.',
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
          zh: '远端 DSH 重启后没有留下可用的 launch token，无法自动重新挂载；请点「重启远端 DSH」或「重连」。',
          en: 'The restarted remote DSH left no usable launch token, so it cannot be re-attached; use "Restart remote DSH" or Reconnect.',
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
    await openTunnelFor(ctx, runtime, resolved.port)
    tunnelCreated = true
    if (!isLinkWorkCurrent(runtime, token)) return

    phase('verifying', 'verifying')
    await verifyRemoteUi(ctx, runtime, resolved.port, resolved.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, resolved.token)
    if (!isLinkWorkCurrent(runtime, token)) return
    recordRestart(runtime, {
      kind: 'remote-reattach',
      fromPort,
      toPort: resolved.port,
      pid: resolved.pid,
      reason,
      source: resolved.source,
    })
    markConnected(ctx, runtime)
    log(
      'info',
      `re-attached: remote ${runtime.remote.version ?? 'version unknown'} on 127.0.0.1:${
        runtime.tunnel.localPort
      } (remote port ${fromPort} -> ${resolved.port})`,
    )
  } catch (error) {
    if (!isLinkWorkCurrent(runtime, token)) {
      log('debug', 're-attach aborted: the link was replaced by a disconnect or reconnect')
      return
    }
    const view = toErrorView(error)
    runtime.error = view
    runtime.status = 'error'
    runtime.phase = null
    runtime.progress = null
    runtime.remote.uiReady = false
    runtime.remote.localPort = null
    await closeTunnel(runtime)
    stopRemoteHeartbeat(runtime)
    log('warn', `re-attach failed: ${view.code}`, messageOf(error))
    ctx.emitState()
  } finally {
    // A listener this action created must never outlive the action (see runRestart).
    if (tunnelCreated && !isLinkWorkCurrent(runtime, token)) await closeTunnel(runtime)
    endLinkWork(runtime, token)
  }
}

/**
 * The connect pipeline: SSH → probe → managed Node → plan → adopt/conflict →
 * npx preflight → start → tunnel → verify, plus re-entry for reconnect.
 *
 * Every external step comes from `ctx.deps` (the facade's injected fakes), so the
 * sequence runs in unit tests without SSH or timers. The step order is the
 * behavior: adopt before the preflight, a leftover registry stop before the
 * foreign-process scan, and teardown on every failure path.
 */
import { REMOTE_START_TIMEOUT_MS, SSH_READY_TIMEOUT_MS, TUNNEL_PROBE_TIMEOUT_MS } from './constants.js'
import { errors, toErrorView } from './errors.js'
import { runtimeOf } from './host-registry.js'
import {
  cancelIdleStop,
  cancelReconnect,
  closeTunnel,
  disconnectHost,
  disposeSsh,
  scheduleReconnect,
  teardownRuntime,
} from './host-lifecycle.js'
import { findKnownHostEntries, parseKnownHosts } from './known-hosts.js'
import { remoteLayout } from './layout.js'
import { applyManagedNodeFacts, managedNodeVersionFromEngine } from './node-runtime.js'
import { askConflict, requestHostKey } from './prompts.js'
import { resolveDestination } from './ssh-config.js'
import { isPid, messageOf, nowIso } from './util.js'
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
  if (runtime.status === 'connected' && runtime.ssh?.connected) return { accepted: false, reason: 'already-connected' }
  runtime.password = options.password ?? runtime.password
  // A password the user asked to remember is written to the credential store the
  // moment it is known, so a failed first attempt still leaves it available.
  if (options.rememberPassword === true && typeof runtime.password === 'string' && runtime.password !== '') {
    runtime.savePassword = true
  }
  runtime.desired = 'connected'
  cancelReconnect(runtime)
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
  return startConnect(ctx, runtime.id, {})
}

/**
 * Re-enter the pipeline after a dropped link. Lives here rather than in the
 * lifecycle module so `scheduleReconnect` stays a pure timer with a callback.
 */
export async function reconnectNow(ctx, runtime) {
  if (ctx.state.disposed || runtime.desired !== 'connected') return
  await disposeSsh(runtime)
  runtime.connectPromise = connectPipeline(ctx, runtime).finally(() => {
    runtime.connectPromise = null
  })
}

function attachDisconnectHandler(ctx, runtime) {
  const ssh = runtime.ssh
  if (!ssh) return
  ssh.on('close', () => {
    if (runtime.closing || runtime.desired !== 'connected' || runtime.status !== 'connected') return
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
async function resolveForeignConflict(ctx, runtime, layout, profile) {
  const ignorePids = []
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
  ctx.progress.log(runtime, 'info', `stopped ${found.processes.length} manual remote DSH process(es)`)
}

export async function connectPipeline(ctx, runtime) {
  const log = (level, ...args) => ctx.progress.log(runtime, level, ...args)
  const phase = (name, code, params) => ctx.progress.phase(runtime, name, code, params)
  runtime.closing = false
  runtime.reconnectAttempts = 0
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
      } else if (adopted) {
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
      } else {
        log('debug', 'adopt: no running remote web to reuse')
      }
    } catch (error) {
      log('debug', 'adopt check failed:', messageOf(error))
    }
    if (!webInfo) {
      // The registry row we refused to adopt (stale launch marker, unresponsive
      // HTTP, ...) still names a process on this ~/.dsh profile. Starting a second
      // one would let two clients write the same session files.
      const leftover = await ctx.deps.readRegistry(runtime.ssh, layout)
      const leftoverPid = Number(leftover?.pid ?? 0)
      if (leftover?.dshHome === layout.dshHome && leftover?.profile === profile && isPid(leftoverPid)) {
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
    }

    phase('tunnel', 'tunneling')
    runtime.tunnel = await ctx.deps.tunnelFactory({ ssh: runtime.ssh, remotePort: webInfo.port })
    runtime.remote.localPort = runtime.tunnel.localPort
    log('info', `tunnel open: 127.0.0.1:${runtime.tunnel.localPort} -> 127.0.0.1:${webInfo.port}`)

    phase('verifying', 'verifying')
    log('debug', `verifying the remote UI on 127.0.0.1:${webInfo.port}`)
    const ui = await ctx.deps.waitUi(runtime.ssh, webInfo.port, { attempts: 20, intervalMs: 500 })
    if (!ui.ok) {
      throw errors.remoteUiUnreachable({
        zh: `远端 DSH 的本地 127.0.0.1:${webInfo.port} 没有响应（HTTP ${ui.status ?? '无'}）。`,
        en: `The remote DSH on 127.0.0.1:${webInfo.port} did not respond (HTTP ${ui.status ?? 'none'}).`,
      })
    }
    log('debug', `remote UI answered HTTP ${ui.status}; exchanging the launch token`)
    const exchange = await ctx.deps.exchange(runtime.tunnel.localPort, webInfo.token, {
      timeoutMs: TUNNEL_PROBE_TIMEOUT_MS,
    })
    runtime.exchange = exchange
    if (!exchange.ok) {
      throw errors.remoteUiUnreachable({
        zh: `本地隧道完成了 token 交换，但远端界面返回 HTTP ${exchange.status}（首次状态 ${exchange.firstStatus}）。`,
        en: `The tunnel exchanged the token but the remote UI answered HTTP ${exchange.status} (first ${exchange.firstStatus}).`,
      })
    }
    // X-Frame-Options / CSP no longer matter: the remote UI is rendered by the
    // desktop guest, not embedded in a frame, so a page that refuses framing is
    // still a perfectly usable remote host.
    runtime.remote.uiReady = true
    await ctx.store.patchHost(runtime.id, { lastOpenedAt: nowIso() })
    runtime.entry = ctx.store.getHost(runtime.id) ?? runtime.entry
    if (ctx.settings().saveTokens) await ctx.store.saveToken(runtime.id, webInfo.token)
    // Remember the password now that it is proven, if the user asked for that.
    if (runtime.savePassword === true && typeof runtime.password === 'string' && ctx.secrets) {
      runtime.passwordSaved = await ctx.secrets.set(runtime.id, runtime.password)
    }
    runtime.status = 'connected'
    runtime.phase = 'ready'
    runtime.progress = { code: 'ready' }
    runtime.error = null
    ctx.state.activeHostId = runtime.id
    attachDisconnectHandler(ctx, runtime)
    ctx.emitState()
    log('info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${runtime.tunnel.localPort}`)
  } catch (error) {
    const view = toErrorView(error)
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
      log('warn', `connect failed: ${view.code}`, messageOf(error))
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

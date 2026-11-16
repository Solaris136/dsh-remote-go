/**
 * Orchestration service — the facade over host-registry, connect-pipeline, host-lifecycle, prompts and connect-progress; every external step is injected.
 */
import { EventEmitter } from 'node:events'
import { planNpx, verifyNpxVersion } from './bootstrap.js'
import {
  REMOTE_CONFLICT_TIMEOUT_MS,
  REMOTE_REATTACH_ATTEMPTS,
  REMOTE_REATTACH_INTERVAL_MS,
  REMOTE_UNREACHABLE_CONFIRM_DELAY_MS,
  REMOTE_UNREACHABLE_RECHECK_DELAY_MS,
  REMOTE_VIEW_PREFIX,
} from './constants.js'
import { createConnectProgress, describePreflightEvent } from './connect-progress.js'
import { createDownloadJobs } from './download-jobs.js'
import { reattachHost, reconnectHost, repairTunnel, restartHost, startConnect } from './connect-pipeline.js'
import { diagnoseHost } from './diagnostics.js'
import { errors } from './errors.js'
import {
  discoverSshAliases,
  initRegistry,
  listKeyFiles,
  removeHost,
  runtimeOf,
  saveHost,
  saveSettings,
  setActiveHost,
  snapshot,
} from './host-registry.js'
import { disconnectHost, noteRemoteUnreachable, shutdownAll } from './host-lifecycle.js'
import { loadLocalSshMaterial } from './local-ssh.js'
import { ensureRemoteNode } from './node-runtime.js'
import { confirmConflict, confirmHostKey } from './prompts.js'
import { probeRemote } from './probe.js'
import { SshConnection } from './ssh.js'
import { createTunnel } from './tunnel.js'
import { normalizeVersion } from './version.js'
import { nowIso } from './util.js'
import {
  adoptRemoteWeb,
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  readRunRegistry,
  remoteHttpStatus,
  remoteProcessIdentity,
  resolveRemoteWeb,
  startRemoteWeb,
  stopForeignDshProcesses,
  stopRemoteWeb,
  waitForRemoteUi,
  writeRunRegistry,
} from './webapp.js'

export { describePreflightEvent }

/** Milliseconds a paused host-key handshake waits for the user. */
const HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000

export class RemoteGoService extends EventEmitter {
  constructor(options) {
    super()
    this.store = options.store
    this.home = options.home
    this.logger = options.logger ?? console
    this.localVersion = options.localVersion ?? null
    // `engines.node` of the local DSH package; the managed Node version is its
    // lower bound (see `managedNodeVersionFromEngine`). Null until detected.
    this.engineNodeRange = options.engineNodeRange ?? null
    this.secrets = options.secrets ?? null
    this.hostKeyConfirmTimeoutMs = options.hostKeyConfirmTimeoutMs ?? HOST_KEY_CONFIRM_TIMEOUT_MS
    this.conflictConfirmTimeoutMs = options.conflictConfirmTimeoutMs ?? REMOTE_CONFLICT_TIMEOUT_MS
    this.logLevel = typeof options.logLevel === 'string' ? options.logLevel : null

    const deps = {
      sshFactory: options.sshFactory ?? ((sshOptions) => new SshConnection(sshOptions)),
      tunnelFactory: options.tunnelFactory ?? createTunnel,
      probe: options.probe ?? probeRemote,
      plan: options.plan ?? planNpx,
      ensureNode: options.ensureNode ?? ensureRemoteNode,
      preflight: options.preflight ?? verifyNpxVersion,
      startWeb: options.startWeb ?? startRemoteWeb,
      stopWeb: options.stopWeb ?? stopRemoteWeb,
      waitUi: options.waitUi ?? waitForRemoteUi,
      exchange: options.exchange ?? exchangeTokenOverTunnel,
      adopt: options.adopt ?? adoptRemoteWeb,
      resolveRemote: options.resolveRemote ?? resolveRemoteWeb,
      writeRegistry: options.writeRegistry ?? writeRunRegistry,
      remoteStatus: options.remoteStatus ?? remoteHttpStatus,
      processIdentity: options.processIdentity ?? remoteProcessIdentity,
      findForeign: options.findForeign ?? findForeignDshProcesses,
      stopForeign: options.stopForeign ?? stopForeignDshProcesses,
      readRegistry: options.readRegistry ?? readRunRegistry,
      loadSshMaterial: options.loadSshMaterial ?? loadLocalSshMaterial,
    }
    this.ctx = {
      deps,
      store: this.store,
      home: this.home,
      logger: this.logger,
      secrets: this.secrets,
      state: { runtimes: new Map(), activeHostId: null, initialized: false, disposed: false },
      timers: {
        hostKeyConfirmMs: this.hostKeyConfirmTimeoutMs,
        conflictConfirmMs: this.conflictConfirmTimeoutMs,
        // Liveness confirmation and the re-attach retry loop; tests shorten these.
        remoteConfirmDelayMs: options.remoteConfirmDelayMs ?? REMOTE_UNREACHABLE_CONFIRM_DELAY_MS,
        remoteRecheckMs: options.remoteRecheckMs ?? REMOTE_UNREACHABLE_RECHECK_DELAY_MS,
        reattachAttempts: options.reattachAttempts ?? REMOTE_REATTACH_ATTEMPTS,
        reattachIntervalMs: options.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS,
      },
      // Live readers, never cached: a setting or a detected version can change
      // while a connect is already in flight.
      settings: () => this.store.getSettings(),
      localVersion: () => this.localVersion,
      engineNodeRange: () => this.engineNodeRange,
      userHome: () => process.env.USERPROFILE || process.env.HOME || this.home,
      emitState: () => this.emitState(),
      init: () => this.init(),
      /**
       * The watchdog reports an episode (suspected -> confirmed -> recovered); the Client
       * contract gets the same transitions as one SSE event, and the state frames carry the
       * `restarting-remote` progress. Never let a listener failure break the probe.
       */
      onRemoteUnreachable: (runtime, info) => {
        try {
          this.emit('remote-unreachable', { hostId: runtime.id, at: nowIso(), ...info })
        } catch (error) {
          this.logger.warn?.('[dsh-remote-go] remote-unreachable listener failed:', error)
        }
      },
      /** A proxy or tunnel failure arrived: confirm it with probes instead of trusting one request. */
      noteRemoteUnreachable: (runtime, source) => noteRemoteUnreachable(this.ctx, runtime, source),
      /** Confirmed by probes: re-read the remote, rewrite the registry, rebuild the tunnel. */
      requestReattach: (runtime, info) => {
        void reattachHost(this.ctx, runtime, info)
      },
      /** The remote answers but proxied requests fail: rebuild the local listener (B8). */
      repairTunnel: (runtime) => repairTunnel(this.ctx, runtime),
    }
    this.ctx.progress = createConnectProgress({
      logger: this.logger,
      logLevel: this.logLevel,
      getSettings: () => this.store.getSettings(),
      emitState: () => this.emitState(),
    })
    this.downloads = createDownloadJobs({
      logger: this.logger,
      emit: (job) => this.emit('download', job),
    })
  }

  get runtimes() {
    return this.ctx.state.runtimes
  }

  get activeHostId() {
    return this.ctx.state.activeHostId
  }

  async init() {
    await initRegistry(this.ctx)
    return this
  }

  emitState() {
    try {
      this.emit('state', this.snapshot())
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] state listener failed:', error)
    }
  }

  setLocalVersion(version) {
    const normalized = version ? normalizeVersion(version) : null
    if (normalized) {
      this.localVersion = normalized
      this.emitState()
    }
  }

  setLocalEnginesNode(range) {
    const text = typeof range === 'string' ? range.trim() : ''
    this.engineNodeRange = text === '' ? null : text
  }

  /** Build the client-facing state snapshot (contract: docs/api.md). */
  snapshot() {
    return snapshot(this.ctx)
  }

  userHome() {
    return this.ctx.userHome()
  }

  async saveHost(rawHost) {
    return saveHost(this.ctx, rawHost)
  }

  async removeHost(id) {
    return removeHost(this.ctx, id)
  }

  setActiveHost(id) {
    return setActiveHost(this.ctx, id)
  }

  async saveSettings(patch) {
    return saveSettings(this.ctx, patch)
  }

  async listKeyFiles(dir) {
    return listKeyFiles(this.ctx, dir)
  }

  async discoverSshAliases() {
    return discoverSshAliases(this.ctx)
  }

  async connect(id, options = {}) {
    return startConnect(this.ctx, id, options)
  }

  async disconnect(id, options = {}) {
    await this.init()
    return disconnectHost(this.ctx, runtimeOf(this.ctx, id), options)
  }

  async reconnect(id) {
    await this.init()
    return reconnectHost(this.ctx, runtimeOf(this.ctx, id))
  }

  /**
   * Restart the managed remote web on the same SSH session (the "Restart remote DSH"
   * card action). Only a connected host can be restarted; the work runs in the
   * background and reports through `/state` like a connect does.
   */
  async restart(id) {
    await this.init()
    return restartHost(this.ctx, runtimeOf(this.ctx, id))
  }

  async confirmFingerprint(id, decision) {
    return confirmHostKey(this.ctx, runtimeOf(this.ctx, id), decision)
  }

  async confirmConflict(id, decision) {
    return confirmConflict(runtimeOf(this.ctx, id), decision)
  }

  openInfo(id) {
    const runtime = runtimeOf(this.ctx, id)
    if (runtime.status !== 'connected' || !runtime.tunnel || !runtime.token) {
      throw errors.remoteUiUnreachable({
        zh: '主机尚未连接，无法打开远端界面。',
        en: 'The host is not connected yet, so the remote UI cannot be opened.',
      })
    }
    const token = encodeURIComponent(runtime.token)
    return {
      url: `http://127.0.0.1:${runtime.tunnel.localPort}/?token=${token}`,
      // The browser half's carrier: same-origin seat of the same UI, proxied to this tunnel.
      webUrl: `${REMOTE_VIEW_PREFIX}${encodeURIComponent(id)}/?token=${token}`,
      localPort: runtime.tunnel.localPort,
      address: `127.0.0.1:${runtime.tunnel.localPort}`,
    }
  }

  /** Configured host ids (the proxy keeps one stream upgrade route per id). */
  hostIds() {
    return [...this.ctx.state.runtimes.keys()]
  }

  /**
   * Loopback target of one host's remote web UI, for the same-origin proxy.
   * Reads the live runtime, so a reconnect hands the proxy the new tunnel on the next request.
   * @param {string} id - host id.
   * @returns {{ localPort: number, remotePort: number | null } | null}
   */
  webViewTarget(id) {
    const runtime = this.ctx.state.runtimes.get(id)
    if (!runtime || runtime.status !== 'connected' || !runtime.tunnel) return null
    return { localPort: runtime.tunnel.localPort, remotePort: runtime.remote.port }
  }

  /**
   * The same-origin proxy could not reach a host's tunnel. One failed request is not a
   * restart: it starts the same probe confirmation the heartbeat uses.
   * @param {string} id - host id the proxy serves.
   */
  noteUpstreamFailure(id) {
    const runtime = this.ctx.state.runtimes.get(id)
    if (!runtime) return
    noteRemoteUnreachable(this.ctx, runtime, 'proxy')
  }

  async diagnose(id) {
    await this.init()
    return diagnoseHost(runtimeOf(this.ctx, id), { targetVersion: this.localVersion })
  }

  /**
   * Start preparing one remote file or folder for the client's download.
   * @param {string} id - host id.
   * @param {unknown} path - absolute remote path.
   * @param {{ destination?: string }} [options] - local destination directory.
   * @returns {object} the initial download job view.
   */
  async startRemoteDownload(id, path, options = {}) {
    await this.init()
    return this.downloads.start(runtimeOf(this.ctx, id), path, options)
  }

  /** Current view of one download job. */
  async remoteDownloadStatus(jobId) {
    await this.init()
    return this.downloads.status(jobId)
  }

  /** Cancel one download job. */
  async cancelRemoteDownload(jobId) {
    await this.init()
    return this.downloads.cancel(jobId)
  }

  async shutdown() {
    this.ctx.state.disposed = true
    this.ctx.progress.dispose()
    this.downloads.dispose()
    await shutdownAll(this.ctx)
  }
}

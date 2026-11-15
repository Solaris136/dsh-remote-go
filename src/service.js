/**
 * Orchestration service — the facade over host-registry, connect-pipeline, host-lifecycle, prompts and connect-progress; every external step is injected.
 */
import { EventEmitter } from 'node:events'
import { planNpx, verifyNpxVersion } from './bootstrap.js'
import { REMOTE_CONFLICT_TIMEOUT_MS } from './constants.js'
import { createConnectProgress, describePreflightEvent } from './connect-progress.js'
import { createDownloadJobs } from './download-jobs.js'
import { reconnectHost, startConnect } from './connect-pipeline.js'
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
import { disconnectHost, shutdownAll } from './host-lifecycle.js'
import { loadLocalSshMaterial } from './local-ssh.js'
import { ensureRemoteNode } from './node-runtime.js'
import { confirmConflict, confirmHostKey } from './prompts.js'
import { probeRemote } from './probe.js'
import { SshConnection } from './ssh.js'
import { createTunnel } from './tunnel.js'
import { normalizeVersion } from './version.js'
import {
  adoptRemoteWeb,
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  readRunRegistry,
  startRemoteWeb,
  stopForeignDshProcesses,
  stopRemoteWeb,
  waitForRemoteUi,
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
      },
      // Live readers, never cached: a setting or a detected version can change
      // while a connect is already in flight.
      settings: () => this.store.getSettings(),
      localVersion: () => this.localVersion,
      engineNodeRange: () => this.engineNodeRange,
      userHome: () => process.env.USERPROFILE || process.env.HOME || this.home,
      emitState: () => this.emitState(),
      init: () => this.init(),
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
    return {
      url: `http://127.0.0.1:${runtime.tunnel.localPort}/?token=${encodeURIComponent(runtime.token)}`,
      localPort: runtime.tunnel.localPort,
      address: `127.0.0.1:${runtime.tunnel.localPort}`,
    }
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

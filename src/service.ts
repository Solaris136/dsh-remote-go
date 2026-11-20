/** Orchestration facade over host-registry, the connect workflow, host-lifecycle, prompts and connect-progress; every
 * external step is injected. */
import { EventEmitter } from 'node:events'
import { MIN_DSH_VERSION, REMOTE_VIEW_PREFIX } from './constants.js'
import { connectLogTail, connectLogVisible, type ConnectLogTailItem } from './connect-log.js'
import { describePreflightEvent } from './connect-progress.js'
import { createCtx, type Ctx, type ServiceHooks, type ServiceLogger, type ServiceOptions } from './context.js'
import { createDownloadJobs, type DownloadJobView, type DownloadJobs } from './download-jobs.js'
import { reconnectHost, startConnect, type AcceptedResult, type StartConnectOptions } from './connect/links.js'
import { reattachHost } from './connect/reattach.js'
import { repairTunnel } from './connect/repair.js'
import { restartHost } from './connect/restart.js'
import { stopRemoteHost, type StopRemoteResult } from './connect/stop.js'
import { installWatchdog } from './connect/watchdog.js'
import { diagnoseHost, type DiagnosticsReport } from './diagnostics.js'
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
import type { KeyFileListing, RawHostEntry, SshDiscovery, StateSnapshot } from './host-registry.js'
import { disconnectHost, shutdownAll, type DisconnectOptions } from './host-lifecycle.js'
import type { HostRuntime } from './host-runtime.js'
import type { HostView } from './host-view.js'
import { requireDestination } from './local-download.js'
import { confirmConflict, confirmHostKey, type ConflictDecision, type FingerprintDecision } from './prompts.js'
import type { SecretStore } from './secrets.js'
import type { Settings } from './settings.js'
import type { HostStore } from './store.js'
import { compareVersions, normalizeVersion, parseVersion } from './version.js'
import { nowIso } from './util.js'
import { noteRemoteUnreachable } from './watchdog.js'
export { describePreflightEvent }
export interface StateView extends StateSnapshot {
  rev: number
  instance: string
}
/** One host's connect log cursor view for the log channel; a host that just left the visible set still publishes. */
export interface ConnectLogView {
  hostId: string
  attempt: number
  visible: boolean
  firstSeq: number
  seq: number
  entries: ConnectLogTailItem[]
}
export interface SavePasswordOptions {
  password?: string
  clear?: boolean
}
export interface SavePasswordResult {
  available: boolean
  saved: boolean
}
export interface RemoteDownloadOptions {
  destination?: string
}
export interface WebViewTarget {
  localPort: number
  remotePort: number | null
}
export interface OpenInfo {
  url: string
  webUrl: string
  localPort: number
  address: string
}
export type RemoteGoServiceOptions = ServiceOptions
let stateInstanceSequence = 0
/** A fresh instance id per service, so a restarted Host's low `rev` is still accepted as newer. */
function stateInstanceId(): string {
  stateInstanceSequence += 1
  const pid = typeof process !== 'undefined' && Number.isInteger(process.pid) ? process.pid.toString(36) : '0'
  return `${pid}-${Date.now().toString(36)}-${stateInstanceSequence.toString(36)}`
}

export class RemoteGoService extends EventEmitter {
  declare store: HostStore
  declare home: string
  declare logger: ServiceLogger
  declare localVersion: string | null
  declare engineNodeRange: string | null
  declare secrets: SecretStore | null
  declare stateRev: number
  /** The publish generation: after a Host restart a fresh `rev` would look older, so the Client accepts a new instance. */
  declare stateInstance: string
  declare ctx: Ctx
  declare downloads: DownloadJobs
  declare uninstallWatchdog: (() => void) | null

  constructor(options: RemoteGoServiceOptions) {
    super()
    this.store = options.store
    this.home = options.home
    this.logger = options.logger ?? console
    this.localVersion = options.localVersion ?? null
    this.engineNodeRange = options.engineNodeRange ?? null
    this.secrets = options.secrets ?? null
    this.stateRev = 0
    this.stateInstance = stateInstanceId()
    // Only the facade can supply these: the publish revision, the lazy load, the two adopted values
    // (`api.ts` and `index.ts` read the fields) and the episode event.
    const hooks: ServiceHooks = {
      publish: () => this.emitState(),
      publishLogs: (hostId) => this.emitLogs(hostId),
      load: () => this.init(),
      localVersion: () => this.localVersion,
      engineNodeRange: () => this.engineNodeRange,
      onEpisode: (runtime, info) => {
        try {
          this.emit('remote-unreachable', { hostId: runtime.id, at: nowIso(), ...info })
        } catch (error) {
          this.logger.warn?.('[dsh-remote-go] remote-unreachable listener failed:', error)
        }
      },
    }
    this.ctx = createCtx({ ...options, logger: this.logger }, hooks)
    this.uninstallWatchdog = installWatchdog(this.ctx, {
      reattach: (runtime, info) => reattachHost(this.ctx, runtime, info),
      repair: (runtime) => repairTunnel(this.ctx, runtime),
    })
    this.ctx.noteRemoteUnreachable = (runtime, source) => noteRemoteUnreachable(this.ctx, runtime, source)
    this.downloads = createDownloadJobs({
      logger: this.logger,
      emit: (job) => this.emit('download', job),
    })
  }

  get runtimes(): Map<string, HostRuntime> {
    return this.ctx.state.runtimes
  }

  get activeHostId(): string | null {
    return this.ctx.state.activeHostId
  }

  async init(): Promise<this> {
    await initRegistry(this.ctx)
    return this
  }

  emitState(): void {
    try {
      // Every frame gets its own monotonic revision, so an out-of-order SSE delivery or a slow
      // `GET /state` cannot repaint the panel backwards; a connect log row must not move it.
      this.stateRev += 1
      this.emit('state', this.snapshot())
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] state listener failed:', error)
    }
  }

  emitLogs(hostId: string): void {
    try {
      this.emit('logs', { hostId })
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] log listener failed:', error)
    }
  }
  /** Adopt a DSH version for this machine. A `client` backfill exists for the case where the Host could not detect the
   * version itself, so it must never overwrite a detected one and must stay inside the supported range — without both
   * guards any local page could pin the remote runtime. */
  setLocalVersion(version: unknown, source = 'detected'): boolean {
    const normalized = version ? normalizeVersion(String(version)) : null
    const valid = normalized !== null && parseVersion(normalized) !== null
    // A client backfill must never overwrite a detected version nor name one below the floor,
    // otherwise any local page could pin the remote npx runtime to a value of its choosing.
    if (source === 'client') {
      if (this.localVersion !== null) return false
      if (!valid) {
        throw errors.invalidInput('version', {
          zh: '本机 DSH 版本格式不合法。',
          en: 'The local DSH version is not a valid version.',
        })
      }
      if (compareVersions(normalized, MIN_DSH_VERSION) < 0) {
        throw errors.invalidInput('version', {
          zh: `本机 DSH 版本 ${normalized} 低于插件要求的最低版本 ${MIN_DSH_VERSION}。`,
          en: `Local DSH ${normalized} is below the minimum this plugin supports (${MIN_DSH_VERSION}).`,
        })
      }
    } else if (!valid) {
      return false
    }
    this.localVersion = normalized
    this.emitState()
    return true
  }

  setLocalEnginesNode(range: unknown): void {
    const text = typeof range === 'string' ? range.trim() : ''
    this.engineNodeRange = text === '' ? null : text
  }
  /** Build the client-facing state snapshot; `logs: false` is the state-frame shape that strips every tail. */
  snapshot(options: { logs?: boolean } = {}): StateView {
    return { ...snapshot(this.ctx, options), rev: this.stateRev, instance: this.stateInstance }
  }

  logView(hostId: string): ConnectLogView | null {
    const runtime = this.ctx.state.runtimes.get(hostId)
    if (!runtime) return null
    const logs = Array.isArray(runtime.logs) ? runtime.logs : []
    const seq = typeof runtime.logSeq === 'number' ? runtime.logSeq : 0
    const oldest = logs[0]
    // An empty ring reports "one past the current cursor", so a cursor from the last row still replays.
    const firstSeq = oldest !== undefined && typeof oldest.seq === 'number' ? oldest.seq : seq + 1
    return {
      hostId,
      attempt: typeof runtime.connectCount === 'number' ? runtime.connectCount : 0,
      visible: connectLogVisible(runtime.status),
      firstSeq,
      seq,
      entries: connectLogTail(runtime),
    }
  }

  logHostIds(): string[] {
    const ids: string[] = []
    for (const [id, runtime] of this.ctx.state.runtimes) {
      if (connectLogVisible(runtime.status)) ids.push(id)
    }
    return ids
  }

  userHome(): string {
    return this.ctx.userHome()
  }

  async saveHost(rawHost: RawHostEntry): Promise<HostView> {
    return saveHost(this.ctx, rawHost)
  }

  async removeHost(id: string): Promise<{ ok: true }> {
    return removeHost(this.ctx, id)
  }

  setActiveHost(id: string | null): void {
    return setActiveHost(this.ctx, id)
  }

  async saveSettings(patch: unknown): Promise<Settings> {
    return saveSettings(this.ctx, patch)
  }

  async listKeyFiles(dir: unknown): Promise<KeyFileListing> {
    return listKeyFiles(this.ctx, dir)
  }

  async discoverSshAliases(): Promise<SshDiscovery> {
    return discoverSshAliases(this.ctx)
  }

  async connect(id: string, options: StartConnectOptions = {}): Promise<AcceptedResult> {
    return startConnect(this.ctx, id, options)
  }
  /** Remember or forget the SSH password without connecting; the value never enters `hosts.json`. */
  async saveHostPassword(id: string, options: SavePasswordOptions = {}): Promise<SavePasswordResult> {
    await this.init()
    const runtime = runtimeOf(this.ctx, id)
    const available = this.secrets ? this.secrets.available() === true : false
    if (!available) return { available: false, saved: false }
    if (options.clear === true) {
      const removed = await this.secrets.remove(id)
      // The in-memory password belonged to the record just removed: a later connect must ask again.
      runtime.password = null
      runtime.passwordSaved = !removed
      this.emitState()
      return { available, saved: false }
    }
    const password = typeof options.password === 'string' ? options.password : ''
    if (password === '') {
      throw errors.invalidInput('password', { zh: '密码不能为空。', en: 'The password must not be empty.' })
    }
    const saved = await this.secrets.set(id, password)
    // An explicit save also arms the in-memory copy, so clicking "connect" next does not ask again
    // for a password this process just proved and stored.
    runtime.password = password
    runtime.passwordSaved = saved
    this.emitState()
    return { available, saved }
  }

  async disconnect(id: string, options: DisconnectOptions = {}): Promise<{ ok: boolean }> {
    await this.init()
    return disconnectHost(this.ctx, runtimeOf(this.ctx, id), options)
  }

  async reconnect(id: string): Promise<AcceptedResult> {
    await this.init()
    return reconnectHost(this.ctx, runtimeOf(this.ctx, id))
  }
  /** Restart the managed remote web on the same SSH session (the "Restart remote DSH" card action). */
  async restart(id: string): Promise<AcceptedResult> {
    await this.init()
    return restartHost(this.ctx, runtimeOf(this.ctx, id))
  }
  /** Stop the managed remote web this connection is bound to, then release the link and leave the host `disconnected`;
   * a refusal (wrong state, busy, unprovable pid) is a coded error (HTTP 409). */
  async stopRemote(id: string): Promise<StopRemoteResult> {
    await this.init()
    return stopRemoteHost(this.ctx, runtimeOf(this.ctx, id))
  }

  async confirmFingerprint(id: string, decision: FingerprintDecision): Promise<{ ok: boolean }> {
    return confirmHostKey(this.ctx, runtimeOf(this.ctx, id), decision)
  }

  async confirmConflict(id: string, decision: ConflictDecision): Promise<{ ok: boolean }> {
    return confirmConflict(runtimeOf(this.ctx, id), decision)
  }

  openInfo(id: string): OpenInfo {
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
      webUrl: `${REMOTE_VIEW_PREFIX}${encodeURIComponent(id)}/?token=${token}`,
      localPort: runtime.tunnel.localPort,
      address: `127.0.0.1:${runtime.tunnel.localPort}`,
    }
  }

  hostIds(): string[] {
    return [...this.ctx.state.runtimes.keys()]
  }

  webViewTarget(id: string): WebViewTarget | null {
    const runtime = this.ctx.state.runtimes.get(id)
    if (!runtime || runtime.status !== 'connected' || !runtime.tunnel) return null
    return { localPort: runtime.tunnel.localPort, remotePort: runtime.remote.port }
  }
  /** One failed proxy request is not a restart: it starts the same probe confirmation the heartbeat uses. */
  noteUpstreamFailure(id: string): void {
    const runtime = this.ctx.state.runtimes.get(id)
    if (!runtime) return
    noteRemoteUnreachable(this.ctx, runtime, 'proxy')
  }

  async diagnose(id: string): Promise<DiagnosticsReport> {
    await this.init()
    return diagnoseHost(runtimeOf(this.ctx, id), { targetVersion: this.localVersion })
  }

  async startRemoteDownload(id: string, path: unknown, options: RemoteDownloadOptions = {}): Promise<DownloadJobView> {
    await this.init()
    const runtime = runtimeOf(this.ctx, id)
    const home = this.userHome()
    await requireDestination(options.destination, { home })
    return this.downloads.start(runtime, path, { ...options, home })
  }

  async remoteDownloadStatus(jobId: string): Promise<DownloadJobView> {
    await this.init()
    return this.downloads.status(jobId)
  }

  async cancelRemoteDownload(jobId: string): Promise<boolean> {
    await this.init()
    return this.downloads.cancel(jobId)
  }

  async shutdown(): Promise<void> {
    this.uninstallWatchdog?.()
    this.uninstallWatchdog = null
    this.ctx.state.disposed = true
    this.ctx.progress.dispose()
    this.downloads.dispose()
    await shutdownAll(this.ctx)
  }
}

/**
 * Orchestration service — the facade over host-registry, the connect workflow (`connect/`), host-lifecycle, prompts and connect-progress; every external step is injected.
 */
import { EventEmitter } from 'node:events'
import { MIN_DSH_VERSION, REMOTE_VIEW_PREFIX } from './constants.js'
import { describePreflightEvent } from './connect-progress.js'
import { createCtx } from './context.js'
import type { Ctx, ServiceHooks, ServiceLogger, ServiceOptions } from './context.js'
import { createDownloadJobs } from './download-jobs.js'
import type { DownloadJobView, DownloadJobs } from './download-jobs.js'
import { reconnectHost, startConnect } from './connect/links.js'
import type { AcceptedResult, StartConnectOptions } from './connect/links.js'
import { restartHost } from './connect/restart.js'
import { stopRemoteHost } from './connect/stop.js'
import type { StopRemoteResult } from './connect/stop.js'
import { installWatchdog } from './connect/watchdog.js'
import { diagnoseHost } from './diagnostics.js'
import type { DiagnosticsReport } from './diagnostics.js'
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
import { disconnectHost, shutdownAll } from './host-lifecycle.js'
import type { DisconnectOptions } from './host-lifecycle.js'
import type { HostRuntime } from './host-runtime.js'
import type { HostView } from './host-view.js'
import { requireDestination } from './local-download.js'
import { confirmConflict, confirmHostKey } from './prompts.js'
import type { ConflictDecision, FingerprintDecision } from './prompts.js'
import type { SecretStore } from './secrets.js'
import type { Settings } from './settings.js'
import type { HostStore } from './store.js'
import { compareVersions, normalizeVersion, parseVersion } from './version.js'
import { nowIso } from './util.js'
import { noteRemoteUnreachable } from './watchdog.js'

export { describePreflightEvent }

/** The published state frame: the snapshot plus its revision and the publishing instance. */
export interface StateView extends StateSnapshot {
  rev: number
  instance: string
}

/** The wizard's plain "save"/"forget" action for one host's SSH password. */
export interface SavePasswordOptions {
  password?: string
  clear?: boolean
}

/** What one credential write reports: whether it could be persisted, and whether it was. */
export interface SavePasswordResult {
  available: boolean
  saved: boolean
}

/** One download destination the Client asked for. */
export interface RemoteDownloadOptions {
  destination?: string
}

/** The loopback target the same-origin proxy forwards one host's view to. */
export interface WebViewTarget {
  localPort: number
  remotePort: number | null
}

/** Everything the link to one host's UI needs, as `GET /hosts/:id/open` answers it. */
export interface OpenInfo {
  url: string
  webUrl: string
  localPort: number
  address: string
}

/**
 * Constructor input: the store and home the Host half resolved, plus every injectable step.
 *
 * The shape lives in `context.ts` beside the assembly that consumes it; this name is kept because
 * it is how the facade's constructor has always been described (`index.ts` builds one).
 */
export type RemoteGoServiceOptions = ServiceOptions

/**
 * One Host process can create several services (tests, a plugin reload in-process). The
 * instance id must differ for each so the Client can tell a new publish generation from a stale
 * frame without trusting wall-clock ordering.
 */
let stateInstanceSequence = 0
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
  /** `engines.node` of the local DSH package; the managed Node version is its lower bound. */
  declare engineNodeRange: string | null
  declare secrets: SecretStore | null
  /** Monotonic revision of the published `/state` snapshot (StateView.rev). */
  declare stateRev: number
  /**
   * Identifies this plugin instance. `rev` is only monotonic inside one process; after a Host
   * restart or a plugin reload a fresh counter would look older to a Client that is still
   * holding the previous high-water mark, and every new frame would be dropped. The Client
   * accepts a frame from a different instance regardless of its `rev` (StateView.instance).
   */
  declare stateInstance: string
  declare ctx: Ctx
  declare downloads: DownloadJobs
  /** The watchdog bus subscription this instance installed; `shutdown()` removes it. */
  declare uninstallWatchdog: (() => void) | null

  constructor(options: RemoteGoServiceOptions) {
    super()
    this.store = options.store
    this.home = options.home
    this.logger = options.logger ?? console
    this.localVersion = options.localVersion ?? null
    // `engines.node` of the local DSH package; the managed Node version is its
    // lower bound (see `managedNodeVersionFromEngine`). Null until detected.
    this.engineNodeRange = options.engineNodeRange ?? null
    this.secrets = options.secrets ?? null
    this.stateRev = 0
    this.stateInstance = stateInstanceId()

    /**
     * What only the facade can supply: the publish revision, the lazy load, the two adopted
     * values (it owns them: `api.ts` and `index.ts` read the fields) and the episode event.
     */
    const hooks: ServiceHooks = {
      publish: () => this.emitState(),
      load: () => this.init(),
      localVersion: () => this.localVersion,
      engineNodeRange: () => this.engineNodeRange,
      /**
       * The watchdog reports an episode (suspected -> confirmed -> recovered); the Client
       * contract gets the same transitions as one SSE event, and the state frames carry the
       * `restarting-remote` progress. Never let a listener failure break the probe.
       */
      onEpisode: (runtime, info) => {
        try {
          this.emit('remote-unreachable', { hostId: runtime.id, at: nowIso(), ...info })
        } catch (error) {
          this.logger.warn?.('[dsh-remote-go] remote-unreachable listener failed:', error)
        }
      },
    }
    // The assembly root is `context.ts` (P2/1): this class only owns the facade state above.
    this.ctx = createCtx({ ...options, logger: this.logger }, hooks)
    /**
     * The watchdog: one bus (assembled in `context.ts`), one subscriber (`connect/watchdog.ts`),
     * installed here because the facade owns the lifecycle — it subscribes now and unsubscribes on
     * shutdown, exactly where the three reverse callbacks of design-arch §1.7 used to be wired.
     */
    this.uninstallWatchdog = installWatchdog(this.ctx)
    /**
     * `noteRemoteUnreachable` is not a capability: `watchdog.ts` is imported forward by every
     * production caller. The alias exists because 13 test call sites drive a proxy/tunnel failure
     * through `service.ctx` (design-arch §1.7, §1.6).
     */
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
      // Every emitted frame gets its own monotonic revision. The Client drops a frame whose
      // `rev` is not newer than the one on screen, so an out-of-order SSE delivery or a slow
      // `GET /state` can no longer repaint the panel backwards (docs/api.md StateView.rev).
      this.stateRev += 1
      this.emit('state', this.snapshot())
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] state listener failed:', error)
    }
  }

  /**
   * Adopt a DSH version for this machine.
   *
   * `source === 'client'` is the browser's `POST /local-version` backfill: it exists for the
   * case where the Host could not detect the version by itself, so it must never overwrite a
   * detected one, and it must stay inside the range this plugin supports. Without both guards
   * any local page could pin the remote npx runtime (and the version-parity check) to a value
   * of its choosing.
   * @param version - a DSH semver string.
   * @param source - where the value came from; only `client` is distrusted.
   * @returns whether the value was adopted.
   */
  setLocalVersion(version: unknown, source = 'detected'): boolean {
    const normalized = version ? normalizeVersion(String(version)) : null
    const valid = normalized !== null && parseVersion(normalized) !== null
    if (source === 'client') {
      if (this.localVersion !== null) return false
      // A page may only name a real DSH version: a typo or a crafted value is a client mistake
      // (400), not a silent no-op the page could mistake for success.
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

  /** Build the client-facing state snapshot (contract: docs/api.md). */
  snapshot(): StateView {
    return { ...snapshot(this.ctx), rev: this.stateRev, instance: this.stateInstance }
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

  /**
   * Remember (or forget) the SSH password without opening a connection. The wizard's plain
   * "save" action uses this, and it is the only way to refresh a saved password that does not
   * require a successful connect first. The value never enters `hosts.json`; `available:false`
   * means no credential store can persist it here.
   * @param id - host id.
   */
  async saveHostPassword(id: string, options: SavePasswordOptions = {}): Promise<SavePasswordResult> {
    await this.init()
    const runtime = runtimeOf(this.ctx, id)
    const available = this.secrets ? this.secrets.available() === true : false
    if (!available) return { available: false, saved: false }
    if (options.clear === true) {
      const removed = await this.secrets.remove(id)
      // The password in memory belonged to the record just removed: a later connect must ask
      // instead of silently reusing a credential the user asked to forget.
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
    // An explicit save also arms the in-memory copy, so clicking "connect" next does not ask
    // again for a password this process just proved and stored.
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

  /**
   * Restart the managed remote web on the same SSH session (the "Restart remote DSH"
   * card action). Only a connected host can be restarted; the work runs in the
   * background and reports through `/state` like a connect does.
   */
  async restart(id: string): Promise<AcceptedResult> {
    await this.init()
    return restartHost(this.ctx, runtimeOf(this.ctx, id))
  }

  /**
   * Stop the managed remote web this connection is bound to, then release the link and
   * leave the host `disconnected` (the "Stop remote DSH" card action). Runs synchronously
   * on the same SSH session: `/state` carries `stopping-remote` while it works, and a
   * refusal (wrong state, busy, or an unprovable pid) is thrown as a coded error (HTTP 409).
   */
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
      // The browser half's carrier: same-origin seat of the same UI, proxied to this tunnel.
      webUrl: `${REMOTE_VIEW_PREFIX}${encodeURIComponent(id)}/?token=${token}`,
      localPort: runtime.tunnel.localPort,
      address: `127.0.0.1:${runtime.tunnel.localPort}`,
    }
  }

  /** Configured host ids (the proxy keeps one stream upgrade route per id). */
  hostIds(): string[] {
    return [...this.ctx.state.runtimes.keys()]
  }

  /**
   * Loopback target of one host's remote web UI, for the same-origin proxy.
   * Reads the live runtime, so a reconnect hands the proxy the new tunnel on the next request.
   * @param id - host id.
   */
  webViewTarget(id: string): WebViewTarget | null {
    const runtime = this.ctx.state.runtimes.get(id)
    if (!runtime || runtime.status !== 'connected' || !runtime.tunnel) return null
    return { localPort: runtime.tunnel.localPort, remotePort: runtime.remote.port }
  }

  /**
   * The same-origin proxy could not reach a host's tunnel. One failed request is not a
   * restart: it starts the same probe confirmation the heartbeat uses.
   * @param id - host id the proxy serves.
   */
  noteUpstreamFailure(id: string): void {
    const runtime = this.ctx.state.runtimes.get(id)
    if (!runtime) return
    noteRemoteUnreachable(this.ctx, runtime, 'proxy')
  }

  async diagnose(id: string): Promise<DiagnosticsReport> {
    await this.init()
    return diagnoseHost(runtimeOf(this.ctx, id), { targetVersion: this.localVersion })
  }

  /**
   * Start preparing one remote file or folder for the client's download.
   * @param id - host id.
   * @param path - absolute remote path.
   * @param options - local destination directory.
   * @returns the initial download job view.
   */
  async startRemoteDownload(id: string, path: unknown, options: RemoteDownloadOptions = {}): Promise<DownloadJobView> {
    await this.init()
    const runtime = runtimeOf(this.ctx, id)
    // One home root for both checks: the pre-flight below and the write itself. Falling back to
    // `os.homedir()` later could disagree with `userHome()` when HOME/USERPROFILE is unset, and
    // then a destination accepted here would be refused by the job.
    const home = this.userHome()
    // The local folder is checked before a job exists: a refused destination is the caller's
    // mistake (HTTP 400 `invalid-input`), not a job that first answers `preparing` and then
    // reports the refusal asynchronously (which also wasted a job slot and an SFTP stat).
    await requireDestination(options.destination, { home })
    return this.downloads.start(runtime, path, { ...options, home })
  }

  /** Current view of one download job. */
  async remoteDownloadStatus(jobId: string): Promise<DownloadJobView> {
    await this.init()
    return this.downloads.status(jobId)
  }

  /** Cancel one download job. */
  async cancelRemoteDownload(jobId: string): Promise<boolean> {
    await this.init()
    return this.downloads.cancel(jobId)
  }

  async shutdown(): Promise<void> {
    // Stop reacting to watchdog events before the hosts are torn down: a re-attach or a listener
    // rebuild started by a closing episode has nowhere to land. Idempotent.
    this.uninstallWatchdog?.()
    this.uninstallWatchdog = null
    this.ctx.state.disposed = true
    this.ctx.progress.dispose()
    this.downloads.dispose()
    await shutdownAll(this.ctx)
  }
}

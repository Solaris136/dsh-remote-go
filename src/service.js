/**
 * Orchestration service: host state machine, connect pipeline
 * (SSH → probe → bootstrap → start → tunnel → verify), auto-reconnect,
 * keep-alive policy and diagnostics (design §5, §8, §16.4).
 *
 * Everything external is injected so the whole pipeline can be unit-tested
 * with fakes (no real SSH, no timers).
 */
import { EventEmitter } from 'node:events'
import {
  DEFAULT_IDLE_MINUTES,
  REMOTE_START_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
  TUNNEL_PROBE_TIMEOUT_MS,
} from './constants.js'
import { errors, toErrorView } from './errors.js'
import { remoteLayout } from './layout.js'
import { loadLocalSshMaterial } from './local-ssh.js'
import { findKnownHostEntries, parseKnownHosts, summarizeKnownHosts } from './known-hosts.js'
import { probeRemote, describeProbeCapabilities } from './probe.js'
import { executeBootstrap, planBootstrap, verifyInstalledVersion } from './bootstrap.js'
import { discoverSshAliases as discoverAliasesFromConfig, resolveDestination } from './ssh-config.js'
import { parseSshConfig } from './ssh-config.js'
import { SshConnection } from './ssh.js'
import { createTunnel } from './tunnel.js'
import {
  adoptRemoteWeb,
  exchangeTokenOverTunnel,
  remoteHttpStatus,
  startRemoteWeb,
  stopRemoteWeb,
  waitForRemoteUi,
} from './webapp.js'
import { randomBytes } from 'node:crypto'
import { nowIso, randomDelay } from './util.js'
import { normalizeVersion, versionParity, versionsEqual } from './version.js'
import { resolveTargetVersion } from './local-version.js'
import {
  DEFAULT_EPOCH_JUMP_LIMIT,
  MIRROR_LEASE_TTL_MS,
  acquireLease,
  assertWritable,
  currentEpoch,
  decideLevel,
  l1Capabilities,
  observeRemoteLease,
  planMirror,
  reconcileMirrors,
  renewLease,
} from './mirror.js'
import { MirrorStore } from './mirror-store.js'
import { HISTORY_LIMITS, fetchRemoteHistory, foldNoticeRange, planHistoryWindow, recoveredCursor } from './history.js'
import {
  LEASE_LIMITS,
  buildLeaseRecord,
  buildLeaseReleaseCommand,
  fetchRemoteLease,
  remoteLeaseFile,
  leaseExpiryFor,
  publishRemoteLease,
} from './lease.js'
import { mergeDescriptorDeltas, withMirrorQueue, withMirrorWriter } from './mirror-writer.js'
import { readLocalWorkspaces, readRemoteWorkspaces } from './workspaces.js'

/** Milliseconds a paused host-key handshake waits for the user. */
export const HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000

/** @typedef {'unconfigured'|'connecting'|'fingerprint-pending'|'connected'|'disconnected'|'error'|'limited'} HostStatus */
/** @typedef {'ssh'|'probe'|'bootstrap'|'start'|'tunnel'|'ready'} ConnectPhase */

/**
 * @typedef {{
 *   store: import('./store.js').HostStore,
 *   home: string,
 *   logger?: { info?: (...a: any[]) => void, warn?: (...a: any[]) => void, debug?: (...a: any[]) => void, error?: (...a: any[]) => void },
 *   localVersion?: string | null,
 *   sshFactory?: (options: any) => any,
 *   tunnelFactory?: (options: any) => Promise<any>,
 *   probe?: typeof probeRemote,
 *   plan?: typeof planBootstrap,
 *   execute?: typeof executeBootstrap,
 *   startWeb?: typeof startRemoteWeb,
 *   stopWeb?: typeof stopRemoteWeb,
 *   waitUi?: typeof waitForRemoteUi,
 *   exchange?: typeof exchangeTokenOverTunnel,
 *   adopt?: typeof adoptRemoteWeb,
 *   loadSshMaterial?: typeof loadLocalSshMaterial,
 *   resolveTarget?: typeof resolveTargetVersion,
 *   mirrorStore?: import('./mirror-store.js').MirrorStore,
 *   sessionAdapter?: {
 *     ensureMirrorSession: (descriptor: any) => any,
 *     ensureMirrorCwd?: (descriptor: any) => Promise<string | null>,
 *     hasMirrorSession?: (localSessionId: string) => boolean,
 *     removeMirrorSession?: (localSessionId: string) => any,
 *   } | null,
 *   workspaceAdapter?: {
 *     ensureHostWorkspace: (request: any) => Promise<any>,
 *     removeHostWorkspace?: (request: any) => Promise<any>,
 *   } | null,
 *   hostKeyConfirmTimeoutMs?: number,
 *   clock?: () => number,
 * }} ServiceOptions
 */

/**
 * @param {any} runtime
 */
function emptyRemote() {
  return {
    version: null,
    uiReady: false,
    localPort: null,
    port: null,
    pid: null,
    dshHome: null,
    bootstrapLevel: null,
    nodeVersion: null,
    startedAt: null,
  }
}

export class RemoteGoService extends EventEmitter {
  /** @param {ServiceOptions} options */
  constructor(options) {
    super()
    this.options = options
    this.store = options.store
    this.home = options.home
    this.logger = options.logger ?? console
    this.localVersion = options.localVersion ?? null
    this.localVersionSource = 'unknown'
    this.sshFactory = options.sshFactory ?? ((sshOptions) => new SshConnection(sshOptions))
    this.tunnelFactory = options.tunnelFactory ?? createTunnel
    this.probe = options.probe ?? probeRemote
    this.plan = options.plan ?? planBootstrap
    this.execute = options.execute ?? executeBootstrap
    this.startWeb = options.startWeb ?? startRemoteWeb
    this.stopWeb = options.stopWeb ?? stopRemoteWeb
    this.waitUi = options.waitUi ?? waitForRemoteUi
    this.exchange = options.exchange ?? exchangeTokenOverTunnel
    this.adopt = options.adopt ?? adoptRemoteWeb
    this.loadSshMaterial = options.loadSshMaterial ?? loadLocalSshMaterial
    this.resolveTarget = options.resolveTarget ?? resolveTargetVersion
    this.mirrorStore = options.mirrorStore ?? new MirrorStore({ dir: options.store.dir, logger: this.logger })
    this.sessionAdapter = options.sessionAdapter ?? null
    // Optional: registers one sidebar workspace per host so the mirrored local
    // sessions are grouped where DSH's sidebar actually lists them.
    this.workspaceAdapter = options.workspaceAdapter ?? null
    this.hostKeyConfirmTimeoutMs = options.hostKeyConfirmTimeoutMs ?? HOST_KEY_CONFIRM_TIMEOUT_MS
    this.clock = options.clock ?? (() => Date.now())
    // L3 prerequisite (design §6.2): every mirror write carries a fencing epoch, and the
    // writer id identifies *which* local side holds it. Stable per host so a restart
    // resumes its own lease instead of looking like a competing writer.
    this.leaseTtlMs = options.leaseTtlMs ?? MIRROR_LEASE_TTL_MS
    this.epochJumpLimit = options.epochJumpLimit ?? LEASE_LIMITS.epochJumpLimit ?? DEFAULT_EPOCH_JUMP_LIMIT
    /** @type {Map<string, any>} */
    this.runtimes = new Map()
    this.activeHostId = null
    this.disposed = false
    this.initialized = false
  }

  async init() {
    if (this.initialized) return this
    await this.store.load()
    if (this.mirrorStore && typeof this.mirrorStore.load === 'function') await this.mirrorStore.load()
    for (const host of this.store.listHosts()) this.#ensureRuntime(host)
    // Repairs ghosts a failed unregister left behind (fix for an empty group with
    // no host); no-op when the optional registry is absent.
    await this.#pruneOrphanWorkspaces()
    this.initialized = true
    return this
  }

  /** @param {string | null} version */
  setLocalVersion(version, source = 'client') {
    if (version && normalizeVersion(version)) {
      this.localVersion = normalizeVersion(version)
      this.localVersionSource = source
      this.#emitState()
    }
  }

  /** @param {Record<string, any>} host */
  #ensureRuntime(host) {
    let runtime = this.runtimes.get(host.id)
    if (runtime) {
      runtime.entry = host
      return runtime
    }
    runtime = {
      id: host.id,
      entry: host,
      status: /** @type {HostStatus} */ ('unconfigured'),
      phase: /** @type {ConnectPhase | null} */ (null),
      progress: null,
      error: null,
      warning: null,
      fingerprint: host.pinnedFingerprint
        ? { sha256: host.pinnedFingerprint, keyType: 'pinned', status: 'pinned', pinned: host.pinnedFingerprint }
        : null,
      remote: emptyRemote(),
      ssh: null,
      jumpSsh: null,
      tunnel: null,
      token: null,
      password: null,
      facts: null,
      plan: null,
      exchange: null,
      pendingHostKey: null,
      desired: 'idle',
      reconnectAttempts: 0,
      reconnectTimer: null,
      idleTimer: null,
      connectPromise: null,
      mirrorSync: null,
      mirrorResync: null,
      closing: false,
      logs: [],
    }
    this.runtimes.set(host.id, runtime)
    return runtime
  }

  /** @param {string} id */
  #runtime(id) {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw errors.invalidInput('id', { zh: `未知主机 ${id}`, en: `Unknown host ${id}` })
    return runtime
  }

  /**
   * The clock every lease decision reads.
   *
   * Injected (constructor `clock`) so expiry and fencing are testable without sleeping for
   * real time — the tests advance a fake clock instead of waiting out a TTL.
   * @returns {number} epoch milliseconds
   */
  #now() {
    const value = typeof this.clock === 'function' ? this.clock() : Number.NaN
    return Number.isFinite(value) ? value : Date.now()
  }

  #log(runtime, level, ...args) {
    const line = `[dsh-remote-go:${runtime.id}] ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`
    if (runtime.logs.length > 200) runtime.logs.shift()
    runtime.logs.push({ at: nowIso(), level, line })
    const method = this.logger[level] ?? this.logger.info
    method?.(line)
  }

  #emitState() {
    try {
      this.emit('state', this.snapshot())
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] state listener failed:', error)
    }
  }

  #set(runtime, patch) {
    Object.assign(runtime, patch)
    this.#emitState()
  }

  #phase(runtime, phase, code, params) {
    runtime.phase = phase
    runtime.progress = { code, ...(params ? { params } : {}) }
    this.#emitState()
  }

  #progress(runtime, code, params) {
    runtime.progress = { code, ...(params ? { params } : {}) }
    this.#emitState()
  }

  /** Build the client-facing state snapshot (contract: docs/api.md). */
  snapshot() {
    const settings = this.store.getSettings()
    const localVersion = this.localVersion
    const hosts = [...this.runtimes.values()].map((runtime) => this.#hostView(runtime, settings))
    return {
      hostVersion: localVersion,
      targetVersion: this.#targetVersionForSnapshot(settings, localVersion).targetVersion,
      hosts,
      settings,
      activeHostId: this.activeHostId,
      firstRun: hosts.length === 0,
    }
  }

  /** @param {import('./settings.js').Settings} settings @param {string | null} localVersion */
  #targetVersionForSnapshot(settings, localVersion) {
    return this.resolveTarget({ configured: settings.bootstrap.targetVersion, localVersion })
  }

  /** @param {any} runtime @param {import('./settings.js').Settings} settings */
  #hostView(runtime, settings) {
    const entry = runtime.entry
    const target = this.#targetVersionForSnapshot(settings, this.localVersion)
    return {
      id: runtime.id,
      name: entry.name,
      address: entry.address,
      addressMasked: maskAddress(entry),
      /** Never the secret itself; lets the Client ask for a one-time password. */
      authType: entry.auth?.type ?? 'agent',
      jumpHost: entry.jumpHost ?? null,
      status: runtime.status,
      phase: runtime.phase,
      progress: runtime.progress,
      error: runtime.error,
      warning: runtime.warning,
      fingerprint: runtime.fingerprint,
      remote: {
        ...runtime.remote,
        version: runtime.remote.version ?? runtime.facts?.dshVersion ?? null,
      },
      keepAlive: entry.keepAlive,
      idleMinutes: entry.idleMinutes,
      autoReconnect: entry.autoReconnect,
      hostKeyPolicy: entry.hostKeyPolicy,
      lastOpenedAt: entry.lastOpenedAt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      targetVersion: target.targetVersion,
      versionParity: versionParity(target.targetVersion, runtime.remote.version ?? runtime.facts?.dshVersion ?? null),
    }
  }

  // ---------------------------------------------------------------- hosts

  /** @param {Record<string, any>} rawHost */
  async saveHost(rawHost) {
    await this.init()
    /** @type {Record<string, any>} */
    let entry
    try {
      entry = await this.store.upsertHost(rawHost, { settings: this.store.getSettings() })
    } catch (error) {
      if (error instanceof Error && error.message === 'address is required') {
        throw errors.invalidInput('address', {
          zh: '请填写服务器地址或 ~/.ssh/config 别名。',
          en: 'Enter a server address or an ~/.ssh/config alias.',
        })
      }
      if (error instanceof Error && error.message === 'address is invalid') {
        throw errors.invalidInput('address', { zh: '服务器地址格式不正确。', en: 'The server address is not valid.' })
      }
      throw errors.invalidInput('host', {
        zh: `主机配置不合法：${error instanceof Error ? error.message : String(error)}`,
        en: `Invalid host entry: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    this.#ensureRuntime(entry)
    this.#emitState()
    return this.#hostView(this.#runtime(entry.id), this.store.getSettings())
  }

  /** @param {string} id */
  async removeHost(id) {
    await this.init()
    const runtime = this.runtimes.get(id)
    if (runtime) await this.#teardownRuntime(runtime, { stopRemote: runtime.entry.keepAlive === 'stop' ? true : false })
    this.runtimes.delete(id)
    await this.store.removeHost(id)
    // Drop the local mirror sessions and their descriptors with the host, so no
    // orphan session points at a host the user just deleted.
    for (const descriptor of this.mirrorStore.listMirrors({ hostId: id })) {
      try {
        this.sessionAdapter?.removeMirrorSession?.(descriptor.localSessionId)
      } catch (error) {
        this.logger.warn?.('[dsh-remote-go] cannot remove a mirror session:', error)
      }
    }
    await this.#removeMirrorsForHost(id, runtime)
    // Remove the host's sidebar workspace too: its directory stays (session logs
    // live elsewhere), but the group must not outlive the host it represents. A
    // failure here is repaired by the startup sweep, so it never blocks deletion.
    if (this.workspaceAdapter) {
      const removed = await this.#callWorkspaceAdapter(null, 'removeHostWorkspace', { hostId: id })
      if (removed?.ok !== true) {
        this.logger.warn?.(
          `[dsh-remote-go] could not remove the mirror workspace for ${id}: ${removed?.reason ?? 'unknown'}`,
        )
      }
    }
    if (this.activeHostId === id) this.activeHostId = null
    this.#emitState()
    return { ok: true }
  }

  /** @param {string} id */
  setActiveHost(id) {
    if (id !== null && !this.runtimes.has(id)) throw errors.invalidInput('id')
    this.activeHostId = id
    this.#emitState()
  }

  /** @param {Record<string, any>} patch */
  async saveSettings(patch) {
    await this.init()
    const settings = await this.store.saveSettings(patch)
    this.#emitState()
    return settings
  }

  /**
   * Local DSH workspaces for the panel's "local workspaces" group.
   * @returns {Promise<Record<string, unknown>>}
   */
  async listLocalWorkspaces() {
    const result = await readLocalWorkspaces({ home: this.home })
    return {
      source: result.source,
      initialized: result.initialized,
      defaultWorkspaceId: result.defaultWorkspaceId,
      workspaces: result.workspaces.map((workspace) => ({ ...workspace, origin: 'local' })),
    }
  }

  /**
   * Workspaces of one remote DSH (read over the existing SSH session, same
   * durable registry format). Returns `connected:false` instead of throwing when
   * the host is not connected so the panel can render the group placeholder.
   * @param {string} id
   */
  async listHostWorkspaces(id) {
    await this.init()
    const runtime = this.#runtime(id)
    if (!runtime.ssh?.connected) {
      return {
        hostId: id,
        hostName: runtime.entry.name,
        connected: false,
        workspaces: [],
        initialized: false,
        defaultWorkspaceId: null,
      }
    }
    const layout = remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null)
    const result = await readRemoteWorkspaces(runtime.ssh, layout.home)
    return {
      hostId: id,
      hostName: runtime.entry.name,
      connected: true,
      dshHome: layout.home,
      ok: result.ok,
      reason: result.reason ?? null,
      initialized: result.initialized,
      defaultWorkspaceId: result.defaultWorkspaceId,
      workspaces: result.workspaces.map((workspace) => ({
        ...workspace,
        origin: 'remote',
        hostId: id,
        hostName: runtime.entry.name,
      })),
    }
  }

  // ---------------------------------------------------------------- mirrors

  /**
   * Persisted mirror descriptors of one host (P0: L1 directory mirrors).
   * Read-only: descriptors are reconciled when a host connects or when
   * `syncHostMirrors()` is called explicitly, never on a GET. A resync notice
   * produced by the connect-time background sync stays visible here until a
   * client acknowledges it, so the documented "restart → re-pull" obligation is
   * reachable without waiting for the next sync.
   * @param {string} id
   */
  async listHostMirrors(id) {
    await this.init()
    const runtime = this.#runtime(id)
    const decision = this.#mirrorDecision(runtime)
    return {
      hostId: id,
      hostName: runtime.entry.name,
      connected: Boolean(runtime.ssh?.connected),
      level: decision.level,
      reason: decision.reason,
      capabilities: decision.capabilities,
      sessionsAvailable: Boolean(this.sessionAdapter),
      ...this.#pendingResync(runtime),
      mirrors: this.mirrorStore.listMirrors({ hostId: id }),
    }
  }

  /**
   * Re-read the remote workspace registry and reconcile the mirror descriptors
   * (design §4 L1). Never creates or deletes anything on the remote; a session
   * that disappeared from the registry is kept and marked `remote-deleted`
   * (design §7). The result also carries the per-session adapter outcomes so the
   * "restart → re-pull from the remote" notice is reachable from the API.
   * @param {string} id
   * @param {{ acknowledgeResync?: boolean }} [options]
   */
  async syncHostMirrors(id, options = {}) {
    await this.init()
    const runtime = this.#runtime(id)
    if (runtime.mirrorSync) {
      // Never run two directory syncs at once for one host; coalesce on the
      // in-flight one started by the connect pipeline.
      await runtime.mirrorSync.catch(() => null)
    }
    if (options.acknowledgeResync === true) runtime.mirrorResync = null
    if (!runtime.ssh?.connected) {
      return {
        hostId: id,
        connected: false,
        synced: false,
        reason: 'not-connected',
        sessionsAvailable: Boolean(this.sessionAdapter),
        ...this.#pendingResync(runtime),
        truncated: 0,
        skipped: 0,
        mirrors: this.mirrorStore.listMirrors({ hostId: id }),
      }
    }
    return this.#syncMirrors(runtime)
  }

  /**
   * The resync notice a client has not acknowledged yet (set by the background
   * connect sync, kept until `acknowledgeResync`).
   * @param {any} runtime
   */
  #pendingResync(runtime) {
    const pending = runtime.mirrorResync ?? null
    return { resyncRequired: pending?.resyncRequired ?? 0, notice: pending?.notice ?? null }
  }

  /** @param {any} runtime */
  #mirrorDecision(runtime) {
    // L2: the history channel is read over SSH `exec`, the same transport L1 already
    // uses. It is only *claimable* when there is somewhere to replay into — without a
    // session adapter there are no local sessions, so the host stays at L1 and the
    // descriptors keep their directory-level annotation.
    const historyEnabled = this.store.getSettings()?.mirrorHistory !== false && Boolean(this.sessionAdapter)
    return decideLevel({
      hostVersion: runtime.remote.version ?? runtime.facts?.dshVersion ?? null,
      localVersion: this.localVersion,
      probe: { ...l1Capabilities(), history: historyEnabled },
    })
  }

  /** @param {any} runtime */
  async #syncMirrors(runtime) {
    const layout = remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null)
    const result = await readRemoteWorkspaces(runtime.ssh, layout.home)
    const existing = this.mirrorStore.listMirrors({ hostId: runtime.id })
    const decision = this.#mirrorDecision(runtime)
    if (!result.ok) {
      // Offline or unreadable: keep the last known descriptors instead of
      // marking every remote session deleted (design §7 "host not connected").
      return {
        hostId: runtime.id,
        synced: false,
        reason: result.reason ?? 'unreadable',
        sessionsAvailable: Boolean(this.sessionAdapter),
        ...this.#pendingResync(runtime),
        truncated: 0,
        skipped: 0,
        mirrors: existing,
      }
    }
    if (existing.length > 0 && result.workspaces.length === 0) {
      // A parseable but empty registry is far more likely to be a transient
      // (fresh/partially-written) remote file than "the user deleted every
      // session". Keep every record instead of marking all of them deleted.
      return {
        hostId: runtime.id,
        synced: false,
        reason: 'empty-registry',
        sessionsAvailable: Boolean(this.sessionAdapter),
        ...this.#pendingResync(runtime),
        truncated: 0,
        skipped: 0,
        mirrors: existing,
      }
    }
    const now = nowIso()
    const planned = planMirror({
      host: runtime.entry,
      remoteWorkspaces: result,
      capabilities: decision.capabilities,
      existing,
      now,
      // §7: annotate every mirrored session with the level/reason decided for
      // this host, not only the host summary. Without a session adapter there is
      // nothing to replay into, so the descriptors must not claim L2.
      decision: this.sessionAdapter ? decision : { ...decision, level: 'L1' },
    })
    // Reconcile through the single writer: it reads the current descriptors, applies the delta and
    // persists, so a stream apply that landed meanwhile cannot be clobbered by this snapshot.
    /** @type {any} */
    let reconciled = reconcileMirrors({ existing, planned })
    const mirrors = await this.#mutateMirrors(runtime, (current) => {
      // Always reconcile against what is stored *now*. The old `current.length > 0 ? current :
      // existing` fallback reconciled against a snapshot taken before any deletion, which is the
      // second way a deleted host's mirrors came back.
      reconciled = reconcileMirrors({ existing: current, planned })
      return reconciled.mirrors
    })
    const sessionRun = await this.#ensureMirrorSessions(runtime, mirrors)
    const sessions = sessionRun.results
    // L2: replay history into the sessions that were just created (design §3 L2,
    // §6 cursor, §7 failure modes). Runs after the session step because there is
    // nothing to append into before it; failures never affect the connect result.
    const historyRun = await this.#syncMirrorHistory(runtime, mirrors, sessions, decision)
    const mirrorsWithHistory = historyRun.mirrors
    const sidebar = await this.#ensureHostWorkspace(runtime, mirrorsWithHistory, sessions)
    const freshRequired = sessions.filter((entry) => entry?.resync?.needed === true).length
    if (freshRequired > 0) {
      // Keep the notice until a client acknowledges it: the client's own sync
      // finds the sessions already live and would otherwise never see it.
      runtime.mirrorResync = {
        resyncRequired: freshRequired,
        notice: sessions.find((entry) => entry?.resync?.notice)?.resync.notice ?? null,
        at: nowIso(),
      }
    }
    return {
      hostId: runtime.id,
      synced: true,
      // The host summary reports the *verified* level: L2 only once history was
      // actually replayed this sync (or had been replayed before, i.e. a cursor).
      level: historyRun.level ?? decision.level,
      reason: historyRun.reason ?? decision.reason,
      sessionsAvailable: Boolean(this.sessionAdapter),
      ...this.#pendingResync(runtime),
      mirrors: mirrorsWithHistory,
      markedDeleted: reconciled.markedDeleted,
      revived: reconciled.revived,
      sessions,
      sessionLimit: sessionRun.limit,
      truncated: sessionRun.truncated,
      skipped: sessionRun.skipped,
      history: historyRun.summary,
      sidebar,
    }
  }

  /**
   * Report a per-session history failure at `info` level.
   *
   * The typed `reason` code plus the remote session id is what an operator needs
   * to tell "the remote log has a hole" from "the transport broke", so a §7
   * failure must be diagnosable from a normal log, not only from the `debug`
   * aggregation. It is emitted while the descriptors are still being collected,
   * i.e. before they are persisted, so a log line always exists by the time the
   * new mirror state is observable.
   * @param {any} runtime
   * @param {import('./mirror.js').MirrorDescriptor} descriptor
   * @param {string} reason
   */
  #logHistoryFailure(runtime, descriptor, reason) {
    this.#log(runtime, 'info', `mirror history failed for ${descriptor.remoteSessionId}: ${reason}`)
  }

  /**
   * L2: replay each mirror's remote history into its local session (design §3 L2).
   *
   * One SSH read per mirrored session, bounded by `HISTORY_LIMITS`; the projection
   * is `planHistoryWindow()` (pure, unit-tested) and the write goes through the
   * session adapter. Everything is idempotent twice over: the descriptor `cursor`
   * stops a re-sync from replaying, and `mirrorEventSeqs()` stops a crash between
   * "append" and "persist cursor" from duplicating (replayed events carry
   * `data.mirrorSeq`).
   *
   * Failure behaviour is design §7: a log that is missing, unreadable, truncated or
   * of an unknown version keeps the mirror exactly as it was — the descriptor gets a
   * typed `reason`, the cursor does **not** advance, and nothing is thrown into the
   * connect path. A `mirrorHistory:false` setting leaves every mirror at L1.
   *
   * @param {any} runtime
   * @param {import('./mirror.js').MirrorDescriptor[]} mirrors
   * @param {{ ok?: boolean, localSessionId?: string }[]} sessionResults
   * @param {{ level?: string, reason?: any, capabilities?: any } | null} [decision] the host-level
   *   level decision for this sync. History must respect it: a host that was
   *   downgraded (version mismatch, unreadable directory) must not replay, or the
   *   per-descriptor reason §7 requires is erased on the next sync.
   * @returns {Promise<{ mirrors: import('./mirror.js').MirrorDescriptor[], level: string | null, reason: any, summary: any }>}
   */
  async #syncMirrorHistory(runtime, mirrors, sessionResults, decision = null) {
    const settings = this.store.getSettings()
    const enabled = settings?.mirrorHistory !== false
    const maxEvents = Number(settings?.mirrorMaxEvents ?? 0)
    const summary = {
      enabled,
      attempted: 0,
      applied: 0,
      appended: 0,
      folded: 0,
      skipped: 0,
      /** Fencing events seen this sync (a stale writer refused to write). */
      fenced: 0,
      /** Epoch jumps too large to believe (refused, never adopted). */
      suspicious: 0,
      /** Same-`seq` payload conflicts reported by `applyEvents` (design §6.2). */
      conflicts: 0,
      /** The conflicting seqs, bounded by the caller's use of the plan's capped list. */
      conflictSeqs: [],
      failures: [],
    }
    // §7: a host whose mirror was refused must not gain history. Returning the
    // descriptors untouched keeps whatever `planMirror` stamped (the mismatch reason)
    // instead of overwriting it with `level: 'L2', reason: null`.
    // Only a *hard* refusal blocks: `version-mismatch` (the documented "do not build a
    // mirror" case) and `probe-missing`. `version-unknown` is deliberately allowed —
    // it is the transient state during the first connect sync, before the remote
    // version has been read, and history succeeding is itself the evidence that the
    // channel works.
    const blockedCode = typeof decision?.reason?.code === 'string' ? decision.reason.code : null
    const blocked = blockedCode === 'version-mismatch' || blockedCode === 'probe-missing'
    if (!enabled || blocked || !this.sessionAdapter) return { mirrors, level: null, reason: null, summary }

    const live = new Set(
      (Array.isArray(sessionResults) ? sessionResults : [])
        .filter((entry) => entry?.ok === true)
        .map((entry) => entry.localSessionId),
    )
    const layout = remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null)
    /** @type {import('./mirror.js').MirrorDescriptor[]} */
    const updated = []
    let appliedAny = false
    /** @type {any} */
    let firstReason = null

    for (const descriptor of mirrors) {
      if (descriptor.status !== 'active' || !live.has(descriptor.localSessionId)) {
        updated.push(descriptor)
        continue
      }
      summary.attempted += 1
      try {
        // ---- L3 prerequisite: fencing (design §6.2) --------------------------------
        // Every write below is gated on a lease whose `epoch` is current. The gate runs
        // before the remote read so a fenced writer does not even re-pull.
        const writer = leaseWriterId(runtime.id)
        const now = this.#now()
        const fenceState = {
          cursor: descriptor.cursor ?? 0,
          epoch: descriptor.epoch ?? 0,
          lease: descriptor.lease ?? null,
          // Needed so a repeat observation of the same fencing is recognised as the same
          // occurrence instead of being announced (or acted on) again.
          fencedWriter: descriptor.fencedWriter ?? null,
        }
        // Ask the remote whether someone else holds a newer grant. An absent authority is
        // normal (no L3 channel yet); a malformed one is reported, never read as "free".
        const authority = await fetchRemoteLease(runtime.ssh, {
          remoteDshHome: layout.home,
          remoteSessionId: descriptor.remoteSessionId,
        })
        if (authority.ok && authority.report) {
          const observed = observeRemoteLease(fenceState, {
            writer: authority.report.writer,
            epoch: authority.report.epoch,
            now,
            epochJumpLimit: this.epochJumpLimit,
            // Identifies "our own leftover record" (same writer id) versus a takeover.
            previousWriter: writer,
          })
          if (observed.suspicious === true) {
            // A jump too large to believe: refuse it, do not adopt it, and say so in the log.
            // Adopting would hand the lease to whoever published the biggest number.
            this.#log(
              runtime,
              'warn',
              `mirror lease: suspicious epoch jump for ${descriptor.remoteSessionId} ` +
                `(ours ${descriptor.epoch ?? 0}, reported ${authority.report.epoch}, limit ${this.epochJumpLimit}); refusing it`,
            )
            summary.suspicious += 1
          }
          if (observed.fenced) {
            summary.fenced += 1
            firstReason = firstReason ?? 'fenced'
            // Announce once per epoch: `fencedEpoch` on the descriptor makes a repeated
            // sync (or a crash-recovered one) silent until the number actually changes.
            const alreadyAnnounced = descriptor.fencedEpoch === observed.epoch
            if (!alreadyAnnounced) {
              this.sessionAdapter.appendEvent(descriptor.localSessionId, {
                type: 'mirror/fenced',
                data: {
                  readOnly: true,
                  epoch: observed.epoch,
                  remoteEpoch: authority.report.epoch,
                  remoteWriter: authority.report.writer,
                  reason: observed.reason,
                },
              })
            }
            summary.failures.push({ localSessionId: descriptor.localSessionId, reason: 'fenced' })
            updated.push({
              ...descriptor,
              // Adopt the newer epoch so our own next write is refused locally too, and
              // keep the cursor untouched: being fenced says nothing about the data.
              epoch: Math.max(descriptor.epoch ?? 0, observed.epoch),
              lease: null,
              level: 'L1',
              readOnly: true,
              fencedEpoch: observed.epoch,
              // Remembering *who* fenced us is what makes the repeat silent: the next sync
              // re-observes the same writer at the same epoch and must not announce it again.
              fencedWriter: observed.holder ?? authority.report.writer ?? null,
              reason: historyReason('fenced'),
              mirroredAt: nowIso(),
            })
            continue
          }
        }

        // (Re)acquire or renew our own lease; a live lease held by someone else refuses.
        const acquired = acquireLease(fenceState, { owner: writer, now, ttlMs: this.leaseTtlMs })
        if (!acquired.ok) {
          summary.fenced += 1
          firstReason = firstReason ?? 'lease-held-by-other'
          summary.failures.push({ localSessionId: descriptor.localSessionId, reason: acquired.reason })
          updated.push({
            ...descriptor,
            level: 'L1',
            readOnly: true,
            reason: historyReason('fenced'),
            mirroredAt: nowIso(),
          })
          continue
        }
        const renewed = renewLease(acquired.state, { owner: writer, now, ttlMs: this.leaseTtlMs })
        const claimed = renewed.ok ? renewed : acquired
        const writeEpoch = currentEpoch(claimed.state)
        const writable = assertWritable(claimed.state, { owner: writer, epoch: writeEpoch, now })
        if (!writable.ok) {
          summary.fenced += 1
          firstReason = firstReason ?? 'fenced'
          summary.failures.push({ localSessionId: descriptor.localSessionId, reason: writable.reason })
          updated.push({
            ...descriptor,
            epoch: Math.max(descriptor.epoch ?? 0, writeEpoch),
            lease: claimed.state.lease ?? null,
            level: 'L1',
            readOnly: true,
            reason: historyReason('fenced'),
            mirroredAt: nowIso(),
          })
          continue
        }
        // ---- publish our authority (design §6.2) -----------------------------------
        // The channel is only real if the remote can *refuse* us. Publish on every sync that
        // claims the lease (acquire or renew), and treat a refusal as "not authorized": we do
        // not fall back to writing anyway, because that would make the channel decorative.
        const sessionKey = runtime.leaseSessionKey ?? null
        if (sessionKey !== null) {
          const published = await publishRemoteLease(runtime.ssh, {
            remoteDshHome: layout.home,
            remoteSessionId: descriptor.remoteSessionId,
            record: buildLeaseRecord({
              writer,
              epoch: writeEpoch,
              expiresAt: leaseExpiryFor({ startedAt: now, ttlMs: this.leaseTtlMs }),
              sessionKey,
            }),
          })
          if (published.ok) {
            runtime.leasePublished = { writer, epoch: writeEpoch, sessionId: descriptor.remoteSessionId }
          }
          if (!published.ok) {
            // The remote said no. That is the enforcement half of the protocol: a partitioned
            // writer that ignored its own local check still cannot take the lease.
            summary.fenced += 1
            if (published.reason === 'implausible-epoch') summary.suspicious += 1
            firstReason = firstReason ?? 'fenced'
            this.#log(
              runtime,
              'warn',
              `mirror lease: publish refused for ${descriptor.remoteSessionId}: ${published.reason}`,
            )
            summary.failures.push({ localSessionId: descriptor.localSessionId, reason: published.reason })
            updated.push({
              ...descriptor,
              epoch: Math.max(descriptor.epoch ?? 0, writeEpoch),
              lease: null,
              level: 'L1',
              readOnly: true,
              reason: historyReason('fenced'),
              mirroredAt: nowIso(),
            })
            continue
          }
        }
        /** Descriptor fields the successful write must carry. */
        const leaseFields = {
          epoch: writeEpoch,
          lease: claimed.state.lease ?? null,
          writable: true,
        }

        const remote = await fetchRemoteHistory(runtime.ssh, {
          remoteDshHome: layout.home,
          remoteSessionId: descriptor.remoteSessionId,
          maxEvents: HISTORY_LIMITS.maxEvents,
        })
        if (!remote.ok) {
          // Typed failure: annotate, keep the cursor, retry next sync.
          summary.failures.push({ localSessionId: descriptor.localSessionId, reason: remote.reason })
          firstReason = firstReason ?? remote.reason
          this.#logHistoryFailure(runtime, descriptor, remote.reason)
          updated.push({
            ...descriptor,
            level: 'L1',
            reason: historyReason(remote.reason),
          })
          continue
        }

        const alreadyThere = this.sessionAdapter.mirrorEventSeqs?.(descriptor.localSessionId) ?? new Set()
        /** @type {any[]} */
        const appended = []
        /** @type {string | null} */
        let appendFailed = null
        /**
         * Apply one planned window to the local session.
         * @param {{ append: any[], folded: number }} plan
         * @returns {boolean} whether the append succeeded
         */
        const applyPlan = (plan) => {
          if (plan.folded > 0) {
            // Announce the fold once, with the range that was actually skipped. The
            // fetch keeps only the newest `HISTORY_LIMITS.maxEvents` records, so the
            // folded prefix for a very long log starts later than seq 1 — computing it
            // from the retained window is the only honest answer.
            const firstKept = plan.append[0]?.seq ?? 1
            const { from: foldedFrom, to: foldedTo } = foldNoticeRange({
              firstKeptSeq: firstKept,
              folded: plan.folded,
            })
            const result = this.sessionAdapter.appendEvent(descriptor.localSessionId, {
              type: 'mirror/history-folded',
              data: {
                mirrorSeq: firstKept,
                folded: plan.folded,
                from: foldedFrom,
                to: foldedTo,
                retained: plan.append.length,
                // Which cap governed the window, so a reader is not left guessing.
                retentionCap: maxEvents,
                fetchCap: HISTORY_LIMITS.maxEvents,
              },
            })
            if (result?.ok !== true) {
              appendFailed = result?.reason ?? 'append-failed'
              return false
            }
          }
          for (const event of plan.append) {
            if (alreadyThere.has(event.seq)) continue
            const result = this.sessionAdapter.appendEvent(descriptor.localSessionId, {
              type: event.type,
              data: { ...event.data, mirrorSeq: event.seq },
            })
            if (result?.ok !== true) {
              appendFailed = result?.reason ?? 'append-failed'
              return false
            }
            appended.push(event.seq)
          }
          return true
        }

        let cursor = descriptor.cursor
        let plan = planHistoryWindow({
          cursor,
          events: remote.events,
          maxEvents,
          // Folding the prefix is only legitimate when nothing has been applied yet.
          foldBeforeCursor: cursor === 0,
        })

        if (plan.gap) {
          // Design §6 recovery: the remote dropped the range the cursor points at
          // (or the log outgrew the fetch window). Resetting to a full re-pull is
          // the documented fallback; retrying the same unreachable window forever
          // would stall the mirror permanently.
          summary.recovered = (summary.recovered ?? 0) + 1
          this.#log(
            runtime,
            'info',
            `mirror history: cursor ${cursor} is unreachable for ${descriptor.remoteSessionId}; re-pulling the full log`,
          )
          cursor = 0
          const full = await fetchRemoteHistory(runtime.ssh, {
            remoteDshHome: layout.home,
            remoteSessionId: descriptor.remoteSessionId,
            maxEvents: HISTORY_LIMITS.maxEvents,
          })
          if (!full.ok) {
            summary.failures.push({ localSessionId: descriptor.localSessionId, reason: full.reason })
            firstReason = firstReason ?? full.reason
            this.#logHistoryFailure(runtime, descriptor, full.reason)
            updated.push({ ...descriptor, level: 'L1', reason: historyReason(full.reason) })
            continue
          }
          plan = planHistoryWindow({ cursor: 0, events: full.events, maxEvents, foldBeforeCursor: true })
          if (plan.gap) {
            // Still discontinuous after a full re-pull: the remote log itself has holes.
            // Report it and keep the cursor **monotonic**: the session already holds the
            // events up to `descriptor.cursor`, so a plan computed from 0 must not move the
            // descriptor backwards (a log that does not start at seq 1 would resolve to 0
            // while events 1..N are still in the session). The mirror stays L1 with a typed
            // reason until the log becomes readable in one piece again.
            summary.failures.push({ localSessionId: descriptor.localSessionId, reason: 'gap-unfilled' })
            firstReason = firstReason ?? 'gap-unfilled'
            this.#logHistoryFailure(runtime, descriptor, 'gap-unfilled')
            updated.push({
              ...descriptor,
              // Never backwards: the recovery plan is computed from 0, so for a log that
              // does not start at seq 1 it can resolve below what this descriptor already
              // applied. `recoveredCursor` keeps the larger value (see its docs).
              cursor: recoveredCursor(descriptor.cursor, plan.cursor),
              level: 'L1',
              reason: historyReason('gap-unfilled'),
              mirroredAt: nowIso(),
            })
            continue
          }
        }

        // Re-check the lease **immediately before the write batch** (design §6.2).
        //
        // The earlier check (`:798`) runs before the two bounded SSH reads, and those can
        // take up to 20 s each against a 30 s TTL: a slow sync could otherwise outlive its
        // own lease and still append. This second call is pure (no I/O) and re-reads the
        // injected clock, so the TTL is actually enforced at the moment of writing rather
        // than at the moment of deciding to try.
        const late = assertWritable(claimed.state, { owner: writer, epoch: writeEpoch, now: this.#now() })
        if (!late.ok) {
          summary.fenced += 1
          firstReason = firstReason ?? 'fenced'
          summary.failures.push({ localSessionId: descriptor.localSessionId, reason: late.reason })
          updated.push({
            ...descriptor,
            epoch: Math.max(descriptor.epoch ?? 0, writeEpoch),
            lease: null,
            level: 'L1',
            readOnly: true,
            reason: historyReason('fenced'),
            mirroredAt: nowIso(),
          })
          continue
        }

        if (!applyPlan(plan)) {
          // Partial append: do not persist a cursor past what landed. The
          // `mirrorSeq` guard makes the next sync continue from the real position.
          summary.failures.push({ localSessionId: descriptor.localSessionId, reason: appendFailed })
          firstReason = firstReason ?? appendFailed
          this.#logHistoryFailure(runtime, descriptor, appendFailed)
          updated.push(descriptor)
          continue
        }

        if (descriptor.readOnly !== true) {
          // Design §10 P1 asks for a清晰 read-only marker. L2 has no input channel yet
          // (`capabilities.input === false`), so the replay announces itself once, as a
          // non-surface notice: a reader can tell mirrored history from local input
          // without the plugin pretending it can send anything back.
          this.sessionAdapter.appendEvent(descriptor.localSessionId, {
            type: 'mirror/read-only',
            data: {
              readOnly: true,
              level: 'L2',
              // Kept in sync with the descriptor so a client that only sees the session
              // can still explain why nothing can be typed into it.
              capabilities: { input: false, stream: false, approve: false },
            },
          })
        }

        appliedAny = appliedAny || plan.applied > 0
        summary.applied += plan.applied
        summary.appended += appended.length
        summary.folded += plan.folded
        summary.skipped += Math.max(0, plan.append.length - appended.length)
        // Conflict reporting (design §6.2): same-seq records whose payloads disagree are
        // reported here instead of vanishing. The counter is cumulative per descriptor.
        if (plan.conflicts && plan.conflicts.length > 0) {
          summary.conflicts += plan.conflicts.length
          summary.conflictSeqs.push(...plan.conflicts.map((conflict) => conflict.seq))
        }
        updated.push({
          ...descriptor,
          cursor: plan.cursor,
          level: 'L2',
          reason: null,
          // Mirrored history is a projection of a remote session: the *session* is
          // read-only until L3 delivers input/approval forwarding (design §4). That is a
          // different fact from `writable` below, which says whether this mirror currently
          // holds the write lease; being writable must not make the session look editable.
          readOnly: true,
          writable: leaseFields.writable,
          // The lease that authorized this write, so the next sync renews instead of
          // re-acquiring and the epoch survives a restart (design §6.2).
          epoch: leaseFields.epoch,
          lease: leaseFields.lease,
          fencedEpoch: null,
          conflicts: plan.conflicts.length > 0 ? plan.conflicts : descriptor.conflicts,
          conflictCount: (descriptor.conflictCount ?? 0) + plan.conflicts.length,
          mirroredAt: nowIso(),
        })
      } catch (error) {
        // Never let history break the sync: record and keep the descriptor.
        const reason = error instanceof Error ? error.message : String(error)
        summary.failures.push({ localSessionId: descriptor.localSessionId, reason: 'read-failed' })
        firstReason = firstReason ?? 'read-failed'
        updated.push(descriptor)
        this.#logHistoryFailure(runtime, descriptor, 'read-failed')
        this.#log(runtime, 'debug', `mirror history read error for ${descriptor.remoteSessionId}: ${reason}`)
      }
    }

    const changed = updated.some((descriptor, index) => descriptor !== mirrors[index])
    const persisted = changed
      ? await this.#mutateMirrors(runtime, (current) => this.#mergeDelta(current, updated))
      : updated
    const anyL2 = persisted.some((descriptor) => descriptor.status === 'active' && descriptor.level === 'L2')
    this.#log(
      runtime,
      'info',
      `mirror history: ${summary.attempted} session(s) / ${summary.applied} event(s) applied / ` +
        `${summary.appended} appended / ${summary.folded} folded` +
        (summary.failures.length > 0
          ? ` (failed: ${[...new Set(summary.failures.map((entry) => entry.reason))].join(', ')})`
          : ''),
    )
    return {
      mirrors: persisted,
      level: anyL2 ? 'L2' : appliedAny ? 'L2' : null,
      reason: firstReason === null ? null : historyReason(firstReason),
      summary,
    }
  }

  /**
   * Create the local DSH sessions that back the mirrors, when the host publishes
   * the optional `sessions` service. Absent adapter ⇒ no sessions, no error.
   *
   * `mirrorMaxSessions` caps how many descriptors get a local session per sync
   * (0 = unlimited). The cap only limits **creation**: it never removes an
   * existing session, so lowering it cannot orphan sessions a previous sync
   * created; descriptors beyond the cap whose session already exists are not
   * reported as skipped. Typed adapter failures are counted and logged instead of
   * being swallowed (design §4: no silent pretend success).
   * @param {any} runtime
   * @param {import('./mirror.js').MirrorDescriptor[]} mirrors
   * @returns {Promise<{ results: any[], limit: number, total: number, attempted: number, truncated: number, skipped: number }>}
   */
  async #ensureMirrorSessions(runtime, mirrors) {
    const active = mirrors.filter((descriptor) => descriptor.status === 'active')
    const configured = Number(this.store.getSettings()?.mirrorMaxSessions ?? 0)
    const limit = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0
    const selected = limit > 0 ? active.slice(0, limit) : active
    const dropped = active.slice(selected.length)
    const empty = { results: [], limit, total: active.length, attempted: selected.length, truncated: 0, skipped: 0 }
    if (!this.sessionAdapter) return { ...empty, truncated: dropped.length, skipped: dropped.length }
    /** @type {any[]} */
    const results = []
    for (const descriptor of selected) {
      try {
        // The per-host cwd must exist before the host keys storage off it.
        await this.sessionAdapter.ensureMirrorCwd?.(descriptor)
        results.push(this.sessionAdapter.ensureMirrorSession(descriptor))
      } catch (error) {
        results.push({
          ok: false,
          reason: 'adapter-error',
          localSessionId: descriptor.localSessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    let skipped = 0
    for (const descriptor of dropped) {
      // A descriptor whose session already exists is merely over the cap for new
      // creation; it is not skipped work and its session must stay alive.
      if (this.sessionAdapter.hasMirrorSession?.(descriptor.localSessionId) !== true) skipped += 1
    }
    const created = results.filter((entry) => entry?.ok === true).length
    const reasons = [
      ...new Set(results.filter((entry) => entry?.ok !== true).map((entry) => entry?.reason ?? 'unknown')),
    ]
    this.#log(
      runtime,
      'info',
      `mirror sessions: ${active.length} descriptor(s) / ${created} local session(s)` +
        (dropped.length > 0 ? ` / truncated ${dropped.length}` : '') +
        (reasons.length > 0 ? ` (failed: ${reasons.join(', ')})` : ''),
    )
    if (reasons.length > 0) this.#log(runtime, 'debug', `mirror session failure reasons: ${reasons.join(', ')}`)
    return { results, limit, total: active.length, attempted: selected.length, truncated: dropped.length, skipped }
  }

  /**
   * Register (or unregister) the host's mirror directory as a sidebar workspace.
   *
   * DSH's sidebar lists sessions per workspace and membership is derived from the
   * session header's canonical cwd, so the per-host directory the mirror sessions
   * already use must also exist as a workspace registration — otherwise every
   * mirrored session is invisible in the UI. `workspaceRegistry.create(path,
   * title)` is idempotent, and the adapter always resolves before creating, so a
   * reconnect never produces a duplicate.
   *
   * Degradations are explicit rather than silent: `mirrorToSidebar:false`
   * **unregisters** the group (a mere skip would leave it on screen forever), a
   * missing sessions service or a sync where every `sessions.create` failed means
   * there is nothing to group (`sessions-unavailable`, never an empty group), and
   * any adapter failure is logged and reported as `ok:false` without touching the
   * connect result.
   *
   * @param {any} runtime
   * @param {import('./mirror.js').MirrorDescriptor[]} mirrors
   * @param {{ ok?: boolean }[]} [sessionResults] outcomes of the session adapter.
   */
  async #ensureHostWorkspace(runtime, mirrors, sessionResults = []) {
    const settings = this.store.getSettings()
    const enabled = settings?.mirrorToSidebar !== false
    const active = mirrors.filter((descriptor) => descriptor.status === 'active')
    if (!this.workspaceAdapter) return { ok: false, enabled, reason: 'adapter-absent', path: null, workspaceId: null }
    if (!enabled) {
      // Turning the setting off must remove an existing group, not just stop
      // creating new ones: otherwise the "Remote: <host>" workspace stays in the
      // sidebar forever (the mirror sessions behind it are memory-only).
      const removed = await this.#callWorkspaceAdapter(runtime, 'ensureHostWorkspace', {
        hostId: runtime.id,
        hostName: runtime.entry?.name ?? null,
        enabled: false,
      })
      if (removed?.ok !== true) return { ...removed, enabled: false, reason: removed?.reason ?? 'adapter-error' }
      if (removed.removed === true) {
        this.#log(runtime, 'info', 'mirror sidebar workspace: unregistered (mirrorToSidebar is off)')
      } else {
        this.#log(runtime, 'debug', 'mirror sidebar workspace: disabled by settings (mirrorToSidebar)')
      }
      return removed
    }
    if (!this.sessionAdapter) {
      // No local sessions to group, so a workspace would only be an empty group.
      return { ok: true, enabled, reason: 'sessions-unavailable', path: null, workspaceId: null }
    }
    if (active.length === 0) {
      return { ok: true, enabled, reason: 'no-mirrors', path: null, workspaceId: null }
    }
    // Count every live mirror session, not only the ones this sync attempted: a
    // capped batch whose creates all failed still has live sessions from earlier
    // syncs, and reporting `sessions-unavailable` would contradict them.
    const grouped =
      typeof this.sessionAdapter.hasMirrorSession === 'function'
        ? active.filter((descriptor) => this.sessionAdapter.hasMirrorSession(descriptor.localSessionId) === true).length
        : sessionResults.filter((entry) => entry?.ok === true).length
    if (grouped === 0) {
      // Every `sessions.create` failed: registering now would show an empty group
      // that contradicts the documented `sessions-unavailable` meaning.
      this.#log(runtime, 'debug', 'mirror sidebar workspace: no local session was created, skipping the group')
      return { ok: true, enabled, reason: 'sessions-unavailable', path: null, workspaceId: null }
    }
    const result = await this.#callWorkspaceAdapter(runtime, 'ensureHostWorkspace', {
      hostId: runtime.id,
      hostName: runtime.entry?.name ?? null,
      enabled,
    })
    if (result?.ok === true) {
      // Reuse is the steady state (every re-sync hits it), so it stays at debug
      // level; only an actual create/retitle is worth an info line.
      const changed = result.created === true || result.renamed === true
      this.#log(
        runtime,
        changed ? 'info' : 'debug',
        `mirror sidebar workspace: ${result.created ? 'created' : result.renamed ? 'retitled' : 'reused'} ` +
          `${JSON.stringify(result.title ?? '')} (${grouped} session(s))`,
      )
    } else {
      this.#log(
        runtime,
        'warn',
        `mirror sidebar workspace unavailable: ${result?.reason ?? 'unknown'}` +
          (result?.error ? ` (${result.error})` : ''),
      )
    }
    return result
  }

  /** Shape of a sidebar result when the adapter is unusable. */
  #sidebarFailure(reason) {
    return { ok: false, enabled: true, reason, path: null, workspaceId: null }
  }

  /**
   * Call one adapter method, converting a throw (the adapters promise not to, but
   * a broken or third-party implementation might) into a typed failure so a
   * sidebar problem can never fail a connect or a delete.
   *
   * @param {any} runtime
   * @param {string} method
   * @param {Record<string, any>} request
   */
  async #callWorkspaceAdapter(runtime, method, request) {
    const adapter = this.workspaceAdapter
    if (!adapter || typeof adapter[method] !== 'function') return this.#sidebarFailure('adapter-absent')
    try {
      const result = await adapter[method](request)
      return result ?? this.#sidebarFailure('no-result')
    } catch (error) {
      // The adapters promise never to throw; this is the belt-and-braces guard so
      // a broken or third-party implementation can never fail a connect or a
      // delete. `runtime` is null when the caller has no live runtime to log to.
      if (runtime && Array.isArray(runtime.logs)) {
        this.#log(runtime, 'warn', `mirror sidebar workspace ${method} failed: ${messageOf(error)}`)
      } else {
        this.logger.warn?.(`[dsh-remote-go] mirror sidebar workspace ${method} failed:`, error)
      }
      return this.#sidebarFailure('adapter-error')
    }
  }

  /**
   * Startup sweep: delete sidebar registrations under the mirror root whose host
   * no longer exists. A failed unregister used to leave a permanently empty
   * "Remote: …" group behind (mirror sessions are memory-only, so nothing ever
   * fills it again); this repairs such ghosts on the next load.
   */
  async #pruneOrphanWorkspaces() {
    if (!this.workspaceAdapter || typeof this.workspaceAdapter.pruneOrphanWorkspaces !== 'function') return null
    const hostIds = this.store.listHosts().map((host) => host.id)
    try {
      const result = await this.workspaceAdapter.pruneOrphanWorkspaces({ hostIds })
      if (result?.ok !== true) {
        this.logger.warn?.(
          '[dsh-remote-go] cannot prune orphan mirror workspaces:',
          result?.reason ?? 'unknown',
          result?.error ?? '',
        )
        return result ?? null
      }
      if (Array.isArray(result.removed) && result.removed.length > 0) {
        this.logger.info?.(`[dsh-remote-go] removed ${result.removed.length} orphan mirror workspace(s) with no host`)
      }
      return result
    } catch (error) {
      this.logger.warn?.('[dsh-remote-go] cannot prune orphan mirror workspaces:', error)
      return null
    }
  }

  /** Start one directory sync without blocking the caller. @param {any} runtime */
  #startMirrorSync(runtime) {
    if (runtime.mirrorSync) return runtime.mirrorSync
    runtime.mirrorSync = this.#syncMirrors(runtime)
      .then((synced) => {
        if (synced.mirrors.length > 0) {
          this.#log(runtime, 'info', `mirror directory: ${synced.mirrors.length} session(s), level ${synced.level}`)
        }
        return synced
      })
      .catch((error) => {
        // A mirror failure must never take the connection down (design §4).
        this.#log(
          runtime,
          'warn',
          'mirror directory sync failed:',
          error instanceof Error ? error.message : String(error),
        )
        return null
      })
      .finally(() => {
        runtime.mirrorSync = null
      })
    return runtime.mirrorSync
  }

  /** Read-only SSH discovery for the wizard (design §15.1). */
  async discoverSshAliases() {
    const material = await this.loadSshMaterial({ home: this.userHome() })
    const parsed = parseSshConfig(material.configText)
    const aliases = discoverAliasesFromConfig(parsed, { home: this.userHome() })
    const knownHosts = parseKnownHosts(material.knownHostsText)
    return {
      aliases: aliases.map((alias) => ({
        alias: alias.alias,
        host: alias.host,
        user: alias.user,
        port: alias.port,
        source: 'config',
      })),
      knownHosts: summarizeKnownHosts(knownHosts),
    }
  }

  /**
   * Update the keep-alive policy of one host (design §16.4).
   * @param {string} id
   * @param {{ keepAlive?: unknown, idleMinutes?: unknown }} policy
   */
  async updateHostPolicy(id, policy) {
    await this.init()
    const runtime = this.#runtime(id)
    /** @type {Record<string, any>} */
    const patch = {}
    if (['keep', 'stop', 'idle'].includes(String(policy.keepAlive))) patch.keepAlive = policy.keepAlive
    const idle = Number(policy.idleMinutes)
    if (Number.isFinite(idle)) patch.idleMinutes = Math.max(1, Math.min(24 * 60, Math.round(idle)))
    const entry = await this.store.patchHost(id, patch)
    if (entry) runtime.entry = entry
    this.#emitState()
    return this.#hostView(runtime, this.store.getSettings())
  }

  // -------------------------------------------------------------- connect

  /**
   * Start the connect pipeline. Returns immediately; progress travels on the
   * `state` event (see docs/api.md /events).
   * @param {string} id
   * @param {{ password?: string, rememberFingerprint?: boolean, overrideVersion?: boolean }} [options]
   */
  async connect(id, options = {}) {
    await this.init()
    const runtime = this.#runtime(id)
    if (runtime.connectPromise) return { accepted: false, reason: 'already-connecting' }
    if (runtime.status === 'connected' && runtime.ssh?.connected)
      return { accepted: false, reason: 'already-connected' }
    runtime.password = options.password ?? runtime.password
    runtime.rememberFingerprint = options.rememberFingerprint !== false
    runtime.overrideVersion = options.overrideVersion === true
    runtime.desired = 'connected'
    this.#cancelReconnect(runtime)
    runtime.connectPromise = this.#connectPipeline(runtime).finally(() => {
      runtime.connectPromise = null
    })
    return { accepted: true }
  }

  /** @param {string} id @param {{ stopRemote?: boolean }} [options] */
  async disconnect(id, options = {}) {
    await this.init()
    const runtime = this.#runtime(id)
    runtime.desired = 'idle'
    this.#cancelReconnect(runtime)
    const policy = runtime.entry.keepAlive
    const stopRemote = options.stopRemote === true || policy === 'stop'
    await this.#teardownRuntime(runtime, { stopRemote, keepSshForIdle: policy === 'idle' && !stopRemote })
    runtime.status = 'disconnected'
    runtime.phase = null
    runtime.progress = null
    runtime.remote.uiReady = false
    runtime.remote.localPort = null
    runtime.token = null
    this.#set(runtime, {})
    if (policy === 'idle' && !stopRemote) this.#scheduleIdleStop(runtime)
    return { ok: true }
  }

  /** @param {string} id */
  async reconnect(id) {
    const runtime = this.#runtime(id)
    await this.disconnect(id, { stopRemote: false })
    this.#cancelIdleStop(runtime)
    await this.#disposeSsh(runtime)
    return this.connect(id)
  }

  /**
   * @param {string} id
   * @param {{ accept: boolean, remember?: boolean, sha256?: string }} decision
   */
  async confirmFingerprint(id, decision) {
    const runtime = this.#runtime(id)
    const pending = runtime.pendingHostKey
    if (!pending)
      throw errors.invalidInput('fingerprint', {
        zh: '没有待确认的主机指纹。',
        en: 'No host key is pending confirmation.',
      })
    if (decision.sha256 && pending.sha256 && decision.sha256 !== pending.sha256) {
      throw errors.invalidInput('fingerprint', {
        zh: '确认的指纹与待确认的不一致。',
        en: 'The confirmed fingerprint does not match the pending one.',
      })
    }
    if (decision.accept && decision.remember) {
      await this.store.patchHost(runtime.id, { pinnedFingerprint: pending.sha256 })
      runtime.entry = { ...runtime.entry, pinnedFingerprint: pending.sha256 }
    }
    runtime.fingerprint = {
      sha256: pending.sha256,
      keyType: pending.keyType,
      status: 'pinned',
      pinned: decision.remember ? pending.sha256 : null,
    }
    runtime.pendingHostKey = null
    runtime.status = 'connecting'
    runtime.progress = { code: 'auth-checking' }
    pending.resolve(decision.accept === true)
    this.#emitState()
    return { ok: true }
  }

  /**
   * Open info for the iframe: a loopback URL carrying the one-shot launch token.
   * The token stays in memory (design §9.3).
   * @param {string} id
   */
  openInfo(id) {
    const runtime = this.#runtime(id)
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

  // ------------------------------------------------------------ pipeline

  /** @param {any} runtime */
  async #connectPipeline(runtime) {
    runtime.closing = false
    runtime.reconnectAttempts = 0
    this.#set(runtime, { status: 'connecting', error: null, warning: null })
    /** @type {boolean} */
    let remoteStarted = false
    try {
      const target = await this.#resolveTargetForRuntime(runtime)
      this.#phase(runtime, 'ssh', 'ssh-connecting', { host: runtime.entry.name })
      await this.#openTransport(runtime, target)
      this.#log(
        runtime,
        'info',
        `SSH connected to ${target.host}:${target.port} as ${target.username ?? '(default)'} (fingerprint ${runtime.fingerprint?.sha256 ?? 'unknown'})`,
      )

      this.#phase(runtime, 'probe', 'probing')
      const facts = await this.probe(runtime.ssh, { remoteDir: runtime.entry.bootstrap.remoteDir })
      runtime.facts = facts
      const capabilities = describeProbeCapabilities(facts)
      if (!capabilities.system.supported) throw errors.unsupportedOs(capabilities.system.name)

      const targetVersion = await this.#pickTargetVersion(runtime, facts)
      const plan = this.plan({
        facts,
        targetVersion,
        remoteDir: runtime.entry.bootstrap.remoteDir,
        mode: runtime.entry.bootstrap.mode,
        nodeVersion: runtime.entry.bootstrap.nodeVersion,
      })
      runtime.plan = plan
      this.#log(runtime, 'info', `bootstrap plan ${plan.level}: ${plan.reason.en}`)

      if (plan.steps.length > 0) {
        this.#phase(runtime, 'bootstrap', 'bootstrapping', { level: plan.level })
        await this.execute(runtime.ssh, plan, {
          onProgress: (progress) => {
            if (progress.state === 'running' && !progress.output) {
              this.#progress(runtime, 'bootstrap-progress', {
                template: progress.step.id,
                index: progress.index + 1,
                total: plan.steps.length,
                level: plan.level,
              })
            }
          },
        })
        await verifyInstalledVersion(runtime.ssh, plan)
      }

      this.#phase(runtime, 'start', 'starting-remote', { level: plan.level })
      const layout = remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null)
      let webInfo = null
      // Adopt an instance left running by a previous local process (keep-alive).
      try {
        const adopted = await this.adopt(runtime.ssh, layout)
        const adoptedVersion = adopted?.version ? normalizeVersion(adopted.version) : null
        const expectVersion =
          plan.level === 'T0' || plan.level === 'T0-local' || plan.level === 'T1'
            ? plan.start.targetVersion
            : plan.start.targetVersion
        if (adopted && (!adoptedVersion || versionsEqual(adoptedVersion, expectVersion))) {
          webInfo = { ...adopted, logPath: layout.logFile, startedAt: nowIso(), rawLine: '' }
          this.#log(runtime, 'info', `adopted running remote web pid=${adopted.pid} port=${adopted.port}`)
        } else if (adopted) {
          this.#log(
            runtime,
            'info',
            `running remote web version ${adoptedVersion} != ${expectVersion}; starting a matching instance`,
          )
        }
      } catch (error) {
        this.#log(runtime, 'debug', 'adopt check failed:', error instanceof Error ? error.message : String(error))
      }
      if (!webInfo) {
        webInfo = await this.startWeb(runtime.ssh, {
          plan,
          timeoutMs: REMOTE_START_TIMEOUT_MS,
          onLine: (line) => this.#log(runtime, 'debug', `remote: ${line}`),
        })
      }
      remoteStarted = true
      runtime.token = webInfo.token
      runtime.remote = {
        version: plan.start.targetVersion,
        uiReady: false,
        localPort: null,
        port: webInfo.port,
        pid: webInfo.pid ?? null,
        dshHome: layout.home,
        bootstrapLevel: plan.level,
        nodeVersion: facts.isolatedNodeVersion ?? facts.nodeVersion,
        startedAt: webInfo.startedAt ?? nowIso(),
      }
      if (plan.level === 'T0' || plan.level === 'T0-local' || plan.level === 'T1') {
        const parity = versionParity(this.localVersion, runtime.remote.version)
        if (!parity.same && !runtime.overrideVersion) {
          throw errors.versionMismatch(parity.local ?? 'unknown', parity.remote ?? 'unknown')
        }
        if (!parity.same) {
          runtime.warning = {
            zh: '正在沿用远端版本，界面可能与本地不一致。',
            en: 'Continuing with the remote version; the UI may differ from this machine.',
          }
        }
      }

      this.#phase(runtime, 'tunnel', 'tunneling')
      runtime.tunnel = await this.tunnelFactory({ ssh: runtime.ssh, remotePort: webInfo.port })
      runtime.remote.localPort = runtime.tunnel.localPort

      this.#phase(runtime, 'verifying', 'verifying')
      const ui = await this.waitUi(runtime.ssh, webInfo.port, { attempts: 20, intervalMs: 500 })
      if (!ui.ok) {
        throw errors.remoteUiUnreachable({
          zh: `远端 DSH 的本地 127.0.0.1:${webInfo.port} 没有响应（HTTP ${ui.status ?? '无'}）。`,
          en: `The remote DSH on 127.0.0.1:${webInfo.port} did not respond (HTTP ${ui.status ?? 'none'}).`,
        })
      }
      const exchange = await this.exchange(runtime.tunnel.localPort, webInfo.token, {
        timeoutMs: TUNNEL_PROBE_TIMEOUT_MS,
      })
      runtime.exchange = exchange
      if (!exchange.ok) {
        throw errors.remoteUiUnreachable({
          zh: `本地隧道完成了 token 交换，但远端界面返回 HTTP ${exchange.status}（首次状态 ${exchange.firstStatus}）。`,
          en: `The tunnel exchanged the token but the remote UI answered HTTP ${exchange.status} (first ${exchange.firstStatus}).`,
        })
      }
      if (exchange.frameBlocked) {
        runtime.warning = {
          zh: `远端页面带有禁止嵌入的响应头（X-Frame-Options=${exchange.xFrameOptions ?? '-'}），请使用「在新窗口打开」。`,
          en: `The remote page blocks embedding (X-Frame-Options=${exchange.xFrameOptions ?? '-'}); use "Open in new window".`,
        }
      }
      runtime.remote.uiReady = true
      await this.store.patchHost(runtime.id, { lastOpenedAt: nowIso() })
      runtime.entry = this.store.getHost(runtime.id) ?? runtime.entry
      if (this.store.getSettings().saveTokens) await this.store.saveToken(runtime.id, webInfo.token)
      runtime.status = 'connected'
      runtime.phase = 'ready'
      runtime.progress = { code: 'ready' }
      runtime.error = null
      this.activeHostId = runtime.id
      this.#attachDisconnectHandler(runtime)
      this.#emitState()
      this.#log(runtime, 'info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${runtime.tunnel.localPort}`)
      // P0: mirror the remote directory AFTER `connected` is published, and never
      // await it: a slow remote read must not delay the connect response or the
      // ready state. Failures are logged, never fatal.
      this.#startMirrorSync(runtime)
    } catch (error) {
      const view = toErrorView(error)
      runtime.error = view
      runtime.status = 'error'
      runtime.phase = null
      runtime.progress = null
      runtime.remote.uiReady = false
      runtime.remote.localPort = null
      this.#log(runtime, 'warn', `connect failed: ${view.code}`, error instanceof Error ? error.message : String(error))
      await this.#teardownRuntime(runtime, {
        stopRemote: remoteStarted && runtime.entry.keepAlive === 'stop',
        keepRemote: remoteStarted && runtime.entry.keepAlive !== 'stop',
      })
      this.#emitState()
    } finally {
      runtime.connectPromise = null
    }
  }

  /**
   * @param {any} runtime
   * @param {import('./probe.js').ProbeFacts} facts
   */
  async #pickTargetVersion(runtime, facts) {
    const resolved = this.resolveTarget({
      configured: runtime.entry.bootstrap.targetVersion,
      localVersion: this.localVersion,
    })
    let targetVersion = resolved.targetVersion
    if (!targetVersion) {
      throw errors.invalidInput('targetVersion', {
        zh: '无法确定本机 DSH 版本：本机版本探测失败，请安装设置里显式填写目标版本，或在远端界面里告诉插件版本。',
        en: 'Cannot determine the local DSH version. Set an explicit target version in settings or let the client report its version.',
      })
    }
    const existing = facts.dshVersion ?? facts.isolatedDshVersion ?? null
    if (runtime.entry.bootstrap.mode === 'reuse' && existing && !versionsEqual(existing, targetVersion)) {
      if (!runtime.overrideVersion) throw errors.versionMismatch(targetVersion, existing)
    }
    if (runtime.overrideVersion && existing) targetVersion = existing
    return targetVersion
  }

  /**
   * Resolve the SSH destination from the entry + local ssh config, then open the
   * transport (direct, or through a jump host).
   * @param {any} runtime
   */
  async #resolveTargetForRuntime(runtime) {
    const material = await this.loadSshMaterial({ home: this.userHome() })
    const entry = runtime.entry
    const resolved = resolveDestination(entry.address, { configText: material.configText, home: this.userHome() })
    const host = resolved.host || entry.address
    const configPort = resolved.port ?? 22
    const port = entry.port && entry.port !== 22 ? entry.port : configPort
    const knownHosts = parseKnownHosts(material.knownHostsText)
    const knownFingerprints = findKnownHostEntries(knownHosts, host, port).map((item) => item.fingerprint)
    return {
      host,
      port,
      username: entry.username || resolved.user || null,
      identityFiles: resolved.identityFiles ?? [],
      knownFingerprints,
      jumpHost: entry.jumpHost
        ? resolveDestination(entry.jumpHost, { configText: material.configText, home: this.userHome() })
        : null,
      entry,
    }
  }

  userHome() {
    return process.env.USERPROFILE || process.env.HOME || this.home
  }

  /** @param {any} runtime @param {any} target */
  async #openTransport(runtime, target) {
    /** @param {any} resolved @param {import('node:stream').Duplex | undefined} sock */
    const buildOptions = (resolved, sock) => ({
      host: resolved.host,
      port: resolved.port ?? 22,
      username: resolved.username ?? resolved.user ?? null,
      auth: {
        type: runtime.entry.auth?.type ?? 'agent',
        keyPath: runtime.entry.auth?.keyPath ?? null,
        password: runtime.password ?? null,
      },
      identityFiles: resolved.identityFiles ?? [],
      hostKeyPolicy: runtime.entry.hostKeyPolicy ?? this.store.getSettings().hostKeyPolicy,
      pinnedFingerprint: runtime.entry.pinnedFingerprint ?? null,
      knownHostFingerprints: resolved.knownFingerprints ?? [],
      acceptUnknownHostKey: false,
      readyTimeoutMs: this.store.getSettings().connectTimeoutSec * 1000 || SSH_READY_TIMEOUT_MS,
      ...(sock ? { sock } : {}),
      onHostKey: (info) => this.#onHostKey(runtime, info),
    })
    if (!target.jumpHost) {
      runtime.ssh = this.sshFactory(buildOptions(target))
      this.#phase(runtime, 'ssh', 'ssh-connecting', { host: target.host })
      this.#captureFingerprint(runtime, await runtime.ssh.connect())
      this.#startLeaseSession(runtime)
      return
    }
    this.#phase(runtime, 'ssh', 'ssh-connecting', { host: target.jumpHost.host, jump: true })
    const jumpTarget = {
      ...target.jumpHost,
      username: target.jumpHost.user ?? target.username,
      knownFingerprints: findKnownHostEntries(
        parseKnownHosts((await this.loadSshMaterial({ home: this.userHome() })).knownHostsText),
        target.jumpHost.host,
        target.jumpHost.port ?? 22,
      ).map((item) => item.fingerprint),
    }
    runtime.jumpSsh = this.sshFactory(buildOptions(jumpTarget))
    await runtime.jumpSsh.connect()
    this.#phase(runtime, 'ssh', 'ssh-connecting', { host: target.host, via: target.jumpHost.host })
    const stream = await runtime.jumpSsh.forwardOut(target.host, target.port ?? 22)
    runtime.ssh = this.sshFactory(buildOptions(target, stream))
    this.#captureFingerprint(runtime, await runtime.ssh.connect())
  }

  /**
   * Remember the session fingerprint reported by the transport so diagnostics
   * and the host card can show it even when no pin was stored.
   * @param {any} runtime
   * @param {{ fingerprint?: string, keyType?: string } | undefined} info
   */
  #captureFingerprint(runtime, info) {
    if (!info?.fingerprint) return
    const pinned = runtime.entry.pinnedFingerprint ?? null
    runtime.fingerprint = {
      sha256: info.fingerprint,
      keyType: info.keyType ?? 'unknown',
      status: pinned === info.fingerprint ? 'pinned' : pinned ? 'changed' : 'observed',
      pinned,
    }
    this.#emitState()
  }

  /**
   * Pause the SSH handshake until the user answers the fingerprint prompt.
   * @param {any} runtime
   * @param {{ sha256: string, keyType: string }} info
   */
  async #onHostKey(runtime, info) {
    const policy = runtime.entry.hostKeyPolicy ?? this.store.getSettings().hostKeyPolicy
    if (policy === 'strict') throw errors.hostKeyUnknown(info.sha256)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (runtime.pendingHostKey?.resolve === resolve) runtime.pendingHostKey = null
        this.#set(runtime, {
          status: 'error',
          phase: null,
          progress: null,
          error: toErrorView(errors.hostKeyUnknown(info.sha256)),
        })
        resolve(false)
      }, this.hostKeyConfirmTimeoutMs)
      runtime.pendingHostKey = {
        sha256: info.sha256,
        keyType: info.keyType,
        resolve: (accepted) => {
          clearTimeout(timer)
          resolve(accepted)
        },
      }
      runtime.fingerprint = { sha256: info.sha256, keyType: info.keyType, status: 'pending', pinned: null }
      runtime.status = 'fingerprint-pending'
      runtime.phase = 'ssh'
      runtime.progress = { code: 'host-key-confirm', params: { sha256: info.sha256, keyType: info.keyType } }
      this.#emitState()
      // The pipeline resumes as soon as confirmFingerprint() resolves the promise.
      runtime.pendingHostKey.wrapped = () => {
        runtime.status = 'connecting'
        this.#emitState()
      }
    })
  }

  /** @param {any} runtime */
  #attachDisconnectHandler(runtime) {
    const ssh = runtime.ssh
    if (!ssh) return
    ssh.on('close', () => {
      if (runtime.closing || runtime.desired !== 'connected' || runtime.status !== 'connected') return
      runtime.status = 'disconnected'
      runtime.phase = null
      runtime.remote.uiReady = false
      runtime.remote.localPort = null
      runtime.progress = { code: 'reconnecting', params: { attempt: runtime.reconnectAttempts + 1 } }
      this.#emitState()
      void this.#closeTunnel(runtime)
      this.#scheduleReconnect(runtime)
    })
  }

  /** @param {any} runtime */
  #scheduleReconnect(runtime) {
    this.#cancelReconnect(runtime)
    const settings = this.store.getSettings()
    if (!runtime.entry.autoReconnect || !settings.autoReconnect.enabled) {
      this.#set(runtime, { status: 'disconnected' })
      return
    }
    const maxAttempts = settings.autoReconnect.maxAttempts
    if (runtime.reconnectAttempts >= maxAttempts) {
      runtime.status = 'error'
      runtime.error = toErrorView(
        errors.network({
          zh: `连接已断开，自动重连 ${maxAttempts} 次均失败。远端任务可能仍在运行。`,
          en: `The connection dropped and ${maxAttempts} automatic retries failed. Remote tasks may still be running.`,
        }),
      )
      runtime.progress = null
      this.#emitState()
      return
    }
    runtime.reconnectAttempts += 1
    const delay = randomDelay(
      settings.autoReconnect.baseDelayMs,
      settings.autoReconnect.baseDelayMs * 2 ** Math.min(runtime.reconnectAttempts, 4),
    )
    runtime.progress = { code: 'reconnecting', params: { attempt: runtime.reconnectAttempts, max: maxAttempts } }
    this.#emitState()
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null
      void this.#reconnectOnce(runtime)
    }, delay)
  }

  /** @param {any} runtime */
  async #reconnectOnce(runtime) {
    if (this.disposed || runtime.desired !== 'connected') return
    await this.#disposeSsh(runtime)
    runtime.connectPromise = this.#connectPipeline(runtime).finally(() => {
      runtime.connectPromise = null
    })
  }

  /** @param {any} runtime */
  #cancelReconnect(runtime) {
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer)
      runtime.reconnectTimer = null
    }
  }

  /** @param {any} runtime */
  #cancelIdleStop(runtime) {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer)
      runtime.idleTimer = null
    }
  }

  /** @param {any} runtime */
  #scheduleIdleStop(runtime) {
    this.#cancelIdleStop(runtime)
    const minutes = Math.max(1, runtime.entry.idleMinutes ?? DEFAULT_IDLE_MINUTES)
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      void this.#stopRemoteQuietly(runtime)
    }, minutes * 60_000)
  }

  /** @param {any} runtime */
  async #stopRemoteQuietly(runtime) {
    try {
      if (runtime.ssh?.connected) {
        await this.stopWeb(runtime.ssh, remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null), {
          pid: runtime.remote.pid ?? undefined,
        })
      }
    } catch (error) {
      this.#log(runtime, 'warn', 'idle stop failed:', error instanceof Error ? error.message : String(error))
    } finally {
      await this.#disposeSsh(runtime)
    }
  }

  /** @param {any} runtime */
  async #closeTunnel(runtime) {
    const tunnel = runtime.tunnel
    runtime.tunnel = null
    if (tunnel) {
      try {
        await tunnel.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * The **single writer** for one host's descriptors (design §6.3).
   *
   * Delegates to `withMirrorWriter`, which owns the per-host queue: every descriptor mutation
   * (sync reconcile, history apply, stream apply) goes through it, so two writers can never
   * interleave a read and a persist and drop each other's cursor.
   * @param {any} runtime
   * @param {(current: any[]) => any[]} delta
   * @returns {Promise<any[]>}
   */
  async #mutateMirrors(runtime, delta) {
    return withMirrorWriter(
      runtime,
      () => this.mirrorStore.listMirrors({ hostId: runtime.id }),
      (next) => this.mirrorStore.replaceHostMirrors(runtime.id, next),
      // The guard is *inside* the queued delta: a write enqueued before the deletion but executed
      // after it must also be a no-op, otherwise the queue would only reorder the resurrection.
      (current) => (runtime.mirrorDeleted === true ? current : delta(current)),
    )
  }

  /**
   * Remove a host's descriptors on the same per-host queue a sync uses.
   *
   * Deleting while a sync is mid-flight used to leave the sync's queued write to re-insert the
   * descriptors it had read before the deletion. Sharing the queue orders the two, and the
   * tombstone set by `removeHost` makes any write ordered *before* the deletion harmless too.
   * @param {string} hostId
   * @param {any} [runtime] the runtime captured before it left the map (may be undefined)
   */
  async #removeMirrorsForHost(hostId, runtime) {
    if (!runtime) return this.mirrorStore?.removeHostMirrors?.(hostId)
    return withMirrorQueue(runtime, async () => this.mirrorStore?.removeHostMirrors?.(hostId))
  }

  /**
   * Merge descriptor deltas onto the current set (monotonic cursor/epoch/conflictCount).
   * @param {any[]} current @param {any[]} deltas
   */
  #mergeDelta(current, deltas) {
    return mergeDescriptorDeltas(current, deltas)
  }
  /**
   * Start a fresh writer-authority session for this connection (design §6.2).
   *
   * The key is a **per-connection random token**, not a secret shared with anyone: it exists so
   * a lease cannot be silently continued by a different writer (the remote refuses a publish
   * whose key does not own the record). Anything stronger would need a real secret, which this
   * transport does not provide — see §11 #9 for exactly what that leaves open.
   * @param {any} runtime
   */
  #startLeaseSession(runtime) {
    runtime.leaseSessionKey = `sk_${randomBytes(18).toString('base64url')}`
    runtime.leasePublished = null
  }

  /**
   * Publish the tombstone for this host's lease, if we ever published one.
   *
   * Never throws and never blocks teardown: failing to release only costs other clients a TTL
   * wait, which is why the record carries `expiresAt` in the first place.
   * @param {any} runtime
   */
  async #releaseLease(runtime) {
    const key = runtime.leaseSessionKey ?? null
    const published = runtime.leasePublished ?? null
    runtime.leaseSessionKey = null
    runtime.leasePublished = null
    if (key === null || published === null || !runtime.ssh?.connected) return
    const layout = remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null)
    if (!layout?.home) return
    try {
      await runtime.ssh.exec(
        buildLeaseReleaseCommand(remoteLeaseFile(layout.home, published.sessionId ?? null), {
          writer: published.writer,
          epoch: published.epoch,
          sessionKey: key,
          now: this.#now(),
        }),
        { timeoutMs: LEASE_LIMITS.timeoutMs },
      )
    } catch {
      /* a failed release is only a delay, never an error */
    }
  }

  /** @param {any} runtime */
  async #disposeSsh(runtime) {
    const ssh = runtime.ssh
    runtime.ssh = null
    const jump = runtime.jumpSsh
    runtime.jumpSsh = null
    if (ssh) {
      try {
        await ssh.dispose()
      } catch {
        /* already gone */
      }
    }
    if (jump) {
      try {
        await jump.dispose()
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * @param {any} runtime
   * @param {{ stopRemote?: boolean, keepRemote?: boolean, keepSshForIdle?: boolean }} [options]
   */
  async #teardownRuntime(runtime, options = {}) {
    // Publish the tombstone while the transport still exists: a released lease lets another
    // client take over immediately instead of waiting out the TTL, and it is the honest
    // "I am gone" signal a single-writer protocol needs.
    await this.#releaseLease(runtime)
    runtime.closing = true
    this.#cancelIdleStop(runtime)
    if (options.stopRemote && runtime.ssh?.connected) {
      try {
        await this.stopWeb(runtime.ssh, remoteLayout(runtime.entry.bootstrap.remoteDir, runtime.facts?.home ?? null), {
          pid: runtime.remote.pid ?? undefined,
        })
      } catch (error) {
        this.#log(runtime, 'warn', 'stop remote failed:', error instanceof Error ? error.message : String(error))
      }
    }
    await this.#closeTunnel(runtime)
    if (!options.keepSshForIdle) await this.#disposeSsh(runtime)
    if (!options.keepRemote) {
      runtime.remote = { ...emptyRemote(), version: runtime.remote.version }
      runtime.token = null
    }
  }

  // ---------------------------------------------------------- diagnostics

  /**
   * Run the wizard/diagnostic checklist (design §4.4). Uses the live connection
   * when present; otherwise honest `unknown` rows instead of new connections.
   * @param {string} id
   */
  async diagnose(id) {
    await this.init()
    const runtime = this.#runtime(id)
    const settings = this.store.getSettings()
    /** @type {{ id: string, title: { zh: string, en: string }, status: 'pass'|'fail'|'unknown', detail: { zh: string, en: string } }[]} */
    const checks = []
    const push = (checkId, title, status, detail) => checks.push({ id: checkId, title, status, detail })
    const sshLive = Boolean(runtime.ssh?.connected)

    push(
      'ssh-reachable',
      { zh: 'SSH 可达性', en: 'SSH reachability' },
      sshLive ? 'pass' : runtime.error ? 'fail' : 'unknown',
      sshLive
        ? { zh: `已连接 ${runtime.entry.address}`, en: `Connected to ${runtime.entry.address}` }
        : runtime.error
          ? runtime.error.detail
          : { zh: '尚未连接，请先连接一次。', en: 'Not connected yet; connect once first.' },
    )

    push(
      'auth',
      { zh: '认证方式', en: 'Authentication' },
      sshLive ? 'pass' : 'unknown',
      sshLive
        ? {
            zh: `认证方式：${runtime.entry.auth?.type ?? 'agent'}（凭据不会保存在本机）`,
            en: `Method: ${runtime.entry.auth?.type ?? 'agent'} (no credentials are stored locally)`,
          }
        : { zh: '连接后检查', en: 'Checked after connecting' },
    )

    const pinned = runtime.entry.pinnedFingerprint
    const liveFingerprint = runtime.fingerprint?.sha256 ?? null
    push(
      'host-key',
      { zh: '主机指纹', en: 'Host key' },
      pinned && liveFingerprint ? (pinned === liveFingerprint ? 'pass' : 'fail') : pinned ? 'unknown' : 'unknown',
      pinned
        ? {
            zh: `已记录 ${pinned}${liveFingerprint ? `，本次 ${liveFingerprint}` : ''}`,
            en: `Pinned ${pinned}${liveFingerprint ? `, this session ${liveFingerprint}` : ''}`,
          }
        : liveFingerprint
          ? { zh: `本次会话 ${liveFingerprint}（尚未记录）`, en: `This session ${liveFingerprint} (not pinned yet)` }
          : { zh: '尚未记录指纹，首次连接时会询问。', en: 'No host key recorded yet; it is asked on first connect.' },
    )

    const tunnel = runtime.tunnel
    push(
      'tunnel',
      { zh: '本地回环隧道', en: 'Loopback tunnel' },
      tunnel ? 'pass' : 'fail',
      tunnel
        ? {
            zh: `127.0.0.1:${tunnel.localPort} → 远端 127.0.0.1:${runtime.remote.pid ? runtime.remote.pid : ''}`,
            en: `127.0.0.1:${tunnel.localPort} → remote loopback`,
          }
        : {
            zh: '隧道未建立（连接断开或尚未连接）。',
            en: 'The tunnel is not established (disconnected or not connected yet).',
          },
    )

    const remotePort = runtime.remote.port ?? runtime.remote.localPort ?? 0
    const serverStatus = sshLive ? await remoteHttpStatus(runtime.ssh, remotePort) : null
    const remoteAlive = sshLive && runtime.exchange?.status === 200
    push(
      'remote-service',
      { zh: '远端 DSH 服务', en: 'Remote DSH service' },
      remoteAlive ? 'pass' : sshLive ? 'fail' : 'unknown',
      remoteAlive
        ? {
            zh: `远端进程 pid=${runtime.remote.pid ?? '未知'}，本地端口 ${runtime.remote.localPort ?? '未知'}`,
            en: `Remote pid ${runtime.remote.pid ?? 'unknown'}, local port ${runtime.remote.localPort ?? 'unknown'}`,
          }
        : { zh: '远端服务未确认在运行。', en: 'The remote service is not confirmed running.' },
    )

    push(
      'remote-ui',
      { zh: '远端界面可达性', en: 'Remote UI reachability' },
      runtime.exchange?.ok ? (runtime.exchange.frameBlocked ? 'fail' : 'pass') : sshLive ? 'fail' : 'unknown',
      runtime.exchange?.ok
        ? runtime.exchange.frameBlocked
          ? {
              zh: `可以打开，但禁止 iframe 嵌入（X-Frame-Options: ${runtime.exchange.xFrameOptions ?? '未知'}）。`,
              en: `Opens, but iframe embedding is blocked (X-Frame-Options: ${runtime.exchange.xFrameOptions ?? 'unknown'}).`,
            }
          : {
              zh: `页面标题：${runtime.exchange.title ?? '（无）'}`,
              en: `Page title: ${runtime.exchange.title ?? '(none)'}`,
            }
        : { zh: '尚未完成远端界面的鉴权握手。', en: 'The remote UI authentication handshake has not completed.' },
    )

    const target = this.#targetVersionForSnapshot(settings, this.localVersion)
    const remoteVersion = runtime.remote.version ?? runtime.facts?.dshVersion ?? null
    const parity = versionParity(target.targetVersion, remoteVersion)
    push(
      'remote-version',
      { zh: '远端 DSH 版本', en: 'Remote DSH version' },
      parity.status === 'same' ? 'pass' : parity.status === 'different' ? 'fail' : 'unknown',
      { zh: parity.message.zh, en: parity.message.en },
    )

    const credentials = runtime.facts
      ? runtime.facts.credentialsFile || runtime.facts.deepseekKeyEnv || runtime.facts.providerEnvKeys.length > 0
      : false
    push(
      'model-credentials',
      { zh: '模型凭据', en: 'Model credentials' },
      runtime.facts ? (credentials ? 'pass' : 'unknown') : 'unknown',
      runtime.facts
        ? credentials
          ? { zh: '远端已检测到模型凭据配置。', en: 'Remote model credentials were detected.' }
          : {
              zh: '未检测到模型凭据；请在远端界面里配置。',
              en: 'No model credentials detected; configure them in the remote UI.',
            }
        : { zh: '未探测远端环境。', en: 'Remote environment has not been probed.' },
    )

    push(
      'desktop-guard',
      { zh: '远端桌面功能检查', en: 'Remote desktop guard' },
      runtime.facts ? (runtime.facts.sshConnection ? 'pass' : 'unknown') : 'unknown',
      runtime.facts
        ? runtime.facts.sshConnection
          ? {
              zh: '远端 DSH 经 SSH 会话启动，宿主桌面功能已关闭。',
              en: 'The remote DSH runs inside an SSH session, so host desktop features stay off.',
            }
          : {
              zh: '远端未检测到 SSH 会话标记，目录对话框可能弹在远端屏幕上。',
              en: 'No SSH session marker on the remote; directory dialogs may appear on the remote screen.',
            }
        : { zh: '未探测远端环境。', en: 'Remote environment has not been probed.' },
    )

    const failed = checks.filter((check) => check.status === 'fail').length
    const unknown = checks.filter((check) => check.status === 'unknown').length
    const summary = failed > 0 ? 'error' : unknown > 0 ? 'warning' : 'ok'
    return {
      summary,
      checks,
      redacted: true,
      generatedAt: nowIso(),
      logs: runtime.logs.slice(-40).map((entry) => entry.line),
      serverStatus,
    }
  }

  // ----------------------------------------------------------------- teardown

  async shutdown() {
    this.disposed = true
    for (const runtime of this.runtimes.values()) {
      this.#cancelReconnect(runtime)
      this.#cancelIdleStop(runtime)
      try {
        const policy = runtime.entry.keepAlive
        if (policy === 'stop') {
          await this.#stopRemoteQuietly(runtime)
        } else {
          await this.#closeTunnel(runtime)
          await this.#disposeSsh(runtime)
        }
      } catch {
        /* best effort on shutdown */
      }
    }
  }
}

/**
 * @param {Record<string, any>} entry
 */
export function maskAddress(entry) {
  const port = entry.port && entry.port !== 22 ? `:${entry.port}` : ''
  const user = entry.username ? `${entry.username}@` : ''
  const host = entry.address || '?'
  return `${user}${host}${port}`
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
}

/**
 * The writer id a host's mirror lease is issued to (design §6.2).
 *
 * Stable for a given host so a restart **renews** its own lease instead of looking like a
 * competing writer that has to be fenced. It is not a secret and carries no credentials —
 * it only distinguishes local writers, which today means one plugin instance per host.
 * @param {string} hostId
 * @returns {string}
 */
function leaseWriterId(hostId) {
  return `local:${hostId}`
}

/**
 * Typed history failure ⇒ the bilingual `reason` a descriptor (and its client row)
 * carries. Kept next to the sync code so a new `HistoryFailure` cannot be added
 * without a user-visible explanation.
 * @param {string | null} code
 * @returns {{ code: string, message: { zh: string, en: string } } | null}
 */
function historyReason(code) {
  if (code === null || code === undefined) return null
  /** @type {Record<string, { zh: string, en: string }>} */
  const table = {
    // L3 prerequisite (design §6.2): the local side has been fenced — another writer holds
    // a newer epoch, or a live lease belongs to someone else. Writes stop, the mirror stays
    // readable, and nothing about the existing history is discarded.
    fenced: {
      zh: '写入租约已被更新的写入者接管（epoch 更新），镜像转为只读；历史仍可查看，写入停止。',
      en: 'A newer writer took over the lease (a higher epoch), so the mirror is read-only; its history stays readable and writes stop.',
    },
    'sessions-dir-missing': {
      zh: '远端没有会话目录，无法回放历史（镜像保持只读快照）。',
      en: 'The remote has no session directory, so history cannot be replayed (the mirror keeps its last snapshot).',
    },
    'no-session-log': {
      zh: '找不到该会话的远端日志，历史暂不可用。',
      en: 'No remote log was found for this session, so its history is not available yet.',
    },
    'read-failed': {
      zh: '读取远端会话日志失败，下次同步会重试。',
      en: 'Reading the remote session log failed; the next sync will retry.',
    },
    'permission-denied': {
      zh: '远端会话日志不允许读取（权限不足）。',
      en: 'The remote session log is not readable (permission denied).',
    },
    'log-truncated': {
      zh: '远端会话日志超出读取上限，已跳过本次回放。',
      en: 'The remote log exceeds the read limit, so this replay was skipped.',
    },
    'log-malformed': {
      zh: '远端会话日志格式无法识别，已跳过本次回放。',
      en: 'The remote log format is not recognised, so this replay was skipped.',
    },
    'unknown-version': {
      zh: '远端会话日志版本高于本插件，已跳过回放以免错位。',
      en: 'The remote log uses a newer version than this plugin; replay was skipped to avoid mis-mapping it.',
    },
    'gap-unfilled': {
      zh: '远端历史存在缺口且补齐失败，游标停在缺口前。',
      en: 'The remote history has a gap that could not be backfilled, so the cursor stopped before it.',
    },
    'history-disabled': {
      zh: '历史回放已关闭，镜像停留在目录级（L1）。',
      en: 'History replay is disabled, so the mirror stays at the directory level (L1).',
    },
  }
  const message = table[code] ?? {
    zh: '历史回放失败，镜像保持上一次状态。',
    en: 'History replay failed; the mirror keeps its previous state.',
  }
  return { code, message: { ...message } }
}

/**
 * Orchestration service: host state machine, connect pipeline
 * (SSH → probe → bootstrap → start → tunnel → verify), auto-reconnect,
 * keep-alive policy and diagnostics (design §5, §8, §16.4).
 *
 * Everything external is injected so the whole pipeline can be unit-tested
 * with fakes (no real SSH, no timers).
 */
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_IDLE_MINUTES,
  REMOTE_CONFLICT_TIMEOUT_MS,
  REMOTE_START_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
  TUNNEL_PROBE_TIMEOUT_MS,
} from './constants.js'
import { errors, toErrorView } from './errors.js'
import { remoteLayout } from './layout.js'
import { loadLocalSshMaterial } from './local-ssh.js'
import { findKnownHostEntries, parseKnownHosts, summarizeKnownHosts } from './known-hosts.js'
import { probeRemote } from './probe.js'
import { planNpx, verifyNpxVersion } from './bootstrap.js'
import { applyManagedNodeFacts, ensureRemoteNode, managedNodeVersionFromEngine } from './node-runtime.js'
import { discoverSshAliases as discoverAliasesFromConfig, resolveDestination } from './ssh-config.js'
import { parseSshConfig } from './ssh-config.js'
import { SshConnection } from './ssh.js'
import { createTunnel } from './tunnel.js'
import {
  adoptRemoteWeb,
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  readRunRegistry,
  remoteHttpStatus,
  startRemoteWeb,
  stopForeignDshProcesses,
  stopRemoteWeb,
  waitForRemoteUi,
} from './webapp.js'
import { logVisible, nowIso, randomDelay } from './util.js'
import { normalizeVersion, isNodeVersionSupported, versionParity, versionsEqual } from './version.js'
import { listKeyFiles as listKeyFilesInHome } from './key-files.js'
import { createHostRuntime, emptyRemote } from './host-runtime.js'
import { hostView } from './host-view.js'
import { diagnoseHost } from './diagnostics.js'

/** Milliseconds a paused host-key handshake waits for the user. */
export const HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000

/** @typedef {'unconfigured'|'connecting'|'fingerprint-pending'|'conflict-pending'|'connected'|'disconnected'|'error'|'limited'} HostStatus */
/** @typedef {'ssh'|'probe'|'bootstrap'|'start'|'tunnel'|'ready'} ConnectPhase */

/**
 * @typedef {{
 *   store: import('./store.js').HostStore,
 *   home: string,
 *   logger?: { info?: (...a: any[]) => void, warn?: (...a: any[]) => void, debug?: (...a: any[]) => void, error?: (...a: any[]) => void },
 *   localVersion?: string | null,
 *   engineNodeRange?: string | null,
 *   sshFactory?: (options: any) => any,
 *   tunnelFactory?: (options: any) => Promise<any>,
 *   probe?: typeof probeRemote,
 *   plan?: typeof planNpx,
 *   ensureNode?: typeof ensureRemoteNode,
 *   preflight?: typeof verifyNpxVersion,
 *   startWeb?: typeof startRemoteWeb,
 *   stopWeb?: typeof stopRemoteWeb,
 *   waitUi?: typeof waitForRemoteUi,
 *   exchange?: typeof exchangeTokenOverTunnel,
 *   adopt?: typeof adoptRemoteWeb,
 *   findForeign?: typeof findForeignDshProcesses,
 *   stopForeign?: typeof stopForeignDshProcesses,
 *   readRegistry?: typeof readRunRegistry,
 *   loadSshMaterial?: typeof loadLocalSshMaterial,
 * }} ServiceOptions
 */

/** @param {string} text */
function stripAnsi(text) {
  return String(text ?? '').replace(/\u001B\[[0-9;]*m/g, '')
}

/**
 * Turn one npm/npx output line into a progress event for the connect line.
 * `npm_config_loglevel=http` makes npm report fetches without a TTY; known shapes
 * get a localized progress code, anything else is kept (truncated) as a detail.
 * @param {string} line
 * @param {string} version
 * @returns {{ code: string, params?: Record<string, string> } | null}
 */
export function describePreflightEvent(line, version) {
  const text = stripAnsi(line).trim()
  if (text === '') return null
  // The package's own `--version` output is the success signal, not progress.
  if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text)) return null
  if (/The following package was not found and will be installed/i.test(text)) {
    return { code: 'bootstrap-first-run', params: { version } }
  }
  if (/^npm (http fetch|http request)/i.test(text)) return { code: 'bootstrap-fetching' }
  if (/added \d+ packages? in/i.test(text)) return { code: 'bootstrap-installed' }
  return { code: 'bootstrap-progress', params: { detail: text.slice(0, 160) } }
}

/**
 * @param {any} runtime
 */
export class RemoteGoService extends EventEmitter {
  /** @param {ServiceOptions} options */
  constructor(options) {
    super()
    this.store = options.store
    this.home = options.home
    this.logger = options.logger ?? console
    this.localVersion = options.localVersion ?? null
    this.localVersionSource = 'unknown'
    // `engines.node` of the local DSH package; the managed Node version is its
    // lower bound (see `managedNodeVersionFromEngine`). Null until detected.
    this.engineNodeRange = options.engineNodeRange ?? null
    this.engineNodeSource = 'unknown'
    this.sshFactory = options.sshFactory ?? ((sshOptions) => new SshConnection(sshOptions))
    this.tunnelFactory = options.tunnelFactory ?? createTunnel
    this.probe = options.probe ?? probeRemote
    this.plan = options.plan ?? planNpx
    this.ensureNode = options.ensureNode ?? ensureRemoteNode
    this.preflight = options.preflight ?? verifyNpxVersion
    this.startWeb = options.startWeb ?? startRemoteWeb
    this.stopWeb = options.stopWeb ?? stopRemoteWeb
    this.waitUi = options.waitUi ?? waitForRemoteUi
    this.exchange = options.exchange ?? exchangeTokenOverTunnel
    this.adopt = options.adopt ?? adoptRemoteWeb
    this.findForeign = options.findForeign ?? findForeignDshProcesses
    this.stopForeign = options.stopForeign ?? stopForeignDshProcesses
    this.readRegistry = options.readRegistry ?? readRunRegistry
    this.loadSshMaterial = options.loadSshMaterial ?? loadLocalSshMaterial
    // Optional: keeps a remembered SSH password in DSH's credential store so it
    // never reaches hosts.json. Absent ⇒ passwords stay in memory for one session.
    this.secrets = options.secrets ?? null
    this.hostKeyConfirmTimeoutMs = options.hostKeyConfirmTimeoutMs ?? HOST_KEY_CONFIRM_TIMEOUT_MS
    this.conflictConfirmTimeoutMs = options.conflictConfirmTimeoutMs ?? REMOTE_CONFLICT_TIMEOUT_MS
    // Log verbosity override: set it to `debug` to see the §6.4 poll trace in full. Unset means the
    // configured `logLevel` decides.
    this.logLevel = typeof options.logLevel === 'string' ? options.logLevel : null
    /** @type {Map<string, any>} */
    this.runtimes = new Map()
    this.activeHostId = null
    this.disposed = false
    this.initialized = false
  }

  async init() {
    if (this.initialized) return this
    await this.store.load()
    for (const host of this.store.listHosts()) this.#ensureRuntime(host)
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

  /**
   * Remember the local DSH build's `engines.node`. The managed Node version is
   * derived from it, so the plugin follows DSH instead of hard-coding a number.
   * @param {string | null} range
   * @param {string} [source]
   */
  setLocalEnginesNode(range, source = 'detected') {
    const text = typeof range === 'string' ? range.trim() : ''
    this.engineNodeRange = text === '' ? null : text
    this.engineNodeSource = source
  }

  /** @param {Record<string, any>} host */
  /** @param {Record<string, any>} host */
  #ensureRuntime(host) {
    const existing = this.runtimes.get(host.id)
    if (existing) {
      existing.entry = host
      return existing
    }
    const runtime = createHostRuntime(host)
    this.runtimes.set(host.id, runtime)
    return runtime
  }

  /** @param {string} id */
  #runtime(id) {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw errors.invalidInput('id', { zh: `未知主机 ${id}`, en: `Unknown host ${id}` })
    return runtime
  }

  #log(runtime, level, ...args) {
    const line = `[dsh-remote-go:${runtime.id}] ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`
    if (runtime.logs.length > 200) runtime.logs.shift()
    runtime.logs.push({ at: nowIso(), level, line })
    // `runtime.logs` above is the unfiltered ring an operator inspects. The logger below honours a
    // threshold so verbosity is a runtime decision: `options.logLevel` (tests, diagnostics) or the
    // configured `logLevel`.
    const threshold = this.logLevel ?? this.store.getSettings()?.logLevel ?? 'info'
    if (!logVisible(level, threshold)) return
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

  /**
   * Managed-Node provisioning reports coarse steps; surface them in the same
   * progress line the rest of the pipeline uses (and throttle nothing here: the
   * installer already bundles byte progress into ~5s/8 MB events).
   * @param {any} runtime
   * @param {{ step: string, version?: string, bytes?: number }} event
   */
  #nodeProgress(runtime, event) {
    if (event.step === 'check') return
    if (event.step === 'download') {
      this.#phase(runtime, 'bootstrap', 'downloading-node', {
        version: event.version,
        mb: Math.max(0, Math.round(Number(event.bytes ?? 0) / (1024 * 1024))),
      })
      return
    }
    if (event.step === 'ready') return
    this.#phase(runtime, 'bootstrap', 'installing-node', { version: event.version })
  }

  /**
   * Stream one channel of the npx preflight into the connect progress line.
   * npm has no TTY over SSH, so the command enables `npm_config_loglevel=http`;
   * each line becomes a short detail, throttled so the SSE stream is not flooded.
   * @param {any} runtime
   * @param {string} version
   * @returns {(chunk: string) => void}
   */
  #bootstrapReporter(runtime, version) {
    let buffer = ''
    let lastAt = 0
    let lastKey = ''
    return (chunk) => {
      buffer += String(chunk ?? '')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const event = describePreflightEvent(rawLine, version)
        if (!event) continue
        const key = `${event.code}:${event.params?.detail ?? ''}`
        if (key === lastKey) continue
        const now = Date.now()
        if (now - lastAt < 700) continue
        lastAt = now
        lastKey = key
        this.#phase(runtime, 'bootstrap', event.code, event.params)
      }
    }
  }

  /** Build the client-facing state snapshot (contract: docs/api.md). */
  snapshot() {
    const settings = this.store.getSettings()
    const localVersion = this.localVersion
    const hosts = [...this.runtimes.values()].map((runtime) => this.#hostView(runtime))
    return {
      hostVersion: localVersion,
      targetVersion: localVersion,
      hosts,
      settings,
      activeHostId: this.activeHostId,
      firstRun: hosts.length === 0,
    }
  }

  /** @param {any} runtime */
  /** @param {any} runtime */
  #hostView(runtime) {
    return hostView(runtime, {
      targetVersion: this.localVersion,
      passwordStorageAvailable: this.secrets ? this.secrets.available() === true : false,
    })
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
    return this.#hostView(this.#runtime(entry.id))
  }

  /** @param {string} id */
  async removeHost(id) {
    await this.init()
    const runtime = this.runtimes.get(id)
    if (runtime) {
      // A deleted host must not be resurrected by a timer scheduled before deletion.
      this.#cancelReconnect(runtime)
      this.#cancelIdleStop(runtime)
      await this.#teardownRuntime(runtime, { stopRemote: runtime.entry.keepAlive === 'stop' })
    }
    this.runtimes.delete(id)
    await this.store.removeHost(id)
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
   * Browse directories inside the user's home so the client can pick a private-key
   * file instead of typing an absolute path. Read-only and home-confined.
   * @param {string} [dir]
   * @returns {Promise<Record<string, unknown>>}
   */
  async listKeyFiles(dir) {
    // The picker is rooted at the OS user home, not DSH_HOME: private keys live in
    // `~/.ssh` of the account, while this service's `home` is the DSH state root.
    const userHome = homedir()
    const listing = await listKeyFilesInHome({ home: userHome, dir: typeof dir === 'string' ? dir : '' })
    const settings = this.store.getSettings()
    return { ...listing, defaultKeyPath: settings.defaultKeyPath, defaultDir: path.join(userHome, '.ssh') }
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
    return this.#hostView(runtime)
  }

  // -------------------------------------------------------------- connect

  /**
   * Start the connect pipeline. Returns immediately; progress travels on the
   * `state` event (see docs/api.md /events).
   * @param {string} id
   * @param {{ password?: string, rememberPassword?: boolean }} [options]
   */
  async connect(id, options = {}) {
    await this.init()
    const runtime = this.#runtime(id)
    if (runtime.connectPromise) return { accepted: false, reason: 'already-connecting' }
    if (runtime.status === 'connected' && runtime.ssh?.connected)
      return { accepted: false, reason: 'already-connected' }
    runtime.password = options.password ?? runtime.password
    // A password the user asked to remember is written to the credential store the
    // moment it is known, so a failed first attempt still leaves it available.
    if (options.rememberPassword === true && typeof runtime.password === 'string' && runtime.password !== '') {
      runtime.savePassword = true
    }
    runtime.desired = 'connected'
    this.#cancelReconnect(runtime)
    runtime.connectPromise = this.#connectPipeline(runtime).finally(() => {
      runtime.connectPromise = null
    })
    return { accepted: true }
  }

  /**
   * Store or forget the remembered SSH password for one host. Returns whether the
   * credential store accepted it (`available:false` means nothing can be persisted).
   * @param {string} id
   * @param {{ password?: string, clear?: boolean }} [options]
   */
  async saveHostPassword(id, options = {}) {
    await this.init()
    const runtime = this.#runtime(id)
    if (!this.secrets) return { available: false, saved: false }
    const available = this.secrets.available() === true
    if (options.clear === true) {
      await this.secrets.remove(id)
      runtime.passwordSaved = false
      runtime.password = null
      this.#emitState()
      return { available, saved: false }
    }
    const password = typeof options.password === 'string' ? options.password : ''
    if (password === '') {
      throw errors.invalidInput('password', { zh: '密码不能为空。', en: 'The password must not be empty.' })
    }
    const saved = await this.secrets.set(id, password)
    runtime.password = password
    runtime.passwordSaved = saved
    this.#set(runtime, {})
    return { available, saved }
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
   * Answer the "a manually started DSH is already running" prompt.
   * @param {string} id
   * @param {{ action: 'stop'|'alongside'|'cancel' }} decision
   */
  async confirmConflict(id, decision) {
    const runtime = this.#runtime(id)
    const pending = runtime.pendingConflict
    if (!pending)
      throw errors.invalidInput('conflict', {
        zh: '没有待确认的远端 DSH 冲突。',
        en: 'No remote DSH conflict is pending confirmation.',
      })
    const action = decision?.action
    if (action !== 'stop' && action !== 'alongside' && action !== 'cancel') {
      throw errors.invalidInput('conflict', {
        zh: '请选择停止手工实例、与它并存，或取消连接。',
        en: 'Choose whether to stop the manual instance, keep it alongside, or cancel.',
      })
    }
    pending.resolve({ action })
    return { ok: true }
  }

  /**
   * Open info for the guest: a loopback URL carrying the one-shot launch token.
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
      // A password-auth host may have one remembered: load it before the transport
      // is opened, so reconnect and background retries work without a prompt.
      if (runtime.entry.auth?.type === 'password' && !runtime.password && this.secrets) {
        const remembered = await this.secrets.get(runtime.id)
        if (remembered) {
          runtime.password = remembered
          runtime.passwordSaved = true
        }
      }
      this.#phase(runtime, 'ssh', 'ssh-connecting', { host: runtime.entry.name })
      await this.#openTransport(runtime, target)
      this.#log(
        runtime,
        'info',
        `SSH connected to ${target.host}:${target.port} as ${target.username ?? '(default)'} (fingerprint ${runtime.fingerprint?.sha256 ?? 'unknown'})`,
      )

      this.#phase(runtime, 'probe', 'probing')
      let facts = await this.probe(runtime.ssh)
      // The runtime always runs on a plugin-owned Node (`~/.dsh/remote-go/node`),
      // whether or not the remote already has one: a shared system/nvm Node is
      // exactly what makes "works for my other project" break the remote DSH.
      // There is no system fallback on purpose — the managed install is the only
      // path, so this failure is the connection's failure.
      const profile = this.store.getSettings().bootstrap.profile
      const managedVersion = managedNodeVersionFromEngine(this.engineNodeRange)
      const managed = await this.ensureNode(runtime.ssh, {
        facts,
        layout: remoteLayout(facts.home),
        version: managedVersion,
        onProgress: (event) => this.#nodeProgress(runtime, event),
      })
      facts = applyManagedNodeFacts(facts, managed)
      runtime.managedNode = managed
      this.#log(
        runtime,
        'info',
        `managed Node ${managed.version}${managed.installed ? ' installed' : ' reused'} at ${managed.nodeBinDir}`,
      )
      runtime.facts = facts
      const targetVersion = this.localVersion
      if (!targetVersion) {
        throw errors.invalidInput('version', {
          zh: '无法确定本机 DSH 版本，无法用 npx 固定同版本启动远端。请从 DSH 界面启动本插件，让 Host 读到本机版本。',
          en: 'The local DSH version is unknown, so the remote cannot be pinned to the same version. Start the plugin from the DSH UI so the Host can read the local version.',
        })
      }
      const plan = this.plan({ facts, targetVersion, profile })
      runtime.plan = plan
      this.#log(runtime, 'info', `runtime plan ${plan.level}: ${plan.reason.en}`)

      this.#phase(runtime, 'start', 'starting-remote', { level: plan.level })
      const layout = remoteLayout(runtime.facts?.home ?? null)
      let webInfo = null
      // Adopt an instance left running by a previous local process (keep-alive).
      // This is checked before the npx preflight: an adoptable instance should not
      // require registry access just to reconnect.
      try {
        const adopted = await this.adopt(runtime.ssh, layout, { profile })
        const adoptedVersion = adopted?.version ? normalizeVersion(adopted.version) : null
        if (adopted && (!adoptedVersion || versionsEqual(adoptedVersion, targetVersion))) {
          webInfo = { ...adopted, logPath: layout.logFile, startedAt: nowIso(), rawLine: '' }
          this.#log(runtime, 'info', `adopted running remote web pid=${adopted.pid} port=${adopted.port}`)
        } else if (adopted) {
          this.#log(
            runtime,
            'info',
            `running remote web version ${adoptedVersion} != ${targetVersion}; stopping it and starting a matching instance`,
          )
          // The old process owns the same `~/.dsh` profile; leaving it running
          // next to the new one would share session files with a stale version.
          try {
            await this.stopWeb(runtime.ssh, layout, { pid: adopted.pid })
          } catch (error) {
            this.#log(runtime, 'warn', 'could not stop the stale remote web:', String(error?.message ?? error))
          }
        }
      } catch (error) {
        this.#log(runtime, 'debug', 'adopt check failed:', error instanceof Error ? error.message : String(error))
      }
      if (!webInfo) {
        // The registry row we refused to adopt (stale launch marker, unresponsive
        // HTTP, ...) still names a process on this ~/.dsh profile. Starting a
        // second one would let two clients write the same session files.
        const leftover = await this.readRegistry(runtime.ssh, layout)
        const leftoverPid = Number(leftover?.pid ?? 0)
        if (leftover?.dshHome === layout.dshHome && leftover?.profile === profile && leftoverPid > 0) {
          try {
            await this.stopWeb(runtime.ssh, layout, { pid: leftoverPid })
            this.#log(runtime, 'info', `stopped a non-adoptable remote web instance pid=${leftoverPid}`)
          } catch (error) {
            this.#log(runtime, 'warn', 'could not stop the non-adoptable remote web:', String(error?.message ?? error))
          }
        }
        await this.#resolveForeignConflict(runtime, layout, profile)
        this.#phase(runtime, 'bootstrap', 'bootstrapping', { level: plan.level })
        // Resolve the exact package in the foreground first: a cold npx download
        // belongs in the connect error, not in a detached process that only leaves
        // a log behind. This also warms the cache for the real start below. There is
        // no deadline: a cold cache can take minutes, so its output becomes progress.
        const reportStdout = this.#bootstrapReporter(runtime, plan.start.targetVersion)
        const reportStderr = this.#bootstrapReporter(runtime, plan.start.targetVersion)
        await this.preflight(runtime.ssh, plan, { onStdout: reportStdout, onStderr: reportStderr })
        this.#phase(runtime, 'start', 'starting-remote', { level: plan.level })
        webInfo = await this.startWeb(runtime.ssh, {
          plan,
          layout,
          profile,
          timeoutMs: REMOTE_START_TIMEOUT_MS,
          onLine: (line) => this.#log(runtime, 'debug', `remote: ${line}`),
        })
      }
      if (webInfo.browserCarrier === 'patched') {
        this.#log(
          runtime,
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
      // X-Frame-Options / CSP no longer matter: the remote UI is rendered by the
      // desktop guest, not embedded in a frame, so a page that refuses framing is
      // still a perfectly usable remote host.
      runtime.remote.uiReady = true
      await this.store.patchHost(runtime.id, { lastOpenedAt: nowIso() })
      runtime.entry = this.store.getHost(runtime.id) ?? runtime.entry
      if (this.store.getSettings().saveTokens) await this.store.saveToken(runtime.id, webInfo.token)
      // Remember the password now that it is proven, if the user asked for that.
      if (runtime.savePassword === true && typeof runtime.password === 'string' && this.secrets) {
        runtime.passwordSaved = await this.secrets.set(runtime.id, runtime.password)
      }
      runtime.status = 'connected'
      runtime.phase = 'ready'
      runtime.progress = { code: 'ready' }
      runtime.error = null
      this.activeHostId = runtime.id
      this.#attachDisconnectHandler(runtime)
      this.#emitState()
      this.#log(runtime, 'info', `connected: remote ${runtime.remote.version} on 127.0.0.1:${runtime.tunnel.localPort}`)
    } catch (error) {
      const view = toErrorView(error)
      const cancelled = runtime.desired !== 'connected'
      if (cancelled) {
        // A user-initiated disconnect/teardown resolved a pending prompt (or closed
        // the window) while the pipeline was in flight: this is not a failure.
        runtime.error = null
        runtime.status = 'disconnected'
        runtime.phase = null
        runtime.progress = null
        this.#log(runtime, 'info', 'connect cancelled by disconnect')
      } else {
        runtime.error = view
        runtime.status = 'error'
        runtime.phase = null
        runtime.progress = null
        this.#log(
          runtime,
          'warn',
          `connect failed: ${view.code}`,
          error instanceof Error ? error.message : String(error),
        )
      }
      runtime.remote.uiReady = false
      runtime.remote.localPort = null
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
   * Warn when the remote already runs a DSH this plugin did not start, and let
   * the user decide: stop it, keep it alongside, or cancel.
   * @param {any} runtime
   * @param {ReturnType<typeof remoteLayout>} layout
   * @param {string} profile
   */
  async #resolveForeignConflict(runtime, layout, profile) {
    /** @type {number[]} */
    const ignorePids = []
    try {
      const registry = await this.readRegistry(runtime.ssh, layout)
      const pid = Number(registry?.pid)
      if (Number.isInteger(pid) && pid > 0 && registry?.dshHome === layout.dshHome && registry?.profile === profile) {
        ignorePids.push(pid)
      }
    } catch (error) {
      // swallow-ok: registry absence is normal; the scan below still finds foreign processes
      this.#log(runtime, 'debug', 'foreign DSH: registry read failed:', String(error?.message ?? error))
    }
    const found = await this.findForeign(runtime.ssh, { ignorePids })
    if (found.ok !== true) {
      this.#log(runtime, 'debug', 'foreign DSH: scan failed:', found.reason ?? found.technical ?? 'unknown')
      return
    }
    if (found.processes.length === 0) return

    const decision = await this.#askConflict(runtime, found.processes)
    if (decision.action === 'cancel') throw errors.remoteDshRunning()
    if (decision.action === 'alongside') {
      runtime.warning = {
        zh: '远端已有手工启动的 DSH；已按你的选择并存运行，两者共享 ~/.dsh，请避免同时操作同一会话。',
        en: 'A manually started DSH is already running; it was kept as you chose. Both share ~/.dsh, so avoid editing the same session in both.',
      }
      return
    }
    const stopped = await this.stopForeign(runtime.ssh, found.processes)
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
    this.#log(runtime, 'info', `stopped ${found.processes.length} manual remote DSH process(es)`)
  }

  /**
   * Pause the pipeline for a user decision about foreign remote processes.
   * Mirrors the host-key prompt: a state, a promise, and a bounded timeout.
   * @param {any} runtime
   * @param {{ pid: number, command: string }[]} processes
   * @returns {Promise<{ action: 'stop'|'alongside'|'cancel', timedOut?: boolean }>}
   */
  #askConflict(runtime, processes) {
    runtime.status = 'conflict-pending'
    runtime.progress = { code: 'remote-dsh-running', params: { count: processes.length } }
    runtime.conflict = {
      detectedAt: nowIso(),
      processes: processes.slice(0, 20).map((process) => ({
        pid: process.pid,
        command: String(process.command ?? '').slice(0, 400),
      })),
    }
    this.#emitState()
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (/** @type {{ action: 'stop'|'alongside'|'cancel', timedOut?: boolean }} */ decision) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (runtime.pendingConflict?.resolve === finish) runtime.pendingConflict = null
        runtime.conflict = null
        if (runtime.desired === 'connected') {
          runtime.status = 'connecting'
          runtime.progress = { code: 'probing' }
        }
        this.#emitState()
        resolve(decision)
      }
      timer = setTimeout(() => finish({ action: 'cancel', timedOut: true }), this.conflictConfirmTimeoutMs)
      runtime.pendingConflict = { processes, resolve: finish }
    })
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
      // The key path is expanded against the *user* home (`~/.ssh/...`), never
      // against DSH_HOME, so the SSH layer needs to know which one that is.
      home: this.userHome(),
      auth: {
        type: runtime.entry.auth?.type ?? 'key',
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
  #cancelConflict(runtime) {
    const pending = runtime.pendingConflict
    runtime.pendingConflict = null
    runtime.conflict = null
    if (pending) pending.resolve({ action: 'cancel' })
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
        await this.stopWeb(runtime.ssh, remoteLayout(runtime.facts?.home ?? null), {
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
    this.#cancelConflict(runtime)
    runtime.closing = true
    this.#cancelIdleStop(runtime)
    if (options.stopRemote && runtime.ssh?.connected) {
      try {
        await this.stopWeb(runtime.ssh, remoteLayout(runtime.facts?.home ?? null), {
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
      runtime.facts = null
      runtime.exchange = null
    }
  }

  // ---------------------------------------------------------- diagnostics

  /**
   * Run the wizard/diagnostic checklist (design §4.4). Uses the live connection
   * when present; otherwise honest `unknown` rows instead of new connections.
   * @param {string} id
   */
  /** @param {string} id */
  async diagnose(id) {
    await this.init()
    return diagnoseHost(this.#runtime(id), { targetVersion: this.localVersion })
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

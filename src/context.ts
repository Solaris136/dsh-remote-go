/** The assembled service context: the one file that knows every injected leaf. Six narrow slices replaced the old
 * 47-key god-`ctx`, so a module reaches only the capability it declares; the assembled object keeps the same keys and
 * paths because tests use `service.ctx` as public API. Narrowing is in the parameter types, never a rename. */
import { planNpx, verifyNpxVersion } from './bootstrap.js'
import {
  REMOTE_CONFLICT_TIMEOUT_MS,
  REMOTE_REATTACH_ATTEMPTS,
  REMOTE_REATTACH_INTERVAL_MS,
  REMOTE_TUNNEL_REPAIR_SETTLE_MS,
  REMOTE_UNREACHABLE_CONFIRM_DELAY_MS,
  REMOTE_UNREACHABLE_RECHECK_DELAY_MS,
} from './constants.js'
import { createConnectProgress } from './connect-progress.js'
import { loadLocalSshMaterial } from './local-ssh.js'
import { ensureRemoteNode } from './node-runtime.js'
import { probeRemote } from './probe.js'
import {
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  remoteHttpStatus,
  remoteProcessIdentity,
  stopForeignDshProcesses,
  waitForRemoteUi,
} from './remote-proc.js'
import { clearRunRegistry, readRunRegistry, writeRunRegistry } from './remote-web/registry.js'
import { adoptRemoteWeb, resolveRemoteWeb } from './remote-web/resolve.js'
import { startRemoteWeb } from './remote-web/start.js'
import { stopRemoteWeb } from './remote-web/stop.js'
import { createSsh2Port } from './ssh.js'
import type { SshFactory } from './ssh-port.js'
import { createTunnel, probeLoopback } from './tunnel.js'
import type { EpisodeSource, HostRuntime } from './host-runtime.js'
import type { SecretStore } from './secrets.js'
import type { Settings } from './settings.js'
import type { HostStore } from './store.js'
import { createWatchdogBus, type WatchdogBus } from './watchdog-bus.js'
export type ServiceLogger = {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}
export interface ServiceDeps {
  sshFactory: SshFactory
  tunnelFactory: typeof createTunnel
  tunnelProbe: typeof probeLoopback
  probe: typeof probeRemote
  plan: typeof planNpx
  ensureNode: typeof ensureRemoteNode
  preflight: typeof verifyNpxVersion
  startWeb: typeof startRemoteWeb
  stopWeb: typeof stopRemoteWeb
  waitUi: typeof waitForRemoteUi
  exchange: typeof exchangeTokenOverTunnel
  adopt: typeof adoptRemoteWeb
  resolveRemote: typeof resolveRemoteWeb
  writeRegistry: typeof writeRunRegistry
  clearRegistry: typeof clearRunRegistry
  remoteStatus: typeof remoteHttpStatus
  processIdentity: typeof remoteProcessIdentity
  findForeign: typeof findForeignDshProcesses
  stopForeign: typeof stopForeignDshProcesses
  readRegistry: typeof readRunRegistry
  loadSshMaterial: typeof loadLocalSshMaterial
}

export interface ServiceTimers {
  hostKeyConfirmMs: number
  conflictConfirmMs: number
  remoteConfirmDelayMs: number
  remoteRecheckMs: number
  reattachAttempts: number
  reattachIntervalMs: number
  tunnelRepairSettleMs: number
}

export interface ServiceState {
  runtimes: Map<string, HostRuntime>
  activeHostId: string | null
  initialized: boolean
  disposed: boolean
}

export interface RemoteUnreachableInfo {
  phase: 'suspected' | 'confirmed' | 'recovered'
  source: string
  failures?: number
}

export interface ReattachRequest {
  reason?: string
  source?: string
}

export type ConnectProgress = ReturnType<typeof createConnectProgress>
/** 1/6 — host facts: the single mutable table (`ctx.state.runtimes` is the frozen path every reader uses). */
export interface HostState {
  readonly state: ServiceState
}
export interface Config {
  readonly home: string
  readonly timers: ServiceTimers
  /** Live reads: a setting can change while a connect is already in flight. */
  settings(): Settings
  localVersion(): string | null
  engineNodeRange(): string | null
  userHome(): string
}

export type TransportPorts = Pick<
  ServiceDeps,
  | 'sshFactory'
  | 'tunnelFactory'
  | 'tunnelProbe'
  | 'processIdentity'
  | 'loadSshMaterial'
  | 'probe'
  | 'plan'
  | 'ensureNode'
  | 'preflight'
>
export interface Transport {
  readonly deps: TransportPorts
}

export type RemoteWebPorts = Pick<
  ServiceDeps,
  | 'startWeb'
  | 'stopWeb'
  | 'waitUi'
  | 'exchange'
  | 'adopt'
  | 'resolveRemote'
  | 'writeRegistry'
  | 'clearRegistry'
  | 'remoteStatus'
  | 'findForeign'
  | 'stopForeign'
  | 'readRegistry'
>
export interface RemoteDeps {
  readonly deps: RemoteWebPorts
}
/** 5/6 — reporting: connect log, progress, state publishing and liveness episodes. It cannot write a host `status`:
 * the two writers of a progress frame are `ConnectProgress` and the runtime itself. `noteRemoteUnreachable` is a
 * compat alias (tests drive a proxy/tunnel failure through `service.ctx`), `bus` the watchdog's action channel. */
export interface Reporter {
  readonly logger: ServiceLogger
  readonly progress: ConnectProgress
  emitState(): void
  onRemoteUnreachable?: (runtime: HostRuntime, info: RemoteUnreachableInfo) => void
  noteRemoteUnreachable?: (runtime: HostRuntime, source: EpisodeSource) => void
  readonly bus: WatchdogBus
}
export interface Store {
  readonly store: HostStore
  readonly secrets: SecretStore | null
  init(): Promise<unknown>
}

export type Ctx = HostState & Config & Transport & RemoteDeps & Reporter & Store
/** What a connect-orchestration entry point receives: the six entries genuinely span all six slices, so the alias makes
 * them recognizable at a glance. */
export type ConnectCtx = Ctx

export type WatchdogCtx = HostState & Config & Transport & RemoteDeps & Reporter
/** The single teardown path; its capability set is the watchdog's because it hands the context to the idle policy. */
export type TeardownCtx = WatchdogCtx

export type PromptCtx = Config & Reporter & Store
/** Constructor input: the store and home the Host half resolved, plus every injectable step. The key set is a frozen
 * contract — `test/helpers/fake-remote.ts` overrides 30 of these by name. */
export interface ServiceOptions extends Partial<ServiceDeps> {
  store: HostStore
  home: string
  logger?: ServiceLogger
  localVersion?: string | null
  engineNodeRange?: string | null
  secrets?: SecretStore | null
  hostKeyConfirmTimeoutMs?: number
  conflictConfirmTimeoutMs?: number
  logLevel?: string
  remoteConfirmDelayMs?: number
  remoteRecheckMs?: number
  reattachAttempts?: number
  reattachIntervalMs?: number
  tunnelRepairSettleMs?: number
}
/** What only the facade can supply: `localVersion`/`engineNodeRange` are read live, because the facade can adopt a
 * version mid-connect. */
export interface ServiceHooks {
  publish(): void
  publishLogs(hostId: string): void
  load(): Promise<unknown>
  localVersion(): string | null
  engineNodeRange(): string | null
  onEpisode(runtime: HostRuntime, info: RemoteUnreachableInfo): void
}
const HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000
/** Build the one context object: every leaf written out explicitly (no spread), so a missing or misspelled field is a
 * compile error instead of an `undefined` a connection trips over. Nothing here reads the object being built —
 * publishing and loading go through `hooks`, so the literal is complete before the first callback fires, which is why
 * `satisfies Ctx` proves the shape without an `as` assertion. */
export function createCtx(options: ServiceOptions, hooks: ServiceHooks): Ctx {
  const logger: ServiceLogger = options.logger ?? console
  const logLevel = typeof options.logLevel === 'string' ? options.logLevel : null
  const timers: ServiceTimers = {
    hostKeyConfirmMs: options.hostKeyConfirmTimeoutMs ?? HOST_KEY_CONFIRM_TIMEOUT_MS,
    conflictConfirmMs: options.conflictConfirmTimeoutMs ?? REMOTE_CONFLICT_TIMEOUT_MS,
    remoteConfirmDelayMs: options.remoteConfirmDelayMs ?? REMOTE_UNREACHABLE_CONFIRM_DELAY_MS,
    remoteRecheckMs: options.remoteRecheckMs ?? REMOTE_UNREACHABLE_RECHECK_DELAY_MS,
    reattachAttempts: options.reattachAttempts ?? REMOTE_REATTACH_ATTEMPTS,
    reattachIntervalMs: options.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS,
    tunnelRepairSettleMs: options.tunnelRepairSettleMs ?? REMOTE_TUNNEL_REPAIR_SETTLE_MS,
  }
  const deps: ServiceDeps = {
    sshFactory: options.sshFactory ?? ((sshOptions) => createSsh2Port(sshOptions)),
    tunnelFactory: options.tunnelFactory ?? createTunnel,
    tunnelProbe: options.tunnelProbe ?? probeLoopback,
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
    clearRegistry: options.clearRegistry ?? clearRunRegistry,
    remoteStatus: options.remoteStatus ?? remoteHttpStatus,
    processIdentity: options.processIdentity ?? remoteProcessIdentity,
    findForeign: options.findForeign ?? findForeignDshProcesses,
    stopForeign: options.stopForeign ?? stopForeignDshProcesses,
    readRegistry: options.readRegistry ?? readRunRegistry,
    loadSshMaterial: options.loadSshMaterial ?? loadLocalSshMaterial,
  }
  const progress: ConnectProgress = createConnectProgress({
    logger,
    logLevel,
    getSettings: () => options.store.getSettings(),
    emitState: () => hooks.publish(),
    emitLogs: (runtime) => hooks.publishLogs(runtime.id),
  })
  // One bus per service instance: a test (or a plugin reload) that builds a second service must not
  // inherit the first one's subscriber.
  const bus = createWatchdogBus({ warn: logger.warn })
  const state: ServiceState = {
    runtimes: new Map<string, HostRuntime>(),
    activeHostId: null,
    initialized: false,
    disposed: false,
  }
  const ctx = {
    state,
    home: options.home,
    timers,
    // Live readers, never cached: a setting or a detected version can change mid-connect.
    settings: () => options.store.getSettings(),
    localVersion: () => hooks.localVersion(),
    engineNodeRange: () => hooks.engineNodeRange(),
    userHome: () => process.env.USERPROFILE || process.env.HOME || options.home,
    deps,
    store: options.store,
    secrets: options.secrets ?? null,
    init: () => hooks.load(),
    logger,
    progress,
    emitState: () => hooks.publish(),
    bus,
    onRemoteUnreachable: (runtime: HostRuntime, info: RemoteUnreachableInfo) => {
      hooks.onEpisode(runtime, info)
    },
  } satisfies Ctx
  return ctx
}

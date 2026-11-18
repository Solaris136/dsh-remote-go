/**
 * The assembled service context: the one file that knows every injected leaf.
 *
 * P2/1 replaced the 47-key god-`ctx` with six narrow slices, so a module can only reach the
 * capability it declares; the assembly that used to sit in `RemoteGoService`'s constructor moved
 * here. The assembled object keeps the shape it has always had — the same keys under the same
 * paths — because 36 test call sites use `service.ctx` as a public API (design-arch §1.6) and
 * every consumer keeps its `ctx.state.*` / `ctx.deps.*` / `ctx.timers.*` spelling. Narrowing
 * happens in the *parameter* types below, never by renaming a field.
 */
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
import { SshConnection } from './ssh.js'
import type { SshConnectionOptions } from './ssh.js'
import { createTunnel, probeLoopback } from './tunnel.js'
import type { EpisodeSource, HostRuntime } from './host-runtime.js'
import type { SecretStore } from './secrets.js'
import type { Settings } from './settings.js'
import type { HostStore } from './store.js'
import { createWatchdogBus } from './watchdog-bus.js'
import type { WatchdogBus } from './watchdog-bus.js'

/**
 * The Host-process logger this service reports through. Every method is optional: the plugin
 * entry passes `console`, tests pass a collector, and calling one that is absent must not throw.
 *
 * A type alias (not an interface) on purpose: `createConnectProgress` takes an index-signature
 * logger, and only an alias of an object type gets the implicit index signature that satisfies it.
 */
export type ServiceLogger = {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

/**
 * The injected collaborators: every external step the pipeline can take, so a test can replace
 * any of them. Each signature is the production implementation's own — no looser stand-in.
 */
export interface ServiceDeps {
  sshFactory: (options: SshConnectionOptions) => SshConnection
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

/** The two confirm-prompt deadlines, the liveness windows and the re-attach budget. */
export interface ServiceTimers {
  hostKeyConfirmMs: number
  conflictConfirmMs: number
  remoteConfirmDelayMs: number
  remoteRecheckMs: number
  reattachAttempts: number
  reattachIntervalMs: number
  tunnelRepairSettleMs: number
}

/** The mutable registry state: one runtime per configured host, plus the active one. */
export interface ServiceState {
  runtimes: Map<string, HostRuntime>
  activeHostId: string | null
  initialized: boolean
  disposed: boolean
}

/** One liveness episode transition, as `remote-unreachable` listeners receive it. */
export interface RemoteUnreachableInfo {
  phase: 'suspected' | 'confirmed' | 'recovered'
  source: string
  failures?: number
}

/** Why a re-attach was requested (the watchdog's phase code and the source that saw it). */
export interface ReattachRequest {
  reason?: string
  source?: string
}

/** The connect-progress writer the service owns (see `connect-progress.ts`). */
export type ConnectProgress = ReturnType<typeof createConnectProgress>

/**
 * 1/6 — host facts: the single mutable table. Writer: `host-registry.ts`.
 *
 * `state` is a field and not four flattened members because the assembled object's paths are
 * frozen (see the module comment): `ctx.state.runtimes` is what every reader and every test uses.
 */
export interface HostState {
  readonly state: ServiceState
}

/** 2/6 — configuration: live readers that are never cached, plus the shorten-able time constants. */
export interface Config {
  readonly home: string
  /** `ctx.timers.*` keeps its historic path (design-arch §1.2: the old `Clock` is this field). */
  readonly timers: ServiceTimers
  /** Live reads: a setting can change while a connect is already in flight. */
  settings(): Settings
  localVersion(): string | null
  engineNodeRange(): string | null
  userHome(): string
}

/** The transport half of `deps`: SSH dial, listener, process identity and the remote-runtime factories. */
export type TransportPorts = Pick<
  ServiceDeps,
  | 'sshFactory'
  | 'tunnelFactory'
  | 'tunnelProbe'
  | 'processIdentity'
  | 'loadSshMaterial'
  // The four "bootstrap" leaves the design once drafted as their own interface; their paths are
  // still `ctx.deps.probe` / `plan` / `ensureNode` / `preflight`, so they narrow with the transport.
  | 'probe'
  | 'plan'
  | 'ensureNode'
  | 'preflight'
>

/** 3/6 — transport + remote runtime factories. P5 grows the `SshPort` port out of `sshFactory`. */
export interface Transport {
  readonly deps: TransportPorts
}

/** The remote-web half of `deps`: the managed remote DSH and its run registry. */
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

/** 4/6 — the remote web and its registry (12 leaves). */
export interface RemoteDeps {
  readonly deps: RemoteWebPorts
}

/**
 * 5/6 — reporting: connect log, progress, state publishing and liveness episodes.
 *
 * It cannot write a host `status`: the two writers of a progress frame are `ConnectProgress`
 * (phase/progress) and the runtime itself, and P2's FSM work moves the last status writes out of
 * here (design-arch §2.2).
 *
 * `noteRemoteUnreachable` is a *compatibility alias*, not a capability: the liveness code lives in
 * `watchdog.ts` and every production caller imports it forward. The alias stays on this slice
 * because 13 test call sites drive a proxy/tunnel failure through `service.ctx` (design-arch
 * §1.7); the facade assigns the same function reference the forward import gives anybody else.
 *
 * `bus` is the watchdog's action channel (design-arch §1.7): a detection publishes there, and
 * `connect/watchdog.ts` — its only subscriber — runs the action. P2's step 9 replaced the two
 * reverse callbacks this slice used to carry with it, so it no longer reaches into the
 * orchestration it belongs to.
 */
export interface Reporter {
  readonly logger: ServiceLogger
  readonly progress: ConnectProgress
  /** The state model changed once: bump `rev` and broadcast. Only this publishes (DECISIONS B1). */
  emitState(): void
  onRemoteUnreachable?: (runtime: HostRuntime, info: RemoteUnreachableInfo) => void
  /** Test/API compatibility alias of `watchdog.ts#noteRemoteUnreachable` (see above). */
  noteRemoteUnreachable?: (runtime: HostRuntime, source: EpisodeSource) => void
  /** The watchdog action bus: the liveness detector publishes, `connect/watchdog.ts` subscribes. */
  readonly bus: WatchdogBus
}

/** 6/6 — persistence: hosts/settings/token plus the credential store. */
export interface Store {
  readonly store: HostStore
  readonly secrets: SecretStore | null
  /** The lazy `await ctx.init()`: the first load, idempotent (`state.initialized`). */
  init(): Promise<unknown>
}

/** The whole assembled context. Only the assembly root and the facade may hold it. */
export type Ctx = HostState & Config & Transport & RemoteDeps & Reporter & Store

/**
 * What a connect-orchestration entry point receives.
 *
 * The six entries (connect / reconnect / restart / stop / reattach / repair) genuinely span all
 * six slices — resolving a target needs `Transport`, starting the remote needs `RemoteDeps`,
 * logging needs `Reporter`, the registry needs `Store`. Splitting them into six parameters would
 * narrow nothing; what narrows is everything *below* the orchestration (design-arch §1.2).
 * Same type as `Ctx` on purpose: the alias makes an orchestration entry recognizable at a glance.
 */
export type ConnectCtx = Ctx

/**
 * The watchdog (heartbeat, episode confirmation, idle stop, reconnect): everything except the
 * persistence layer, which it never reads.
 */
export type WatchdogCtx = HostState & Config & Transport & RemoteDeps & Reporter

/**
 * The single teardown path (`teardownRuntime` / `disconnectHost` / `shutdownAll`).
 *
 * Its capability set is the watchdog's: teardown reads the timer budget, logs, probes nothing —
 * but it hands the same context to the idle-stop policy, so the two surfaces coincide. Naming it
 * separately keeps the intent ("this is teardown, not the watchdog") in every signature.
 */
export type TeardownCtx = WatchdogCtx

/** The two prompts: a policy from `settings`, a deadline from `timers`, a pin written to `store`. */
export type PromptCtx = Config & Reporter & Store

/**
 * Constructor input: the store and home the Host half resolved, plus every injectable step.
 *
 * The key set is a frozen contract — `test/helpers/fake-remote.js` overrides 30 of these by name
 * (design-arch §1.6), so a renamed key silently stops being overridden.
 */
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

/**
 * What only the facade can supply, because it owns the state behind it.
 *
 * `localVersion` / `engineNodeRange` are read live rather than copied: the facade adopts a
 * detected (or Client-backfilled) version at any moment, including mid-connect, and `api.ts`
 * reads the field on the facade directly. One fact, one seat.
 */
export interface ServiceHooks {
  /** `service.emitState()`: revision bump plus broadcast (the `Reporter.emitState` leaf). */
  publish(): void
  /** `service.emitLogs(hostId)`: publish one host's appended rows on the log channel only. */
  publishLogs(hostId: string): void
  /** `service.init()`: the facade's lazy first load (the `Store.init` leaf). */
  load(): Promise<unknown>
  localVersion(): string | null
  engineNodeRange(): string | null
  /** One liveness episode, published as the `remote-unreachable` event the Client listens to. */
  onEpisode(runtime: HostRuntime, info: RemoteUnreachableInfo): void
}

/** Milliseconds a paused host-key handshake waits for the user. */
const HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000

/**
 * Build the one context object. Every leaf is written out explicitly (no spread): a missing or
 * misspelled field is then a compile error instead of an `undefined` that only surfaces when a
 * connection happens to read it.
 *
 * Nothing here reads the object being built — publishing and loading go through `hooks`, so the
 * literal is complete before the first callback can fire. That is also why no `as Ctx` assertion
 * is needed: `satisfies Ctx` proves the shape and keeps the result fully typed.
 * @param options - the constructor input, defaults applied per leaf.
 * @param hooks - the five leaves only the facade can supply (see `ServiceHooks`).
 * @returns the assembled context.
 */
export function createCtx(options: ServiceOptions, hooks: ServiceHooks): Ctx {
  const logger: ServiceLogger = options.logger ?? console
  const logLevel = typeof options.logLevel === 'string' ? options.logLevel : null
  const timers: ServiceTimers = {
    hostKeyConfirmMs: options.hostKeyConfirmTimeoutMs ?? HOST_KEY_CONFIRM_TIMEOUT_MS,
    conflictConfirmMs: options.conflictConfirmTimeoutMs ?? REMOTE_CONFLICT_TIMEOUT_MS,
    // Liveness confirmation and the re-attach retry loop; tests shorten these.
    remoteConfirmDelayMs: options.remoteConfirmDelayMs ?? REMOTE_UNREACHABLE_CONFIRM_DELAY_MS,
    remoteRecheckMs: options.remoteRecheckMs ?? REMOTE_UNREACHABLE_RECHECK_DELAY_MS,
    reattachAttempts: options.reattachAttempts ?? REMOTE_REATTACH_ATTEMPTS,
    reattachIntervalMs: options.reattachIntervalMs ?? REMOTE_REATTACH_INTERVAL_MS,
    tunnelRepairSettleMs: options.tunnelRepairSettleMs ?? REMOTE_TUNNEL_REPAIR_SETTLE_MS,
  }
  const deps: ServiceDeps = {
    sshFactory: options.sshFactory ?? ((sshOptions) => new SshConnection(sshOptions)),
    tunnelFactory: options.tunnelFactory ?? createTunnel,
    /** Local listener health: decides whether a transient proxy failure needs a rebuild. */
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
    // Log rows and progress lines have different channels (docs/api.md v2.12): a row is not a
    // state change, so it must not bump the revision the Client gates everything else on.
    emitLogs: (runtime) => hooks.publishLogs(runtime.id),
  })
  // One bus per service instance: a test (or a plugin reload) that builds a second service must
  // not inherit the first one's subscriber.
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
    // Live readers, never cached: a setting or a detected version can change while a connect is
    // already in flight.
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

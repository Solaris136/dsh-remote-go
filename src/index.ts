/**
 * dsh-remote-go — Host half: registers the local HTTP API and the browser half's same-origin remote proxy,
 * and owns the SSH / bootstrap / tunnel lifecycle; it never copies remote data.
 */
import { API_PREFIX, PLUGIN_ID, REMOTE_VIEW_PREFIX } from './constants.js'
import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmission } from './admission.js'
import { createApi } from './api.js'
import { KERNEL_PROBE_VERSION, createKernelAdapter } from './kernel-adapter.js'
import type { KernelAdapter, KernelProbeReport } from './kernel-adapter.js'
import { detectLocalEnginesNode, detectLocalVersion } from './local-version.js'
import { createRemoteProxy } from './proxy/index.js'
import type { UpgradeRegistration } from './proxy/index.js'
import { RemoteGoService } from './service.js'
import { createSecretStore } from './secrets.js'
import { HostStore, resolveDshHome, resolveStateDir } from './store.js'
import { registerHostTools } from './tools.js'
import type { ToolContext } from './tools.js'
import { messageOf } from './util.js'

/** One prefix registration on DSH's own web server. */
interface WebRegistration {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

/** The HTTP server service the kernel injects as `webServer`. */
interface WebServerService {
  getOrigin?: () => string | null
  register: (registration: WebRegistration) => () => void
  /**
   * Exact-path upgrade routes: the same-origin proxy registers one per connected host. Optional
   * because a kernel without it degrades to "no remote stream" instead of failing the plugin.
   */
  registerUpgrade?: (registration: UpgradeRegistration) => () => void
}

/**
 * The plugin context this entry drives. Every member is the slice cordis actually provides; the
 * optional ones are the services this plugin may run without (`connection`, `credentials`, `tools`
 * are looked up, never injected as required).
 *
 * The loader's own metadata (`fiber`, `clientModules`) is deliberately *not* declared here: it is
 * read through `kernel-adapter.ts`, which is the only module allowed to know that shape.
 */
interface PluginContext {
  webServer?: WebServerService
  get: (name: string) => unknown
  /** `webServer` is the only injected service; effects are released when the fiber unloads. */
  effect?: (setup: () => () => void, label?: string) => () => void
  inject?: (names: string[], apply: (scoped: ToolContext) => () => void) => { dispose?: () => void } | undefined
}

/** The plugin configuration DSH passes to `apply` (all of it optional). */
interface PluginConfig {
  home?: string
  localVersion?: string
  hostKeyConfirmTimeoutMs?: number
}

/** The facts `describeSelf` reports about this installation. */
interface SelfInfo {
  home: string
  stateDir: string
  localVersion: string | null
  engineNodeRange: string | null
  storeCorrupt: boolean
}

/**
 * The `/diagnostics/self` document body.
 *
 * A `type`, not an `interface`: the API option declares `() => Record<string, unknown>`, and only
 * an object type literal is assignable to an index signature.
 *
 * `kernel` is additive (v2.12): `entry` and `client` keep their historical shape and their `null`s,
 * while `kernel.probes` reports *why* a field is null (absent service vs. moved shape).
 */
type SelfReport = {
  home: string
  stateDir: string
  hostVersion: string | null
  engineNodeRange: string | null
  storeCorrupt: boolean
  entry: { id: string | null; name: string | null } | null
  client: Record<string, unknown> | null
  kernel: { version: string; probes: KernelProbeReport }
}

export const name = PLUGIN_ID
export const inject = ['webServer']

export const optional = ['connection', 'credentials']

export function apply(ctx: PluginContext, config: PluginConfig = {}): RemoteGoService {
  const logger = createLogger()
  // The kernel's own metadata (loader fiber, client-module registry) is read through one adapter,
  // so `/diagnostics/self` and every future kernel probe share the same three-state answers.
  const kernel = createKernelAdapter(ctx)
  const home = config.home ? String(config.home) : resolveDshHome(process.env)
  const stateDir = resolveStateDir(home)
  const store = new HostStore({ dir: stateDir, logger })
  // Saved SSH passwords live in DSH's credential store, never in hosts.json.
  const secrets = createSecretStore({ ctx, logger })
  const service = new RemoteGoService({
    store,
    home,
    logger,
    secrets,
    localVersion: config.localVersion ? String(config.localVersion) : null,
    hostKeyConfirmTimeoutMs: config.hostKeyConfirmTimeoutMs,
  })
  const getOrigin = (): string | null => {
    try {
      return ctx.webServer?.getOrigin?.() ?? null
    } catch {
      return null
    }
  }
  // DSH's own admission for every route this plugin serves: the kernel's Host/Origin fence plus
  // browser-session authentication. `connection` is optional, so the gate hands the request to the
  // plugin's own fence when the service is absent (see admission.js).
  const admit = createAdmission(ctx, logger)
  const api = createApi({
    service,
    getOrigin,
    admit,
    logger,
    diagnostics: () =>
      describeSelf(kernel, {
        home,
        stateDir,
        localVersion: service.localVersion,
        engineNodeRange: service.engineNodeRange,
        storeCorrupt: store.hostsCorrupt,
      }),
  })
  // The browser half's remote window lives on the local origin (the desktop half uses a guest
  // instead), so the same-origin proxy is the only thing that needs to know how to reach a tunnel.
  const proxy = createRemoteProxy({
    webServer: ctx.webServer,
    getOrigin,
    admit,
    resolveHost: (id: string) => service.webViewTarget(id),
    // A failed upstream is a suspicion, not a restart: the service confirms it with probes.
    onUpstreamError: (id: string) => service.noteUpstreamFailure(id),
    logger,
  })

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void api.handler(req, res)
      },
    })
    const disposeView = ctx.webServer.register({
      kind: 'prefix',
      path: proxy.routePath,
      handler: (req: IncomingMessage, res: ServerResponse) => proxy.handle(req, res),
    })
    // The model-facing host list lives on the Host half only: a local LLM session reads the same
    // snapshot the switcher renders, and the remote DSH never loads this package.
    const disposeTools = registerHostTools(ctx, { service, logger })
    const syncViewRoutes = () => proxy.sync(service.hostIds())
    service.on('state', syncViewRoutes)
    logger.info(`API mounted at ${API_PREFIX} (state dir ${stateDir})`)
    logger.info(`remote view mounted at ${REMOTE_VIEW_PREFIX}<host> (browser carrier)`)

    void (async () => {
      try {
        await service.init()
        syncViewRoutes()
        const detected = await detectLocalVersion({ ctx, logger })
        if (detected.version) service.setLocalVersion(detected.version, detected.source)
        // The managed Node version is the lower bound of DSH's own `engines.node`;
        // reading it here keeps the plugin in step with the running DSH build.
        const engine = await detectLocalEnginesNode({ ctx })
        // `setLocalEnginesNode` has always taken one parameter; the source is not persisted there
        // (only `setLocalVersion` reports where its value came from).
        if (engine.range) service.setLocalEnginesNode(engine.range)
        if (!detected.version)
          logger.warn(
            'could not detect the local DSH version; the remote npx runtime cannot be pinned to this machine, so connections will fail until the version is readable',
          )
      } catch (error) {
        logger.error('initialization failed:', error)
      }
    })()

    return () => {
      service.removeListener('state', syncViewRoutes)
      // A failing disposer must not skip the rest of the unload: the proxy, the API and the SSH
      // transports below still have to be released.
      try {
        disposeTools()
      } catch (error) {
        logger.error('unload: could not dispose the model tools:', error)
      }
      proxy.dispose()
      api.dispose()
      void service.shutdown()
      disposeRoute()
      disposeView()
      logger.info('unloaded')
    }
  }, 'dsh-remote-go: http api + service')

  return service
}

/**
 * The `/diagnostics/self` body: the installation facts plus the kernel probe table.
 *
 * Every kernel read goes through `kernel-adapter.ts`, whose three states map onto this document the
 * same way everywhere: `ok` fills the historical field, `absent`/`changed` leave it `null` (exactly
 * what a missing service used to do) and `kernel.probes` says which of the two it was.
 */
function describeSelf(kernel: KernelAdapter, info: SelfInfo): SelfReport {
  const out: SelfReport = {
    home: info.home,
    stateDir: info.stateDir,
    hostVersion: info.localVersion,
    engineNodeRange: info.engineNodeRange ?? null,
    // True when hosts.json was unreadable and the list beside it is the recovered fallback.
    storeCorrupt: info.storeCorrupt === true,
    entry: null,
    client: null,
    kernel: { version: KERNEL_PROBE_VERSION, probes: kernel.probeReport() },
  }
  const entry = kernel.fiberEntry()
  if (entry.state === 'ok' && entry.value !== null) out.entry = { id: entry.value.id, name: entry.value.name }
  const graph = kernel.clientModuleGraph()
  const row = kernel.clientModuleRow(PLUGIN_ID)
  const clientPathProbe = kernel.clientPath(PLUGIN_ID)
  const clientPath = clientPathProbe.state === 'ok' ? clientPathProbe.value : null
  let bundle: Record<string, unknown> | null = null
  if (clientPath) {
    try {
      const stat = statSync(clientPath)
      bundle = { path: clientPath, size: stat.size, mtimeMs: stat.mtimeMs }
    } catch (error) {
      bundle = { path: clientPath, error: messageOf(error) }
    }
  }
  out.client = {
    graph:
      graph.state === 'ok' && graph.value !== null
        ? { rev: graph.value.rev, release: graph.value.release, entries: graph.value.entries }
        : null,
    row:
      row.state === 'ok' && row.value !== null
        ? {
            id: row.value.id,
            rev: row.value.rev,
            url: row.value.url,
            inject: row.value.inject,
            immediately: row.value.immediately,
          }
        : null,
    clientPath,
    bundle,
  }
  return out
}

function createLogger() {
  const tag = '[dsh-remote-go]'
  const write = (level: 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => {
    const sink =
      level === 'debug'
        ? console.debug
        : level === 'error'
          ? console.error
          : level === 'warn'
            ? console.warn
            : console.info
    try {
      sink?.call(console, tag, ...args)
    } catch {
      // swallow-ok: logging must never throw into the host
    }
  }
  return {
    info: (...args: unknown[]) => write('info', args),
    warn: (...args: unknown[]) => write('warn', args),
    error: (...args: unknown[]) => write('error', args),
    debug: (...args: unknown[]) => write('debug', args),
  }
}

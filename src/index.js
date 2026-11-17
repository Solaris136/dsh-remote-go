/**
 * dsh-remote-go — Host half: registers the local HTTP API and the browser half's same-origin remote proxy,
 * and owns the SSH / bootstrap / tunnel lifecycle; it never copies remote data.
 */
import { API_PREFIX, PLUGIN_ID, REMOTE_VIEW_PREFIX } from './constants.js'
import { statSync } from 'node:fs'
import { createAdmission } from './admission.js'
import { createApi } from './api.js'
import { detectLocalEnginesNode, detectLocalVersion } from './local-version.js'
import { createRemoteProxy } from './remote-proxy.js'
import { RemoteGoService } from './service.js'
import { createSecretStore } from './secrets.js'
import { HostStore, resolveDshHome, resolveStateDir } from './store.js'
import { registerHostTools } from './tools.js'
import { messageOf } from './util.js'

export const name = PLUGIN_ID
export const inject = ['webServer']

export const optional = ['connection', 'credentials']

export function apply(ctx, config = {}) {
  const logger = createLogger()
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
  const getOrigin = () => {
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
      describeSelf(ctx, {
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
    resolveHost: (id) => service.webViewTarget(id),
    // A failed upstream is a suspicion, not a restart: the service confirms it with probes.
    onUpstreamError: (id) => service.noteUpstreamFailure(id),
    logger,
  })

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (/** @type {any} */ req, /** @type {any} */ res) => {
        void api.handler(req, res)
      },
    })
    const disposeView = ctx.webServer.register({
      kind: 'prefix',
      path: proxy.routePath,
      handler: (/** @type {any} */ req, /** @type {any} */ res) => proxy.handle(req, res),
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
        const detected = await detectLocalVersion({ ctx })
        if (detected.version) service.setLocalVersion(detected.version, detected.source)
        // The managed Node version is the lower bound of DSH's own `engines.node`;
        // reading it here keeps the plugin in step with the running DSH build.
        const engine = await detectLocalEnginesNode({ ctx })
        if (engine.range) service.setLocalEnginesNode(engine.range, engine.source)
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

function describeSelf(ctx, info) {
  const out = {
    home: info.home,
    stateDir: info.stateDir,
    hostVersion: info.localVersion,
    engineNodeRange: info.engineNodeRange ?? null,
    // True when hosts.json was unreadable and the list beside it is the recovered fallback.
    storeCorrupt: info.storeCorrupt === true,
    entry: null,
    client: null,
  }
  try {
    const entry = ctx?.fiber?.entry
    out.entry = {
      id: entry?.options?.id ?? null,
      name: entry?.options?.name ?? null,
    }
  } catch {
    /* fiber shape is loader-internal; diagnostics must never throw */
  }
  try {
    const clientModules = ctx?.get?.('clientModules') ?? ctx?.clientModules
    const graph = clientModules?.graph?.()
    const clientPath = clientModules?.clientPath?.(PLUGIN_ID) ?? null
    const row = Array.isArray(graph?.entries) ? (graph.entries.find((item) => item.id === PLUGIN_ID) ?? null) : null
    let bundle = null
    if (clientPath) {
      try {
        const stat = statSync(clientPath)
        bundle = { path: clientPath, size: stat.size, mtimeMs: stat.mtimeMs }
      } catch (error) {
        bundle = { path: clientPath, error: messageOf(error) }
      }
    }
    out.client = {
      graph: graph ? { rev: graph.rev ?? null, release: graph.release ?? null, entries: graph.entries.length } : null,
      row: row
        ? { id: row.id, rev: row.rev, url: row.url, inject: row.inject ?? [], immediately: row.immediately === true }
        : null,
      clientPath,
      bundle,
    }
  } catch (error) {
    out.client = { error: messageOf(error) }
  }
  return out
}

function createLogger() {
  const tag = '[dsh-remote-go]'
  const write = (/** @type {'info'|'warn'|'error'|'debug'} */ level, /** @type {any[]} */ args) => {
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
      /* logging must never throw */
    }
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  }
}

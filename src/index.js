/**
 * dsh-remote-go — Host half.
 *
 * Registers the local HTTP API used by the browser panel and owns the SSH /
 * bootstrap / tunnel lifecycle. The remote DSH UI itself is rendered by the
 * remote host through a window takeover; this half never proxies UI bytes
 * (design §2, §7.0).
 */
import { API_PREFIX, PLUGIN_ID } from './constants.js'
import { statSync } from 'node:fs'
import path from 'node:path'
import { createApi } from './api.js'
import { detectLocalEnginesNode, detectLocalVersion } from './local-version.js'
import { RemoteGoService } from './service.js'
import { canonicalMirrorRoot, createSessionAdapter } from './session-adapter.js'
import { createWorkspaceAdapter } from './workspace-adapter.js'
import { createSecretStore } from './secrets.js'
import { HostStore, resolveDshHome, resolveStateDir } from './store.js'

export const name = PLUGIN_ID
export const inject = ['webServer']

/** Services the plugin can use when the composition provides them. */
export const optional = ['connection', 'workspaceRegistry', 'credentials']

/**
 * @param {any} ctx Cordis context.
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config = {}) {
  const logger = createLogger()
  const home = config.home ? String(config.home) : resolveDshHome(process.env)
  const stateDir = resolveStateDir(home)
  const store = new HostStore({ dir: stateDir, logger })
  // Mirror sessions are an optional host capability: without `ctx.sessions` the
  // adapter answers typed `sessions-unavailable` and the plugin keeps working.
  // Each host gets its own cwd under `$DSH_HOME/remote-go/mirrors/<hostId>`; the
  // remote workspace path is never used (it may not exist on this machine).
  //
  // The root is canonicalized once (realpath) and the same value feeds both
  // adapters: the host's workspace registry canonicalizes registrations, while a
  // session header keeps our literal `meta.cwd`, so with a symlinked or junctioned
  // root the two spellings would otherwise disagree and grouping would depend on
  // the registry canonicalizing the header too (docs/session-design.md §4.3).
  const mirrorRoot = canonicalMirrorRoot(path.join(stateDir, 'mirrors'), { logger })
  const sessionAdapter = createSessionAdapter({
    ctx,
    logger,
    mirrorRoot,
  })
  // Sidebar visibility needs the same directory registered as a workspace: DSH
  // lists sessions per workspace and derives membership from the session's
  // canonical cwd. Optional like `sessions`; absent ⇒ mirrors stay panel-only.
  const workspaceAdapter = createWorkspaceAdapter({
    ctx,
    logger,
    mirrorRoot,
  })
  // Saved SSH passwords live in DSH's credential store, never in hosts.json.
  const secrets = createSecretStore({ ctx, logger })
  const service = new RemoteGoService({
    store,
    home,
    logger,
    secrets,
    localVersion: config.localVersion ? String(config.localVersion) : null,
    hostKeyConfirmTimeoutMs: config.hostKeyConfirmTimeoutMs,
    sessionAdapter,
    workspaceAdapter,
  })
  const getOrigin = () => {
    try {
      return ctx.webServer?.getOrigin?.() ?? null
    } catch {
      return null
    }
  }
  const api = createApi({
    service,
    getOrigin,
    logger,
    diagnostics: () =>
      describeSelf(ctx, {
        home,
        stateDir,
        localVersion: service.localVersion,
        engineNodeRange: service.engineNodeRange,
      }),
  })

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (/** @type {any} */ req, /** @type {any} */ res) => {
        void api.handler(req, res)
      },
    })
    logger.info(`API mounted at ${API_PREFIX} (state dir ${stateDir})`)

    void (async () => {
      try {
        await service.init()
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
      api.dispose()
      void service.shutdown()
      disposeRoute()
      logger.info('unloaded')
    }
  }, 'dsh-remote-go: http api + service')

  return service
}

/**
 * Live self-description for diagnostics and end-to-end acceptance: proves the
 * host row is loaded and whether the browser half is registered in the client
 * module graph (with a readable bundle path).
 * @param {any} ctx
 * @param {{ home: string, stateDir: string, localVersion: string | null, engineNodeRange?: string | null }} info
 */
export function describeSelf(ctx, info) {
  /** @type {Record<string, unknown>} */
  const out = {
    home: info.home,
    stateDir: info.stateDir,
    hostVersion: info.localVersion,
    /** Local DSH `engines.node`; the managed Node version is its lower bound. */
    engineNodeRange: info.engineNodeRange ?? null,
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
    /** @type {Record<string, unknown> | null} */
    let bundle = null
    if (clientPath) {
      try {
        const stat = statSync(clientPath)
        bundle = { path: clientPath, size: stat.size, mtimeMs: stat.mtimeMs }
      } catch (error) {
        bundle = { path: clientPath, error: error instanceof Error ? error.message : String(error) }
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
    out.client = { error: error instanceof Error ? error.message : String(error) }
  }
  return out
}

/** @returns {Record<string, (...args: any[]) => void>} */
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

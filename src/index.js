/**
 * dsh-remote-go — Host half.
 *
 * Registers the local HTTP API used by the browser panel and owns the SSH /
 * bootstrap / tunnel lifecycle. The remote DSH UI itself is rendered by the
 * remote host inside a loopback iframe; this half never proxies UI bytes
 * (design §2, §7.0).
 */
import { API_PREFIX, PLUGIN_ID } from './constants.js'
import { statSync } from 'node:fs'
import { createApi } from './api.js'
import { detectLocalVersion } from './local-version.js'
import { RemoteGoService } from './service.js'
import { HostStore, resolveDshHome, resolveStateDir } from './store.js'

export const name = PLUGIN_ID
export const inject = ['webServer']

/** Services the plugin can use when the composition provides them. */
export const optional = ['connection']

/**
 * @param {any} ctx Cordis context.
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config = {}) {
  const logger = createLogger()
  const home = config.home ? String(config.home) : resolveDshHome(process.env)
  const stateDir = resolveStateDir(home)
  const store = new HostStore({ dir: stateDir, logger })
  const service = new RemoteGoService({
    store,
    home,
    logger,
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
  const api = createApi({
    service,
    getOrigin,
    logger,
    diagnostics: () => describeSelf(ctx, { home, stateDir, localVersion: service.localVersion }),
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
        if (!detected.version) logger.warn('could not detect the local DSH version; set an explicit bootstrap target version in settings')
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
 * @param {{ home: string, stateDir: string, localVersion: string | null }} info
 */
export function describeSelf(ctx, info) {
  /** @type {Record<string, unknown>} */
  const out = {
    home: info.home,
    stateDir: info.stateDir,
    hostVersion: info.localVersion,
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
    const row = Array.isArray(graph?.entries) ? graph.entries.find((item) => item.id === PLUGIN_ID) ?? null : null
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
      row: row ? { id: row.id, rev: row.rev, url: row.url, inject: row.inject ?? [], immediately: row.immediately === true } : null,
      clientPath,
      bundle,
    }
  } catch (error) {
    out.client = { error: error instanceof Error ? error.message : String(error) }
  }
  return out
}

/** @returns {Record<string, (...args: any[]) => void>} */
function createLogger() {  const tag = '[dsh-remote-go]'
  const write = (/** @type {'info'|'warn'|'error'|'debug'} */ level, /** @type {any[]} */ args) => {
    const sink = level === 'debug' ? console.debug : level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
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

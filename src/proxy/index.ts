/**
 * Same-origin reverse proxy for a connected host's remote DSH web UI.
 *
 * The browser half shows the remote UI in a same-origin frame. This module makes that frame work
 * without handing the browser a second origin:
 *
 * - every request under `REMOTE_VIEW_PREFIX<hostId>/` is stripped of the prefix and forwarded to
 *   that host's loopback tunnel;
 * - the remote's session cookies stay in a per-host jar here, never in the local GUI's cookie jar
 *   (both GUIs answer on 127.0.0.1, so browser cookies are shared across ports);
 * - `Host`/`Origin` are rewritten to the remote's own loopback authority, so the remote's
 *   authority-bound cookie and same-origin fence keep working;
 * - the only WebSocket route a remote DSH owns (`/api/remote.mux`) gets one exact upgrade route
 *   per connected host, because the local web server matches upgrades by exact pathname.
 *
 * It proxies nothing but a host that is currently connected: an unknown or disconnected host id
 * is a 404, DSH's own admission decides whether the caller may use the seat at all, and the
 * same-origin fence rejects cross-site requests, matching the local API.
 *
 * This file is the assembly — options, the per-host route table, the jar book and the teardown —
 * not a re-export barrel: the routes live in `routes.ts`, the header rewriting in `headers.ts`,
 * the jar in `cookies.ts`, and the two handlers in `http.ts` / `upgrade.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Admission, AdmissionRequest } from '../admission.js'
import { REMOTE_VIEW_PREFIX } from '../constants.js'
import { createJarBook } from './cookies.js'
import { cookieHeader } from './cookies.js'
import { remoteAuthority } from './headers.js'
import type { ProxyTarget } from './headers.js'
import { createHttpHandler } from './http.js'
import type { ProxyLogger, ProxyRuntime } from './http.js'
import { UPSTREAM_TIMEOUT_MS } from './limits.js'
import { HOST_ID_PATTERN, upgradePath } from './routes.js'
import { createUpgradeHandler } from './upgrade.js'

/** One exact-path upgrade route, as the local web server registers it. */
export interface UpgradeRegistration {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

/**
 * The local DSH web server, narrowed to the one route call this module makes. It stays optional:
 * a kernel/web server without upgrade support never registers a stream route, and `sync` reports
 * that per host instead of taking the proxy down.
 */
export interface ProxyWebServer {
  registerUpgrade?: (registration: UpgradeRegistration) => (() => void) | undefined
}

/** Everything the proxy needs; `resolveHost` is the single pivot between it and the tunnels. */
export interface RemoteProxyOptions {
  /** Local DSH web server (register/registerUpgrade/getOrigin). */
  webServer: ProxyWebServer
  /** Local origin, read per request. */
  getOrigin: () => string | null
  /** The loopback target for one connected host, or null. */
  resolveHost: (hostId: string) => ProxyTarget | null
  /**
   * DSH admission (`ctx.connection.requestRejection`): the rejection status for a request, or
   * undefined when it may proceed. Absent on kernels without the Connection service, where the
   * fence below is the gate.
   */
  admit?: (req: AdmissionRequest) => number | undefined
  /** Called once per failed upstream connection so the Host can confirm a suspected remote restart. */
  onUpstreamError?: (hostId: string) => void
  /** Milliseconds the remote may take to accept and answer; defaults to `UPSTREAM_TIMEOUT_MS`. */
  upstreamTimeoutMs?: number
  logger?: ProxyLogger
}

/** The proxy one activation owns: its routes, its per-host jars and its teardown. */
export interface RemoteProxy {
  prefix: string
  routePath: string
  handle: (req: IncomingMessage, res: ServerResponse) => void
  handleUpgrade: (hostId: string, req: IncomingMessage, socket: Duplex, head: Buffer) => void
  sync: (hostIds: string[]) => void
  cookies: (hostId: string) => string
  dispose: () => void
}

/**
 * Create the proxy. `resolveHost` is the single pivot: it returns the loopback target for one
 * connected host (`{ localPort, remotePort }`) or null. Nothing else in this module knows how a
 * tunnel was made.
 */
export function createRemoteProxy(options: RemoteProxyOptions): RemoteProxy {
  const logger: ProxyLogger = options.logger ?? console
  const webServer = options.webServer
  const getOrigin = options.getOrigin
  const resolveHost = options.resolveHost
  // Annotated because the default below must answer like the real gate: the kernel may not
  // provide the Connection service at all, and a missing gate admits the request.
  const admit: Admission = typeof options.admit === 'function' ? options.admit : () => undefined
  const onUpstreamError = options.onUpstreamError
  const upstreamTimeoutMs =
    Number.isSafeInteger(options.upstreamTimeoutMs) && options.upstreamTimeoutMs > 0
      ? options.upstreamTimeoutMs
      : UPSTREAM_TIMEOUT_MS
  const jars = createJarBook(remoteAuthority)
  const upgrades = new Map<string, () => void>()
  const sockets = new Set<Duplex>()
  let disposed = false
  /** Report one failed upstream without letting the reporter break the proxy. */
  function reportUpstreamFailure(hostId: string): void {
    try {
      onUpstreamError?.(hostId)
    } catch {
      // swallow-ok: reporting only feeds the liveness confirmation, it must never fail a request
    }
  }

  function localOrigin(): URL | null {
    try {
      const origin = getOrigin()
      return typeof origin === 'string' && origin !== '' ? new URL(origin) : null
    } catch {
      return null
    }
  }

  function targetOf(hostId: string): ProxyTarget | null {
    try {
      const target = resolveHost(hostId)
      return target && Number.isInteger(Number(target.localPort)) && Number(target.localPort) > 0 ? target : null
    } catch {
      return null
    }
  }

  /** The two handlers see exactly these operations, never this closure. */
  const runtime: ProxyRuntime = {
    disposed: () => disposed,
    logger,
    admit,
    localOrigin,
    targetOf,
    jarFor: (hostId, target) => jars.jarFor(hostId, target),
    reportUpstreamFailure,
    upstreamTimeoutMs,
  }
  const handle = createHttpHandler(runtime)
  const handleUpgrade = createUpgradeHandler(runtime, {
    add(socket: Duplex): void {
      sockets.add(socket)
    },
    delete(socket: Duplex): void {
      sockets.delete(socket)
    },
  })

  /**
   * Keep one upgrade route per configured host. Called on init and on every state change; a host
   * that disappears loses its route and its cookies.
   */
  function sync(hostIds: string[]): void {
    if (disposed) return
    const wanted = new Set((Array.isArray(hostIds) ? hostIds : []).filter((id) => HOST_ID_PATTERN.test(String(id))))
    for (const [hostId, dispose] of upgrades) {
      if (wanted.has(hostId)) continue
      dispose()
      upgrades.delete(hostId)
      jars.clear(hostId)
    }
    for (const hostId of wanted) {
      if (upgrades.has(hostId)) continue
      try {
        upgrades.set(
          hostId,
          webServer.registerUpgrade({
            path: upgradePath(hostId),
            handler: (req, socket, head) => handleUpgrade(hostId, req, socket, head),
          }),
        )
      } catch (error) {
        logger.warn?.(
          `[dsh-remote-go] could not register the stream route for ${hostId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  return {
    prefix: REMOTE_VIEW_PREFIX,
    /**
     * The route registration path. The web server matches a prefix as `pathname === prefix ||
     * pathname.startsWith(prefix + '/')`, so registering the trailing-slash seat prefix verbatim
     * would never match a real view URL.
     */
    routePath: REMOTE_VIEW_PREFIX.replace(/\/$/, ''),
    handle,
    handleUpgrade,
    sync,
    /** One host's current cookie header, for diagnostics and tests. */
    cookies(hostId: string): string {
      const jar = jars.get(hostId)
      return jar === undefined ? '' : cookieHeader(jar, '/')
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const dispose of upgrades.values()) dispose()
      upgrades.clear()
      jars.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

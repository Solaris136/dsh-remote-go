/** Same-origin reverse proxy for a connected host's remote DSH web UI: requests under `REMOTE_VIEW_PREFIX<hostId>/` go
 * to that host's loopback tunnel, cookies stay in a per-host jar (both GUIs answer on 127.0.0.1, so browser cookies
 * are shared across ports), `Host`/`Origin` become the remote's authority, and each host gets an exact upgrade route
 * for its WebSocket. Unknown or disconnected hosts are a 404; admission and the fence still decide. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Admission, AdmissionRequest } from '../admission.js'
import { REMOTE_VIEW_PREFIX } from '../constants.js'
import { createJarBook, cookieHeader } from './cookies.js'
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
/** The local DSH web server, narrowed to the one route call this module makes. Optional: a web server without upgrade
 * support never registers a stream route, and `sync` reports that per host instead of taking the proxy down. */
export interface ProxyWebServer {
  registerUpgrade?: (registration: UpgradeRegistration) => (() => void) | undefined
}
/** Everything the proxy needs; `resolveHost` is the single pivot between it and the tunnels. */
export interface RemoteProxyOptions {
  webServer: ProxyWebServer
  getOrigin: () => string | null
  resolveHost: (hostId: string) => ProxyTarget | null
  /** DSH admission (`ctx.connection.requestRejection`): the rejection status, or undefined to proceed. Absent on
   * kernels without the Connection service, where the same-origin fence below is the gate. */
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

/** Create the proxy. `resolveHost` is the single pivot: the loopback target for one connected host, or null — nothing
 * else in this module knows how a tunnel was made. */
export function createRemoteProxy(options: RemoteProxyOptions): RemoteProxy {
  const logger: ProxyLogger = options.logger ?? console
  const webServer = options.webServer
  const getOrigin = options.getOrigin
  const resolveHost = options.resolveHost
  // Annotated because the default must answer like the real gate: a kernel may provide no Connection service at all,
  // and a missing gate admits the request.
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
    // Report one failed upstream without letting the reporter break the proxy: it only feeds the liveness
    // confirmation, so a throwing reporter must never fail the request.
    reportUpstreamFailure(hostId: string): void {
      try {
        onUpstreamError?.(hostId)
      } catch {
        // swallow-ok: reporting only feeds the liveness confirmation
      }
    },
    upstreamTimeoutMs,
  }
  const handle = createHttpHandler(runtime)
  const handleUpgrade = createUpgradeHandler(runtime, {
    add: (socket: Duplex) => void sockets.add(socket),
    delete: (socket: Duplex) => void sockets.delete(socket),
  })

  /** Keep one upgrade route per configured host, called on init and on every state change: a host that disappears
   * loses its route and its cookies. */
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
    // The web server matches `pathname === prefix || pathname.startsWith(prefix + '/')`, so the trailing slash must go.
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

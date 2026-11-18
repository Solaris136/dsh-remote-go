/**
 * The WebSocket half of the same-origin proxy.
 *
 * The only WebSocket route a remote DSH owns (`/api/remote.mux`) gets one exact upgrade route per
 * connected host, because the local web server matches upgrades by exact pathname. The handshake
 * is admitted and fenced like an HTTP request, the upstream's response head is filtered before
 * the browser sees it (a 101 used to be forwarded byte-for-byte, also handing the remote's
 * `Set-Cookie` to the local origin), and both directions stream untouched afterwards.
 */
import http from 'node:http'
import net from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { trustedRequest } from '../request-trust.js'
import { filterResponseHead, remoteOrigin, upstreamHeaders } from './headers.js'
import type { ProxyRuntime } from './http.js'
import { MAX_UPSTREAM_HEAD_BYTES } from './limits.js'
import { parseViewPath } from './routes.js'
import type { ViewPath } from './routes.js'

/** The sockets one activation owns: the assembly keeps the set, a handler only registers its own. */
export interface UpgradeSocketTracking {
  add: (socket: Duplex) => void
  delete: (socket: Duplex) => void
}

/**
 * Create the upgrade handler of one proxy activation.
 *
 * An upgrade owns its socket, so every refusal here either answers the handshake with a status and
 * closes it (an admission rejection) or destroys it; nothing falls back to an HTTP response.
 */
export function createUpgradeHandler(
  rt: ProxyRuntime,
  track: UpgradeSocketTracking,
): (hostId: string, req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  /** One exact upgrade route per host: the only WebSocket a DSH web serves is its stream mux. */
  return function handleUpgrade(hostId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (rt.disposed()) {
      socket.destroy()
      return
    }
    const rejection = rt.admit(req)
    if (rejection !== undefined) {
      // An upgrade owns its socket: answer the handshake with the status, then close it.
      socket.on('error', () => {})
      socket.end(
        `HTTP/1.1 ${rejection} ${http.STATUS_CODES[rejection] ?? 'Rejected'}\r\n` +
          'connection: close\r\ncontent-length: 0\r\n\r\n',
      )
      return
    }
    const origin = rt.localOrigin()
    if (origin === null || !trustedRequest(req, origin)) {
      socket.destroy()
      return
    }
    const target = rt.targetOf(hostId)
    if (target === null) {
      socket.destroy()
      return
    }
    // A malformed request target (absolute-form, broken escape) must not throw out of the upgrade
    // handler: the HTTP path already degrades to a 400, this one just drops the socket.
    let parsed: ViewPath | null = null
    try {
      parsed = parseViewPath(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      parsed = null
    }
    if (parsed === null) {
      socket.destroy()
      return
    }
    const jar = rt.jarFor(hostId, target)
    const headers = upstreamHeaders(req.rawHeaders, {
      target,
      localOrigin: origin.origin,
      path: parsed.path,
      jar,
      preserveUpgrade: true,
    })
    let raw = `${req.method} ${parsed.path} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) raw += `${name}: ${item}\r\n`
    }
    raw += '\r\n'
    const upstream = net.connect({ port: target.localPort, host: '127.0.0.1', timeout: rt.upstreamTimeoutMs })
    // An upgrade owns its socket, so the deadline covers the handshake only: an upstream that
    // accepts and never answers would otherwise leave both sockets dangling forever.
    let settled = false
    const handshakeTimer = setTimeout(() => failUpgrade(), rt.upstreamTimeoutMs)
    handshakeTimer.unref?.()
    function failUpgrade(): void {
      clearTimeout(handshakeTimer)
      if (settled) return
      settled = true
      upstream.destroy()
      socket.destroy()
      rt.reportUpstreamFailure(hostId)
    }
    track.add(socket)
    // The upstream's response head is filtered before the browser sees it: a 101 used to be
    // forwarded byte-for-byte, which also handed the remote's `Set-Cookie` and policy headers to
    // the local origin. Only the head is parsed; everything after it streams untouched.
    let upstreamHead = Buffer.alloc(0)
    let headForwarded = false
    const writeToClient = (chunk: Buffer | string): void => {
      if (!socket.write(chunk)) upstream.pause()
    }
    const forwardUpstreamData = (chunk: Buffer): void => {
      if (settled) return
      clearTimeout(handshakeTimer)
      upstream.setTimeout(0)
      if (headForwarded) {
        writeToClient(chunk)
        return
      }
      upstreamHead = upstreamHead.length === 0 ? Buffer.from(chunk) : Buffer.concat([upstreamHead, chunk])
      if (upstreamHead.length > MAX_UPSTREAM_HEAD_BYTES) {
        // Nothing legitimate answers a handshake with a head this large.
        failUpgrade()
        return
      }
      const end = upstreamHead.indexOf('\r\n\r\n')
      if (end === -1) return
      const filtered = filterResponseHead(upstreamHead.subarray(0, end).toString('latin1'), {
        hostId,
        remoteOrigin: remoteOrigin(target),
      })
      if (filtered === '') {
        failUpgrade()
        return
      }
      headForwarded = true
      writeToClient(`${filtered}\r\n`)
      const rest = upstreamHead.subarray(end + 4)
      upstreamHead = Buffer.alloc(0)
      if (rest.length > 0) writeToClient(rest)
    }
    upstream.on('data', forwardUpstreamData)
    socket.on('drain', () => upstream.resume())
    upstream.on('timeout', () => failUpgrade())
    upstream.on('error', () => failUpgrade())
    /**
     * The remote ended the stream. `upstream.pipe(socket)` used to forward that EOF implicitly;
     * the head is parsed here, so the end of the upstream must still close the browser side or
     * the page would hold a dead socket forever.
     */
    const endClient = (): void => {
      if (settled) return
      settled = true
      clearTimeout(handshakeTimer)
      try {
        socket.end()
      } catch {
        // swallow-ok: the client socket may already be closed
      }
    }
    upstream.on('end', endClient)
    upstream.on('close', endClient)
    socket.once('close', () => {
      settled = true
      clearTimeout(handshakeTimer)
      track.delete(socket)
      upstream.destroy()
    })
    socket.on('error', () => {
      settled = true
      clearTimeout(handshakeTimer)
      upstream.destroy()
    })
    upstream.once('connect', () => {
      if (settled) return
      upstream.write(raw)
      if (head && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
    })
  }
}

/**
 * Local loopback TCP listener piped through the SSH transport; the guest points at it, so its cookies never mix with the local GUI's.
 */
import http from 'node:http'
import net from 'node:net'
import type { ClientChannel, SshTransport } from './ssh.js'

/** What `createTunnel` needs: the transport, the remote port and the optional listener bindings. */
export interface TunnelOptions {
  ssh?: SshTransport | null
  remoteHost?: string
  remotePort: number
  listenHost?: string
  listenPort?: number
  onError?: (error: Error) => void
}

/** One live tunnel: the local port the guest points at, plus its connection count. */
export interface Tunnel {
  localPort: number
  listenHost: string
  urlHost: string
  readonly connections: number
  close(): Promise<void>
}

/**
 * Ask the *local* listener whether it still serves, without trusting the SSH-side probe:
 * any HTTP answer (even 401/404) proves the tunnel forwards, while a refused/destroyed
 * socket means it is broken. Used before rebuilding a tunnel for a transient proxy failure.
 * @param localPort - tunnel's local port, if any.
 * @returns whether the listener answered.
 */
export function probeLoopback(localPort: number | null, options: { timeoutMs?: number } = {}): Promise<boolean> {
  const port = Number(localPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const request = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: options.timeoutMs ?? 1_500 },
      (response) => {
        response.resume()
        finish(true)
      },
    )
    request.on('timeout', () => {
      request.destroy()
      finish(false)
    })
    request.on('error', () => finish(false))
  })
}

export async function createTunnel(options: TunnelOptions): Promise<Tunnel> {
  const remoteHost = options.remoteHost ?? '127.0.0.1'
  const listenHost = options.listenHost ?? '127.0.0.1'
  const sockets = new Set<net.Socket>()
  // The forwarded SSH channels this listener opened: a closed listener must destroy them too,
  // otherwise an established pipe keeps the (already released) SSH transport busy.
  const streams = new Set<ClientChannel>()
  let closed = false

  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    const cleanup = () => {
      sockets.delete(socket)
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
    const ssh = options.ssh
    if (!ssh) {
      // A listener can outlive its transport if a caller leaks it; never throw from a net
      // connection callback (an uncaught exception there ends the whole host process).
      socket.destroy()
      return
    }
    ssh
      .forwardOut(remoteHost, options.remotePort, '127.0.0.1', socket.remotePort ?? 0)
      .then((stream) => {
        if (closed) {
          stream.destroy()
          socket.destroy()
          return
        }
        streams.add(stream)
        const forget = () => {
          streams.delete(stream)
        }
        stream.once('close', forget)
        stream.once('error', forget)
        socket.pipe(stream).pipe(socket)
        stream.once('close', () => {
          if (!socket.destroyed) socket.end()
        })
        stream.once('error', () => {
          socket.destroy()
        })
      })
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listenPort ?? 0, listenHost, () => {
      server.removeListener('error', reject)
      resolve(undefined)
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('tunnel listener did not expose a TCP address')
  }

  return {
    localPort: address.port,
    listenHost,
    urlHost: listenHost.includes(':') ? `[${listenHost}]` : listenHost,
    get connections() {
      return sockets.size
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      // Destroy the forwarded channels as well: the SSH session may already be disposed.
      for (const stream of streams) {
        try {
          stream.destroy()
        } catch {
          /* the channel may already be gone */
        }
      }
      streams.clear()
      await new Promise<void>((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

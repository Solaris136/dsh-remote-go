/**
 * Local loopback TCP listener piped through the SSH transport; the guest points at it, so its cookies never mix with the local GUI's.
 */
import net from 'node:net'

export async function createTunnel(options) {
  const remoteHost = options.remoteHost ?? '127.0.0.1'
  const listenHost = options.listenHost ?? '127.0.0.1'
  const sockets = new Set()
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
    options.ssh
      .forwardOut(remoteHost, options.remotePort, '127.0.0.1', socket.remotePort ?? 0)
      .then((stream) => {
        if (closed) {
          stream.destroy()
          socket.destroy()
          return
        }
        socket.pipe(stream).pipe(socket)
        stream.once('close', () => {
          if (!socket.destroyed) socket.end()
        })
        stream.once('error', () => {
          socket.destroy()
        })
      })
      .catch((error) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      })
  })

  await new Promise((resolve, reject) => {
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
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

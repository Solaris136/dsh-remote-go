import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { Duplex } from 'node:stream'
import { createTunnel } from '../../dist/src/tunnel.js'

function fakeSshTo(port) {
  return {
    async forwardOut(destHost, destPort) {
      return await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
        socket.once('error', reject)
      })
    },
  }
}

test('createTunnel pipes a local loopback connection to the forwarded stream', async () => {
  const target = net.createServer((socket) => {
    socket.end('hello-from-remote')
  })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetPort = target.address().port
  const tunnel = await createTunnel({ ssh: fakeSshTo(targetPort), remotePort: targetPort })
  try {
    assert.ok(tunnel.localPort > 0)
    assert.equal(tunnel.listenHost, '127.0.0.1')
    const received = await new Promise((resolve, reject) => {
      const client = net.connect(tunnel.localPort, '127.0.0.1', () => {})
      const chunks = []
      client.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      client.on('error', reject)
    })
    assert.equal(received, 'hello-from-remote')
  } finally {
    await tunnel.close()
    target.close()
  }
})

test('createTunnel reports forward failures and closes the listener', async () => {
  const errors = []
  const ssh = {
    async forwardOut() {
      throw new Error('channel refused')
    },
  }
  const tunnel = await createTunnel({ ssh, remotePort: 1234, onError: (error) => errors.push(error.message) })
  await new Promise((resolve) => {
    const client = net.connect(tunnel.localPort, '127.0.0.1', () => {
      client.destroy()
      setTimeout(resolve, 50)
    })
    client.on('error', () => resolve(undefined))
  })
  assert.deepEqual(errors, ['channel refused'])
  await tunnel.close()
  await tunnel.close() // idempotent
})

test('createTunnel cleans up active sockets on close', async () => {
  const ssh = {
    async forwardOut() {
      return new net.Socket() // never writes; stays open until destroyed
    },
  }
  const tunnel = await createTunnel({ ssh, remotePort: 1234 })
  assert.equal(tunnel.connections, 0)
  const client = net.connect(tunnel.localPort, '127.0.0.1')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(tunnel.connections >= 1)
  await tunnel.close()
  assert.equal(tunnel.connections, 0)
  client.destroy()
})

test('createTunnel destroys the forwarded SSH channels on close', async () => {
  const streams = []
  const ssh = {
    async forwardOut() {
      const stream = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback()
        },
      })
      streams.push(stream)
      return stream
    },
  }
  const tunnel = await createTunnel({ ssh, remotePort: 1234 })
  const client = net.connect(tunnel.localPort, '127.0.0.1')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(streams.length, 1)
  assert.equal(streams[0].destroyed, false)
  await tunnel.close()
  assert.equal(streams[0].destroyed, true, 'a closed listener must not keep an SSH channel open')
  client.destroy()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import process from 'node:process'
import { createRemoteProxy, upgradePath } from '../../src/remote-proxy.js'
import { makeTempRoot, resolveDshCli, skipOrFail, sleep, stopChild, tail } from './harness-support.js'

const timeout = { timeout: 120_000 }

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        headers: { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

function fakeWebServer() {
  const routes = new Map()
  const upgrades = new Map()
  return {
    routes,
    upgrades,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
}

/** Start the packaged DSH web in a throwaway home and return its loopback port and launch token. */
async function startDshWeb(cli, home) {
  const child = spawn(cli.command, [...cli.args, '--profile', 'web', '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const logs = []
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web did not print a URL\n${tail(logs)}`)), 90_000)
    timer.unref?.()
    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      logs.push(text)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:(\d+))\/\?token=(\S+)/.exec(logs.join(''))
      if (match === null) return
      clearTimeout(timer)
      resolve({ origin: match[1], port: Number(match[2]), token: match[3] })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${code}\n${tail(logs)}`))
    })
  })
  return { child, logs, ...line }
}

test('the same-origin proxy serves a real DSH web UI end to end', timeout, async (t) => {
  const cli = resolveDshCli()
  if (cli === null) {
    skipOrFail(t, 'the DSH CLI is not available')
    return
  }
  const home = makeTempRoot('dsh-remote-go-web-proxy')
  let child = null
  let server = null
  let proxy = null
  try {
    const remote = await startDshWeb(cli, home)
    child = remote.child
    const webServer = fakeWebServer()
    const upstream = { localPort: remote.port, remotePort: remote.port }
    server = http.createServer((req, res) => {
      if (proxy === null) {
        res.writeHead(503)
        res.end()
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      for (const [prefix, route] of webServer.routes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        route.handler(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.on('upgrade', (req, socket, head) => {
      if (proxy === null) {
        socket.destroy()
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const route = webServer.upgrades.get(pathname)
      if (route === undefined) {
        socket.destroy()
        return
      }
      route.handler(req, socket, head)
    })
    const localPort = await listen(server)
    proxy = createRemoteProxy({
      webServer,
      getOrigin: () => `http://127.0.0.1:${localPort}`,
      resolveHost: (id) => (id === 'h_proxy' ? upstream : null),
      logger: { debug() {}, warn() {}, error() {} },
    })
    webServer.register({ kind: 'prefix', path: proxy.routePath, handler: (req, res) => proxy.handle(req, res) })
    proxy.sync(['h_proxy'])

    // 1. The launch token lands in the proxy's jar, never in a browser-visible cookie.
    const token = await request(localPort, '/dsh-remote-go/remote/h_proxy/?token=' + encodeURIComponent(remote.token))
    assert.equal(token.status, 303)
    assert.equal(token.headers['set-cookie'], undefined, 'the remote session cookie must stay server-side')
    const warmed = proxy.cookies('h_proxy')
    assert.match(warmed, /^dsh-auth-/)

    // 2. The framed app is the real DSH web shell, served under the prefix with a relative base.
    let page = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      page = await request(localPort, '/dsh-remote-go/remote/h_proxy/')
      if (page.status === 200 && page.body.includes('DeepSeek Harness')) break
      await sleep(250)
    }
    assert.equal(page?.status, 200, `the remote index did not become ready: ${page?.status}\n${tail(remote.logs)}`)
    assert.match(page.body, /<base href="\.\/">/)
    assert.match(page.body, /__DSH_BOOT__/)
    const asset = /src="plugins\/\?\?[^"]+"/.exec(page.body)
    assert.ok(asset, 'the boot HTML must reference a plugin asset')
    const assetPath = asset[0].slice('src="'.length, -1).replace(/&amp;/g, '&')
    const script = await request(localPort, `/dsh-remote-go/remote/h_proxy/${assetPath}`)
    assert.equal(script.status, 200)
    assert.match(script.headers['content-type'] ?? '', /javascript/)

    // 3. The app's only WebSocket route upgrades through the proxy with the jar cookie.
    const upgraded = await new Promise((resolve, reject) => {
      const socket = net.connect(localPort, '127.0.0.1', () => {
        socket.write(
          `GET ${upgradePath('h_proxy')} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${localPort}\r\n` +
            `Origin: http://127.0.0.1:${localPort}\r\n` +
            'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('the stream upgrade did not answer'))
      }, 15_000)
      timer.unref?.()
      socket.once('data', (chunk) => {
        clearTimeout(timer)
        socket.destroy()
        resolve(chunk.toString('utf8'))
      })
      socket.on('error', reject)
    })
    assert.match(upgraded, /^HTTP\/1\.1 101/)
  } finally {
    proxy?.dispose()
    if (server !== null) await close(server)
    if (child !== null) await stopChild(child)
    rmSync(home, { recursive: true, force: true })
  }
})

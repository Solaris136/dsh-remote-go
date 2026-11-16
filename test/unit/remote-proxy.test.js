import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {
  cookieHeader,
  createRemoteProxy,
  parseSetCookie,
  parseViewPath,
  responseHeaders,
  storeCookies,
  upgradePath,
} from '../../src/remote-proxy.js'
import { trustedRequest } from '../../src/request-trust.js'

const LOCAL_ORIGIN = 'http://127.0.0.1:57442'
const LOCAL_AUTHORITY = '127.0.0.1:57442'

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

/** One HTTP request against the local proxy listener, with browser-shaped headers. */
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: LOCAL_AUTHORITY, ...(options.headers ?? {}) },
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
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

/** A local DSH web server stand-in: prefix routes plus exact upgrade routes. */
function fakeWebServer() {
  const routes = new Map()
  const upgrades = new Map()
  return {
    routes,
    upgrades,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error(`duplicate upgrade ${route.path}`)
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
}

async function startProxy(resolveHost, webServer = fakeWebServer(), options = {}) {
  const proxy = createRemoteProxy({
    webServer,
    getOrigin: () => LOCAL_ORIGIN,
    resolveHost,
    admit: options.admit,
    onUpstreamError: options.onUpstreamError,
    logger: { debug() {}, warn() {}, error() {} },
    ...options,
  })
  webServer.register({ kind: 'prefix', path: proxy.routePath, handler: (req, res) => proxy.handle(req, res) })
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    for (const [prefix, route] of webServer.routes) {
      // Mirror the real web server's prefix boundary (exact, or one slash deeper).
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      route.handler(req, res)
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = webServer.upgrades.get(pathname)
    if (route === undefined) {
      socket.destroy()
      return
    }
    route.handler(req, socket, head)
  })
  const port = await listen(server)
  return { proxy, server, port, webServer }
}

test('parseViewPath accepts exactly one host segment below the view prefix', () => {
  assert.deepEqual(parseViewPath('/dsh-remote-go/remote/h_a/'), { hostId: 'h_a', path: '/' })
  assert.deepEqual(parseViewPath('/dsh-remote-go/remote/h_a/assets/app.js'), {
    hostId: 'h_a',
    path: '/assets/app.js',
  })
  for (const bad of [
    '/dsh-remote-go/api/state',
    '/dsh-remote-go/remote/',
    '/dsh-remote-go/remote/../etc/passwd',
    '/dsh-remote-go/remote/h_a%2F..%2Fb/',
    '/dsh-remote-go/remote/h b/',
    '/dsh-remote-go/remote/h_a',
    '',
  ]) {
    assert.equal(parseViewPath(bad), null, `must refuse ${JSON.stringify(bad)}`)
  }
})

test('the cookie jar honours path, expiry and deletion', () => {
  const jar = new Map()
  storeCookies(jar, [
    'dsh-auth-a=one; Path=/; HttpOnly; SameSite=Strict',
    'scoped=two; Path=/assets',
    'gone=three; Max-Age=0',
    'expired=four; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
  ])
  assert.equal(cookieHeader(jar, '/'), 'dsh-auth-a=one')
  assert.equal(cookieHeader(jar, '/assets/app.js'), 'dsh-auth-a=one; scoped=two')
  assert.equal(cookieHeader(jar, '/apis'), 'dsh-auth-a=one')
  storeCookies(jar, 'dsh-auth-a=; Max-Age=0')
  assert.equal(cookieHeader(jar, '/'), '')
  assert.deepEqual(Object.keys(parseSetCookie('x=1; Path=/; Max-Age=60')), ['name', 'value', 'path', 'expiresAt'])
  assert.equal(parseSetCookie('nodots'), null)
})

test('the proxy fence mirrors the local API: same host authority, same Origin, no cross-site', () => {
  const origin = new URL(LOCAL_ORIGIN)
  assert.equal(trustedRequest({ headers: { host: LOCAL_AUTHORITY } }, origin), true)
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1:5000' } }, origin), false)
  assert.equal(trustedRequest({ headers: { host: LOCAL_AUTHORITY, origin: LOCAL_ORIGIN } }, origin), true)
  assert.equal(trustedRequest({ headers: { host: LOCAL_AUTHORITY, origin: 'https://evil.example' } }, origin), false)
  assert.equal(trustedRequest({ headers: { host: LOCAL_AUTHORITY, 'sec-fetch-site': 'cross-site' } }, origin), false)
  // An omitted default port still names the same authority.
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1' } }, new URL('http://127.0.0.1:80')), true)
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1' } }, new URL('https://127.0.0.1')), true)
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1' } }, new URL('https://127.0.0.1:443')), true)
  // Host is case-insensitive, and a loopback spelling may differ from the listener's own.
  assert.equal(trustedRequest({ headers: { host: 'LOCALHOST:57442' } }, origin), true)
  // A parser has to rewrite each of these into a loopback authority; a browser fills Host from the
  // serialized URL, so such a value never arrives from one — and the fence must not trust it.
  for (const host of [
    'attacker.example@127.0.0.1:57442',
    '127.0.0.1:57442\\@attacker.example',
    '127.0.0.1:57442#@attacker.example',
    '127.0.0.1.:57442',
    '127.0.0.1:057442',
  ]) {
    assert.equal(trustedRequest({ headers: { host } }, origin), false, `Host ${JSON.stringify(host)} must be rejected`)
  }
})

test('response headers drop the remote cookie, framing denial and remote redirects', () => {
  const headers = responseHeaders(
    [
      'content-type',
      'text/html',
      'set-cookie',
      'dsh-auth-a=one; Path=/',
      'x-frame-options',
      'DENY',
      'content-security-policy',
      "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
      'location',
      'http://127.0.0.1:43210/next?x=1',
      'content-length',
      '10',
    ],
    { hostId: 'h_a', remoteOrigin: 'http://127.0.0.1:43210' },
  )
  assert.deepEqual(headers, [
    'content-type',
    'text/html',
    'content-security-policy',
    "default-src 'self'; script-src 'self'",
    'location',
    '/dsh-remote-go/remote/h_a/next?x=1',
    'content-length',
    '10',
  ])
})

test('the HTTP proxy strips the prefix, keeps cookies server-side and rewrites authority', async () => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, {
        location: './',
        'set-cookie': ['dsh-auth-fake=session-value; Path=/; HttpOnly; SameSite=Strict'],
        'content-type': 'text/html',
      })
      res.end('token-consumed')
      return
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`cookie=${req.headers.cookie ?? ''}`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('asset')
  })
  const upstreamPort = await listen(upstream)
  const hosts = { h_a: { localPort: upstreamPort, remotePort: upstreamPort } }
  const local = await startProxy((id) => hosts[id] ?? null)
  try {
    const first = await request(local.port, '/dsh-remote-go/remote/h_a/?token=launch-token')
    assert.equal(first.status, 303)
    assert.equal(first.headers.location, './')
    assert.equal(first.headers['set-cookie'], undefined, 'the remote cookie must never reach the browser')
    const second = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(second.status, 200)
    assert.equal(second.body, 'cookie=dsh-auth-fake=session-value')
    const tokenRequest = seen[0]
    assert.equal(tokenRequest.url, '/?token=launch-token')
    assert.equal(tokenRequest.headers.host, `127.0.0.1:${upstreamPort}`)
    // The local GUI's own cookie is never forwarded to the remote.
    assert.equal(seen[1].headers.cookie, 'dsh-auth-fake=session-value')
    // Remote cookies stay inside the proxy: the browser sees none.
    assert.equal(local.proxy.cookies('h_a'), 'dsh-auth-fake=session-value')
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
})

test('the proxy refuses cross-site requests, unknown hosts and disconnected hosts', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('should not be reached')
  })
  const upstreamPort = await listen(upstream)
  const hosts = { h_a: null }
  const local = await startProxy((id) => hosts[id] ?? null)
  try {
    const crossSite = await request(local.port, '/dsh-remote-go/remote/h_a/', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)
    const unknown = await request(local.port, '/dsh-remote-go/remote/h_missing/')
    assert.equal(unknown.status, 404)
    const badHost = await request(local.port, '/dsh-remote-go/remote/h_a/', {
      headers: { host: 'evil.example:57442' },
    })
    assert.equal(badHost.status, 403)
    hosts.h_a = { localPort: upstreamPort, remotePort: upstreamPort }
    const connected = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(connected.status, 200)
    assert.equal(connected.body, 'should not be reached')
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
})

test('the proxy refuses callers DSH does not admit, over HTTP and the stream upgrade', async () => {
  const reached = []
  const upstream = http.createServer((_req, res) => {
    reached.push('http')
    res.writeHead(200)
    res.end('upstream')
  })
  upstream.on('upgrade', (_req, socket) => {
    reached.push('upgrade')
    socket.destroy()
  })
  const upstreamPort = await listen(upstream)
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }), undefined, {
    admit: (req) => (req.headers['x-test-session'] === 'ok' ? undefined : 401),
  })
  try {
    local.proxy.sync(['h_a'])
    const denied = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(denied.status, 401)
    assert.doesNotMatch(denied.body, /upstream/)

    const deniedUpgrade = await new Promise((resolve, reject) => {
      const socket = net.connect(local.port, '127.0.0.1', () => {
        socket.write(
          `GET ${upgradePath('h_a')} HTTP/1.1\r\n` +
            `Host: ${LOCAL_AUTHORITY}\r\n` +
            'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      const chunks = []
      socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
    })
    assert.match(deniedUpgrade, /HTTP\/1\.1 401/)
    assert.deepEqual(reached, [], 'a rejected request must never open an upstream connection')

    const allowed = await request(local.port, '/dsh-remote-go/remote/h_a/', {
      headers: { 'x-test-session': 'ok' },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body, 'upstream')
    assert.deepEqual(reached, ['http'])
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
})

test('the upgrade route forwards only the host stream path and injects the jar cookie', async () => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    // The token exchange is the only HTTP request this test needs: it fills the jar.
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, {
        location: './',
        'set-cookie': ['dsh-auth-fake=session-value; Path=/; HttpOnly; SameSite=Strict'],
      })
      res.end()
      return
    }
    res.writeHead(200)
    res.end('page')
  })
  upstream.on('upgrade', (req, socket) => {
    seen.push(req)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n' +
        `cookie=${req.headers.cookie ?? ''};host=${req.headers.host}`,
    )
    socket.end()
  })
  const upstreamPort = await listen(upstream)
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }))
  try {
    local.proxy.sync(['h_a'])
    assert.equal(local.webServer.upgrades.has(upgradePath('h_a')), true)
    // Warm the jar the same way the first page load does.
    const tokenRequest = await request(local.port, '/dsh-remote-go/remote/h_a/?token=t')
    assert.equal(tokenRequest.status, 303)
    assert.equal(local.proxy.cookies('h_a'), 'dsh-auth-fake=session-value')

    const received = await new Promise((resolve, reject) => {
      const socket = net.connect(local.port, '127.0.0.1', () => {
        socket.write(
          `GET ${upgradePath('h_a')} HTTP/1.1\r\n` +
            `Host: ${LOCAL_AUTHORITY}\r\n` +
            'Origin: http://127.0.0.1:57442\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      const chunks = []
      socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
    })
    assert.match(received, /HTTP\/1\.1 101/)
    assert.match(received, new RegExp(`host=127\\.0\\.0\\.1:${upstreamPort}`))
    assert.match(received, /cookie=dsh-auth-fake=session-value/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/api/remote.mux')
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
})

test('a failed upstream reports the fault once per request and still answers 502', async () => {
  // Bind then release a port so the proxy forwards to a loopback listener that is really gone.
  const probe = net.createServer()
  const deadPort = await listen(probe)
  await close(probe)
  const failures = []
  const local = await startProxy(() => ({ localPort: deadPort, remotePort: deadPort }), fakeWebServer(), {
    onUpstreamError: (hostId) => failures.push(hostId),
  })
  try {
    const first = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(first.status, 502)
    assert.deepEqual(failures, ['h_a'])
    const second = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(second.status, 502)
    assert.deepEqual(failures, ['h_a', 'h_a'])

    local.proxy.sync(['h_a'])
    await new Promise((resolve, reject) => {
      const socket = net.connect(local.port, '127.0.0.1', () => {
        socket.write(
          `GET ${upgradePath('h_a')} HTTP/1.1\r\n` +
            `Host: ${LOCAL_AUTHORITY}\r\n` +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n\r\n',
        )
      })
      socket.on('close', resolve)
      socket.on('error', reject)
      socket.resume()
    })
    assert.deepEqual(failures, ['h_a', 'h_a', 'h_a'], 'the upgrade failure is reported too')
  } finally {
    local.proxy.dispose()
    await close(local.server)
  }
})

test('a throwing upstream reporter cannot fail the proxied request', async () => {
  const probe = net.createServer()
  const deadPort = await listen(probe)
  await close(probe)
  const local = await startProxy(() => ({ localPort: deadPort, remotePort: deadPort }), fakeWebServer(), {
    onUpstreamError: () => {
      throw new Error('reporter exploded')
    },
  })
  try {
    const response = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(response.status, 502)
  } finally {
    local.proxy.dispose()
    await close(local.server)
  }
})

test('sync keeps one upgrade route per host and drops removed hosts', async () => {
  const local = await startProxy(() => null)
  try {
    local.proxy.sync(['h_a', 'h_b'])
    assert.equal(local.webServer.upgrades.size, 2)
    assert.equal(local.webServer.upgrades.has(upgradePath('h_a')), true)
    assert.equal(local.webServer.upgrades.has(upgradePath('h_b')), true)
    local.proxy.sync(['h_b'])
    assert.equal(local.webServer.upgrades.size, 1)
    assert.equal(local.webServer.upgrades.has(upgradePath('h_a')), false)
    local.proxy.dispose()
    assert.equal(local.webServer.upgrades.size, 0)
  } finally {
    await close(local.server)
  }
})

test('an upgrade whose target no URL can parse is dropped instead of throwing', async () => {
  const local = await startProxy(() => ({ localPort: 1, remotePort: 1 }))
  try {
    let destroyed = false
    const socket = {
      destroy() {
        destroyed = true
      },
    }
    // Absolute-form garbage: `new URL` throws on it, and a throw here would escape into the web
    // server's upgrade dispatch (which only logs it).
    local.proxy.handleUpgrade(
      'h_a',
      { url: 'http://[', headers: { host: LOCAL_AUTHORITY }, rawHeaders: [] },
      socket,
      null,
    )
    assert.equal(destroyed, true)
  } finally {
    local.proxy.dispose()
    await close(local.server)
  }
})

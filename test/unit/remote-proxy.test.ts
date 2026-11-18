import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createRemoteProxy } from '../../dist/src/proxy/index.js'
import {
  MAX_COOKIE_VALUE,
  MAX_JAR_COOKIES,
  cookieHeader,
  parseSetCookie,
  storeCookies,
} from '../../dist/src/proxy/cookies.js'
import { filterResponseHead, responseHeaders, safeLocation, upstreamHeaders } from '../../dist/src/proxy/headers.js'
import { parseViewPath, upgradePath } from '../../dist/src/proxy/routes.js'
import { trustedRequest } from '../../dist/src/request-trust.js'

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
  assert.deepEqual(Object.keys(parseSetCookie('x=1; Path=/; Max-Age=60')), [
    'name',
    'value',
    'path',
    'expiresAt',
    'secure',
  ])
  assert.equal(parseSetCookie('nodots'), null)
})

test('the cookie jar is bounded and never keeps a Secure cookie in its plaintext store', () => {
  const jar = new Map()
  // A `Secure` cookie would be stored and replayed over the plaintext loopback tunnel.
  storeCookies(jar, 'session=secret-value; Path=/; Secure')
  assert.equal(cookieHeader(jar, '/'), '')
  assert.equal(jar.size, 0)
  // Over-long values (and names) are dropped instead of buffered.
  storeCookies(jar, `long=${'a'.repeat(MAX_COOKIE_VALUE + 1)}`)
  assert.equal(jar.size, 0)
  storeCookies(jar, `${'n'.repeat(200)}=x`)
  assert.equal(jar.size, 0)
  // The jar stops at its cap while a known cookie may still be refreshed at the cap.
  for (let index = 0; index < MAX_JAR_COOKIES + 17; index += 1) storeCookies(jar, `c${index}=v${index}; Path=/`)
  assert.equal(jar.size, MAX_JAR_COOKIES)
  assert.equal(cookieHeader(jar, '/').split('; ').length, MAX_JAR_COOKIES)
  storeCookies(jar, 'c0=renewed; Path=/')
  assert.match(cookieHeader(jar, '/'), /c0=renewed/)
  assert.equal(jar.size, MAX_JAR_COOKIES)
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
  assert.equal(trustedRequest({ headers: { host: LOCAL_AUTHORITY, origin: 'http://LOCALHOST:57442' } }, origin), true)
  // The Origin authority is compared verbatim: a value the URL parser rewrote (userinfo, a
  // trailing dot, a zero-padded port) cannot have come from a browser, and the rewritten form
  // must not be accepted as loopback.
  for (const originHeader of [
    'http://evil.example@127.0.0.1:57442',
    'http://127.0.0.1.:57442',
    'http://127.0.0.1:057442',
    'http://user:pass@localhost:57442',
  ]) {
    assert.equal(
      trustedRequest({ headers: { host: LOCAL_AUTHORITY, origin: originHeader } }, origin),
      false,
      `Origin ${originHeader} must be rejected`,
    )
  }
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

test('upstreamHeaders forwards only the allowlisted content headers', () => {
  const jar = new Map([['dsh-auth-remote', { value: 'remote-cookie', path: '/', expiresAt: Infinity }]])
  const input = {
    target: { localPort: 5000, remotePort: 43210 },
    localOrigin: 'http://127.0.0.1:57442',
    path: '/',
    jar,
  }
  const raw = [
    'accept',
    'text/html',
    'accept-encoding',
    'gzip, deflate, br',
    'accept-language',
    'zh-CN',
    'content-type',
    'application/json',
    'content-length',
    '12',
    'range',
    'bytes=0-9',
    'if-none-match',
    '"abc"',
    'if-modified-since',
    'Tue, 01 Jan 2030 00:00:00 GMT',
    'cache-control',
    'no-cache',
    'user-agent',
    'Mozilla/5.0',
    'x-requested-with',
    'dsh',
    'authorization',
    'Bearer local-session-token',
    'x-dsh-remote-go',
    '1',
    'x-dsh-session',
    'local-session',
    'forwarded',
    'for=203.0.113.9',
    'x-forwarded-for',
    '203.0.113.9',
    'x-forwarded-host',
    'evil.example',
    'sec-fetch-site',
    'same-origin',
    'sec-fetch-mode',
    'cors',
    'cookie',
    'dsh-auth-local=local-cookie',
    'host',
    '127.0.0.1:57442',
    'origin',
    'http://127.0.0.1:57442',
    'referer',
    'http://127.0.0.1:57442/page',
    'te',
    'trailers',
    'connection',
    'keep-alive',
  ]
  const out = upstreamHeaders(raw, input)
  assert.deepEqual(Object.keys(out).sort(), [
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'content-length',
    'content-type',
    'cookie',
    'host',
    'if-modified-since',
    'if-none-match',
    'origin',
    'range',
    'referer',
    'user-agent',
    'x-requested-with',
  ])
  // The local session credential and every hop/authority field never reach the remote host.
  for (const name of [
    'authorization',
    'x-dsh-remote-go',
    'x-dsh-session',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'sec-fetch-site',
    'sec-fetch-mode',
    'te',
    'connection',
  ]) {
    assert.equal(out[name], undefined, `${name} must not be forwarded`)
  }
  assert.equal(out.host, '127.0.0.1:43210')
  assert.equal(out.origin, 'http://127.0.0.1:43210')
  assert.equal(out.referer, 'http://127.0.0.1:43210/page')
  // Only this host's own jar cookie, never the local GUI's cookie.
  assert.equal(out.cookie, 'dsh-auth-remote=remote-cookie')
})

test('only a WebSocket handshake carries the upgrade headers, credentials still excluded', () => {
  const input = {
    target: { localPort: 5000, remotePort: 43210 },
    localOrigin: 'http://127.0.0.1:57442',
    path: '/api/remote.mux',
    jar: new Map(),
  }
  const raw = [
    'connection',
    'Upgrade',
    'upgrade',
    'websocket',
    'sec-websocket-key',
    'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version',
    '13',
    'sec-websocket-protocol',
    'dsh',
    'sec-websocket-extensions',
    'permessage-deflate',
    'authorization',
    'Bearer local-session-token',
    'sec-fetch-mode',
    'websocket',
    'x-dsh-remote-go',
    '1',
  ]
  const upgrade = upstreamHeaders(raw, { ...input, preserveUpgrade: true })
  assert.equal(upgrade.connection, 'Upgrade')
  assert.equal(upgrade.upgrade, 'websocket')
  assert.equal(upgrade['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==')
  assert.equal(upgrade['sec-websocket-version'], '13')
  assert.equal(upgrade['sec-websocket-protocol'], 'dsh')
  assert.equal(upgrade['sec-websocket-extensions'], 'permessage-deflate')
  for (const name of ['authorization', 'x-dsh-remote-go', 'sec-fetch-mode']) {
    assert.equal(upgrade[name], undefined, `${name} must not be forwarded even on an upgrade`)
  }
  // The same headers on an ordinary request are hop-by-hop and dropped.
  const plainRequest = upstreamHeaders(raw, input)
  for (const name of ['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version']) {
    assert.equal(plainRequest[name], undefined, `${name} must not be forwarded on a plain request`)
  }
})

test('responseHeaders blocks the browser-policy headers a remote must not set locally', () => {
  const out = responseHeaders(
    [
      'content-type',
      'text/html',
      'clear-site-data',
      '"cookies", "storage"',
      'access-control-allow-origin',
      '*',
      'access-control-allow-credentials',
      'true',
      'refresh',
      '0; url=https://evil.example/',
      'content-location',
      'https://evil.example/',
      'report-to',
      '{"group":"default"}',
      'nel',
      '{"report_to":"default"}',
      'permissions-policy',
      'geolocation=()',
      'alt-svc',
      'h3=":443"; ma=60',
      'cache-control',
      'no-store',
    ],
    { hostId: 'h_a', remoteOrigin: 'http://127.0.0.1:43210' },
  )
  assert.deepEqual(out, ['content-type', 'text/html', 'cache-control', 'no-store'])
})

test('a redirect may only stay on the remote listener', () => {
  const at = { hostId: 'h_a', remoteOrigin: 'http://127.0.0.1:43210' }
  const fold = (value) => responseHeaders(['location', value], at)
  assert.deepEqual(fold('http://127.0.0.1:43210/next?x=1'), ['location', '/dsh-remote-go/remote/h_a/next?x=1'])
  assert.deepEqual(fold('http://127.0.0.1:43210'), ['location', '/dsh-remote-go/remote/h_a/'])
  assert.deepEqual(fold('http://127.0.0.1:43210?token=one'), ['location', '/dsh-remote-go/remote/h_a/?token=one'])
  // Relative references already resolve inside the seat, so they pass through.
  for (const value of ['./', './next', '/assets/app.js', '#frag']) {
    assert.deepEqual(fold(value), ['location', value], `relative ${JSON.stringify(value)} must be kept`)
  }
  // Everything absolute that is not the remote's own listener is dropped, not passed on.
  for (const value of [
    'https://evil.example/',
    '//evil.example/x',
    '\\\\evil.example\\x',
    // A backslash is a slash to the URL parser for http(s): these two resolve to
    // `http://evil.example/…`, so a "relative" reference carrying one is off-origin.
    '/\\evil.example/x',
    '\\/evil.example',
    '/assets\\..\\evil',
    'http://127.0.0.1:5000/other-port',
    'http://localhost:43210/loopback-alias',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    ' http://evil.example/',
    '',
  ]) {
    assert.deepEqual(fold(value), [], `Location ${JSON.stringify(value)} must be dropped`)
  }
  // A percent-encoded backslash is not a separator and stays a normal relative reference.
  assert.deepEqual(fold('/a%5cb'), ['location', '/a%5cb'])
  assert.equal(safeLocation('rel', {}), 'rel')
  assert.equal(safeLocation('https://evil.example/', {}), null)
})

test('filterResponseHead applies the response policy to a 101 handshake', () => {
  const head = [
    'HTTP/1.1 101 Switching Protocols',
    'upgrade: websocket',
    'connection: Upgrade',
    'sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'set-cookie: dsh-auth=stolen; Path=/',
    'clear-site-data: "cookies", "storage"',
    'access-control-allow-origin: *',
    'permissions-policy: geolocation=()',
  ].join('\r\n')
  assert.equal(
    filterResponseHead(head, { hostId: 'h_a', remoteOrigin: 'http://127.0.0.1:43210' }),
    [
      'HTTP/1.1 101 Switching Protocols',
      'upgrade: websocket',
      'connection: Upgrade',
      'sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    ].join('\r\n') + '\r\n',
  )
  // Anything that is not a status line is not a head this proxy will speak.
  assert.equal(filterResponseHead('nonsense\r\nx: y', {}), '')
})

test('the upgrade forwards a filtered 101 and streams the frames after it', async () => {
  const upgraded = []
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('not used')
  })
  upstream.on('upgrade', (_req, socket) => {
    upgraded.push(socket)
    // Keep the server side readable so a peer FIN is processed instead of staying buffered.
    socket.resume()
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\nconnection: Upgrade\r\n' +
        'sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
        'set-cookie: dsh-auth=stolen; Path=/\r\n' +
        'clear-site-data: "cookies"\r\n' +
        'access-control-allow-origin: *\r\n\r\n' +
        'FRAME-AFTER-HEADERS',
    )
  })
  const upstreamPort = await listen(upstream)
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }))
  try {
    local.proxy.sync(['h_a'])
    const received = await new Promise((resolve, reject) => {
      const socket = net.connect(local.port, '127.0.0.1', () => {
        socket.write(
          `GET ${upgradePath('h_a')} HTTP/1.1\r\n` +
            `Host: ${LOCAL_AUTHORITY}\r\n` +
            'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      const chunks = []
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('the upgrade never answered'))
      }, 5000)
      timer.unref?.()
      socket.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.includes('FRAME-AFTER-HEADERS')) {
          clearTimeout(timer)
          socket.destroy()
          resolve(text)
        }
      })
      socket.on('error', reject)
    })
    assert.match(received, /^HTTP\/1\.1 101/)
    assert.match(received, /upgrade: websocket/i)
    assert.match(received, /connection: Upgrade/i)
    assert.match(received, /sec-websocket-accept:/i)
    assert.equal(received.includes('set-cookie'), false, 'a 101 must not install a cookie')
    assert.equal(received.includes('clear-site-data'), false, 'a 101 must not clear local state')
    assert.equal(received.includes('access-control-allow-origin'), false)
    assert.match(received, /FRAME-AFTER-HEADERS/, 'the frames after the head still stream')
  } finally {
    for (const socket of upgraded) socket.destroy()
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
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

test('the cookie jar is bound to the remote authority and resets when the remote moves', async () => {
  const first = http.createServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: './', 'set-cookie': ['dsh-auth=first-instance; Path=/; HttpOnly'] })
      res.end('token-consumed')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`cookie=${req.headers.cookie ?? ''}`)
  })
  const second = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`cookie=${req.headers.cookie ?? ''}`)
  })
  const firstPort = await listen(first)
  const secondPort = await listen(second)
  const target = { current: { localPort: firstPort, remotePort: firstPort } }
  const local = await startProxy(() => target.current)
  try {
    await request(local.port, '/dsh-remote-go/remote/h_a/?token=one')
    const sameAuthority = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(sameAuthority.body, 'cookie=dsh-auth=first-instance')
    // The remote restarted on a new random port: its authority changed, so the old instance's
    // cookie must not be sent to (or kept for) the new one.
    target.current = { localPort: secondPort, remotePort: secondPort }
    const afterRestart = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(afterRestart.body, 'cookie=')
    assert.equal(local.proxy.cookies('h_a'), '')
    // Dropping the host drops its jar with it.
    local.proxy.sync([])
    assert.equal(local.proxy.cookies('h_a'), '')
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(first)
    await close(second)
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

test('the proxy never forwards the local session credential to the remote host', async () => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  const upstreamPort = await listen(upstream)
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }))
  try {
    const response = await request(local.port, '/dsh-remote-go/remote/h_a/page', {
      headers: {
        accept: 'text/html',
        origin: LOCAL_ORIGIN,
        authorization: 'Bearer local-session-token',
        'x-dsh-remote-go': '1',
        'x-dsh-session': 'local-session',
        'x-forwarded-for': '203.0.113.9',
        forwarded: 'for=203.0.113.9',
        'sec-fetch-site': 'same-origin',
        'x-custom-trace': 'trace-1',
      },
    })
    assert.equal(response.status, 200)
    assert.equal(seen.length, 1)
    const headers = seen[0]
    // The upstream received the request, but not the browser's local credentials or the
    // one-hop routing fields.
    for (const name of [
      'authorization',
      'x-dsh-remote-go',
      'x-dsh-session',
      'x-forwarded-for',
      'forwarded',
      'sec-fetch-site',
      'x-custom-trace',
    ]) {
      assert.equal(headers[name], undefined, `${name} reached the remote host`)
    }
    assert.equal(headers.accept, 'text/html', 'ordinary content headers still work')
    assert.equal(headers.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(headers.origin, `http://127.0.0.1:${upstreamPort}`)
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
})

test('a hostile remote response cannot clear local cookies or navigate the frame away', async () => {
  const upstream = http.createServer((_req, res) => {
    if (_req.url.startsWith('/?token=')) {
      res.writeHead(303, { location: './', 'set-cookie': ['dsh-auth=ok; Path=/'] })
      res.end('token-consumed')
      return
    }
    res.writeHead(302, {
      location: 'https://evil.example/login',
      'clear-site-data': '"cookies", "storage"',
      'access-control-allow-origin': '*',
      'content-location': 'https://evil.example/',
      refresh: '0; url=https://evil.example/',
      'permissions-policy': 'geolocation=()',
      'content-type': 'text/html',
    })
    res.end('redirecting')
  })
  const upstreamPort = await listen(upstream)
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }))
  try {
    await request(local.port, '/dsh-remote-go/remote/h_a/?token=t')
    const redirected = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(redirected.status, 302)
    for (const name of [
      'location',
      'clear-site-data',
      'access-control-allow-origin',
      'content-location',
      'refresh',
      'permissions-policy',
    ]) {
      assert.equal(redirected.headers[name], undefined, `the remote set ${name} on the local origin`)
    }
    assert.equal(redirected.headers['content-type'], 'text/html')
  } finally {
    local.proxy.dispose()
    await close(local.server)
    await close(upstream)
  }
})

test('an upstream that accepts and never answers fails with 502 instead of hanging', async () => {
  const hungSockets = new Set()
  const hung = net.createServer((socket) => {
    hungSockets.add(socket)
    socket.on('close', () => hungSockets.delete(socket))
    // Accept and never answer: the old proxy waited forever.
  })
  const upstreamPort = await listen(hung)
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }), fakeWebServer(), {
    upstreamTimeoutMs: 150,
  })
  try {
    const started = Date.now()
    const response = await request(local.port, '/dsh-remote-go/remote/h_a/')
    assert.equal(response.status, 502)
    assert.ok(Date.now() - started < 10_000, 'the request must not hang on a silent upstream')
  } finally {
    for (const socket of hungSockets) socket.destroy()
    local.proxy.dispose()
    await close(local.server)
    await close(hung)
  }
})

test('an upgrade upstream that accepts and never answers the handshake is dropped and reported', async () => {
  const hungSockets = new Set()
  const hung = net.createServer((socket) => {
    hungSockets.add(socket)
    socket.on('close', () => hungSockets.delete(socket))
  })
  const upstreamPort = await listen(hung)
  const failures = []
  const local = await startProxy(() => ({ localPort: upstreamPort, remotePort: upstreamPort }), fakeWebServer(), {
    upstreamTimeoutMs: 150,
    onUpstreamError: (hostId) => failures.push(hostId),
  })
  try {
    local.proxy.sync(['h_a'])
    await new Promise((resolve, reject) => {
      const socket = net.connect(local.port, '127.0.0.1', () => {
        socket.write(
          `GET ${upgradePath('h_a')} HTTP/1.1\r\n` +
            `Host: ${LOCAL_AUTHORITY}\r\n` +
            'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
      })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('the upgrade socket was never dropped'))
      }, 10_000)
      timer.unref?.()
      socket.on('close', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      socket.on('error', () => {})
      socket.resume()
    })
    assert.deepEqual(failures, ['h_a'])
  } finally {
    for (const socket of hungSockets) socket.destroy()
    local.proxy.dispose()
    await close(local.server)
    await close(hung)
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

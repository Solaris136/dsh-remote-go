import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  adoptRemoteWeb,
  buildForeignDshCommand,
  buildStartCommand,
  buildStartScript,
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  parseForeignDshOutput,
  parseWebLine,
  readWebLineFromLog,
  startRemoteWeb,
  stopForeignDshProcesses,
  stopRemoteWeb,
  remoteHttpStatus,
} from '../../src/webapp.js'
import { remoteLayout } from '../../src/layout.js'

const LAYOUT = remoteLayout('~/.dsh-remote-go', '/home/ubuntu')

/** @returns {import('../../src/bootstrap.js').RuntimePlan} */
function npxPlan(overrides = {}) {
  return {
    level: 'npx',
    profile: 'web',
    targetVersion: '0.2.2-rc.1',
    reason: { zh: '', en: '' },
    start: {
      kind: 'npx',
      npxPath: '/usr/bin/npx',
      nodePath: '/usr/bin/node',
      nodeBinDir: '/usr/bin',
      targetVersion: '0.2.2-rc.1',
      ...overrides,
    },
  }
}

test('parseWebLine extracts loopback port and token', () => {
  const parsed = parseWebLine('dsh web: http://127.0.0.1:38123/?token=abc123')
  assert.equal(parsed.host, '127.0.0.1')
  assert.equal(parsed.port, 38123)
  assert.equal(parsed.token, 'abc123')
  assert.equal(parsed.url, 'http://127.0.0.1:38123/?token=abc123')
  assert.equal(parseWebLine('no url here'), null)
  assert.equal(parseWebLine('dsh web: http://[::1]:4444/?token=x').host, '::1')
})

test('buildStartCommand produces the pinned npx launch command against ~/.dsh', () => {
  const command = buildStartCommand(npxPlan(), LAYOUT)
  assert.ok(command.includes("DSH_HOME='/home/ubuntu/.dsh'"), command)
  assert.match(command, /@deepseek-ai\/dsh@0\.2\.2-rc\.1/)
  assert.match(command, /--profile 'web' --no-open --port 0/)
  assert.match(command, /PATH='\/usr\/bin':"\$PATH"/)
})

test('buildStartScript detaches, waits for the readiness line and records the run registry', () => {
  const script = buildStartScript('env A=1 /bin/true', LAYOUT, {
    waitSeconds: 7,
    version: '0.2.2-rc.1',
    profile: 'web',
  })
  assert.match(script, /setsid nohup bash -lc/)
  assert.match(script, /grep -q 'dsh web:'/)
  assert.match(script, /DONE:\$PID:\$PORT/)
  assert.match(script, /"0\.2\.2-rc\.1"/)
  assert.match(script, /"dshHome":%s/)
  assert.ok(script.includes('"/home/ubuntu/.dsh"'))
  assert.match(script, /-lt 7/)
})

test('startRemoteWeb parses the combined stdout and returns pid/port/token', async () => {
  const ssh = {
    async exec(command, options) {
      assert.match(command, /setsid nohup/)
      options.onStdout('PID:999\ni=0\nLINE:dsh web: http://127.0.0.1:41234/?token=tok\nDONE:999:41234\n')
      return { code: 0, stdout: 'LINE:dsh web: http://127.0.0.1:41234/?token=tok\nDONE:999:41234\n', stderr: '' }
    },
  }
  const info = await startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT })
  assert.equal(info.pid, 999)
  assert.equal(info.port, 41234)
  assert.equal(info.token, 'tok')
  assert.equal(info.profile, 'web')
  assert.equal(info.dshHome, '/home/ubuntu/.dsh')
})

test('startRemoteWeb fails with coded errors when the remote dies or times out', async () => {
  const dead = {
    async exec() {
      return { code: 3, stdout: 'EXITED:1\n---LOG---\ncrash', stderr: '' }
    },
  }
  await assert.rejects(
    () => startRemoteWeb(dead, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-dsh-start-failed' && /crash/.test(error.technical ?? ''),
  )
  const timeout = {
    async exec() {
      return { code: 4, stdout: 'TIMEOUT\n---LOG---', stderr: '' }
    },
  }
  await assert.rejects(
    () => startRemoteWeb(timeout, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-dsh-start-failed',
  )
})

test('startRemoteWeb refuses a non-loopback advertised URL', async () => {
  const ssh = {
    async exec() {
      return { code: 0, stdout: 'DONE:1:80\nLINE:dsh web: http://10.0.0.5:80/?token=x\n', stderr: '' }
    },
  }
  await assert.rejects(
    () => startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-ui-unreachable',
  )
})

test('stopRemoteWeb and remoteHttpStatus use tightly scoped shell commands', async () => {
  const calls = []
  const ssh = {
    async exec(command) {
      calls.push(command)
      if (command.includes('curl')) return { code: 0, stdout: '401', stderr: '' }
      if (command.includes('kill')) return { code: 0, stdout: 'STOPPED', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  assert.deepEqual(await stopRemoteWeb(ssh, LAYOUT, { pid: 42 }), { ok: true, output: 'STOPPED' })
  assert.equal(await remoteHttpStatus(ssh, 38123), 401)
  assert.equal(await remoteHttpStatus(ssh, 0), null)
  assert.ok(calls.some((command) => command.includes('kill -TERM')))
})

test('adoptRemoteWeb requires the same dshHome/profile, a live pid, a logged URL and a responsive server', async () => {
  const responses = [
    {
      code: 0,
      stdout: '{"pid":4242,"port":38123,"version":"0.2.2-rc.1","profile":"web","dshHome":"/home/ubuntu/.dsh"}',
      stderr: '',
    }, // cat registry
    { code: 0, stdout: 'alive', stderr: '' }, // kill -0
    { code: 0, stdout: 'dsh web: http://127.0.0.1:38123/?token=adopted\n', stderr: '' }, // grep log
    { code: 0, stdout: '200', stderr: '' }, // curl
  ]
  const ssh = {
    async exec() {
      return responses.shift() ?? { code: 1, stdout: '', stderr: '' }
    },
  }
  const adopted = await adoptRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(adopted.pid, 4242)
  assert.equal(adopted.token, 'adopted')
  assert.equal(adopted.version, '0.2.2-rc.1')
  assert.equal(adopted.dshHome, '/home/ubuntu/.dsh')

  const dead = {
    async exec() {
      return { code: 1, stdout: '', stderr: '' }
    },
  }
  assert.equal(await adoptRemoteWeb(dead, LAYOUT, { profile: 'web' }), null)
})

test('adoptRemoteWeb refuses a registry from another home or profile', async () => {
  for (const registry of [
    { pid: 1, port: 2, profile: 'web', dshHome: '/home/ubuntu/.dsh-remote-go/home' },
    { pid: 1, port: 2, profile: 'headless', dshHome: '/home/ubuntu/.dsh' },
    { pid: 1, port: 2, version: '0.2.2-rc.1' },
  ]) {
    const ssh = {
      async exec() {
        return { code: 0, stdout: JSON.stringify(registry), stderr: '' }
      },
    }
    assert.equal(await adoptRemoteWeb(ssh, LAYOUT, { profile: 'web' }), null)
  }
})

test('foreign DSH detection scans ps, ignores pids and respects DSH_HOME', async () => {
  const command = buildForeignDshCommand([111, 222])
  assert.match(command, /ps -eww -o pid=,comm=,args=/)
  assert.match(command, /IGNORE=" 111 222 "/)
  assert.match(command, /node\|dsh\|npm\|npx/)
  assert.match(command, /DSH_HOME/)

  const stdout = '4242\t/bin/node /home/u/.npm/_npx/x/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web\n'
  const ssh = {
    async exec(got) {
      assert.match(got, /IGNORE=" 111 "/)
      return { code: 0, stdout, stderr: '' }
    },
  }
  const found = await findForeignDshProcesses(ssh, { ignorePids: [111] })
  assert.equal(found.ok, true)
  assert.deepEqual(found.processes, [
    { pid: 4242, command: '/bin/node /home/u/.npm/_npx/x/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web' },
  ])
  assert.deepEqual(parseForeignDshOutput('nope\n0\tx\n9\t\n'), [])
  const broken = {
    async exec() {
      throw new Error('no ps')
    },
  }
  assert.equal((await findForeignDshProcesses(broken)).ok, false)
})

test('stopForeignDshProcesses sends TERM/KILL and reports survivors', async () => {
  const calls = []
  const ssh = {
    async exec(command) {
      calls.push(command)
      return { code: 0, stdout: 'STOPPED\n', stderr: '' }
    },
  }
  const stopped = await stopForeignDshProcesses(ssh, [{ pid: 42 }, { pid: 42 }, { pid: 0 }])
  assert.equal(stopped.ok, true)
  assert.match(calls[0], /PIDS="42"/)
  assert.match(calls[0], /kill -TERM/)
  assert.match(calls[0], /kill -KILL/)

  const survivor = {
    async exec() {
      return { code: 0, stdout: 'ALIVE:42\nSTOPPED\n', stderr: '' }
    },
  }
  const failed = await stopForeignDshProcesses(survivor, [{ pid: 42 }])
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.alive, [42])
  assert.equal((await stopForeignDshProcesses(ssh, [])).ok, true)
})

test('readWebLineFromLog reads the last readiness line', async () => {
  const ssh = {
    async exec() {
      return { code: 0, stdout: 'dsh web: http://127.0.0.1:5000/?token=abc\n', stderr: '' }
    },
  }
  const parsed = await readWebLineFromLog(ssh, LAYOUT)
  assert.equal(parsed.port, 5000)
})

async function startFakeDsh({ xFrameOptions = null, csp = null } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      res.writeHead(302, {
        location: './',
        'set-cookie': ['dsh-auth-test=abc123; Path=/; HttpOnly; SameSite=Strict', 'other=1; Path=/'],
      })
      res.end()
      return
    }
    if (url.pathname === '/') {
      const cookie = req.headers.cookie ?? ''
      if (!cookie.includes('dsh-auth-test=abc123')) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      /** @type {Record<string, string>} */
      const headers = { 'content-type': 'text/html; charset=utf-8' }
      if (xFrameOptions) headers['x-frame-options'] = xFrameOptions
      if (csp) headers['content-security-policy'] = csp
      res.writeHead(200, headers)
      res.end('<!doctype html><html><head><title>DSH</title></head><body>app</body></html>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: address.port }
}

test('exchangeTokenOverTunnel performs the token → cookie → index handshake', async () => {
  const { server, port } = await startFakeDsh()
  try {
    const result = await exchangeTokenOverTunnel(port, 'tok-1')
    assert.equal(result.ok, true)
    assert.equal(result.firstStatus, 302)
    assert.equal(result.status, 200)
    assert.equal(result.title, 'DSH')
    assert.deepEqual(result.cookieNames, ['dsh-auth-test', 'other'])
    assert.equal(result.frameBlocked, false)
  } finally {
    server.close()
  }
})

test('exchangeTokenOverTunnel flags frame-blocking headers', async () => {
  const { server, port } = await startFakeDsh({ xFrameOptions: 'DENY' })
  try {
    const result = await exchangeTokenOverTunnel(port, 'tok-2')
    assert.equal(result.frameBlocked, true)
    assert.equal(result.xFrameOptions, 'DENY')
  } finally {
    server.close()
  }
})

test('exchangeTokenOverTunnel reports a failed handshake without throwing', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401)
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await exchangeTokenOverTunnel(port, 'bad')
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
  } finally {
    server.close()
  }
})

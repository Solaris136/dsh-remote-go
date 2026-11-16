import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  BROWSER_CARRIER_PATCH_FILE,
  LAUNCH_MARKER,
  adoptRemoteWeb,
  buildBrowserCarrierProbe,
  buildForeignDshCommand,
  buildRunRegistryRecord,
  buildStartCommand,
  buildStartScript,
  commandMatchesProfile,
  ensureBrowserCarrier,
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  parseForeignDshOutput,
  parseListenPorts,
  parseWebLine,
  readWebLineFromLog,
  remoteListenPorts,
  remotePortOwnerPid,
  resolveRemoteWeb,
  startRemoteWeb,
  stopForeignDshProcesses,
  stopRemoteWeb,
  remoteHttpStatus,
  versionFromCommand,
  writeRunRegistry,
} from '../../src/webapp.js'
import { remoteLayout } from '../../src/layout.js'

const LAYOUT = remoteLayout('/home/ubuntu')

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

test('buildStartCommand applies the browser-carrier overlay before the profile', () => {
  const patchPath = '/home/ubuntu/.dsh/remote-go/browser-carrier.patch.yml'
  const command = buildStartCommand(npxPlan(), LAYOUT, { patchPath })
  assert.match(command, new RegExp(`--patch '${patchPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --profile 'web'`))
})

test('buildBrowserCarrierProbe dumps the profile and only then writes the overlay', () => {
  const script = buildBrowserCarrierProbe(npxPlan(), LAYOUT, 'web')
  assert.match(script, /--dump-config/)
  assert.match(script, /grep -A6 'id: api-remotes'/)
  assert.ok(script.includes('- id: api-remotes\n  disabled: false'), script)
  assert.ok(script.includes(`/home/ubuntu/.dsh/remote-go/${BROWSER_CARRIER_PATCH_FILE}`), script)
  assert.ok(script.indexOf('disabled: true') < script.indexOf('cat >'), script)
})

test('ensureBrowserCarrier reports patched, clear and unknown probes', async () => {
  const replies = [
    { code: 0, stdout: 'PATCH\n', stderr: '' },
    { code: 0, stdout: 'CLEAR\n', stderr: '' },
    { code: 0, stdout: 'DUMP-FAILED\n', stderr: '' },
  ]
  const ssh = {
    async exec() {
      return replies.shift() ?? { code: 1, stdout: '', stderr: '' }
    },
  }
  const options = { plan: npxPlan(), layout: LAYOUT, profile: 'web' }
  assert.deepEqual(await ensureBrowserCarrier(ssh, options), {
    status: 'patched',
    patchPath: `/home/ubuntu/.dsh/remote-go/${BROWSER_CARRIER_PATCH_FILE}`,
  })
  assert.deepEqual(await ensureBrowserCarrier(ssh, options), { status: 'clear', patchPath: null })
  assert.deepEqual(await ensureBrowserCarrier(ssh, options), { status: 'unknown', patchPath: null })
  const throwing = {
    async exec() {
      throw new Error('no npx')
    },
  }
  assert.deepEqual(await ensureBrowserCarrier(throwing, options), { status: 'unknown', patchPath: null })
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
  assert.ok(script.includes(`"launch":"${LAUNCH_MARKER}"`), script)
  assert.match(script, /-lt 7/)
})

test('startRemoteWeb parses the combined stdout and returns pid/port/token', async () => {
  const commands = []
  const ssh = {
    async exec(command, options) {
      commands.push(command)
      if (command.includes('--dump-config')) return { code: 0, stdout: 'CLEAR\n', stderr: '' }
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
  assert.equal(info.browserCarrier, 'clear')
  assert.equal(commands.filter((command) => command.includes('--dump-config')).length, 1)
  assert.ok(!commands.some((command) => command.includes('--patch ')))
})

test('startRemoteWeb re-enables api-remotes with --patch when the profile disables it', async () => {
  const commands = []
  const ssh = {
    async exec(command, options) {
      commands.push(command)
      if (command.includes('--dump-config')) return { code: 0, stdout: 'PATCH\n', stderr: '' }
      options.onStdout('LINE:dsh web: http://127.0.0.1:41234/?token=tok\nDONE:999:41234\n')
      return { code: 0, stdout: 'LINE:dsh web: http://127.0.0.1:41234/?token=tok\nDONE:999:41234\n', stderr: '' }
    },
  }
  const info = await startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT })
  assert.equal(info.browserCarrier, 'patched')
  const start = commands.find((command) => command.includes('setsid nohup'))
  assert.ok(start.includes('--patch'), start)
  assert.ok(start.includes(BROWSER_CARRIER_PATCH_FILE), start)
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
      stdout: `{"pid":4242,"port":38123,"version":"0.2.2-rc.1","profile":"web","dshHome":"/home/ubuntu/.dsh","launch":"${LAUNCH_MARKER}"}`,
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

test('adoptRemoteWeb refuses a registry from another home/profile or an older launch path', async () => {
  for (const registry of [
    { pid: 1, port: 2, profile: 'web', dshHome: '/home/ubuntu/.dsh-remote-go/home', launch: LAUNCH_MARKER },
    { pid: 1, port: 2, profile: 'headless', dshHome: '/home/ubuntu/.dsh', launch: LAUNCH_MARKER },
    { pid: 1, port: 2, version: '0.2.2-rc.1', launch: LAUNCH_MARKER },
    { pid: 1, port: 2, profile: 'web', dshHome: '/home/ubuntu/.dsh', version: '0.2.2-rc.1' },
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

const ok = (stdout) => ({ code: 0, stdout, stderr: '' })

/** A fake transport that answers by the shape of the command it receives. */
function routedSsh(routes) {
  const calls = []
  return {
    calls,
    async exec(command) {
      calls.push(command)
      for (const [pattern, reply] of routes) {
        if (pattern.test(command)) return typeof reply === 'function' ? reply(command) : reply
      }
      return { code: 1, stdout: '', stderr: '' }
    },
  }
}

const REGISTRY_JSON = JSON.stringify({
  pid: 4242,
  port: 38123,
  startedAt: '2026-11-16T00:00:00.000Z',
  profile: 'web',
  version: '0.2.2-rc.1',
  dshHome: '/home/ubuntu/.dsh',
  launch: LAUNCH_MARKER,
})

const HTTP_PROBE = /curl -s -o \/dev\/null -w|--server-response/
const LISTEN_SCAN = /\/proc\/\$PID\/fd/
const PROCESS_PS = /ps -eww -o pid=,comm=,args=/

test('resolveRemoteWeb re-reads the random port after an in-place restart', async () => {
  const ssh = routedSsh([
    [/^cat '.*run\/web\.json'/, ok(`${REGISTRY_JSON}\n`)],
    [/grep 'dsh web:'/, ok('dsh web: http://127.0.0.1:41234/?token=newtok\n')],
    [/^kill -0 4242/, ok('alive\n')],
    [LISTEN_SCAN, ok('INODE:700\nLISTEN:0100007F:9A32:700\n')],
    [HTTP_PROBE, (command) => ok(/38123/.test(command) ? '000' : '200')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(found.ok, true)
  assert.equal(found.pid, 4242)
  assert.equal(found.port, 41234)
  assert.equal(found.token, 'newtok')
  assert.equal(found.url, 'http://127.0.0.1:41234/?token=newtok')
  assert.equal(found.version, '0.2.2-rc.1')
  assert.equal(found.source, 'registry')
  assert.equal(found.dshHome, '/home/ubuntu/.dsh')
  assert.equal(found.profile, 'web')
})

test('resolveRemoteWeb recovers a new pid from a fresh readiness line', async () => {
  const deadRegistry = JSON.stringify({ ...JSON.parse(REGISTRY_JSON), pid: 4242 })
  const ssh = routedSsh([
    [/^cat '.*run\/web\.json'/, ok(`${deadRegistry}\n`)],
    [/grep 'dsh web:'/, ok('dsh web: http://127.0.0.1:41234/?token=newtok\n')],
    [/^kill -0 4242/, ok('')],
    [/\/proc\/net\/tcp/, ok('PID:5150\n')],
    [/(ps -p 5150 -o args=|tr '\\0' ' ' < "\/proc\/5150\/cmdline")/, ok('node /x/bin.js --profile web --no-open\n')],
    [HTTP_PROBE, ok('200')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(found.ok, true)
  assert.equal(found.pid, 5150)
  assert.equal(found.port, 41234)
  assert.equal(found.token, 'newtok')
  assert.equal(found.source, 'log')
})

test('resolveRemoteWeb falls back to the DSH process for this profile when the log is stale', async () => {
  const ssh = routedSsh([
    [/^cat '.*run\/web\.json'/, ok('')],
    [/grep 'dsh web:'/, ok('')],
    [PROCESS_PS, ok('5150\t/bin/node /x/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open\n')],
    [/\/proc\/\$PID\/fd/, ok('INODE:900\nLISTEN:0100007F:B6E2:900\n')],
    [/ps -p 5150 -o args=/, ok('node bin.js @deepseek-ai/dsh@0.2.2-rc.1 --profile web\n')],
    [HTTP_PROBE, ok('200')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(found.ok, true)
  assert.equal(found.pid, 5150)
  assert.equal(found.port, 0xb6e2)
  assert.equal(found.token, '')
  assert.equal(found.url, `http://127.0.0.1:${0xb6e2}/`)
  assert.equal(found.version, '0.2.2-rc.1')
  assert.equal(found.source, 'process')
})

test('resolveRemoteWeb reports a typed reason when nothing can be re-attached', async () => {
  const empty = routedSsh([
    [/^cat '.*run\/web\.json'/, ok('')],
    [/grep 'dsh web:'/, ok('')],
    [PROCESS_PS, ok('')],
  ])
  assert.deepEqual(await resolveRemoteWeb(empty, LAYOUT, { profile: 'web' }), {
    ok: false,
    reason: 'no-running-web',
  })
  const aliveButSilent = routedSsh([
    [/^cat '.*run\/web\.json'/, ok(`${REGISTRY_JSON}\n`)],
    [/grep 'dsh web:'/, ok('')],
    [/^kill -0 4242/, ok('alive\n')],
    [LISTEN_SCAN, ok('')],
    [HTTP_PROBE, ok('000')],
    [PROCESS_PS, ok('')],
  ])
  assert.deepEqual(await resolveRemoteWeb(aliveButSilent, LAYOUT, { profile: 'web' }), {
    ok: false,
    reason: 'no-listener',
  })
})

test('writeRunRegistry writes a shell-quoted record and reports the acknowledgement', async () => {
  const record = buildRunRegistryRecord({
    pid: 4242,
    port: 41234,
    version: 'v0.2.2-rc.1',
    profile: 'web',
    dshHome: "/home/o'neil/.dsh",
    startedAt: '2026-11-16T00:00:00.000Z',
  })
  assert.equal(record.launch, LAUNCH_MARKER)
  assert.equal(record.version, '0.2.2-rc.1')
  const ssh = routedSsh([[/printf '%s\\n'/, ok('REGISTRY-WRITTEN\n')]])
  const written = await writeRunRegistry(ssh, LAYOUT, record)
  assert.deepEqual(written, { ok: true, output: 'REGISTRY-WRITTEN' })
  const command = ssh.calls[0]
  assert.match(command, /mkdir -p '\/home\/ubuntu\/\.dsh\/remote-go\/run'/)
  assert.match(command, /printf '%s\\n' '/)
  // A quote in the home directory must not break out of the single-quoted payload.
  assert.ok(command.includes("/home/o'\\''neil/.dsh"), command)
  const failing = routedSsh([[/printf '%s\\n'/, { code: 1, stdout: '', stderr: 'read-only fs' }]])
  assert.deepEqual(await writeRunRegistry(failing, LAYOUT, record), { ok: false, output: '' })
  const throwing = {
    async exec() {
      throw new Error('no shell')
    },
  }
  assert.equal((await writeRunRegistry(throwing, LAYOUT, record)).ok, false)
})

test('buildRunRegistryRecord refuses invalid pids, ports and homes', () => {
  assert.throws(() => buildRunRegistryRecord({ pid: 0, port: 1, dshHome: '/x' }), /pid/)
  assert.throws(() => buildRunRegistryRecord({ pid: 1, port: 0, dshHome: '/x' }), /port/)
  assert.throws(() => buildRunRegistryRecord({ pid: 1, port: 70000, dshHome: '/x' }), /port/)
  assert.throws(() => buildRunRegistryRecord({ pid: 1, port: 2, dshHome: '  ' }), /DSH_HOME/)
})

test('profile and version helpers only match the exact launch shape', () => {
  assert.equal(commandMatchesProfile('node bin.js --profile web --no-open --port 0', 'web'), true)
  assert.equal(commandMatchesProfile('node bin.js --profile=web', 'web'), true)
  assert.equal(commandMatchesProfile('node bin.js --profile webtest', 'web'), false)
  assert.equal(commandMatchesProfile('node bin.js', ''), false)
  assert.equal(versionFromCommand('npx -y @deepseek-ai/dsh@0.2.2-rc.1 --profile web'), '0.2.2-rc.1')
  assert.equal(versionFromCommand('node /opt/dsh/bin.js web'), null)
})

test('listen-port parsing only keeps sockets owned by the pid', async () => {
  const stdout = [
    'INODE:700',
    'LISTEN:0100007F:1F90:700',
    'LISTEN:00000000000000000000000000000000:01BB:701',
    'LISTEN:0100007F:1F90:700',
  ].join('\n')
  assert.deepEqual(parseListenPorts(stdout), [8080])
  const ssh = routedSsh([[/\/proc\/\$PID\/fd/, ok(`${stdout}\n`)]])
  assert.deepEqual(await remoteListenPorts(ssh, 4242), [8080])
  assert.deepEqual(await remoteListenPorts(ssh, 0), [])
  const broken = {
    async exec() {
      throw new Error('no /proc')
    },
  }
  assert.deepEqual(await remoteListenPorts(broken, 1), [])
  const owner = routedSsh([[/\/proc\/net\/tcp/, ok('PID:99\n')]])
  assert.equal(await remotePortOwnerPid(owner, 8080), 99)
  assert.match(owner.calls[0], /PORT_HEX=\$\(printf '%04X' 8080\)/)
  assert.equal(await remotePortOwnerPid(owner, 0), null)
  assert.equal(await remotePortOwnerPid(owner, 70000), null)
  const noOwner = routedSsh([[/\/proc\/net\/tcp/, ok('')]])
  assert.equal(await remotePortOwnerPid(noOwner, 8080), null)
})

async function startFakeDsh() {
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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
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

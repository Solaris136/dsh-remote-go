import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  LAUNCH_MARKER,
  buildRunRegistryRecord,
  parseRunRegistry,
  readRunRegistry,
  writeRunRegistry,
} from '../../dist/src/remote-web/registry.js'
import {
  adoptRemoteWeb,
  commandMatchesProfile,
  dshPackageDirFromCommand,
  parseWebLine,
  readWebLineFromLog,
  remoteDshVersion,
  resolveRemoteWeb,
  versionFromCommand,
} from '../../dist/src/remote-web/resolve.js'
import {
  BROWSER_CARRIER_PATCH_FILE,
  buildBrowserCarrierProbe,
  buildStartCommand,
  buildStartScript,
  ensureBrowserCarrier,
  startRemoteWeb,
} from '../../dist/src/remote-web/start.js'
import { stopRemoteWeb } from '../../dist/src/remote-web/stop.js'
import {
  buildForeignDshCommand,
  exchangeTokenOverTunnel,
  findForeignDshProcesses,
  parseForeignDshOutput,
  parseListenPorts,
  parseProcessIdentity,
  remoteHttpStatus,
  remoteListenPorts,
  remotePortOwnerPid,
  stopForeignDshProcesses,
} from '../../dist/src/remote-proc.js'
import { remoteLayout } from '../../dist/src/layout.js'
const LAYOUT = remoteLayout('/home/ubuntu')
const HOST = '/home/ubuntu/.dsh'
const TARGET = '0.2.2-rc.1'
const ok = (stdout) => ({ code: 0, stdout, stderr: '' })
const FAILED = { code: 1, stdout: '', stderr: '' }
/** A transport that answers every command with `stdout`. */
const answers = (stdout) => ({
  async exec() {
    return ok(stdout)
  },
})
/** A transport that records every command and answers each one through `handler`. */
function recordingSsh(handler) {
  const calls = []
  return {
    calls,
    async exec(command, options) {
      calls.push(command)
      return handler(command, options)
    },
  }
}
/** A fake transport that answers by the shape of the command it receives. */
function routedSsh(routes) {
  const calls = []
  return {
    calls,
    async exec(command, options) {
      calls.push(command)
      for (const [pattern, reply] of routes) {
        if (pattern.test(command)) return typeof reply === 'function' ? reply(command, options) : reply
      }
      return FAILED
    },
  }
}
const REGISTRY_JSON = JSON.stringify({
  pid: 4242,
  port: 38123,
  startedAt: '2026-11-16T00:00:00.000Z',
  profile: 'web',
  version: TARGET,
  dshHome: HOST,
  launch: LAUNCH_MARKER,
})
const HTTP_PROBE = /curl -s -o \/dev\/null -w|--server-response/
const LISTEN_SCAN = /\/proc\/\$PID\/fd/
const PROCESS_PS = /ps -eww -o pid=,comm=,args=/
const OWNER_PROBE = /\/proc\/net\/tcp/
const IDENTITY_PROBE = /\/proc\/\$PID\/stat/
const REGISTRY_READ = /^cat '.*run\/web\.json'/
const LOG_GREP = /grep 'dsh web:'/
/** One `/proc` identity answer for a pid (see src/remote-proc.js remoteProcessIdentity). */
function identityAnswer(pid, overrides = {}) {
  const profile = overrides.profile ?? 'web'
  const dshHome = overrides.dshHome ?? HOST
  const command =
    overrides.command ??
    `node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web --profile ${profile} --no-open --port 0`
  return ok(`START:${7000 + pid}\nCMD:${command}\nDSH_HOME:${dshHome}\n`)
}
function npxPlan(overrides = {}) {
  return {
    level: 'npx',
    profile: 'web',
    targetVersion: TARGET,
    reason: { zh: '', en: '' },
    start: {
      kind: 'npx',
      npxPath: '/usr/bin/npx',
      nodePath: '/usr/bin/node',
      nodeBinDir: '/usr/bin',
      targetVersion: TARGET,
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
  const patchPath = `${HOST}/remote-go/browser-carrier.patch.yml`
  const command = buildStartCommand(npxPlan(), LAYOUT, { patchPath })
  assert.match(command, new RegExp(`--patch '${patchPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --profile 'web'`))
})

test('buildBrowserCarrierProbe dumps the profile and only then writes the overlay', () => {
  const script = buildBrowserCarrierProbe(npxPlan(), LAYOUT, 'web')
  assert.match(script, /--dump-config/)
  assert.match(script, /grep -A6 'id: api-remotes'/)
  assert.ok(script.includes('- id: api-remotes\n  disabled: false'), script)
  assert.ok(script.includes(`${HOST}/remote-go/${BROWSER_CARRIER_PATCH_FILE}`), script)
  assert.ok(script.indexOf('disabled: true') < script.indexOf('cat >'), script)
})

test('ensureBrowserCarrier reports patched, clear and unknown probes', async () => {
  const replies = [ok('PATCH\n'), ok('CLEAR\n'), ok('DUMP-FAILED\n')]
  const ssh = {
    async exec() {
      return replies.shift() ?? FAILED
    },
  }
  const options = { plan: npxPlan(), layout: LAYOUT, profile: 'web' }
  assert.deepEqual(await ensureBrowserCarrier(ssh, options), {
    status: 'patched',
    patchPath: `${HOST}/remote-go/${BROWSER_CARRIER_PATCH_FILE}`,
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
  const script = buildStartScript('env A=1 /bin/true', LAYOUT, { waitSeconds: 7, version: TARGET, profile: 'web' })
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
  const line = `LINE:dsh web: http://127.0.0.1:41234/?token=tok\nDONE:999:41234\n`
  const ssh = recordingSsh((command, options) => {
    if (command.includes('--dump-config')) return ok('CLEAR\n')
    assert.match(command, /setsid nohup/)
    options.onStdout(`PID:999\ni=0\n${line}`)
    return ok(line)
  })
  const info = await startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT })
  assert.equal(info.pid, 999)
  assert.equal(info.port, 41234)
  assert.equal(info.token, 'tok')
  assert.equal(info.profile, 'web')
  assert.equal(info.dshHome, HOST)
  assert.equal(info.browserCarrier, 'clear')
  assert.equal(ssh.calls.filter((command) => command.includes('--dump-config')).length, 1)
  assert.ok(!ssh.calls.some((command) => command.includes('--patch ')))
})

test('startRemoteWeb re-enables api-remotes with --patch when the profile disables it', async () => {
  const line = `LINE:dsh web: http://127.0.0.1:41234/?token=tok\nDONE:999:41234\n`
  const ssh = recordingSsh((command, options) => {
    if (command.includes('--dump-config')) return ok('PATCH\n')
    options.onStdout(line)
    return ok(line)
  })
  const info = await startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT })
  assert.equal(info.browserCarrier, 'patched')
  const start = ssh.calls.find((command) => command.includes('setsid nohup'))
  assert.ok(start.includes('--patch'), start)
  assert.ok(start.includes(BROWSER_CARRIER_PATCH_FILE), start)
})

test('startRemoteWeb fails with coded errors when the remote dies or times out', async () => {
  const dead = answers('EXITED:1\n---LOG---\ncrash')
  await assert.rejects(
    () => startRemoteWeb(dead, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-dsh-start-failed' && /crash/.test(error.technical ?? ''),
  )
  const timeout = answers('TIMEOUT\n---LOG---')
  await assert.rejects(
    () => startRemoteWeb(timeout, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-dsh-start-failed',
  )
})

test('startRemoteWeb refuses a non-loopback advertised URL', async () => {
  const ssh = answers('DONE:1:80\nLINE:dsh web: http://10.0.0.5:80/?token=x\n')
  await assert.rejects(
    () => startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-ui-unreachable',
  )
})

test('startRemoteWeb stops the process it already launched when the start fails', async () => {
  // A readiness line that names another host: the launch already happened and must be undone.
  const nonLoopback = routedSsh([
    [/--dump-config/, ok('CLEAR\n')],
    [/setsid nohup/, ok('PID:4242\nLINE:dsh web: http://10.0.0.5:80/?token=x\nDONE:4242:80\n')],
    [/^kill -0 (?:4242|777)/, ok('alive\n')],
    [/kill -TERM/, ok('STOPPED:4242\n')],
    [/^cat /, FAILED],
  ])
  await assert.rejects(
    () => startRemoteWeb(nonLoopback, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-ui-unreachable',
  )
  const stop = nonLoopback.calls.find((command) => command.includes('kill -TERM'))
  assert.ok(stop, 'the launched process must be stopped before the error surfaces')
  assert.match(stop, /PID=4242/)
  // The wait itself failed: the pid is still known from the `PID:` line, so it is stopped too.
  const timedOut = routedSsh([
    [/--dump-config/, ok('CLEAR\n')],
    [/setsid nohup/, ok('PID:777\nTIMEOUT\n---LOG---\n')],
    [/^kill -0 (?:4242|777)/, ok('alive\n')],
    [/kill -TERM/, ok('STOPPED:4242\n')],
    [/^cat /, FAILED],
  ])
  await assert.rejects(
    () => startRemoteWeb(timedOut, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-dsh-start-failed',
  )
  const timedOutStop = timedOut.calls.find((command) => command.includes('kill -TERM'))
  assert.ok(timedOutStop, 'a start that timed out after launching must stop what it started')
  assert.match(timedOutStop, /PID=777/)
})

test('stopRemoteWeb and remoteHttpStatus use tightly scoped shell commands', async () => {
  const ssh = recordingSsh((command) => ok(command.includes('curl') ? '401' : 'STOPPED'))
  assert.deepEqual(await stopRemoteWeb(ssh, LAYOUT, { pid: 42 }), { ok: true, output: 'STOPPED' })
  assert.equal(await remoteHttpStatus(ssh, 38123), 401)
  assert.equal(await remoteHttpStatus(ssh, 0), null)
  assert.ok(ssh.calls.some((command) => command.includes('kill -TERM')))
})

test('adoptRemoteWeb requires the same dshHome/profile, a live pid, a logged URL and a responsive server', async () => {
  const replies = [
    ok(
      `{"pid":4242,"port":38123,"version":"${TARGET}","profile":"web","dshHome":"${HOST}","launch":"${LAUNCH_MARKER}"}`,
    ), // cat registry
    ok('alive'), // kill -0
    ok('dsh web: http://127.0.0.1:38123/?token=adopted\n'), // grep log
    ok('200'), // curl
  ]
  const ssh = {
    async exec() {
      return replies.shift() ?? FAILED
    },
  }
  const adopted = await adoptRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(adopted.pid, 4242)
  assert.equal(adopted.token, 'adopted')
  assert.equal(adopted.version, TARGET)
  assert.equal(adopted.dshHome, HOST)
  // A record written by the launch script grants kill rights to the connection that adopts it.
  assert.equal(adopted.origin, 'launch')
  const reattached = JSON.stringify({
    pid: 4242,
    port: 38123,
    version: TARGET,
    profile: 'web',
    dshHome: HOST,
    launch: LAUNCH_MARKER,
    origin: 'reattach',
  })
  const reattachReplies = [
    ok(reattached),
    ok('alive'),
    ok('dsh web: http://127.0.0.1:38123/?token=adopted\n'),
    ok('200'),
  ]
  const reattachedSsh = {
    async exec() {
      return reattachReplies.shift() ?? FAILED
    },
  }
  // A re-attached record is hosted, not owned: the adopting connection must not kill it later.
  assert.equal((await adoptRemoteWeb(reattachedSsh, LAYOUT, { profile: 'web' })).origin, 'reattach')
  assert.equal(
    await adoptRemoteWeb(
      {
        async exec() {
          return FAILED
        },
      },
      LAYOUT,
      { profile: 'web' },
    ),
    null,
  )
})

test('adoptRemoteWeb refuses an instance that advertises a non-loopback host', async () => {
  const replies = [
    ok(`${REGISTRY_JSON}\n`),
    ok('alive'),
    // The token would be usable, but the advertised host is not the loopback the tunnel serves.
    ok('dsh web: http://10.0.0.5:38123/?token=adopted\n'),
    ok('200'),
  ]
  const ssh = {
    async exec() {
      return replies.shift() ?? FAILED
    },
  }
  assert.equal(await adoptRemoteWeb(ssh, LAYOUT, { profile: 'web' }), null)
})

test('adoptRemoteWeb refuses a registry from another home/profile or an older launch path', async () => {
  for (const registry of [
    { pid: 1, port: 2, profile: 'web', dshHome: '/home/ubuntu/.dsh-remote-go/home', launch: LAUNCH_MARKER },
    { pid: 1, port: 2, profile: 'headless', dshHome: HOST, launch: LAUNCH_MARKER },
    { pid: 1, port: 2, version: TARGET, launch: LAUNCH_MARKER },
    { pid: 1, port: 2, profile: 'web', dshHome: HOST, version: TARGET },
  ]) {
    const ssh = answers(JSON.stringify(registry))
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
      return ok(stdout)
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
  const ssh = recordingSsh(() => ok('STOPPED\n'))
  const stopped = await stopForeignDshProcesses(ssh, [{ pid: 42 }, { pid: 42 }, { pid: 0 }])
  assert.equal(stopped.ok, true)
  assert.match(ssh.calls[0], /PIDS="42"/)
  assert.match(ssh.calls[0], /kill -TERM/)
  assert.match(ssh.calls[0], /kill -KILL/)
  const survivor = answers('ALIVE:42\nSTOPPED\n')
  const failed = await stopForeignDshProcesses(survivor, [{ pid: 42 }])
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.alive, [42])
  assert.equal((await stopForeignDshProcesses(ssh, [])).ok, true)
})

test('readWebLineFromLog reads the last readiness line', async () => {
  const parsed = await readWebLineFromLog(answers('dsh web: http://127.0.0.1:5000/?token=abc\n'), LAYOUT)
  assert.equal(parsed.port, 5000)
})

test('resolveRemoteWeb re-reads the random port after an in-place restart', async () => {
  const ssh = routedSsh([
    [REGISTRY_READ, ok(`${REGISTRY_JSON}\n`)],
    [LOG_GREP, ok('dsh web: http://127.0.0.1:41234/?token=newtok\n')],
    [/^kill -0 4242/, ok('alive\n')],
    [LISTEN_SCAN, ok('INODE:700\nLISTEN:0100007F:A112:700\n')],
    [IDENTITY_PROBE, identityAnswer(4242)],
    [OWNER_PROBE, ok('PID:4242\n')],
    [HTTP_PROBE, (command) => ok(/41234/.test(command) ? '200' : '000')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(found.ok, true)
  assert.equal(found.pid, 4242)
  assert.equal(found.port, 41234)
  assert.equal(found.token, 'newtok')
  assert.equal(found.url, 'http://127.0.0.1:41234/?token=newtok')
  assert.equal(found.version, TARGET)
  assert.equal(found.source, 'registry')
  assert.equal(found.dshHome, HOST)
  assert.equal(found.profile, 'web')
})

test('resolveRemoteWeb recovers a new pid from a fresh readiness line', async () => {
  const ssh = routedSsh([
    [REGISTRY_READ, ok(`${REGISTRY_JSON}\n`)],
    [LOG_GREP, ok('dsh web: http://127.0.0.1:41234/?token=newtok\n')],
    [/^kill -0 4242/, ok('')],
    [OWNER_PROBE, ok('PID:5150\n')],
    [IDENTITY_PROBE, identityAnswer(5150)],
    [HTTP_PROBE, ok('200')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.equal(found.ok, true)
  assert.equal(found.pid, 5150)
  assert.equal(found.port, 41234)
  assert.equal(found.token, 'newtok')
  assert.equal(found.source, 'log')
  // A new pid cannot be assumed to run the local version.
  assert.equal(found.version, null)
})

test('resolveRemoteWeb never takes over without a launch token (process-scan fallback degrades)', async () => {
  const ssh = routedSsh([
    [REGISTRY_READ, ok('')],
    [LOG_GREP, ok('')],
    [PROCESS_PS, ok('5150\t/bin/node /x/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open\n')],
    [LISTEN_SCAN, ok('INODE:900\nLISTEN:0100007F:B6E2:900\n')],
    [IDENTITY_PROBE, identityAnswer(5150)],
    [HTTP_PROBE, ok('200')],
  ])
  assert.deepEqual(await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' }), { ok: false, reason: 'no-token' })
})

test('resolveRemoteWeb reports no-token instead of accepting an empty token', async () => {
  const ssh = routedSsh([
    [REGISTRY_READ, ok(`${REGISTRY_JSON}\n`)],
    // The log line still names an older port; the live port has no token to offer.
    [LOG_GREP, ok('dsh web: http://127.0.0.1:41234/?token=stale\n')],
    [/^kill -0 4242/, ok('alive\n')],
    [LISTEN_SCAN, ok('INODE:700\nLISTEN:0100007F:9513:700\n')],
    [IDENTITY_PROBE, identityAnswer(4242)],
    [OWNER_PROBE, ok('PID:4242\n')],
    [HTTP_PROBE, (command) => ok(/38123/.test(command) ? '200' : '000')],
    [PROCESS_PS, ok('')],
  ])
  assert.deepEqual(await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' }), { ok: false, reason: 'no-token' })
})

test('resolveRemoteWeb refuses a readiness line owned by another profile', async () => {
  const ssh = routedSsh([
    [REGISTRY_READ, ok(`${REGISTRY_JSON}\n`)],
    [LOG_GREP, ok('dsh web: http://127.0.0.1:41234/?token=other-profile\n')],
    [/^kill -0 4242/, ok('alive\n')],
    // The registry pid owns 38123, the newest line's port belongs to another pid/profile.
    [LISTEN_SCAN, ok('INODE:700\nLISTEN:0100007F:9513:700\n')],
    [
      IDENTITY_PROBE,
      (command) => {
        const pid = Number(/^PID=(\d+)/m.exec(command)[1])
        return identityAnswer(pid, pid === 9999 ? { profile: 'other' } : {})
      },
    ],
    [OWNER_PROBE, (command) => ok(/41234/.test(command) ? 'PID:9999\n' : 'PID:4242\n')],
    [HTTP_PROBE, ok('200')],
    [PROCESS_PS, ok('')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.notEqual(found.ok, true)
  assert.equal(found.reason, 'profile-mismatch')
})

test('resolveRemoteWeb refuses a process with another DSH_HOME', async () => {
  const ssh = routedSsh([
    [REGISTRY_READ, ok('')],
    [LOG_GREP, ok('dsh web: http://127.0.0.1:41234/?token=foreign\n')],
    [/^kill -0 4242/, ok('')],
    [OWNER_PROBE, ok('PID:9999\n')],
    [IDENTITY_PROBE, identityAnswer(9999, { dshHome: '/home/other/.dsh' })],
    [HTTP_PROBE, ok('200')],
    [PROCESS_PS, ok('')],
  ])
  const found = await resolveRemoteWeb(ssh, LAYOUT, { profile: 'web' })
  assert.notEqual(found.ok, true)
  assert.equal(found.reason, 'dsh-home-mismatch')
})

test('resolveRemoteWeb reports a typed reason when nothing can be re-attached', async () => {
  const empty = routedSsh([
    [REGISTRY_READ, ok('')],
    [LOG_GREP, ok('')],
    [PROCESS_PS, ok('')],
  ])
  assert.deepEqual(await resolveRemoteWeb(empty, LAYOUT, { profile: 'web' }), {
    ok: false,
    reason: 'no-running-web',
  })
  const aliveButSilent = routedSsh([
    [REGISTRY_READ, ok(`${REGISTRY_JSON}\n`)],
    [LOG_GREP, ok('')],
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

test('process identity parsing fails closed and keeps the kernel start time', () => {
  const identity = parseProcessIdentity(
    'START:12345\nCMD:/usr/bin/node /x/node_modules/@deepseek-ai/dsh/lib/bin.js web --profile web\nDSH_HOME:/home/ubuntu/.dsh\n',
  )
  assert.deepEqual(identity, {
    ok: true,
    startTime: '12345',
    command: '/usr/bin/node /x/node_modules/@deepseek-ai/dsh/lib/bin.js web --profile web',
    dshHome: HOST,
  })
  assert.deepEqual(parseProcessIdentity('MISSING\n'), { ok: false, reason: 'missing' })
  assert.deepEqual(parseProcessIdentity('NO-STAT\n'), { ok: false, reason: 'unreadable' })
  assert.deepEqual(parseProcessIdentity('garbage'), { ok: false, reason: 'unreadable' })
  // A missing environ yields an empty home, which callers treat as unproven (never a match).
  const withoutHome = parseProcessIdentity('START:9\nCMD:node bin.js --profile web\n')
  assert.equal(withoutHome.ok, true)
  assert.equal(withoutHome.dshHome, '')
})

test('real npx/app argv yields the version from the loaded package, never a guess', async () => {
  const argv = '/usr/bin/node /home/u/.npm/_npx/1a2b/node_modules/@deepseek-ai/dsh/lib/bin.js web --profile web'
  assert.equal(versionFromCommand(argv), null)
  assert.equal(dshPackageDirFromCommand(argv), '/home/u/.npm/_npx/1a2b/node_modules/@deepseek-ai/dsh')
  const ssh = {
    files: new Map([
      [
        '/home/u/.npm/_npx/1a2b/node_modules/@deepseek-ai/dsh/package.json',
        JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET }),
      ],
    ]),
    async readRemoteFile(file) {
      const content = this.files.get(file)
      if (content === undefined) throw new Error('no such file')
      return { data: Buffer.from(content), size: content.length }
    },
  }
  assert.equal(await remoteDshVersion(ssh, argv), TARGET)
  assert.equal(await remoteDshVersion(ssh, '/usr/bin/node /opt/unknown/bin.js web'), null)
  assert.equal(dshPackageDirFromCommand('/x/../../etc/node_modules/@deepseek-ai/dsh/lib/bin.js'), null)
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
  assert.equal(record.version, TARGET)
  assert.equal(record.origin, 'launch')
  assert.equal(buildRunRegistryRecord({ ...record, origin: 'reattach' }).origin, 'reattach')
  const ssh = recordingSsh(() => ok('REGISTRY-WRITTEN\n'))
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
  for (const [overrides, pattern] of [
    [{ pid: 0, port: 1, dshHome: '/x' }, /pid/],
    [{ pid: 1, port: 0, dshHome: '/x' }, /port/],
    [{ pid: 1, port: 70000, dshHome: '/x' }, /port/],
    [{ pid: 1, port: 2, dshHome: '  ' }, /DSH_HOME/],
  ]) {
    assert.throws(() => buildRunRegistryRecord(overrides), pattern)
  }
})

test('profile and version helpers only match the exact launch shape', () => {
  assert.equal(commandMatchesProfile('node bin.js --profile web --no-open --port 0', 'web'), true)
  assert.equal(commandMatchesProfile('node bin.js --profile=web', 'web'), true)
  assert.equal(commandMatchesProfile('node bin.js --profile webtest', 'web'), false)
  assert.equal(commandMatchesProfile('node bin.js', ''), false)
  assert.equal(versionFromCommand('npx -y @deepseek-ai/dsh@0.2.2-rc.1 --profile web'), TARGET)
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
/** One DSH server that hands out the auth cookie at `/?token=` and serves the index behind it. */
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
  return { server, port: server.address().port }
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

test('stopRemoteWeb reports no-target when neither a pid nor a registry names the process', async () => {
  const ssh = recordingSsh(() => ok('NO-TARGET\n'))
  const result = await stopRemoteWeb(ssh, LAYOUT, {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-target')
  const stopScript = ssh.calls.find((command) => command.includes('NO-TARGET'))
  assert.ok(stopScript, 'the stop script must run and report the missing target')
  assert.ok(stopScript.indexOf('NO-TARGET') < stopScript.indexOf('kill -TERM'), stopScript)
})

test('stopRemoteWeb keeps the run registry when the process does not confirm its stop', async () => {
  const ssh = recordingSsh((command) => {
    if (command.includes('kill -TERM')) return { code: 6, stdout: 'ALIVE:4242\n', stderr: '' }
    return ok('')
  })
  const result = await stopRemoteWeb(ssh, LAYOUT, { pid: 4242 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'alive')
  const script = ssh.calls.find((command) => command.includes('kill -TERM'))
  // The registry may only be removed after the process is confirmed gone (M4), and only when it names *this* pid.
  assert.equal((script.match(/rm -f "\$RUN"/g) ?? []).length, 1, script)
  assert.ok(script.indexOf('drop_own_record()') < script.indexOf('rm -f "$RUN"'), script)
  assert.ok(script.indexOf('"${REC_PID:-}" = "$PID"') < script.indexOf('rm -f "$RUN"'), script)
  // The ALIVE branch exits before the confirmed-path call, so an unconfirmed stop keeps it.
  assert.ok(script.indexOf('echo "ALIVE:$PID"') < script.lastIndexOf('drop_own_record'), script)
  assert.equal(script.indexOf('ALIVE:'), script.lastIndexOf('ALIVE:'))
})

test('a run registry that does not parse still yields the pid it names', async () => {
  const truncated =
    '{"pid":4242,"port":38123,"startedAt":"2026-11-16T00:00:00.000Z","profile":"web","dshHome":"/home/ubuntu/.dsh"'
  const registry = parseRunRegistry(truncated)
  assert.equal(registry.pid, 4242)
  assert.equal(registry.port, 38123)
  assert.equal(registry.dshHome, HOST)
  // A JSON record without a usable pid is still "a record" (callers
  // check `isPid`); only text naming no pid is "no record".
  assert.equal(parseRunRegistry('{"pid":0,"port":1}').pid, 0)
  assert.equal(parseRunRegistry('complete garbage'), null)
  assert.equal(parseRunRegistry(''), null)
  const read = await readRunRegistry(answers(truncated), LAYOUT)
  assert.equal(read.pid, 4242)
})

test('the run registry is written through a temp file and renamed', async () => {
  const ssh = recordingSsh(() => ok('REGISTRY-WRITTEN\n'))
  const written = await writeRunRegistry(ssh, LAYOUT, { pid: 4242, port: 38123, profile: 'web', dshHome: HOST })
  assert.equal(written.ok, true)
  const script = ssh.calls[0]
  assert.match(script, /TMP="\$RUN\.tmp\.\$\$"/)
  assert.ok(script.indexOf('TMP=') < script.indexOf('mv -f "$TMP"'), script)
  assert.ok(script.indexOf('mv -f "$TMP" "$RUN"') < script.indexOf('REGISTRY-WRITTEN'), script)
})

test('the launch script keeps its private files private and writes the registry atomically', () => {
  const start = buildStartScript('env A=1 /bin/true', LAYOUT, { version: TARGET, profile: 'web' })
  assert.ok(start.indexOf('umask 077') < start.indexOf('mkdir -p'), start)
  assert.ok(start.indexOf('umask 077') < start.indexOf(': > "$LOG"'), start)
  assert.match(start, /chmod 600 "\$LOG"/)
  assert.match(start, /TMP="\$RUN\.tmp\.\$\$"/)
  assert.ok(start.indexOf('> "$TMP"') < start.indexOf('mv -f "$TMP" "$RUN"'), start)
  const probe = buildBrowserCarrierProbe(npxPlan(), LAYOUT, 'web')
  assert.match(probe, /umask 077/)
  assert.match(probe, /rm -f "\$DUMP"/)
  // Both the failure path and the success path remove the profile dump.
  assert.ok(probe.indexOf('DUMP-FAILED') < probe.indexOf('rm -f "$DUMP"'), probe)
  assert.ok(probe.lastIndexOf('echo "CLEAR"') < probe.lastIndexOf('rm -f "$DUMP"'), probe)
})

test('startRemoteWeb never stops a pid it did not launch, even when the registry names one', async () => {
  const registry = JSON.stringify({
    pid: 9999,
    port: 38123,
    profile: 'web',
    dshHome: HOST,
    launch: LAUNCH_MARKER,
    origin: 'reattach',
  })
  const ssh = routedSsh([
    [/--dump-config/, ok('CLEAR\n')],
    // The wrapper printed its pid and then died: nothing of this launch is left alive.
    [/setsid nohup/, ok('PID:1234\nTIMEOUT\n---LOG---\n')],
    [/^kill -0 1234/, ok('')],
    [/^kill -0 9999/, ok('alive\n')],
    [/^cat /, ok(`${registry}\n`)],
    [/kill -TERM/, ok('STOPPED:9999\n')],
  ])
  await assert.rejects(
    () => startRemoteWeb(ssh, { plan: npxPlan(), layout: LAYOUT }),
    (error) => error.code === 'remote-dsh-start-failed',
  )
  assert.equal(
    ssh.calls.some((command) => command.includes('kill -TERM')),
    false,
    'a re-attached instance named by the registry must never be signalled',
  )
})

test('a truncated registry that names no complete pid yields no record', () => {
  assert.equal(parseRunRegistry('{"pid":42'), null)
  assert.equal(parseRunRegistry('{"pid":4242'), null)
  assert.equal(parseRunRegistry('garbage {"pid":4242'), null)
  assert.equal(parseRunRegistry('{"pid":4242,"port":38123}').pid, 4242)
})

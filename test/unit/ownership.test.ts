/**
 * The ownership gate's cross matrix (design-arch §4.3 + §6.2 risk 4).
 *
 * Risk 4 of the P2 design is that merging the three authorization proofs into `proveOwnership`
 * could *loosen* one of them — the restart accepting a `bound` record (B1 regression), or the idle
 * policy reporting the stop-shaped `not-launched-by-this-connection` instead of `not-owned`. The
 * three call sites already have end-to-end tests for their own paths; what was missing is the
 * **cross**: one record shape judged by all three call sites. That is this table.
 *
 * Every row runs the real `proveOwnership` with the real option set each call site passes
 * (`OWNERSHIP_OPTIONS`), so a changed parameter shows up as a changed reason here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { OWNERSHIP_OPTIONS, proveOwnership } from '../../dist/src/connect/ownership.js'
import { remoteLayout } from '../../dist/src/layout.js'
import { createHost, makeTestService } from '../helpers/fake-remote.ts'
import { REPO_ROOT, walkFiles } from '../helpers/source-scan.ts'

const PID = 4242
const REMOTE_HOME = '/home/ubuntu'
const DSH_HOME = '/home/ubuntu/.dsh'
const LAYOUT = remoteLayout(REMOTE_HOME)
const PROFILE = 'web'
const COMMAND = 'node /home/ubuntu/.dsh/remote-go/node/v24.9.0/bin/npx -y @deepseek-ai/dsh@0.2.2-rc.1 --profile web'

/** The `/proc` identity a live, matching instance has (what every row starts from). */
function identity(overrides = {}) {
  return { ok: true, startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME, ...overrides }
}

/** The run registry that names that instance. */
const REGISTRY = { pid: PID, port: 38123, profile: PROFILE, dshHome: DSH_HOME, origin: 'launch' }

/** One record shape: what the runtime remembers, and what `/proc` says now. */
const SHAPES = [
  {
    // A process this connection launched itself (a plain connect / restart).
    name: 'launched',
    launched: { startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME },
  },
  {
    // A process this connection only took over (a re-attach): display rights, no restart kill right.
    name: 'bound',
    bound: { startTime: 'start-4242', origin: 'reattach' },
  },
  {
    // A process the user chose to keep alongside the managed instance.
    name: 'alongside',
    launched: { startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME },
    alongside: true,
  },
  {
    // The pid was recycled: the kernel start time moved.
    name: 'pid-reused',
    launched: { startTime: '1000', command: COMMAND, dshHome: DSH_HOME },
    identity: identity({ startTime: '9999' }),
  },
  {
    // The process runs under another DSH home.
    name: 'dsh-home-mismatch',
    launched: { startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME },
    identity: identity({ dshHome: '/srv/other/.dsh' }),
  },
  {
    // The process runs another profile (its command line says so).
    name: 'profile-mismatch',
    launched: { startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME },
    identity: identity({ command: 'node /opt/dsh/bin.js web --profile other --no-open' }),
  },
  {
    // No record at all: the reason each call site reports for "not mine" is its own wording.
    name: 'no record',
  },
]

/**
 * The expected verdict of each call site for each shape. `null` means "authorized".
 *
 * The `no record` row is why `noProofReason` exists: the stop/restart shape keeps
 * `not-launched-by-this-connection` (the `technical: reason=` payload and the restart log line are
 * frozen, DECISIONS H5), the idle policy keeps `not-owned` (`idle-stop.test.js` deep-equals it).
 */
const EXPECTED = {
  restart: {
    launched: null,
    bound: 'not-launched-by-this-connection',
    alongside: 'kept-alongside',
    'pid-reused': 'pid-reused',
    'dsh-home-mismatch': 'dsh-home-mismatch',
    'profile-mismatch': 'profile-mismatch',
    'no record': 'not-launched-by-this-connection',
  },
  stop: {
    launched: null,
    bound: null,
    alongside: 'kept-alongside',
    'pid-reused': 'pid-reused',
    'dsh-home-mismatch': 'dsh-home-mismatch',
    'profile-mismatch': 'profile-mismatch',
    'no record': 'not-launched-by-this-connection',
  },
  idle: {
    launched: null,
    bound: null,
    // The idle policy never points at an alongside pid, so the shared gate's refusal is a no-op
    // in practice; it is passed for every caller so none can be looser by omission (§4.2).
    alongside: 'kept-alongside',
    'pid-reused': 'pid-reused',
    'dsh-home-mismatch': 'dsh-home-mismatch',
    'profile-mismatch': 'profile-mismatch',
    'no record': 'not-owned',
  },
}

/** Run one row: the real service context, a real runtime, the call site's own option set. */
async function verdictFor(callSite, shape) {
  const { service } = await makeTestService({
    processIdentity: async () => shape.identity ?? identity(),
    readRegistry: async () => REGISTRY,
  })
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
  runtime.remote.pid = PID
  runtime.remote.profile = PROFILE
  runtime.launched = new Map()
  if (shape.launched) runtime.launched.set(PID, shape.launched)
  runtime.bound = shape.bound ? { pid: PID, ...shape.bound } : null
  runtime.alongsidePids = shape.alongside ? [PID] : []
  try {
    return await proveOwnership(service.ctx, runtime, {
      ...OWNERSHIP_OPTIONS[callSite],
      pid: PID,
      layout: LAYOUT,
      profile: PROFILE,
    })
  } finally {
    await service.shutdown()
  }
}

for (const callSite of Object.keys(EXPECTED)) {
  for (const shape of SHAPES) {
    const expected = EXPECTED[callSite][shape.name]
    test(`${callSite} × ${shape.name} → ${expected ?? 'allowed'}`, async () => {
      const verdict = await verdictFor(callSite, shape)
      if (expected === null) {
        assert.equal(verdict.ok, true, `expected the ${callSite} call site to authorize this pid`)
        assert.equal(verdict.evidence.pid, PID)
        assert.ok(verdict.evidence.identity !== null, 'an authorized verdict carries the identity it proved')
        return
      }
      assert.equal(verdict.ok, false, `expected the ${callSite} call site to refuse this pid`)
      assert.equal(verdict.reason, expected)
    })
  }
}

test('an idle policy with no remembered profile skips the profile check instead of refusing', async () => {
  // `teardownRuntime` keeps `remoteProfile`; when even that is unknown the timer has no profile to
  // compare and must not turn "unknown" into a refusal (the pre-merge idle proof behaved the same).
  const { service } = await makeTestService({
    processIdentity: async () => identity({ command: 'node /opt/dsh/bin.js web' }),
    readRegistry: async () => REGISTRY,
  })
  const host = await createHost(service)
  const runtime = service.runtimes.get(host.id)
  runtime.remote.pid = PID
  runtime.remote.profile = null
  runtime.remoteProfile = null
  runtime.launched = new Map([[PID, { startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME }]])
  const verdict = await proveOwnership(service.ctx, runtime, {
    ...OWNERSHIP_OPTIONS.idle,
    pid: PID,
    layout: LAYOUT,
    profile: '',
  })
  assert.equal(verdict.ok, true)
  await service.shutdown()
})

test('only the stop shape reads the run registry', async () => {
  const reads = { restart: 0, stop: 0, idle: 0 }
  for (const callSite of Object.keys(reads)) {
    const { service } = await makeTestService({
      processIdentity: async () => identity(),
      readRegistry: async () => {
        reads[callSite] += 1
        return REGISTRY
      },
    })
    const host = await createHost(service)
    const runtime = service.runtimes.get(host.id)
    runtime.remote.pid = PID
    runtime.launched = new Map([[PID, { startTime: 'start-4242', command: COMMAND, dshHome: DSH_HOME }]])
    await proveOwnership(service.ctx, runtime, {
      ...OWNERSHIP_OPTIONS[callSite],
      pid: PID,
      layout: LAYOUT,
      profile: PROFILE,
    })
    await service.shutdown()
  }
  // The restart's registry check is the caller's (`runRestart` needs a mismatch to become a
  // conflict prompt, not a refusal); the idle policy must survive a stale registry (§4.3).
  assert.deepEqual(reads, { restart: 0, stop: 1, idle: 0 })
})

/**
 * The matrix above proves the *options*; this proves the call sites pass *their own* options.
 * A copy-pasted `OWNERSHIP_OPTIONS.stop` in `restart.ts` would keep every row above green.
 */
test('each call site passes its own ownership option set', async () => {
  const expected = {
    'connect/restart.ts': 'restart',
    'connect/stop.ts': 'stop',
    'host-lifecycle.ts': 'idle',
  }
  for (const [file, callSite] of Object.entries(expected)) {
    const source = await readFile(path.join(REPO_ROOT, 'src', file), 'utf8')
    assert.match(
      source,
      new RegExp(`\\.\\.\\.OWNERSHIP_OPTIONS\\.${callSite}\\b`),
      `${file} must pass OWNERSHIP_OPTIONS.${callSite}`,
    )
    assert.match(source, /proveOwnership\(/)
  }
})

test('proveOwnership has exactly one implementation and three call sites', async () => {
  const definers = []
  const importers = []
  for (const file of await walkFiles(path.join(REPO_ROOT, 'src'), { extensions: /\.ts$/ })) {
    const relative = path.relative(path.join(REPO_ROOT, 'src'), file).split(path.sep).join('/')
    const source = await readFile(file, 'utf8')
    if (/export async function proveOwnership\s*\(/.test(source)) definers.push(relative)
    if (/import\s*\{[^}]*\bproveOwnership\b[^}]*\}/.test(source)) importers.push(relative)
  }
  assert.deepEqual(definers, ['connect/ownership.ts'], 'the gate must stay one implementation')
  assert.deepEqual(importers.sort(), ['connect/restart.ts', 'connect/stop.ts', 'host-lifecycle.ts'])
  // The three literals this merge must not resurrect (§4.1).
  for (const file of await walkFiles(path.join(REPO_ROOT, 'src'), { extensions: /\.ts$/ })) {
    const source = await readFile(file, 'utf8')
    for (const gone of ['killAuthorized', 'closeAuthorized', 'proveIdleStopTarget']) {
      assert.equal(source.includes(gone), false, `${path.basename(file)} still names ${gone}`)
    }
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAdmission } from '../../dist/src/admission.js'
import { createApi } from '../../dist/src/api.js'
import { createKernelAdapter } from '../../dist/src/kernel-adapter.js'
import { createSecretStore, passwordRecordKey } from '../../dist/src/secrets.js'
import { makeTestService } from '../helpers/fake-remote.ts'

const HEADER = { 'x-dsh-remote-go': '1' }

/** One credential service that behaves the way DSH's `LocalCredentialProvider` does. */
function fakeCredentials(extra = {}) {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
    ...extra,
  }
}

function ctxWith(services, extra = {}) {
  return { get: (name) => services[name], ...extra }
}

/** The kernel a current DSH build presents: every capability, every shape as documented. */
function healthyCtx() {
  return ctxWith(
    {
      connection: { requestRejection: (req) => (req?.headers?.origin === 'https://evil.example' ? 403 : undefined) },
      clientModules: {
        graph: () => ({
          rev: '7',
          release: { version: '0.2.2-rc.3', commit: 'abc123' },
          entries: [
            {
              id: 'dsh-remote-go',
              rev: '7',
              url: '/plugins/dsh-remote-go/client.js',
              inject: ['a', 'b'],
              immediately: false,
            },
          ],
        }),
        clientPath: (id) => (id === 'dsh-remote-go' ? 'C:\\tmp\\dsh-remote-go\\client.js' : undefined),
      },
      credentials: fakeCredentials(),
    },
    { fiber: { entry: { options: { id: 'dsh-remote-go', name: 'dsh-remote-go' } } } },
  )
}

// --- 1. fiber.entry -------------------------------------------------------------------------

test('fiberEntry reports ok, absent and changed separately, and never throws', () => {
  const healthy = createKernelAdapter(healthyCtx()).fiberEntry()
  assert.equal(healthy.state, 'ok')
  assert.deepEqual(healthy.value, { id: 'dsh-remote-go', name: 'dsh-remote-go' })

  // An older kernel: no fiber on the context at all.
  const missing = createKernelAdapter({ get: () => undefined }).fiberEntry()
  assert.equal(missing.state, 'absent')
  assert.equal(missing.value, null)
  assert.equal(missing.reason, 'not-injected')

  // A newer kernel: the entry moved from an object to a plain string.
  const moved = createKernelAdapter({ fiber: { entry: 'dsh-remote-go' } }).fiberEntry()
  assert.equal(moved.state, 'changed')
  assert.equal(moved.value, null)
  assert.equal(moved.reason, 'shape')
  assert.match(moved.detail, /fiber\.entry/)

  // A kernel that throws on the lookup itself is absence, never a shape change.
  const throwing = createKernelAdapter({
    get() {
      throw new Error('reflection unavailable')
    },
    fiber: { entry: { options: { id: 'x', name: 'x' } } },
  })
  assert.equal(throwing.fiberEntry().state, 'ok', 'the fiber is a property, not a service lookup')
})

// --- 2. clientModules: graph, release, row, path ---------------------------------------------

test('clientModuleGraph reports the graph, its absence, and a moved graph without NaN counts', () => {
  const healthy = createKernelAdapter(healthyCtx()).clientModuleGraph()
  assert.equal(healthy.state, 'ok')
  assert.equal(healthy.value.rev, '7')
  assert.equal(healthy.value.entries, 1)
  assert.deepEqual(healthy.value.release, { version: '0.2.2-rc.3', commit: 'abc123' })

  const missing = createKernelAdapter(ctxWith({})).clientModuleGraph()
  assert.equal(missing.state, 'absent')
  assert.equal(missing.value, null)

  // The design's fake: `graph()` used to return an object and now returns an array.
  const moved = createKernelAdapter(ctxWith({ clientModules: { graph: () => [] } })).clientModuleGraph()
  assert.equal(moved.state, 'changed')
  assert.equal(moved.value, null)
  assert.match(moved.detail, /graph\(\) returned an array/)
})

test('clientModuleRelease reads the release identity alone, so a graph-only change cannot blind it', () => {
  const releaseOnly = createKernelAdapter(
    ctxWith({ clientModules: { graph: () => ({ release: { version: '0.2.2-rc.3' } }) } }),
  ).clientModuleRelease()
  // No `entries` here on purpose: the version probe does not read them, so it still answers ok.
  assert.equal(releaseOnly.state, 'ok')
  assert.equal(releaseOnly.value.version, '0.2.2-rc.3')

  const noRelease = createKernelAdapter(ctxWith({ clientModules: { graph: () => ({ entries: [] }) } }))
  assert.equal(noRelease.clientModuleRelease().state, 'absent')
  assert.equal(noRelease.clientModuleRelease().value, null)

  const moved = createKernelAdapter(ctxWith({ clientModules: { graph: () => ({ release: { version: 42 } }) } }))
  const changed = moved.clientModuleRelease()
  assert.equal(changed.state, 'changed')
  assert.match(changed.detail, /version/)
})

test('clientModuleRow reports the row, its absence, and a row whose inject list moved', () => {
  const healthy = createKernelAdapter(healthyCtx()).clientModuleRow('dsh-remote-go')
  assert.equal(healthy.state, 'ok')
  assert.deepEqual(healthy.value, {
    id: 'dsh-remote-go',
    rev: '7',
    url: '/plugins/dsh-remote-go/client.js',
    inject: ['a', 'b'],
    immediately: false,
  })

  const unregistered = createKernelAdapter(healthyCtx()).clientModuleRow('some-other-plugin')
  assert.equal(unregistered.state, 'absent')
  assert.match(unregistered.detail, /lists no row/)

  const moved = createKernelAdapter(
    ctxWith({ clientModules: { graph: () => ({ entries: [{ id: 'dsh-remote-go', inject: [1, 2] }] }) } }),
  ).clientModuleRow('dsh-remote-go')
  assert.equal(moved.state, 'changed')
  assert.match(moved.detail, /inject/)
})

test('clientPath reports the resolved bundle, its absence and a moved return type', () => {
  const healthy = createKernelAdapter(healthyCtx()).clientPath('dsh-remote-go')
  assert.equal(healthy.state, 'ok')
  assert.match(healthy.value, /client\.js$/)
  assert.equal(healthy.detail, 'resolved', 'the detail must never echo the machine path')

  const unknown = createKernelAdapter(healthyCtx()).clientPath('some-other-plugin')
  assert.equal(unknown.state, 'absent')

  const moved = createKernelAdapter(
    ctxWith({ clientModules: { graph: () => ({ entries: [] }), clientPath: () => 42 } }),
  ).clientPath('dsh-remote-go')
  assert.equal(moved.state, 'changed')
  assert.match(moved.detail, /clientPath\(\) returned a number/)
})

// --- 3. requestRejection --------------------------------------------------------------------

test('requestRejection keeps the kernel verdict, and only the verdict', () => {
  const adapter = createKernelAdapter(healthyCtx())
  const admitted = adapter.requestRejection({ headers: {} })
  assert.equal(admitted.state, 'ok')
  assert.equal(admitted.value, undefined)
  const refused = adapter.requestRejection({ headers: { origin: 'https://evil.example' } })
  assert.equal(refused.state, 'ok')
  assert.equal(refused.value, 403)
})

test('requestRejection reports a missing service as absent and a moved member as changed', () => {
  const absent = createKernelAdapter(ctxWith({})).requestRejection({ headers: {} })
  assert.equal(absent.state, 'absent')
  assert.equal(absent.value, null)

  const moved = createKernelAdapter(ctxWith({ connection: { requestRejection: 'nope' } })).requestRejection({
    headers: {},
  })
  assert.equal(moved.state, 'changed')
  assert.match(moved.detail, /requestRejection is a string/)

  const threw = createKernelAdapter(
    ctxWith({
      connection: {
        requestRejection() {
          throw new Error('kernel exploded')
        },
      },
    }),
  ).requestRejection({ headers: {} })
  assert.equal(threw.state, 'changed', 'a judgement that throws is changed, not absent')
  assert.equal(threw.reason, 'call-failed')
})

test('T-f: a lookup that throws is absence, so the local fence still decides', () => {
  const admit = createAdmission(
    {
      get() {
        throw new Error('reflection unavailable')
      },
    },
    { warn() {} },
  )
  assert.equal(admit({ headers: {} }), undefined, 'a failed lookup must not go dark')
})

test('T-g: admission fails closed on changed — every request gets 500, never a pass', () => {
  const logged = []
  const admit = createAdmission(ctxWith({ connection: { requestRejection: 'nope' } }), {
    warn: (...args) => logged.push(args.map(String).join(' ')),
  })
  for (const req of [
    { headers: {} },
    { headers: { origin: 'https://evil.example' } },
    { headers: { 'x-dsh-remote-go': '1', origin: 'http://127.0.0.1:1' } },
  ]) {
    assert.equal(admit(req), 500, 'a check that cannot decide must never admit')
  }
  assert.equal(logged.length, 3)
  for (const entry of logged) assert.match(entry, /admission failed/)
})

test('T-g: a changed admission turns a real route into 500 with an ErrorView', async () => {
  const { service } = await makeTestService()
  const admit = createAdmission(ctxWith({ connection: { requestRejection: 'nope' } }), { warn() {} })
  let server
  const api = createApi({
    service,
    getOrigin: () => `http://127.0.0.1:${server.address().port}`,
    admit,
    logger: { warn() {}, error() {} },
  })
  server = http.createServer(api.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-remote-go/api/state`, {
      headers: HEADER,
    })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'internal')
  } finally {
    api.dispose()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await service.shutdown()
  }
})

// --- 4. credentials -------------------------------------------------------------------------

test('credentialService reports the record API, its absence and a moved member', () => {
  const healthy = createKernelAdapter(healthyCtx()).credentialService()
  assert.equal(healthy.state, 'ok')
  assert.equal(typeof healthy.value.readRecord, 'function')
  assert.equal(typeof healthy.value.modifyRecord, 'function')
  assert.equal(typeof healthy.value.deleteRecord, 'function')

  const absent = createKernelAdapter(ctxWith({})).credentialService()
  assert.equal(absent.state, 'absent')
  assert.equal(absent.value, null)

  const moved = createKernelAdapter(ctxWith({ credentials: { readRecord: 'nope', modifyRecord: 'nope' } }))
  const changed = moved.credentialService()
  assert.equal(changed.state, 'changed')
  assert.match(changed.detail, /readRecord/)
})

test('credentialKeyGrammar confirms the replica when the kernel exposes its parser — and refuses a moved one', () => {
  // The kernel's own parser: exactly the documented rule (both segments lowercase identifiers).
  const parser = (value) => {
    const segments = String(value).split('/')
    if (segments.length !== 2 || !/^[a-z][a-z0-9-]*$/.test(segments[0]) || !/^[a-z][a-z0-9-]*$/.test(segments[1])) {
      throw new TypeError(`credential key "${value}" must be "<scope>/<id>"`)
    }
    return `${segments[0]}/${segments[1]}`
  }
  const verified = createKernelAdapter(ctxWith({ credentials: { ...fakeCredentials(), parseCredentialKey: parser } }))
  const ok = verified.credentialKeyGrammar()
  assert.equal(ok.state, 'ok')
  assert.equal(ok.value.verified, true)
  assert.match(ok.value.rule, /a-z/)

  // A kernel that exposes no parser: the replica is still usable, just unconfirmed.
  const unverified = createKernelAdapter(healthyCtx()).credentialKeyGrammar()
  assert.equal(unverified.state, 'ok')
  assert.equal(unverified.value.verified, false)
  assert.match(unverified.detail, /replicated grammar/)

  // A parser that accepts a colon-separated key: the grammar moved.
  const moved = createKernelAdapter(
    ctxWith({ credentials: { ...fakeCredentials(), parseCredentialKey: (value) => String(value) } }),
  ).credentialKeyGrammar()
  assert.equal(moved.state, 'changed')
  assert.equal(moved.value, null)
  assert.match(moved.detail, /accepted/)

  const absent = createKernelAdapter(ctxWith({})).credentialKeyGrammar()
  assert.equal(absent.state, 'absent')
})

test('the secret store generates the same key in all three grammar states', async () => {
  const hostId = 'h_1'
  const expected = 'dsh-remote-go/ssh-password-h-1'
  const states = [
    ['ok', healthyCtx()],
    ['absent', ctxWith({})],
    ['changed', ctxWith({ credentials: { ...fakeCredentials(), parseCredentialKey: () => 'anything' } })],
  ]
  for (const [label, ctx] of states) {
    const grammar = createKernelAdapter(ctx).credentialKeyGrammar()
    assert.equal(grammar.state, label, `the probe must report ${label} here (got ${grammar.state}: ${grammar.detail})`)
    assert.equal(passwordRecordKey(hostId), expected, `the key must not depend on the kernel (${label})`)
  }
  assert.equal(passwordRecordKey('h_1'), expected)
})

test('a changed grammar is reported once and never changes a saved key or blocks the write', async () => {
  const credentials = {
    ...fakeCredentials(),
    parseCredentialKey: () => 'anything',
  }
  const warnings = []
  const secrets = createSecretStore({
    ctx: ctxWith({ credentials }),
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  })
  assert.equal(secrets.available(), true)
  assert.equal(await secrets.set('h_1', 's3cret'), true, 'the local rule keeps addressing the record')
  assert.equal(await secrets.get('h_1'), 's3cret')
  assert.deepEqual([...credentials.records.keys()], ['dsh-remote-go/ssh-password-h-1'])
  assert.equal(warnings.length, 1, 'the degradation is reported once, not per operation')
  assert.match(warnings[0], /grammar changed/)
  // Later operations do not warn again.
  assert.equal(await secrets.get('h_1'), 's3cret')
  assert.equal(warnings.length, 1)
})

test('without a credential service nothing is stored and the probe says absent', async () => {
  const secrets = createSecretStore({ ctx: ctxWith({}), logger: { warn() {} } })
  assert.equal(secrets.available(), false)
  assert.equal(await secrets.set('h_1', 's3cret'), false)
  assert.equal(await secrets.get('h_1'), null)
})

// --- 5. the diagnostics table ---------------------------------------------------------------

test('probeReport names every probe and leaks neither values nor machine paths', () => {
  const report = createKernelAdapter(healthyCtx()).probeReport()
  assert.deepEqual(Object.keys(report), [
    'fiberEntry',
    'clientModuleGraph',
    'clientModuleRelease',
    'clientModuleRow',
    'clientPath',
    'requestRejection',
    'credentialService',
    'credentialKeyGrammar',
  ])
  for (const [name, entry] of Object.entries(report)) {
    assert.deepEqual(Object.keys(entry).sort(), ['detail', 'state'], `${name} carries state + detail only`)
    assert.ok(['ok', 'absent', 'changed'].includes(entry.state), `${name} state`)
    assert.equal(typeof entry.detail, 'string')
    assert.equal(entry.detail.includes('C:\\tmp'), false, `${name} leaked a machine path`)
  }
  assert.equal(report.fiberEntry.state, 'ok')
  assert.equal(report.clientPath.detail, 'resolved')
  assert.equal(report.requestRejection.state, 'ok')
})

test('probeReport turns every probe into absent on an empty kernel instead of throwing', () => {
  const report = createKernelAdapter({ get: () => undefined }).probeReport()
  for (const [name, entry] of Object.entries(report)) {
    assert.equal(entry.state, 'absent', `${name} must be absent, not changed: ${entry.detail}`)
  }
})

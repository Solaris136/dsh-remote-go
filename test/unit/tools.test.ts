import test from 'node:test'
import assert from 'node:assert/strict'
import { LIST_TOOL_NAME, REVEAL_TOOL_NAME, registerHostTools } from '../../dist/src/tools.js'
import { REPORT_TOOL_NAME } from '../../dist/src/tools-report.js'
import { EXEC_TOOL_NAME } from '../../dist/src/tools-exec.js'
import { errors, toErrorView } from '../../dist/src/errors.js'

// ---- fixtures ----------------------------------------------------------------------------------

const SECRET = 'hunter2-do-not-leak'
const TOKEN = 'tok_live_abcdefghijklmnop'
const KEY_PATH = '/home/dev/.ssh/id_ed25519'
const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG='

/** A HostView with credentials and fingerprints deliberately filled in: none may reach a result. */
function hostView(overrides = {}) {
  return {
    id: 'h_prod',
    name: 'prod',
    address: 'prod.example.com',
    username: 'dev',
    port: 2222,
    status: 'connected',
    phase: 'ready',
    progress: { code: 'ready' },
    error: null,
    warning: null,
    authType: 'key',
    authKeyPath: KEY_PATH,
    passwordSaved: true,
    password: SECRET,
    token: TOKEN,
    fingerprint: { sha256: FINGERPRINT, keyType: 'ssh-ed25519' },
    remote: { version: '0.2.2-rc.3', uiReady: true, localPort: 41234, token: TOKEN },
    keepAlive: 'keep',
    hostKeyPolicy: 'first-use',
    autoReconnect: true,
    lastOpenedAt: '2026-11-16T12:00:00.000Z',
    jumpHost: null,
    versionParity: { status: 'same' },
    ...overrides,
  }
}

/**
 * A fake host composition. `inject` behaves like cordis: it returns a *fiber* (not a disposer),
 * whose `dispose()` unloads the child effect, and it can deliver the injected context immediately
 * or later (`deferInject`), exactly as a parked fiber would.
 */
function makeHarness(options = {}) {
  const registered = new Map()
  const whens = new Map()
  const labels = []
  const logs = []
  const injects = []
  const fibers = []
  const cleanups = []
  const views = options.views ?? [hostView()]
  const service = {
    init: async () => {},
    snapshot: () => ({ hosts: views }),
    ...(options.service ?? {}),
  }
  const tools = {
    register(definition, registration = {}) {
      assert.equal(registered.has(definition.name), false, `duplicate tool ${definition.name}`)
      registered.set(definition.name, definition)
      if (typeof registration.when === 'function') whens.set(definition.name, registration.when)
      return () => {
        registered.delete(definition.name)
        whens.delete(definition.name)
      }
    },
  }
  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: (...args) => logs.push(['debug', ...args]),
  }
  const childCtx = {
    tools,
    effect(execute, label) {
      labels.push(label)
      const dispose = execute()
      cleanups.push(dispose)
      return () => dispose?.()
    },
  }
  const ctx = {
    get: (name) => (name === 'tools' && options.hideTools !== true ? tools : null),
    inject(names, callback) {
      injects.push(names)
      const fiber = {
        disposed: false,
        deliver: () => callback(childCtx),
        dispose() {
          fiber.disposed = true
          if (options.fiberDisposeThrows === true) throw new Error('fiber dispose failed')
          for (const run of cleanups.splice(0)) {
            try {
              run?.()
            } catch {
              // a real fiber tolerates one failing effect; the test only needs the next ones to run
            }
          }
        },
      }
      fibers.push(fiber)
      if (options.deferInject !== true) fiber.deliver()
      return fiber
    },
  }
  const dispose = registerHostTools(ctx, { service, logger })
  return {
    registered,
    whens,
    labels,
    logs,
    injects,
    fibers,
    service,
    logger,
    dispose,
    list: registered.get(LIST_TOOL_NAME),
    reveal: registered.get(REVEAL_TOOL_NAME),
  }
}

/**
 * Validate one result against the tool's declared `output.schema` the way the kernel does: required
 * fields present, declared types, no undeclared key and no `undefined` value. A mismatch here is a
 * runtime INVALID_TOOL_OUTPUT, so this catches it before a model ever sees a broken call.
 */
function assertMatchesSchema(schema, value, path = 'value') {
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`)
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`)
    for (const key of Object.keys(value)) {
      assert.notEqual(value[key], undefined, `${path}.${key} is undefined`)
      if (schema.additionalProperties === false) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key} is not declared in the schema`)
      }
      const child = schema.properties?.[key]
      if (child) assertMatchesSchema(child, value[key], `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`)
    for (const [index, item] of value.entries()) {
      if (schema.items) assertMatchesSchema(schema.items, item, `${path}[${index}]`)
    }
    return
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} must be a string`)
  else if (schema.type === 'integer') assert.ok(Number.isInteger(value), `${path} must be an integer`)
  else if (schema.type === 'number') assert.equal(typeof value, 'number', `${path} must be a number`)
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} must be a boolean`)
}

/**
 * The three tools the reveal entry unlocks. Every one of them is registered at mount behind a
 * `when` condition, so a session that never reveals never sees their schemas and cannot call them.
 */
const GATED_TOOLS = ['remote_hosts_list', 'remote_host_report', 'remote_exec']

/** The credentials, fingerprints and key material that must never appear in a result. */
const FORBIDDEN = [
  SECRET,
  TOKEN,
  KEY_PATH,
  FINGERPRINT,
  'SHA256',
  'PRIVATE KEY',
  '.ssh',
  'passwordSaved',
  'authKeyPath',
]

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value)
  for (const secret of FORBIDDEN) {
    assert.equal(serialized.includes(secret), false, `the result leaked ${secret}`)
  }
}

// ---- registration ------------------------------------------------------------------------------

test('the host list registers with a read-only contract and a working disposer', () => {
  const harness = makeHarness()
  assert.deepEqual([...harness.registered.keys()], [...GATED_TOOLS, REVEAL_TOOL_NAME])
  assert.deepEqual(harness.injects, [['tools']], 'registration goes through the injected service')
  assert.ok(harness.labels.includes('dsh-remote-go: model tools'))

  const definition = harness.list
  assert.match(definition.name, /^[a-z][a-z0-9_]{0,40}$/, 'a model-facing tool name is lower_snake_case')
  assert.notEqual(definition.name, 'run_code', 'run_code is reserved by DSH')
  assert.match(definition.description, /Read-only/i, 'the description must say the tool changes nothing')
  assert.match(definition.description, /no password, token, cookie, host fingerprint or private-key path/)
  assert.match(definition.description, /untrusted input/)
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(definition.parameters.properties), ['includeDisconnected'])
  assert.equal(definition.output.schema.type, 'object')
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(definition.timeoutMs, undefined, 'a body with no cancellable wait must not promise a timeout')
  assert.equal(definition.isConcurrencySafe(), true, 'the read-only tool may run in parallel')
  assert.ok(
    harness.logs.some((line) => line[0] === 'info' && /model tool registered: remote_hosts_list/.test(line[1])),
    'a startup log must say the tool is registered',
  )

  // `ctx.inject` hands back the fiber, so the returned disposer must dispose it — and it must not
  // throw, because `apply`'s cleanup runs the rest of the unload after this line.
  assert.equal(typeof harness.dispose, 'function')
  assert.doesNotThrow(() => harness.dispose())
  assert.equal(harness.fibers.length, 1)
  assert.equal(harness.fibers[0].disposed, true, 'the parked fiber must be disposed')
  assert.equal(harness.registered.size, 0, 'unloading the plugin must remove the tool')
})

test('a failed fiber disposal is contained and lets the rest of the unload run', () => {
  const harness = makeHarness({ fiberDisposeThrows: true })
  const order = []
  assert.equal(typeof harness.dispose, 'function')
  assert.doesNotThrow(() => {
    for (const step of [() => harness.dispose(), () => order.push('proxy'), () => order.push('api')]) step()
  })
  assert.deepEqual(order, ['proxy', 'api'], 'a failing disposer must not skip the remaining cleanup')
  assert.ok(
    harness.logs.some((line) => line[0] === 'warn' && /could not dispose the model tool fiber/.test(line[1])),
    'the failure is logged instead of swallowed',
  )
})

test('the tool is registered through ctx.inject even when the service is already live', () => {
  // A replaced `tools` service only reaches us through the fiber's re-apply; a one-shot
  // `ctx.get` fast path would leave the tool registered against the dead service.
  const harness = makeHarness()
  assert.deepEqual(harness.injects, [['tools']])
  assert.equal(harness.registered.size, 4, 'three gated tools plus the entry they are reached through')
})

test('a tools service that arrives later still gets the tool', () => {
  const harness = makeHarness({ hideTools: true, deferInject: true })
  assert.equal(harness.registered.size, 0, 'nothing registers while the service is absent')
  assert.ok(
    harness.logs.some((line) => line[0] === 'info' && /tools service is not ready yet/.test(line[1])),
    'the parked state is logged, not silent',
  )
  harness.fibers[0].deliver()
  assert.deepEqual(
    [...harness.registered.keys()],
    [...GATED_TOOLS, REVEAL_TOOL_NAME],
    'the parked fiber registers on arrival',
  )
  harness.dispose()
  assert.equal(harness.registered.size, 0)
})

test('a composition without ctx.inject falls back to the lookup', () => {
  const logs = []
  const service = { snapshot: () => ({ hosts: [] }) }
  const ctx = { get: () => null, effect: () => assert.fail('no effect without a tools service') }
  const dispose = registerHostTools(ctx, {
    service,
    logger: { info: (...a) => logs.push(a) },
  })
  assert.equal(logs.length, 1)
  assert.match(String(logs[0][0]), /no tools service/)
  assert.equal(typeof dispose, 'function', 'the caller still gets a disposer to call on unload')
  assert.doesNotThrow(() => dispose())

  // Service present: register directly against it, and the result is disposable too.
  const registered = new Map()
  const tools = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const direct = registerHostTools(
    {
      get: () => tools,
      effect(execute) {
        const run = execute()
        return () => run?.()
      },
    },
    { service, logger: { info() {}, warn() {} } },
  )
  assert.deepEqual([...registered.keys()], [...GATED_TOOLS, REVEAL_TOOL_NAME])
  direct()
  assert.equal(registered.size, 0)

  // A lookup that throws is the same "missing" case: never park the plugin on it.
  const throwing = registerHostTools(
    {
      get() {
        throw new Error('cannot get property "tools" without inject')
      },
      effect: () => assert.fail('a throwing lookup must not park the plugin'),
    },
    { service, logger: { info: (...a) => logs.push(a) } },
  )
  assert.match(String(logs[logs.length - 1][0]), /no tools service/)
  assert.doesNotThrow(() => throwing())
})

test('a kernel that refuses the definition costs the tool, never the plugin', () => {
  const warnings = []
  const ctx = {
    inject: (_names, callback) =>
      callback({
        tools: {
          register() {
            throw new TypeError('tool "remote_hosts_list" must declare output { schema, render }')
          },
        },
        effect: (execute) => execute(),
      }),
  }
  const fiber = registerHostTools(ctx, {
    service: { snapshot: () => ({ hosts: [] }) },
    logger: { warn: (...a) => warnings.push(a) },
  })
  assert.equal(warnings.length, 4, 'each refused definition is reported, and none stops the plugin')
  assert.ok(warnings.some((warning) => /could not register remote_hosts_list/.test(String(warning[0]))))
  assert.equal(typeof fiber, 'function')
})

test('an unregister that throws is contained like every other teardown failure', () => {
  const warnings = []
  const cleanups = []
  const ctx = {
    inject: (_names, callback) => {
      callback({
        tools: {
          register: () => () => {
            throw new Error('dispose failed')
          },
        },
        effect(execute) {
          const run = execute()
          cleanups.push(run)
          return () => run?.()
        },
      })
      return {
        dispose() {
          for (const run of cleanups.splice(0)) run?.()
        },
      }
    },
  }
  const dispose = registerHostTools(ctx, {
    service: { snapshot: () => ({ hosts: [] }) },
    logger: { warn: (...a) => warnings.push(a) },
  })
  assert.doesNotThrow(() => dispose())
  assert.ok(
    warnings.some((line) => /could not unregister a model tool/.test(String(line[0]))),
    'the teardown failure is logged instead of escaping',
  )
})

// ---- on-demand reveal ------------------------------------------------------------------------

test('all three tools are suspended behind one condition until the entry is called', async () => {
  const harness = makeHarness()
  const agentA = { id: 'agent_a' }
  const agentB = { id: 'agent_b' }
  assert.deepEqual(
    [...harness.registered.keys()],
    [...GATED_TOOLS, REVEAL_TOOL_NAME],
    'the definitions are registered up front: a `when` condition, not late registration, is the gate',
  )
  assert.equal(harness.whens.size, 3, 'one condition per suspended tool')
  assert.equal(harness.whens.has(REVEAL_TOOL_NAME), false, 'the entry itself is always offered')
  for (const name of GATED_TOOLS) {
    assert.equal(harness.whens.get(name)({ agent: agentA }), false, `${name} is hidden before the reveal`)
  }

  const first = await harness.reveal.execute({}, { agent: agentA })
  assert.equal(first.ok, true)
  assert.deepEqual(first.revealed, GATED_TOOLS)
  assert.deepEqual(first.available, [LIST_TOOL_NAME, REPORT_TOOL_NAME, EXEC_TOOL_NAME, REVEAL_TOOL_NAME])
  for (const name of GATED_TOOLS) {
    assert.equal(harness.whens.get(name)({ agent: agentA }), true, `${name} is admitted for the revealing agent`)
    assert.equal(harness.whens.get(name)({ agent: agentB }), false, 'another conversation stays hidden')
  }

  const second = await harness.reveal.execute({}, { agent: agentA })
  assert.deepEqual(second.revealed, GATED_TOOLS, 'the entry is idempotent')
  assert.equal(harness.registered.size, 4, 'and registers nothing twice')

  harness.dispose()
  assert.equal(harness.registered.size, 0, 'unloading removes every tool with the rest')
})

test('the reveal result renders and survives a hostile value', async () => {
  const harness = makeHarness()
  const value = await harness.reveal.execute({}, { agent: {} })
  const [block] = harness.reveal.output.render({}, value)
  assert.match(block.text, /已解锁 remote_hosts_list, remote_host_report, remote_exec/)
  for (const hostile of [undefined, null, {}, { ok: false, error: { code: 'X', message: 'boom' } }]) {
    const [fallback] = harness.reveal.output.render({}, hostile)
    assert.equal(fallback.type, 'text')
    assert.match(fallback.text, /\[dsh-remote-go\]/)
  }
})

// ---- output contract ---------------------------------------------------------------------------

test('render produces bounded text blocks and never throws on a hostile value', () => {
  const harness = makeHarness()
  const render = harness.list.output.render
  const hostile = {
    ok: true,
    get hosts() {
      throw new Error('boom')
    },
  }
  for (const value of [{ ok: false, error: { code: 'X', message: 'boom' } }, undefined, {}, null, hostile]) {
    const blocks = render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    for (const block of blocks) {
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.match(block.text, /\[dsh-remote-go\]/)
    }
  }
})

test('render lists one line per host and reports an empty list', () => {
  const harness = makeHarness()
  const result = {
    ok: true,
    hosts: [{ id: 'h_prod', label: 'prod', state: 'connected', connected: true }],
    count: 1,
    connected: 1,
  }
  const [block] = harness.list.output.render({}, result)
  assert.match(block.text, /1 台主机，已连接 1 台/)
  assert.match(block.text, /- prod · connected/)
  const empty = makeHarness({ views: [] })
  const [emptyBlock] = empty.list.output.render({}, { ok: true, hosts: [], count: 0, connected: 0 })
  assert.match(emptyBlock.text, /还没有配置远端主机/)
})

// ---- projection --------------------------------------------------------------------------------

test('the host list projects a whitelist and never echoes a credential', async () => {
  const harness = makeHarness()
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.connected, 1)
  const [row] = result.hosts
  assert.deepEqual(row, {
    id: 'h_prod',
    label: 'prod',
    state: 'connected',
    connected: true,
    address: 'prod.example.com',
    username: 'dev',
    port: 2222,
    progressCode: 'ready',
    remoteVersion: '0.2.2-rc.3',
  })
  assertNoSecrets(result)
})

test('the endpoint fields are projected, and a broken port is dropped instead of stringified', async () => {
  const harness = makeHarness({
    views: [
      hostView({ id: 'h_default', username: null, port: 22 }),
      hostView({ id: 'h_broken', username: '', port: 'not-a-port' }),
    ],
  })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  const [defaults, broken] = result.hosts
  assert.equal(defaults.port, 22, '22 is the default the entry carries, and it is still projected')
  assert.equal(defaults.username, undefined, 'no username means no field')
  assert.equal(broken.port, undefined, 'a non-integer port is dropped, not passed through')
  assert.equal(broken.username, undefined, 'an empty username is dropped')
  assertNoSecrets(result)
})

test('the render line names the endpoint the model would talk about', async () => {
  const harness = makeHarness()
  const [block] = harness.list.output.render({}, await harness.list.execute({}, {}))
  assert.match(block.text, /- prod · connected · dev@prod\.example\.com:2222/)
})

test('the host list filters disconnected hosts and counts what it returns', async () => {
  const views = [
    hostView(),
    hostView({
      id: 'h_idle',
      name: 'idle',
      address: 'idle.example.com',
      status: 'disconnected',
      phase: null,
      progress: null,
      authType: 'password',
      passwordSaved: false,
      remote: { version: null, uiReady: false },
      versionParity: { status: 'unknown' },
      error: { code: 'network', detail: { zh: '连不上', en: 'unreachable' } },
    }),
  ]
  const harness = makeHarness({ views })

  const all = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, all)
  assert.equal(all.count, 2)
  assert.equal(all.connected, 1, 'only the connected host counts as connected')

  const filtered = await harness.list.execute({ includeDisconnected: false }, {})
  assertMatchesSchema(harness.list.output.schema, filtered)
  assert.deepEqual(
    filtered.hosts.map((row) => row.id),
    ['h_prod'],
    'includeDisconnected: false keeps only the connected host',
  )

  const idle = all.hosts.find((row) => row.id === 'h_idle')
  assert.equal(idle.connected, false)
  assert.equal(idle.state, 'disconnected')
  assert.equal(idle.lastError, 'network: 连不上 / unreachable')
  assertNoSecrets(all)
})

test('a host with no readable id is dropped instead of producing a broken row', async () => {
  const harness = makeHarness({ views: [hostView({ id: '' }), hostView({ id: 'h_two', name: 'two' })] })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.deepEqual(
    result.hosts.map((row) => row.id),
    ['h_two'],
  )
})

test('the result is capped, stops projecting early and says so', async () => {
  const views = Array.from({ length: 5_000 }, (_unused, index) => hostView({ id: `h_${index}`, name: `host ${index}` }))
  const harness = makeHarness({ views })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.equal(result.count, 500, 'the cap keeps the result bounded')
  assert.equal(result.truncated, true)
  const [block] = harness.list.output.render({}, result)
  assert.match(block.text, /只列前 500 台/)

  const exactly = makeHarness({ views: views.slice(0, 500) })
  const complete = await exactly.list.execute({}, {})
  assert.equal(complete.count, 500)
  assert.equal(complete.truncated, undefined, 'a list that fits carries no truncation flag')
})

test('a connect failure never echoes a fingerprint or a private-key path', async () => {
  // The two failure shapes the pipeline really stores on the runtime: prompts.js builds the
  // first-use host-key prompt (120s timeout) and ssh.js the changed-key one, both from SHA256
  // fingerprints; an auth failure quotes the configured key file.
  const unknown = toErrorView(errors.hostKeyUnknown(FINGERPRINT))
  const changed = toErrorView(
    errors.hostKeyChanged('SHA256:pinnedpinnedpinnedpinnedpinnedpinned00=', 'SHA256:actualactualactualactualactual00='),
  )
  assert.ok(JSON.stringify(unknown).includes('SHA256:'), 'fixture: the raw ErrorView does carry the fingerprint')
  const harness = makeHarness({
    views: [
      hostView({ id: 'h_unknown', status: 'fingerprint-pending', error: unknown }),
      hostView({ id: 'h_changed', status: 'error', error: changed, remote: { version: null, uiReady: false } }),
      hostView({
        id: 'h_keypath',
        status: 'error',
        error: { code: 'auth', detail: { zh: '密钥 ~/.ssh/id_ed25519 无法读取。', en: `Cannot read ${KEY_PATH}.` } },
      }),
    ],
  })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('SHA256:'), false, 'no fingerprint material may survive')
  assert.equal(serialized.includes('.ssh'), false, 'no private-key path may survive')
  assertNoSecrets(result)
  // The line still says what happened — only the identifiers are gone.
  assert.match(result.hosts[0].lastError, /^host-key-unknown: /)
  assert.match(result.hosts[0].lastError, /<fingerprint redacted>/)
  assert.match(result.hosts[1].lastError, /^host-key-changed: /)
  assert.ok(
    result.hosts[1].lastError.match(/<fingerprint redacted>/g).length >= 2,
    'both the pinned and the actual fingerprint are redacted',
  )
  assert.match(result.hosts[2].lastError, /<private-key path>/)
})

test('redaction covers case, short tokens and key files outside .ssh', async () => {
  const harness = makeHarness({
    views: [
      hostView({
        id: 'h_case',
        address: 'box.example.com',
        error: {
          code: 'host-key-unknown',
          detail: {
            zh: '指纹 sha256:lowercaselowercaselowercase00=',
            en: 'fingerprint SHA256:abc and could not read D:\\keys\\prod.ppk: permission denied',
          },
        },
      }),
      hostView({ id: 'h_name', address: 'box.ssh.example.com', error: null }),
    ],
  })
  const result = await harness.list.execute({}, {})
  const [row] = result.hosts
  assert.equal(JSON.stringify(result).toLowerCase().includes('sha256:'), false, 'lowercase and short forms go too')
  assert.match(row.lastError, /<fingerprint redacted>/)
  assert.match(row.lastError, /<private-key path>/, 'a .pem outside .ssh is still a key file')
  // A host whose name merely contains `.ssh` is not a path and stays readable.
  assert.equal(result.hosts[1].address, 'box.ssh.example.com')
})

test('a 50 KB field cannot stall the host event loop', async () => {
  // `address` has no upstream length limit and the projection is synchronous, so a separator-free
  // 50 KB token used to cost seconds of regex backtracking.
  const long = `${FINGERPRINT} ${KEY_PATH} ${'a'.repeat(50_000)}`
  const harness = makeHarness({
    views: [hostView({ address: long, error: { code: 'network', detail: { zh: long, en: long } } })],
  })
  const started = performance.now()
  const result = await harness.list.execute({}, {})
  const elapsed = performance.now() - started
  assert.ok(elapsed < 100, `the projection took ${elapsed.toFixed(1)} ms for a 50 KB field`)
  assertMatchesSchema(harness.list.output.schema, result)
  assert.match(result.hosts[0].address, /^<fingerprint redacted> <private-key path>/, 'the identifiers are gone')
  assert.equal(JSON.stringify(result).includes('SHA256:'), false)
  assert.equal(JSON.stringify(result).includes('.ssh'), false)
})

test('long fields are truncated instead of returned whole', async () => {
  const long = 'x'.repeat(5_000)
  const harness = makeHarness({
    views: [hostView({ address: long, error: { code: 'network', detail: { zh: long, en: long } } })],
  })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.ok(result.hosts[0].address.length <= 200, 'the address is capped at 200 characters')
  assert.ok(result.hosts[0].address.endsWith('…'), 'a shortened field says so')
  assert.ok(result.hosts[0].lastError.length <= 410, 'the failure line is capped at one field plus its code')
})

test('planted regression: an extra projected field fails the whitelist check', () => {
  // The guard that protects every result: this is the shape a leaky projection would produce, so the
  // checker (and the row key assertion above) must reject it rather than pass it through.
  const harness = makeHarness()
  const leaky = {
    ok: true,
    hosts: [{ id: 'h_prod', label: 'prod', state: 'connected', connected: true, authKeyPath: KEY_PATH }],
    count: 1,
    connected: 1,
  }
  assert.throws(() => assertMatchesSchema(harness.list.output.schema, leaky), /authKeyPath is not declared/)
  assert.throws(() => assertNoSecrets(leaky), /leaked/)
})

// ---- faults ------------------------------------------------------------------------------------

test('a service failure becomes a structured error instead of a throw', async () => {
  const coded = makeHarness({
    service: {
      snapshot() {
        throw errors.invalidInput('state', { zh: '状态不可读。', en: 'The state is unreadable.' })
      },
    },
  })
  const first = await coded.list.execute({}, {})
  assertMatchesSchema(coded.list.output.schema, first)
  assert.equal(first.ok, false)
  assert.equal(first.error.code, 'INVALID_INPUT')
  assert.match(first.error.message, /状态不可读/)
  assert.ok(
    coded.logs.some((line) => line[0] === 'error'),
    'a failure is logged at error level',
  )

  const crash = makeHarness({
    service: {
      snapshot() {
        throw new Error(`socket hang up while reading ${KEY_PATH} (${FINGERPRINT})`)
      },
    },
  })
  const second = await crash.list.execute({}, {})
  assertMatchesSchema(crash.list.output.schema, second)
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'INTERNAL')
  assert.match(second.error.message, /socket hang up/)
  assert.equal(second.error.retryable, true)
  assertNoSecrets(second)
})

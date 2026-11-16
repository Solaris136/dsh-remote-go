import test from 'node:test'
import assert from 'node:assert/strict'
import { LIST_TOOL_NAME, registerHostTools } from '../../src/tools.js'
import { errors } from '../../src/errors.js'

// ---- fixtures ----------------------------------------------------------------------------------

const SECRET = 'hunter2-do-not-leak'
const TOKEN = 'tok_live_abcdefghijklmnop'
const KEY_PATH = '/home/dev/.ssh/id_ed25519'
const FINGERPRINT = 'SHA256:deadbeefdeadbeef'

/** A HostView with credentials and fingerprints deliberately filled in: none may reach a result. */
function hostView(overrides = {}) {
  return {
    id: 'h_prod',
    name: 'prod',
    address: 'prod.example.com',
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

/** A fake host composition: `register`/`effect` behave like cordis (the effect runs now). */
function makeHarness(options = {}) {
  const registered = new Map()
  const labels = []
  const logs = []
  const views = options.views ?? [hostView()]
  const service = {
    init: async () => {},
    snapshot: () => ({ hosts: views }),
    ...(options.service ?? {}),
  }
  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: (...args) => logs.push(['debug', ...args]),
  }
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(registered.has(definition.name), false, `duplicate tool ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    effect(execute, label) {
      labels.push(label)
      const dispose = execute()
      return () => dispose?.()
    },
  }
  const dispose = registerHostTools(ctx, { service, logger })
  return { registered, labels, logs, views, service, logger, dispose, list: registered.get(LIST_TOOL_NAME) }
}

// ---- output contract ---------------------------------------------------------------------------

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

/** The credentials and key material that must never appear in a result. */
const FORBIDDEN = [SECRET, TOKEN, KEY_PATH, FINGERPRINT, 'PRIVATE KEY', '.ssh', 'passwordSaved', 'authKeyPath']

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value)
  for (const secret of FORBIDDEN) {
    assert.equal(serialized.includes(secret), false, `the result leaked ${secret}`)
  }
}

// ---- registration ------------------------------------------------------------------------------

test('the host list registers with a read-only contract and a working disposer', () => {
  const harness = makeHarness()
  assert.deepEqual([...harness.registered.keys()], [LIST_TOOL_NAME])
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
  assert.ok(definition.timeoutMs >= 5_000 && definition.timeoutMs <= 8_000, 'the timeout stays in the 5-8s budget')
  assert.equal(definition.isConcurrencySafe(), true, 'the read-only tool may run in parallel')
  assert.equal(definition.isConcurrencySafe({ includeDisconnected: false }), true)

  harness.dispose()
  assert.equal(harness.registered.size, 0, 'unloading the plugin must remove the tool')
  assert.equal(harness.registered.get(LIST_TOOL_NAME), undefined)
})

test('render produces bounded text blocks and never throws on a failure value', () => {
  const harness = makeHarness()
  const render = harness.list.output.render
  for (const value of [
    { ok: false, error: { code: 'X', message: 'boom' } },
    undefined,
    {},
    null,
    { ok: true, hosts: [] },
  ]) {
    const blocks = render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    for (const block of blocks) {
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.match(block.text, /\[dsh-remote-go\]/)
    }
  }
})

test('render never throws, even for a value whose fields explode', () => {
  const harness = makeHarness()
  const hostile = {
    ok: true,
    get hosts() {
      throw new Error('boom')
    },
  }
  const [block] = harness.list.output.render({}, hostile)
  assert.equal(block.type, 'text')
  assert.match(block.text, /结果无法渲染/)
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
    progressCode: 'ready',
    remoteVersion: '0.2.2-rc.3',
  })
  assertNoSecrets(result)
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
  assert.throws(
    () => assertMatchesSchema(harness.list.output.schema, leaky),
    /authKeyPath is not declared in the schema/,
  )
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
        throw new Error('store is unreadable')
      },
    },
  })
  const second = await crash.list.execute({}, {})
  assertMatchesSchema(crash.list.output.schema, second)
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'INTERNAL')
  assert.match(second.error.message, /store is unreadable/)
  assert.equal(second.error.retryable, true)
  assertNoSecrets(second)
})

test('a kernel that refuses the definition costs the tool, never the plugin', () => {
  const warnings = []
  const ctx = {
    tools: {
      register() {
        throw new TypeError('tool "remote_hosts_list" must declare output { schema, render }')
      },
    },
    effect(execute) {
      const dispose = execute()
      return () => dispose?.()
    },
  }
  const dispose = registerHostTools(ctx, {
    service: { snapshot: () => ({ hosts: [] }) },
    logger: { warn: (...args) => warnings.push(args) },
  })
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /could not register remote_hosts_list/)
  dispose()
})

test('a disposer that throws is contained instead of breaking the unload', () => {
  const warnings = []
  const ctx = {
    tools: {
      register: () => () => {
        throw new Error('dispose failed')
      },
    },
    effect(execute) {
      const dispose = execute()
      return () => dispose?.()
    },
  }
  const dispose = registerHostTools(ctx, {
    service: { snapshot: () => ({ hosts: [] }) },
    logger: { warn: (...args) => warnings.push(args) },
  })
  assert.doesNotThrow(() => dispose())
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /could not unregister remote_hosts_list/)
})

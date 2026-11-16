import test from 'node:test'
import assert from 'node:assert/strict'
import { LIST_TOOL_NAME, MANAGE_TOOL_NAME, registerHostTools } from '../../src/tools.js'
import { errors } from '../../src/errors.js'

// ---- fixtures ----------------------------------------------------------------------------------

const SECRET = 'hunter2-do-not-leak'
const TOKEN = 'tok_live_abcdefghijklmnop'
const KEY_PATH = '/home/dev/.ssh/id_ed25519'
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'

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
    fingerprint: { sha256: 'SHA256:deadbeefdeadbeef', keyType: 'ssh-ed25519' },
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

/** A stored host entry, also carrying material the tool must never echo. */
function hostEntry(overrides = {}) {
  return {
    id: 'h_prod',
    name: 'prod',
    address: 'prod.example.com',
    port: 2222,
    username: 'dev',
    auth: { type: 'key', keyPath: KEY_PATH },
    jumpHost: null,
    keepAlive: 'keep',
    password: SECRET,
    token: TOKEN,
    privateKey: PRIVATE_KEY,
    ...overrides,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A fake host composition: `register`/`effect` behave like cordis (the effect runs now and returns
 * its disposer), and the fake service records every call without touching a real SSH connection.
 */
function makeHarness(options = {}) {
  const calls = []
  const registered = new Map()
  const labels = []
  const logs = []
  const views = options.views ?? [hostView()]
  const entries = options.entries ?? [hostEntry()]
  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: (...args) => logs.push(['debug', ...args]),
  }
  // `init()` only loads hosts.json; it is not a change, so the call log stays a log of writes.
  const service = {
    init: async () => {},
    snapshot: () => ({ hosts: views }),
    runtimes: new Map(),
    async saveHost(entry) {
      calls.push({ method: 'saveHost', entry })
      return { id: entry.id ?? 'h_new', name: entry.name }
    },
    async removeHost(id) {
      calls.push({ method: 'removeHost', id })
      return { ok: true }
    },
    async disconnect(id, disconnectOptions) {
      calls.push({ method: 'disconnect', id, options: disconnectOptions })
      return { ok: true }
    },
    async connect(id) {
      calls.push({ method: 'connect', id })
      if (options.connectDelayMs) await sleep(options.connectDelayMs)
      const view = views.find((item) => item.id === id)
      if (view) view.status = options.connectStatus ?? 'connected'
      const runtime = service.runtimes.get(id)
      if (runtime) runtime.connectPromise = Promise.resolve()
      return {
        accepted: options.connectAccepted ?? true,
        ...(options.connectReason ? { reason: options.connectReason } : {}),
      }
    },
    async reconnect(id) {
      calls.push({ method: 'reconnect', id })
      const view = views.find((item) => item.id === id)
      if (view) view.status = options.connectStatus ?? 'connected'
      const runtime = service.runtimes.get(id)
      if (runtime) runtime.connectPromise = Promise.resolve()
      return { accepted: options.connectAccepted ?? true }
    },
    ...(options.service ?? {}),
  }
  for (const view of views) service.runtimes.set(view.id, { connectPromise: null })
  const store = {
    listHosts: () => entries,
    getHost: (id) => entries.find((entry) => entry.id === id) ?? null,
    ...(options.store ?? {}),
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
    get(name) {
      return name === 'jobs' ? (options.jobs ?? null) : null
    },
  }
  const dispose = registerHostTools(ctx, { service, store, logger, getJobs: () => options.jobs ?? null })
  return {
    calls,
    registered,
    labels,
    logs,
    views,
    entries,
    service,
    dispose,
    list: registered.get(LIST_TOOL_NAME),
    manage: registered.get(MANAGE_TOOL_NAME),
  }
}

/** A jobs service stub: `run(handle)` runs synchronously, exactly like the real registry. */
function fakeJobs() {
  const specs = []
  const runs = []
  return {
    specs,
    runs,
    start(spec) {
      const id = `job_${specs.length + 1}`
      const lines = []
      const handle = { id, append: (text) => lines.push(text), updateProgress: () => {}, lines }
      specs.push(spec)
      runs.push({ handle, hooks: spec.run(handle) })
      return id
    },
  }
}

const EXEC = { agent: { session: { id: 'sess_1' } } }

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

function assertTextBlocks(blocks) {
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render must return at least one content block')
  for (const block of blocks) {
    assert.equal(block.type, 'text')
    assert.equal(typeof block.text, 'string')
    assert.ok(block.text.length > 0)
    assert.match(block.text, /\[dsh-remote-go\]/)
  }
}

// ---- registration ------------------------------------------------------------------------------

test('both tools register with a complete output contract and a working disposer', () => {
  const harness = makeHarness()
  assert.deepEqual([...harness.registered.keys()].sort(), [LIST_TOOL_NAME, MANAGE_TOOL_NAME].sort())
  assert.ok(harness.labels.includes('dsh-remote-go: model tools'))

  for (const [name, definition] of harness.registered) {
    assert.match(name, /^[a-z][a-z0-9_]{0,40}$/, 'a model-facing tool name is lower_snake_case')
    assert.notEqual(name, 'run_code', 'run_code is reserved by DSH')
    assert.equal(typeof definition.description, 'string')
    assert.match(definition.description, /never|not accepted|不含/, 'the description must state the projection rule')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
    assert.ok(definition.output.schema.additionalProperties === false)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.ok(definition.timeoutMs > 0 && definition.timeoutMs <= 120_000)
  }
  assert.equal(harness.list.isConcurrencySafe(), true, 'the read-only tool may run in parallel')
  assert.equal(harness.manage.isConcurrencySafe, undefined, 'a mutating tool stays exclusive')
  assert.ok(harness.manage.parameters.properties.action.enum.includes('connect'))

  harness.dispose()
  assert.equal(harness.registered.size, 0, 'unloading the plugin must remove both tools')
  assert.equal(harness.registered.get(LIST_TOOL_NAME), undefined)
  assert.equal(harness.registered.get(MANAGE_TOOL_NAME), undefined)
})

test('render produces bounded text blocks and never throws on a failure value', () => {
  const harness = makeHarness()
  for (const definition of harness.registered.values()) {
    assertTextBlocks(definition.output.render({}, { ok: false, error: { code: 'X', message: 'boom' } }))
    assertTextBlocks(definition.output.render({}, undefined))
    assertTextBlocks(definition.output.render(undefined, {}))
  }
})

test('a tool the kernel refuses costs that tool, never the plugin', () => {
  const context = []
  const warnings = []
  const ctx = {
    tools: {
      register(definition) {
        if (definition.name === MANAGE_TOOL_NAME) throw new TypeError('tool name is taken')
        context.push(definition.name)
        return () => context.splice(context.indexOf(definition.name), 1)
      },
    },
    effect(execute, label) {
      const dispose = execute()
      return () => dispose?.()
    },
  }
  const dispose = registerHostTools(ctx, {
    service: { snapshot: () => ({ hosts: [] }) },
    logger: { warn: (...args) => warnings.push(args) },
  })
  assert.deepEqual(context, [LIST_TOOL_NAME], 'the tool that registered keeps working')
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), new RegExp(MANAGE_TOOL_NAME))
  dispose()
  assert.deepEqual(context, [])
})

// ---- remote_hosts_list -------------------------------------------------------------------------

test('remote_hosts_list projects a whitelist and never echoes a credential', async () => {
  const harness = makeHarness()
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.connected, 1)
  const [row] = result.hosts
  assert.deepEqual(Object.keys(row).sort(), [
    'address',
    'connected',
    'id',
    'label',
    'port',
    'progressCode',
    'remoteVersion',
    'state',
    'user',
  ])
  assert.deepEqual(row, {
    id: 'h_prod',
    label: 'prod',
    state: 'connected',
    connected: true,
    address: 'prod.example.com',
    user: 'dev',
    port: 2222,
    progressCode: 'ready',
    remoteVersion: '0.2.2-rc.3',
  })
  const serialized = JSON.stringify(result)
  for (const secret of [SECRET, TOKEN, KEY_PATH, 'PRIVATE KEY', 'SHA256:deadbeef']) {
    assert.equal(serialized.includes(secret), false, `the result leaked ${secret}`)
  }
  assert.equal(serialized.includes('.ssh'), false, 'no ~/.ssh path may leave the tool')
  assertTextBlocks(harness.list.output.render({}, result))
})

test('remote_hosts_list filters disconnected hosts and adds details on request', async () => {
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
  const entries = [hostEntry(), hostEntry({ id: 'h_idle', name: 'idle', port: 22, username: 'ops' })]
  const harness = makeHarness({ views, entries })

  const filtered = await harness.list.execute({ includeDisconnected: false }, {})
  assertMatchesSchema(harness.list.output.schema, filtered)
  assert.deepEqual(
    filtered.hosts.map((row) => row.id),
    ['h_prod'],
    'includeDisconnected: false keeps only the connected host',
  )

  const detailed = await harness.list.execute({ includeDetails: true }, {})
  assertMatchesSchema(harness.list.output.schema, detailed)
  assert.equal(detailed.count, 2)
  const idle = detailed.hosts.find((row) => row.id === 'h_idle')
  assert.equal(idle.connected, false)
  assert.equal(idle.state, 'disconnected')
  assert.equal(idle.authType, 'password')
  assert.equal(idle.passwordSaved, false)
  assert.equal(idle.hostKeyPolicy, 'first-use')
  assert.equal(idle.versionParity, 'unknown')
  assert.equal(idle.lastError, 'network: 连不上 / unreachable')
  const serialized = JSON.stringify(detailed)
  assert.equal(serialized.includes(KEY_PATH), false)
  assert.equal(serialized.includes('authKeyPath'), false)
})

test('remote_hosts_list survives a store that cannot be listed', async () => {
  const harness = makeHarness({
    store: {
      listHosts() {
        throw new Error('hosts.json is unreadable')
      },
    },
  })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.equal(result.ok, true, 'the live rows still come from the service snapshot')
  assert.equal(result.count, 1)
  assert.equal(result.hosts[0].user, undefined, 'an unreadable store leaves the optional fields out')
})

test('remote_hosts_list reports a snapshot failure as a structured error', async () => {
  const harness = makeHarness({
    service: {
      snapshot() {
        throw errors.invalidInput('state', { zh: '状态不可读。', en: 'The state is unreadable.' })
      },
    },
  })
  const result = await harness.list.execute({}, {})
  assertMatchesSchema(harness.list.output.schema, result)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_INPUT')
  assert.match(result.error.message, /状态不可读/)
})

// ---- confirmation gate -------------------------------------------------------------------------

const UNCONFIRMED = [
  ['add', { host: { address: 'new.example.com' } }],
  ['update', { hostId: 'h_prod', host: { name: 'renamed' } }],
  ['remove', { hostId: 'h_prod' }],
  ['connect', { hostId: 'h_prod' }],
  ['disconnect', { hostId: 'h_prod' }],
  ['reconnect', { hostId: 'h_prod' }],
]

test('every action defaults to a plan with CONFIRMATION_REQUIRED and writes nothing', async () => {
  for (const [action, extra] of UNCONFIRMED) {
    const harness = makeHarness()
    const result = await harness.manage.execute({ action, ...extra }, EXEC)
    assertMatchesSchema(harness.manage.output.schema, result)
    assert.equal(result.ok, false, `${action} must not run without confirmation`)
    assert.equal(result.error.code, 'CONFIRMATION_REQUIRED')
    assert.equal(result.error.retryable, false)
    assert.match(result.error.hint, /confirm:true/)
    assert.equal(result.planned.action, action)
    assert.ok(result.planned.summary.length > 0, `${action} must say what it would do`)
    assert.deepEqual(harness.calls, [], `${action} must not call the service`)
    assertTextBlocks(harness.manage.output.render({ action }, result))
  }
})

test('dryRun wins over confirm and still only describes the plan', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute({ action: 'remove', hostId: 'h_prod', confirm: true, dryRun: true }, EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CONFIRMATION_REQUIRED')
  assert.match(result.error.message, /dryRun/)
  assert.deepEqual(harness.calls, [])
})

test('a non-boolean confirm is not a confirmation', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute({ action: 'remove', hostId: 'h_prod', confirm: 'true' }, EXEC)
  assert.equal(result.error.code, 'CONFIRMATION_REQUIRED')
  assert.deepEqual(harness.calls, [])
})

// ---- confirmed changes -------------------------------------------------------------------------

test('a confirmed add maps the caller fields onto the store shape', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute(
    {
      action: 'add',
      confirm: true,
      host: {
        name: 'staging',
        address: '10.0.0.9',
        port: 2200,
        user: 'ops',
        authMethod: 'key',
        identityFile: '/home/dev/.ssh/staging',
        keepAlive: 'idle',
      },
    },
    EXEC,
  )
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'add')
  assert.equal(harness.calls.length, 1)
  const [{ method, entry }] = harness.calls
  assert.equal(method, 'saveHost')
  assert.deepEqual(entry, {
    name: 'staging',
    address: '10.0.0.9',
    port: 2200,
    username: 'ops',
    auth: { type: 'key', keyPath: '/home/dev/.ssh/staging' },
    keepAlive: 'idle',
  })
  assert.equal(
    JSON.stringify(result).includes('/home/dev/.ssh/staging'),
    false,
    'the key path must not come back in the result',
  )
  assertTextBlocks(harness.manage.output.render({ action: 'add' }, result))
})

test('a confirmed update sends the stored entry back with the change applied', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute(
    { action: 'update', hostId: 'h_prod', confirm: true, host: { port: 2022, name: 'prod-2' } },
    EXEC,
  )
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(harness.calls.length, 1)
  const [{ method, entry }] = harness.calls
  assert.equal(method, 'saveHost')
  assert.equal(entry.id, 'h_prod')
  assert.equal(entry.port, 2022)
  assert.equal(entry.name, 'prod-2')
  // Everything the store's sanitizer would otherwise lose from the entry comes back unchanged.
  assert.equal(entry.address, 'prod.example.com')
  assert.equal(entry.username, 'dev')
  assert.deepEqual(entry.auth, { type: 'key', keyPath: KEY_PATH })
  assert.equal(entry.keepAlive, 'keep')
})

test('a confirmed remove deletes the host and reports it', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute({ action: 'remove', hostId: 'h_prod', confirm: true }, EXEC)
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'removed')
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ['removeHost'],
  )
  assert.equal(harness.calls[0].id, 'h_prod')
})

test('a confirmed disconnect reports whether it was connected', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute({ action: 'disconnect', hostId: 'h_prod', confirm: true }, EXEC)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'disconnected')
  assert.deepEqual(harness.calls, [{ method: 'disconnect', id: 'h_prod', options: {} }])

  const idle = makeHarness({ views: [hostView({ status: 'disconnected', remote: { uiReady: false } })] })
  const idleResult = await idle.manage.execute({ action: 'disconnect', hostId: 'h_prod', confirm: true }, EXEC)
  assert.equal(idleResult.ok, true)
  assert.equal(idleResult.state, 'unchanged')
})

test('an unknown host id is refused before any service call', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute({ action: 'remove', hostId: 'h_missing', confirm: true }, EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'HOST_NOT_FOUND')
  assert.deepEqual(harness.calls, [])
})

// ---- secrets -----------------------------------------------------------------------------------

test('a credential in the arguments is refused, whatever field carries it', async () => {
  const cases = [
    { action: 'add', host: { address: 'x.example.com', password: SECRET } },
    { action: 'add', host: { address: 'x.example.com', privateKey: PRIVATE_KEY } },
    { action: 'add', host: { address: 'x.example.com', token: TOKEN } },
    { action: 'update', hostId: 'h_prod', host: { name: 'x', passphrase: SECRET } },
    { action: 'add', host: { address: 'x.example.com', name: '-----BEGIN OPENSSH PRIVATE KEY----- AA' } },
  ]
  for (const args of cases) {
    const harness = makeHarness()
    const result = await harness.manage.execute({ ...args, confirm: true }, EXEC)
    assertMatchesSchema(harness.manage.output.schema, result)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'SECRET_NOT_ACCEPTED', JSON.stringify(args))
    assert.equal(result.error.retryable, false)
    assert.deepEqual(harness.calls, [])
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(SECRET), false)
    assert.equal(serialized.includes(TOKEN), false)
  }
})

test('a password-authenticated host is delegated to the host manager', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute(
    { action: 'add', confirm: true, host: { address: 'pw.example.com', authMethod: 'password' } },
    EXEC,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SECRET_NOT_ACCEPTED')
  assert.match(result.error.hint, /管理界面|host manager/)
  assert.deepEqual(harness.calls, [])

  // An existing password host keeps working when its password is already in the credential store.
  const saved = makeHarness({ views: [hostView({ authType: 'password', passwordSaved: true })] })
  const kept = await saved.manage.execute(
    { action: 'update', hostId: 'h_prod', confirm: true, host: { authMethod: 'password', name: 'still-pw' } },
    EXEC,
  )
  assert.equal(kept.ok, true)
  assert.equal(saved.calls.length, 1)
})

test('an unsupported argument or field is refused with the accepted list', async () => {
  const harness = makeHarness()
  const unknownArgument = await harness.manage.execute({ action: 'connect', hostId: 'h_prod', force: true }, EXEC)
  assert.equal(unknownArgument.error.code, 'INVALID_ARGUMENTS')
  assert.match(unknownArgument.error.hint, /action/)
  const unknownField = await harness.manage.execute(
    { action: 'add', host: { address: 'x.example.com', colour: 'red' } },
    EXEC,
  )
  assert.equal(unknownField.error.code, 'INVALID_ARGUMENTS')
  assert.match(unknownField.error.hint, /address/)
  const badAction = await harness.manage.execute({ action: 'restart_host', hostId: 'h_prod' }, EXEC)
  assert.equal(badAction.error.code, 'INVALID_ARGUMENTS')
  assert.match(badAction.error.message, /add \/ update/)
  const missing = await harness.manage.execute({ action: 'connect' }, EXEC)
  assert.equal(missing.error.code, 'INVALID_ARGUMENTS')
  const notAnObject = await harness.manage.execute({ action: 'add', host: 'x.example.com' }, EXEC)
  assert.equal(notAnObject.error.code, 'INVALID_ARGUMENTS')
  assert.deepEqual(harness.calls, [])
})

// ---- jobs --------------------------------------------------------------------------------------

test('connect returns a job id when jobs exist and the producer settles it later', async () => {
  const jobs = fakeJobs()
  const harness = makeHarness({ jobs, connectDelayMs: 10 })
  const result = await harness.manage.execute({ action: 'connect', hostId: 'h_prod', confirm: true }, EXEC)
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'pending')
  assert.equal(result.jobId, 'job_1')
  assert.match(result.hint, /job_output/)
  assert.equal(jobs.specs.length, 1)
  assert.equal(jobs.specs[0].kind, 'dsh-remote-go-connect')
  assert.equal(jobs.specs[0].label, 'connect prod')
  assert.equal(jobs.specs[0].owner, 'sess_1')
  assertTextBlocks(harness.manage.output.render({ action: 'connect' }, result))

  const [{ handle, hooks }] = jobs.runs
  assert.deepEqual(await hooks.done, { status: 'completed' })
  assert.ok(harness.calls.some((call) => call.method === 'connect'))
  assert.equal(harness.views[0].status, 'connected')
  assert.ok(handle.lines.length >= 2, 'the job output must say what it is doing')
  assert.equal(typeof hooks.cancel, 'function')
  await hooks.cancel()
  assert.ok(
    harness.calls.some((call) => call.method === 'disconnect'),
    'a killed job drops the link',
  )
})

test('reconnect uses the reconnect path and reports a failed attempt through the job', async () => {
  const jobs = fakeJobs()
  const harness = makeHarness({
    jobs,
    connectStatus: 'error',
    views: [
      hostView({
        status: 'disconnected',
        error: { code: 'network', detail: { zh: '连不上', en: 'unreachable' } },
        remote: { uiReady: false },
      }),
    ],
  })
  const result = await harness.manage.execute({ action: 'reconnect', hostId: 'h_prod', confirm: true }, EXEC)
  assert.equal(result.state, 'pending')
  assert.equal(jobs.specs[0].kind, 'dsh-remote-go-reconnect')
  const [{ hooks }] = jobs.runs
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /network/)
  assert.ok(harness.calls.some((call) => call.method === 'reconnect'))
  assert.equal(
    harness.calls.some((call) => call.method === 'connect'),
    false,
  )
})

test('a jobs service that cannot start a job is a structured JOB_START_FAILED', async () => {
  const jobs = {
    start() {
      throw new Error('background job limit reached for this owner')
    },
  }
  const harness = makeHarness({ jobs })
  const result = await harness.manage.execute({ action: 'connect', hostId: 'h_prod', confirm: true }, EXEC)
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'JOB_START_FAILED')
  assert.match(result.error.hint, /job_list/)
  assert.deepEqual(harness.calls, [], 'a refused job must not also run in the foreground')
})

test('connect falls back to the foreground when the jobs service is absent', async () => {
  const harness = makeHarness()
  const result = await harness.manage.execute({ action: 'connect', hostId: 'h_prod', confirm: true }, EXEC)
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'connected')
  assert.equal(result.jobId, undefined)
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ['connect'],
  )
})

test('a failed connect is a structured CONNECT_FAILED with the host row', async () => {
  const harness = makeHarness({
    connectStatus: 'error',
    views: [
      hostView({
        status: 'disconnected',
        error: { code: 'auth', detail: { zh: '认证没过', en: 'authentication failed' } },
        remote: { uiReady: false },
      }),
    ],
  })
  const result = await harness.manage.execute({ action: 'connect', hostId: 'h_prod', confirm: true }, EXEC)
  assertMatchesSchema(harness.manage.output.schema, result)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CONNECT_FAILED')
  assert.match(result.error.message, /auth/)
  assert.equal(result.host.id, 'h_prod')
  assert.equal(result.state, 'error')
})

test('a service that refuses to start reports the state instead of pretending', async () => {
  const harness = makeHarness({ connectAccepted: false, connectReason: 'already-connected' })
  const result = await harness.manage.execute({ action: 'connect', hostId: 'h_prod', confirm: true }, EXEC)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'connected')
  assert.match(result.message, /已经连接/)

  const connecting = makeHarness({ connectAccepted: false, connectReason: 'already-connecting' })
  const pending = await connecting.manage.execute({ action: 'connect', hostId: 'h_prod', confirm: true }, EXEC)
  assert.equal(pending.ok, true)
  assert.equal(pending.state, 'connecting')
  assert.match(pending.message, /progressCode/)
})

// ---- faults ------------------------------------------------------------------------------------

test('a service failure becomes a structured error instead of a throw', async () => {
  const remoteGoFault = makeHarness({
    service: {
      async saveHost() {
        throw errors.invalidInput('address', { zh: '地址格式不正确。', en: 'The address is not valid.' })
      },
    },
  })
  const first = await remoteGoFault.manage.execute(
    { action: 'add', confirm: true, host: { address: 'x.example.com' } },
    EXEC,
  )
  assertMatchesSchema(remoteGoFault.manage.output.schema, first)
  assert.equal(first.ok, false)
  assert.equal(first.error.code, 'INVALID_INPUT')
  assert.match(first.error.message, /地址格式不正确/)

  const crash = makeHarness({
    service: {
      async saveHost() {
        throw new Error('socket hang up')
      },
    },
  })
  const second = await crash.manage.execute({ action: 'add', confirm: true, host: { address: 'x.example.com' } }, EXEC)
  assertMatchesSchema(crash.manage.output.schema, second)
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'INTERNAL')
  assert.match(second.error.message, /socket hang up/)
  assert.equal(second.error.retryable, true)
  assert.ok(
    crash.logs.some((line) => line[0] === 'error'),
    'an unexpected fault is logged at error level',
  )
})

test('the tool log lines never carry a credential from the request', async () => {
  const harness = makeHarness()
  await harness.manage.execute({ action: 'add', confirm: true, host: { address: 'x.example.com', name: 'x' } }, EXEC)
  await harness.manage.execute(
    { action: 'add', confirm: true, host: { address: 'y.example.com', password: SECRET } },
    EXEC,
  )
  assert.ok(harness.logs.length > 0, 'a successful change is logged')
  for (const line of harness.logs) assert.equal(line.join(' ').includes(SECRET), false)
})

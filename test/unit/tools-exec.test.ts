import test from 'node:test'
import assert from 'node:assert/strict'
import { EXEC_TOOL_NAME, execTool } from '../../dist/src/tools-exec.js'
import { errors } from '../../dist/src/errors.js'

// ---- fixtures ----------------------------------------------------------------------------------

const HOST_ID = 'h_prod'

/** One `SshExecResult`-shaped frame: exactly the fields the port contract returns. */
function frame(overrides = {}) {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

/**
 * A fake composition: one connected host inside a real Map (the same live registry the host half
 * writes), a snapshot that names it, and an `exec` that records every call it receives.
 */
function makeHarness(options = {}) {
  const calls = []
  const logs = []
  const behaviour = options.exec ?? (async () => options.frame ?? frame({ stdout: 'ok' }))
  const exec = async (command, execOptions) => {
    calls.push({ command, ...execOptions })
    return behaviour(command, execOptions)
  }
  const runtime = options.runtime ?? { id: HOST_ID, status: 'connected', ssh: { connected: true, exec } }
  const runtimes = new Map()
  if (options.register !== false) runtimes.set(HOST_ID, runtime)
  const service = {
    init: async () => {},
    snapshot: () => ({ hosts: [{ id: HOST_ID, name: 'prod', status: 'connected' }] }),
    runtimes,
  }
  const tool = execTool({ service, logger: { error: (...args) => logs.push(args) }, ...(options.toolOptions ?? {}) })
  return { tool, calls, logs, runtimes, service }
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

// ---- read mode ---------------------------------------------------------------------------------

test('read mode runs an allowlisted command and forwards the deadline and the signal', async () => {
  const harness = makeHarness({ frame: frame({ code: 0, stdout: 'total 0\n' }) })
  const controller = new AbortController()
  const result = await harness.tool.execute(
    { id: HOST_ID, command: 'ls -la', timeoutMs: 12345 },
    { signal: controller.signal },
  )

  assert.equal(EXEC_TOOL_NAME, 'remote_exec')
  assertMatchesSchema(harness.tool.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'read')
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'total 0\n')
  assert.equal(result.stderr, '')
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.host, { id: HOST_ID, label: 'prod' })
  assert.equal(result.command, 'ls -la')
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].command, 'ls -la')
  assert.equal(harness.calls[0].timeoutMs, 12345, 'the call deadline is forwarded to the port')
  assert.equal(harness.calls[0].maxBytes, 2 * 1024 * 1024, 'the transport cap is the port default')
  assert.equal(harness.calls[0].signal, controller.signal, 'the kernel signal is forwarded')
})

test('read mode refuses commands that hide a program or could write', async () => {
  const refused = [
    { command: 'rm -rf /', token: 'rm' },
    { command: 'cat a > /tmp/b', token: '>' },
    { command: 'ls $(whoami)', token: '$(' },
    { command: 'FOO=bar ls', token: 'FOO=bar' },
    { command: 'systemctl restart x', token: 'restart' },
    { command: 'journalctl --vacuum-time=1d', token: '--vacuum-time=1d' },
    { command: 'ls\nrm -rf /' },
    // `getopt_long` accepts unambiguous abbreviations, so the full spelling is not the only shape.
    { command: 'journalctl --rot', token: '--rot' },
    { command: 'file --comp -m /usr/share/misc/magic', token: '--comp' },
    { command: 'ss -D /tmp/out', token: '-D' },
    { command: 'ss --dia=/tmp/out', token: '--dia' },
    { command: 'df --sync', token: '--sync' },
    // `date` and `hostname` are settable through an ordinary operand, so they are not allowlisted.
    { command: 'date -s @0', token: 'date' },
    { command: 'date 010100002020', token: 'date' },
    { command: 'hostname attacker.example', token: 'hostname' },
    { command: 'hostname -F /etc/hostname', token: 'hostname' },
    // Input redirection can open a TCP socket from the remote host in bash.
    { command: 'cat </dev/tcp/127.0.0.1/22', token: '<' },
    // `ps e` appends every process environment, which no read surface should offer.
    { command: 'ps e -p 1', token: 'e' },
  ]
  for (const entry of refused) {
    const harness = makeHarness()
    const result = await harness.tool.execute({ id: HOST_ID, command: entry.command }, {})
    assertMatchesSchema(harness.tool.output.schema, result)
    assert.equal(result.ok, false, `${entry.command} must not run`)
    assert.equal(result.error.code, 'READ_ONLY_REFUSED', `${entry.command} must be a read-only refusal`)
    assert.match(result.error.message, /read mode|只读/)
    if (entry.token) assert.ok(result.error.message.includes(entry.token), `the message must name ${entry.token}`)
    assert.equal(harness.calls.length, 0, 'a refused command never reaches the transport')
  }
})

test('the two harmless redirections are not refusals', async () => {
  for (const command of ['ls /nope 2>/dev/null', 'ls /nope 2>&1']) {
    const harness = makeHarness()
    const result = await harness.tool.execute({ id: HOST_ID, command }, {})
    assert.equal(result.ok, true, `${command} must run`)
    assert.equal(result.mode, 'read')
    assert.equal(harness.calls.length, 1)
    assert.equal(harness.calls[0].command, command)
  }
})

test('a compound read line passes when every segment starts with an allowed program', async () => {
  const command = 'ls -la && ps aux | grep node; journalctl -u dsh --no-pager'
  const harness = makeHarness()
  const result = await harness.tool.execute({ id: HOST_ID, command }, {})
  assertMatchesSchema(harness.tool.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(harness.calls.length, 1)
})

// ---- write mode --------------------------------------------------------------------------------

test('write mode needs the config switch and the per-call confirmation', async () => {
  const off = makeHarness()
  const disabled = await off.tool.execute(
    { id: HOST_ID, command: 'systemctl restart dsh', mode: 'write', confirm: true },
    {},
  )
  assertMatchesSchema(off.tool.output.schema, disabled)
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error.code, 'WRITE_DISABLED')
  assert.equal(off.calls.length, 0, 'a switched-off write never reaches the transport')

  const unconfirmed = makeHarness({ toolOptions: { allowWrite: true } })
  const missing = await unconfirmed.tool.execute({ id: HOST_ID, command: 'systemctl restart dsh', mode: 'write' }, {})
  assertMatchesSchema(unconfirmed.tool.output.schema, missing)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'CONFIRM_REQUIRED')
  assert.equal(unconfirmed.calls.length, 0, 'an unconfirmed write never reaches the transport')

  const enabled = makeHarness({ toolOptions: { allowWrite: true } })
  const done = await enabled.tool.execute(
    { id: HOST_ID, command: 'systemctl restart dsh', mode: 'write', confirm: true },
    {},
  )
  assertMatchesSchema(enabled.tool.output.schema, done)
  assert.equal(done.ok, true)
  assert.equal(done.mode, 'write')
  assert.equal(enabled.calls.length, 1)
  assert.equal(enabled.calls[0].command, 'systemctl restart dsh', 'write mode is not filtered by the allowlist')
})

// ---- host link ---------------------------------------------------------------------------------

test('an unknown or disconnected host never reaches the transport', async () => {
  const unknown = makeHarness({ register: false })
  const missing = await unknown.tool.execute({ id: 'h_ghost', command: 'ls' }, {})
  assertMatchesSchema(unknown.tool.output.schema, missing)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'HOST_NOT_FOUND')

  const offline = makeHarness({
    runtime: { id: HOST_ID, status: 'disconnected', ssh: { connected: true, exec: async () => frame() } },
  })
  const disconnected = await offline.tool.execute({ id: HOST_ID, command: 'ls' }, {})
  assert.equal(disconnected.ok, false)
  assert.equal(disconnected.error.code, 'HOST_NOT_CONNECTED')
  assert.match(disconnected.error.hint, /host switcher/)

  const deadLink = makeHarness({
    runtime: { id: HOST_ID, status: 'connected', ssh: { connected: false, exec: async () => frame() } },
  })
  const dead = await deadLink.tool.execute({ id: HOST_ID, command: 'ls' }, {})
  assert.equal(dead.ok, false)
  assert.equal(dead.error.code, 'HOST_NOT_CONNECTED')
})

// ---- projection --------------------------------------------------------------------------------

test('a huge stream is capped at maxBytes and says it was cut', async () => {
  const harness = makeHarness({ frame: frame({ stdout: 'x'.repeat(100_000) }) })
  const result = await harness.tool.execute({ id: HOST_ID, command: 'cat big.log', maxBytes: 1024 }, {})
  assertMatchesSchema(harness.tool.output.schema, result)
  assert.equal(result.ok, true)
  assert.ok(result.stdout.length <= 1024 + 1, `stdout is ${result.stdout.length} characters`)
  assert.ok(result.stdout.endsWith('…'), 'a cut stream says so')
  assert.equal(result.truncated, true)
})

test('remote output is redacted before it reaches the model', async () => {
  const stdout = [
    'fake SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=',
    'key at /home/dev/.ssh/id_ed25519',
    'token=tok_live_abcdef',
    'dsh web: http://127.0.0.1:9/?token=secret',
  ].join('\n')
  const harness = makeHarness({ frame: frame({ stdout }) })
  const result = await harness.tool.execute({ id: HOST_ID, command: 'cat /etc/env' }, {})

  assertMatchesSchema(harness.tool.output.schema, result)
  const serialized = JSON.stringify(result)
  for (const secret of ['SHA256:abcdefghijklmnop', '/home/dev', 'tok_live_abcdef', 'token=secret']) {
    assert.equal(serialized.includes(secret), false, `the result leaked ${secret}`)
  }
  assert.ok(serialized.includes('<fingerprint redacted>'), 'the fingerprint is replaced')
  assert.ok(serialized.includes('<private-key path>'), 'the key path is replaced')
  assert.ok(serialized.includes('<redacted>'), 'the token is replaced')
})

test('redaction covers the shapes a real diagnostic line carries', async () => {
  // Every line here is a shape a remote command really prints: a sentence that ends on the key path,
  // a password glued to `-p`, a prefixed env name, and a launch token passed as a flag.
  const stdout = [
    'could not read D:\\keys\\prod.ppk: ENOENT',
    'could not read /opt/keys/deploy.pem, skipping',
    'mysql -u root -pHunter2Pass db',
    'MYSQL_PWD=hunter2 psql',
    'npx @deepseek-ai/dsh web --token s3cr3tLaunchToken',
  ].join('\n')
  const harness = makeHarness({ frame: frame({ stdout }) })
  const result = await harness.tool.execute({ id: HOST_ID, command: 'ps aux' }, {})

  assertMatchesSchema(harness.tool.output.schema, result)
  const serialized = JSON.stringify(result)
  for (const secret of ['prod.ppk', 'deploy.pem', 'Hunter2Pass', 'hunter2', 's3cr3tLaunchToken']) {
    assert.equal(serialized.includes(secret), false, `the result leaked ${secret}`)
  }
  assert.ok(serialized.includes('<private-key path>'), 'a key path terminated by punctuation is replaced')
  assert.ok(serialized.includes('<redacted>'), 'the flag and env values are replaced')
})

test('the command echo is bounded and redacted', async () => {
  const harness = makeHarness()
  const command = `echo ${'a'.repeat(600)}`
  const result = await harness.tool.execute({ id: HOST_ID, command }, {})
  assertMatchesSchema(harness.tool.output.schema, result)
  assert.ok(result.command.length <= 200, `the echo is ${result.command.length} characters`)
})

test('a timed-out command is a result, not an error', async () => {
  const harness = makeHarness({ frame: frame({ code: null, stdout: 'partial output', timedOut: true }) })
  const result = await harness.tool.execute({ id: HOST_ID, command: 'tail -f server.log' }, {})
  assertMatchesSchema(harness.tool.output.schema, result)
  assert.equal(result.ok, true)
  assert.equal(result.timedOut, true)
  assert.equal(result.stdout, 'partial output')
  assert.equal(Object.hasOwn(result, 'code'), false, 'a missing exit status is omitted, never null')
  const [block] = harness.tool.output.render({}, result)
  assert.match(block.text, /timed out/)
})

test('a transport failure becomes a structured error, never a throw', async () => {
  const crashed = makeHarness({
    exec: async () => {
      throw new Error('socket hang up')
    },
  })
  const internal = await crashed.tool.execute({ id: HOST_ID, command: 'ls' }, {})
  assertMatchesSchema(crashed.tool.output.schema, internal)
  assert.equal(internal.ok, false)
  assert.equal(internal.error.code, 'INTERNAL')
  assert.equal(crashed.logs.length, 1, 'the failure is logged at error level')

  const coded = makeHarness({
    exec: async () => {
      throw errors.network({ zh: '连不上。', en: 'The network is unreachable.' })
    },
  })
  const network = await coded.tool.execute({ id: HOST_ID, command: 'ls' }, {})
  assert.equal(network.ok, false)
  assert.equal(network.error.code, 'NETWORK', 'a RemoteGoError keeps its own code')
})

// ---- render ------------------------------------------------------------------------------------

test('render never throws and always prefixes the plugin tag', () => {
  const harness = makeHarness()
  const hostileStdout = {
    ok: true,
    get stdout() {
      throw new Error('boom')
    },
  }
  const hostileOk = {
    get ok() {
      throw new Error('boom')
    },
  }
  const values = [
    undefined,
    null,
    {},
    { ok: false, error: { code: 'HOST_NOT_FOUND', message: '找不到 / not found' } },
    hostileStdout,
    hostileOk,
    { ok: true, code: 0, stdout: 'out', stderr: '', timedOut: false, durationMs: 3, mode: 'read' },
  ]
  for (const value of values) {
    const blocks = harness.tool.output.render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    for (const block of blocks) {
      assert.deepEqual(Object.keys(block).sort(), ['text', 'type'])
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.ok(block.text.startsWith('[dsh-remote-go]'), 'every rendered block carries the plugin tag')
    }
  }
})

test('render prints the status line and both streams', async () => {
  const harness = makeHarness({ frame: frame({ code: 2, stdout: 'out line', stderr: 'err line' }) })
  const result = await harness.tool.execute({ id: HOST_ID, command: 'ls -la' }, {})
  const [block] = harness.tool.output.render({}, result)
  assert.match(block.text, /^\[dsh-remote-go\] exit 2 · \d+ ms · read/)
  assert.match(block.text, /--- stdout ---\nout line/)
  assert.match(block.text, /--- stderr ---\nerr line/)
})

// ---- definition shape --------------------------------------------------------------------------

test('the definition declares the exec contract', () => {
  const harness = makeHarness()
  const definition = harness.tool
  assert.equal(definition.name, EXEC_TOOL_NAME)
  assert.match(definition.name, /^[a-z][a-z0-9_]{0,40}$/, 'a model-facing tool name is lower_snake_case')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, ['id', 'command'])
  assert.deepEqual(Object.keys(definition.parameters.properties), [
    'id',
    'command',
    'mode',
    'confirm',
    'timeoutMs',
    'maxBytes',
  ])
  assert.deepEqual(definition.parameters.properties.mode.enum, ['read', 'write'])
  // The kernel's enforced schema subset is type/oneOf/properties/required/additionalProperties/
  // items/enum/const + annotations, so numeric bounds live in the description and are clamped in
  // code (`boundedInt`); a `minimum`/`maximum` keyword here is rejected by the real registry.
  const unsupported = ['minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'format', 'nullable']
  const declared = JSON.stringify(definition.parameters)
  for (const keyword of unsupported) {
    assert.equal(declared.includes(`"${keyword}"`), false, `the parameter schema must not use ${keyword}`)
  }
  assert.match(definition.parameters.properties.timeoutMs.description, /1000–120000/)
  assert.match(definition.parameters.properties.maxBytes.description, /1024–65536/)

  assert.equal(definition.output.schema.type, 'object')
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.deepEqual(definition.output.schema.required, ['ok'])
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')

  assert.equal(definition.timeoutMs, 125000, 'the kernel deadline sits above the parameter ceiling')
  assert.equal(definition.isConcurrencySafe(), false, 'a command can have side effects')

  for (const phrase of [/authenticated SSH link/, /allowlist/, /exec\.allowWrite/, /UNTRUSTED/, /中文/]) {
    assert.match(definition.description, phrase)
  }
})

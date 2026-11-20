import test from 'node:test'
import assert from 'node:assert/strict'
import { REPORT_TOOL_NAME, reportTool } from '../../dist/src/tools-report.js'
import { errors } from '../../dist/src/errors.js'

// ---- fixtures ----------------------------------------------------------------------------------
const SECRET = 'hunter2-do-not-leak'
const TOKEN = 'tok_live_abcdef'
const KEY_PATH = '/home/dev/.ssh/id_ed25519'
const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG='
/** A HostView with credentials and fingerprints filled in: none of them may reach a result. */
function hostView(overrides = {}) {
  return {
    id: 'h_prod',
    name: 'prod',
    address: 'prod.example.com',
    status: 'connected',
    phase: 'ready',
    progress: { code: 'ready' },
    error: null,
    authKeyPath: KEY_PATH,
    password: SECRET,
    token: TOKEN,
    fingerprint: { sha256: FINGERPRINT },
    remote: { version: '0.2.2-rc.3', token: TOKEN },
    ...overrides,
  }
}
/** `count` checklist rows; the first one fails so `summary`/`counts` have something to report. */
function makeChecks(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `check-${index}`,
    title: { zh: `检查 ${index}`, en: `Check ${index}` },
    status: index === 0 ? 'fail' : 'pass',
    detail: { zh: `详情 ${index}`, en: `Detail ${index}` },
  }))
}
/** The runtime's restart trail: `fromPort`/`pid` are nullable and `source` is not contract. */
function makeRestarts() {
  return [
    { at: '2026-11-19T09:00:00.000Z', kind: 'local-restart', fromPort: 41234, toPort: 41235, pid: 9001 },
    {
      at: '2026-11-19T09:30:00.000Z',
      kind: 'remote-reattach',
      fromPort: null,
      toPort: 41235,
      pid: null,
      reason: 'heartbeat saw the remote fail',
      source: 'heartbeat',
    },
  ]
}
/** A `DiagnosticsReport` shaped like `diagnoseHost` builds it (already redacted upstream). */
function makeReport(overrides = {}) {
  return {
    summary: 'warning',
    checks: makeChecks(10),
    redacted: true,
    generatedAt: '2026-11-19T10:00:00.000Z',
    restarts: makeRestarts(),
    logs: ['[dsh-remote-go:h_prod] connected'],
    ...overrides,
  }
}
/** `count` connect-log rows, oldest first, alternating `phase` so the projection has both. */
function makeEntries(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    seq: index + 1,
    at: `2026-11-19T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
    level: index % 5 === 4 ? 'warn' : 'info',
    phase: index % 2 === 0 ? 'ssh' : null,
    message: `line ${index + 1}`,
  }))
}
/** A `ConnectLogView` as `service.logView` answers it. */
function makeLogView(entries) {
  return { hostId: 'h_prod', attempt: 2, visible: true, firstSeq: 1, seq: entries.length, entries }
}
// A fake Host composition plus the tool built on it. `calls` counts what the body actually read, so a test can prove
// `parts` skips the half it did not ask for; `omit` removes a
// service member the way a composition that never mounted it would.
function makeService(options = {}) {
  const calls = { init: 0, diagnose: 0, logView: 0 }
  const views = options.views ?? [hostView()]
  const service = {
    init: async () => {
      calls.init += 1
    },
    snapshot: () => ({ hosts: views }),
    diagnose: async (id) => {
      calls.diagnose += 1
      return options.diagnose ? options.diagnose(id) : (options.report ?? makeReport())
    },
    logView: (id) => {
      calls.logView += 1
      return options.logView ? options.logView(id) : (options.view ?? makeLogView(options.entries ?? makeEntries(3)))
    },
  }
  for (const name of options.omit ?? []) delete service[name]
  const logs = []
  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  }
  return { service, calls, logs, logger, tool: reportTool({ service, logger }) }
}
/** The declared leaf types, checked the way the kernel checks them before a model sees a result. */
const LEAVES = {
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
}
// Validate one result against the tool's declared `output.schema` the way the kernel does: required fields present,
// declared types, no undeclared key and no `undefined` value. A mismatch is a runtime INVALID_TOOL_OUTPUT, so this
// catches it before a model ever sees a broken call.
function assertMatchesSchema(schema, value, path = 'value') {
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`)
    for (const [index, item] of value.entries()) {
      if (schema.items) assertMatchesSchema(schema.items, item, `${path}[${index}]`)
    }
    return
  }
  if (schema.type !== 'object') {
    assert.ok(LEAVES[schema.type](value), `${path} must be a ${schema.type}`)
    return
  }
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
}
/** Run the report tool once, validate the result against its schema and hand back what was read. */
async function runReport(options = {}, input = {}) {
  const made = makeService(options)
  const result = await made.tool.execute(input, {})
  assertMatchesSchema(made.tool.output.schema, result)
  return { ...made, result }
}
/** The identifiers, credentials and key material that must never appear in a result. */
const FORBIDDEN = [SECRET, TOKEN, KEY_PATH, FINGERPRINT, 'SHA256', '.ssh']
function assertNoSecrets(value) {
  const serialized = JSON.stringify(value)
  for (const secret of FORBIDDEN) {
    assert.equal(serialized.includes(secret), false, `the result leaked ${secret}`)
  }
}

// ---- registration ------------------------------------------------------------------------------

test('the report registers with a read-only contract and no declared timeout', () => {
  const { tool } = makeService()
  assert.equal(tool.name, REPORT_TOOL_NAME)
  assert.match(tool.name, /^[a-z][a-z0-9_]{0,40}$/, 'a model-facing tool name is lower_snake_case')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['id'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['id', 'limit', 'parts'])
  assert.equal(tool.parameters.properties.limit.type, 'integer')
  assert.deepEqual(tool.parameters.properties.parts.items.enum, ['checks', 'logs'])
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.deepEqual(tool.output.schema.required, ['ok'])
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.timeoutMs, undefined, 'a body with no cancellable wait must not promise a timeout')
  assert.equal(tool.isConcurrencySafe(), true, 'the read-only tool may run in parallel')
  assert.match(tool.description, /Read-only/i, 'the description must say the tool changes nothing')
  assert.match(tool.description, /no password, token, cookie, host fingerprint or private-key path/)
  assert.match(tool.description, /untrusted input/)
  assert.match(tool.description.split('\n').at(-1), /^中文：/, 'the description ends with one 中文 line')
})

// ---- happy path --------------------------------------------------------------------------------

test('the report projects the checklist, the restart trail and the log tail', async () => {
  const { result, calls } = await runReport({}, { id: 'h_prod' })
  assert.equal(result.ok, true)
  assert.equal(calls.init, 1, 'the service is initialised before anything is read')
  assert.equal(result.summary, 'warning')
  assert.equal(result.generatedAt, '2026-11-19T10:00:00.000Z')
  assert.equal(result.checks.length, 10)
  assert.deepEqual(result.counts, { pass: 9, fail: 1, unknown: 0 })
  assert.equal(result.logs.length, 3)
  assert.equal(result.truncated, undefined, 'a report that fits carries no truncation flag')
  // The exact row: nothing from the HostView rides along, not even the address.
  assert.deepEqual(result.host, { id: 'h_prod', label: 'prod', state: 'connected', connected: true })
  // A nullable port/pid is omitted rather than emitted as `null`, and `source` is not contract.
  assert.deepEqual(result.restarts[0], {
    at: '2026-11-19T09:00:00.000Z',
    kind: 'local-restart',
    fromPort: 41234,
    toPort: 41235,
    pid: 9001,
  })
  assert.deepEqual(result.restarts[1], {
    at: '2026-11-19T09:30:00.000Z',
    kind: 'remote-reattach',
    toPort: 41235,
    reason: 'heartbeat saw the remote fail',
  })
  assertNoSecrets(result)
})

test('a host missing from the snapshot still gets a row, and its connected flag stays false', async () => {
  const { result } = await runReport({ views: [] }, { id: 'h_prod', parts: ['checks'] })
  assert.deepEqual(result.host, { id: 'h_prod', label: 'h_prod', state: 'unknown', connected: false })
})

// ---- redaction ---------------------------------------------------------------------------------

test('the projection scrubs the fingerprint, the key path and the token', async () => {
  const detailZh = `已记录 ${FINGERPRINT}`
  const detailEn = `key ${KEY_PATH} token=${TOKEN}`
  const { result } = await runReport(
    {
      report: makeReport({
        checks: [
          {
            id: 'host-key',
            title: { zh: '主机指纹', en: 'Host key' },
            status: 'fail',
            detail: { zh: detailZh, en: detailEn },
          },
        ],
        restarts: [],
      }),
      view: makeLogView([
        {
          seq: 1,
          at: '2026-11-19T10:00:00.000Z',
          level: 'error',
          phase: 'ssh',
          message: `connect failed: ${FINGERPRINT} at ${KEY_PATH} token=${TOKEN}`,
        },
      ]),
    },
    { id: 'h_prod' },
  )
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('SHA256'), false, 'no fingerprint material may survive')
  assert.equal(serialized.includes('.ssh'), false, 'no private-key path may survive')
  assert.equal(serialized.includes(TOKEN), false, 'no token may survive')
  // The lines still say what happened — only the identifiers are gone.
  assert.match(result.checks[0].detail, /<fingerprint redacted>/)
  assert.match(result.checks[0].detail, /<private-key path>/)
  assert.match(serialized, /token=<redacted>/)
  assert.match(result.logs[0].message, /<fingerprint redacted>/)
  assert.match(result.logs[0].message, /<private-key path>/)
  assertNoSecrets(result)
})

test('a 50 KB detail is bounded and cannot stall the projection', async () => {
  // A host field is caller- or remote-controlled and the projection
  // is synchronous, so its cost must not scale with length.
  const long = `${FINGERPRINT} ${KEY_PATH} ${'a'.repeat(50_000)}`
  const made = makeService({
    report: makeReport({
      checks: [
        { id: 'ssh-reachable', title: { zh: 'SSH', en: 'SSH' }, status: 'pass', detail: { zh: long, en: long } },
      ],
      restarts: [],
    }),
  })
  const started = performance.now()
  const result = await made.tool.execute({ id: 'h_prod', parts: ['checks'] }, {})
  const elapsed = performance.now() - started
  assert.ok(elapsed < 100, `the projection took ${elapsed.toFixed(1)} ms for a 50 KB field`)
  assertMatchesSchema(made.tool.output.schema, result)
  const detail = result.checks[0].detail
  assert.ok(detail.length <= 400, `the detail is capped at TEXT_LIMIT (400), got ${detail.length}`)
  assert.match(detail, /^<fingerprint redacted> <private-key path>/, 'the identifiers are gone')
  assert.equal(JSON.stringify(result).includes('SHA256'), false)
  assert.equal(JSON.stringify(result).includes('.ssh'), false)
})

// ---- faults ------------------------------------------------------------------------------------

test('a diagnose failure for an unknown host becomes a structured error', async () => {
  const { result, logs } = await runReport(
    {
      diagnose: async () => {
        throw errors.invalidInput('id', { zh: '找不到这台主机。', en: 'No such host.' })
      },
    },
    { id: 'h_missing' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_INPUT')
  assert.match(result.error.message, /找不到这台主机/)
  assert.ok(
    logs.some((line) => line[0] === 'error'),
    'a failure is logged at error level',
  )
})

test('a null log view is HOST_NOT_FOUND, and the log half does not read the checklist', async () => {
  const { result, calls } = await runReport(
    {
      logView: () => null,
      diagnose: async () => {
        throw new Error('the log half must not read the checklist')
      },
    },
    { id: 'h_missing', parts: ['logs'] },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'HOST_NOT_FOUND')
  assert.equal(calls.diagnose, 0, 'parts: [logs] must not call diagnose')
})

test('a composition without the method a part needs answers UNSUPPORTED', async () => {
  const noChecks = await runReport({ omit: ['diagnose'] }, { id: 'h_prod' })
  assert.equal(noChecks.result.ok, false)
  assert.equal(noChecks.result.error.code, 'UNSUPPORTED')
  assert.match(noChecks.result.error.message, /诊断/)

  const noLogs = await runReport({ omit: ['logView'] }, { id: 'h_prod' })
  assert.equal(noLogs.result.ok, false)
  assert.equal(noLogs.result.error.code, 'UNSUPPORTED')
  assert.match(noLogs.result.error.message, /logs/)

  // The half that is still mounted keeps answering.
  const checksOnly = await noLogs.tool.execute({ id: 'h_prod', parts: ['checks'] }, {})
  assert.equal(checksOnly.ok, true)
  assert.equal(checksOnly.checks.length, 10)
  assert.equal(Object.hasOwn(checksOnly, 'logs'), false)
})

test('an invalid id is refused before the service is touched', async () => {
  const { tool, calls } = makeService()
  for (const id of [undefined, null, 42, '', '   ', 'x'.repeat(121)]) {
    const result = await tool.execute({ id }, {})
    assertMatchesSchema(tool.output.schema, result)
    assert.equal(result.ok, false, `id ${JSON.stringify(id)} must be refused`)
    assert.equal(result.error.code, 'INVALID_INPUT')
    assert.match(result.error.hint, /remote_hosts_list/)
  }
  assert.equal(calls.init, 0, 'input validation comes before init')
})

// ---- parts and limits --------------------------------------------------------------------------

test('parts selects which half is read and emitted', async () => {
  const { tool, calls } = makeService()
  const checks = await tool.execute({ id: 'h_prod', parts: ['checks'] }, {})
  assertMatchesSchema(tool.output.schema, checks)
  assert.equal(Object.hasOwn(checks, 'logs'), false, 'parts: [checks] emits no logs key')
  assert.equal(checks.checks.length, 10)
  assert.equal(calls.logView, 0)

  const logs = await tool.execute({ id: 'h_prod', parts: ['logs'] }, {})
  assertMatchesSchema(tool.output.schema, logs)
  assert.equal(Object.hasOwn(logs, 'checks'), false, 'parts: [logs] emits no checks key')
  assert.equal(Object.hasOwn(logs, 'counts'), false)
  assert.equal(Object.hasOwn(logs, 'summary'), false)
  assert.equal(logs.logs.length, 3)

  // An absent, empty or unrecognized selection means both halves.
  for (const parts of [undefined, [], ['nonsense']]) {
    const both = await tool.execute({ id: 'h_prod', parts }, {})
    assert.equal(both.checks.length, 10)
    assert.equal(both.logs.length, 3)
  }
})

test('the log tail keeps the newest rows, clamps limit and says when it dropped some', async () => {
  const { tool } = makeService({ entries: makeEntries(120) })
  const five = await tool.execute({ id: 'h_prod', parts: ['logs'], limit: 5 }, {})
  assertMatchesSchema(tool.output.schema, five)
  assert.equal(five.logs.length, 5)
  assert.deepEqual(
    five.logs.map((row) => row.seq),
    [116, 117, 118, 119, 120],
    'the newest rows survive, oldest first',
  )
  assert.equal(five.truncated, true)

  const defaults = await tool.execute({ id: 'h_prod', parts: ['logs'] }, {})
  assert.equal(defaults.logs.length, 40, 'the default limit is 40')
  assert.equal(defaults.truncated, true, '120 entries still overflow 40')

  const clampedHigh = await tool.execute({ id: 'h_prod', parts: ['logs'], limit: 5_000 }, {})
  assert.equal(clampedHigh.logs.length, 60, 'limit is clamped down to 60')

  const clampedLow = await tool.execute({ id: 'h_prod', parts: ['logs'], limit: 0 }, {})
  assert.equal(clampedLow.logs.length, 1, 'limit is clamped up to 1')

  const bogus = await tool.execute({ id: 'h_prod', parts: ['logs'], limit: 'many' }, {})
  assert.equal(bogus.logs.length, 40, 'a non-integer limit falls back to the default')

  const fits = await tool.execute({ id: 'h_prod', parts: ['logs'], limit: 60 }, {})
  assert.equal(fits.logs.length, 60)
  assert.equal(fits.truncated, true, '60 of 120 is still truncated')

  const exact = makeService({ entries: makeEntries(3) })
  const complete = await exact.tool.execute({ id: 'h_prod', parts: ['logs'], limit: 3 }, {})
  assert.equal(complete.logs.length, 3)
  assert.equal(complete.truncated, undefined, 'a tail that fits carries no truncation flag')
})

test('the checklist is capped at 20 rows and says so', async () => {
  const { result } = await runReport(
    { report: makeReport({ checks: makeChecks(25) }) },
    { id: 'h_prod', parts: ['checks'] },
  )
  assert.equal(result.checks.length, 20)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.counts, { pass: 19, fail: 1, unknown: 0 }, 'counts cover the returned rows')
})

test('the restart trail keeps the newest 8 and never emits a null field', async () => {
  const restarts = Array.from({ length: 12 }, (_unused, index) => ({
    at: `2026-11-19T09:${String(index).padStart(2, '0')}:00.000Z`,
    kind: index % 2 === 0 ? 'local-restart' : 'remote-reattach',
    fromPort: index % 3 === 0 ? null : 41000 + index,
    toPort: 41000 + index + 1,
    pid: index % 4 === 0 ? null : 9000 + index,
  }))
  const { result } = await runReport(
    { report: makeReport({ checks: makeChecks(1), restarts }) },
    { id: 'h_prod', parts: ['checks'] },
  )
  assert.equal(result.restarts.length, 8, 'only the newest 8 restarts survive')
  assert.equal(result.restarts[0].at, '2026-11-19T09:04:00.000Z')
  assert.equal(result.restarts.at(-1).at, '2026-11-19T09:11:00.000Z')
  for (const row of result.restarts) {
    for (const key of ['fromPort', 'pid']) assert.notEqual(row[key], null, `${key} must be omitted, not null`)
  }
})

// ---- render ------------------------------------------------------------------------------------

test('render never throws and always says who it is', () => {
  const render = makeService().tool.output.render
  const hostile = {
    ok: true,
    get checks() {
      throw new Error('boom')
    },
  }
  for (const value of [undefined, null, { ok: false, error: { code: 'X', message: 'boom' } }, hostile]) {
    const blocks = render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    for (const block of blocks) {
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
      assert.match(block.text, /\[dsh-remote-go\]/)
    }
  }
})

test('render prints the header, one line per check and the log tail', async () => {
  const { tool, result } = await runReport({}, { id: 'h_prod' })
  const [block] = tool.output.render({}, result)
  assert.match(block.text, /^\[dsh-remote-go\] prod · connected · 10 项检查/)
  assert.match(block.text, /10 checks/)
  assert.match(block.text, /warning/)
  assert.match(block.text, /- \[fail\] 检查 0 \/ Check 0 — 详情 0 \/ Detail 0/)
  assert.equal(block.text.split('\n').filter((line) => line.startsWith('- [')).length, 10, 'one line per check')
  assert.match(block.text, /- 1 · 2026-11-19T10:00:00.000Z · info ssh line 1/)

  const truncated = await makeService({ entries: makeEntries(120) }).tool.execute({ id: 'h_prod', parts: ['logs'] }, {})
  const [tail] = tool.output.render({}, truncated)
  assert.match(tail.text, /已截断/)
  assert.match(tail.text, /truncated/)
})

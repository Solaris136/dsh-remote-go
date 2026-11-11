/**
 * Predicate guard: a wait may not cover less than the assertions that follow it.
 *
 * This is the regression that produced three CI failures (and one Windows-only
 * flake): `history.e2e.js` waited for `cursor === 2` and then asserted the log
 * contained `gap-unfilled`, which is written *after* persistence — so the wait
 * returned on a half-settled state. The fix widened the predicate to exactly the
 * asserted state (see `history.e2e.js`'s `settled()`: length + cursor + level +
 * reason + log line). This test enforces that shape across the e2e suites instead
 * of trusting review.
 *
 * Model (deliberately narrow, so it stays readable and has no false positives):
 * - a *wait* is `waitForMirrors(service, hostId, (list) => …)` or `pollUntil(…)`;
 * - its **predicate fields** are the property names read through the callback
 *   parameter (`mirror.cursor`, `mirror.reason`, `mirror.lease`, …);
 * - the assertions that follow are the `assert.*` calls in the same scope that read
 *   the resolved value (`mirrors[i].field`, `mirrors.every((m) => m.field …)`).
 *
 * A field asserted afterwards but absent from the predicate fails with `file:line`.
 * Deliberate non-goals: values (only field coverage), control flow, and any wait
 * whose resolved value is not asserted by field (nothing to compare).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INTEGRATION = path.resolve(HERE, '..', 'integration')

/**
 * Property reads through a named receiver: `mirror.cursor` → `cursor`.
 *
 * Collection/accessor noise is filtered: `map`/`filter`/`every`/`some`/`find`/
 * `length`/`json`/`slice`/`hostId` are not states a predicate can (or should) wait
 * on — including them would make the guard cry wolf and get disabled.
 */
const NON_STATE_FIELDS = new Set([
  'map',
  'filter',
  'every',
  'some',
  'find',
  'length',
  'json',
  'slice',
  'join',
  'sort',
  'includes',
  'textContent',
  'hostId',
  'forEach',
  'then',
  'catch',
])

function fieldsOf(source, receivers) {
  const fields = new Set()
  for (const receiver of receivers) {
    const re = new RegExp(`\\b${receiver}\\??\\.([A-Za-z_$][\\w$]*)`, 'g')
    for (const match of source.matchAll(re)) {
      if (!NON_STATE_FIELDS.has(match[1])) fields.add(match[1])
    }
  }
  return fields
}

/**
 * The assertion-only view of a block: the arguments of every `assert.*(...)` call.
 *
 * Diagnostic text is *not* an assertion. Reading a field inside a failure message
 * (`` `got ${JSON.stringify(x.map((m) => ({ epoch: m.epoch })))}` ``) must not make
 * the guard demand that the predicate wait on it — that was a false positive on a
 * transient snapshot, and a guard that cries wolf gets deleted.
 * @param {string} source
 */
function assertionArguments(source) {
  const parts = []
  for (const match of source.matchAll(/\bassert\.[A-Za-z]+(?:\.[A-Za-z]+)?\s*\(/g)) {
    const open = match.index + match[0].length - 1
    const close = matchingParen(source, open)
    if (close > open) parts.push(source.slice(open, close + 1))
  }
  return parts.join('\n')
}

/**
 * The assertion window: from the end of the wait call to the end of its block. It
 * stops at the next subtest/test or at a closing brace that de-indents, so it cannot
 * attribute a *later* test's assertions to this predicate.
 * @param {string} rest
 */
function assertionWindow(rest) {
  const lines = rest.split('\n').slice(0, 40)
  const kept = []
  for (const line of lines) {
    if (/^\s*await t\.test\(/.test(line) || /^\s*test\(/.test(line)) break
    if (/^\s*\/\/ ----/.test(line)) break
    kept.push(line)
    if (kept.length > 0 && /^\s{0,4}\}$/.test(line)) break
  }
  return kept.join('\n')
}

/** Index of the parenthesis that closes the one at `open`. */
function matchingParen(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Finds every wait call and the assertions that follow in the same block.
 * @param {string} text
 * @param {string} file
 * @returns {{ file: string, line: number, missing: string[], predicate: string[] }[]}
 */
function violations(text, file) {
  const found = []
  const waitCall = /\b(waitForMirrors|pollUntil)\s*\(/g
  for (const match of text.matchAll(waitCall)) {
    const open = match.index + match[0].length - 1
    const close = matchingParen(text, open)
    if (close < 0) continue
    const call = text.slice(match.index, close + 1)
    const predicate = (() => {
      const arrow = call.indexOf('=>')
      return arrow < 0 ? call : call.slice(arrow)
    })()
    // Receiver names inside the predicate: the callback parameter, or `list`.
    const receivers = new Set(['list'])
    for (const param of predicate.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)\s*=>/g)) receivers.add(param[1])
    for (const param of predicate.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) receivers.add(param[1])
    const predicateFields = fieldsOf(predicate, [...receivers])
    if (predicateFields.size === 0) continue

    // The resolved value: `const X = await waitForMirrors(…)`.
    const before = text.slice(Math.max(0, match.index - 160), match.index)
    const binding = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*$/.exec(before)
    if (!binding) continue
    const result = binding[1]

    // Assertions in the rest of this block that read the result by field.
    const line = text.slice(0, match.index).split('\n').length
    const window = assertionWindow(text.slice(close + 1))
    // Loop variables are declared *outside* the assert calls, so they are collected
    // from the window; the fields themselves come from the assertion arguments.
    const loopParams = [
      ...window.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${result}\\b`, 'g')),
    ].map((loop) => loop[1])
    const after = assertionArguments(window)
    const asserted = new Set()
    for (const use of after.matchAll(new RegExp(`\\b${result}(?:\\[[^\\]]*\\])?\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      if (!NON_STATE_FIELDS.has(use[1])) asserted.add(use[1])
    }
    // `result.every((m) => m.field …)` and `result[i].field` shapes.
    for (const use of after.matchAll(
      new RegExp(`\\b${result}\\.(?:every|some|map|filter)\\(\\s*\\(?([A-Za-z_$][\\w$]*)`, 'g'),
    )) {
      asserted.add(`__callback:${use[1]}`)
    }
    // `for (const m of result) { assert.equal(m.field, …) }` — a loop body reads the
    // resolved value just as much as `.every()` does. This was a blind spot: the epoch
    // assertions of `lease.e2e.js` live in such a loop and went unenforced.
    for (const param of loopParams) asserted.add(`__callback:${param}`)
    const callbackFields = new Set()
    for (const entry of asserted) {
      if (!entry.startsWith('__callback:')) continue
      const param = entry.slice('__callback:'.length)
      for (const field of fieldsOf(after, [param])) callbackFields.add(field)
    }
    for (const entry of asserted) if (!entry.startsWith('__callback:')) callbackFields.add(entry)

    const missing = [...callbackFields].filter((field) => !predicateFields.has(field))
    if (missing.length > 0) {
      // Keyed by file + the predicate's own text, not by line: a line number changes
      // with every unrelated edit, and a reviewed exception must stay attached to the
      // predicate it excuses.
      const key = `${file}|${predicate.replace(/\s+/g, ' ').trim()}`
      found.push({ file, line, key, missing: missing.sort(), predicate: [...predicateFields].sort() })
    }
  }
  return found
}

/**
 * Reviewed exceptions: waits whose *snapshot is transient*, so requiring the asserted
 * field in the predicate would wait for a state that never coexists.
 *
 * The lease suite is the case in point: `waitForMirrors` returns the descriptor it
 * matched, and the fence lands while the descriptor is still advancing. Asserting
 * `cursor === 0` on that returned snapshot is correct, but adding it to the predicate
 * makes the wait time out (measured: with the field added, `two clients against one
 * remote` failed 2/2 and ended at cursor 5, reason cleared; with main's predicate it
 * passes). Widening these would be a behaviour change to PR #21's safety tests, not a
 * hardening, so they are exceptions — keyed by predicate text, with the reason.
 *
 * The guard still fails for every wait *not* listed here, and it fails when an entry
 * goes stale (the violation disappeared), so the list cannot rot.
 */
const TRANSIENT_SNAPSHOT_WAITS = new Map([
  [
    "lease.e2e.js|=> list.every((mirror) => mirror.reason?.code === 'fenced'), )",
    'fenced writers: the fence is observed while the descriptor is still advancing; assertions read that same snapshot',
  ],
  [
    "lease.e2e.js|=> list.every((mirror) => mirror.reason?.code === 'fenced' && mirror.readOnly === true), )",
    'refused client: it never takes a lease (epoch stays 0), so only reason+readOnly are stably settled',
  ],
  [
    'lease.e2e.js|=> list.every((m) => m.cursor === 5))',
    'two-client test: the later assertions describe a different phase than this first write',
  ],
])

test('every e2e wait predicate covers the fields its following assertions read', () => {
  const files = readdirSync(INTEGRATION).filter((name) => name.endsWith('.e2e.js'))
  assert.ok(files.length > 0, 'no e2e suites found to guard')
  /** @type {{ file: string, line: number, key: string, missing: string[] }[]} */
  const failures = []
  for (const name of files) {
    const text = readFileSync(path.join(INTEGRATION, name), 'utf8')
    failures.push(...violations(text, name))
  }
  const unaccepted = failures.filter((entry) => !TRANSIENT_SNAPSHOT_WAITS.has(entry.key))
  assert.deepEqual(
    unaccepted.map((entry) => `${entry.file}:${entry.line} — missing ${entry.missing.join(', ')}`),
    [],
    'a wait predicate is narrower than the assertions that follow it (add the field to the ' +
      'predicate, or document it in TRANSIENT_SNAPSHOT_WAITS with a reason)',
  )
  // Stale entries are a maintenance trap: they silently widen the allowlist.
  const keys = new Set(failures.map((entry) => entry.key))
  const stale = [...TRANSIENT_SNAPSHOT_WAITS.keys()].filter((key) => !keys.has(key))
  assert.deepEqual(stale, [], 'TRANSIENT_SNAPSHOT_WAITS lists a wait that no longer violates the rule — remove it')
})

// ---- self-calibration -------------------------------------------------------
// The analyzer is code too: these fixtures prove it fails on the historical defect
// (a `reason === null`-style proxy) and passes on the documented model, so a future
// refactor of the guard cannot silently turn it into a no-op.

test('the guard detects the documented proxy predicate', () => {
  // The historical defect in its supported shape: the wait only covers the cursor while
  // the assertion that follows also reads `reason` (history.e2e's `gap-unfilled` race).
  const fixture = [
    'const mirrors = await waitForMirrors(service, host.id, (list) =>',
    '  list.every((mirror) => mirror.cursor === 5),',
    ')',
    'assert.equal(',
    '  mirrors.every((mirror) => mirror.cursor === 5 && mirror.reason === null),',
    '  true,',
    ')',
  ].join('\n')
  const found = violations(fixture, 'fixture.e2e.js')
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].missing, ['reason'])
  assert.equal(found[0].line, 1)
})

test('the guard accepts the widened predicate history.e2e uses as its model', () => {
  const fixture = [
    'const settled = async () => {',
    '  const mirrors = await mirrorsOf(service, host.id)',
    '  return (',
    '    mirrors.length === 2 &&',
    "    mirrors.every((mirror) => mirror.cursor === 2 && mirror.level === 'L1' && mirror.reason?.code === 'gap-unfilled')",
    '  )',
    '}',
    'const mirrors = await waitForMirrors(service, host.id, (list) =>',
    '  list.every(',
    "    (mirror) => mirror.cursor === 2 && mirror.level === 'L1' && mirror.reason?.code === 'gap-unfilled',",
    '  ),',
    ')',
    'assert.equal(mirrors.every((mirror) => mirror.cursor === 2 && mirror.level === L1), true)',
  ].join('\n')
  assert.deepEqual(violations(fixture, 'fixture.e2e.js'), [])
})

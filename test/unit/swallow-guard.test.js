/**
 * Swallowed-error guard.
 *
 * The incident: `streamFile` was read before its `const` (a TDZ `ReferenceError`)
 * inside the history read path. The blanket `catch` there mapped **any** exception to
 * the benign typed reason `read-failed`, so a defect in our own code was reported as a
 * remote condition — history replay was silently disabled while every test stayed
 * green. The module was deleted; the shape survives wherever a `catch` turns an
 * unknown failure into a plausible, normal-looking typed reason.
 *
 * The rule this enforces (documented in CONTRIBUTING §9):
 *
 * > a catch that converts an unknown failure into a normal-looking state must log at
 * > error level and be distinguishable; never let an internal defect masquerade as a
 * > remote condition.
 *
 * Scope, deliberately narrow: only catches that **produce a typed reason from a fixed
 * vocabulary of benign/remote reasons**. A catch that returns `null`, `''`, `false` or
 * a best-effort default is not this bug (the caller cannot mistake it for "the remote
 * said no"), so it is out of scope — flagging those would bury the signal.
 *
 * Two honest escape hatches:
 * 1. **Distinguished** — the catch classifies internal causes (mentions `internal-error`)
 *    or logs at error level or re-throws. Nothing to report: a defect cannot hide.
 * 2. **`// swallow-ok: <reason>`** — an explicit, reviewed marker for a catch whose
 *    `try` body genuinely *is* the I/O call, so an exception there can only be a
 *    transport condition. The reason after the colon is required and is asserted to be
 *    two words or more, so a bare `// swallow-ok` cannot be used to silence the guard.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src')

/**
 * The plausible, remote-sounding reasons a catch must not produce from an unknown
 * failure. Local best-effort values (`null`, `''`, `'corrupt'`, `'missing'`) are not
 * here on purpose: they cannot be confused with "the remote refused".
 */
const BENIGN_REASONS = [
  'read-failed',
  'permission-denied',
  'no-session-log',
  'log-malformed',
  'log-truncated',
  'unknown-version',
  'sessions-dir-missing',
  'lease-malformed',
  'publish-failed',
  'malformed',
]

const LITERAL_PATTERN = new RegExp(`['"\`](${BENIGN_REASONS.join('|')})['"\`]`)
/** A catch that produces a typed reason at all — literal, ternary, or call. */
const REASON_FIELD = /reason\s*:/
const MARKER = /\/\/\s*swallow-ok:\s*(\S[^\n]*)/

/** Index of the brace that closes the one at `open`, skipping strings/comments loosely. */
function matchingBrace(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Every catch block in a source file, with its body and the text just before it.
 * @param {string} text
 * @param {string} file
 */
function catchBlocks(text, file) {
  const blocks = []
  for (const match of text.matchAll(/\bcatch\b\s*(?:\([^)]*\)\s*)?\{/g)) {
    const open = match.index + match[0].length - 1
    const close = matchingBrace(text, open)
    if (close < 0) continue
    const line = text.slice(0, match.index).split('\n').length
    blocks.push({
      file,
      line,
      body: text.slice(open, close + 1),
      before: text.slice(Math.max(0, match.index - 260), match.index),
    })
  }
  return blocks
}

/** @param {{ file: string, line: number, body: string, before: string }} block */
function violation(block) {
  // The incident site computed its reason with a ternary, so matching only
  // `reason: 'literal'` would have missed it. Any benign reason literal inside a catch
  // body that produces a `reason:` field counts, and the escapes below decide.
  const reasonMatch = block.body.match(LITERAL_PATTERN)
  if (!reasonMatch || !REASON_FIELD.test(block.body)) return null
  // Distinguished: a defect cannot masquerade, so there is nothing to report.
  const distinguished =
    block.body.includes('internal-error') ||
    /\b(?:logger|this\.logger|console)\s*\.\s*error\b/.test(block.body) ||
    /\bthrow\b/.test(block.body) ||
    // `this.#log(runtime, 'error', …)` — the runtime log at error level.
    /['"]error['"]/.test(block.body)
  if (distinguished) return null
  // Reviewed, explicit exception with a stated reason.
  const marker = block.body.match(MARKER) ?? block.before.match(MARKER)
  if (marker && marker[1].trim().split(/\s+/).length >= 2) return null
  return { file: block.file, line: block.line, reason: reasonMatch[1], marked: Boolean(marker) }
}

test('no catch turns an unknown failure into a plausible remote reason without saying so', () => {
  const files = readdirSync(SRC)
    .filter((name) => name.endsWith('.js'))
    .sort()
  assert.ok(files.length > 0, 'no source files found to guard')

  /** @type {{ file: string, line: number, reason: string, marked: boolean }[]} */
  const failures = []
  for (const name of files) {
    const text = readFileSync(path.join(SRC, name), 'utf8')
    for (const block of catchBlocks(text, name)) {
      const found = violation(block)
      if (found) failures.push(found)
    }
  }
  assert.deepEqual(
    failures.map(
      (entry) =>
        `${entry.file}:${entry.line} — returns '${entry.reason}' without internal-error, an error log, or // swallow-ok: <reason>`,
    ),
    [],
    'a catch swallows an unknown failure into a normal-looking remote reason',
  )
})

// ---- self-calibration -------------------------------------------------------
// The scanner is code too; these fixtures prove it still detects the incident shape
// and still accepts the two documented escape hatches.

test('the scanner detects the incident shape', () => {
  const fixture = [
    'export async function read(ssh) {',
    '  try {',
    '    const file = streamFile',
    '    return await ssh.exec(file)',
    '  } catch (error) {',
    "    return { ok: false, reason: 'read-failed' }",
    '  }',
    '}',
  ].join('\n')
  const found = catchBlocks(fixture, 'fixture.js').map(violation).filter(Boolean)
  assert.equal(found.length, 1)
  assert.equal(found[0].reason, 'read-failed')
  assert.equal(found[0].line, 5)
})

test('the scanner accepts an error-level, distinguishable catch', () => {
  const fixture = [
    'export async function read(ssh) {',
    '  try {',
    '    return await ssh.exec(file)',
    '  } catch (error) {',
    '    logger.error("[dsh-remote-go] internal history fault:", error)',
    "    return { ok: false, reason: 'read-failed' }",
    '  }',
    '}',
  ].join('\n')
  assert.deepEqual(catchBlocks(fixture, 'fixture.js').map(violation).filter(Boolean), [])
})

test('the scanner accepts a reviewed swallow-ok marker, and rejects an empty one', () => {
  const marked = [
    'try {',
    '  result = await ssh.exec(command)',
    '} catch {',
    '  // swallow-ok: the try body is only ssh.exec, a rejection is transport',
    "  return { ok: false, reason: 'read-failed' }",
    '}',
  ].join('\n')
  assert.deepEqual(catchBlocks(marked, 'fixture.js').map(violation).filter(Boolean), [])

  const bare = [
    'try {',
    '  result = await ssh.exec(command)',
    '} catch {',
    '  // swallow-ok',
    "  return { ok: false, reason: 'read-failed' }",
    '}',
  ].join('\n')
  const found = catchBlocks(bare, 'fixture.js').map(violation).filter(Boolean)
  assert.equal(found.length, 1, 'a marker without a stated reason must not silence the guard')
})

test('the scanner ignores best-effort defaults that cannot be mistaken for a remote answer', () => {
  const fixture = ['try {', '  await close()', '} catch {', '  return null', '}'].join('\n')
  assert.deepEqual(catchBlocks(fixture, 'fixture.js').map(violation).filter(Boolean), [])
})

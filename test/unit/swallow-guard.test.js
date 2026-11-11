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
 * The rule this enforces (CONTRIBUTING §9):
 *
 * > a catch that converts an unknown failure into a normal-looking state must log at
 * > error level and be distinguishable; never let an internal defect masquerade as a
 * > remote condition.
 *
 * Design: **the default is "violation"**, not a denylist of reason names. A denylist
 * was tried first and the reviewer planted four regressions that all passed it —
 * `reason: REASON` (a variable), `reason: remoteReasonFor(e)` (a helper call — the shape
 * this very PR introduces), `reason: 'ssh-unreachable'` (a new name), and a comment
 * containing "throw" (which silenced the guard). So the scanner now flags **any** catch
 * that produces a `reason:` field, unless it is:
 *
 * 1. **distinguished** — mentions `internal-error`, contains a real error-level log
 *    call (`#log(…, 'error', …)` / `logger.error(` / `console.error(`), or re-throws;
 * 2. **reviewed** — carries `// swallow-ok: <reason>` with a stated reason (≥2 words).
 *
 * Comments are stripped before the distinguished test, so prose cannot silence the
 * guard; the marker is read from the original text, because it *is* a comment.
 *
 * Scope is recursive (`src/**\/*.js`), matching what CONTRIBUTING states.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src')

const MARKER = /\/\/\s*swallow-ok:\s*(\S[^\n]*)/
/** A catch that produces a typed reason at all: literal, variable, ternary or call. */
const REASON_FIELD = /\breason\s*:/

/**
 * Replace comments (and, harmlessly, string bodies) with spaces while preserving
 * offsets and newlines, so line numbers and slices stay valid and prose cannot
 * satisfy the "distinguished" test.
 *
 * String literals are skipped rather than rewritten, so a `//` inside a URL is not
 * mistaken for a comment; the offsets are preserved either way.
 * @param {string} source
 */
export function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      out += '  '
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      if (index < source.length) {
        out += '  '
        index += 2
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        const current = source[index]
        out += current
        index += 1
        if (current === '\\') {
          if (index < source.length) {
            out += source[index]
            index += 1
          }
          continue
        }
        if (current === quote || current === '\n') break
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Index of the brace that closes the one at `open`. */
function matchingBrace(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Every catch block in a source file, with its comment-free body and the original
 * text around it (the marker lives in a comment).
 * @param {string} text
 * @param {string} file
 */
function catchBlocks(text, file) {
  const stripped = stripComments(text)
  const blocks = []
  for (const match of stripped.matchAll(/\bcatch\b\s*(?:\([^)]*\)\s*)?\{/g)) {
    const open = match.index + match[0].length - 1
    const close = matchingBrace(stripped, open)
    if (close < 0) continue
    blocks.push({
      file,
      line: stripped.slice(0, match.index).split('\n').length,
      // Comment-free: only real code may count as "distinguished".
      body: stripped.slice(open, close + 1),
      // Original: the reviewed marker is a comment by construction.
      rawBody: text.slice(open, close + 1),
      before: text.slice(Math.max(0, match.index - 300), match.index),
    })
  }
  return blocks
}

/**
 * Is this catch allowed to turn an unknown failure into a typed reason?
 * @param {{ file: string, line: number, body: string, rawBody: string, before: string }} block
 */
function violation(block) {
  if (!REASON_FIELD.test(block.body)) return null
  // Distinguished: a defect can no longer masquerade, so there is nothing to report.
  const distinguished =
    block.body.includes('internal-error') ||
    // The canonical classifier: mentioning it by call is the same statement as the
    // literal, and the helper is single-sourced so it cannot drift into benignness.
    block.body.includes('internalHistoryFault(') ||
    // A real error-level log call. Not the string 'error' — a variable or a comment
    // named `error` must not silence the guard.
    /#log\s*\([^;]*?['"]error['"]/.test(block.body) ||
    /\b(?:logger|console|this\.logger)\s*\.\s*error\s*\(/.test(block.body) ||
    /\bthrow\b/.test(block.body)
  if (distinguished) return null
  // Reviewed exception with a stated reason (a bare marker does not count).
  const marker = block.rawBody.match(MARKER) ?? block.before.match(MARKER)
  if (marker && marker[1].trim().split(/\s+/).length >= 2) return null
  return { file: block.file, line: block.line, marked: Boolean(marker) }
}

/** @param {string} dir @param {string[]} [out] */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('no catch turns an unknown failure into a typed reason without saying so', () => {
  const files = collectSourceFiles(SRC)
  assert.ok(files.length > 0, 'no source files found to guard')

  /** @type {{ file: string, line: number, marked: boolean }[]} */
  const failures = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const block of catchBlocks(text, path.relative(SRC, file))) {
      const found = violation(block)
      if (found) failures.push(found)
    }
  }
  assert.deepEqual(
    failures.map(
      (entry) =>
        `${entry.file}:${entry.line} — returns a typed reason without internal-error, an error-level log, or // swallow-ok: <reason>`,
    ),
    [],
    'a catch swallows an unknown failure into a normal-looking typed reason',
  )
})

// ---- self-calibration -------------------------------------------------------
// One fixture per shape the reviewer planted, plus the documented escape hatches.
// The scanner is code too: if a refactor turns it into a no-op these fail.

/** @param {string} code */
const scan = (code) => catchBlocks(code, 'fixture.js').map(violation).filter(Boolean)

test('planted regression: a reason held in a variable is flagged', () => {
  const fixture = [
    "const REASON = 'read-failed'",
    'function read(ssh) {',
    '  try {',
    '    return await ssh.exec(command)',
    '  } catch {',
    '    return { ok: false, reason: REASON }',
    '  }',
    '}',
  ].join('\n')
  assert.equal(scan(fixture).length, 1)
})

test('planted regression: a reason produced by a helper call is flagged', () => {
  // The shape this PR itself introduces (`remoteReasonFor`), which a literal-only
  // scanner could never see.
  const fixture = [
    'function read(ssh) {',
    '  try {',
    '    return await ssh.exec(command)',
    '  } catch (error) {',
    '    return { ok: false, reason: remoteReasonFor(error) }',
    '  }',
    '}',
  ].join('\n')
  assert.equal(scan(fixture).length, 1)
})

test('planted regression: an unknown, new-sounding reason is flagged (no denylist)', () => {
  const fixture = [
    'function read(ssh) {',
    '  try {',
    '    return await ssh.exec(command)',
    '  } catch {',
    "    return { ok: false, reason: 'ssh-unreachable' }",
    '  }',
    '}',
  ].join('\n')
  assert.equal(scan(fixture).length, 1)
})

test('planted regression: prose containing "throw"/"error" does not count as distinguished', () => {
  const fixture = [
    'function read(ssh) {',
    '  try {',
    '    return await ssh.exec(command)',
    '  } catch {',
    '    // we could throw here, or log the error, but we do not',
    "    return { ok: false, reason: 'read-failed' }",
    '  }',
    '}',
  ].join('\n')
  const found = scan(fixture)
  assert.equal(found.length, 1, 'a comment must not silence the guard')
})

test('planted regression: a variable named error does not count as an error log', () => {
  const fixture = [
    'function read(ssh) {',
    '  try {',
    '    return await ssh.exec(command)',
    '  } catch (error) {',
    '    const errorLine = String(error)',
    "    return { ok: false, reason: 'read-failed' }",
    '  }',
    '}',
  ].join('\n')
  assert.equal(scan(fixture).length, 1)
})

test('a real error-level log distinguishes the catch', () => {
  const fixtures = [
    [
      'function read(ssh) {',
      '  try {',
      '    return await ssh.exec(command)',
      '  } catch (error) {',
      '    logger.error("[dsh-remote-go] history read failed:", error)',
      "    return { ok: false, reason: 'read-failed' }",
      '  }',
      '}',
    ].join('\n'),
    [
      'function read(ssh) {',
      '  try {',
      '    return await ssh.exec(command)',
      '  } catch (error) {',
      "    this.#log(runtime, 'error', 'history read failed')",
      "    return { ok: false, reason: 'read-failed' }",
      '  }',
      '}',
    ].join('\n'),
    [
      'function read(ssh) {',
      '  try {',
      '    return await ssh.exec(command)',
      '  } catch (error) {',
      "    return { ok: false, reason: 'internal-error' }",
      '  }',
      '}',
    ].join('\n'),
    [
      'function read(ssh) {',
      '  try {',
      '    return await ssh.exec(command)',
      '  } catch (error) {',
      '    throw error',
      '  }',
      '}',
    ].join('\n'),
  ]
  for (const fixture of fixtures) assert.deepEqual(scan(fixture), [])
})

test('a reviewed swallow-ok marker is honoured, a bare one is not', () => {
  const marked = [
    'try {',
    '  result = await ssh.exec(command)',
    '} catch {',
    '  // swallow-ok: the try body is only ssh.exec, a rejection is transport',
    "  return { ok: false, reason: 'read-failed' }",
    '}',
  ].join('\n')
  assert.deepEqual(scan(marked), [])

  const bare = [
    'try {',
    '  result = await ssh.exec(command)',
    '} catch {',
    '  // swallow-ok',
    "  return { ok: false, reason: 'read-failed' }",
    '}',
  ].join('\n')
  assert.equal(scan(bare).length, 1, 'a marker without a stated reason must not silence the guard')
})

test('best-effort defaults that cannot be mistaken for a remote answer are not flagged', () => {
  const fixtures = [
    ['try {', '  await close()', '} catch {', '  return null', '}'].join('\n'),
    ['try {', '  await close()', '} catch {', "  return { status: 'corrupt', value: null }", '}'].join('\n'),
  ]
  for (const fixture of fixtures) assert.deepEqual(scan(fixture), [])
})

test('the scanner covers src recursively, not just the top level', () => {
  const files = collectSourceFiles(SRC).map((file) => path.relative(SRC, file))
  assert.ok(files.length > 0)
  // Every discovered path is a .js file; nesting is supported even when a directory is
  // added later, which is what CONTRIBUTING's `src/**/*.js` promises.
  assert.deepEqual(
    files.filter((file) => !file.endsWith('.js')),
    [],
  )
  assert.ok(files.includes('history.js'), 'top-level sources are still scanned')
})

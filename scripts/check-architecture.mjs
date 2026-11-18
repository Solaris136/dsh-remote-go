// Structural gates that stay cheap and low-noise: file length, the god-`ctx` ban, barrels,
// runtime-state ownership, the client module size, and the ratchet that keeps each of them from
// creeping back up. Node built-ins only, no AST: the rules are decided on "comments blanked,
// string bodies masked" text, which is enough for these shapes and is what makes the script fast
// enough to run before prettier in `pnpm gate` (design-contract §4).
//
// Exit codes: 0 = all rules within budget, 1 = at least one violation.
// `--update` lowers the recorded numbers to the actual values; it can never raise one, because a
// gate that widens itself is not a gate.
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const budgetPath = path.join(root, 'scripts', 'architecture-budget.json')
const SRC = path.join(root, 'src')
const CLIENT_SRC = path.join(root, 'client', 'src')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', 'artifacts', 'e2e', '.pnpm-store'])

const problems = []
const warnings = []
let checks = 0
const pass = () => {
  checks += 1
}
const update = process.argv.includes('--update')
const help = process.argv.includes('--help') || process.argv.includes('-h')

if (help) {
  console.log(`[check-architecture] usage: node scripts/check-architecture.mjs [--update]
  --update   lower the recorded budget values to the measured ones (never raises one)`)
  process.exit(0)
}

// ---- text helpers (same semantics as test/helpers/source-scan.ts) ---------------------------

/** Blank comments but keep string bodies and every newline (line numbers must not move). */
function stripComments(source) {
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

/** Replace string/template bodies with spaces, keeping newlines so line numbers stay valid. */
function maskStrings(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char !== "'" && char !== '"' && char !== '`') {
      out += char
      index += 1
      continue
    }
    out += char
    index += 1
    while (index < source.length) {
      const current = source[index]
      if (current === '\\') {
        out += '  '
        index += 2
        continue
      }
      if (current === char) {
        out += char
        index += 1
        break
      }
      out += current === '\n' ? '\n' : ' '
      index += 1
    }
  }
  return out
}

/** The text structure is decided on: no comments, no string bodies, newlines untouched. */
const structure = (text) => maskStrings(stripComments(text))

const lineOf = (text, index) => text.slice(0, index).split('\n').length
const relOf = (file) => path.relative(root, file).replace(/\\/g, '/')

/** Physical line count: a trailing newline is a terminator, not an extra line. */
function countLines(text) {
  if (text === '') return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

async function walk(dir, accept, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out // a tree that does not exist yet (client/src before P3) is not a failure
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, accept, out)
      continue
    }
    if (entry.isFile() && accept(entry.name)) out.push(full)
  }
  return out
}

/** `.ts` source only: a `.js` beside a `.ts` is a build artifact (P1e: artifacts live in dist/). */
const sourceFiles = (dir) => walk(dir, (name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))

/** The files of one tree, counted as checks: the OK line then reports real coverage, not 5 rules. */
async function sources(dir) {
  const files = await sourceFiles(dir)
  checks += files.length
  return files
}

// ---- budget ---------------------------------------------------------------------------------

const rawBudget = await readFile(budgetPath, 'utf8').catch(() => null)
if (rawBudget === null) {
  console.error(
    `[check-architecture] FAIL: scripts/architecture-budget.json — missing — every rule needs a recorded budget`,
  )
  process.exit(1)
}
let budget
try {
  budget = JSON.parse(rawBudget)
} catch (error) {
  console.error(`[check-architecture] FAIL: scripts/architecture-budget.json — unreadable — ${error.message}`)
  process.exit(1)
}
const rules = budget.rules ?? {}
for (const name of ['fileLength', 'clientFileLength', 'godCtxParams', 'barrelReExports', 'statusAssignments']) {
  if (!rules[name]) {
    console.error(`[check-architecture] FAIL: scripts/architecture-budget.json — rule — "${name}" has no budget entry`)
    process.exit(1)
  }
}
const measured = {}

/**
 * Compare one rule's measured violations with its recorded budget.
 *
 * The ratchet only turns one way: more than the budget fails with every site named, fewer than the
 * budget warns that the number can be lowered, and a budget above zero still reports the sites it
 * is covering so the allowance is never invisible.
 */
function ratchet(rule, actual, allowed, sites) {
  measured[rule] = actual
  if (actual > allowed) {
    for (const site of sites) problems.push(site)
    problems.push(
      `${rule} — ratchet — ${actual} violation(s), budget ${allowed} (+${actual - allowed}); the code must be split/lowered, never the budget raised`,
    )
    return
  }
  if (actual > 0) for (const site of sites) warnings.push(`${site} (allowed by the ${rule} budget of ${allowed})`)
  if (actual < allowed) {
    warnings.push(`${rule}: ${actual} violation(s), budget ${allowed} — lower the budget with \`--update\``)
  }
  pass()
}

// ---- A: src file length ---------------------------------------------------------------------

async function ruleFileLength() {
  const { limit, exceptions = {} } = rules.fileLength
  const allowed = Number(rules.fileLength.violations) || 0
  const files = await sources(SRC)
  const sites = []
  let over = 0
  const seen = new Set()
  for (const file of files) {
    const rel = relOf(file)
    const lines = countLines(await readFile(file, 'utf8'))
    const exception = exceptions[rel]
    if (!exception) {
      if (lines > limit) {
        over += 1
        sites.push(
          `${rel}:${limit + 1} — file length — ${lines} lines exceeds ${limit}; split the module (the budget has no exception for it)`,
        )
      }
      continue
    }
    seen.add(rel)
    const ceiling = Number(exception.maxLines) || 0
    if (lines > ceiling) {
      over += 1
      sites.push(
        `${rel}:${ceiling + 1} — file length — ${lines} lines exceeds its recorded ceiling of ${ceiling}; lower the file or raise the ceiling in a reviewed budget edit`,
      )
    } else if (lines < ceiling) {
      warnings.push(`${rel}: ${lines} lines is below its recorded ceiling ${ceiling} — lower it with \`--update\``)
    }
    if (lines <= limit)
      warnings.push(`${rel}: ${lines} lines is now within ${limit} — drop its exception with \`--update\``)
  }
  for (const rel of Object.keys(exceptions)) {
    if (!seen.has(rel)) warnings.push(`fileLength: the exception for ${rel} matches no file — drop it from the budget`)
  }
  ratchet('fileLength', over, allowed, sites)
}

// ---- B: client module length ----------------------------------------------------------------

async function ruleClientFileLength() {
  const { limit } = rules.clientFileLength
  const allowed = Number(rules.clientFileLength.violations) || 0
  const files = await sources(CLIENT_SRC)
  const sites = []
  let over = 0
  for (const file of files) {
    const rel = relOf(file)
    const lines = countLines(await readFile(file, 'utf8'))
    if (lines <= limit) continue
    over += 1
    sites.push(`${rel}:${limit + 1} — client file length — ${lines} lines exceeds ${limit}; split the module`)
  }
  ratchet('clientFileLength', over, allowed, sites)
}

// ---- C: god-ctx ban -------------------------------------------------------------------------
//
// The gate recognises exactly two type names, `Ctx` and `ConnectCtx`, because those are the names
// `src/context.ts` exports (design-contract §4.3: keep the type name in one place, and the rule
// only has to know that one). Renaming the alias would silently switch the rule off, which is why
// the six allowed entries are listed by *function name* in the budget: a rename there is a
// reviewed diff, not a quiet escape.

/** A function declaration whose first parameter is typed as the whole context. */
const FN_DECL =
  /(?:^|[^\w$.])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*(ConnectCtx|Ctx)\b/dg
/** The same shape as an arrow/function expression assigned to a name. */
const FN_EXPR =
  /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*:\s*(ConnectCtx|Ctx)\b/dg
/** Every `name: Ctx` occurrence; the ones the two patterns above did not claim are inspected too. */
const TYPED_CTX = /([A-Za-z_$][\w$]*)\s*:\s*(ConnectCtx|Ctx)\b/dg

/**
 * The `(` that opens the parameter list a position belongs to.
 *
 * A brace or a `;` at the same depth ends the search: a `name: Ctx` inside a type literal or a
 * block is not a parameter (`interface Options { handler: Ctx }` must not fail the gate).
 * @param code - the comment- and string-masked source.
 * @param index - the position of the parameter name.
 * @returns the opener's index, or -1 when the position is not inside a parameter list.
 */
function enclosingParen(code, index) {
  let depth = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = code[cursor]
    if (char === ')') depth += 1
    else if (char === '(') {
      if (depth === 0) return cursor
      depth -= 1
    } else if (char === '{' || char === '}' || char === ';') {
      if (depth === 0) return -1
    }
  }
  return -1
}

/** Every whole-context parameter in one file, attributed to a function name when possible. */
function godCtxSites(rel, text) {
  const code = structure(text)
  const attributed = new Set()
  const sites = []
  for (const pattern of [FN_DECL, FN_EXPR]) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1]
      const type = match[3]
      attributed.add(match.indices[2][0])
      sites.push({ rel, line: lineOf(code, match.indices[2][0]), name, type })
    }
  }
  for (const match of code.matchAll(TYPED_CTX)) {
    const start = match.indices[1][0]
    if (attributed.has(start)) continue
    const before = code.slice(0, start).replace(/\s+$/, '')
    // `): Ctx` is a return type and `= Ctx` is a type alias side: neither is a parameter.
    if (before.endsWith(')') || before.endsWith('=')) continue
    if (!before.endsWith('(') && !before.endsWith(',')) continue
    if (enclosingParen(code, start) < 0) continue
    sites.push({ rel, line: lineOf(code, start), name: null, type: match[2] })
  }
  return sites
}

async function ruleGodCtx() {
  const entries = new Set(rules.godCtxParams.entries ?? [])
  const allowed = Number(rules.godCtxParams.violations) || 0
  const files = await sources(SRC)
  const seenEntries = new Set()
  const sites = []
  let violations = 0
  for (const file of files) {
    for (const site of godCtxSites(relOf(file), await readFile(file, 'utf8'))) {
      if (site.name !== null && entries.has(site.name)) {
        seenEntries.add(site.name)
        continue
      }
      violations += 1
      const who = site.name === null ? 'a parameter' : `\`${site.name}\``
      sites.push(
        `${site.rel}:${site.line} — god-ctx — ${who} takes the whole context (${site.type}); only the six orchestration entries may (see godCtxParams.entries in the budget)`,
      )
    }
  }
  for (const name of entries) {
    if (!seenEntries.has(name))
      warnings.push(`godCtxParams: the entry \`${name}\` matches no function — drop it from the budget`)
  }
  ratchet('godCtxParams', violations, allowed, sites)
}

// ---- D: barrel ban --------------------------------------------------------------------------

/**
 * `export … from` re-exports.
 *
 * The rule counts *statements*, not file names: `src/proxy/index.ts` is the same-origin proxy's
 * assembly module (it exports `createRemoteProxy`), not a barrel, and it must keep existing.
 */
const REEXPORT = /(?:^|\n)[ \t]*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\b/g

async function ruleBarrels() {
  const allowed = Number(rules.barrelReExports.violations) || 0
  const files = await sources(SRC)
  const sites = []
  let found = 0
  for (const file of files) {
    const rel = relOf(file)
    const code = structure(await readFile(file, 'utf8'))
    for (const match of code.matchAll(REEXPORT)) {
      found += 1
      // The pattern may start on the previous line (it consumes the newline before `export`).
      const keyword = match.index + match[0].indexOf('export')
      sites.push(
        `${rel}:${lineOf(code, keyword)} — barrel — \`export … from\` re-export; import the owner module directly (this counts statements, so src/proxy/index.ts as an implementation module is not a barrel)`,
      )
    }
  }
  ratchet('barrelReExports', found, allowed, sites)
}

// ---- E: runtime state ownership -------------------------------------------------------------

/** `.status =` but not `.status ===` (the naive regex over-counted 22 comparison lines). */
const STATUS_ASSIGN = /\.status\s*=(?!=)/g

/** The state writes the owner is allowed; reported in the OK line so the allowance stays visible. */
let ownedStatusWrites = 0

async function ruleStatusAssignments() {
  const owners = new Set(rules.statusAssignments.owners ?? [])
  const allowed = Number(rules.statusAssignments.violations) || 0
  const files = await sources(SRC)
  const sites = []
  let violations = 0
  let owned = 0
  for (const file of files) {
    const rel = relOf(file)
    const code = structure(await readFile(file, 'utf8'))
    const hits = [...code.matchAll(STATUS_ASSIGN)]
    if (hits.length === 0) continue
    if (owners.has(rel)) {
      owned += hits.length
      continue
    }
    for (const hit of hits) {
      violations += 1
      sites.push(
        `${rel}:${lineOf(code, hit.index)} — runtime state ownership — \`.status =\` outside the state owner (${[...owners].join(', ')}); write it through the FSM dispatch instead`,
      )
    }
  }
  if (owned > 0) ownedStatusWrites = owned
  ratchet('statusAssignments', violations, allowed, sites)
}

// ---- run ------------------------------------------------------------------------------------

await ruleFileLength()
await ruleClientFileLength()
await ruleGodCtx()
await ruleBarrels()
await ruleStatusAssignments()

if (update) {
  const lowered = []
  const lowerNumber = (label, current, actual) => {
    const value = Math.min(Number(current) || 0, actual)
    if (value !== Number(current)) lowered.push(`${label} ${Number(current)} -> ${value}`)
    return value
  }
  rules.fileLength.violations = lowerNumber('fileLength.violations', rules.fileLength.violations, measured.fileLength)
  rules.clientFileLength.violations = lowerNumber(
    'clientFileLength.violations',
    rules.clientFileLength.violations,
    measured.clientFileLength,
  )
  rules.godCtxParams.violations = lowerNumber(
    'godCtxParams.violations',
    rules.godCtxParams.violations,
    measured.godCtxParams,
  )
  rules.barrelReExports.violations = lowerNumber(
    'barrelReExports.violations',
    rules.barrelReExports.violations,
    measured.barrelReExports,
  )
  rules.statusAssignments.violations = lowerNumber(
    'statusAssignments.violations',
    rules.statusAssignments.violations,
    measured.statusAssignments,
  )
  // The recorded ceiling tracks the file, and an exception whose file is back within the limit (or
  // gone) is dropped: an allowance that no longer covers anything is the entry that never expires.
  const exceptions = rules.fileLength.exceptions ?? {}
  for (const [rel, exception] of Object.entries(exceptions)) {
    const full = path.join(root, rel)
    if (!existsSync(full)) {
      delete exceptions[rel]
      lowered.push(`fileLength.exceptions["${rel}"] removed (no such file)`)
      continue
    }
    const lines = countLines(await readFile(full, 'utf8'))
    if (lines <= Number(rules.fileLength.limit)) {
      delete exceptions[rel]
      lowered.push(`fileLength.exceptions["${rel}"] removed (${lines} lines is within ${rules.fileLength.limit})`)
      continue
    }
    const ceiling = lowerNumber(`fileLength.exceptions["${rel}"].maxLines`, exception.maxLines, lines)
    exception.maxLines = ceiling
  }
  // Written through prettier so the file stays `prettier --check`-clean: the gate runs prettier
  // right after this script, and an `--update` that leaves a formatting diff would fail the gate it
  // was meant to repair. Prettier is a devDependency (scripts/), not a runtime one.
  const serialized = `${JSON.stringify(budget, null, 2)}\n`
  let formatted = serialized
  try {
    const prettier = await import('prettier')
    const options = (await prettier.resolveConfig(budgetPath)) ?? {}
    formatted = await prettier.format(serialized, { ...options, filepath: budgetPath })
  } catch {
    // swallow-ok: no prettier resolved means this is running outside the repo's dev tooling
  }
  if (formatted !== rawBudget) await writeFile(budgetPath, formatted, 'utf8')
  for (const entry of lowered) console.log(`[check-architecture] updated: ${entry}`)
  if (lowered.length === 0) console.log('[check-architecture] updated: nothing to lower')
  console.log(
    `[check-architecture] budgets: ${Object.entries(measured)
      .map(([rule, value]) => `${rule}=${value}`)
      .join(' ')}`,
  )
  process.exit(0)
}

for (const message of warnings) console.warn(`[check-architecture] WARN: ${message}`)
if (problems.length > 0) {
  for (const message of problems) console.error(`[check-architecture] FAIL: ${message}`)
  console.error(`[check-architecture] ${problems.length} problem(s) found; ${checks} check(s) passed`)
  process.exit(1)
}
console.log(
  `[check-architecture] OK: ${checks} checks${ownedStatusWrites > 0 ? ` (${ownedStatusWrites} runtime-state write(s) inside ${(rules.statusAssignments.owners ?? []).join(', ')})` : ''}`,
)

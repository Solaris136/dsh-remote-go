// Structural gates that stay cheap and low-noise: file length, the god-`ctx` ban, barrels,
// runtime-state ownership, the client module size, and the ratchet that keeps each of them from
// creeping back up. Everything but the god-`ctx` rule is decided on "comments blanked, string
// bodies masked" text, which is enough for those shapes and is what makes the rest of the script
// fast enough to run before prettier in `pnpm gate` (design-contract §4). The god-`ctx` rule uses
// the TypeScript compiler API instead, because a text scan cannot see through a type alias.
//
// Exit codes: 0 = all rules within budget, 1 = at least one violation.
// `--update` lowers the recorded numbers to the actual values; it can never raise one, because a
// gate that widens itself is not a gate.
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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

// ---- stage / terminal stage -----------------------------------------------------------------
//
// `stage` is the phase this tree is reviewed at; `terminalStage` is the phase it must arrive at.
// The pair is what makes `terminalStage` more than a comment: at the terminal stage the budget may
// not carry a single exemption, so the tree has to *arrive* clean instead of declaring itself clean.
const STAGE_PATTERN = /^P[1-9]$/
const stageNumber = (value) => Number(String(value).slice(1))
const stage = budget.stage
const terminalStage = budget.terminalStage
if (typeof stage !== 'string' || !STAGE_PATTERN.test(stage)) {
  console.error(
    `[check-architecture] FAIL: scripts/architecture-budget.json — stage — must be a stage such as "P6" (found ${JSON.stringify(stage)}); without it the terminal stage cannot be enforced`,
  )
  process.exit(1)
}
if (typeof terminalStage !== 'string' || !STAGE_PATTERN.test(terminalStage)) {
  console.error(
    `[check-architecture] FAIL: scripts/architecture-budget.json — terminalStage — must be a stage such as "P7" (found ${JSON.stringify(terminalStage)})`,
  )
  process.exit(1)
}
if (stageNumber(terminalStage) < stageNumber(stage)) {
  console.error(
    `[check-architecture] FAIL: scripts/architecture-budget.json — terminalStage — ${terminalStage} is before stage ${stage}; a terminal state cannot already be behind the tree`,
  )
  process.exit(1)
}
const atTerminalStage = stage === terminalStage
const p7Todo = budget.p7Todo ?? []
if (!Array.isArray(p7Todo) || p7Todo.some((item) => typeof item !== 'string' || item.trim() === '')) {
  console.error(
    '[check-architecture] FAIL: scripts/architecture-budget.json — p7Todo — must be an array of non-empty strings naming the work still owed before the terminal stage',
  )
  process.exit(1)
}

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
// The rule is decided on types, not on text: `typescript` is a devDependency, so this script builds
// the same program `tsc` does and asks the checker which slice each parameter really needs. The old
// text scan only recognised the two *spellings* `Ctx` and `ConnectCtx`, which meant a one-line alias
// (`type PipelineCtx = HostState & … & Store`) or a copied intersection switched the rule off while
// the gate kept saying zero violations.
//
// A parameter violates when its type — aliases, `Pick<>`s and intersections expanded by the
// checker — is assignable to **all six** slices `src/context.ts` exports (`HostState`, `Config`,
// `Transport`, `RemoteDeps`, `Reporter`, `Store`). Five of them (`WatchdogCtx`) is legal: that is
// what the staging calls "not the god context". The allowed sites are listed per
// `{ file, function, reason }` in the budget, so two functions with the same name are not
// interchangeable: an entry whose file does not carry the violating function is an error.

const SLICES = ['HostState', 'Config', 'Transport', 'RemoteDeps', 'Reporter', 'Store']

/** The repo's own compiler options, so the gate resolves exactly what `tsc` resolves. */
function architectureProgram(fileNames) {
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  if (configFile.error) {
    problems.push(
      `tsconfig.json:${''} — god-ctx — unreadable (${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}); the type gate cannot run`,
    )
    return null
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, root)
  return ts.createProgram({ rootNames: fileNames, options: { ...parsed.options, noEmit: true } })
}

/** The six slice types, resolved through the checker (so a renamed export fails here, not silently). */
function sliceTypes(checker, program) {
  const contextFile = program.getSourceFile(path.join(root, 'src', 'context.ts'))
  if (contextFile === undefined) {
    problems.push('src/context.ts — god-ctx — missing; the six slice types cannot be resolved')
    return null
  }
  const moduleSymbol = checker.getSymbolAtLocation(contextFile)
  if (moduleSymbol === undefined) {
    problems.push('src/context.ts — god-ctx — the module has no symbol; the six slice types cannot be resolved')
    return null
  }
  const exported = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]))
  const types = []
  for (const name of SLICES) {
    const symbol = exported.get(name)
    if (symbol === undefined) {
      problems.push(`src/context.ts — god-ctx — the slice \`${name}\` is not exported; the gate cannot expand it`)
      return null
    }
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    types.push({ name, type: checker.getDeclaredTypeOfSymbol(resolved) })
  }
  return types
}

/** `Pick<>`/generics can hide behind a type parameter: measure the constraint, not the parameter. */
function constrain(checker, type) {
  return type.isTypeParameter?.() === true ? (checker.getBaseConstraintOfType(type) ?? type) : type
}

/**
 * Which of the six slices a type is assignable to.
 *
 * A union is inspected member by member (a `Ctx | undefined` is still a god context in one branch);
 * an intersection needs no special case, because the checker already sees `Ctx & X` as a subtype of
 * every slice. `never`/`unknown` are excluded so an accidental bottom type cannot fake a violation.
 */
function coveredSlices(checker, type, slices) {
  const candidates = type.isUnion?.() === true ? type.types : [type]
  let best = []
  for (const candidate of candidates) {
    const measured = constrain(checker, candidate)
    if (measured.flags & (ts.TypeFlags.Never | ts.TypeFlags.Unknown | ts.TypeFlags.Any)) continue
    const covered = slices.filter((slice) => checker.isTypeAssignableTo(measured, slice.type))
    if (covered.length > best.length) best = covered
  }
  return best
}

/** The declared name of a function-like node, or its nearest named parent, or `<anonymous>`. */
function functionName(node) {
  if (node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  if (parent === undefined) return '<anonymous>'
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent)) return parent.name.getText()
  if (ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) return parent.left.text
  return '<anonymous>'
}

/** Every whole-context parameter of one program, as `[{ rel, line, name, slices }]`. */
async function godCtxSites(files) {
  const program = architectureProgram(files.map((file) => file))
  if (program === null) return []
  const checker = program.getTypeChecker()
  const slices = sliceTypes(checker, program)
  if (slices === null) return []
  const srcRoot = `${SRC}${path.sep}`
  const sites = []
  for (const sourceFile of program.getSourceFiles()) {
    if (!path.resolve(sourceFile.fileName).startsWith(path.resolve(srcRoot))) continue
    if (sourceFile.isDeclarationFile) continue
    const rel = relOf(sourceFile.fileName)
    const visit = (node) => {
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          const type = checker.getTypeAtLocation(parameter)
          const covered = coveredSlices(checker, type, slices)
          if (covered.length < SLICES.length) continue
          const { line } = sourceFile.getLineAndCharacterOfPosition(parameter.getStart(sourceFile))
          sites.push({
            rel,
            line: line + 1,
            name: functionName(node),
            type: slices.map((slice) => slice.name).join(' & '),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sites
}

async function ruleGodCtx() {
  const entries = rules.godCtxParams.entries ?? []
  const allowed = Number(rules.godCtxParams.violations) || 0
  const files = await sources(SRC)
  const seen = new Set()
  const sites = []
  let violations = 0

  const entryKey = (file, fn) => `${file}::${fn}`
  const registered = new Set()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(
        `architecture-budget.json — godCtxParams.entries — every entry must be { file, function, reason } (found ${JSON.stringify(entry)})`,
      )
      continue
    }
    if (typeof entry.file !== 'string' || !/^src\/.+\.ts$/.test(entry.file)) {
      problems.push(
        `architecture-budget.json — godCtxParams.entries — "${entry.function}" has no \`file\` (src/…/*.ts); an entry without its file would exempt every function of that name`,
      )
      continue
    }
    if (typeof entry.function !== 'string' || entry.function === '') {
      problems.push(
        `architecture-budget.json — godCtxParams.entries — ${entry.file} has an entry without a function name`,
      )
      continue
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      problems.push(
        `architecture-budget.json — godCtxParams.entries — ${entry.file}#${entry.function} needs a reason of at least 20 characters`,
      )
      continue
    }
    const key = entryKey(entry.file, entry.function)
    if (registered.has(key)) {
      problems.push(
        `architecture-budget.json — godCtxParams.entries — duplicate entry for ${entry.file}#${entry.function}`,
      )
      continue
    }
    registered.add(key)
  }

  for (const site of await godCtxSites(files)) {
    const key = entryKey(site.rel, site.name)
    if (registered.has(key)) {
      seen.add(key)
      continue
    }
    violations += 1
    sites.push(
      `${site.rel}:${site.line} — god-ctx — \`${site.name}\` takes the whole context (${site.type}); narrow it to the slices the body reads, or register { file, function, reason } in godCtxParams.entries`,
    )
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const key = entryKey(entry.file, entry.function)
    if (seen.has(key)) continue
    // A stale or misspelled entry is a failure, not a warning: it is an exemption that would keep
    // covering a function that no longer exists (or a same-named one in another file).
    problems.push(
      `architecture-budget.json — godCtxParams.entries — "${entry.file}#${entry.function}" matches no whole-context parameter; the function was narrowed/renamed/moved, so drop or fix the entry (a wrong \`file\` must not exempt a same-named function)`,
    )
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

if (atTerminalStage) {
  for (const rel of Object.keys(rules.fileLength.exceptions ?? {})) {
    problems.push(
      `scripts/architecture-budget.json — terminal stage — fileLength has an exception for ${rel}; ${terminalStage} is the terminal stage, so every exemption must already be gone (split the file instead)`,
    )
  }
  for (const [name, rule] of Object.entries(rules)) {
    const value = Number(rule?.violations) || 0
    if (value > 0) {
      problems.push(
        `scripts/architecture-budget.json — terminal stage — "${name}.violations" is ${value}; ${terminalStage} is the terminal stage, so every violation budget must be 0`,
      )
    }
  }
  for (const item of p7Todo) {
    problems.push(`scripts/architecture-budget.json — terminal stage — p7Todo still names outstanding work: ${item}`)
  }
} else if (p7Todo.length === 0) {
  warnings.push(
    `p7Todo is empty while stage ${stage} is not terminal (${terminalStage}); record what is still owed before ${terminalStage}`,
  )
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

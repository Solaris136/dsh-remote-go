// The type policy of decision A in .agents/refactor/DECISIONS.md, executable: no explicit `any`,
// no `as any`, no `as unknown as X` double assertion, and no suppression directive that has not
// been registered in types/any-allowlist.json.
//
// The TypeScript compiler API is the source of truth, not a grep: `any` mentioned in a comment or
// a string literal is not a type, and `'// @ts-ignore'` inside a fixture is not a directive. The
// AST catches `any` and the assertions; comments are read through the compiler's own scanner, so
// no string masking is needed here either.
//
// Scope: src/**/*.ts, index.ts, types/**/*.d.ts and client/src/**/*.ts (that directory arrives in
// P3; its absence is not an error). test/**, scripts/** and e2e/** stay out: a fixture may need a
// loose type, and the allowlist is meant for product code. A `.d.ts` next to a source under `src/`
// is not scanned - ambient declarations belong in `types/`, which is.
//
// Usage:
//   node scripts/check-types.mjs             check; exits 1 on any problem
//   node scripts/check-types.mjs --update    re-anchor drifted entries by their `match`, drop the
//                                            stale ones. It NEVER adds an entry: a new hit has to
//                                            be registered by hand with a reason, which is the
//                                            whole point of the gate.
//   node scripts/check-types.mjs --stage P7  warn about `until` entries that have come due
//                                            (a warning, not a failure: it must not block the
//                                            stage the entry is supposed to disappear in).
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// fileURLToPath, not URL#pathname: pathname percent-encodes characters such as the
// space in "C:\Work\my repo", which made every gate resolve the wrong repository root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const ALLOWLIST_FILE = 'types/any-allowlist.json'
const SOURCE_DIRS = ['src', 'client/src']
const SOURCE_FILES = ['index.ts']
const DECLARATION_DIRS = ['types']
const MAX_SNIPPET = 96
const MIN_REASON_LENGTH = 12
const MIN_EXPECT_ERROR_WORDS = 6

const SECTIONS = ['any', 'doubleAssertion', 'suppressions']
const SECTION_OF_KIND = {
  any: 'any',
  'as-any': 'any',
  'double-assertion': 'doubleAssertion',
  suppression: 'suppressions',
}
const SECTION_LABEL = { any: '`any`', doubleAssertion: 'a double assertion', suppressions: '`@ts-expect-error`' }
const ADVICE = {
  any: 'unlisted; narrow it (unknown + a type guard, a generic, or a declared interface) or register it in types/any-allowlist.json with a reason',
  'as-any':
    'unlisted; declare the member in a local .d.ts instead, or register the assertion in types/any-allowlist.json with a reason',
  'double-assertion':
    'unlisted; `as unknown as X` switches off both directions of assignability, so add a type guard or extend the local declaration, or register it in types/any-allowlist.json with a reason',
  suppression: 'unlisted; register the directive in types/any-allowlist.json under "suppressions" with a reason',
}

const ALLOWLIST_KEY = /^[^:]+:[1-9][0-9]*$/
const STAGE_PATTERN = /^P[1-9]$/
const ENTRY_FIELDS = new Set(['reason', 'match', 'until'])
const TOP_LEVEL_FIELDS = new Set(['$schema', 'version', 'policy', 'any', 'doubleAssertion', 'suppressions'])
// TypeScript only honours a directive that opens the comment, and so does this scan:
// `// the old @ts-ignore is gone` is documentation, not a suppression.
const DIRECTIVE = /^(?:\/|\*)*\s*@ts-(ignore|expect-error|nocheck)\b(.*)$/

// ---- arguments -------------------------------------------------------------------------
const argv = process.argv.slice(2)
const update = argv.includes('--update')
const stageIndex = argv.indexOf('--stage')
const stage = stageIndex === -1 ? null : (argv[stageIndex + 1] ?? '')

function fail(message) {
  console.error(`[check-types] FAIL: ${message}`)
  process.exit(1)
}

for (const [index, argument] of argv.entries()) {
  if (argument === '--update' || argument === '--stage') continue
  if (argv[index - 1] === '--stage') continue
  fail(`unknown argument ${JSON.stringify(argument)}; usage: node scripts/check-types.mjs [--update] [--stage P7]`)
}
if (stage !== null && !STAGE_PATTERN.test(stage)) {
  fail(`--stage expects a stage such as P7 (found ${JSON.stringify(stage)})`)
}

// ---- findings, problems and their positions ---------------------------------------------
/** @type {{file: string, line: number, col: number, rule: string, detail: string}[]} */
const problems = []
/** @type {string[]} */
const warnings = []

function problem(file, line, col, rule, detail) {
  problems.push({ file, line, col, rule, detail })
}

const relative = (file) => path.relative(root, file).replace(/\\/g, '/')
const fileOf = (key) => key.slice(0, key.lastIndexOf(':'))
const lineOfKey = (key) => Number(key.slice(key.lastIndexOf(':') + 1))

function snippetOf(line) {
  const text = (line ?? '').trim()
  return text.length <= MAX_SNIPPET ? text : `${text.slice(0, MAX_SNIPPET - 1)}…`
}

// ---- scan scope -------------------------------------------------------------------------
/**
 * Repository-relative TypeScript files under `dir`. A missing directory is not an error:
 * `client/src` only exists once P3 lands, and `types/` arrived with the SSH declarations.
 */
async function collectSources(dir, { declarations = false } = {}) {
  const found = []
  const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...(await collectSources(rel, { declarations })))
      continue
    }
    if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) continue
    if (!declarations && entry.name.endsWith('.d.ts')) continue
    found.push(rel)
  }
  return found
}

const scanned = new Set()
for (const dir of SOURCE_DIRS) for (const file of await collectSources(dir)) scanned.add(file)
for (const file of SOURCE_FILES) if (ts.sys.fileExists(path.join(root, file))) scanned.add(file)
// Hand-written ambient declarations count too: an `any` there poisons every caller.
for (const dir of DECLARATION_DIRS)
  for (const file of await collectSources(dir, { declarations: true })) scanned.add(file)
const rootNames = [...scanned].sort().map((file) => path.join(root, file))
if (rootNames.length === 0)
  fail('no TypeScript sources were found; the scan scope is src/, index.ts, types/ and client/src')

// compilerOptions come from tsconfig.json, the FILE LIST is ours on purpose: tsconfig "include"
// does not cover client/src until P3, and a program without the client half would pass silently.
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
if (configFile.error) {
  fail(`tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, root)
const program = ts.createProgram({
  rootNames,
  options: { ...parsed.options, noEmit: true, allowJs: false, checkJs: false, skipLibCheck: true },
})
const own = new Set(rootNames.map((file) => path.resolve(file)))

// ---- AST scan ---------------------------------------------------------------------------
const ANY_KEYWORD = ts.SyntaxKind.AnyKeyword
const AS_EXPRESSION = ts.SyntaxKind.AsExpression
const TYPE_ASSERTION = ts.SyntaxKind.TypeAssertionExpression
const UNKNOWN_KEYWORD = ts.SyntaxKind.UnknownKeyword
const isAssertion = (node) => node.kind === AS_EXPRESSION || node.kind === TYPE_ASSERTION

/** @type {{file: string, line: number, col: number, kind: string, snippet: string, directive?: string, words?: number}[]} */
const findings = []
/** @type {Map<string, string[]>} */
const sourceLines = new Map()

/**
 * Walk one source file. The parent is threaded through the walk instead of read from
 * `node.parent`: parent pointers are filled in by the binder, which only runs once a type checker
 * exists, and this gate only needs the parse tree.
 */
function scanAst(sourceFile, file) {
  const lines = sourceFile.text.split('\n')
  const locate = (node, kind) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return {
      file,
      line: line + 1,
      col: character + 1,
      kind,
      snippet: snippetOf(lines[line]),
    }
  }
  const visit = (node, parent) => {
    if (node.kind === ANY_KEYWORD) {
      // `x as any` also produces an AnyKeyword for the asserted type: report the assertion only,
      // so one construct needs one allowlist key and the column points at the expression.
      const insideAssertion = parent !== undefined && isAssertion(parent) && parent.type === node
      if (!insideAssertion) findings.push(locate(node, 'any'))
    } else if (isAssertion(node)) {
      if (node.type.kind === ANY_KEYWORD) findings.push(locate(node, 'as-any'))
      else if (
        isAssertion(node.expression) &&
        (node.expression.type.kind === ANY_KEYWORD || node.expression.type.kind === UNKNOWN_KEYWORD)
      )
        findings.push(locate(node, 'double-assertion'))
    }
    ts.forEachChild(node, (child) => visit(child, node))
  }
  visit(sourceFile, undefined)
}

/**
 * Suppression directives are comments, so there is no AST node to match. The compiler's scanner
 * is still the parser here: a `'// @ts-ignore'` string literal is a string token, never a comment.
 */
function scanDirectives(sourceFile, file) {
  const text = sourceFile.text
  const lines = text.split('\n')
  const variant = /\.[jt]sx$/.test(file) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, variant, text)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    const start = scanner.getTokenPos()
    const comment = text.slice(start, scanner.getTextPos())
    const match = DIRECTIVE.exec(comment)
    if (match === null) continue
    // `/* @ts-ignore */` is honoured by tsc as well; drop the closing marker from the reason.
    const reason = match[2].replace(/\s*\*\/\s*$/, '')
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start + comment.indexOf('@ts-'))
    findings.push({
      file,
      line: line + 1,
      col: character + 1,
      kind: 'suppression',
      directive: match[1],
      words: reason.trim().split(/\s+/).filter(Boolean).length,
      snippet: snippetOf(lines[line]),
    })
  }
}

for (const sourceFile of program.getSourceFiles()) {
  // lib.*.d.ts and @types/* are not ours; without this filter the report drowns in their `any`.
  if (!own.has(path.resolve(sourceFile.fileName))) continue
  const file = relative(sourceFile.fileName)
  sourceLines.set(file, sourceFile.text.split('\n'))
  scanAst(sourceFile, file)
  scanDirectives(sourceFile, file)
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col)

// ---- allowlist --------------------------------------------------------------------------
// The key is `<repo-relative-path>:<1-based-line>`; the entry carries the reason plus an optional
// `match` (a substring of that line) that turns a shifted line into a stale entry instead of
// silently allowing whatever moved into the old slot.
const allowlistText = await readFile(path.join(root, ALLOWLIST_FILE), 'utf8').catch(() => null)
if (allowlistText === null) {
  fail(`${ALLOWLIST_FILE} is missing; it must exist even when empty ({ "version": 1 } plus the three empty sections)`)
}

let allowlist
try {
  allowlist = JSON.parse(allowlistText)
} catch (error) {
  fail(`${ALLOWLIST_FILE} is not valid JSON: ${error.message}`)
}
if (allowlist === null || typeof allowlist !== 'object' || Array.isArray(allowlist)) {
  fail(`${ALLOWLIST_FILE} must contain a JSON object`)
}

const schemaProblem = (detail) => problem(ALLOWLIST_FILE, 0, 0, 'schema', detail)
for (const field of Object.keys(allowlist)) {
  if (!TOP_LEVEL_FIELDS.has(field)) schemaProblem(`unknown top-level key ${JSON.stringify(field)}`)
}
if (allowlist.version !== 1) schemaProblem(`"version" must be 1 (found ${JSON.stringify(allowlist.version)})`)
for (const field of ['$schema', 'policy']) {
  if (allowlist[field] !== undefined && typeof allowlist[field] !== 'string')
    schemaProblem(`"${field}" must be a string`)
}

/** section -> key -> entry; only structurally usable entries are kept (the rest is already reported). */
const listed = new Map(SECTIONS.map((section) => [section, new Map()]))
for (const section of SECTIONS) {
  const entries = allowlist[section]
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    schemaProblem(`"${section}" must be an object of "<path>:<line>" entries`)
    continue
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (!ALLOWLIST_KEY.test(key)) {
      schemaProblem(`"${section}" key ${JSON.stringify(key)} must be "<repo-relative-path>:<1-based-line>"`)
      continue
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      schemaProblem(`"${section}" entry ${JSON.stringify(key)} must be an object with a "reason"`)
      continue
    }
    for (const field of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(field))
        schemaProblem(`"${section}" entry ${JSON.stringify(key)} has unknown field ${JSON.stringify(field)}`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
      schemaProblem(
        `"${section}" entry ${JSON.stringify(key)} needs a "reason" of at least ${MIN_REASON_LENGTH} characters saying why a narrower type is impossible`,
      )
    }
    if (entry.match !== undefined && (typeof entry.match !== 'string' || entry.match === '')) {
      schemaProblem(`"${section}" entry ${JSON.stringify(key)}: "match" must be a non-empty string`)
    }
    if (entry.until !== undefined && (typeof entry.until !== 'string' || !STAGE_PATTERN.test(entry.until))) {
      schemaProblem(`"${section}" entry ${JSON.stringify(key)}: "until" must be a stage such as P7`)
    }
    listed.get(section).set(key, entry)
  }
}

// ---- bucket the findings by allowlist section --------------------------------------------
const grouped = new Map(SECTIONS.map((section) => [section, new Map()]))
for (const finding of findings) {
  if (finding.kind === 'suppression' && finding.directive !== 'expect-error') continue // zero tolerance
  const section = SECTION_OF_KIND[finding.kind]
  const key = `${finding.file}:${finding.line}`
  if (!grouped.get(section).has(key)) grouped.get(section).set(key, [])
  grouped.get(section).get(key).push(finding)
}

const lineOf = (file, line) => sourceLines.get(file)?.[line - 1]
const lineIncludes = (file, line, needle) => (lineOf(file, line) ?? '').includes(needle)

/** The single entry key of `section` whose line still contains `match`, or null when ambiguous. */
function reanchor(section, file, match) {
  let found = null
  for (const key of grouped.get(section).keys()) {
    if (fileOf(key) !== file) continue
    if (!lineIncludes(file, lineOfKey(key), match)) continue
    if (found !== null) return null // two candidate lines: never guess
    found = key
  }
  return found
}

// `--update` only ever re-anchors by `match` and prunes: a hit with no entry stays a failure, so a
// mistake in this script can never widen the gate.
const changes = []
if (update) {
  for (const section of SECTIONS) {
    const entries = listed.get(section)
    const kept = new Map()
    for (const [key, entry] of entries) {
      const hits = grouped.get(section).get(key)
      const matches =
        typeof entry.match !== 'string' ||
        (hits !== undefined && lineIncludes(fileOf(key), lineOfKey(key), entry.match))
      if (hits !== undefined && matches) {
        kept.set(key, entry)
        continue
      }
      const target = typeof entry.match === 'string' ? reanchor(section, fileOf(key), entry.match) : null
      if (target !== null && !kept.has(target) && !entries.has(target)) {
        kept.set(target, entry)
        changes.push({ section, action: 're-anchored', from: key, to: target })
      } else {
        changes.push({ section, action: 'dropped', from: key, to: null })
      }
    }
    listed.set(section, kept)
  }
  if (changes.length > 0) {
    for (const section of SECTIONS) allowlist[section] = Object.fromEntries(listed.get(section))
    await writeFile(path.join(root, ALLOWLIST_FILE), `${JSON.stringify(allowlist, null, 2)}\n`)
    for (const change of changes) {
      const what = change.action === 'dropped' ? 'dropped' : `re-anchored to ${JSON.stringify(change.to)}`
      console.log(`[check-types] UPDATED: ${change.section} ${JSON.stringify(change.from)} ${what}`)
    }
    console.log(
      `[check-types] UPDATED: ${ALLOWLIST_FILE} rewritten, ${changes.length} change(s); --update never adds an entry`,
    )
  } else {
    console.log(`[check-types] UPDATED: ${ALLOWLIST_FILE} needed no change`)
  }
}

// ---- check: every hit is registered, every entry still hits -------------------------------
for (const finding of findings) {
  if (finding.kind !== 'suppression') continue
  if (finding.directive === 'ignore') {
    problem(
      finding.file,
      finding.line,
      finding.col,
      'suppression',
      `\`${finding.snippet}\` — \`@ts-ignore\` is forbidden and cannot be allowlisted: it never expires, so a later fix leaves a permanent blind spot. Use \`@ts-expect-error\` with a reason instead (it reports itself once the error is gone)`,
    )
    continue
  }
  if (finding.directive === 'nocheck') {
    problem(
      finding.file,
      finding.line,
      finding.col,
      'suppression',
      `\`${finding.snippet}\` — \`@ts-nocheck\` is forbidden and cannot be allowlisted: it removes the whole file from \`verify:types\``,
    )
    continue
  }
  if (finding.words < MIN_EXPECT_ERROR_WORDS) {
    problem(
      finding.file,
      finding.line,
      finding.col,
      'suppression',
      `\`${finding.snippet}\` — \`@ts-expect-error\` needs a reason on the same line (at least ${MIN_EXPECT_ERROR_WORDS} words), so the expiry is explainable`,
    )
  }
  // Fall through: an expect-error directive still has to be registered below.
}

for (const section of SECTIONS) {
  const hits = grouped.get(section)
  const entries = listed.get(section)
  for (const [key, group] of hits) {
    if (entries.has(key)) continue
    for (const finding of group) {
      problem(finding.file, finding.line, finding.col, finding.kind, `\`${finding.snippet}\` — ${ADVICE[finding.kind]}`)
    }
  }
  for (const [key, entry] of entries) {
    const file = fileOf(key)
    const group = hits.get(key)
    if (group === undefined) {
      const scope = scanned.has(file) ? '' : ' (the file is not in the scan scope)'
      problem(
        ALLOWLIST_FILE,
        0,
        0,
        'stale',
        `${JSON.stringify(key)} matches no ${SECTION_LABEL[section]} hit${scope}; drop it with \`node scripts/check-types.mjs --update\``,
      )
      continue
    }
    if (typeof entry.match === 'string' && !lineIncludes(file, lineOfKey(key), entry.match)) {
      problem(
        ALLOWLIST_FILE,
        0,
        0,
        'stale',
        `${JSON.stringify(key)} no longer contains ${JSON.stringify(entry.match)}; the line moved, so re-anchor it with \`node scripts/check-types.mjs --update\``,
      )
    }
  }
}

if (stage !== null) {
  const due = Number(stage.slice(1))
  for (const section of SECTIONS) {
    for (const [key, entry] of listed.get(section)) {
      if (typeof entry.until !== 'string' || Number(entry.until.slice(1)) >= due) continue
      warnings.push(
        `${key} is marked until ${entry.until} but the stage is ${stage}; remove the entry or re-justify the reason`,
      )
    }
  }
}

// ---- report -----------------------------------------------------------------------------
problems.sort(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule),
)
const tally = {
  any: findings.filter((finding) => finding.kind === 'any' || finding.kind === 'as-any').length,
  'double-assertion': findings.filter((finding) => finding.kind === 'double-assertion').length,
  suppression: findings.filter((finding) => finding.kind === 'suppression').length,
}
const counts = `${tally.any} any / ${tally['double-assertion']} double-assertion / ${tally.suppression} suppression`
const allowlisted = SECTIONS.reduce((total, section) => total + listed.get(section).size, 0)

for (const message of warnings) console.warn(`[check-types] WARN: ${message}`)
if (problems.length > 0) {
  for (const reported of problems) {
    const position = reported.line > 0 ? `${reported.file}:${reported.line}:${reported.col}` : reported.file
    console.error(`[check-types] FAIL: ${position} — ${reported.rule} — ${reported.detail}`)
  }
  console.error(
    `[check-types] ${problems.length} problem(s) found; ${rootNames.length} file(s) scanned, ${counts}, ${allowlisted} allowlisted`,
  )
  process.exit(1)
}
console.log(`[check-types] OK: ${rootNames.length} files scanned, ${counts}, ${allowlisted} allowlisted`)

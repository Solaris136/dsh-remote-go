// The type policy, executable: no explicit `any`, no `as any`, no `as unknown as X` double assertion, no suppression
// directive missing from types/any-allowlist.json. The compiler API is the source of truth, not a grep: `any` in a
// comment is not a type and `'// @ts-ignore'` in a fixture is not a directive, so comments are read through the
// compiler's own scanner and no string masking is needed. Scope: src/**/*.ts, index.ts, types/**/*.d.ts and
// client/src/**/*.ts; test/**, scripts/** and e2e/** stay out (a fixture may need a loose type, the allowlist is for
// product code), and a `.d.ts` beside a `src/` source is not scanned because ambient declarations belong in `types/`,
// which is. `--update` re-anchors drifted entries by `match` and drops the stale ones but never adds one; `--stage P6`
// warns about due `until` entries and `--strict` fails them. "Due" means at or before the stage under review, so
// `until: P7` is due at P7 (the stage it promised to disappear in), not only at P8; without `--strict` that list is
// only a warning, which must not block the stage the entry names.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// fileURLToPath, not URL#pathname: it percent-encodes the space in "C:\Work\my repo" and resolved the wrong root.
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
// TS only honours a directive that opens the comment, and so does this scan: `// old @ts-ignore` is documentation.
const DIRECTIVE = /^(?:\/|\*)*\s*@ts-(ignore|expect-error|nocheck)\b(.*)$/
const argv = process.argv.slice(2)
const update = argv.includes('--update')
const strict = argv.includes('--strict')
const stageIndex = argv.indexOf('--stage')
const stage = stageIndex === -1 ? null : (argv[stageIndex + 1] ?? '')
function fail(message) {
  console.error(`[check-types] FAIL: ${message}`)
  process.exit(1)
}
for (const [index, argument] of argv.entries()) {
  if (argument === '--update' || argument === '--stage' || argument === '--strict') continue
  if (argv[index - 1] === '--stage') continue
  const message = `unknown argument ${JSON.stringify(argument)}; usage: node scripts/check-types.mjs [--update] [--stage P6] [--strict]`
  fail(message)
}
if (stage !== null && !STAGE_PATTERN.test(stage))
  fail(`--stage expects a stage such as P6 (found ${JSON.stringify(stage)})`)
if (strict && stage === null)
  fail('--strict only means something with --stage; it fails the "until" entries that stage has reached')
const problems = []
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
/** Repository-relative TypeScript files under `dir`. A missing directory is not an error: `client/src` only exists
 * once the client half lands, and `types/` arrived with the SSH declarations. */
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
// compilerOptions from tsconfig.json; the file list is ours on purpose, because "include" misses client/src
// and a program without the client half would pass silently.
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
if (configFile.error)
  fail(`tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`)
const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, root)
const program = ts.createProgram({
  rootNames,
  options: { ...parsed.options, noEmit: true, allowJs: false, checkJs: false, skipLibCheck: true },
})
const own = new Set(rootNames.map((file) => path.resolve(file)))
const ANY_KEYWORD = ts.SyntaxKind.AnyKeyword
const isAssertion = (node) =>
  node.kind === ts.SyntaxKind.AsExpression || node.kind === ts.SyntaxKind.TypeAssertionExpression
const findings = []
const sourceLines = new Map()
/** Walk one source file. The parent is threaded instead of read from `node.parent`: parent pointers are filled in by
 * the binder (it needs a type checker), and this gate only needs the parse tree. */
function scanAst(sourceFile, file) {
  const lines = sourceFile.text.split('\n')
  const locate = (node, kind) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return { file, line: line + 1, col: character + 1, kind, snippet: snippetOf(lines[line]) }
  }
  const visit = (node, parent) => {
    if (node.kind === ANY_KEYWORD) {
      // `x as any` yields an AnyKeyword: report the assertion only, one key per construct, column on the expression.
      const insideAssertion = parent !== undefined && isAssertion(parent) && parent.type === node
      if (!insideAssertion) findings.push(locate(node, 'any'))
    } else if (isAssertion(node)) {
      if (node.type.kind === ANY_KEYWORD) findings.push(locate(node, 'as-any'))
      else if (
        isAssertion(node.expression) &&
        (node.expression.type.kind === ANY_KEYWORD || node.expression.type.kind === ts.SyntaxKind.UnknownKeyword)
      )
        findings.push(locate(node, 'double-assertion'))
    }
    ts.forEachChild(node, (child) => visit(child, node))
  }
  visit(sourceFile, undefined)
}

/** Suppression directives are comments, so no AST node matches them; the compiler's scanner is still the parser here:
 * a `'// @ts-ignore'` string literal is a string token, never a comment. */
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
// The key is `<repo-relative-path>:<1-based-line>` plus a reason and an optional `match` (a substring of that line) so
// a shifted line becomes a stale entry instead of silently allowing whatever moved into that slot.
const allowlistText = await readFile(path.join(root, ALLOWLIST_FILE), 'utf8').catch(() => null)
if (allowlistText === null)
  fail(`${ALLOWLIST_FILE} is missing; it must exist even when empty ({ "version": 1 } plus the three empty sections)`)
let allowlist
try {
  allowlist = JSON.parse(allowlistText)
} catch (error) {
  fail(`${ALLOWLIST_FILE} is not valid JSON: ${error.message}`)
}
if (allowlist === null || typeof allowlist !== 'object' || Array.isArray(allowlist))
  fail(`${ALLOWLIST_FILE} must contain a JSON object`)
const schemaProblem = (detail) => problem(ALLOWLIST_FILE, 0, 0, 'schema', detail)
for (const field of Object.keys(allowlist)) {
  if (!TOP_LEVEL_FIELDS.has(field)) schemaProblem(`unknown top-level key ${JSON.stringify(field)}`)
}
if (allowlist.version !== 1) schemaProblem(`"version" must be 1 (found ${JSON.stringify(allowlist.version)})`)
for (const field of ['$schema', 'policy']) {
  if (allowlist[field] !== undefined && typeof allowlist[field] !== 'string')
    schemaProblem(`"${field}" must be a string`)
}
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
      const message = `"${section}" entry ${JSON.stringify(key)} needs a "reason" of at least ${MIN_REASON_LENGTH} characters saying why a narrower type is impossible`
      schemaProblem(message)
    }
    if (entry.match !== undefined && (typeof entry.match !== 'string' || entry.match === ''))
      schemaProblem(`"${section}" entry ${JSON.stringify(key)}: "match" must be a non-empty string`)
    if (entry.until !== undefined && (typeof entry.until !== 'string' || !STAGE_PATTERN.test(entry.until)))
      schemaProblem(`"${section}" entry ${JSON.stringify(key)}: "until" must be a stage such as P7`)
    listed.get(section).set(key, entry)
  }
}
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

// `--update` only re-anchors by `match` and prunes: a hit with no entry stays a failure, so this cannot widen the gate.
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
    const message = `[check-types] UPDATED: ${ALLOWLIST_FILE} rewritten, ${changes.length} change(s); --update never adds an entry`
    console.log(message)
  } else {
    console.log(`[check-types] UPDATED: ${ALLOWLIST_FILE} needed no change`)
  }
}
// A forbidden directive cannot be allowlisted at all; @ts-expect-error can, but only with a stated reason.
const FORBIDDEN = {
  ignore:
    '`@ts-ignore` is forbidden and cannot be allowlisted: it never expires, so a later fix leaves a permanent blind spot. Use `@ts-expect-error` with a reason instead (it reports itself once the error is gone)',
  nocheck: '`@ts-nocheck` is forbidden and cannot be allowlisted: it removes the whole file from `verify:types`',
}
for (const finding of findings) {
  if (finding.kind !== 'suppression') continue
  const { file, line, col, snippet, words, directive } = finding
  const forbidden = FORBIDDEN[directive]
  if (forbidden !== undefined) problem(file, line, col, 'suppression', `\`${snippet}\` — ${forbidden}`)
  else if (words < MIN_EXPECT_ERROR_WORDS) {
    const needs = `needs a reason on the same line (at least ${MIN_EXPECT_ERROR_WORDS} words), so the expiry is explainable`
    problem(file, line, col, 'suppression', `\`${snippet}\` — \`@ts-expect-error\` ${needs}`)
  }
}
for (const section of SECTIONS) {
  const hits = grouped.get(section)
  const entries = listed.get(section)
  for (const [key, group] of hits) {
    if (entries.has(key)) continue
    for (const finding of group)
      problem(finding.file, finding.line, finding.col, finding.kind, `\`${finding.snippet}\` — ${ADVICE[finding.kind]}`)
  }
  for (const [key, entry] of entries) {
    const file = fileOf(key)
    const group = hits.get(key)
    if (group === undefined) {
      const scope = scanned.has(file) ? '' : ' (the file is not in the scan scope)'
      const stale = `${JSON.stringify(key)} matches no ${SECTION_LABEL[section]} hit${scope}; drop it with \`node scripts/check-types.mjs --update\``
      problem(ALLOWLIST_FILE, 0, 0, 'stale', stale)
      continue
    }
    if (typeof entry.match === 'string' && !lineIncludes(file, lineOfKey(key), entry.match)) {
      const moved = `${JSON.stringify(key)} no longer contains ${JSON.stringify(entry.match)}; the line moved, so re-anchor it with \`node scripts/check-types.mjs --update\``
      problem(ALLOWLIST_FILE, 0, 0, 'stale', moved)
    }
  }
}
if (stage !== null) {
  const due = Number(stage.slice(1))
  for (const section of SECTIONS) {
    for (const [key, entry] of listed.get(section)) {
      // Due when the promised stage has arrived: `until: P7` is due at P7, not at P8.
      if (typeof entry.until !== 'string' || Number(entry.until.slice(1)) > due) continue
      const message = `${key} is marked until ${entry.until} and the stage is ${stage}; remove the entry (the suppression must be gone) or give it a later \`until\` with a reason`
      if (strict) problem(ALLOWLIST_FILE, 0, 0, 'due', message)
      else warnings.push(message)
    }
  }
}
problems.sort(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule),
)
const count = (kind) => findings.filter((finding) => finding.kind === kind).length
const counts = `${count('any') + count('as-any')} any / ${count('double-assertion')} double-assertion / ${count('suppression')} suppression`
const allowlisted = SECTIONS.reduce((total, section) => total + listed.get(section).size, 0)
for (const message of warnings) console.warn(`[check-types] WARN: ${message}`)
if (problems.length > 0) {
  for (const reported of problems) {
    const position = reported.line > 0 ? `${reported.file}:${reported.line}:${reported.col}` : reported.file
    console.error(`[check-types] FAIL: ${position} — ${reported.rule} — ${reported.detail}`)
  }
  const summary = `[check-types] ${problems.length} problem(s) found; ${rootNames.length} file(s) scanned, ${counts}, ${allowlisted} allowlisted`
  console.error(summary)
  process.exit(1)
}
console.log(`[check-types] OK: ${rootNames.length} files scanned, ${counts}, ${allowlisted} allowlisted`)

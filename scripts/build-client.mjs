// Build the published browser half: the modules listed in `SOURCES` -> `dist/client.js`.
// `scripts/stage-publish.mjs` copies it to `client.js` for the packed tarball (prepack), and
// `scripts/unstage-publish.mjs` removes that copy again (postpack), so the repository root has
// no generated file while the published layout is unchanged.
//
// Three parts, and the contract-bearing one is never rewritten by a tool:
//
//   the modules          every file in `SOURCES`, concatenated in that order with exactly one
//                        blank line between files. They are one *script* scope, not modules: no
//                        `import`/`export` anywhere (checked below), so a declaration in one file
//                        is the same binding a later file uses - exactly the single file P3a had.
//   client/template.js   the loader shell — `window.__ModuleLoader__.load({ id, factory(require) })`,
//                        `require('react')`, and the `return __drgExport` hand-off. It is read as
//                        text and spliced, never parsed or formatted, so the frozen contract text
//                        in it stays byte-exact.
//   prettier             formats the composed file with the repository's `.prettierrc.json`, so the
//                        artifact keeps the same style every other checked-in file has.
//
// Why no bundler (deviation from design-client.md §3.1, recorded in the P3a report and confirmed by
// P3b): with `bundle: true`, esbuild rewrites every module-level `const`/`let` to `var` (a bundle
// flattens module scopes), which breaks two structural guards that read the artifact text and must
// not be relaxed: `const CSS = ` at test/unit/guards.test.ts:446-451 and `const TONE_VARS = {` at
// :590-596. Source-level concatenation sidesteps the rewrite instead of arguing with it: `const`
// stays `const`, no helper is emitted, nothing is renamed.
//
// esbuild still runs, as a *transform* (`bundle: false`, the P3a options): it strips the TypeScript
// annotations and the comments, which is why the published file is ~60 KB smaller than its sources.
// A transform neither renames nor re-scopes a binding, so it composes with the manifest: the same
// bytes in produce the same bytes out, and P3b's acceptance was that the artifact hash does not
// move at all.
//
// `target: 'es2022'` means no syntax lowering, so no `__async`/`__spreadValues` helper can appear
// in the four guest functions that are injected into a remote page via `Function#toString`.
//
// `external: ['react']` is deliberately absent: esbuild refuses it without `bundle` ("Cannot use
// external without bundle"), and the property it has to guarantee is asserted instead — exactly one
// `require()` call survives and its specifier is `react`, so React is injected by the loader and
// never inlined (checkArtifact below).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require_ = createRequire(path.join(root, 'package.json'))
const esbuild = require_('esbuild')
const prettier = require_('prettier')
const ts = require_('typescript')

// The manifest. Order is the artifact's order: this array *is* the file, and it is hand-written so
// that a rename or a delete is a reviewable one-line diff. Adding a module means adding a line
// here; the completeness check below fails on both a missing line and a line for a file that no
// longer exists.
const SOURCE_DIR = 'client/src'
const SOURCES = [
  'react',
  'constants',
  'i18n-dict',
  'i18n',
  'util',
  'errors',
  'api-client',
  'connect-logs',
  'log-stream',
  'primitives',
  'dialogs',
  'host-list',
  'connect-window',
  'switcher',
  'guest-host-row',
  'guest-tools',
  'guest-storage',
  'carrier-pool',
  'carrier-install',
  'carrier-caption',
  'carrier-desktop',
  'carrier-web',
  'carrier-intents',
  'carrier-overlay',
  'key-picker',
  'wizard-draft',
  'wizard',
  'diagnostics',
  'settings',
  'prompts',
  'toast',
  'overlay-state',
  'manage-window',
  'actions',
  'plugin-overlay',
  'styles',
  'plugin',
].map((name) => `${SOURCE_DIR}/${name}.ts`)
const TEMPLATE = 'client/template.js'
// Inside `dist/` like every other emitted file: the staged copy at the package root is what the
// published `client.js` is, and it only exists between `prepack` and `postpack`.
const OUT = 'dist/client.js'
const BUNDLE_MARKER = '/* @@BUNDLE@@ */'
// Bindings the artifact legitimately declares with a `__` prefix (`__drgExport` is the plugin face
// the loader template hands back; `__test` is the test seam on it). Any other `__`-prefixed binding
// is a bundler helper.
const OWN_BINDINGS = new Set(['__drgExport', '__test'])

// The four functions injected into a remote page through `Function#toString()`: a guest cannot see
// the plugin's scope, so a bundler helper in their body would be a runtime ReferenceError there.
const GUEST_FUNCTIONS = ['mountHostRow', 'mountGuestTools', 'mountCapabilityBridge', 'mountSidebarMirror']
// Globals the guest copies create and read themselves (they are properties, not plugin bindings).
const GUEST_GLOBALS = new Set([
  '__drgBridgeQueue',
  '__drgBridgeSink',
  '__drgCapabilityBridge',
  '__drgCapabilityReply',
  '__drgGuestTools',
  '__drgHostRow',
  '__drgHostRowStyle',
  '__drgSidebarMirror',
  '__drgStoragePartition',
  '__drgText',
  '__DSH_BOOT__',
  '__DSH_DIRECTORY_PICKER__',
])

// A module is a contiguous, reviewable slice. Every one of them fits the budget with no exception:
// P3c split the overlay host's commands out into `actions.ts`, which was the last module over it.
const MAX_MODULE_LINES = 600

function fail(message) {
  throw new Error(message)
}

const specifiersOf = (text) => [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
const literalOf = (text, name) => text.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\``))?.[1] ?? null
const parse = (text) => ts.createSourceFile('client.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)

/** Every `__`-prefixed identifier read inside the four stringified guest functions. */
function guestHelperLeaks(text) {
  const source = parse(text)
  const leaks = []
  const visit = (node, guest) => {
    if (ts.isFunctionDeclaration(node) && node.name && GUEST_FUNCTIONS.includes(node.name.text)) guest = node.name.text
    if (guest !== null && ts.isIdentifier(node) && node.text.startsWith('__') && !GUEST_GLOBALS.has(node.text)) {
      leaks.push(`${guest}: ${node.text}`)
    }
    ts.forEachChild(node, (child) => visit(child, guest))
  }
  visit(source, null)
  return [...new Set(leaks)]
}

/** Every `__`-prefixed declaration in the artifact: that is the shape an esbuild helper arrives in. */
function helperDeclarations(text) {
  const source = parse(text)
  const names = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.push(node.name.text)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...new Set(names.filter((name) => name.startsWith('__') && !OWN_BINDINGS.has(name)))]
}

/** Structural contract of the artifact: every rule is a hard build failure, not a warning. */
function checkArtifact(text, sourceText) {
  const rules = [
    [/window\.__ModuleLoader__\.load\(/.test(text), 'the loader call vanished'],
    [(text.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length === 1, 'the loader call must appear once'],
    [text.includes("id: 'dsh-remote-go'"), 'the loader id must stay `dsh-remote-go`'],
    [text.includes('factory(require) {'), 'the factory signature must stay `factory(require)`'],
    [(text.match(/factory\s*\(/g) ?? []).length === 1, 'exactly one factory must be declared'],
    [
      specifiersOf(text).join(',') === 'react',
      `the artifact must require react and nothing else (got ${specifiersOf(text).join(',') || 'nothing'})`,
    ],
    [(text.match(/\brequire\s*\(/g) ?? []).length === 1, 'exactly one require() call must remain'],
    [(text.match(/const CSS = `/g) ?? []).length === 1, 'the stylesheet must stay one `const CSS = ` template literal'],
    [
      literalOf(text, 'CSS') === literalOf(sourceText, 'CSS'),
      'the stylesheet bytes changed between the source and the artifact',
    ],
    [
      (text.match(/const TONE_VARS = \{/g) ?? []).length === 1,
      'the `const TONE_VARS = {` table must survive (guards.test.ts)',
    ],
    [text.includes('style.textContent = ['), 'the switcher row stylesheet array must survive (guards.test.ts)'],
    [text.includes("].join('')"), "the switcher row stylesheet `join('')` must survive (guards.test.ts)"],
    [text.includes('function openExternalUrl('), 'the capability bridge must stay a named function (guards.test.ts)'],
    [
      text.includes("win.open(url, '_blank', 'noopener,noreferrer')"),
      'the only new-window call site must stay on one line (guards.test.ts)',
    ],
    [!/^\s*(?:import|export)\b/m.test(text), 'the artifact must contain no `import`/`export` statement'],
    [!/\b__require\b|\brequire2\b/.test(text), 'a bundler rename (`__require`/`require2`) leaked into the artifact'],
    [!/\bmodule\.exports\b|\b__toCommonJS\b|\b__commonJS\b/.test(text), 'a CommonJS wrapper leaked into the artifact'],
    [!/\t/.test(text), 'the artifact must not contain a tab character'],
    [!/\r/.test(text), 'the artifact must contain no carriage return'],
    [text.endsWith('\n') && !text.endsWith('\n\n'), 'the artifact must end with exactly one newline'],
    [text.length < 800 * 1024, `the artifact is ${Math.round(text.length / 1024)} KiB, over the 800 KiB budget`],
  ]
  const failures = rules.filter(([ok]) => !ok).map(([, why]) => why)
  if (failures.length > 0) fail(failures.join('; '))
}

/** Repository-relative TypeScript files under `dir`, ambient declarations excluded. */
async function sourceFiles(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await sourceFiles(rel)))
    // A `.d.ts` is an ambient declaration: it types the loader template's names, it never reaches
    // the artifact, so it must not appear in the manifest.
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(rel)
  }
  return found
}

/**
 * The manifest's contract: every source file appears exactly once, in a list whose order is the
 * artifact's order. A file nobody lists would be silently dropped from the published plugin, and a
 * listed file that no longer exists would be a build error instead of a mystery - both fail here.
 */
async function checkManifest() {
  const actual = (await sourceFiles(SOURCE_DIR)).sort()
  const listed = [...SOURCES].sort()
  const missing = actual.filter((file) => !listed.includes(file))
  const extra = listed.filter((file) => !actual.includes(file))
  const duplicates = listed.filter((file, index) => listed.indexOf(file) !== index)
  const problems = []
  if (missing.length > 0) problems.push(`missing from SOURCES: ${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`listed in SOURCES but absent: ${extra.join(', ')}`)
  if (duplicates.length > 0) problems.push(`listed more than once: ${[...new Set(duplicates)].join(', ')}`)
  if (problems.length > 0) fail(problems.join('; '))
}

/**
 * A module is a *script* file: top-level `import`/`export` would make it a module, and the
 * concatenated artifact would then be either a syntax error (no bundler resolves the specifier) or
 * a silent half-load. The compiler already answers exactly this question — `externalModuleIndicator`
 * is set by any module syntax, including the `export` *modifier* on a `const`, which a
 * statement-kind check alone would miss — and it reads the AST, so a `// import` in a comment or an
 * `'export'` in a string is never mistaken for code.
 */
function checkSourceScript(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const problems = []
  if (source.externalModuleIndicator !== undefined) {
    const { line } = source.getLineAndCharacterOfPosition(source.externalModuleIndicator.getStart(source))
    problems.push(`${file}:${line + 1} uses module syntax; every client module shares one script scope`)
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      problems.push(`${file}:${line + 1} calls import(); the artifact has one loader-provided require and no imports`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (problems.length > 0) fail(problems.join('; '))
}

/**
 * Read the manifest in order and rebuild the one script the template expects.
 *
 * Each file starts with exactly one header line (`// client/src/<name>.ts - <what it holds>`); the
 * header documents the slice for a reader and is *not* part of the artifact. The bodies are joined
 * with one blank line, which is what the build's byte-for-byte equivalence with the pre-split
 * `client/src/main.ts` was proven against.
 */
async function composeSource() {
  const bodies = []
  for (const file of SOURCES) {
    const text = await readFile(path.join(root, file), 'utf8')
    const header = `// ${file} - `
    if (!text.startsWith(header)) fail(`${file} must open with its one-line header (\`${header}\u2026\`)`)
    const newline = text.indexOf('\n')
    if (newline === -1) fail(`${file} is a single line; it has no body`)
    if (!text.endsWith('\n') || text.endsWith('\n\n')) fail(`${file} must end with exactly one newline`)
    const body = text.slice(newline + 1)
    if (body.trim() === '') fail(`${file} has an empty body`)
    const lines = body.split('\n').length - 1
    if (lines > MAX_MODULE_LINES) {
      fail(`${file} is ${lines} lines, over the ${MAX_MODULE_LINES}-line module budget`)
    }
    checkSourceScript(file, body)
    bodies.push(body.slice(0, -1))
  }
  const source = bodies.join('\n\n') + '\n'
  if (source.trim() === '') fail('the composed source is empty')
  return source
}

/** One build: esbuild transform + template splice + prettier. Returns the finished artifact text. */
async function compose(sourceText) {
  const template = await readFile(path.join(root, TEMPLATE), 'utf8')
  if (!template.includes(BUNDLE_MARKER)) fail(`${TEMPLATE} must contain the ${BUNDLE_MARKER} marker`)
  // The annotation below is stripped textually, so a literal one in the source would be mangled by
  // that regex: catching it here keeps the strip safe instead of making it a hidden landmine.
  if (sourceText.includes('@__PURE__')) fail('the client sources must not contain a literal @__PURE__ annotation')

  const bundle = await esbuild.build({
    // The composed script arrives on stdin: there is one input (the manifest's concatenation), and
    // an entry point would re-run resolution over a file that deliberately imports nothing.
    stdin: { contents: sourceText, resolveDir: root, sourcefile: 'client/src/client.ts', loader: 'ts' },
    absWorkingDir: root,
    bundle: false,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    treeShaking: false,
    charset: 'utf8',
    logLevel: 'silent',
  })
  const body = bundle.outputFiles[0].text.replaceAll('/* @__PURE__ */ ', '')
  // The replacement has to be a function: `$&`/`$'` in the bundle would be read as replace patterns.
  const composed = template.replace(BUNDLE_MARKER, () => body)
  const config = (await prettier.resolveConfig(path.join(root, OUT))) ?? {}
  return prettier.format(composed, { ...config, parser: 'babel', filepath: path.join(root, OUT) })
}

await checkManifest()
const sourceText = await composeSource()

const first = await compose(sourceText)
const second = await compose(sourceText)
if (first !== second) fail('two consecutive builds differ; the artifact is not reproducible')

checkArtifact(first, sourceText)
for (const leak of guestHelperLeaks(first)) fail(`a guest script closes over a bundler helper: ${leak}`)
for (const helper of helperDeclarations(first)) fail(`a \`__\`-prefixed binding leaked into the artifact: ${helper}`)

await mkdir(path.dirname(path.join(root, OUT)), { recursive: true })
await writeFile(path.join(root, OUT), first, 'utf8')
console.log(
  `[build-client] wrote ${OUT} (${Buffer.byteLength(first)} bytes) from ${SOURCES.length} modules (${SOURCE_DIR}) + ${TEMPLATE}`,
)

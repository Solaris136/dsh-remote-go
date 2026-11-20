// Build the published browser half: SOURCES concatenated in source order into one script scope (no import/export,
// checked below) -> `dist/client.js`, with `client/template.js` spliced in as text so its frozen contract stays
// byte-exact, then formatted by prettier. No bundler on purpose: `bundle: true` rewrites module-level const/let to var
// and breaks the structural guards that read the artifact text (`const CSS = `, `const TONE_VARS = {`), so esbuild runs
// as a *transform* only (types and comments stripped, nothing renamed); `target: 'es2022'` keeps a bundler helper
// out of the guest functions injected via `Function#toString`. `external: ['react']` is absent on purpose (esbuild
// refuses it without `bundle`) and the one surviving `require()` is asserted instead.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require_ = createRequire(path.join(root, 'package.json'))
const esbuild = require_('esbuild')
const prettier = require_('prettier')
const ts = require_('typescript')
const SOURCE_DIR = 'client/src'
// The manifest. Order is the artifact's order: this array *is* the file, and it is hand-written so that a rename or a
// delete is a reviewable one-line diff. The completeness check below fails on both a missing line and a stale one.
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
// Inside `dist/` like every other emitted file: this is the file `exports["./client"]` names.
const OUT = 'dist/client.js'
const BUNDLE_MARKER = '/* @@BUNDLE@@ */'
// Own `__` bindings: `__drgExport` (the loader's plugin face), `__test` (its seam); any other one is a bundler helper.
const OWN_BINDINGS = new Set(['__drgExport', '__test'])
// The four functions injected via `Function#toString()`: a guest cannot see the plugin's scope,
// so a bundler helper in their body would be a runtime ReferenceError in the remote page.
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
// A module is a contiguous, reviewable slice: every one of them fits this budget with no exception.
const MAX_MODULE_LINES = 600
function fail(message) {
  throw new Error(message)
}
const specifiersOf = (text) => [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
const literalOf = (text, name) => text.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\``))?.[1] ?? null
const parse = (text) => ts.createSourceFile('client.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)

/** The two `__`-prefix rules in one walk: a `__` identifier read inside the four stringified guest functions (a helper
 * there would not exist in the remote page), and every `__`-prefixed declaration in the artifact (the shape an esbuild
 * helper arrives in). */
function artifactLeaks(text) {
  const leaks = []
  const names = []
  const visit = (node, guest) => {
    if (ts.isFunctionDeclaration(node) && node.name && GUEST_FUNCTIONS.includes(node.name.text)) guest = node.name.text
    if (guest !== null && ts.isIdentifier(node) && node.text.startsWith('__') && !GUEST_GLOBALS.has(node.text)) {
      leaks.push(`${guest}: ${node.text}`)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.push(node.name.text)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.push(node.name.text)
    ts.forEachChild(node, (child) => visit(child, guest))
  }
  visit(parse(text), null)
  return {
    leaks: [...new Set(leaks)],
    helpers: [...new Set(names.filter((name) => name.startsWith('__') && !OWN_BINDINGS.has(name)))],
  }
}
/** Structural contract of the artifact: every rule is a hard build failure, not a warning. */
function checkArtifact(text, templateText) {
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
      literalOf(text, 'CSS') === literalOf(templateText, 'CSS'),
      'the stylesheet bytes changed between client/template.js and the artifact',
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
  const found = []
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await sourceFiles(rel)))
    // A `.d.ts` types the loader template's names and never reaches the artifact, so it stays out of the manifest.
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(rel)
  }
  return found
}

/** The manifest's contract: every source file appears exactly once, in a list whose order is the artifact's order. A
 * file nobody lists would be silently dropped from the published plugin, and a listed file that no longer exists must
 * be a build error instead of a mystery - both fail here. */
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
/** A module is a *script* file: top-level `import`/`export` would make it a module and the concatenated artifact would
 * be a syntax error (no bundler resolves the specifier) or a silent half-load. The compiler answers exactly this:
 * `externalModuleIndicator` is set by any module syntax, including the `export` *modifier* on a `const` that a
 * statement-kind check would miss, and it reads the AST, so a `// import` in a comment is never mistaken for code. */
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
/** Read the manifest in order and rebuild the one script the template expects. Each file starts with exactly one
 * header line (`// client/src/<name>.ts - <what it holds>`) that documents the slice and is not part of the artifact;
 * bodies are joined with one blank line, which is what the byte-for-byte equivalence with the pre-split `main.ts` was
 * proven against. */
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
    if (lines > MAX_MODULE_LINES) fail(`${file} is ${lines} lines, over the ${MAX_MODULE_LINES}-line module budget`)
    checkSourceScript(file, body)
    bodies.push(body.slice(0, -1))
  }
  const source = bodies.join('\n\n') + '\n'
  if (source.trim() === '') fail('the composed source is empty')
  return source
}
/** One build: esbuild transform + template splice + prettier. Returns the finished artifact text. */
async function compose(sourceText, templateText) {
  if (!templateText.includes(BUNDLE_MARKER)) fail(`${TEMPLATE} must contain the ${BUNDLE_MARKER} marker`)
  // The annotation below is stripped textually, so a literal one would be mangled by that regex: catching it here keeps
  // the strip safe instead of making it a hidden landmine.
  if (sourceText.includes('@__PURE__')) fail('the client sources must not contain a literal @__PURE__ annotation')
  const bundle = await esbuild.build({
    // One input (the concatenation) on stdin: an entry point would re-run resolution over a file that imports nothing.
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
  const composed = templateText.replace(BUNDLE_MARKER, () => body)
  const config = (await prettier.resolveConfig(path.join(root, OUT))) ?? {}
  return prettier.format(composed, { ...config, parser: 'babel', filepath: path.join(root, OUT) })
}
await checkManifest()
const sourceText = await composeSource()
const templateText = await readFile(path.join(root, TEMPLATE), 'utf8')
const first = await compose(sourceText, templateText)
const second = await compose(sourceText, templateText)
if (first !== second) fail('two consecutive builds differ; the artifact is not reproducible')
checkArtifact(first, templateText)
const { leaks, helpers } = artifactLeaks(first)
for (const leak of leaks) fail(`a guest script closes over a bundler helper: ${leak}`)
for (const helper of helpers) fail(`a \`__\`-prefixed binding leaked into the artifact: ${helper}`)
await mkdir(path.dirname(path.join(root, OUT)), { recursive: true })
await writeFile(path.join(root, OUT), first, 'utf8')
console.log(
  `[build-client] wrote ${OUT} (${Buffer.byteLength(first)} bytes) from ${SOURCES.length} modules (${SOURCE_DIR}) + ${TEMPLATE}`,
)

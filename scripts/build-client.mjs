// Build the published browser half: `client/src/main.ts` -> `client.js`.
//
// Three parts, and the contract-bearing one is never rewritten by a tool:
//
//   client/template.js   the loader shell — `window.__ModuleLoader__.load({ id, factory(require) })`,
//                        `require('react')`, and the `return __drgExport` hand-off. It is read as
//                        text and spliced, never parsed or formatted, so the frozen contract text
//                        in it stays byte-exact.
//   the bundle           esbuild's output for `client/src/main.ts` (the whole implementation).
//   prettier             formats the composed file with the repository's `.prettierrc.json`, so the
//                        artifact keeps the same style every other checked-in file has.
//
// Why `bundle: false` (deviation from design-client.md §3.1, recorded in the P3a report): with
// `bundle: true`, esbuild rewrites every module-level `const`/`let` to `var` (a bundle flattens
// module scopes), which breaks two structural guards that read the artifact text and must not be
// relaxed: `const CSS = ` at test/unit/guards.test.js:446-451 and `const TONE_VARS = {` at
// :590-596. P3a moves a single file, so bundling buys nothing; when P3b really splits
// `client/src/**` into modules it has to solve that rewrite (design-client.md C1). Until then this
// script rejects any runtime `import`/`export` in the source instead of silently shipping a
// half-composed artifact.
//
// `treeShaking: false` documents the switch that matters the day bundling returns: an entry with
// no exports is otherwise dropped entirely (verified: a 0-byte bundle under `bundle: true`).
// `target: 'es2022'` means no syntax lowering, so no `__async`/`__spreadValues` helper can appear
// in the four guest functions that are injected into a remote page via `Function#toString`.
//
// `external: ['react']` is deliberately absent: esbuild refuses it without `bundle` ("Cannot use
// external without bundle"), and the property it has to guarantee is asserted instead — exactly one
// `require()` call survives and its specifier is `react`, so React is injected by the loader and
// never inlined (checkArtifact below).
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require_ = createRequire(path.join(root, 'package.json'))
const esbuild = require_('esbuild')
const prettier = require_('prettier')
const ts = require_('typescript')

const ENTRY = 'client/src/main.ts'
const TEMPLATE = 'client/template.js'
const OUT = 'client.js'
const BUNDLE_MARKER = '/* @@BUNDLE@@ */'
// Bindings the artifact legitimately declares with a `__` prefix (`__drgExport` is main.ts's plugin
// face; `__test` is the test seam on it). Any other `__`-prefixed binding is a bundler helper.
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
function checkArtifact(text, entryText) {
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
      literalOf(text, 'CSS') === literalOf(entryText, 'CSS'),
      'the stylesheet bytes changed between the source and the artifact',
    ],
    [
      (text.match(/const TONE_VARS = \{/g) ?? []).length === 1,
      'the `const TONE_VARS = {` table must survive (guards.test.js)',
    ],
    [text.includes('style.textContent = ['), 'the switcher row stylesheet array must survive (guards.test.js)'],
    [text.includes("].join('')"), "the switcher row stylesheet `join('')` must survive (guards.test.js)"],
    [text.includes('function openExternalUrl('), 'the capability bridge must stay a named function (guards.test.js)'],
    [
      text.includes("win.open(url, '_blank', 'noopener,noreferrer')"),
      'the only new-window call site must stay on one line (guards.test.js)',
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

/** One build: esbuild transform + template splice + prettier. Returns the finished artifact text. */
async function compose(entryText) {
  const template = await readFile(path.join(root, TEMPLATE), 'utf8')
  if (!template.includes(BUNDLE_MARKER)) fail(`${TEMPLATE} must contain the ${BUNDLE_MARKER} marker`)
  // The annotation below is stripped textually, so a literal one in the source would be mangled by
  // that regex: catching it here keeps the strip safe instead of making it a hidden landmine.
  if (entryText.includes('@__PURE__')) fail(`${ENTRY} must not contain a literal @__PURE__ annotation`)

  const bundle = await esbuild.build({
    entryPoints: [path.join(root, ENTRY)],
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

const entryText = await readFile(path.join(root, ENTRY), 'utf8')

const first = await compose(entryText)
const second = await compose(entryText)
if (first !== second) fail('two consecutive builds differ; the artifact is not reproducible')

checkArtifact(first, entryText)
for (const leak of guestHelperLeaks(first)) fail(`a guest script closes over a bundler helper: ${leak}`)
for (const helper of helperDeclarations(first)) fail(`a \`__\`-prefixed binding leaked into the artifact: ${helper}`)

await writeFile(path.join(root, OUT), first, 'utf8')
console.log(`[build-client] wrote ${OUT} (${Buffer.byteLength(first)} bytes) from ${ENTRY} + ${TEMPLATE}`)

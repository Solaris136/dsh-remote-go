// Verify the published artifact without publishing: `files` coverage, and `... <plugin.tgz>` inspects that tarball too.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL#pathname: it percent-encodes the space in "C:\Work\my repo" and resolved the wrong root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
function fail(message) {
  console.error(`[pack-check] ${message}`)
  process.exit(1)
}
const cliArgs = process.argv.slice(2)
const findIndex = cliArgs.indexOf('--find')
let tarball = cliArgs.find((arg, index) => !arg.startsWith('--') && index !== findIndex + 1) ?? null
async function newestTarball(dir) {
  if (!existsSync(dir)) return null
  let best = null
  let bestTime = -1
  for (const name of (await readdir(dir)).filter((name) => name.endsWith('.tgz'))) {
    const full = path.join(dir, name)
    const info = await stat(full)
    if (info.mtimeMs > bestTime) {
      best = full
      bestTime = info.mtimeMs
    }
  }
  return best
}
if (findIndex >= 0) {
  const dir = path.resolve(root, cliArgs[findIndex + 1] ?? 'artifacts')
  tarball = await newestTarball(dir)
  if (!tarball) fail(`--find ${cliArgs[findIndex + 1] ?? 'artifacts'}: no .tgz tarball found; run pnpm pack first`)
  console.log(`[pack-check] tarball: ${path.relative(root, tarball)}`)
}
async function walk(dir, accept, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await walk(rel, accept, out)
    else if (entry.isFile() && accept(entry.name)) out.push(rel)
  }
  return out
}
// The tarball ships built JavaScript in `dist/` (`exports` points into it directly, with no staged copy at the root).
// One artifact per source, compared as a *set* rather than by count: a count let one stale artifact hide a missing one,
// while naming each file pins a `.ts` added without a rebuild and a `.ts` deleted without a clean rebuild.
const expectedArtifacts = new Set(
  (await walk('src', (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))).map(
    (source) => `dist/${source.replace(/\.ts$/, '.js')}`,
  ),
)
/** Compare one artifact set against the sources, naming both directions.
 * @param actual - the `.js` paths found (working tree or tarball entry names).
 * @param where - what the set describes, for the message. */
function compareArtifacts(actual, where) {
  const missing = [...expectedArtifacts].filter((file) => !actual.has(file)).sort()
  const extra = [...actual].filter((file) => !expectedArtifacts.has(file)).sort()
  if (missing.length > 0) {
    const message = `${where} is missing ${missing.length} artifact(s) that a src/ source requires (rebuild): ${missing.join(', ')}`
    problems.push(message)
  }
  if (extra.length > 0) {
    const extraProblem = `${where} carries ${extra.length} artifact(s) with no src/ source (stale build output): ${extra.join(', ')}`
    problems.push(extraProblem)
  }
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const problems = []

// The vendored ssh2 bundle is imported at runtime by `src/ssh.js`, so a missing `vendor/` entry is an install-time
// crash, not a cosmetic packaging bug; one list checks both the working tree and the tarball's copy of the same layout.
const REQUIRED_FILES = `package.json index.js dist/index.js dist/client.js cordis.patch.yml locale/en.json
locale/zh.json dist/src/index.js dist/src/api.js dist/src/service.js dist/vendor/ssh2.bundle.cjs
vendor/THIRD_PARTY_NOTICES.md README.md LICENSE`.split(/\s+/)
for (const file of REQUIRED_FILES) {
  if (!existsSync(path.join(root, file))) problems.push(`missing file: ${file}`)
}
const files = pkg.files ?? []
// A directory entry (`dist`) covers its files; an explicit file stays exact.
const ships = (needed) =>
  files.some((entry) => entry === needed || entry.startsWith(`${needed}/`) || needed.startsWith(`${entry}/`))
for (const needed of ['dist', 'vendor/THIRD_PARTY_NOTICES.md', 'README.md', 'LICENSE']) {
  if (!ships(needed)) problems.push(`files[] must ship ${needed}`)
}
// The loader contract: `exports["."]` host half, `exports["./client"]` browser bundle; drift breaks every install.
const exportPaths = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {}
if (exportPaths['.'] !== './index.js') problems.push('exports["."] must be "./index.js"')
if (exportPaths['./client'] !== './dist/client.js') problems.push('exports["./client"] must be "./dist/client.js"')
if (pkg.private === true) problems.push('package.json is private; publishing is refused')
// The working tree is half the same contract: every source has its artifact, and no artifact survives a deleted source.
if (!tarball) compareArtifacts(new Set(await walk('dist/src', (name) => name.endsWith('.js'))), 'dist/src')
if (tarball) {
  if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`)
  let listing = ''
  try {
    listing = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch (error) {
    fail(`cannot list tarball with tar: ${error.message}`)
  }
  const entries = listing
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ''))
  const missing = REQUIRED_FILES.filter((file) => !entries.includes(file))
  if (missing.length > 0) problems.push(`tarball is missing: ${missing.join(', ')}`)
  const stray = entries.filter(
    (file) =>
      file.startsWith('test/') || file.startsWith('e2e/') || file.startsWith('_research/') || file.startsWith('docs/'),
  )
  if (stray.length > 0) problems.push(`tarball contains development files: ${stray.slice(0, 10).join(', ')}`)
  // The layout is `dist/` plus `index.js`; a root `client.js` or `src/` is a stale in-place build that leaked back in.
  if (entries.includes('client.js')) problems.push('tarball contains a root client.js; the bundle lives in dist/')
  if (!entries.includes('index.js')) problems.push('tarball is missing the root index.js entry shim')
  const rootSources = entries.filter((file) => file.startsWith('src/'))
  if (rootSources.length > 0)
    problems.push(`tarball contains root src/ entries: ${rootSources.slice(0, 10).join(', ')}`)
  // The tarball alone proves a published module exists: every `.ts` source is represented, and no `.ts` may slip in.
  const typescriptSources = entries.filter((file) => file.endsWith('.ts'))
  if (typescriptSources.length > 0)
    problems.push(`tarball contains TypeScript sources: ${typescriptSources.slice(0, 10).join(', ')}`)
  compareArtifacts(
    new Set(entries.filter((file) => file.startsWith('dist/src/') && file.endsWith('.js'))),
    'the tarball',
  )
  // Assert the vendor runtime: a `files[]` or build regression dropping it crashes at install time, not cosmetically.
  if (!entries.includes('dist/vendor/ssh2.bundle.cjs'))
    problems.push('tarball does not contain dist/vendor/ssh2.bundle.cjs (the runtime ssh2 bundle)')
  // `vendor/ssh2-entry.mjs` is the esbuild input, not runtime code: versioned, but it must stay out of the tarball.
  if (entries.includes('vendor/ssh2-entry.mjs'))
    problems.push('tarball contains the build-only input vendor/ssh2-entry.mjs')
  console.log(`[pack-check] tarball entries: ${entries.length}`)
}
if (problems.length > 0) fail(problems.join('\n  - '))
console.log(`[pack-check] OK: ${pkg.name}@${pkg.version}${tarball ? ` (tarball ${path.basename(tarball)})` : ''}`)

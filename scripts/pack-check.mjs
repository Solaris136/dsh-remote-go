// Verify the published artifact without publishing: `node scripts/pack-check.mjs` checks the
// package.json `files` coverage, and `... <plugin.tgz>` also inspects the packed tarball.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL#pathname: pathname percent-encodes characters such as the
// space in "C:\Work\my repo", which made every gate resolve the wrong repository root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const cliArgs = process.argv.slice(2)
const findIndex = cliArgs.indexOf('--find')
let tarball = cliArgs.find((arg, index) => !arg.startsWith('--') && index !== findIndex + 1) ?? null
if (findIndex >= 0) {
  const dir = path.resolve(root, cliArgs[findIndex + 1] ?? 'artifacts')
  tarball = await newestTarball(dir)
  if (!tarball) fail(`--find ${cliArgs[findIndex + 1] ?? 'artifacts'}: no .tgz tarball found; run pnpm pack first`)
  console.log(`[pack-check] tarball: ${path.relative(root, tarball)}`)
}

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

function fail(message) {
  console.error(`[pack-check] ${message}`)
  process.exit(1)
}

/** Repository-relative TypeScript sources under `dir`; declarations emit no artifact. */
async function walkTs(dir, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await walkTs(rel, out)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** Repository-relative `.js` artifacts under `dir`. */
async function walkJs(dir, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await walkJs(rel, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel)
  }
  return out
}

// The tarball ships built JavaScript, and the build output lives in `dist/`: `exports["."]` and
// `exports["./client"]` point into it directly, so there is no staged copy at the package root.
// DSH's client loader reads `exports["./client"]` (dsh-client-modules/clientExportOf), which is
// what makes the dist layout safe to publish instead of a root copy.
//
// One artifact per source, compared as a *set*: `dist/` plus the source path with `.ts` → `.js`.
// A count comparison let one stale artifact hide a missing one, and reported only numbers; this
// names the file that is missing (a `.ts` added without a rebuild) or extra (a `.ts` deleted
// without a clean rebuild).
const expectedArtifacts = new Set((await walkTs('src')).map((source) => `dist/${source.replace(/\.ts$/, '.js')}`))

/**
 * Compare one artifact set against the sources, naming both directions.
 * @param actual - the `.js` paths that were found (working tree or tarball entry names).
 * @param where - what the set describes, for the message.
 */
function compareArtifacts(actual, where) {
  const missing = [...expectedArtifacts].filter((file) => !actual.has(file)).sort()
  const extra = [...actual].filter((file) => !expectedArtifacts.has(file)).sort()
  if (missing.length > 0) {
    problems.push(
      `${where} is missing ${missing.length} artifact(s) that a src/ source requires (rebuild): ${missing.join(', ')}`,
    )
  }
  if (extra.length > 0) {
    problems.push(
      `${where} carries ${extra.length} artifact(s) with no src/ source (stale build output): ${extra.join(', ')}`,
    )
  }
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const problems = []

// The vendored ssh2 bundle is imported at runtime by src/ssh.js, so a missing vendor/
// entry is an install-time crash, not a cosmetic packaging bug.
//
// Two lists for the two places the same contract is checked: the working tree holds the build
// output in `dist/`, and the tarball must carry exactly that layout - a root `index.js` or
// `client.js` in the tarball would mean the package and its `exports` disagreed.
const REPOSITORY_FILES = `package.json index.js dist/index.js dist/client.js cordis.patch.yml locale/en.json
locale/zh.json dist/src/index.js dist/src/api.js dist/src/service.js dist/vendor/ssh2.bundle.cjs
vendor/THIRD_PARTY_NOTICES.md README.md LICENSE`.split(/\s+/)
const TARBALL_FILES = `package.json index.js dist/index.js dist/client.js cordis.patch.yml locale/en.json
locale/zh.json dist/src/index.js dist/src/api.js dist/src/service.js dist/vendor/ssh2.bundle.cjs
vendor/THIRD_PARTY_NOTICES.md README.md LICENSE`.split(/\s+/)

for (const file of REPOSITORY_FILES) {
  if (!existsSync(path.join(root, file))) problems.push(`missing file: ${file}`)
}
const files = pkg.files ?? []
// A directory entry (`src`) covers its files; an explicit file stays exact.
const ships = (needed) =>
  files.some((entry) => entry === needed || entry.startsWith(`${needed}/`) || needed.startsWith(`${entry}/`))
for (const needed of ['dist', 'vendor/THIRD_PARTY_NOTICES.md', 'README.md', 'LICENSE']) {
  if (!ships(needed)) problems.push(`files[] must ship ${needed}`)
}
// The loader contract: DSH imports the host half through `exports["."]` and resolves the browser
// bundle through `exports["./client"]` (dsh-client-modules/clientExportOf). If either string drifts
// from the build output, every install breaks at load time rather than at pack time.
const exportPaths = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {}
if (exportPaths['.'] !== './index.js') problems.push('exports["."] must be "./index.js"')
if (exportPaths['./client'] !== './dist/client.js') problems.push('exports["./client"] must be "./dist/client.js"')
if (pkg.private === true) problems.push('package.json is private; publishing is refused')

// The working tree is the first half of the same contract: every source has its artifact, and no
// artifact survives a deleted source. The `--find artifacts` pass then checks the tarball again.
if (!tarball) {
  compareArtifacts(new Set(await walkJs('dist/src')), 'dist/src')
}

if (tarball) {
  if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`)
  let listing = ''
  try {
    listing = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
      // windowsHide keeps a console from flashing for every child the gates start.
      windowsHide: true,
    })
  } catch (error) {
    fail(`cannot list tarball with tar: ${error.message}`)
  }
  const entries = listing
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ''))
  const missing = TARBALL_FILES.filter((file) => !entries.includes(file))
  if (missing.length > 0) problems.push(`tarball is missing: ${missing.join(', ')}`)
  const stray = entries.filter(
    (file) =>
      file.startsWith('test/') || file.startsWith('e2e/') || file.startsWith('_research/') || file.startsWith('docs/'),
  )
  if (stray.length > 0) problems.push(`tarball contains development files: ${stray.slice(0, 10).join(', ')}`)
  // The published layout is `dist/` plus the `index.js` entry the DSH loader opens. A root
  // `client.js` or a root `src/` in the tarball means an older in-place build leaked back in.
  if (entries.includes('client.js')) problems.push('tarball contains a root client.js; the bundle lives in dist/')
  if (!entries.includes('index.js')) problems.push('tarball is missing the root index.js entry shim')
  const rootSources = entries.filter((file) => file.startsWith('src/'))
  if (rootSources.length > 0)
    problems.push(`tarball contains root src/ entries: ${rootSources.slice(0, 10).join(', ')}`)
  // P1e: the `.js` files are build output, so the only guarantee that a published module exists
  // is the tarball itself. Every `.ts` source must be represented, and no `.ts` may slip in.
  const typescriptSources = entries.filter((file) => file.endsWith('.ts'))
  if (typescriptSources.length > 0)
    problems.push(`tarball contains TypeScript sources: ${typescriptSources.slice(0, 10).join(', ')}`)
  const shippedArtifacts = new Set(entries.filter((file) => file.startsWith('dist/src/') && file.endsWith('.js')))
  compareArtifacts(shippedArtifacts, 'the tarball')
  // Assert the vendor runtime explicitly: the mirror lives next to the emitted adapter, so a
  // `files[]` or build regression that drops it is an install-time crash, not a cosmetic one.
  if (!entries.includes('dist/vendor/ssh2.bundle.cjs'))
    problems.push('tarball does not contain dist/vendor/ssh2.bundle.cjs (the runtime ssh2 bundle)')
  // `vendor/ssh2-entry.mjs` is the esbuild input, not runtime code: it must stay out of
  // the published tarball even though it is versioned in the repository.
  if (entries.includes('vendor/ssh2-entry.mjs'))
    problems.push('tarball contains the build-only input vendor/ssh2-entry.mjs')
  console.log(`[pack-check] tarball entries: ${entries.length}`)
}

if (problems.length > 0) fail(problems.join('\n  - '))
console.log(`[pack-check] OK: ${pkg.name}@${pkg.version}${tarball ? ` (tarball ${path.basename(tarball)})` : ''}`)

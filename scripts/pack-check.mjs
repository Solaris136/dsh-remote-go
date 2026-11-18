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

// The tarball must ship one `.js` per TypeScript source under `src/`. Since P1e those files are
// not committed: `files[]` plus a real `pnpm build` (run by `prepack`) are the only things that
// put them in the package, so a packaging regression here publishes a package whose `exports`
// point at nothing. Since the dist move the build output lives in `dist/`, and `prepack`'s
// `scripts/stage-publish.mjs` copies it to the published root layout before pnpm reads `files[]`.
// `index.ts` -> `dist/index.js` -> `index.js` is covered by the entries below.
const sourceCount = (await walkTs('src')).length

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const problems = []

// The vendored ssh2 bundle is imported at runtime by src/ssh.js, so a missing vendor/
// entry is an install-time crash, not a cosmetic packaging bug.
//
// Two lists, because the two sides genuinely differ: the working tree holds the build output in
// `dist/`, and the tarball holds the staged copy at the package root (`index.js`, `client.js`,
// `src/**/*.js`). Asserting the tarball layout is what keeps DSH's loader and `exports` working;
// asserting the `dist/` layout is what proves a `pnpm pack` from this tree would have something
// to stage.
const REPOSITORY_FILES = `package.json dist/index.js dist/client.js cordis.patch.yml locale/en.json
locale/zh.json dist/src/index.js dist/src/api.js dist/src/service.js vendor/ssh2.bundle.cjs
vendor/THIRD_PARTY_NOTICES.md README.md LICENSE`.split(/\s+/)
const TARBALL_FILES = `index.js client.js cordis.patch.yml locale/en.json locale/zh.json src/index.js
src/api.js src/service.js vendor/ssh2.bundle.cjs vendor/THIRD_PARTY_NOTICES.md README.md LICENSE
package.json`.split(/\s+/)

for (const file of REPOSITORY_FILES) {
  if (!existsSync(path.join(root, file))) problems.push(`missing file: ${file}`)
}
const files = pkg.files ?? []
// A directory entry (`src`) covers its files; an explicit file stays exact.
const ships = (needed) =>
  files.some((entry) => entry === needed || entry.startsWith(`${needed}/`) || needed.startsWith(`${entry}/`))
for (const needed of [
  'index.js',
  'client.js',
  'src',
  'vendor/ssh2.bundle.cjs',
  'vendor/THIRD_PARTY_NOTICES.md',
  'README.md',
  'LICENSE',
]) {
  if (!ships(needed)) problems.push(`files[] must ship ${needed}`)
}
// The sources are `.ts` (P1e): without the negation the tarball would ship them next to the
// emitted `.js`, which is neither the published contract nor needed by a consumer.
if (!files.includes('!src/**/*.ts')) problems.push('files[] must exclude the TypeScript sources with "!src/**/*.ts"')
if (pkg.private === true) problems.push('package.json is private; publishing is refused')

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
  // `dist/` is the working tree's build output, never a published path: the tarball must carry
  // the staged root layout instead (asserted by `TARBALL_FILES`).
  const distEntries = entries.filter((file) => file === 'dist' || file.startsWith('dist/'))
  if (distEntries.length > 0)
    problems.push(`tarball contains the local build directory: ${distEntries.slice(0, 10).join(', ')}`)
  if (!entries.some((file) => file.startsWith('src/') && file.endsWith('.js')))
    problems.push('tarball does not contain src/*.js')
  // P1e: the `.js` files are build output, so the only guarantee that a published module exists
  // is the tarball itself. Every `.ts` source must be represented, and no `.ts` may slip in.
  const typescriptSources = entries.filter((file) => file.endsWith('.ts'))
  if (typescriptSources.length > 0)
    problems.push(`tarball contains TypeScript sources: ${typescriptSources.slice(0, 10).join(', ')}`)
  const shippedArtifacts = entries.filter((file) => file.startsWith('src/') && file.endsWith('.js'))
  if (shippedArtifacts.length < sourceCount)
    problems.push(
      `tarball ships ${shippedArtifacts.length} src/**/*.js but the repository has ${sourceCount} TypeScript source(s); run pnpm build before packing`,
    )
  // Assert the vendor runtime explicitly: `mustShip` covers the two files, this catches a
  // `files[]` regression that drops the whole directory from the published tarball.
  if (!entries.some((file) => file.startsWith('vendor/')))
    problems.push('tarball does not contain vendor/ (the runtime ssh2 bundle)')
  // `vendor/ssh2-entry.mjs` is the esbuild input, not runtime code: it must stay out of
  // the published tarball even though it is versioned in the repository.
  if (entries.includes('vendor/ssh2-entry.mjs'))
    problems.push('tarball contains the build-only input vendor/ssh2-entry.mjs')
  console.log(`[pack-check] tarball entries: ${entries.length}`)
}

if (problems.length > 0) fail(problems.join('\n  - '))
console.log(`[pack-check] OK: ${pkg.name}@${pkg.version}${tarball ? ` (tarball ${path.basename(tarball)})` : ''}`)

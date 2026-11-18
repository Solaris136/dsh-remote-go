// Copy the local build output (`dist/`) into the published root layout.
//
// `dist/` is the only place `pnpm build` writes (`tsconfig.json` outDir; the browser half is
// `dist/client.js`), but the package contract is still the historical root layout:
//
//   dist/index.js          -> index.js      (`exports["."]`)
//   dist/client.js         -> client.js     (`exports["./client"]`, DSH's client loader)
//   dist/src/**/*.js       -> src/**/*.js   (the Host half's modules)
//
// `prepack` runs this script, `pnpm pack` then reads `files[]` from the root layout, and
// `postpack` (`scripts/unstage-publish.mjs`) removes exactly these copies again. The working
// tree therefore never keeps a generated file outside `dist/`, while the tarball is
// item-for-item identical to the one the plugin has always published.
//
// The copy is deliberately `.js`-only: a `.ts` in the tarball would be a packaging regression
// (decision I in .agents/refactor/DECISIONS.md), so a source file that ever lands in `dist/`
// fails here instead of being copied into the package.
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = 'dist'
// `scripts/build.mjs` mirrors the vendored ssh2 bundle into `dist/vendor/` so the emitted adapter
// resolves `../vendor/ssh2.bundle.cjs` inside the build output. It is not a published path: the
// tarball ships the real `vendor/` directory at the package root (`files[]`), so staging skips the
// mirror instead of copying a third-party blob that is already in the package.
const LOCAL_ONLY = `${DIST}/vendor`

function fail(message) {
  console.error(`[stage-publish] ${message}`)
  process.exit(1)
}

/** Repository-relative paths of every file under `dir`, recursively. */
async function walk(dir, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (rel === LOCAL_ONLY) continue
    if (entry.isDirectory()) await walk(rel, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * Where one `dist/` file is published from. Everything under `dist/` is emitted output, so the
 * mapping is the identity minus the `dist/` prefix - but only for the three published shapes.
 * Anything else (a stray `.d.ts`, a source map, a test fixture) is a packaging bug, not a copy
 * candidate, and fails the stage.
 */
function publishedPathOf(relative) {
  if (relative === 'index.js') return 'index.js'
  if (relative === 'client.js') return 'client.js'
  if (relative.startsWith('src/')) return relative
  return null
}

if (!(await stat(path.join(root, DIST)).catch(() => null))?.isDirectory()) {
  fail(`${DIST}/ does not exist; run pnpm build before staging`)
}

const entries = await walk(DIST)
if (entries.length === 0) fail(`${DIST}/ is empty; run pnpm build before staging`)

const copies = []
for (const relative of entries.sort()) {
  if (!relative.endsWith('.js')) fail(`${relative}: only .js build output may be staged into the package`)
  const inside = relative.slice(DIST.length + 1)
  const published = publishedPathOf(inside)
  if (published === null) fail(`${relative}: has no published path (expected index.js, client.js or src/**/*.js)`)
  if (!published.endsWith('.js')) fail(`${published}: a staged file must be JavaScript`)
  copies.push({ from: relative, to: published })
}

for (const { from, to } of copies) {
  await mkdir(path.dirname(path.join(root, to)), { recursive: true })
  await copyFile(path.join(root, from), path.join(root, to))
}

// The published entry points are addressed by name by `exports` and by DSH's loader, so their
// absence is a hard failure even though the generic copy above would have reported it as zero.
for (const required of ['index.js', 'client.js']) {
  if (!copies.some((copy) => copy.to === required)) fail(`${DIST}/${required}: the published entry point is missing`)
}

const modules = copies.filter((copy) => copy.to.startsWith('src/')).length
console.log(
  `[stage-publish] staged ${copies.length} file(s) from ${DIST}/: index.js, client.js, src/**/*.js (${modules} module(s))`,
)

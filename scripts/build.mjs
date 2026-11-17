// Build the published JavaScript from the TypeScript sources.
//
// tsc emits next to each source on purpose (`src/x.ts` -> `src/x.js`, `index.ts` -> `index.js`,
// no `outDir`): the package `exports`, the DSH plugin loader, the test suite and the packed
// tarball all address `.js` paths, so the emitted layout has to be the published layout exactly
// (decision D1 in .agents/refactor/PLAN.md).
//
// The artifacts are not committed since P1e (`.gitignore`, decision I in DECISIONS.md): the
// sources are the only product code, so every consumer builds first — `pretest`, `gate`,
// `verify` and `prepack` — and the published tarball still ships the emitted `.js`, because
// `files[]` is honoured regardless of `.gitignore` by `pnpm pack`.
//
// Clean before compiling: deleting or renaming a `.ts` leaves its old `.js` behind, and that
// stale artifact would be packed as a module that no longer exists. The cleanup therefore
// removes exactly what this build generates and nothing else — `client.js` is still hand-written
// source (P3 turns it into an artifact) and `vendor/`, `types/` and `test/` are never touched.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

// The only generated paths in the repository: `src/` and the package root hold sources (`.ts`)
// whose emitted twins (`.js`) live beside them. `src/` is walked recursively so a nested layout
// (P2's `src/proxy/index.js`) is cleaned as well.
const CLEAN_DIRECTORIES = ['src']
const CLEAN_ROOT_FILES = ['index.js']

/** Repository-relative paths under `dir` whose name matches `accept`. */
async function walk(dir, accept, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await walk(rel, accept, out)
    else if (entry.isFile() && accept(entry.name)) out.push(rel)
  }
  return out
}

// The CLI pinned by this lockfile, never a global `tsc`/`npx`: a different TypeScript
// version reprints the emitted artifacts and would then read as drift on every machine
// except the one that ran the build.
const cli = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

// Checked before the cleanup: a missing compiler must not be able to delete the artifacts it
// was supposed to regenerate.
if (!existsSync(cli)) {
  console.error(`[build] typescript is not installed (${path.relative(root, cli)}); run pnpm install`)
  process.exit(1)
}

const stale = []
for (const dir of CLEAN_DIRECTORIES) stale.push(...(await walk(dir, (name) => name.endsWith('.js'))))
for (const file of CLEAN_ROOT_FILES) if (existsSync(path.join(root, file))) stale.push(file)

for (const file of stale) await rm(path.join(root, file))
console.log(`[build] cleaned ${stale.length} generated artifact(s) before compiling`)

const result = spawnSync(process.execPath, [cli, '-p', path.join(root, 'tsconfig.json')], {
  cwd: root,
  // inherit: tsc's own diagnostics are the useful output, and a wrapper must not reshape them.
  stdio: 'inherit',
  // windowsHide keeps a console from flashing for every child the gates start.
  windowsHide: true,
})

if (result.error) {
  console.error(`[build] cannot start tsc: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[build] tsc failed with exit code ${result.status ?? 'unknown'}`)
  process.exit(result.status === null ? 1 : result.status)
}
console.log('[build] OK: tsc emitted the published layout')

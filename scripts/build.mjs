// Build the committed JavaScript artifacts from the TypeScript sources.
//
// tsc emits next to each source on purpose (`src/x.ts` -> `src/x.js`, `index.ts` ->
// `index.js`, no `outDir`): the package `exports`, the DSH plugin loader, the test suite
// and the packed tarball all address `.js` paths, so the emitted layout has to be the
// published layout exactly (decision D1 in .agents/refactor/PLAN.md). That also means the
// artifacts are committed, and `scripts/verify-artifacts.mjs` is what keeps them honest.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
// The CLI pinned by this lockfile, never a global `tsc`/`npx`: a different TypeScript
// version reprints the emitted artifacts and would then read as drift on every machine
// except the one that ran the build.
const cli = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(cli)) {
  console.error(`[build] typescript is not installed (${path.relative(root, cli)}); run pnpm install`)
  process.exit(1)
}

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
console.log('[build] OK: tsc emitted the committed layout')

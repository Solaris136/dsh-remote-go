// Remove the copies `scripts/stage-publish.mjs` made for `pnpm pack`.
//
// `postpack` runs this script, so the working tree goes back to "sources only, generated output
// in `dist/`" immediately after a pack. It removes exactly what staging creates and nothing
// else:
//
//   index.js, client.js      the two published entry points
//   src/**/*.js              the emitted twins of `src/**/*.ts`
//
// It never removes `dist/` (the build output that staging copied from), never removes a `.ts`
// source, and never reaches into `client/` (`client/template.js` is a source, not an artifact).
// The `src/` sweep is `.js`-only for that reason: a `.ts` file that ends up in its own path
// list would mean this script was pointed at the wrong tree.
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function fail(message) {
  console.error(`[unstage-publish] ${message}`)
  process.exit(1)
}

/** Repository-relative `.js` paths under `dir`, recursively. */
async function generated(dir, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await generated(rel, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel)
  }
  return out
}

const targets = await generated('src')
for (const file of ['index.js', 'client.js']) {
  if ((await stat(path.join(root, file)).catch(() => null))?.isFile()) targets.push(file)
}

for (const file of targets) {
  // Belt and braces: the list is built from `.js` names and fixed entry points, but a source
  // file must never be deleted by a cleanup script, so the guard is re-asserted here.
  if (!file.endsWith('.js')) fail(`${file}: refusing to remove a non-JavaScript file`)
  await rm(path.join(root, file), { force: true })
}

console.log(
  targets.length === 0
    ? '[unstage-publish] nothing to remove; the package root has no staged artifacts'
    : `[unstage-publish] removed ${targets.length} staged file(s) (index.js/client.js/src/**/*.js); dist/ is untouched`,
)

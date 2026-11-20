// Remove the generated JavaScript without rebuilding: `dist/` plus the legacy in-place copies a pre-dist checkout may
// have left behind. Every `pnpm test*` entry point builds first, so a tree with no artifacts still works but cannot be
// loaded by Node until built. Only generated output goes (`client/template.js`, `client/src/*.ts`, `vendor/*`,
// `scripts/*.mjs` are sources); `--dry-run` reports.
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dryRun = process.argv.includes('--dry-run')
/** Every generated `.js` under `dir` (recursive). */
async function generated(dir, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await generated(rel, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel)
  }
  return out
}
/** Directories removed wholesale, with the bytes they hold for the report. */
async function directorySize(dir) {
  let bytes = 0
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, dir, entry.name)
    if (entry.isDirectory()) bytes += await directorySize(`${dir}/${entry.name}`)
    else bytes += (await stat(full).catch(() => ({ size: 0 }))).size
  }
  return bytes
}
const targets = await generated('src')
for (const file of ['index.js', 'client.js']) {
  if (existsSync(path.join(root, file))) targets.push(file)
}
const directories = existsSync(path.join(root, 'dist')) ? ['dist'] : []
let bytes = 0
for (const file of targets) bytes += (await stat(path.join(root, file)).catch(() => ({ size: 0 }))).size
for (const dir of directories) bytes += await directorySize(dir)
if (targets.length === 0 && directories.length === 0) {
  console.log('[clean] nothing to remove; the tree has no generated artifacts')
  process.exit(0)
}
if (dryRun) {
  for (const dir of directories) console.log(`[clean] would remove ${dir}/`)
  for (const file of targets) console.log(`[clean] would remove ${file}`)
  const message = `[clean] dry run: ${directories.length} directory(ies) + ${targets.length} file(s), ${(bytes / 1024).toFixed(1)} KiB`
  console.log(message)
  process.exit(0)
}
for (const dir of directories) await rm(path.join(root, dir), { recursive: true, force: true })
for (const file of targets) await rm(path.join(root, file), { force: true })
console.log(
  `[clean] removed ${directories.length} directory(ies) + ${targets.length} file(s), ${(bytes / 1024).toFixed(1)} KiB; run \`pnpm build\` to restore`,
)

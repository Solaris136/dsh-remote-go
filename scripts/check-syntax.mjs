// Syntax-check every JavaScript entry that runs in production, tests, scripts or
// the fixture tooling. `node --check` parses ESM/CJS without executing it, so a
// browser bundle (client.js) and Node plugin files are both covered.
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const includeDirs = ['src', 'scripts', 'test', 'e2e/control']
const includeFiles = ['index.js', 'client.js']
const skipDirs = new Set([
  'node_modules',
  '_research',
  '_tools',
  'artifacts',
  'home',
  'home-published',
  'logs',
  'vendor',
])

/** @param {string} dir @param {string[]} out */
async function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      await walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue
    // Skip generated fixtures and packaged copies.
    if (entry.name.endsWith('.bundle.cjs')) continue
    out.push(path.join(dir, entry.name))
  }
}

/** @type {string[]} */
const files = []
for (const dir of includeDirs) await walk(path.join(root, dir), files)
for (const file of includeFiles) {
  const full = path.join(root, file)
  if (existsSync(full)) files.push(full)
}

const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0)
    failures.push({ file: path.relative(root, file), error: (result.stderr || '').split('\n').slice(0, 6).join('\n') })
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-syntax] FAIL ${failure.file}\n${failure.error}`)
  process.exit(1)
}
console.log(`[check-syntax] OK: ${files.length} files parsed`)

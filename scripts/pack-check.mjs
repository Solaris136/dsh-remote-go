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

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const problems = []

// The vendored ssh2 bundle is imported at runtime by src/ssh.js, so a missing vendor/
// entry is an install-time crash, not a cosmetic packaging bug.
const mustShip = `index.js client.js cordis.patch.yml locale/en.json locale/zh.json src/index.js
src/api.js src/service.js vendor/ssh2.bundle.cjs vendor/THIRD_PARTY_NOTICES.md README.md LICENSE
package.json`.split(/\s+/)

for (const file of mustShip) {
  if (!existsSync(path.join(root, file))) problems.push(`missing file: ${file}`)
}
const files = pkg.files ?? []
if (!files.includes('src') && !files.some((entry) => entry.startsWith('src/'))) problems.push('files[] must ship src/')
if (!files.includes('client.js')) problems.push('files[] must ship client.js')
if (!files.includes('vendor') && !files.some((entry) => entry.startsWith('vendor/')))
  problems.push('files[] must ship vendor/ (the runtime ssh2 bundle)')
if (!files.includes('README.md')) problems.push('files[] must ship README.md')
if (!files.includes('LICENSE')) problems.push('files[] must ship LICENSE')
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
  const missing = mustShip.filter((file) => !entries.includes(file))
  if (missing.length > 0) problems.push(`tarball is missing: ${missing.join(', ')}`)
  const stray = entries.filter(
    (file) =>
      file.startsWith('test/') || file.startsWith('e2e/') || file.startsWith('_research/') || file.startsWith('docs/'),
  )
  if (stray.length > 0) problems.push(`tarball contains development files: ${stray.slice(0, 10).join(', ')}`)
  if (!entries.some((file) => file.startsWith('src/') && file.endsWith('.js')))
    problems.push('tarball does not contain src/*.js')
  // Assert the vendor/ tree explicitly: `mustShip` covers the two files, this catches a
  // `files[]` regression that drops the whole directory from the published tarball.
  if (!entries.some((file) => file.startsWith('vendor/')))
    problems.push('tarball does not contain vendor/ (the runtime ssh2 bundle)')
  console.log(`[pack-check] tarball entries: ${entries.length}`)
}

if (problems.length > 0) fail(problems.join('\n  - '))
console.log(`[pack-check] OK: ${pkg.name}@${pkg.version}${tarball ? ` (tarball ${path.basename(tarball)})` : ''}`)

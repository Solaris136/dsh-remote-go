// Verify the published artifact without publishing: check `files` coverage and,
// when given a tarball, that the archive contains exactly the runtime files.
//
// Usage:
//   node scripts/pack-check.mjs                  # check package.json files coverage
//   node scripts/pack-check.mjs <plugin.tgz>     # additionally inspect the packed tarball
//
// The tarball check reads the gzip header listing via `tar -tzf` (POSIX tar is
// present on Windows 10+, macOS and Linux); if tar is unavailable the check
// reports that instead of silently passing.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const cliArgs = process.argv.slice(2)
const findIndex = cliArgs.indexOf('--find')
/** @type {string | null} */
let tarball = cliArgs.find((arg, index) => !arg.startsWith('--') && index !== findIndex + 1) ?? null
if (findIndex >= 0) {
  const dir = path.resolve(root, cliArgs[findIndex + 1] ?? 'artifacts')
  tarball = await newestTarball(dir)
  if (!tarball) fail(`--find ${cliArgs[findIndex + 1] ?? 'artifacts'}: no .tgz tarball found; run pnpm pack first`)
  console.log(`[pack-check] tarball: ${path.relative(root, tarball)}`)
}

/** @param {string} dir */
async function newestTarball(dir) {
  if (!existsSync(dir)) return null
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.tgz'))
  if (entries.length === 0) return null
  let best = null
  let bestTime = -1
  for (const name of entries) {
    const full = path.join(dir, name)
    const stat = await statFile(full)
    if (stat.mtimeMs > bestTime) {
      best = full
      bestTime = stat.mtimeMs
    }
  }
  return best
}

/** @param {string} file */
async function statFile(file) {
  const { stat } = await import('node:fs/promises')
  return stat(file)
}

function fail(message) {
  console.error(`[pack-check] ${message}`)
  process.exit(1)
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const problems = []

const mustShip = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'src/index.js',
  'src/api.js',
  'src/service.js',
  'package.json',
]

for (const file of mustShip) {
  if (!existsSync(path.join(root, file))) problems.push(`missing file: ${file}`)
}
const files = pkg.files ?? []
if (!files.includes('src') && !files.some((entry) => entry.startsWith('src/'))) problems.push('files[] must ship src/')
if (!files.includes('client.js')) problems.push('files[] must ship client.js')
if (pkg.private === true) problems.push('package.json is private; publishing is refused')

if (tarball) {
  if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`)
  let listing
  try {
    listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
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
  console.log(`[pack-check] tarball entries: ${entries.length}`)
}

if (problems.length > 0) fail(problems.join('\n  - '))
console.log(`[pack-check] OK: ${pkg.name}@${pkg.version}${tarball ? ` (tarball ${path.basename(tarball)})` : ''}`)

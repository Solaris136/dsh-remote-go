// Verify the published artifact without publishing: `node scripts/pack-check.mjs` checks the
// package.json `files` coverage, and `... <plugin.tgz>` also inspects the packed tarball.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
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

const mustShip = `index.js client.js cordis.patch.yml locale/en.json locale/zh.json src/index.js
src/api.js src/service.js package.json`.split(/\s+/)

for (const file of mustShip) {
  if (!existsSync(path.join(root, file))) problems.push(`missing file: ${file}`)
}
const files = pkg.files ?? []
if (!files.includes('src') && !files.some((entry) => entry.startsWith('src/'))) problems.push('files[] must ship src/')
if (!files.includes('client.js')) problems.push('files[] must ship client.js')
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
  console.log(`[pack-check] tarball entries: ${entries.length}`)
}

if (problems.length > 0) fail(problems.join('\n  - '))
console.log(`[pack-check] OK: ${pkg.name}@${pkg.version}${tarball ? ` (tarball ${path.basename(tarball)})` : ''}`)

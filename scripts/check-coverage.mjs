// Regression fences: Node's aggregate thresholds cannot express a per-file floor, and a
// global aggregate let a large untested file hide next to well-tested ones. This script
// runs the unit suite twice with the same coverage engine:
//
//   1. the runtime sources, with the original aggregate floors (85 / 70 / 80), the
//      per-file floors below, and a coverage-completeness check: every `.ts` under `src/`
//      must have its emitted `.js` under `dist/src/` and must appear in the report. A new module that no unit
//      test imports never enters the report, so without that check it is invisible to every
//      floor here (the 85% aggregate quietly dips by nothing at all).
//   2. client.js on its own, so the 310 KB browser half is actually measured (it used to
//      be invisible because the vm context loaded it with a relative filename).
//
// Regressions therefore fail on the file that caused them instead of drifting inside a
// still-passing aggregate. Run: node scripts/check-coverage.mjs (CI / release / verify).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const GLOBAL_FLOORS = ['--test-coverage-lines=85', '--test-coverage-branches=70', '--test-coverage-functions=80']
const PER_FILE_FLOORS = new Map([
  // These two files sat far below the aggregate: local-ssh.js was at 29.63% line
  // coverage while the repository-wide number still passed.
  ['dist/src/local-ssh.js', 95],
  ['dist/src/local-download.js', 90],
])
const CLIENT_ARTIFACT = 'dist/client.js'
const CLIENT_FLOOR = 70
const TEST_GLOB = 'test/unit/*.test.ts'

function runCoverage(label, args) {
  console.log(`[check-coverage] ${label}`)
  const result = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // windowsHide keeps a console from flashing for every child the gates start.
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`)
  return { status: result.status, output }
}

/**
 * Parse the textual coverage table into `path -> line %`.
 *
 * The table is a tree: a directory row carries no percentage and is indented one space per level,
 * and each of its files is indented one space deeper. Tracking "the last directory row" instead
 * would mis-file every top-level source that sorts after a nested directory (`src/connect/` landed
 * in P2, so `src/local-ssh.js` and `src/local-download.js` came after that subtree and lost their
 * per-file floor silently), which is why the path is rebuilt from the indentation.
 */
function parseCoverage(output) {
  const percentages = new Map()
  const directories = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('ℹ')) continue
    const body = line.slice(1)
    const separator = body.indexOf('|')
    if (separator === -1) continue
    const name = body.slice(0, separator).trim()
    if (name === '' || name === 'file') continue
    const indent = body.length - body.trimStart().length
    const linePercent = Number.parseFloat(
      body
        .slice(separator + 1)
        .split('|')[0]
        .trim(),
    )
    if (!Number.isFinite(linePercent)) {
      directories[indent] = name
      directories.length = indent + 1
      continue
    }
    // A row that already carries a path (some Node versions print the relative path) is used
    // as-is; every other file row is joined with the directory rows above it.
    const parents = directories.slice(1, indent).filter(Boolean)
    const file = name.includes('/') || parents.length === 0 ? name : `${parents.join('/')}/${name}`
    percentages.set(file, linePercent)
  }
  return percentages
}

const failures = []

/**
 * Every hand-written runtime source, as the `dist/src/...` `.js` path the report uses.
 *
 * `.d.ts` files emit nothing, so they are excluded by construction; everything else must have an
 * artifact *and* a row in the report. A module nobody imports is exactly the case the aggregate
 * floors cannot see: it never executes, so it is absent from the report instead of reading 0%.
 */
async function runtimeSources(dir, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await runtimeSources(rel, out)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** The report/artifact names of every `.ts` under `src/`, sorted and deduplicated. */
async function expectedArtifacts() {
  const sources = await runtimeSources('src')
  return [...new Set(sources.map((file) => `dist/${file.replace(/\.ts$/, '.js')}`))].sort()
}

// A nonzero test run can mean two very different things: the thresholds rejected the
// percentages, or the unit tests themselves failed. Node prints "does not meet threshold"
// only for the former, so the report must not blame coverage when a test is broken.
const THRESHOLD_FAILURE = /does not meet threshold/
function classifyRun(result, label) {
  if (result.status === 0) return null
  if (THRESHOLD_FAILURE.test(result.output)) return `${label}: coverage floors were not met (see the report above)`
  return `${label}: the unit tests failed (process exited ${result.status}); coverage floors were not evaluated`
}

const sourceRun = runCoverage('runtime sources (aggregate floors 85 / 70 / 80)', [
  '--test-coverage-exclude=vendor/**',
  // `scripts/build.mjs` mirrors the vendored ssh2 bundle into `dist/vendor/` so the emitted
  // adapter's `../vendor/ssh2.bundle.cjs` import resolves; it is a third-party blob, not product
  // code, and measuring it would sink the function floor on its own.
  '--test-coverage-exclude=dist/vendor/**',
  '--test-coverage-exclude=test/**',
  `--test-coverage-exclude=${CLIENT_ARTIFACT}`,
  ...GLOBAL_FLOORS,
  TEST_GLOB,
])
const sourceFailure = classifyRun(sourceRun, 'runtime-source pass')
if (sourceFailure) failures.push(sourceFailure)
// If the tests failed, the second pass would fail the same way; report the test failure
// once and skip the extra run instead of emitting a misleading coverage verdict.
const testsFailed = sourceRun.status !== 0 && !THRESHOLD_FAILURE.test(sourceRun.output)
const sourcePercentages = parseCoverage(sourceRun.output)
for (const [file, floor] of PER_FILE_FLOORS) {
  const actual = sourcePercentages.get(file)
  if (actual === undefined) {
    if (!testsFailed)
      failures.push(`${file}: not present in the coverage report (per-file floor ${floor}% cannot be enforced)`)
  } else if (actual < floor) {
    failures.push(`${file}: ${actual.toFixed(2)}% line coverage is below the per-file floor of ${floor}%`)
  }
}

// Coverage completeness: the numbers above only guard files that reached the report. Listing the
// sources and requiring a row for each is what makes a brand-new, never-imported module fail here
// instead of silently sitting outside every floor.
if (!testsFailed) {
  const expected = await expectedArtifacts()
  const unbuilt = expected.filter((file) => !existsSync(path.join(root, file)))
  if (unbuilt.length > 0) {
    failures.push(
      `coverage completeness: ${unbuilt.length} source(s) have no build output — run pnpm build:\n  ${unbuilt.join('\n  ')}`,
    )
  }
  const missing = expected.filter((file) => !unbuilt.includes(file) && !sourcePercentages.has(file))
  if (missing.length > 0) {
    failures.push(
      `coverage completeness: ${missing.length} source(s) are absent from the coverage report, so no floor measures them (no unit test imports them):\n  ${missing.join('\n  ')}`,
    )
  }
  if (expected.length === 0)
    failures.push('coverage completeness: no `.ts` source under src/ was found; the scan is broken')
}

let clientPercentages = new Map()
if (!testsFailed) {
  const clientRun = runCoverage(`${CLIENT_ARTIFACT} (per-file floor)`, [
    `--test-coverage-include=${CLIENT_ARTIFACT}`,
    `--test-coverage-lines=${CLIENT_FLOOR}`,
    '--test-coverage-branches=60',
    '--test-coverage-functions=55',
    TEST_GLOB,
  ])
  const clientFailure = classifyRun(clientRun, `${CLIENT_ARTIFACT} pass`)
  if (clientFailure) failures.push(clientFailure)
  clientPercentages = parseCoverage(clientRun.output)
  if (!clientPercentages.has(CLIENT_ARTIFACT)) {
    failures.push(
      `${CLIENT_ARTIFACT}: not present in the coverage report (the vm context must load it by absolute path)`,
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-coverage] FAIL: ${failure}`)
  process.exit(1)
}
const measured = [...PER_FILE_FLOORS.keys()]
  .map((file) => `${file} ${sourcePercentages.get(file).toFixed(2)}%`)
  .join(', ')
console.log(
  `[check-coverage] OK: aggregate floors met; ${measured}; ${CLIENT_ARTIFACT} ${clientPercentages.get(CLIENT_ARTIFACT).toFixed(2)}%`,
)

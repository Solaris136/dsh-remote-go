// Coverage gate. Node's aggregate thresholds cannot express a per-file floor, and a
// global aggregate let a large untested file hide next to well-tested ones. This script
// runs the unit suite twice with the same coverage engine:
//
//   1. the runtime sources, with the original aggregate floors (85 / 70 / 80) and the
//      per-file floors below;
//   2. client.js on its own, so the 310 KB browser half is actually measured (it used to
//      be invisible because the vm context loaded it with a relative filename).
//
// Regressions therefore fail on the file that caused them instead of drifting inside a
// still-passing aggregate. Run: node scripts/check-coverage.mjs (CI / release / verify).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const GLOBAL_FLOORS = ['--test-coverage-lines=85', '--test-coverage-branches=70', '--test-coverage-functions=80']
const PER_FILE_FLOORS = new Map([
  // These two files sat far below the aggregate: local-ssh.js was at 29.63% line
  // coverage while the repository-wide number still passed.
  ['src/local-ssh.js', 95],
  ['src/local-download.js', 90],
])
const CLIENT_FLOOR = 70

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
 * Parse the textual coverage table into `path -> line %`. Directory rows have no
 * percentage and set the current section (`src`, `e2e`, ...); file rows carry one.
 */
function parseCoverage(output) {
  const percentages = new Map()
  let section = ''
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('ℹ')) continue
    const body = line.slice(1)
    const separator = body.indexOf('|')
    if (separator === -1) continue
    const name = body.slice(0, separator).trim()
    if (name === '' || name === 'file') continue
    const linePercent = Number.parseFloat(
      body
        .slice(separator + 1)
        .split('|')[0]
        .trim(),
    )
    if (!Number.isFinite(linePercent)) {
      section = name
      continue
    }
    // File rows are shown under their directory section; a row that already carries a
    // path (some Node versions print the relative path) is used as-is.
    const file = name.includes('/') ? name : section === '' ? name : `${section}/${name}`
    percentages.set(file, linePercent)
  }
  return percentages
}

const failures = []

const sourceRun = runCoverage('runtime sources (aggregate floors 85 / 70 / 80)', [
  '--test-coverage-exclude=vendor/**',
  '--test-coverage-exclude=test/**',
  '--test-coverage-exclude=client.js',
  ...GLOBAL_FLOORS,
  'test/unit/*.test.js',
])
if (sourceRun.status !== 0) failures.push('the runtime-source coverage run did not meet the aggregate floors')
const sourcePercentages = parseCoverage(sourceRun.output)
for (const [file, floor] of PER_FILE_FLOORS) {
  const actual = sourcePercentages.get(file)
  if (actual === undefined) {
    failures.push(`${file}: not present in the coverage report (per-file floor ${floor}% cannot be enforced)`)
  } else if (actual < floor) {
    failures.push(`${file}: ${actual.toFixed(2)}% line coverage is below the per-file floor of ${floor}%`)
  }
}

const clientRun = runCoverage('client.js (per-file floor)', [
  '--test-coverage-include=client.js',
  `--test-coverage-lines=${CLIENT_FLOOR}`,
  '--test-coverage-branches=60',
  '--test-coverage-functions=55',
  'test/unit/*.test.js',
])
if (clientRun.status !== 0) failures.push(`client.js did not meet its coverage floor (${CLIENT_FLOOR}% lines)`)
const clientPercentages = parseCoverage(clientRun.output)
if (!clientPercentages.has('client.js')) {
  failures.push('client.js: not present in the coverage report (the vm context must load it by absolute path)')
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-coverage] FAIL: ${failure}`)
  process.exit(1)
}
const measured = [...PER_FILE_FLOORS.keys()]
  .map((file) => `${file} ${sourcePercentages.get(file).toFixed(2)}%`)
  .join(', ')
console.log(
  `[check-coverage] OK: aggregate floors met; ${measured}; client.js ${clientPercentages.get('client.js').toFixed(2)}%`,
)

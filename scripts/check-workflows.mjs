// Validate the committed CI workflow YAML files with a real YAML parser.
//
// Resolution order:
//   1. the js-yaml devDependency (what CI installs),
//   2. DSH_JS_YAML, an explicit path to a js-yaml entry point,
//   3. python3 + PyYAML.
//
// Exits 1 when a workflow fails to parse or is missing, and 2 when no YAML
// parser is available at all.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const files = [
  '.github/workflows/ci.yml',
  '.github/workflows/e2e.yml',
  '.github/workflows/codeql.yml',
  '.github/workflows/release.yml',
  '.github/workflows/web-e2e.yml',
]

/** @type {((text: string) => unknown) | null} */
let parse = null
// Preferred: the js-yaml devDependency (installed by pnpm in CI and locally).
try {
  const module = await import('js-yaml')
  const yaml = /** @type {any} */ (module).default ?? module
  parse = (text) => yaml.load(text)
  console.log('[check-workflows] using js-yaml devDependency')
} catch {
  /* fall through to the explicit override / python */
}
// Explicit override for environments that keep js-yaml outside the project.
const override = process.env.DSH_JS_YAML
if (!parse && override) {
  if (!existsSync(override)) {
    console.error(`[check-workflows] DSH_JS_YAML points at a missing file: ${override}`)
    process.exit(2)
  }
  try {
    const require = createRequire(import.meta.url)
    const yaml = require(override)
    parse = (text) => yaml.load(text)
    console.log(`[check-workflows] using js-yaml: ${override}`)
  } catch (error) {
    console.error(
      `[check-workflows] cannot load DSH_JS_YAML (${override}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
if (!parse) {
  // Fallback: python3 + PyYAML.
  const probe = spawnSync('python3', ['-c', 'import yaml; print("ok")'], { encoding: 'utf8' })
  if (probe.status === 0) {
    parse = (text) => {
      const result = spawnSync(
        'python3',
        ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
        {
          input: text,
          encoding: 'utf8',
        },
      )
      if (result.status !== 0) throw new Error(result.stderr)
      return JSON.parse(result.stdout)
    }
    console.log('[check-workflows] using python3 + PyYAML')
  }
}
if (!parse) {
  console.error(
    '[check-workflows] no YAML parser available: install the devDependencies, or set DSH_JS_YAML to a js-yaml entry path',
  )
  process.exit(2)
}

let bad = 0
for (const file of files) {
  const full = path.join(root, file)
  if (!existsSync(full)) {
    bad += 1
    console.error(`[check-workflows] FAIL ${file}: workflow file is missing`)
    continue
  }
  try {
    const doc = /** @type {any} */ (parse(await readFile(full, 'utf8')))
    // Minimal structural assertions: workflows need `on` and `jobs`.
    const problem =
      !doc || typeof doc !== 'object' ? 'not a mapping' : !doc.jobs ? 'missing jobs' : !doc.on ? 'missing on' : null
    if (problem) throw new Error(problem)
    console.log(`[check-workflows] OK ${file} (jobs: ${Object.keys(doc.jobs).join(', ')})`)
  } catch (error) {
    bad += 1
    console.error(`[check-workflows] FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (bad > 0) process.exit(1)
console.log(`[check-workflows] OK: ${files.length} workflows`)

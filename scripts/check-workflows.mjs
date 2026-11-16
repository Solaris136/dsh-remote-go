// Validate the committed CI workflow YAML files with a real parser: the js-yaml
// devDependency, then DSH_JS_YAML, then python3 + PyYAML. Exit 1 on a bad workflow and 2
// when no YAML parser is available.
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL#pathname: pathname percent-encodes characters such as the
// space in "C:\Work\my repo", which made every gate resolve the wrong repository root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workflowDir = path.join(root, '.github', 'workflows')
// Discover the workflows instead of listing them: a new workflow file must be validated
// by CI on the day it is added, not after someone remembers to extend this list.
const files = (await readdir(workflowDir).catch(() => []))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => `.github/workflows/${name}`)
if (files.length === 0) {
  console.error(`[check-workflows] no workflow YAML found under ${path.relative(root, workflowDir)}`)
  process.exit(1)
}

let parse = null
try {
  // Preferred: the js-yaml devDependency (installed by pnpm in CI and locally).
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
    const yaml = createRequire(import.meta.url)(override)
    parse = (text) => yaml.load(text)
    console.log(`[check-workflows] using js-yaml: ${override}`)
  } catch (error) {
    console.error(
      `[check-workflows] cannot load DSH_JS_YAML (${override}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
if (!parse && spawnSync('python3', ['-c', 'import yaml; print("ok")'], { windowsHide: true }).status === 0) {
  parse = (text) => {
    const result = spawnSync(
      'python3',
      ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { input: text, encoding: 'utf8', windowsHide: true },
    )
    if (result.status !== 0) throw new Error(result.stderr)
    return JSON.parse(result.stdout)
  }
  console.log('[check-workflows] using python3 + PyYAML')
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

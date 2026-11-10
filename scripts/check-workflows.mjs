// Validate the committed CI workflow YAML files with a real YAML parser.
// Uses the js-yaml copy shipped with the local DSH desktop profile; falls back
// to python3 + PyYAML when available. Exits non-zero on the first parse error.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const files = ['.github/workflows/ci.yml', '.github/workflows/e2e.yml']

const candidates = [
  process.env.DSH_JS_YAML,
  'C:/Users/zhang/.dsh/profiles/desktop/node_modules/js-yaml/index.js',
  '/usr/local/lib/node_modules/js-yaml/index.js',
].filter(Boolean)

let parse = null
for (const candidate of candidates) {
  if (!candidate || !existsSync(candidate)) continue
  try {
    const require = createRequire(import.meta.url)
    const yaml = require(candidate)
    parse = (text) => yaml.load(text)
    console.log(`[check-workflows] using js-yaml: ${candidate}`)
    break
  } catch {
    /* try next */
  }
}
if (!parse) {
  // Fallback: python3 + PyYAML.
  const probe = spawnSync('python3', ['-c', 'import yaml; print("ok")'], { encoding: 'utf8' })
  if (probe.status === 0) {
    parse = (text) => {
      const result = spawnSync('python3', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], {
        input: text,
        encoding: 'utf8',
      })
      if (result.status !== 0) throw new Error(result.stderr)
      return JSON.parse(result.stdout)
    }
    console.log('[check-workflows] using python3 + PyYAML')
  }
}
if (!parse) {
  console.error('[check-workflows] no YAML parser available (set DSH_JS_YAML to a js-yaml entry path)')
  process.exit(2)
}

let bad = 0
for (const file of files) {
  const full = path.join(root, file)
  try {
    const doc = parse(await readFile(full, 'utf8'))
    // Minimal structural assertions: workflows need `on` and `jobs`.
    const problem = !doc || typeof doc !== 'object' ? 'not a mapping' : !doc.jobs ? 'missing jobs' : !doc.on ? 'missing on' : null
    if (problem) throw new Error(problem)
    console.log(`[check-workflows] OK ${file} (jobs: ${Object.keys(doc.jobs).join(', ')})`)
  } catch (error) {
    bad += 1
    console.error(`[check-workflows] FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (bad > 0) process.exit(1)
console.log(`[check-workflows] OK: ${files.length} workflows`)

// Syntax-check every JavaScript entry that runs in production, tests, scripts or fixtures,
// browser bundle and Node files alike, in one child: a per-file `node --check` flashes a
// Windows console window per spawn (~200 ms).
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const includeDirs = ['src', 'scripts', 'test']
const includeFiles = ['index.js', 'client.js']
const skipDirs = new Set('node_modules _research _tools artifacts home home-published logs vendor'.split(' '))

/** Runs in the child process: parse every file, report failures as JSON on stdout. */
const PARSE_SCRIPT = `
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const failures = []
for (const file of JSON.parse(readFileSync(0, 'utf8'))) {
  try {
    const source = readFileSync(file, 'utf8')
    if (file.endsWith('.cjs')) new vm.Script(source, { filename: file })
    else new vm.SourceTextModule(source, { identifier: file })
  } catch (error) {
    const lines = String(error && error.stack ? error.stack : error).split('\\n').slice(0, 6)
    failures.push({ file, error: lines.join('\\n') })
  }
}
process.stdout.write(JSON.stringify(failures))
`

async function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) await walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue
    // Skip generated fixtures and packaged copies.
    if (entry.name.endsWith('.bundle.cjs')) continue
    out.push(path.join(dir, entry.name))
  }
}

const files = []
for (const dir of includeDirs) await walk(path.join(root, dir), files)
for (const file of includeFiles) {
  const full = path.join(root, file)
  if (existsSync(full)) files.push(full)
}

const parsed = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', PARSE_SCRIPT], {
  input: JSON.stringify(files),
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  // windowsHide keeps a console from flashing for every child the gates start.
  windowsHide: true,
})

let failures = []
if (parsed.status !== 0 || !parsed.stdout) {
  failures = [
    {
      file: '(syntax worker)',
      error: (parsed.stderr || parsed.error?.message || 'the syntax worker did not report a result').slice(0, 1200),
    },
  ]
} else {
  failures = /** @type {{ file: string, error: string }[]} */ (JSON.parse(parsed.stdout))
}

if (failures.length > 0) {
  for (const failure of failures) {
    const name = failure.file.startsWith('(') ? failure.file : path.relative(root, failure.file)
    console.error(`[check-syntax] FAIL ${name}\n${failure.error}`)
  }
  process.exit(1)
}
console.log(`[check-syntax] OK: ${files.length} files parsed`)

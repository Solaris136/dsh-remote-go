/**
 * Cheap source guard: every local child-process call must set `windowsHide: true`.
 *
 * Why: the plugin's gates, unit/integration suites, E2E tooling and PowerShell
 * helpers start many short-lived children (`node`, `git`, `tar`, `python3`, `pnpm`,
 * browsers, Electron, `taskkill`). On Windows each one without `windowsHide` flashes
 * a console window in the maintainer's session — measured: the old
 * `scripts/check-syntax.mjs` spawned one child per file (~66 per `verify` run).
 *
 * Scope: `test/**`, `scripts/**`, `src/**` and `e2e/**`, plus the root entries.
 * `vendor/**` is excluded: it is a pre-built third-party bundle we do not edit.
 * This starts no processes, so it is free and cannot rot.
 *
 * Opt out only where a window is genuinely wanted, by putting
 * `windowsHide-ignore` in a comment on the call's own line or the line above.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INCLUDE_DIRS = ['src', 'scripts', 'test', 'e2e']
const INCLUDE_FILES = ['index.js', 'client.js']
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'artifacts',
  'home',
  'home-published',
  'logs',
  '_research',
  '_tools',
])

/** Unambiguous spawn APIs, bare or qualified (`cp.spawn(...)`, `child_process.spawnSync(...)`). */
const SPAWN_RE = /(?<![\w$])(?:[A-Za-z_$][\w$]*\.)?(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/g
/** `exec` is ambiguous: `ssh.exec(...)` is ssh2, `regex.exec(...)` is a match. Bare calls only. */
const EXEC_RE = /(?<![\w.$])exec\s*\(/g
const OPT_OUT = 'windowsHide-ignore'

/**
 * Remove comments so a `spawn(…)` mentioned in prose is not treated as a call
 * site. Newlines are preserved so reported line numbers stay correct.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let output = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      output += source.slice(index, stop).replace(/[^\n]/g, '')
      index = stop
      continue
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      output += ' '.repeat(stop - index)
      index = stop
      continue
    }
    // Skip string literals so `'//'` inside a string cannot truncate real code.
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === char) break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, source.length)
      output += source.slice(index, stop)
      index = stop
      continue
    }
    output += char
    index += 1
  }
  return output
}

/**
 * The parenthesised parameter text of the call whose name starts at `start`,
 * plus the index of its closing paren.
 * @param {string} source
 * @param {number} start
 * @returns {{ text: string, closeIndex: number }}
 */
function callArguments(source, start) {
  const begin = source.indexOf('(', start)
  if (begin === -1) return { text: '', closeIndex: -1 }
  let depth = 0
  for (let index = begin; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return { text: source.slice(begin, index + 1), closeIndex: index }
    }
  }
  return { text: source.slice(begin), closeIndex: -1 }
}

/** @param {string} dir @param {string[]} out */
async function walk(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
    if (entry.name.endsWith('.bundle.cjs')) continue
    out.push(path.join(dir, entry.name))
  }
}

/**
 * Is the parenthesised text at `openIndex` a *definition* rather than a call?
 * `exec(command, options = {}) {` in a class or object literal is ssh2's method, not
 * a child process; a call is never followed by a `{` body.
 * @param {string} source
 * @param {number} closeIndex index of the closing `)` of the parameter list
 */
function looksLikeDefinition(source, closeIndex) {
  let cursor = closeIndex + 1
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return source[cursor] === '{'
}

/**
 * Every local child-process call site under `test/`, `scripts/`, `src/` and `e2e/`.
 *
 * `windowsHide` is satisfied either literally (`{ windowsHide: true }`) or through a
 * shared options object whose name says so (`CHILD_OPTS_WINDOWS_HIDE`): if you factor
 * the options out, keep `windowsHide` in the identifier so this guard keeps working.
 * @returns {Promise<{ file: string, name: string, arguments: string, line: number, optedOut: boolean }[]>}
 */
async function findCallSites() {
  /** @type {string[]} */
  const files = []
  for (const dir of INCLUDE_DIRS) await walk(path.join(ROOT, dir), files)
  for (const name of INCLUDE_FILES) files.push(path.join(ROOT, name))

  /** @type {{ file: string, name: string, arguments: string, line: number, optedOut: boolean }[]} */
  const sites = []
  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    const source = stripComments(raw)
    const rawLines = raw.split('\n')
    const scan = (regex) => {
      for (const match of source.matchAll(regex)) {
        const index = match.index ?? 0
        const args = callArguments(source, index)
        // `exec(a, b) {` / `async exec(a) {` is a method body, not a child process.
        if (args.closeIndex !== -1 && looksLikeDefinition(source, args.closeIndex)) continue
        const line = source.slice(0, index).split('\n').length
        const context = `${rawLines[line - 2] ?? ''}\n${rawLines[line - 1] ?? ''}`
        sites.push({
          file: path.relative(ROOT, file),
          name: match[1] ?? 'exec',
          arguments: args.text,
          line,
          optedOut: context.includes(OPT_OUT),
        })
      }
    }
    scan(SPAWN_RE)
    scan(EXEC_RE)
  }
  return sites
}

test('every child-process call site sets windowsHide', async () => {
  const sites = await findCallSites()
  assert.ok(
    sites.length >= 10,
    `expected to find the repository's child-process call sites, found ${sites.length} — the scanner is broken`,
  )
  const missing = sites
    .filter((site) => !site.optedOut && !site.arguments.includes('windowsHide'))
    .map((site) => `${site.file}:${site.line} ${site.name}(…) has no windowsHide`)
  assert.deepEqual(missing, [], `these child processes would flash a console on Windows:\n${missing.join('\n')}`)
})

test('no child-process call routes its main invocation through cmd.exe', async () => {
  const sites = await findCallSites()
  // The `.cmd`-shim pattern is what makes Windows flash a window even when Node
  // defaults to hiding its own console.
  const offenders = sites
    .filter((site) => /cmd(?:\.exe)?['"\s,]/.test(site.arguments) || site.arguments.includes("'/c'"))
    .map((site) => `${site.file}:${site.line} ${site.name}(…) still routes through cmd.exe`)
  assert.deepEqual(offenders, [], `invoke the real binary or process.execPath instead:\n${offenders.join('\n')}`)
})

test('the scanner ignores remote, regex and comment call sites', async () => {
  const sites = await findCallSites()
  const dotted = sites.filter((site) => site.name === 'exec')
  assert.deepEqual(
    dotted.map((site) => `${site.file}:${site.line}`),
    [],
    'a `.exec(` call was treated as a local child process',
  )
  assert.equal(
    sites.some((site) => site.file.includes('vendor')),
    false,
    'the vendored bundle must stay out of scope',
  )
})

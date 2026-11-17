// Repository conventions the release process depends on: required files, package metadata,
// version parity, line hygiene, secret hygiene, workflow hygiene and the rule that generated
// artifacts never re-enter the index. Node built-ins only.
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL#pathname: pathname percent-encodes characters such as the
// space in "C:\Work\my repo", which made every gate resolve the wrong repository root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const problems = []
const warnings = []
let checks = 0

function pass() {
  checks += 1
}

function fail(message) {
  problems.push(message)
}

/**
 * One check: a passing condition counts, a failing one records its message.
 */
function check(ok, message) {
  if (ok) pass()
  else fail(message)
}

const abs = (rel) => path.join(root, rel)
const exists = (rel) => existsSync(abs(rel))
const readText = (rel) => readFile(abs(rel), 'utf8').catch(() => null)

async function readJson(rel) {
  try {
    return JSON.parse(await readFile(abs(rel), 'utf8'))
  } catch {
    return null
  }
}

function listLines(numbers) {
  const head = numbers.slice(0, 6).join(', ')
  return numbers.length > 6 ? `${head}, +${numbers.length - 6} more` : head
}

// 1. Required files
const REQUIRED_FILES = `README.md LICENSE CHANGELOG.md
.editorconfig .gitattributes .prettierignore .prettierrc.json .nvmrc
.github/CODEOWNERS .github/PULL_REQUEST_TEMPLATE.md .github/dependabot.yml
.github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml
.github/workflows/ci.yml .github/workflows/codeql.yml .github/workflows/release.yml
docs/design.md docs/implementation.md docs/api.md docs/publish.md
vendor/ssh2-entry.mjs vendor/ssh2.bundle.cjs vendor/THIRD_PARTY_NOTICES.md`.split(/\s+/)

for (const file of REQUIRED_FILES) check(exists(file), `missing required file: ${file}`)

// 2. package.json metadata
const pkg = await readJson('package.json')
if (pkg === null) {
  fail('package.json: missing or not valid JSON')
} else {
  pass()
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const strings = [
    ['name', pkg.name],
    ['version', pkg.version],
    ['description', pkg.description],
    ['license', pkg.license],
    ['homepage', pkg.homepage],
    ['repository.url', pkg.repository?.url],
    ['bugs.url', pkg.bugs?.url],
    ['author', author],
    ['engines.dsh', pkg.engines?.dsh],
    ['engines.node', pkg.engines?.node],
    ['packageManager', pkg.packageManager],
    ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
    ['dsh.client.platform', pkg.dsh?.client?.platform],
  ]
  for (const [field, value] of strings) {
    check(typeof value === 'string' && value.trim() !== '', `package.json: missing or empty "${field}"`)
  }

  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : []
  const keywordOk = keywords.length >= 5 && keywords.every((entry) => typeof entry === 'string' && entry !== '')
  check(keywordOk, `package.json: "keywords" must list at least 5 non-empty strings (found ${keywords.length})`)

  const version = typeof pkg.version === 'string' ? pkg.version : ''
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  check(semver, `package.json: "version" must be an exact SemVer version (found ${JSON.stringify(pkg.version)})`)

  const shipped = Array.isArray(pkg.files) ? pkg.files : []
  // A directory entry (`src`) covers its files; an explicit file stays exact. Tarball-wise
  // `vendor/ssh2-entry.mjs` is a build input, so only the bundle and notices must ship.
  const ships = (needed) =>
    shipped.some((entry) => entry === needed || entry.startsWith(`${needed}/`) || needed.startsWith(`${entry}/`))
  for (const needed of [
    'index.js',
    'client.js',
    'src',
    'locale',
    'cordis.patch.yml',
    'vendor/ssh2.bundle.cjs',
    'vendor/THIRD_PARTY_NOTICES.md',
    'README.md',
    'LICENSE',
  ]) {
    check(ships(needed), `package.json: "files" must ship ${needed}`)
  }

  check(pkg.private !== true, 'package.json: "private" must not be true (npm publish would be refused)')

  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : null
  if (dependencies === null)
    fail('package.json: "dependencies" must be an object (this plugin ships zero runtime dependencies)')
  else if (dependencies.length > 0)
    fail(`package.json: runtime "dependencies" must stay empty (found ${dependencies.join(', ')})`)
  else pass()

  // The npm SPDX identifier must agree with the LICENSE file the tarball ships.
  const licenseText = await readText('LICENSE')
  if (licenseText === null) fail('LICENSE: missing or unreadable')
  else {
    const firstLine = (licenseText.split('\n')[0] ?? '').trim()
    check(firstLine === 'MIT License', `LICENSE: first line must be "MIT License" (found ${JSON.stringify(firstLine)})`)
    check(
      pkg.license === 'MIT',
      `package.json: "license" must be "MIT" to match LICENSE (found ${JSON.stringify(pkg.license)})`,
    )
  }

  // 2b. Integration suite classification. The PR/release gate runs explicit lists because
  // strict-mode coverage must differ per suite; a suite nobody lists silently stops running.
  // Every test suite must therefore be in one of the shared group scripts, or explicitly
  // owned by acceptance.yml.
  const ACCEPTANCE_ONLY_SUITES = new Set(['test/integration/desktop.e2e.js'])
  const GROUP_SCRIPTS = ['test:integration:local', 'test:integration:external']
  const groupCommands = GROUP_SCRIPTS.map((name) => pkg.scripts?.[name])
  for (const [index, name] of GROUP_SCRIPTS.entries()) {
    check(
      typeof groupCommands[index] === 'string' && groupCommands[index].trim() !== '',
      `package.json: missing "${name}" script (CI and release share these suite lists)`,
    )
  }
  const suiteText = groupCommands.filter((command) => typeof command === 'string').join('\n')
  const suiteFiles = (await readdir(abs('test/integration'), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /\.(?:test|e2e)\.js$/.test(entry.name))
    .map((entry) => `test/integration/${entry.name}`)
    .sort()
  for (const file of suiteFiles) {
    if (ACCEPTANCE_ONLY_SUITES.has(file)) {
      pass()
      continue
    }
    check(
      suiteText.includes(file),
      `${file}: no integration group runs this suite; add it to "test:integration:local" (no external harness) or "test:integration:external" (harness/browser) in package.json, or to ACCEPTANCE_ONLY_SUITES when acceptance.yml owns it`,
    )
  }

  // 3. Version parity with the changelog and the reported runtime version
  if (version !== '') {
    const changelog = await readText('CHANGELOG.md')
    if (changelog === null) warnings.push('CHANGELOG.md: missing; skipped the version heading check')
    else {
      const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      check(
        new RegExp(`^##\\s*\\[${escaped}\\]`, 'm').test(changelog),
        `CHANGELOG.md: no "## [${version}]" heading for the released version`,
      )
    }

    // The version the Host half reports at runtime has a second source in
    // src/constants.ts (and therefore in its emitted src/constants.js), with nothing but this
    // check binding it to package.json. The `.ts` is the source of truth: the artifact is
    // regenerated by `pnpm build` and carries the emitter's semicolons.
    const constants = await readText('src/constants.ts')
    if (constants === null) fail('src/constants.ts: missing or unreadable (PLUGIN_VERSION cannot be verified)')
    else {
      // Anchored to a real top-level declaration: a commented-out or doc mention of
      // PLUGIN_VERSION must not satisfy (or break) the version-parity check. A trailing
      // `// comment` on the declaration line is allowed.
      const declared =
        /^\s*export\s+const\s+PLUGIN_VERSION\s*=\s*(['"])([^'"]+)\1(?:\s*\/\/.*)?\s*$/m.exec(constants)?.[2] ?? null
      check(
        declared === version,
        `src/constants.ts: PLUGIN_VERSION is ${JSON.stringify(declared)}, expected ${JSON.stringify(version)} from package.json; set PLUGIN_VERSION in src/constants.ts to ${JSON.stringify(version)}`,
      )
    }
  }
}

// 4. Line hygiene
const MAX_TEXT_BYTES = 1024 * 1024
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'vendor', '.pnpm-store', 'artifacts'])
const SKIPPED_PREFIXES = ['e2e/artifacts/', 'node_modules/', 'vendor/']
const ROOT_DOTFILES =
  '.editorconfig .gitattributes .gitignore .nvmrc .node-version package.json index.js client.js'.split(' ')
// TypeScript sources are machine-read the same way their emitted JavaScript is.
const TABBED_EXTENSIONS = /\.(?:js|mjs|cjs|ts|json|ya?ml)$/

/**
 * Repository-relative paths under `dir` that `accept` allows.
 */
async function walk(dir, accept) {
  const entries = await readdir(abs(dir), { withFileTypes: true }).catch(() => [])
  const found = []
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...(await walk(rel, accept)))
    } else if (entry.isFile() && accept(rel)) {
      found.push(rel)
    }
  }
  return found
}

const hygieneFiles = new Set()
const rootEntries = await readdir(root, { withFileTypes: true }).catch(() => [])
for (const entry of rootEntries) {
  if (!entry.isFile()) continue
  if (entry.name.endsWith('.md') || ROOT_DOTFILES.includes(entry.name)) hygieneFiles.add(entry.name)
}
const directChild = (rel) => rel.split('/').length === 2
const HYGIENE_SWEEP = [
  ['docs', (rel) => rel.endsWith('.md') && directChild(rel)],
  ['.github', () => true],
  ['src', () => true],
  ['scripts', () => true],
  ['test', () => true],
  ['locale', (rel) => rel.endsWith('.json') && directChild(rel)],
]
for (const [dir, accept] of HYGIENE_SWEEP) {
  for (const rel of await walk(dir, accept)) hygieneFiles.add(rel)
}

const hygieneFailures = []
for (const rel of [...hygieneFiles].sort()) {
  if (SKIPPED_PREFIXES.some((prefix) => rel.startsWith(prefix)) || !exists(rel)) continue
  const info = await stat(abs(rel)).catch(() => null)
  if (!info?.isFile() || info.size > MAX_TEXT_BYTES) continue
  const bytes = await readFile(abs(rel)).catch(() => null)
  if (bytes === null) continue
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    continue // binary payload (screenshots, tarballs) - nothing to lint
  }

  // `.gitattributes` stores every text file as LF, so a CRLF working tree from
  // `core.autocrlf=true` is a checkout detail; only a genuine CR is a defect.
  const normalized = text.replace(/\r\n/g, '\n')
  const strayCarriageReturn = normalized.indexOf('\r')
  if (strayCarriageReturn === -1) pass()
  else {
    const line = normalized.slice(0, strayCarriageReturn).split('\n').length
    hygieneFailures.push(`${rel}: stray carriage return at line ${line}; this repository stores LF line endings`)
  }

  const lines = normalized.split('\n')

  // Trailing whitespace (markdown hard line breaks keep theirs)
  const trailing = lines.flatMap((line, index) =>
    /[ \t]+$/.test(line) && !(rel.endsWith('.md') && /  $/.test(line)) ? [index + 1] : [],
  )
  if (trailing.length > 0) hygieneFailures.push(`${rel}: trailing whitespace on line(s) ${listLines(trailing)}`)
  else pass()

  // Indentation must not use tabs in machine-read files
  if (TABBED_EXTENSIONS.test(rel)) {
    const tabbed = lines.flatMap((line, index) => (line.includes('\t') ? [index + 1] : []))
    if (tabbed.length > 0) hygieneFailures.push(`${rel}: tab character on line(s) ${listLines(tabbed)}`)
    else pass()
  }

  // Exactly one trailing newline
  if (!normalized.endsWith('\n')) hygieneFailures.push(`${rel}: missing final newline`)
  else if (normalized.endsWith('\n\n')) hygieneFailures.push(`${rel}: more than one trailing newline at end of file`)
  else pass()
}
for (const failure of hygieneFailures) fail(failure)

// 5. Secret hygiene. vendor/ stays out of scope: the vendored ssh2 bundle embeds a
// test key literal that would otherwise be reported on every run.
const SECRET_PATTERNS = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
]
// A bare PEM header is a fixture in the redaction/key-parsing tests; a real leaked key
// carries a base64 body. Requiring a plausible body lets docs/ and test/ be scanned.
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----[\s\S]{0,200}?[A-Za-z0-9+/]{40,}/

const secretFiles = new Set(['client.js', 'index.js'])
for (const dir of ['src', 'scripts', '.github', 'docs', 'test', 'e2e']) {
  for (const rel of await walk(dir, () => true)) secretFiles.add(rel)
}

for (const rel of [...secretFiles].sort()) {
  const text = await readText(rel)
  if (text === null) continue
  const lines = text.split('\n')
  for (const [label, pattern] of SECRET_PATTERNS) {
    let hit = false
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return
      // Never echo the matched material itself into CI logs.
      fail(`${rel}:${index + 1}: possible ${label}; remove the credential and rotate it`)
      hit = true
    })
    if (!hit) pass()
  }
  const key = PRIVATE_KEY_BLOCK.exec(text)
  if (key === null) pass()
  else {
    const line = text.slice(0, key.index).split('\n').length
    fail(`${rel}:${line}: possible private key block; remove the credential and rotate it`)
  }
}

// 6. Workflow hygiene
const WORKFLOW_KEYS = ['name', 'permissions', 'concurrency']
const workflowDir = await readdir(abs('.github/workflows')).catch(() => null)
if (workflowDir === null) fail('.github/workflows: directory missing')
const workflowNames = (workflowDir ?? []).filter((name) => /\.ya?ml$/.test(name)).sort()
if (workflowNames.length === 0) fail('.github/workflows: no workflow file found')

for (const name of workflowNames) {
  const rel = `.github/workflows/${name}`
  const text = await readText(rel)
  if (text === null) {
    fail(`${rel}: missing or unreadable (a required workflow file is expected here)`)
    continue
  }
  pass()
  for (const key of WORKFLOW_KEYS)
    check(new RegExp(`^${key}:`, 'm').test(text), `${rel}: missing top-level "${key}:" block`)
  check(/^(?:on|"on"|'on'):/m.test(text), `${rel}: missing top-level "on:" trigger block`)

  for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
    const ref = match[1]
    const at = ref.lastIndexOf('@')
    if (at <= 0) continue // local action or reusable workflow path
    const pinned = ref.slice(at + 1)
    if (pinned === 'main' || pinned === 'master') {
      fail(`${rel}: ${ref} is pinned to a moving branch; use a release tag or a commit SHA`)
    } else if (/^v\d+(?:\.\d+)*$/.test(pinned) || /^[0-9a-f]{40}$/.test(pinned)) {
      pass()
    } else {
      warnings.push(`${rel}: ${ref} is not a vN tag or a 40-character commit SHA`)
    }
  }
}

// 7. No build artifact in the index. The `.js` twins of the TypeScript sources and the composed
// browser half (`client.js`, built from `client/src/main.ts` + `client/template.js` since P3a) are
// generated output (`.gitignore`, decision I in .agents/refactor/DECISIONS.md): `pnpm build`
// recreates them for every consumer, so a tracked one is a stale copy or a `git add -f` accident -
// and an accidental commit would resurrect the two-mode layout the decision retired.
const isArtifact = (rel) => rel === 'index.js' || rel === 'client.js' || (rel.startsWith('src/') && rel.endsWith('.js'))

function gitTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    // windowsHide keeps a console from flashing for every child the gates start.
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) return null
  return result.stdout.split('\0').filter(Boolean)
}

const tracked = gitTrackedFiles()
if (tracked === null) {
  // A missing git is an environment limitation, not a repository defect: warn instead of failing.
  warnings.push('git is not available; skipped the "build artifacts are not tracked" check')
} else {
  const artifacts = tracked.filter(isArtifact).sort()
  if (artifacts.length === 0) pass()
  for (const artifact of artifacts) {
    fail(
      `${artifact}: tracked build artifact (产物不得进版本库, P1e 决策); it is generated output - unstage it with "git rm --cached ${artifact}" (pnpm build recreates it)`,
    )
  }
}

// 8. Report
for (const message of warnings) console.warn(`[check-repo] WARN: ${message}`)
if (problems.length > 0) {
  for (const message of problems) console.error(`[check-repo] FAIL: ${message}`)
  console.error(`[check-repo] ${problems.length} problem(s) found; ${checks} check(s) passed`)
  process.exit(1)
}
console.log(`[check-repo] OK: ${checks} checks`)

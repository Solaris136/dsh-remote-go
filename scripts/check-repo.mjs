// Repository conventions the release process depends on: required files, package metadata,
// version parity, line hygiene, secret hygiene and workflow hygiene.
//
// Dependency-free (node: built-ins only). Every problem is reported as a `[check-repo] FAIL`
// line and the process exits 1 when at least one is found.
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** @type {string[]} */
const problems = []
/** @type {string[]} */
const warnings = []
let checks = 0

function pass() {
  checks += 1
}

/** @param {string} message */
function fail(message) {
  problems.push(message)
}

/**
 * One check: a passing condition counts, a failing one records its message.
 * @param {boolean} ok @param {string} message
 */
function check(ok, message) {
  if (ok) pass()
  else fail(message)
}

const abs = (rel) => path.join(root, rel)
const exists = (rel) => existsSync(abs(rel))
const readText = (rel) => readFile(abs(rel), 'utf8').catch(() => null)

/** @param {string} rel */
async function readJson(rel) {
  try {
    return JSON.parse(await readFile(abs(rel), 'utf8'))
  } catch {
    return null
  }
}

/** @param {number[]} numbers */
function listLines(numbers) {
  const head = numbers.slice(0, 6).join(', ')
  return numbers.length > 6 ? `${head}, +${numbers.length - 6} more` : head
}

// 1. Required files
const REQUIRED_FILES = `README.md LICENSE CHANGELOG.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
.editorconfig .gitattributes .git-blame-ignore-revs .prettierignore .prettierrc.json .nvmrc
.github/CODEOWNERS .github/PULL_REQUEST_TEMPLATE.md .github/dependabot.yml
.github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml
.github/workflows/ci.yml .github/workflows/codeql.yml .github/workflows/release.yml
docs/design.md docs/implementation.md docs/api.md docs/publish.md
market/index.json market/plugin-entry.json`.split(/\s+/)

for (const file of REQUIRED_FILES) check(exists(file), `missing required file: ${file}`)

// 2. package.json metadata
const pkg = await readJson('package.json')
if (pkg === null) {
  fail('package.json: missing or not valid JSON')
} else {
  pass()
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  /** @type {Array<[string, unknown]>} */
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
  for (const needed of ['index.js', 'client.js', 'src', 'locale', 'cordis.patch.yml']) {
    const covered = shipped.some(
      (entry) => entry === needed || (typeof entry === 'string' && entry.startsWith(`${needed}/`)),
    )
    check(covered, `package.json: "files" must ship ${needed}`)
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

  // 3. Version parity with the market entry and the changelog
  if (version !== '') {
    const pluginEntry = await readJson('market/plugin-entry.json')
    if (pluginEntry === null) fail('market/plugin-entry.json: missing or not valid JSON')
    else {
      const published = pluginEntry.versions?.[0]?.version
      check(
        published === version,
        `market/plugin-entry.json: versions[0].version is ${JSON.stringify(published)}, expected ${version}`,
      )
    }

    const index = await readJson('market/index.json')
    if (index === null) fail('market/index.json: missing or not valid JSON')
    else {
      const published = index.plugins?.[0]?.versions?.[0]?.version
      check(
        published === version,
        `market/index.json: plugins[0].versions[0].version is ${JSON.stringify(published)}, expected ${version}`,
      )
    }

    const changelog = await readText('CHANGELOG.md')
    if (changelog === null) warnings.push('CHANGELOG.md: missing; skipped the version heading check')
    else {
      const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      check(
        new RegExp(`^##\\s*\\[${escaped}\\]`, 'm').test(changelog),
        `CHANGELOG.md: no "## [${version}]" heading for the released version`,
      )
    }
  }
}

// 4. Line hygiene
const MAX_TEXT_BYTES = 1024 * 1024
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'vendor', '.pnpm-store'])
const SKIPPED_PREFIXES = ['e2e/artifacts/', 'e2e/remote/evidence/', 'node_modules/', 'vendor/']
const ROOT_DOTFILES =
  '.editorconfig .gitattributes .gitignore .nvmrc .node-version package.json index.js client.js'.split(' ')
const TABBED_EXTENSIONS = /\.(?:js|mjs|cjs|json|ya?ml)$/

/**
 * Repository-relative paths under `dir` that `accept` allows.
 * @param {string} dir @param {(rel: string) => boolean} accept
 * @returns {Promise<string[]>}
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

/** @type {Set<string>} */
const hygieneFiles = new Set()
const rootEntries = await readdir(root, { withFileTypes: true }).catch(() => [])
for (const entry of rootEntries) {
  if (!entry.isFile()) continue
  if (entry.name.endsWith('.md') || ROOT_DOTFILES.includes(entry.name)) hygieneFiles.add(entry.name)
}
const directChild = (rel) => rel.split('/').length === 2
/** @type {Array<[string, (rel: string) => boolean]>} */
const HYGIENE_SWEEP = [
  ['docs', (rel) => rel.endsWith('.md') && directChild(rel)],
  ['.github', () => true],
  ['src', () => true],
  ['scripts', () => true],
  ['test', () => true],
  ['locale', (rel) => rel.endsWith('.json') && directChild(rel)],
  ['market', (rel) => rel.endsWith('.json') && directChild(rel)],
]
for (const [dir, accept] of HYGIENE_SWEEP) {
  for (const rel of await walk(dir, accept)) hygieneFiles.add(rel)
}

/** @type {string[]} */
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

// 5. Secret hygiene
const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
]

/** @type {Set<string>} */
const secretFiles = new Set(['client.js', 'index.js'])
for (const dir of ['src', 'scripts', '.github']) {
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
}

// Recorded E2E evidence must stay redacted. The captured text dumps and their JSON summaries
// are both checked, so a leak cannot survive a format change.
const evidenceDir = 'e2e/remote/evidence'
const evidenceList = await readdir(abs(evidenceDir)).catch(() => null)
if (evidenceList === null) warnings.push('e2e/remote/evidence: directory missing; skipped the token redaction check')
const TOKEN_VALUE = /\?token=([^\s&<>"'`\\]+)/g
for (const name of (evidenceList ?? []).filter((name) => name.endsWith('.txt') || name.endsWith('.json')).sort()) {
  const text = await readText(`${evidenceDir}/${name}`)
  if (text === null) continue
  let unredacted = 0
  for (const match of text.matchAll(TOKEN_VALUE)) {
    const value = match[1]
    if (value.length < 20) continue
    if (value.includes('...') || /^<redacted>/i.test(value) || /^redacted/i.test(value)) continue
    unredacted += 1
  }
  const rel = `${evidenceDir}/${name}`
  check(unredacted === 0, `${rel}: ${unredacted} unredacted ?token= value(s); replace them with <redacted>`)
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

// 7. Report
for (const message of warnings) console.warn(`[check-repo] WARN: ${message}`)
if (problems.length > 0) {
  for (const message of problems) console.error(`[check-repo] FAIL: ${message}`)
  console.error(`[check-repo] ${problems.length} problem(s) found; ${checks} check(s) passed`)
  process.exit(1)
}
console.log(`[check-repo] OK: ${checks} checks`)

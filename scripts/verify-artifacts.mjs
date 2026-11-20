// One-way artifact gate: every `.ts` source has a fresh `.js` at `dist/<source>.js`, `dist/` holds no `.js` that no
// `.ts` produces (an orphan from a deleted `.ts` is the other rejected state), and the browser half is still what its
// sources produce. "Fresh" = a build of this tree rewrote nothing; the root is skipped, `exports` is `dist/`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL#pathname: it percent-encodes the space in "C:\Work\my repo" and resolved the wrong root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
// The single build output directory (tsconfig `outDir`).
const DIST = 'dist'
// The composed browser half: built by `scripts/build-client.mjs`, outside the tsconfig program, so checked separately.
const CLIENT_ARTIFACT = `${DIST}/client.js`

function fail(message) {
  console.error(`[verify-artifacts] ${message}`)
  process.exit(1)
}

/** Repository-relative paths under `dir` whose file name ends with `suffix`. */
async function walk(dir, suffix, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await walk(rel, suffix, out)
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(rel)
  }
  return out
}
/** Expand one `tsconfig.json` include entry into repository-relative source paths. */
async function expandInclude(pattern) {
  const text = pattern.replace(/\\/g, '/')
  // The shapes used: `<dir>/**/*.ts`, `<dir>/**/*.d.ts`, an exact file; `.d.ts` goes first since it also ends in `.ts`.
  for (const recursive of ['/**/*.d.ts', '/**/*.ts']) {
    if (text.endsWith(recursive)) return walk(text.slice(0, -recursive.length), '.ts')
  }
  if (!text.includes('*') && !text.includes('?')) {
    const exact = text.replace(/^\.\//, '')
    return existsSync(path.join(root, exact)) ? [exact] : []
  }
  // A new include shape must be taught to this gate instead of silently going unverified.
  throw new Error(`tsconfig.json: include pattern ${JSON.stringify(pattern)} is not supported by this gate`)
}
async function expectedSources() {
  const tsconfig = JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8'))
  const patterns = Array.isArray(tsconfig.include) ? tsconfig.include : []
  if (patterns.length === 0) throw new Error('tsconfig.json: "include" must list the TypeScript sources')
  const sources = new Set()
  // A declaration file is type-only (no artifact), so it is skipped and counted — `types/**/*.d.ts` is for typing only.
  let declarations = 0
  for (const pattern of patterns) {
    for (const source of await expandInclude(pattern)) {
      if (source.endsWith('.d.ts')) declarations += 1
      // A `.mts`/`.tsx` source would map to a different path than this gate asserts, so it must be handled explicitly.
      else if (!source.endsWith('.ts')) throw new Error(`${source}: only ".ts" sources are supported by this gate`)
      else sources.add(source)
    }
  }
  return { sources: [...sources].sort(), declarations }
}
/** The emitted twin of a source: `src/x.ts` -> `dist/src/x.js`, `index.ts` -> `dist/index.js`. */
const artifactOf = (source) => `${DIST}/${source.replace(/\.ts$/, '.js')}`
async function hashFile(file) {
  const bytes = await readFile(path.join(root, file)).catch(() => null)
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
}
const { sources, declarations } = await expectedSources().catch((error) => fail(error.message))
if (sources.length === 0) fail('no TypeScript sources matched tsconfig.json "include"; nothing would be verified')
const artifacts = sources.map(artifactOf)
// Orphans are collected before the build: `pnpm build` deletes `dist/` wholesale, so the orphan and the chance to
// report it are both gone. `dist/client.js` is excluded: its source is the module list + `client/template.js`.
const orphans = []
for (const artifact of await walk(DIST, '.js')) {
  if (artifact === CLIENT_ARTIFACT) continue
  const source = artifact.slice(DIST.length + 1).replace(/\.js$/, '.ts')
  if (!existsSync(path.join(root, source))) orphans.push({ artifact, source })
}
// Snapshot first: anything the build creates or rewrites is missing or stale. The client half is snapshotted here too.
const before = new Map()
for (const artifact of artifacts) before.set(artifact, await hashFile(artifact))
const clientBefore = await hashFile(CLIENT_ARTIFACT)
const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
if (build.status !== 0) {
  const message = `the build failed (${build.status ?? build.error?.message ?? 'no exit code'}); artifacts cannot be trusted until it passes`
  fail(message)
}
// Same one-way rule for the browser half: hash it, run its build, and require that the build had nothing to rewrite.
const clientBuild = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
if (clientBuild.status !== 0) {
  const clientBuildProblem = `the client build failed (${clientBuild.status ?? clientBuild.error?.message ?? 'no exit code'}); ${CLIENT_ARTIFACT} cannot be trusted until it passes`
  fail(clientBuildProblem)
}
const problems = []
const clientAfter = await hashFile(CLIENT_ARTIFACT)
if (clientAfter === null) problems.push(`${CLIENT_ARTIFACT}: missing; scripts/build-client.mjs did not produce it`)
else if (clientBefore === null) {
  problems.push(`${CLIENT_ARTIFACT}: missing before the build; scripts/build-client.mjs created it, so run pnpm build`)
} else if (clientBefore !== clientAfter)
  problems.push(`${CLIENT_ARTIFACT}: stale; scripts/build-client.mjs rewrote it, so run pnpm build`)
for (const { artifact, source } of orphans) {
  const orphanProblem = `${artifact}: orphan; no ${source} twin exists, so this .js is not build output (pnpm build removed it)`
  problems.push(orphanProblem)
}
for (const [index, artifact] of artifacts.entries()) {
  const source = sources[index]
  const after = await hashFile(artifact)
  if (after === null) problems.push(`${artifact}: missing; pnpm build did not produce it from ${source}`)
  else if (before.get(artifact) === null) {
    problems.push(`${artifact}: missing before the build; pnpm build created it from ${source}, so run pnpm build`)
  } else if (before.get(artifact) !== after)
    problems.push(`${artifact}: stale; pnpm build rewrote it from ${source}, so run pnpm build`)
}
// `exports` loads by path, so both halves are asserted: the source stays compiled and the emitted file exists.
if (existsSync(path.join(root, 'index.ts')) && !sources.includes('index.ts'))
  problems.push('index.ts: not covered by tsconfig.json "include"; the package entry point would never be built')
if (!existsSync(path.join(root, `${DIST}/index.js`)))
  problems.push(`${DIST}/index.js: missing; the package "exports" entry point was not produced (source: index.ts)`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`[verify-artifacts] FAIL: ${problem}`)
  const summary = `${problems.length} problem(s) found; every .ts source must own the .js that pnpm build emits under ${DIST}/, and nothing else`
  fail(summary)
}
console.log(
  `[verify-artifacts] OK: ${artifacts.length} artifact(s) freshly produced under ${DIST}/ from ${sources.length} source(s)` +
    (declarations > 0 ? ` (${declarations} declaration file(s) skipped)` : '') +
    `; ${CLIENT_ARTIFACT} freshly composed from the client/src modules + client/template.js; no orphan artifacts`,
)

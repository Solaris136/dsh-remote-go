// One-way artifact gate: every TypeScript source must have a fresh `.js` under `dist/`, `dist/`
// must not contain a `.js` that no `.ts` produces, and the composed browser half
// (`dist/client.js`, P3a) must still be what its sources produce.
//
// Since P1e the artifacts are not committed (decision I in .agents/refactor/DECISIONS.md), and
// since the dist move they do not live next to their sources either: `tsconfig.json` emits the
// whole program into `dist/` (`rootDir: "."` keeps `src/**` and `index.ts` in place under it).
// "Fresh" therefore means "a build of the current tree found nothing to rewrite", "complete"
// means "the build emitted one artifact per source at `dist/<source>.js`", and the only other
// state to reject is an orphan artifact left behind by a deleted `.ts`.
//
// The package root is deliberately NOT checked: `exports` points into `dist/`, so the root may
// legitimately hold no generated file at all. The gate is one-way: no committedness checks, no
// "commit the artifacts" path and no switch that could restore the two-mode layout.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL#pathname: pathname percent-encodes characters such as the
// space in "C:\Work\my repo", which made every gate resolve the wrong repository root.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

// The single build output directory (tsconfig `outDir`).
const DIST = 'dist'
// The composed browser half, built by `scripts/build-client.mjs` from `client/src/` +
// `client/template.js`. It is not part of the tsconfig program, so it is checked separately.
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
  // The shapes this tsconfig uses: `<dir>/**/*.ts`, `<dir>/**/*.d.ts` and an exact file.
  // The declaration suffix is tested first: it also ends in `.ts`, and the directory before
  // it has to be walked the same way (`types/**/*.d.ts`).
  const declarationRecursive = '/**/*.d.ts'
  if (text.endsWith(declarationRecursive)) return walk(text.slice(0, -declarationRecursive.length), '.ts')
  const recursive = '/**/*.ts'
  if (text.endsWith(recursive)) return walk(text.slice(0, -recursive.length), '.ts')
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
  // A declaration file is type-only: it produces no artifact, so it is skipped and counted
  // rather than compared (the `types/**/*.d.ts` include exists for typing, not emission).
  let declarations = 0
  for (const pattern of patterns) {
    for (const source of await expandInclude(pattern)) {
      if (source.endsWith('.d.ts')) {
        declarations += 1
        continue
      }
      // A `.mts`/`.tsx` source would map to a different path than the one this gate asserts,
      // so it must be handled explicitly.
      if (!source.endsWith('.ts')) throw new Error(`${source}: only ".ts" sources are supported by this gate`)
      sources.add(source)
    }
  }
  return { sources: [...sources].sort(), declarations }
}

/** The emitted twin of a source: `src/x.ts` -> `dist/src/x.js`, `index.ts` -> `dist/index.js`. */
const artifactOf = (source) => `${DIST}/${source.replace(/\.ts$/, '.js')}`

async function hashFile(file) {
  try {
    return createHash('sha256')
      .update(await readFile(path.join(root, file)))
      .digest('hex')
  } catch {
    return null
  }
}

const { sources, declarations } = await expectedSources().catch((error) => fail(error.message))
if (sources.length === 0) fail('no TypeScript sources matched tsconfig.json "include"; nothing would be verified')
const artifacts = sources.map(artifactOf)

// Orphans have to be collected before the build: `pnpm build` starts by deleting `dist/`
// wholesale, so afterwards an orphan is gone and the chance to report it would be gone with it.
// An orphan is a `.js` under `dist/` without a `.ts` twin - a stale twin that survived a
// rename/delete, or output of a source that no longer exists. `dist/client.js` is excluded: its
// source is the client module list plus `client/template.js`, not a single `.ts` file.
const orphans = []
for (const artifact of await walk(DIST, '.js')) {
  if (artifact === CLIENT_ARTIFACT) continue
  const source = artifact.slice(DIST.length + 1).replace(/\.js$/, '.ts')
  if (!existsSync(path.join(root, source))) orphans.push({ artifact, source })
}

// Snapshot first: anything the build has to create or rewrite is a missing or stale artifact.
// The client half is snapshotted here as well, before `scripts/build.mjs` deletes `dist/`.
const before = new Map()
for (const artifact of artifacts) before.set(artifact, await hashFile(artifact))
const clientBefore = await hashFile(CLIENT_ARTIFACT)

const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
if (build.status !== 0)
  fail(
    `the build failed (${build.status ?? build.error?.message ?? 'no exit code'}); artifacts cannot be trusted until it passes`,
  )

const problems = []

// Same one-way rule for the browser half: hash it, let its build run, and require that the build
// had nothing to rewrite.
const clientBuild = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
if (clientBuild.status !== 0)
  fail(
    `the client build failed (${clientBuild.status ?? clientBuild.error?.message ?? 'no exit code'}); ${CLIENT_ARTIFACT} cannot be trusted until it passes`,
  )
const clientAfter = await hashFile(CLIENT_ARTIFACT)
if (clientAfter === null) problems.push(`${CLIENT_ARTIFACT}: missing; scripts/build-client.mjs did not produce it`)
else if (clientBefore === null)
  problems.push(`${CLIENT_ARTIFACT}: missing before the build; scripts/build-client.mjs created it, so run pnpm build`)
else if (clientBefore !== clientAfter)
  problems.push(`${CLIENT_ARTIFACT}: stale; scripts/build-client.mjs rewrote it, so run pnpm build`)

for (const { artifact, source } of orphans)
  problems.push(
    `${artifact}: orphan; no ${source} twin exists, so this .js is not build output (pnpm build removed it)`,
  )
for (const [index, artifact] of artifacts.entries()) {
  const source = sources[index]
  const after = await hashFile(artifact)
  if (after === null) problems.push(`${artifact}: missing; pnpm build did not produce it from ${source}`)
  else if (before.get(artifact) === null)
    problems.push(`${artifact}: missing before the build; pnpm build created it from ${source}, so run pnpm build`)
  else if (before.get(artifact) !== after)
    problems.push(`${artifact}: stale; pnpm build rewrote it from ${source}, so run pnpm build`)
}
// The package `exports` entry point is loaded by path, so both halves are asserted explicitly
// instead of relying on the tsconfig include that happens to cover them: the source must stay
// compiled, and the emitted file must exist for the `prepack` stage to copy `index.js`.
if (existsSync(path.join(root, 'index.ts')) && !sources.includes('index.ts'))
  problems.push('index.ts: not covered by tsconfig.json "include"; the package entry point would never be built')
if (!existsSync(path.join(root, `${DIST}/index.js`)))
  problems.push(`${DIST}/index.js: missing; the package "exports" entry point was not produced (source: index.ts)`)

if (problems.length > 0) {
  for (const problem of problems) console.error(`[verify-artifacts] FAIL: ${problem}`)
  fail(
    `${problems.length} problem(s) found; every .ts source must own the .js that pnpm build emits under ${DIST}/, and nothing else`,
  )
}
console.log(
  `[verify-artifacts] OK: ${artifacts.length} artifact(s) freshly produced under ${DIST}/ from ${sources.length} source(s)` +
    (declarations > 0 ? ` (${declarations} declaration file(s) skipped)` : '') +
    `; ${CLIENT_ARTIFACT} freshly composed from the client/src modules + client/template.js; no orphan artifacts`,
)

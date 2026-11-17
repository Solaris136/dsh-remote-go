// Artifact drift gate: the `.js` files committed next to the `.ts` sources must be exactly
// what `pnpm build` emits, and every source must have its artifact at all.
//
// The comparison is against the build output, not against `HEAD`: this refactor lands in the
// working tree first and is committed per phase (D7), so "differs from HEAD" is a normal
// mid-phase state while "differs from what tsc emits" never is. The gate therefore snapshots
// every artifact, rebuilds, and reports anything the build had to change.
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

function fail(message) {
  console.error(`[verify-artifacts] ${message}`)
  process.exit(1)
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : null
}

async function walkSources(dir, out) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await walkSources(rel, out)
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

/** Expand one `tsconfig.json` include entry into repository-relative source paths. */
async function expandInclude(pattern) {
  const text = pattern.replace(/\\/g, '/')
  // The shapes this tsconfig uses: `<dir>/**/*.ts` and an exact file.
  const recursive = '/**/*.ts'
  if (text.endsWith(recursive)) return walkSources(text.slice(0, -recursive.length), [])
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
  for (const pattern of patterns) {
    for (const source of await expandInclude(pattern)) {
      // A declaration file has no emitted artifact, and a `.mts`/`.tsx` source would map to a
      // different path than the one this gate asserts; both must be handled explicitly.
      if (source.endsWith('.d.ts'))
        throw new Error(`${source}: declaration-only sources are not supported by this gate`)
      if (!source.endsWith('.ts')) throw new Error(`${source}: only ".ts" sources are supported by this gate`)
      sources.add(source)
    }
  }
  return [...sources].sort()
}

async function hashArtifact(file) {
  try {
    return createHash('sha256')
      .update(await readFile(path.join(root, file)))
      .digest('hex')
  } catch {
    return null
  }
}

const sources = await expectedSources().catch((error) => fail(error.message))
if (sources.length === 0) fail('no TypeScript sources matched tsconfig.json "include"; nothing would be verified')
const artifacts = sources.map((source) => source.replace(/\.ts$/, '.js'))

// Snapshot first: anything the build has to rewrite is a stale (or missing) committed artifact.
const before = new Map()
for (const artifact of artifacts) before.set(artifact, await hashArtifact(artifact))

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
for (const [index, artifact] of artifacts.entries()) {
  const source = sources[index]
  const after = await hashArtifact(artifact)
  if (after === null) problems.push(`${artifact}: pnpm build did not produce it (source: ${source})`)
  else if (before.get(artifact) === null)
    problems.push(`${artifact}: missing from the working tree (source: ${source})`)
  else if (before.get(artifact) !== after)
    problems.push(`${artifact}: the committed artifact was stale; pnpm build rewrote it (source: ${source})`)
}

// Committedness. An artifact that is already committed must stay committed: a `.ts` source
// in HEAD whose `.js` is untracked means a plain clone cannot import the module at all. The
// one state this cannot judge is a source that is not committed yet either — that is a phase
// landing in the working tree (D7), so it is reported without failing until the phase is in.
const headPaths = gitOutput(['ls-tree', '-r', '--name-only', 'HEAD'])
const trackedPaths = gitOutput(['ls-files', '--cached'])
const pending = []
if (headPaths === null || trackedPaths === null) {
  console.warn('[verify-artifacts] WARN: git is unavailable here; the committedness checks were skipped')
} else {
  const head = new Set(headPaths)
  const tracked = new Set(trackedPaths)
  for (const [index, artifact] of artifacts.entries()) {
    if (tracked.has(artifact)) continue
    const source = sources[index]
    if (head.has(source)) problems.push(`${artifact}: not tracked by git although ${source} is committed`)
    else pending.push(artifact)
  }
}
if (pending.length > 0) {
  console.warn(
    `[verify-artifacts] note: ${pending.length} artifact(s) are not committed yet because their source is not committed yet either; commit them together with the phase`,
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[verify-artifacts] FAIL: ${problem}`)
  fail(`${problems.length} problem(s) found; run pnpm build and commit the emitted artifacts with their source`)
}
console.log(`[verify-artifacts] OK: ${artifacts.length} artifact(s) match the build output`)

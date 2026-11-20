/** Detect the DSH version of the local installation; the remote runtime is pinned to this exact version, never to npm `latest`. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createKernelAdapter } from './kernel-adapter.js'
import { isPlainObject } from './util.js'
import { normalizeVersion, parseVersion } from './version.js'

/** Everything the version probes may read; all of it is injectable for tests. */
export interface LocalVersionInput {
  env?: NodeJS.ProcessEnv
  /** The plugin context: only the loader's release identity is read, through `kernel-adapter.ts`. */
  ctx?: unknown
  /** Warn sink for a moved kernel shape — a silent fallback would pin the wrong npx version. */
  logger?: { warn?: (...args: unknown[]) => void }
  argv1?: string
  resourcesPath?: string
  cwd?: string
}

export interface LocalVersionResult {
  version: string | null
  source: string
}

export interface LocalEnginesResult {
  range: string | null
  source: string
}

/** The parsed `package.json` at `candidate`, or null when it is absent or not a JSON object. */
async function readPackageJson(candidate: string): Promise<Record<string, unknown> | null> {
  try {
    if (!existsSync(candidate)) return null
    // A package.json on disk is untrusted input: narrow it before reading fields.
    const parsed: unknown = JSON.parse(await readFile(candidate, 'utf8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    // swallow-ok: a candidate that is absent or unparsable is skipped by design
    return null
  }
}

export async function detectLocalVersion(input: LocalVersionInput = {}): Promise<LocalVersionResult> {
  const env = input.env ?? process.env
  const explicit = env.DSH_VERSION || env.DSH_RUNTIME_VERSION
  if (explicit && parseVersion(normalizeVersion(explicit)))
    return { version: normalizeVersion(explicit), source: 'env' }
  // The web client-module registry publishes the Host release identity, which releases share with
  // the CLI package version.
  const release = createKernelAdapter(input.ctx).clientModuleRelease()
  if (release.state === 'ok' && release.value !== null) {
    const version = release.value.version
    if (version !== null && parseVersion(normalizeVersion(version))) {
      return { version: normalizeVersion(version), source: 'client-modules' }
    }
  } else if (release.state === 'changed') {
    // A moved release identity is a kernel this probe does not recognize: keep the package.json
    // fallback, but say so — a silently wrong pin breaks every connect that follows.
    input.logger?.warn?.(
      '[dsh-remote-go] the client-module release identity changed shape; falling back to package.json:',
      release.detail,
    )
  }
  for (const candidate of candidatePackageJsons(input)) {
    const manifest = await readPackageJson(candidate)
    if (manifest?.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') continue
    if (!parseVersion(normalizeVersion(manifest.version))) continue
    return { version: normalizeVersion(manifest.version), source: `package.json:${candidate}` }
  }
  return { version: null, source: 'unknown' }
}

/** The local DSH build's Node engine range (`engines.node`), the source of truth for the managed Node on the remote: it
 * must satisfy this declaration. Best-effort: a missing package yields `range: null` and the plugin's own floor. */
export async function detectLocalEnginesNode(input: LocalVersionInput = {}): Promise<LocalEnginesResult> {
  for (const candidate of candidatePackageJsons(input)) {
    const manifest = await readPackageJson(candidate)
    const engines = manifest !== null && isPlainObject(manifest.engines) ? manifest.engines : null
    const range = engines?.node
    if (typeof range === 'string' && range.trim() !== '')
      return { range: range.trim(), source: `package.json:${candidate}` }
  }
  return { range: null, source: 'unknown' }
}

export function candidatePackageJsons(input: LocalVersionInput = {}): string[] {
  const out: string[] = []
  const argv1 = input.argv1 ?? process.argv[1] ?? ''
  const marker = `${path.sep}@deepseek-ai${path.sep}dsh${path.sep}`
  const markerIndex = argv1.indexOf(marker)
  if (markerIndex >= 0) out.push(path.join(argv1.slice(0, markerIndex + marker.length), 'package.json'))
  // Electron's `resourcesPath` is not on the standard Process type; it is read duck-typed.
  const resourcesPath = input.resourcesPath ?? (process as { resourcesPath?: unknown }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    for (const dir of ['app.asar', 'app.asar.unpacked', 'app']) {
      out.push(path.join(resourcesPath, dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  // Walk up from the CLI entry looking for a nested package.
  let dir = argv1 ? path.dirname(argv1) : (input.cwd ?? process.cwd())
  for (let i = 0; i < 8; i += 1) {
    out.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...new Set(out)]
}

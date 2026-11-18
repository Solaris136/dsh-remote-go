/**
 * Detect the DSH version of the local installation; the remote runtime is pinned to this exact version, never to npm `latest`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isPlainObject } from './util.js'
import { normalizeVersion, parseVersion } from './version.js'

/** The kernel's client-module registry: the only surface this probe reads from it. */
export interface ClientModulesService {
  graph?: () => { release?: { version?: unknown } | null } | null
}

/** Everything the version probes may read; all of it is injectable for tests. */
export interface LocalVersionInput {
  env?: NodeJS.ProcessEnv
  ctx?: { get?: (name: 'clientModules') => ClientModulesService | null | undefined }
  argv1?: string
  resourcesPath?: string
  cwd?: string
}

/** The detected version (or none) and which source proved it. */
export interface LocalVersionResult {
  version: string | null
  source: string
}

/** The detected `engines.node` range (or none) and which source proved it. */
export interface LocalEnginesResult {
  range: string | null
  source: string
}

export async function detectLocalVersion(input: LocalVersionInput = {}): Promise<LocalVersionResult> {
  const env = input.env ?? process.env
  const explicit = env.DSH_VERSION || env.DSH_RUNTIME_VERSION
  if (explicit && parseVersion(normalizeVersion(explicit))) {
    return { version: normalizeVersion(explicit), source: 'env' }
  }

  // The web client-module registry publishes the Host release identity, which
  // releases share with the CLI package version.
  try {
    const clientModules = input.ctx?.get?.('clientModules')
    const release = clientModules?.graph?.()?.release
    if (release?.version && parseVersion(normalizeVersion(release.version))) {
      return { version: normalizeVersion(release.version), source: 'client-modules' }
    }
  } catch {
    // swallow-ok: the clientModules service is absent in this composition
  }

  for (const candidate of candidatePackageJsons(input)) {
    try {
      if (!existsSync(candidate)) continue
      const text = await readFile(candidate, 'utf8')
      // A package.json on disk is untrusted input: narrow it before reading fields.
      const parsed: unknown = JSON.parse(text)
      if (
        isPlainObject(parsed) &&
        parsed.name === '@deepseek-ai/dsh' &&
        typeof parsed.version === 'string' &&
        parseVersion(normalizeVersion(parsed.version))
      ) {
        return { version: normalizeVersion(parsed.version), source: `package.json:${candidate}` }
      }
    } catch {
      // swallow-ok: a candidate that is absent or unparsable is skipped by design
    }
  }
  return { version: null, source: 'unknown' }
}

/**
 * The local DSH build's Node engine range (`engines.node`). It is the source of
 * truth for the managed Node version the plugin installs on the remote: the
 * remote runs this exact DSH version, so it must satisfy this declaration.
 *
 * Best-effort like the version probe: an unreadable or missing package yields
 * `range: null` and the caller falls back to the plugin's own floor.
 */
export async function detectLocalEnginesNode(input: LocalVersionInput = {}): Promise<LocalEnginesResult> {
  for (const candidate of candidatePackageJsons(input)) {
    try {
      if (!existsSync(candidate)) continue
      const parsed: unknown = JSON.parse(await readFile(candidate, 'utf8'))
      const engines = isPlainObject(parsed) && isPlainObject(parsed.engines) ? parsed.engines : null
      const range = engines?.node
      if (typeof range === 'string' && range.trim() !== '') {
        return { range: range.trim(), source: `package.json:${candidate}` }
      }
    } catch {
      // swallow-ok: the same candidate scan as the version probe above
    }
  }
  return { range: null, source: 'unknown' }
}

export function candidatePackageJsons(input: LocalVersionInput = {}): string[] {
  const out: string[] = []
  const argv1 = input.argv1 ?? process.argv[1] ?? ''
  const marker = `${path.sep}@deepseek-ai${path.sep}dsh${path.sep}`
  const markerIndex = argv1.indexOf(marker)
  if (markerIndex >= 0) {
    out.push(path.join(argv1.slice(0, markerIndex + marker.length), 'package.json'))
  }
  // Electron's `resourcesPath` is not on the standard Process type; it is read duck-typed.
  const resourcesPath = input.resourcesPath ?? (process as { resourcesPath?: unknown }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    out.push(path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    out.push(
      path.join(resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    )
    out.push(path.join(resourcesPath, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
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

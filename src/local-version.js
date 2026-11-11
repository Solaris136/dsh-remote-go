/**
 * Detect the DSH version of the *local* installation. The design pins the
 * remote runtime to this exact version (§16.3), so the value must come from the
 * running installation rather than npm `latest`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeVersion, parseVersion } from './version.js'

/**
 * @param {{ ctx?: any, env?: NodeJS.ProcessEnv, resourcesPath?: string, argv1?: string }} [input]
 * @returns {Promise<{ version: string | null, source: string }>}
 */
export async function detectLocalVersion(input = {}) {
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
    /* service not present in this composition */
  }

  for (const candidate of candidatePackageJsons(input)) {
    try {
      if (!existsSync(candidate)) continue
      const text = await readFile(candidate, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed?.name === '@deepseek-ai/dsh' && parsed?.version && parseVersion(normalizeVersion(parsed.version))) {
        return { version: normalizeVersion(parsed.version), source: `package.json:${candidate}` }
      }
    } catch {
      /* keep looking */
    }
  }
  return { version: null, source: 'unknown' }
}

/**
 * @param {{ resourcesPath?: string, argv1?: string, cwd?: string }} input
 * @returns {string[]}
 */
export function candidatePackageJsons(input = {}) {
  const out = []
  const argv1 = input.argv1 ?? process.argv[1] ?? ''
  const marker = `${path.sep}@deepseek-ai${path.sep}dsh${path.sep}`
  const markerIndex = argv1.indexOf(marker)
  if (markerIndex >= 0) {
    out.push(path.join(argv1.slice(0, markerIndex + marker.length), 'package.json'))
  }
  const resourcesPath = input.resourcesPath ?? /** @type {any} */ (process).resourcesPath
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

/**
 * Resolve the effective remote target version.
 * @param {{ configured: string, localVersion: string | null }} input
 * @returns {{ targetVersion: string | null, source: 'explicit' | 'local' | 'unknown' }}
 */
export function resolveTargetVersion(input) {
  const configured = String(input.configured ?? 'local').trim()
  if (configured !== '' && configured !== 'local' && configured !== 'auto') {
    const parsed = parseVersion(normalizeVersion(configured))
    return parsed
      ? { targetVersion: normalizeVersion(configured), source: 'explicit' }
      : { targetVersion: null, source: 'unknown' }
  }
  if (input.localVersion) return { targetVersion: input.localVersion, source: 'local' }
  return { targetVersion: null, source: 'unknown' }
}

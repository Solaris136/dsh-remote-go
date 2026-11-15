/**
 * Read the local side of a sync: the running profile's plugin manifest, its patch rows and the local credential document; missing or malformed files degrade to an empty snapshot with a note, never to a failed connection.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from '../vendor/yaml.bundle.mjs'
import { isPlainObject } from './util.js'

/** The profile directory of the running DSH (DSH sets `DSH_PROFILE_DIR`). */
export function localProfileDir(home, env = process.env) {
  const explicit = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : ''
  if (explicit !== '') return explicit
  const profile =
    typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '' ? env.DSH_PROFILE.trim() : 'desktop'
  return path.join(home, 'profiles', profile)
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Parse a cordis patch document into its top-level row array. */
export function parseRowsYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') return { rows: [], error: null }
  try {
    const value = load(text)
    if (value === null || value === undefined) return { rows: [], error: null }
    if (!Array.isArray(value)) return { rows: [], error: 'not-a-list' }
    return { rows: value, error: null }
  } catch {
    // swallow-ok: an unparsable patch is reported as a plan note; the document itself is never touched
    return { rows: [], error: 'unparsable' }
  }
}

/** Parse the credential document; the root may carry `refs` and `records`. */
export function parseCredentialsYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') return { refs: {}, records: {}, error: null }
  try {
    const value = load(text)
    if (value === null || value === undefined) return { refs: {}, records: {}, error: null }
    if (!isPlainObject(value)) return { refs: {}, records: {}, error: 'not-a-map' }
    return {
      refs: isPlainObject(value.refs) ? value.refs : {},
      records: isPlainObject(value.records) ? value.records : {},
      error: null,
    }
  } catch {
    // swallow-ok: an unparsable credential document is reported as a plan note; nothing is written
    return { refs: {}, records: {}, error: 'unparsable' }
  }
}

async function readJson(file) {
  const text = await readText(file)
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

async function readManifests(profileDir, names) {
  const out = {}
  for (const name of names) {
    const manifest = await readJson(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
    out[name] = manifest && manifest.name === name ? manifest : null
  }
  return out
}

/**
 * Snapshot everything a sync reads from this machine. `env` supplies fallbacks for
 * credential references that only exist in the launching environment.
 */
export async function readLocalSnapshot(options = {}) {
  const home = options.home
  const profileDir = options.profileDir ?? localProfileDir(home, options.env)
  const packageJson = await readJson(path.join(profileDir, 'package.json'))
  const patchText = await readText(path.join(profileDir, 'cordis.patch.yml'))
  const patch = parseRowsYaml(patchText)
  const credentialsText = await readText(path.join(home, '.credentials.yaml'))
  const credentials = parseCredentialsYaml(credentialsText)
  const dependencies = isPlainObject(packageJson?.dependencies) ? Object.keys(packageJson.dependencies) : []
  const manifests = await readManifests(profileDir, dependencies)
  return {
    home,
    profileDir,
    packageJson,
    rows: patch.rows,
    rowsError: patch.error,
    credentials: { refs: credentials.refs, records: credentials.records },
    credentialsError: credentials.error,
    manifests,
    env: options.env ?? process.env,
  }
}

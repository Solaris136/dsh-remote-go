/**
 * Read-only directory browsing used by the key-file picker.
 *
 * The plugin authenticates with a private-key file only, so the client needs a way
 * to *choose* one without typing an absolute path. DSH ships a directory picker,
 * not a file picker, so the Host lists directories itself: a caller walks to a
 * folder and picks a file from it.
 *
 * Everything stays inside the user's home directory: the picker never becomes a
 * general filesystem browser, and a path that resolves outside home (through `..`
 * or a symlink) is refused rather than clamped.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Entries beyond this count are dropped and reported as truncated. */
const MAX_ENTRIES = 500

/**
 * @param {{ home: string, dir?: string, fsImpl?: typeof fs }} options
 * @returns {Promise<{ path: string, parent: string | null, entries: Array<{ name: string, path: string, isDirectory: boolean }>, truncated: boolean }>}
 */
export async function listKeyFiles(options) {
  const home = path.resolve(options.home)
  const impl = options.fsImpl ?? fs
  // Canonical base: the home directory spelled the way the filesystem reports it.
  // Every path below derives from this one spelling, so the returned `path` and
  // `parent` can never disagree — Windows hands out an 8.3 short path
  // (`C:\Users\RUNNER~1\…`) for a directory that realpath reports in long form.
  const realHome = await impl.realpath(home).catch(() => home)
  const requested = expandHome(options.dir, realHome)
  const target = path.resolve(requested || path.join(realHome, '.ssh'))
  // Resolve first, then judge: a symlinked directory may lead outside home. A path
  // that does not exist keeps its requested spelling, which the check still judges.
  const realTarget = await impl.realpath(target).catch(() => target)
  if (realTarget !== realHome && !realTarget.startsWith(realHome + path.sep)) {
    throw new Error('key-file path must stay inside the home directory')
  }

  const dirents = await impl.readdir(realTarget, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    const full = path.join(realTarget, dirent.name)
    const isDirectory = dirent.isDirectory()
    // Only regular files and directories are selectable; a socket or device node
    // in a home directory is never a private key.
    if (!isDirectory && !dirent.isFile()) continue
    entries.push({ name: dirent.name, path: full, isDirectory })
  }
  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  const shown = entries.slice(0, MAX_ENTRIES)
  const parent = realTarget === realHome ? null : path.dirname(realTarget)
  return {
    path: realTarget,
    parent: parent ?? realHome,
    entries: shown,
    truncated: entries.length > shown.length,
  }
}

/**
 * Expand a leading `~` against the resolved home; a bare relative path stays
 * relative so the caller's `path.resolve` keeps its meaning.
 * @param {string | undefined} value
 * @param {string} home
 */
function expandHome(value, home) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(home, trimmed.slice(2))
  return trimmed
}

/** Read-only directory browsing for the key-file picker; a path that resolves outside the user home directory (through
 * `..` or a symlink) is refused. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expandHome } from './util.js'

/** The `fs.promises` surface the picker uses; tests inject a fake. */
export interface KeyFilesFileSystem {
  realpath(target: string): Promise<string>
  readdir(target: string, options: { withFileTypes: true }): Promise<KeyFilesDirent[]>
}

/** The `Dirent` fields the picker reads. */
export type KeyFilesDirent = { name: string; isDirectory(): boolean; isFile(): boolean }

export interface KeyFilesInput {
  home: string
  /** Requested directory; `~` is expanded and an empty value means `~/.ssh`. */
  dir?: unknown
  fsImpl?: KeyFilesFileSystem
}

/** One selectable row of the picker. */
export type KeyFileEntry = { name: string; path: string; isDirectory: boolean }

export type KeyFilesListing = { path: string; parent: string; entries: KeyFileEntry[]; truncated: boolean }

const MAX_ENTRIES = 500
/** Code of the "not inside the home directory" refusal, so callers can map it to an HTTP 400. */
export const OUTSIDE_HOME = 'EOUTSIDEHOME'

export async function listKeyFiles(options: KeyFilesInput): Promise<KeyFilesListing> {
  const home = path.resolve(options.home)
  const impl = options.fsImpl ?? fs
  // Canonical base: the home directory as the filesystem reports it, so `path` and `parent` cannot disagree — Windows
  // hands out an 8.3 short path (`C:\Users\RUNNER~1\…`) for a directory realpath reports in long form.
  const realHome = await impl.realpath(home).catch(() => home)
  const target = path.resolve(expandHome(options.dir, realHome) || path.join(realHome, '.ssh'))
  // Resolve first, then judge: a symlinked directory may lead outside home; a missing path keeps its spelling.
  const realTarget = await impl.realpath(target).catch(() => target)
  if (realTarget !== realHome && !realTarget.startsWith(realHome + path.sep)) {
    throw Object.assign(new Error('key-file path must stay inside the home directory'), { code: OUTSIDE_HOME })
  }
  const dirents = await impl.readdir(realTarget, { withFileTypes: true })
  const entries: KeyFileEntry[] = []
  for (const dirent of dirents) {
    const full = path.join(realTarget, dirent.name)
    const isDirectory = dirent.isDirectory()
    // Only regular files and directories are selectable; a socket or device node is never a private key.
    if (!isDirectory && !dirent.isFile()) continue
    entries.push({ name: dirent.name, path: full, isDirectory })
  }
  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  const shown = entries.slice(0, MAX_ENTRIES)
  const parent = realTarget === realHome ? realHome : path.dirname(realTarget)
  return { path: realTarget, parent, entries: shown, truncated: entries.length > shown.length }
}

/** Validation and naming for absolute remote POSIX paths. */
import path from 'node:path'
import { errors } from './errors.js'

/** Longest accepted path, matching the remote contract of ordinary POSIX tools. */
const MAX_PATH_CHARS = 4096

/**
 * Validate and normalize a remote file path.
 * @param {unknown} value - path from the client request.
 * @returns {string} a normalized absolute POSIX path.
 */
export function normalizeRemoteFilePath(value) {
  if (typeof value !== 'string') {
    throw errors.invalidInput('path', {
      zh: '远端文件路径必须是字符串。',
      en: 'The remote file path must be a string.',
    })
  }
  const text = value
  if (text === '') {
    throw errors.invalidInput('path', {
      zh: '远端文件路径不能为空。',
      en: 'The remote file path must not be empty.',
    })
  }
  if (text.length > MAX_PATH_CHARS) {
    throw errors.invalidInput('path', {
      zh: '远端文件路径过长。',
      en: 'The remote file path is too long.',
    })
  }
  if (text.includes('\0') || text.includes('\r') || text.includes('\n')) {
    throw errors.invalidInput('path', {
      zh: '远端文件路径包含不可用的控制字符。',
      en: 'The remote file path contains unsupported control characters.',
    })
  }
  if (!text.startsWith('/')) {
    throw errors.invalidInput('path', {
      zh: '远端文件路径必须是绝对路径。',
      en: 'The remote file path must be absolute.',
    })
  }
  const normalized = path.posix.normalize(text)
  if (!normalized.startsWith('/')) {
    throw errors.invalidInput('path', {
      zh: '远端文件路径必须是绝对路径。',
      en: 'The remote file path must be absolute.',
    })
  }
  return normalized
}

/**
 * The suggested download name for a remote path.
 * @param {string} remotePath - a normalized absolute path.
 * @returns {string} the last path segment, or a safe generic name.
 */
export function remoteFileName(remotePath) {
  const name = path.posix.basename(remotePath)
  return name === '' || name === '/' || name === '.' || name === '..' ? 'download' : name
}

/** One local filename segment; Windows-safe so the same code works on every Desktop. */
export function safeLocalSegment(value) {
  let text = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
  if (text === '' || text === '.' || text === '..') text = '_'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(text)) text = '_' + text
  return text
}

/**
 * Windows treats these names as its own metadata or as shell entries: writing them into
 * a download either corrupts a folder view (`desktop.ini`, `thumbs.db`) or leaves a file
 * that a double click executes instead of showing (`.lnk`, `.url`). A remote host never
 * gets to plant one in a local download.
 */
const IGNORED_LOCAL_NAMES = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', '.ds_store'])
const IGNORED_LOCAL_SUFFIXES = ['.lnk', '.url']

/**
 * Whether a remote name must be left out of a local folder download.
 * @param {unknown} value - one remote path segment (file or directory name).
 * @returns {boolean}
 */
export function isIgnoredLocalName(value) {
  const name = String(value ?? '')
    .trim()
    .toLowerCase()
  if (name === '') return false
  if (IGNORED_LOCAL_NAMES.has(name)) return true
  return IGNORED_LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * Pick a local path that no earlier member of the same download already claimed.
 *
 * A case-insensitive filesystem (the Windows/macOS defaults) maps `Report.md` and
 * `report.md` to one file: keeping both names would silently drop one of the two remote
 * files. The later one is renamed `report (2).md` instead, so the file count on disk
 * matches the inventory.
 *
 * @param {string} desired - absolute local path the member maps to.
 * @param {Set<string>} taken - keys of the paths already claimed (use {@link localPathKey}).
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {string} the chosen path (equal to `desired` when it is free).
 */
export function uniqueLocalPath(desired, taken, options = {}) {
  const key = (value) => localPathKey(value, options)
  if (!taken.has(key(desired))) return desired
  const directory = path.dirname(desired)
  const extension = path.extname(desired)
  const base = path.basename(desired, extension)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(directory, `${base} (${index})${extension}`)
    if (!taken.has(key(candidate))) return candidate
  }
  throw errors.remoteFileUnavailable({
    zh: '远端有太多文件映射到同一个本地文件名，无法安全保存。',
    en: 'Too many remote files map to the same local file name to save them safely.',
  })
}

/**
 * The collision key of a local path: separator-normalized, and lowercased when the local
 * filesystem ignores case.
 * @param {string} value - absolute or relative local path.
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {string}
 */
export function localPathKey(value, options = {}) {
  const text = String(value ?? '').replace(/\\/g, '/')
  return options.caseInsensitive === true ? text.toLowerCase() : text
}

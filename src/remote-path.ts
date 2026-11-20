/** Validation and naming for absolute remote POSIX paths. */
import path from 'node:path'
import { errors } from './errors.js'

/** Longest accepted path, matching the remote contract of ordinary POSIX tools. */
const MAX_PATH_CHARS = 4096

/** Options for the case rules of the local filesystem the download lands on. */
export type LocalPathOptions = { caseInsensitive?: boolean }

/** The one "this remote path is unusable" refusal; every rule below reports it with the same code. */
const invalidPath = (zh: string, en: string) => errors.invalidInput('path', { zh, en })

/** Validate and normalize a remote file path. The input comes from a client request, so anything that is not a usable
 * absolute POSIX path is refused with a coded error instead of reaching a remote command. */
export function normalizeRemoteFilePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidPath('远端文件路径必须是字符串。', 'The remote file path must be a string.')
  }
  const text = value
  if (text === '') throw invalidPath('远端文件路径不能为空。', 'The remote file path must not be empty.')
  if (text.length > MAX_PATH_CHARS) throw invalidPath('远端文件路径过长。', 'The remote file path is too long.')
  if (text.includes('\0') || text.includes('\r') || text.includes('\n')) {
    throw invalidPath(
      '远端文件路径包含不可用的控制字符。',
      'The remote file path contains unsupported control characters.',
    )
  }
  const normalized = path.posix.normalize(text)
  if (!normalized.startsWith('/') || !text.startsWith('/')) {
    throw invalidPath('远端文件路径必须是绝对路径。', 'The remote file path must be absolute.')
  }
  return normalized
}

/** The suggested download name for a remote path: the last path segment, or a safe generic name. */
export function remoteFileName(remotePath: string): string {
  const name = path.posix.basename(remotePath)
  return name === '' || name === '/' || name === '.' || name === '..' ? 'download' : name
}

/** One local filename segment; Windows-safe so the same code works on every Desktop. */
export function safeLocalSegment(value: unknown): string {
  let text = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
  if (text === '' || text === '.' || text === '..') text = '_'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(text)) text = '_' + text
  return text
}

/** Windows treats these names as its own metadata or as shell entries: writing one into a download either corrupts a
 * folder view (`desktop.ini`, `thumbs.db`) or leaves a file a double click executes instead of shows (`.lnk`, `.url`).
 * A remote host never gets to plant one in a local download. */
const IGNORED_LOCAL_NAMES = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', '.ds_store'])
const IGNORED_LOCAL_SUFFIXES = ['.lnk', '.url']

/** Whether a remote name must be left out of a local folder download. */
export function isIgnoredLocalName(value: unknown): boolean {
  const name = String(value ?? '')
    .trim()
    .toLowerCase()
  if (IGNORED_LOCAL_NAMES.has(name)) return true
  return IGNORED_LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** Pick a local path that no earlier member of the same download already claimed. A case-insensitive filesystem (the
 * Windows/macOS default) maps `Report.md` and `report.md` to one file, so keeping both names would silently drop one
 * remote file: the later one becomes `report (2).md` instead. */
export function uniqueLocalPath(desired: string, taken: Set<string>, options: LocalPathOptions = {}): string {
  const key = (value: string) => localPathKey(value, options)
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

/** The collision key of a local path: separator-normalized, and lowercased when the local filesystem ignores case. */
export function localPathKey(value: unknown, options: LocalPathOptions = {}): string {
  const text = String(value ?? '').replace(/\\/g, '/')
  return options.caseInsensitive === true ? text.toLowerCase() : text
}

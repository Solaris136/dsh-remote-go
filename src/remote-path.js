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

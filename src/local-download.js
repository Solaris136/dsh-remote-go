/**
 * Local download writer. Every download (single file or folder) is streamed from
 * SFTP directly to a user-selected local directory. Nothing is archived or held in
 * memory, and there is no byte or entry cap. Existing target names are renamed with
 * a ` (2)`, ` (3)` suffix so a download never overwrites local data.
 */
import path from 'node:path'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { errors, isRemoteGoError } from './errors.js'
import { remoteFileName, safeLocalSegment } from './remote-path.js'

async function requireDestination(destination) {
  if (typeof destination !== 'string' || destination.trim() === '' || destination.includes('\0')) {
    throw errors.invalidInput('destination', {
      zh: '请选择本机的保存文件夹。',
      en: 'Choose a destination folder on this machine.',
    })
  }
  const base = path.resolve(destination)
  try {
    const info = await stat(base)
    if (!info.isDirectory()) {
      throw errors.invalidInput('destination', {
        zh: '选择的保存位置不是文件夹。',
        en: 'The selected destination is not a folder.',
      })
    }
  } catch (error) {
    if (isRemoteGoError(error)) throw error
    throw errors.invalidInput('destination', {
      zh: '选择的保存文件夹不存在或不可写。',
      en: 'The selected destination folder does not exist or cannot be written.',
    })
  }
  return base
}

async function createUniqueFolder(base, name) {
  const safeName = safeLocalSegment(name) || 'download'
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(base, index === 1 ? safeName : `${safeName} (${index})`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
    }
  }
  throw errors.invalidInput('destination', {
    zh: '目标目录里已经有太多同名文件夹，请换一个目录。',
    en: 'The destination already contains too many folders with this name; choose another directory.',
  })
}

async function createUniqueFile(base, name) {
  const safeName = safeLocalSegment(name) || 'download'
  const extension = path.extname(safeName)
  const stem = path.basename(safeName, extension) || 'download'
  for (let index = 1; index <= 999; index += 1) {
    const fileName = index === 1 ? safeName : `${stem} (${index})${extension}`
    const candidate = path.join(base, fileName)
    try {
      const handle = await open(candidate, 'wx', 0o600)
      await handle.close()
      return candidate
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
    }
  }
  throw errors.invalidInput('destination', {
    zh: '目标目录里已经有太多同名文件，请换一个目录。',
    en: 'The destination already contains too many files with this name; choose another directory.',
  })
}

function toDownloadError(error) {
  if (isRemoteGoError(error)) return error
  return errors.remoteFileUnavailable(undefined, {
    technical: String(/** @type {any} */ (error?.message ?? error ?? '')).slice(0, 300),
  })
}

/**
 * Stream one remote file into `destination`, creating an auto-renamed local file.
 * @param {object} runtime - connected host runtime.
 * @param {string} remotePath - normalized absolute remote path.
 * @param {unknown} destination - absolute local directory.
 * @param {{ onProgress?: Function, isCancelled?: () => boolean }} [options]
 * @returns {Promise<{ path: string, kind: 'file', name: string, destination: string,
 *   totalBytes: number, files: number }>}
 */
export async function saveHostFile(runtime, remotePath, destination, options = {}) {
  if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
    throw errors.remoteFileUnavailable({
      zh: '这台主机还没有连接，无法读取远端文件。',
      en: 'This host is not connected, so the remote file cannot be read.',
    })
  }
  if (typeof runtime.ssh.saveRemoteFile !== 'function') {
    throw errors.internal('the SSH transport does not support file saves')
  }
  const base = await requireDestination(destination)
  const name = remoteFileName(remotePath)
  let localPath = null
  try {
    localPath = await createUniqueFile(base, name)
    const result = await runtime.ssh.saveRemoteFile(remotePath, localPath, options)
    return {
      path: remotePath,
      kind: 'file',
      name: path.basename(localPath),
      destination: localPath,
      totalBytes: Number(result?.size ?? 0),
      files: 1,
    }
  } catch (error) {
    if (localPath) await rm(localPath, { force: true }).catch(() => {})
    throw toDownloadError(error)
  }
}

/**
 * Copy one remote folder into `destination` as individual local files.
 * @param {object} runtime - connected host runtime.
 * @param {string} remotePath - normalized absolute remote folder path.
 * @param {unknown} destination - absolute local directory.
 * @param {{ onInventory?: Function, onProgress?: Function, isCancelled?: () => boolean }} [options]
 * @returns {Promise<{ path: string, kind: 'folder', name: string, destination: string,
 *   totalBytes: number, files: number, cancelled?: boolean }>}
 */
export async function saveHostFolder(runtime, remotePath, destination, options = {}) {
  if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
    throw errors.remoteFileUnavailable({
      zh: '这台主机还没有连接，无法读取远端文件夹。',
      en: 'This host is not connected, so the remote folder cannot be read.',
    })
  }
  if (typeof runtime.ssh.saveRemoteTree !== 'function') {
    throw errors.internal('the SSH transport does not support folder saves')
  }
  const base = await requireDestination(destination)
  const name = remoteFileName(remotePath)
  let root = null
  try {
    root = await createUniqueFolder(base, name)
    const result = await runtime.ssh.saveRemoteTree(remotePath, root, options)
    return {
      path: remotePath,
      kind: 'folder',
      name,
      destination: result?.destination ?? root,
      totalBytes: Number(result?.totalBytes ?? 0),
      files: Number(result?.totalFiles ?? 0),
      ...(result?.cancelled === true ? { cancelled: true } : {}),
    }
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
    throw toDownloadError(error)
  }
}

export { requireDestination }

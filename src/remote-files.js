/**
 * Remote download entry: validate an absolute Linux path, inspect it, then hand it
 * to the local writer. Both files and folders stream directly to disk; no bytes are
 * buffered in the Host and no ZIP is created.
 */
import { errors, isRemoteGoError } from './errors.js'
import { requireDestination, saveHostFile, saveHostFolder } from './local-download.js'
import { normalizeRemoteFilePath } from './remote-path.js'

export { normalizeRemoteFilePath, remoteFileName } from './remote-path.js'

/**
 * Save one file or one folder for a download job.
 * @param {object} runtime - the connected host runtime.
 * @param {unknown} rawPath - the requested absolute remote path.
 * @param {{ destination?: string, onProgress?: Function, onInventory?: Function,
 *   isCancelled?: () => boolean }} [options]
 * @returns {Promise<{ path: string, kind: 'file'|'folder', name: string,
 *   destination: string, totalBytes: number, files: number, cancelled?: boolean }>}
 */
export async function readHostDownload(runtime, rawPath, options = {}) {
  if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
    throw errors.remoteFileUnavailable({
      zh: '这台主机还没有连接，无法读取远端内容。',
      en: 'This host is not connected, so the remote content cannot be read.',
    })
  }
  const remotePath = normalizeRemoteFilePath(rawPath)
  const ssh = runtime.ssh
  if (typeof ssh.inspectRemotePath !== 'function') {
    throw errors.internal('the SSH transport does not support path inspection')
  }
  let destination
  try {
    const info = await ssh.inspectRemotePath(remotePath)
    destination = await requireDestination(options.destination)
    if (info.isFile) return await saveHostFile(runtime, remotePath, destination, options)
    if (info.isDirectory) return await saveHostFolder(runtime, remotePath, destination, options)
    throw errors.remoteFileUnavailable({
      zh: '这个远端路径既不是普通文件，也不是文件夹。',
      en: 'This remote path is neither a regular file nor a folder.',
    })
  } catch (error) {
    if (isRemoteGoError(error)) throw error
    throw toRemoteFileError(error)
  }
}

/**
 * Classify an SFTP failure without leaking transport internals to the client.
 * @param {unknown} error - the transport error.
 * @returns {import('./errors.js').RemoteGoError} a client-safe error.
 */
export function toRemoteFileError(error) {
  if (isRemoteGoError(error)) return error
  const code = Number(/** @type {any} */ (error)?.code)
  const message = String(/** @type {any} */ (error?.message ?? error ?? ''))
  if (code === 2 || /no such file|not found/i.test(message)) {
    return errors.remoteFileUnavailable({
      zh: '远端文件不存在或已经被移动。',
      en: 'The remote file no longer exists or was moved.',
    })
  }
  if (code === 3 || /permission denied|access denied/i.test(message)) {
    return errors.remoteFileUnavailable({
      zh: '当前 SSH 用户没有读取这个远端路径的权限。',
      en: 'The SSH user is not allowed to read this remote path.',
    })
  }
  return errors.remoteFileUnavailable(undefined, { technical: message.slice(0, 300) })
}

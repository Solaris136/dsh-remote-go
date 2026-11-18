/**
 * Remote download entry: validate an absolute Linux path, inspect it, then hand it
 * to the local writer. Both files and folders stream directly to disk; no bytes are
 * buffered in the Host and no ZIP is created.
 */
import { errors, isRemoteGoError } from './errors.js'
import type { RemoteGoError } from './errors.js'
import { requireDestination, saveHostFile, saveHostFolder } from './local-download.js'
import type {
  HostDownloadRuntime,
  SaveHostFileOptions,
  SaveHostFolderOptions,
  SavedDownload,
} from './local-download.js'
import { normalizeRemoteFilePath } from './remote-path.js'
import type { SshPort } from './ssh-port.js'

export { normalizeRemoteFilePath, remoteFileName } from './remote-path.js'

/** What one download call accepts: the local home plus the destination chosen in the dialog. */
export interface ReadHostDownloadOptions extends SaveHostFileOptions, SaveHostFolderOptions {
  destination?: unknown
}

/**
 * Save one file or one folder for a download job.
 * @param runtime - the connected host runtime.
 * @param rawPath - the requested absolute remote path.
 */
export async function readHostDownload(
  runtime: HostDownloadRuntime | null | undefined,
  rawPath: unknown,
  options: ReadHostDownloadOptions = {},
): Promise<SavedDownload> {
  if (!runtime || runtime.status !== 'connected' || !runtime.ssh) {
    throw errors.remoteFileUnavailable({
      zh: '这台主机还没有连接，无法读取远端内容。',
      en: 'This host is not connected, so the remote content cannot be read.',
    })
  }
  const remotePath = normalizeRemoteFilePath(rawPath)
  const ssh: SshPort = runtime.ssh
  if (typeof ssh.inspectRemotePath !== 'function') {
    throw errors.internal('the SSH transport does not support path inspection')
  }
  let destination: string
  try {
    const info = await ssh.inspectRemotePath(remotePath)
    destination = await requireDestination(options.destination, { home: options.home })
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
 * @param error - the transport error.
 * @returns a client-safe error.
 */
export function toRemoteFileError(error: unknown): RemoteGoError {
  // `isRemoteGoError` only declares a boolean (it lives in the P1a set); the `as` restates
  // the narrowing its `instanceof` proves at runtime.
  if (isRemoteGoError(error)) return error as RemoteGoError
  // A transport error is `unknown`: the `as` restates the two fields an SFTP error carries
  // (`code` 2/3 for ENOENT/EACCES) and the `??` fallbacks keep a thrown string working.
  const code = Number((error as { code?: unknown } | null)?.code)
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '')
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

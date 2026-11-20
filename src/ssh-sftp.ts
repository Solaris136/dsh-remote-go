/** The SFTP download capability of the ssh2 adapter: one session, stat/list, and streaming one file or a whole tree
 * into a local path. `ssh.ts` delegates here to stay inside the 600-line budget, and because ssh2's SFTP details are a
 * capability — optional on `SshPort` (`saveRemoteFile`/`saveRemoteTree`/`inspectRemotePath`) — rather than part of
 * "opening a connection"; nothing outside the adapter imports this module. Deliberately unchanged: the disk is the only
 * bound (cancellation deletes), symlinks are skipped so a loop cannot cycle, Windows metadata names are special only
 * there and reported, and a throwing listener never aborts the transfer. */
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Client as Ssh2Client, SftpDirEntry, SftpSession, SftpStats } from '../vendor/ssh2.bundle.cjs'
import { errors } from './errors.js'
import { isIgnoredLocalName, localPathKey, safeLocalSegment, uniqueLocalPath } from './remote-path.js'
import type { SftpDownloadOptions, SshRemoteFileInfo, SshTreeDownloadResult } from './ssh-port.js'

/** One member of the tree the walk discovered, before anything is written. */
type RemoteTreeMember = {
  relative: string
  localPath: string
  isDirectory?: boolean
  remotePath?: string
  size?: number
}

/** Wrap one node-style ssh2 callback as a promise (the vendor surface has no promise variant). */
const call = <T>(run: (done: (error: unknown, value?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value))))

/** Open one SFTP session on an established transport. */
export function openSftpSession(client: Ssh2Client): Promise<SftpSession> {
  return call((done) => client.sftp(done))
}

/** Close one SFTP session, ignoring a session that is already gone. */
export function endSftp(sftp: SftpSession): void {
  try {
    sftp.end()
  } catch {
    // swallow-ok: the SFTP session may already be gone
  }
}

/** Stream one remote file into a local path. Nothing is buffered; cancellation destroys both streams and removes the
 * partial file. */
export async function saveSftpFile(
  sftp: SftpSession,
  remotePath: string,
  localPath: string,
  options: SftpDownloadOptions = {},
): Promise<{ size: number }> {
  const stats = await call<SftpStats>((done) => sftp.stat(remotePath, done))
  assertReadableFile(stats)
  const totalBytes = Number(stats?.size ?? 0)
  let doneBytes = 0
  try {
    await copySftpFileToLocal(
      sftp,
      remotePath,
      localPath,
      (bytes) => {
        doneBytes += bytes
        try {
          options.onProgress?.({ doneBytes, totalBytes, doneFiles: 0, totalFiles: 1 })
        } catch {
          // swallow-ok: progress listeners must not break the transfer
        }
      },
      options.isCancelled,
    )
  } catch (error) {
    await rm(localPath, { force: true }).catch(() => {})
    throw error
  }
  return { size: doneBytes || totalBytes }
}

export async function inspectSftpPath(sftp: SftpSession, remotePath: string): Promise<SshRemoteFileInfo> {
  const stats = await call<SftpStats>((done) => sftp.stat(remotePath, done))
  return {
    isFile: Boolean(stats?.isFile?.()),
    isDirectory: Boolean(stats?.isDirectory?.()),
    size: Number(stats?.size ?? 0),
    mtime: Number(stats?.mtime ?? 0),
  }
}

/** Copy a remote directory to a local directory, one file at a time: directories are created locally (empty ones
 * included), symlinks are skipped and there is no byte/count cap; `onIgnored` reports the skipped names. */
export async function saveSftpTree(
  sftp: SftpSession,
  remotePath: string,
  targetRoot: string,
  options: SftpDownloadOptions = {},
): Promise<SshTreeDownloadResult> {
  const rootStats = await call<SftpStats>((done) => sftp.stat(remotePath, done))
  if (!rootStats?.isDirectory?.()) {
    throw errors.remoteFileUnavailable({
      zh: '这个远端路径不是目录，无法按文件夹下载。',
      en: 'This remote path is not a directory and cannot be downloaded as a folder.',
    })
  }
  const localRoot = path.resolve(targetRoot)
  // Case-insensitive local filesystems map `Report.md` and `report.md` to one file: the download would silently lose
  // one of them. The default follows the platform (Windows and macOS both default to case-insensitive volumes);
  // tests can force it either way.
  const caseInsensitive = options.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')
  // The Windows metadata / shortcut names are only special on Windows: on Linux/macOS `*.lnk` or `desktop.ini` are
  // ordinary files and must be downloaded like any other.
  const ignoreWindowsNames = options.ignoreWindowsNames ?? process.platform === 'win32'
  const insideRoot = (candidate: string): string => {
    const resolved = path.resolve(candidate)
    if (resolved === localRoot || resolved.startsWith(localRoot + path.sep)) return resolved
    throw errors.remoteFileUnavailable({
      zh: '远端文件名无法安全映射到本地目录。',
      en: 'A remote file name cannot be mapped safely into the local directory.',
    })
  }
  const members: RemoteTreeMember[] = []
  const ignoredNames: string[] = []
  let totalBytes = 0
  let totalFiles = 0
  let renamedFiles = 0
  const walk = async (directory: string, relative: string, localDir: string): Promise<void> => {
    const listing = await call<SftpDirEntry[]>((done) => sftp.readdir(directory, done))
    const items = Array.isArray(listing) ? listing.slice() : []
    items.sort((left, right) => String(left?.filename ?? '').localeCompare(String(right?.filename ?? '')))
    // Names are claimed per directory, so a renamed member keeps its own children.
    const used = new Set<string>()
    for (const item of items) {
      const filename = String(item?.filename ?? '')
      if (filename === '' || filename === '.' || filename === '..') continue
      const attrs = item?.attrs ?? {}
      if (attrs.isSymbolicLink?.() === true) continue
      // Windows metadata and shell entries are never planted in a local download; the skipped names are reported in
      // the result so nothing disappears silently.
      if (ignoreWindowsNames && isIgnoredLocalName(filename)) {
        ignoredNames.push(relative === '' ? filename : `${relative}/${filename}`)
        continue
      }
      const childRelative = relative === '' ? filename : relative + '/' + filename
      const childPath = path.posix.join(directory, filename)
      const desired = insideRoot(path.join(localDir, safeLocalSegment(filename)))
      const localPath = insideRoot(uniqueLocalPath(desired, used, { caseInsensitive }))
      used.add(localPathKey(localPath, { caseInsensitive }))
      if (attrs.isDirectory?.() === true) {
        members.push({ relative: childRelative, isDirectory: true, localPath })
        await walk(childPath, childRelative, localPath)
      } else if (attrs.isFile?.() === true) {
        const size = Number(attrs.size ?? 0)
        if (!Number.isFinite(size) || size < 0) continue
        if (localPath !== desired) renamedFiles += 1
        totalFiles += 1
        totalBytes += size
        members.push({ relative: childRelative, remotePath: childPath, size, localPath })
      }
    }
  }
  await walk(remotePath, '', localRoot)
  if (typeof options.onInventory === 'function') {
    try {
      options.onInventory({ totalBytes, totalFiles })
    } catch {
      // swallow-ok: inventory listeners must not break the download
    }
  }
  if (ignoredNames.length > 0 && typeof options.onIgnored === 'function') {
    try {
      options.onIgnored(ignoredNames.slice())
    } catch {
      // swallow-ok: the ignored-name listener must not break the download
    }
  }
  await mkdir(localRoot, { recursive: true })
  for (const member of members) {
    if (member.isDirectory) await mkdir(member.localPath, { recursive: true })
  }
  let doneBytes = 0
  let doneFiles = 0
  const report = () => {
    try {
      options.onProgress?.({ doneBytes, totalBytes, doneFiles, totalFiles })
    } catch {
      // swallow-ok: progress listeners must not break the download
    }
  }
  const cancelled = async (): Promise<SshTreeDownloadResult> => {
    await rm(localRoot, { recursive: true, force: true }).catch(() => {})
    return { destination: localRoot, totalBytes, totalFiles, cancelled: true }
  }
  for (const member of members) {
    if (member.isDirectory || typeof member.remotePath !== 'string') continue
    if (options.isCancelled?.()) return cancelled()
    await mkdir(path.dirname(member.localPath), { recursive: true })
    try {
      await copySftpFileToLocal(
        sftp,
        member.remotePath,
        member.localPath,
        (bytes) => {
          doneBytes += bytes
          report()
        },
        options.isCancelled,
      )
    } catch (error) {
      if (options.isCancelled?.()) return cancelled()
      throw error
    }
    doneFiles += 1
    report()
  }
  return { destination: localRoot, totalBytes, totalFiles, renamedFiles, ignoredNames }
}

function assertReadableFile(stats: SftpStats): void {
  if (stats?.isDirectory?.()) {
    throw errors.remoteFileUnavailable({
      zh: '这是一个远端目录，不能作为文件下载。',
      en: 'This remote path is a directory, not a downloadable file.',
    })
  }
}

/** Pipe one SFTP file into a local file, reporting bytes as they arrive. */
function copySftpFileToLocal(
  sftp: SftpSession,
  remotePath: string,
  localPath: string,
  onChunk: (bytes: number) => void,
  shouldCancel?: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let input: Readable | undefined
    try {
      input = sftp.createReadStream(remotePath)
    } catch (error) {
      reject(error)
      return
    }
    if (!input || typeof input.on !== 'function') {
      reject(new Error('SFTP read stream is unavailable'))
      return
    }
    const output = createWriteStream(localPath, { flags: 'w' })
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try {
        input.destroy()
      } catch {
        // swallow-ok: the read stream is already destroyed
      }
      const finish = () => reject(error)
      try {
        if (output.closed === true) finish()
        else {
          output.once('close', finish)
          output.destroy()
        }
      } catch {
        finish()
      }
    }
    input.on('data', (chunk: Buffer) => {
      if (shouldCancel?.()) {
        fail(new Error('download-cancelled'))
        return
      }
      try {
        onChunk(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk))
      } catch {
        // swallow-ok: the progress listener must not break the transfer
      }
    })
    pipeline(input, output).then(() => {
      if (settled) return
      settled = true
      resolve()
    }, fail)
  })
}

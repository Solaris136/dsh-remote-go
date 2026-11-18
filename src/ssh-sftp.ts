/**
 * The SFTP download capability of the ssh2 adapter: one session, stat/list, and streaming one file
 * or a whole tree into a local path.
 *
 * `ssh.ts` keeps the transport itself and delegates here, for two reasons: the adapter has to stay
 * within the 600-line budget, and ssh2's SFTP details are a capability — optional on `SshPort`
 * (`saveRemoteFile`/`saveRemoteTree`/`inspectRemotePath`) — rather than part of "open a connection".
 * Nothing outside the adapter imports this module.
 *
 * Behaviour that is deliberately unchanged from the pre-P5 single file:
 *   - the local disk is the only bound (no byte/entry cap); cancellation deletes what it wrote;
 *   - symlinks are skipped, so a remote loop cannot cycle;
 *   - Windows metadata names are only special on Windows (and are reported, never dropped silently);
 *   - two names differing only by case are both kept on a case-insensitive local volume, by renaming;
 *   - a progress/inventory listener that throws must never abort the transfer.
 */
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
interface RemoteTreeMember {
  relative: string
  localPath: string
  isDirectory?: boolean
  remotePath?: string
  size?: number
}

/** Open one SFTP session on an established transport. */
export function openSftpSession(client: Ssh2Client): Promise<SftpSession> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error)
      else resolve(sftp)
    })
  })
}

/** Close one SFTP session, ignoring a session that is already gone. */
export function endSftp(sftp: SftpSession): void {
  try {
    sftp.end()
  } catch {
    /* the session may already be gone */
  }
}

/**
 * Stream one remote file into a local path. Nothing is buffered; cancellation destroys both
 * streams and removes the partial file.
 */
export async function saveSftpFile(
  sftp: SftpSession,
  remotePath: string,
  localPath: string,
  options: SftpDownloadOptions = {},
): Promise<{ size: number }> {
  const stats = await new Promise<SftpStats>((resolve, reject) => {
    sftp.stat(remotePath, (error, value) => (error ? reject(error) : resolve(value)))
  })
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
        if (typeof options.onProgress !== 'function') return
        try {
          options.onProgress({ doneBytes, totalBytes, doneFiles: 0, totalFiles: 1 })
        } catch {
          /* progress listeners must not break the transfer */
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

/** Inspect one remote path without reading it. */
export async function inspectSftpPath(sftp: SftpSession, remotePath: string): Promise<SshRemoteFileInfo> {
  const stats = await new Promise<SftpStats>((resolve, reject) => {
    sftp.stat(remotePath, (error, value) => (error ? reject(error) : resolve(value)))
  })
  return {
    isFile: Boolean(stats?.isFile?.()),
    isDirectory: Boolean(stats?.isDirectory?.()),
    size: Number(stats?.size ?? 0),
    mtime: Number(stats?.mtime ?? 0),
  }
}

/**
 * Copy a remote directory to a local directory, one file at a time (no archive).
 *
 * Directories are created locally, empty ones included; symlinks are skipped so a remote loop
 * cannot cycle. There is no byte/count cap: the local disk is the bound. `options.caseInsensitive`
 * defaults to the local platform (Windows/macOS); `options.ignoreWindowsNames` defaults to Windows
 * and is the only platform where the Windows-only names are skipped; `options.onIgnored` receives
 * the skipped names so a download job can show them.
 */
export async function saveSftpTree(
  sftp: SftpSession,
  remotePath: string,
  targetRoot: string,
  options: SftpDownloadOptions = {},
): Promise<SshTreeDownloadResult> {
  const rootStats = await new Promise<SftpStats>((resolve, reject) => {
    sftp.stat(remotePath, (error, value) => (error ? reject(error) : resolve(value)))
  })
  if (!rootStats?.isDirectory?.()) {
    throw errors.remoteFileUnavailable({
      zh: '这个远端路径不是目录，无法按文件夹下载。',
      en: 'This remote path is not a directory and cannot be downloaded as a folder.',
    })
  }
  const localRoot = path.resolve(targetRoot)
  // Case-insensitive local filesystems map `Report.md` and `report.md` to one file: the download
  // would silently lose one of them. The default follows the platform (Windows and macOS both
  // default to case-insensitive volumes); tests can force it either way.
  const caseInsensitive = options.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')
  // The Windows metadata / shortcut names are only special on Windows: on Linux/macOS `*.lnk` or
  // `desktop.ini` are ordinary files and must be downloaded like any other.
  const ignoreWindowsNames = options.ignoreWindowsNames ?? process.platform === 'win32'
  const insideRoot = (candidate: string): string => {
    const resolved = path.resolve(candidate)
    if (resolved !== localRoot && !resolved.startsWith(localRoot + path.sep)) {
      throw errors.remoteFileUnavailable({
        zh: '远端文件名无法安全映射到本地目录。',
        en: 'A remote file name cannot be mapped safely into the local directory.',
      })
    }
    return resolved
  }
  const members: RemoteTreeMember[] = []
  const ignoredNames: string[] = []
  let totalBytes = 0
  let totalFiles = 0
  let renamedFiles = 0
  const walk = async (directory: string, relative: string, localDir: string): Promise<void> => {
    const listing = await new Promise<SftpDirEntry[]>((resolve, reject) => {
      sftp.readdir(directory, (error, value) => (error ? reject(error) : resolve(value)))
    })
    const items = Array.isArray(listing) ? listing.slice() : []
    items.sort((left, right) => String(left?.filename ?? '').localeCompare(String(right?.filename ?? '')))
    // Names are claimed per directory, so a renamed member keeps its own children.
    const used = new Set<string>()
    for (const item of items) {
      const filename = String(item?.filename ?? '')
      if (filename === '' || filename === '.' || filename === '..') continue
      const attrs = item?.attrs ?? {}
      if (attrs.isSymbolicLink?.() === true) continue
      // Windows metadata and shell entries are never planted in a local download (M6); the
      // skipped names are reported in the result so nothing disappears silently.
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
      /* progress listeners must not break the download */
    }
  }
  if (ignoredNames.length > 0 && typeof options.onIgnored === 'function') {
    try {
      options.onIgnored(ignoredNames.slice())
    } catch {
      /* progress listeners must not break the download */
    }
  }
  await mkdir(localRoot, { recursive: true })
  for (const member of members) {
    if (member.isDirectory) await mkdir(member.localPath, { recursive: true })
  }
  let doneBytes = 0
  let doneFiles = 0
  const report = () => {
    if (typeof options.onProgress !== 'function') return
    try {
      options.onProgress({ doneBytes, totalBytes, doneFiles, totalFiles })
    } catch {
      /* progress listeners must not break the download */
    }
  }
  for (const member of members) {
    if (member.isDirectory || typeof member.remotePath !== 'string') continue
    if (typeof options.isCancelled === 'function' && options.isCancelled()) {
      await rm(localRoot, { recursive: true, force: true }).catch(() => {})
      return { destination: localRoot, totalBytes, totalFiles, cancelled: true }
    }
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
      if (typeof options.isCancelled === 'function' && options.isCancelled()) {
        await rm(localRoot, { recursive: true, force: true }).catch(() => {})
        return { destination: localRoot, totalBytes, totalFiles, cancelled: true }
      }
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
        /* already gone */
      }
      const finish = () => reject(error)
      try {
        if (output.closed === true) {
          finish()
        } else {
          output.once('close', finish)
          output.destroy()
        }
      } catch {
        finish()
      }
    }
    input.on('data', (chunk: Buffer) => {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        fail(new Error('download-cancelled'))
        return
      }
      try {
        onChunk(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk))
      } catch {
        /* progress listeners must not break the transfer */
      }
    })
    pipeline(input, output).then(
      () => {
        if (!settled) {
          settled = true
          resolve()
        }
      },
      (error) => fail(error),
    )
  })
}

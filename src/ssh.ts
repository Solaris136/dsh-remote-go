/**
 * Promise wrapper over `ssh2`: host-key policy/confirmation, auth fallback, one-shot `exec` with streamed output, and TCP forwarding for the loopback tunnel.
 */
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ssh2 from '../vendor/ssh2.bundle.cjs'
import type {
  Client as Ssh2Client,
  ClientChannel,
  ConnectConfig,
  SftpDirEntry,
  SftpSession,
  SftpStats,
} from '../vendor/ssh2.bundle.cjs'
import { fingerprintFromBlob } from './known-hosts.js'
import { expandHome, headTail } from './util.js'
import { errors, RemoteGoError } from './errors.js'
import { isIgnoredLocalName, localPathKey, safeLocalSegment, uniqueLocalPath } from './remote-path.js'

const { Client } = ssh2

/** What one `exec` resolves with: the captured output, the exit status and whether it timed out. */
export interface SshExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Per-command knobs; every caller may omit them. */
export interface SshExecOptions {
  timeoutMs?: number
  maxBytes?: number
  env?: Record<string, string>
  /** Optional stdin (file uploads): the command reads it, so a secret never shows in argv. */
  stdin?: unknown
  signal?: AbortSignal
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
}

/** One progress frame shared by the single-file and tree transfers. */
export interface TransferProgress {
  doneBytes: number
  totalBytes: number
  doneFiles: number
  totalFiles: number
}

/** What a read-only inspection of one remote path reports. */
export interface RemotePathInfo {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtime: number
}

export interface SaveRemoteFileOptions {
  onProgress?: (info: TransferProgress) => void
  isCancelled?: () => boolean
}

/** The tree transfer's inventory callback: sizes rolled up before the first byte is copied. */
export interface TransferInventory {
  totalBytes: number
  totalFiles: number
}

export interface SaveRemoteTreeOptions {
  onInventory?: (info: TransferInventory) => void
  onProgress?: (info: TransferProgress) => void
  onIgnored?: (names: string[]) => void
  isCancelled?: () => boolean
  caseInsensitive?: boolean
  ignoreWindowsNames?: boolean
}

export interface SaveRemoteTreeResult {
  destination: string
  totalBytes: number
  totalFiles: number
  renamedFiles?: number
  ignoredNames?: string[]
  cancelled?: boolean
}

/**
 * The transport surface the rest of the host half drives. `SshConnection` is the ssh2
 * implementation; every caller takes this shape so a fake transport can stand in for it.
 * The SFTP capabilities are optional on purpose: `local-download.ts` and `remote-files.ts`
 * feature-detect them (`typeof ssh.saveRemoteFile === 'function'`) instead of assuming them.
 */
export interface SshTransport {
  readonly connected: boolean
  exec(command: string, options?: SshExecOptions): Promise<SshExecResult>
  forwardOut(destHost: string, destPort: number, srcHost?: string, srcPort?: number): Promise<ClientChannel>
  inspectRemotePath?(remotePath: string): Promise<RemotePathInfo>
  saveRemoteFile?(remotePath: string, localPath: string, options?: SaveRemoteFileOptions): Promise<{ size: number }>
  saveRemoteTree?(
    remotePath: string,
    targetRoot: string,
    options?: SaveRemoteTreeOptions,
  ): Promise<SaveRemoteTreeResult>
  /** A duck-typed capability no transport implements today; callers must feature-detect it. */
  readRemoteFile?(
    remotePath: string,
    options?: { maxBytes?: number },
  ): Promise<{ data?: Buffer | string; size?: number }>
}

/** The ssh2 channel type travels with this module: `tunnel.ts` pipes it and `SshTransport` returns it. */
export type { ClientChannel } from '../vendor/ssh2.bundle.cjs'

/** The host-key context a confirmation is about; never contains the key itself. */
export interface HostKeyInfo {
  sha256: string
  keyType: string
  pinned: boolean
}

/** The auth fields a host entry may carry. */
export interface SshAuthConfig {
  type: 'key' | 'password' | 'agent'
  keyPath?: string
  password?: string
}

/** One auth attempt handed to `connectOnce`: a key blob or a one-time password. */
export type SshAuthCandidate = { privateKey: Buffer } | { password: string; tryKeyboard: true }

/** Everything the connection needs; every field but `host` is optional and defaulted below. */
export interface SshConnectionOptions {
  host: string
  port?: number
  username?: string
  auth?: SshAuthConfig
  identityFiles?: string[]
  hostKeyPolicy?: string
  pinnedFingerprint?: string | null
  knownHostFingerprints?: string[]
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  home?: string
  sock?: ConnectConfig['sock']
  acceptUnknownHostKey?: boolean
  onHostKey?: (info: HostKeyInfo) => boolean | Promise<boolean>
  clientFactory?: () => Ssh2Client
}

/** The options object after the constructor applied its defaults. */
export interface SshResolvedOptions {
  host: string
  port: number
  hostKeyPolicy: string
  pinnedFingerprint: string | null
  knownHostFingerprints: string[]
  readyTimeoutMs: number
  keepaliveIntervalMs: number
  home: string
  username?: string
  auth?: SshAuthConfig
  sock?: ConnectConfig['sock']
  acceptUnknownHostKey?: boolean
  onHostKey?: (info: HostKeyInfo) => boolean | Promise<boolean>
  identityFiles: string[]
}

/** One member of the tree the walk discovered, before anything is written. */
interface RemoteTreeMember {
  relative: string
  localPath: string
  isDirectory?: boolean
  remotePath?: string
  size?: number
}

/** Settle a promise at most once; later calls are ignored, so callers need no flag. */
function oneShot<T>(
  resolve: (value: T) => void,
  reject: (error: unknown) => void,
  cleanup?: () => void,
): (error: unknown, value?: T) => void {
  let settled = false
  return (error, value) => {
    if (settled) return
    settled = true
    cleanup?.()
    if (error) reject(error)
    // The settled-once contract passes exactly one of error/value, so the success branch
    // always carries the value this `as` restates (the optional parameter cannot express it).
    else resolve(value as T)
  }
}

export function parseSshKeyType(blob: Buffer): string {
  try {
    const buffer = Buffer.from(blob)
    if (buffer.length < 6) return 'unknown'
    const length = buffer.readUInt32BE(0)
    if (length <= 0 || length > buffer.length - 4) return 'unknown'
    return buffer.subarray(4, 4 + length).toString('ascii')
  } catch {
    return 'unknown'
  }
}

/** The typed "the transport is gone" failure: retryable network, never a bare internal error. */
function closedError(): RemoteGoError {
  return errors.network(
    {
      zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
      en: 'SSH connection is not open; the transport closed before this step finished.',
    },
    { technical: 'reason=ssh-closed' },
  )
}

export class SshConnection extends EventEmitter implements SshTransport {
  declare options: SshResolvedOptions
  declare client: Ssh2Client | null
  declare fingerprint: string | null
  declare keyType: string | null
  declare closed: boolean
  declare disposed: boolean
  declare hostKeyDecision: Promise<boolean> | null
  declare clientFactory: () => Ssh2Client

  constructor(options: SshConnectionOptions) {
    super()
    this.options = {
      port: 22,
      hostKeyPolicy: 'first-use',
      pinnedFingerprint: null,
      knownHostFingerprints: [],
      readyTimeoutMs: 20_000,
      keepaliveIntervalMs: 15_000,
      home: homedir(),
      ...options,
      identityFiles: options.identityFiles ?? [],
    }
    this.client = null
    this.fingerprint = null
    this.keyType = null
    this.closed = false
    this.disposed = false
    this.hostKeyDecision = null
    // ssh2 clients emit `error` for every failed auth attempt and again while
    // tearing down. EventEmitter treats an unhandled `error` as a thrown
    // exception, which would take down the whole DSH host process; keep a
    // permanent safety listener so failures stay inside this connection.
    this.on('error', () => {})
    this.clientFactory = typeof options.clientFactory === 'function' ? options.clientFactory : () => new Client()
  }

  get connected(): boolean {
    return this.client !== null && !this.closed
  }

  async connect(): Promise<{ fingerprint: string; keyType: string }> {
    if (this.connected) return { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '' }
    const candidates = await this.resolveAuthCandidates()
    if (candidates.length === 0) {
      throw errors.invalidInput('auth', {
        zh: '没有可用的 SSH 认证方式：请选择一个可读的私钥文件（或输入一次密码）。',
        en: 'No usable SSH authentication: choose a readable private-key file (or enter a one-time password).',
      })
    }
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        const info = await this.connectOnce(candidate)
        this.client?.on('error', (error: Error) => {
          this.emit('error', error)
        })
        return info
      } catch (error) {
        lastError = error
        this.cleanupClient()
        // A host-key rejection is a policy decision, not an auth failure.
        if (isHostKeyError(error)) throw error
      }
    }
    throw lastError instanceof Error ? lastError : errors.auth()
  }

  connectOnce(authConfig: SshAuthCandidate): Promise<{ fingerprint: string; keyType: string }> {
    return new Promise((resolve, reject) => {
      const settle = oneShot(resolve, reject)
      const client = this.clientFactory()
      this.client = client
      // A rejected earlier candidate tears its transport down through
      // `cleanupClient()`, which marks this object closed. A new attempt owns a
      // fresh client, so it must clear the flag again; otherwise a successful
      // fallback (agent -> key on a machine without an SSH agent) would report
      // `connected === false` and every later `exec`/`forwardOut` would throw
      // "SSH connection is not open" on a transport that is actually up.
      this.closed = false
      // An attempt that has already failed is torn down by its own error/close pair (a DNS
      // resolution failure emits both synchronously), and that close is the teardown of a
      // connection that never existed - not a lost link. Without this flag the wrapper would
      // emit `close`, the pipeline would read a transport drop and retry a first connection
      // that never got off the ground (review: close-after-error).
      let attemptFailed = false
      // Attach the close handling *before* dialling: a transport that dies during the
      // handshake (for example while a host-key prompt is open) must be observable and must
      // reject the connect promise instead of hanging until the ready timeout. `this.client
      // !== client` filters a superseded auth attempt, whose teardown is not a lost link.
      client.once('close', () => {
        if (attemptFailed) return
        if (this.client !== client) return
        this.closed = true
        this.emit('close')
        settle(
          toSshError(new Error('the connection closed during the SSH handshake'), this.options.host, this.options.port),
        )
      })
      client.once('ready', () => {
        settle(null, { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '' })
      })
      // Permanent listener: settle the promise on the first error, swallow any
      // later teardown errors (they are already reflected in the rejection).
      client.on('error', (error: Error) => {
        attemptFailed = true
        settle(toSshError(error, this.options.host, this.options.port))
      })
      const config = {
        host: this.options.host,
        port: this.options.port,
        username: this.options.username ?? undefined,
        readyTimeout: this.options.readyTimeoutMs,
        keepaliveInterval: this.options.keepaliveIntervalMs,
        keepaliveCountMax: 3,
        tryKeyboard: false,
        ...(this.options.sock ? { sock: this.options.sock } : {}),
        ...authConfig,
        hostVerifier: (keyBlob: Buffer, verify: (accepted: boolean) => void) => {
          this.verifyHostKey(keyBlob)
            .then((accepted) => verify(accepted))
            .catch(() => verify(false))
        },
      }
      try {
        client.connect(config)
      } catch (error) {
        attemptFailed = true
        settle(toSshError(error, this.options.host, this.options.port))
      }
    })
  }

  async verifyHostKey(keyBlob: Buffer): Promise<boolean> {
    const sha256 = fingerprintFromBlob(keyBlob)
    const keyType = parseSshKeyType(keyBlob)
    this.fingerprint = sha256
    this.keyType = keyType
    const pinned = this.options.pinnedFingerprint
    const known = this.options.knownHostFingerprints ?? []
    const info = { sha256, keyType, pinned: Boolean(pinned && pinned === sha256) }
    if (pinned) {
      if (pinned === sha256) return true
      this.emit('hostkey-rejected', info)
      throw errors.hostKeyChanged(pinned, sha256)
    }
    if (known.length > 0) {
      if (known.includes(sha256)) return true
      this.emit('hostkey-rejected', info)
      throw errors.hostKeyChanged(known[0], sha256)
    }
    if (this.options.acceptUnknownHostKey === true) {
      this.emit('hostkey-accepted', info)
      return true
    }
    if (this.hostKeyDecision) return this.hostKeyDecision
    if (this.options.hostKeyPolicy === 'strict') {
      throw errors.hostKeyUnknown(sha256)
    }
    if (typeof this.options.onHostKey !== 'function') {
      // No UI attached (tests/automation): refuse rather than silently trust.
      throw errors.hostKeyUnknown(sha256)
    }
    this.emit('hostkey-pending', info)
    this.hostKeyDecision = Promise.resolve(this.options.onHostKey(info)).then(
      (accepted) => accepted === true,
      () => false,
    )
    const accepted = await this.hostKeyDecision
    if (!accepted) throw errors.hostKeyUnknown(sha256)
    return true
  }

  async resolveAuthCandidates(): Promise<SshAuthCandidate[]> {
    const auth = this.options.auth ?? { type: 'key' }
    const out: SshAuthCandidate[] = []
    if (auth.type === 'password') {
      if (auth.password) out.push({ password: auth.password, tryKeyboard: true })
      return out
    }
    // Key-file authentication only: there is deliberately no agent candidate. The
    // configured path wins; when it is missing or unset the conventional names are
    // tried, so a host added with the default key path still connects.
    const keyPaths = [
      ...(auth.keyPath ? [expandHome(auth.keyPath, this.options.home)] : []),
      ...(this.options.identityFiles ?? []),
      path.join(this.options.home, '.ssh', 'id_ed25519'),
      path.join(this.options.home, '.ssh', 'id_rsa'),
      path.join(this.options.home, '.ssh', 'id_ecdsa'),
    ]
    const seen = new Set<string>()
    for (const keyPath of keyPaths) {
      if (!keyPath) continue
      const normalized = path.resolve(keyPath)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      const privateKey = await readKey(keyPath)
      if (privateKey) out.push({ privateKey })
    }
    return out
  }

  exec(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(closedError())
        return
      }
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const chunks = { stdout: '', stderr: '' }
      const finish = oneShot(resolve, reject, () => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
      })
      const onAbort = () => {
        finish(new Error('aborted'))
      }
      options.signal?.addEventListener?.('abort', onAbort, { once: true })
      this.client.exec(command, { env: options.env }, (error, stream) => {
        if (error) {
          finish(error)
          return
        }
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true
            stream.destroy()
          }, timeoutMs)
        }
        // Optional stdin (file uploads): the command reads it, so a secret never
        // appears on the remote command line.
        if (options.stdin !== undefined) {
          try {
            stream.end(String(options.stdin))
          } catch (writeError) {
            finish(writeError)
            return
          }
        }
        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          if (chunks.stdout.length < maxBytes) {
            chunks.stdout += text
            // The consumer is a progress reporter: its failure must not abort the command.
            try {
              options.onStdout?.(text)
            } catch {
              /* stdout listeners must not break the command */
            }
          }
        })
        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          if (chunks.stderr.length < maxBytes) {
            chunks.stderr += text
            try {
              options.onStderr?.(text)
            } catch {
              /* stderr listeners must not break the command */
            }
          }
        })
        stream.on('close', (code: number | null, signal: string | null) => {
          finish(null, {
            code: code ?? null,
            signal: signal ?? null,
            stdout: chunks.stdout,
            stderr: chunks.stderr,
            timedOut,
          })
        })
        stream.on('error', (streamError: Error) => finish(streamError))
      })
    })
  }

  /** Open one SFTP session on this connection. */
  openSftp(): Promise<SftpSession> {
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(closedError())
        return
      }
      this.client.sftp((error, sftp) => {
        if (error) reject(error)
        else resolve(sftp)
      })
    })
  }

  /**
   * Stream one remote file into a local path. Nothing is buffered; cancellation
   * destroys both streams and removes the partial file.
   */
  async saveRemoteFile(
    remotePath: string,
    localPath: string,
    options: SaveRemoteFileOptions = {},
  ): Promise<{ size: number }> {
    const sftp = await this.openSftp()
    try {
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
    } finally {
      endSftp(sftp)
    }
  }

  /** Inspect one remote path without reading it. */
  async inspectRemotePath(remotePath: string): Promise<RemotePathInfo> {
    const sftp = await this.openSftp()
    try {
      const stats = await new Promise<SftpStats>((resolve, reject) => {
        sftp.stat(remotePath, (error, value) => (error ? reject(error) : resolve(value)))
      })
      return {
        isFile: Boolean(stats?.isFile?.()),
        isDirectory: Boolean(stats?.isDirectory?.()),
        size: Number(stats?.size ?? 0),
        mtime: Number(stats?.mtime ?? 0),
      }
    } finally {
      endSftp(sftp)
    }
  }

  /**
   * Copy a remote directory to a local directory, one file at a time (no archive).
   * Directories are created locally, empty ones included; symlinks are skipped so a
   * remote loop cannot cycle. There is no byte/count cap: the local disk is the bound.
   * `options.caseInsensitive` defaults to the local platform (Windows/macOS);
   * `options.ignoreWindowsNames` defaults to Windows and is the only platform where the
   * Windows-only names are skipped; `options.onIgnored` receives the skipped names so a
   * download job can show them.
   */
  async saveRemoteTree(
    remotePath: string,
    targetRoot: string,
    options: SaveRemoteTreeOptions = {},
  ): Promise<SaveRemoteTreeResult> {
    const sftp = await this.openSftp()
    try {
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
      // Case-insensitive local filesystems map `Report.md` and `report.md` to one file: the
      // download would silently lose one of them. The default follows the platform (Windows
      // and macOS both default to case-insensitive volumes); tests can force it either way.
      const caseInsensitive = options.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')
      // The Windows metadata / shortcut names are only special on Windows: on Linux/macOS
      // `*.lnk` or `desktop.ini` are ordinary files and must be downloaded like any other.
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
          // Windows metadata and shell entries are never planted in a local download (M6);
          // the skipped names are reported in the result so nothing disappears silently.
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
    } finally {
      endSftp(sftp)
    }
  }

  forwardOut(destHost: string, destPort: number, srcHost = '127.0.0.1', srcPort = 0): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(closedError())
        return
      }
      this.client.forwardOut(srcHost, srcPort, destHost, destPort, (error, stream) => {
        if (error) reject(error)
        else resolve(stream)
      })
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const client = this.client
    this.cleanupClient()
    if (!client) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_500)
      try {
        client.once('close', () => {
          clearTimeout(timer)
          resolve(undefined)
        })
        client.end()
      } catch {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
  }

  cleanupClient(): void {
    const client = this.client
    this.client = null
    this.closed = true
    if (client) {
      try {
        // Keep an error sink attached: ssh2 may still emit during teardown.
        client.on('error', () => {})
        client.end()
      } catch {}
    }
  }
}

/** A private key is a few kilobytes; anything larger is not one and must not be read. */
const MAX_KEY_BYTES = 1024 * 1024

async function readKey(keyPath: string): Promise<Buffer | null> {
  let handle: FileHandle | null = null
  try {
    // Measure and read through the *same* handle: a stat followed by a path-based read is a
    // race (the file could be swapped in between), and a non-regular file has no place here.
    handle = await open(keyPath, 'r')
    const stats = await handle.stat()
    if (stats.isFile?.() !== true) return null
    if (typeof stats.size === 'number' && stats.size > MAX_KEY_BYTES) return null
    return await handle.readFile()
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function endSftp(sftp: SftpSession): void {
  try {
    sftp.end()
  } catch {
    /* the session may already be gone */
  }
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

export function toSshError(error: unknown, host: string, port: number): RemoteGoError {
  if (!error) return errors.internal('unknown ssh error')
  if (error instanceof RemoteGoError) return error
  // A thrown value is `unknown`: the `as` restates the two fields an ssh2/node transport
  // error carries, and the `??` fallbacks keep a thrown string working.
  const message = String((error as { message?: unknown }).message ?? error)
  const code = String((error as { code?: unknown }).code ?? '')
  if (/host key|hostkey|verification/i.test(message)) {
    return errors.network({
      zh: `主机密钥校验未通过（${host}:${port}）。`,
      en: `Host key verification failed for ${host}:${port}.`,
    })
  }
  if (/authentication|All configured authentication methods failed|Permission denied/i.test(message)) {
    return errors.auth()
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timed out|timeout|Cannot connect|connect failed/i.test(
      `${code} ${message}`,
    )
  ) {
    return errors.network()
  }
  return errors.network({
    zh: `SSH 连接失败：${headTail(message, 300)}`,
    en: `SSH connection failed: ${headTail(message, 300)}`,
  })
}

function isHostKeyError(error: unknown): boolean {
  // Same narrowing as `toSshError`: a thrown value is `unknown`, and only its `code` is read.
  const code = (error as { code?: unknown } | null)?.code
  return code === 'host-key-changed' || code === 'host-key-unknown'
}

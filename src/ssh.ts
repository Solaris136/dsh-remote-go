/** The ssh2 adapter for `SshPort`, the only class here that talks to `vendor/ssh2.bundle.cjs`; its name and constructor
 * are frozen (four integration suites build it directly). It owns auth fallback, the host-key decision, the handshake
 * lifecycle, `exec`/`forwardOut`/`dispose`; SFTP and failure classification live in the two sibling modules. */
import { EventEmitter } from 'node:events'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import ssh2 from '../vendor/ssh2.bundle.cjs'
import type { Client as Ssh2Client, ClientChannel, SftpSession } from '../vendor/ssh2.bundle.cjs'
import { errors } from './errors.js'
import { fingerprintFromBlob } from './known-hosts.js'
import { classifySshFailure, closedError, isHostKeyError } from './ssh-failures.js'
import {
  DEFAULT_EXEC_MAX_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  type ConnectInfo,
  type SftpDownloadOptions,
  type SshConnectOptions,
  type SshExecOptions,
  type SshExecResult,
  type SshHostKeyPolicy,
  type SshPort,
  type SshRemoteFileInfo,
  type SshTreeDownloadResult,
} from './ssh-port.js'
import { endSftp, inspectSftpPath, openSftpSession, saveSftpFile, saveSftpTree } from './ssh-sftp.js'
import { expandHome } from './util.js'

const { Client } = ssh2

/** The adapter's own options: the port's connect options plus the one seam unit tests need (`clientFactory`). */
export type Ssh2PortOptions = SshConnectOptions & { clientFactory?: () => Ssh2Client }
/** The options object after the constructor applied its defaults. */
interface SshResolvedOptions extends SshConnectOptions {
  port: number
  hostKeyPolicy: SshHostKeyPolicy
  pinnedFingerprint: string | null
  knownHostFingerprints: string[]
  readyTimeoutMs: number
  keepaliveIntervalMs: number
  home: string
  identityFiles: string[]
}

/** One auth attempt handed to `connectOnce`: a key blob or a one-time password. */
export type SshAuthCandidate = { privateKey: Buffer } | { password: string; tryKeyboard: true }

/** Settle a promise at most once (later calls are ignored), so callers need no flag. */
function oneShot<T>(resolve: (value: T) => void, reject: (error: unknown) => void, cleanup?: () => void) {
  let settled = false
  return (error: unknown, value?: T) => {
    if (settled) return
    settled = true
    cleanup?.()
    // The settled-once contract passes exactly one of error/value, so the success branch carries it.
    error ? reject(error) : resolve(value as T)
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

/** The ssh2 implementation of `SshPort`: every failure is a `RemoteGoError`, and the download members are declared. */
export class SshConnection extends EventEmitter implements SshPort {
  declare options: SshResolvedOptions
  client: Ssh2Client | null = null
  fingerprint: string | null = null
  keyType: string | null = null
  closed = false
  disposed = false
  hostKeyDecision: Promise<boolean> | null = null
  clientFactory: () => Ssh2Client = () => new Client()

  constructor(options: Ssh2PortOptions) {
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
    // ssh2 emits `error` on every failed auth attempt and while tearing down; unhandled, it would kill the Host.
    this.on('error', () => {})
    if (typeof options.clientFactory === 'function') this.clientFactory = options.clientFactory
  }

  get connected(): boolean {
    return this.client !== null && !this.closed
  }

  async connect(): Promise<ConnectInfo> {
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
        this.client?.on('error', (error: Error) => this.emit('error', error))
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

  connectOnce(authConfig: SshAuthCandidate): Promise<ConnectInfo> {
    return new Promise((resolve, reject) => {
      const settle = oneShot(resolve, reject)
      const client = this.clientFactory()
      const endpoint = { host: this.options.host, port: this.options.port }
      this.client = client
      // A rejected candidate was torn down by `cleanupClient()`, marking this closed; the new attempt owns a fresh
      // client, so the flag must clear or a working fallback would report "not open".
      this.closed = false
      // An attempt that already failed tears itself down (error+close in one tick): without this flag that close
      // would look like a dropped link, and a first connection that never started would be retried as one.
      let attemptFailed = false
      // Attach the close handling *before* dialling: a transport that dies during the handshake (while a host-key
      // prompt is open) must reject the connect promise, and `this.client !== client` filters a superseded attempt,
      // whose teardown is not a lost link.
      client.once('close', () => {
        if (attemptFailed || this.client !== client) return
        this.closed = true
        // Emit before rejecting: connect-pipeline's watchers rely on the event for a parked prompt.
        this.emit('close')
        settle(classifySshFailure(new Error('the connection closed during the SSH handshake'), endpoint))
      })
      client.once('ready', () => {
        const info: ConnectInfo = { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '' }
        this.emit('ready', info)
        settle(null, info)
      })
      // Settle on the first error and swallow any later teardown errors.
      client.on('error', (error: Error) => {
        attemptFailed = true
        settle(classifySshFailure(error, endpoint))
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
            .then(verify)
            .catch(() => verify(false))
        },
      }
      try {
        client.connect(config)
      } catch (error) {
        attemptFailed = true
        settle(classifySshFailure(error, endpoint))
      }
    })
  }

  /** The five-level host-key decision: pin → known_hosts → acceptUnknown → a decision in flight → policy (strict or
   * ask) → refuse. Emits `hostkey-*` as it goes.
   * @internal exercised directly by `test/unit/ssh.test.js`; not part of `SshPort`. */
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
    // A strict policy, or no UI attached (tests/automation): refuse rather than silently trust.
    if (this.options.hostKeyPolicy === 'strict' || typeof this.options.onHostKey !== 'function') {
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

  /** The candidate list: a password when one is set, otherwise key files only — deliberately no agent candidate. The
   * configured path wins; the conventional names follow, so a host added with the default key path still connects.
   * @internal exercised directly by `test/unit/ssh.test.js`; not part of `SshPort`. */
  async resolveAuthCandidates(): Promise<SshAuthCandidate[]> {
    const auth = this.options.auth ?? { type: 'key' }
    if (auth.type === 'password') return auth.password ? [{ password: auth.password, tryKeyboard: true }] : []
    const sshDir = path.join(this.options.home, '.ssh')
    const keyPaths = [
      ...(auth.keyPath ? [expandHome(auth.keyPath, this.options.home)] : []),
      ...(this.options.identityFiles ?? []),
      path.join(sshDir, 'id_ed25519'),
      path.join(sshDir, 'id_rsa'),
      path.join(sshDir, 'id_ecdsa'),
    ]
    const out: SshAuthCandidate[] = []
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_EXEC_MAX_BYTES
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(closedError())
        return
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      const result: SshExecResult = { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
      const finish = oneShot(resolve, reject, () => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
      })
      const onAbort = () => finish(new Error('aborted'))
      options.signal?.addEventListener?.('abort', onAbort, { once: true })
      // `maxBytes` truncation is silent by contract: no error, no flag, the excess is dropped.
      const collect = (target: 'stdout' | 'stderr', text: string, listener?: (text: string) => void) => {
        if (result[target].length >= maxBytes) return
        result[target] += text
        try {
          listener?.(text)
        } catch {
          // swallow-ok: stream listeners must not break the command
        }
      }
      this.client.exec(command, { env: options.env }, (error, stream) => {
        if (error) {
          finish(error)
          return
        }
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            // A deadline is a result, not a rejection: `timedOut` is the caller's signal and the result contract
            // must not gain a throw path.
            result.timedOut = true
            stream.destroy()
          }, timeoutMs)
        }
        // Optional stdin (file uploads): the command reads it, so a secret never reaches the remote command line.
        if (options.stdin !== undefined) {
          try {
            stream.end(String(options.stdin))
          } catch (writeError) {
            finish(writeError)
            return
          }
        }
        stream.on('data', (data: Buffer) => collect('stdout', data.toString('utf8'), options.onStdout))
        stream.stderr.on('data', (data: Buffer) => collect('stderr', data.toString('utf8'), options.onStderr))
        stream.on('close', (code: number | null, signal: string | null) => {
          result.code = code ?? null
          result.signal = signal ?? null
          finish(null, result)
        })
        stream.on('error', (streamError: Error) => finish(streamError))
      })
    })
  }

  /** Open one SFTP session on this connection (the capability behind the download members). */
  openSftp(): Promise<SftpSession> {
    if (!this.client || this.closed) return Promise.reject(closedError())
    return openSftpSession(this.client)
  }

  /** Run one download step on a fresh SFTP session and close it in `finally`: the three downloads share this. */
  private async withSftp<T>(run: (sftp: SftpSession) => Promise<T>): Promise<T> {
    const sftp = await this.openSftp()
    try {
      return await run(sftp)
    } finally {
      endSftp(sftp)
    }
  }

  /** Stream one remote file into a local path; the session is closed in `finally`. */
  saveRemoteFile(remotePath: string, localPath: string, options: SftpDownloadOptions = {}): Promise<{ size: number }> {
    return this.withSftp((sftp) => saveSftpFile(sftp, remotePath, localPath, options))
  }

  /** Inspect one remote path without reading it. */
  inspectRemotePath(remotePath: string): Promise<SshRemoteFileInfo> {
    return this.withSftp((sftp) => inspectSftpPath(sftp, remotePath))
  }

  /** Copy a remote directory to a local directory; see `saveSftpTree` for the exact contract. */
  saveRemoteTree(
    remotePath: string,
    targetRoot: string,
    options: SftpDownloadOptions = {},
  ): Promise<SshTreeDownloadResult> {
    return this.withSftp((sftp) => saveSftpTree(sftp, remotePath, targetRoot, options))
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
    // The remote never acknowledges, so bound the wait for our own transport to close.
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
    if (!client) return
    try {
      // Keep an error sink attached: ssh2 may still emit during teardown.
      client.on('error', () => {})
      client.end()
    } catch {
      // swallow-ok: an error handler is installed above and end() must not throw
    }
  }
}

/** The production `SshFactory`: one ssh2 adapter per dial attempt, keeping the `(options) => SshPort` signature
 * `ctx.deps.sshFactory` expects, so tests can override the injected client without touching the assembly. */
export function createSsh2Port(options: Ssh2PortOptions): SshPort {
  return new SshConnection(options)
}

/** A private key is a few kilobytes; anything larger is not one and must not be read. */
const MAX_KEY_BYTES = 1024 * 1024

async function readKey(keyPath: string): Promise<Buffer | null> {
  let handle: FileHandle | null = null
  try {
    // Measure and read through the *same* handle: a stat-then-read is a race, and a non-regular file has no place here.
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

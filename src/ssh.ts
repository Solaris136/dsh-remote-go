/**
 * The ssh2 adapter for `SshPort` (design-ssh §4).
 *
 * `SshConnection` is the only class in `src/` that talks to `vendor/ssh2.bundle.cjs`; every other
 * module depends on `src/ssh-port.ts`. The class name and its constructor are frozen until P7
 * because four integration suites construct it directly against a real (simulated) SSH server.
 *
 * What lives here is the transport itself: auth-candidate fallback, the five-step host-key
 * decision, the handshake lifecycle (including "emit `close` before rejecting during a
 * handshake"), `exec`, `forwardOut` and `dispose`. Two concerns moved out without changing a call
 * site: the SFTP capability (`ssh-sftp.ts`) and the failure classification (`ssh-failures.ts`).
 */
import { EventEmitter } from 'node:events'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import ssh2 from '../vendor/ssh2.bundle.cjs'
import type { Client as Ssh2Client, ClientChannel, ConnectConfig, SftpSession } from '../vendor/ssh2.bundle.cjs'
import { errors } from './errors.js'
import { fingerprintFromBlob } from './known-hosts.js'
import { classifySshFailure, closedError, isHostKeyError } from './ssh-failures.js'
import {
  DEFAULT_EXEC_MAX_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  type ConnectInfo,
  type HostKeyInfo,
  type SftpDownloadOptions,
  type SshAuthOptions,
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

// The historical public surface of this module, kept for the callers and tests that have always
// imported it here: the single implementation is in `ssh-failures.ts`, shared with the test double.
export { toSshError } from './ssh-failures.js'

/**
 * The adapter's own options: the port's connect options plus the one seam unit tests need.
 * `clientFactory` is internal — production never sets it; tests hand in a scripted ssh2 client.
 */
export interface Ssh2PortOptions extends SshConnectOptions {
  clientFactory?: () => Ssh2Client
}

/** The options object after the constructor applied its defaults. */
interface SshResolvedOptions {
  host: string
  port: number
  hostKeyPolicy: SshHostKeyPolicy
  pinnedFingerprint: string | null
  knownHostFingerprints: string[]
  readyTimeoutMs: number
  keepaliveIntervalMs: number
  home: string
  username?: string | null
  auth?: SshAuthOptions
  sock?: ConnectConfig['sock']
  acceptUnknownHostKey?: boolean
  onHostKey?: (info: HostKeyInfo) => boolean | Promise<boolean>
  identityFiles: string[]
}

/** One auth attempt handed to `connectOnce`: a key blob or a one-time password. */
export type SshAuthCandidate = { privateKey: Buffer } | { password: string; tryKeyboard: true }

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

/**
 * The ssh2 implementation of `SshPort`.
 *
 * Every failure it produces is a `RemoteGoError` (through `classifySshFailure` / `closedError`),
 * and the SFTP capabilities are declared, so `typeof port.saveRemoteFile === 'function'` is how a
 * caller tells them from a transport that cannot download.
 */
export class SshConnection extends EventEmitter implements SshPort {
  declare options: SshResolvedOptions
  declare client: Ssh2Client | null
  declare fingerprint: string | null
  declare keyType: string | null
  declare closed: boolean
  declare disposed: boolean
  declare hostKeyDecision: Promise<boolean> | null
  declare clientFactory: () => Ssh2Client

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

  connectOnce(authConfig: SshAuthCandidate): Promise<ConnectInfo> {
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
        // Decision D3: emit before rejecting. `connect-pipeline`'s two watchers rely on the
        // event arriving for a handshake that died while a host-key prompt was parked.
        this.emit('close')
        settle(
          classifySshFailure(new Error('the connection closed during the SSH handshake'), {
            host: this.options.host,
            port: this.options.port,
          }),
        )
      })
      client.once('ready', () => {
        const info: ConnectInfo = { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '' }
        this.emit('ready', info)
        settle(null, info)
      })
      // Permanent listener: settle the promise on the first error, swallow any
      // later teardown errors (they are already reflected in the rejection).
      client.on('error', (error: Error) => {
        attemptFailed = true
        settle(classifySshFailure(error, { host: this.options.host, port: this.options.port }))
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
        settle(classifySshFailure(error, { host: this.options.host, port: this.options.port }))
      }
    })
  }

  /**
   * The five-level host-key decision: pin → known_hosts → acceptUnknown → a decision already in
   * flight → policy (ask) → refuse. Emits `hostkey-*` as it goes.
   * @internal exercised directly by `test/unit/ssh.test.js`; not part of `SshPort`.
   */
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

  /**
   * The candidate list: a password when one is set, otherwise key files only. There is
   * deliberately no agent candidate (``~/.ssh/id_{ed25519,rsa,ecdsa}`` is the fallback chain).
   * @internal exercised directly by `test/unit/ssh.test.js`; not part of `SshPort`.
   */
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_EXEC_MAX_BYTES
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
            // A deadline is a result, not a rejection: `timedOut` is the caller's signal, and
            // the existing `{code,signal,stdout,stderr}` contract must not gain a throw path.
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
          // `maxBytes` truncation is silent by contract: no error, no flag, the excess is dropped.
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

  /** Open one SFTP session on this connection (the capability behind the download members). */
  openSftp(): Promise<SftpSession> {
    if (!this.client || this.closed) return Promise.reject(closedError())
    return openSftpSession(this.client)
  }

  /** Stream one remote file into a local path; the session is closed in `finally`. */
  async saveRemoteFile(
    remotePath: string,
    localPath: string,
    options: SftpDownloadOptions = {},
  ): Promise<{ size: number }> {
    const sftp = await this.openSftp()
    try {
      return await saveSftpFile(sftp, remotePath, localPath, options)
    } finally {
      endSftp(sftp)
    }
  }

  /** Inspect one remote path without reading it. */
  async inspectRemotePath(remotePath: string): Promise<SshRemoteFileInfo> {
    const sftp = await this.openSftp()
    try {
      return await inspectSftpPath(sftp, remotePath)
    } finally {
      endSftp(sftp)
    }
  }

  /** Copy a remote directory to a local directory; see `saveSftpTree` for the exact contract. */
  async saveRemoteTree(
    remotePath: string,
    targetRoot: string,
    options: SftpDownloadOptions = {},
  ): Promise<SshTreeDownloadResult> {
    const sftp = await this.openSftp()
    try {
      return await saveSftpTree(sftp, remotePath, targetRoot, options)
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

/**
 * The production `SshFactory`: one ssh2 adapter per dial attempt.
 *
 * `ctx.deps.sshFactory` keeps its `(options) => SshPort` signature (decision D4); the default
 * implementation moved from `new SshConnection(...)` to this factory so tests can override the
 * injected client without touching the assembly.
 * @param options - the port's connect options (plus the adapter's `@internal` client seam).
 */
export function createSsh2Port(options: Ssh2PortOptions): SshPort {
  return new SshConnection(options)
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

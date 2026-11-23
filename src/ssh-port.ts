/** The SSH port: the only shape an adapter has to satisfy, so nothing here depends on ssh2, disk, network or logs. An
 * absent SFTP member means "this transport has no such capability" — not an error, and never a rejection here. */
import type { Duplex } from 'node:stream'

/** `exec`'s default deadline; `timeoutMs <= 0` disables the timer. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000
/** `exec`'s default capture cap, applied to stdout and stderr separately. */
export const DEFAULT_EXEC_MAX_BYTES = 2 * 1024 * 1024

/** How one failure was classified; an adapter that already knows the kind skips the message/code heuristics. */
export type SshFailureKind = 'auth' | 'hostkey' | 'transport' | 'closed' | 'timeout'
/** `first-use` asks (`onHostKey`) or refuses when nobody listens; `strict` accepts a pinned/known fingerprint only. */
export type SshHostKeyPolicy = 'first-use' | 'strict'
/** The auth choice a host entry carries. */
export interface SshAuthOptions {
  type: 'key' | 'password'
  /** Already `~`-expanded private key path (`connect-pipeline` expands it against `userHome()`). */
  keyPath?: string | null
  /** One-time or saved password; never written to disk by the transport layer, never logged. */
  password?: string | null
}

/** The host key a confirmation is about; the key material itself never travels. */
export type HostKeyInfo = { sha256: string; keyType: string; pinned: boolean }
/** What a completed handshake reports: `serverBanner` is ssh2's greeting, diagnostic only, `null` when absent. */
export type ConnectInfo = { fingerprint: string; keyType: string; serverBanner?: string | null }
/** Everything an adapter needs to dial one endpoint: port 22, the OS home and the adapter's timeouts are defaults. A
 * jump-host dial is this shape with `sock` set — the caller dials the jump host, then forwards the target port. */
export interface SshConnectOptions {
  host: string
  port?: number
  username?: string | null
  home?: string
  auth?: SshAuthOptions
  /** `~/.ssh/config` IdentityFile list, tried in order after `auth.keyPath`. */
  identityFiles?: string[]
  hostKeyPolicy?: SshHostKeyPolicy
  pinnedFingerprint?: string | null
  /** Fingerprints known_hosts has for this endpoint; any match is accepted. */
  knownHostFingerprints?: string[]
  /** Automation only: accept an unknown key without asking. */
  acceptUnknownHostKey?: boolean
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  /** Unanswered keepalives before the adapter declares the transport dead; the adapter default rides out a stall. */
  keepaliveCountMax?: number
  /** First-use confirmation; returning `true` continues the handshake. */
  onHostKey?: (info: HostKeyInfo) => boolean | Promise<boolean>
  sock?: Duplex
}

/** Per-command knobs; every caller may omit them, and a secret goes through `stdin`, never the command line. */
export interface SshExecOptions {
  /** Default {@link DEFAULT_EXEC_TIMEOUT_MS}; `<= 0` means no deadline. */
  timeoutMs?: number
  /** Default {@link DEFAULT_EXEC_MAX_BYTES}, per stream; truncation is silent — no error, no flag. */
  maxBytes?: number
  env?: Record<string, string>
  stdin?: string
  /** Aborting rejects with an `Error('aborted')` (the caller decides what that means). */
  signal?: AbortSignal
  /** Streaming consumers; a throwing listener must not abort the command. */
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
}

/** What one `exec` resolves with: captured output, the exit status and whether the deadline fired. */
export interface SshExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** The command was force-finished by `timeoutMs`; this is a result, not an exception. */
  timedOut: boolean
}

/** One progress frame shared by the single-file and tree transfers. */
export type TransferProgress = { doneBytes: number; totalBytes: number; doneFiles: number; totalFiles: number }
/** The tree transfer's inventory: sizes rolled up before the first byte is copied. */
export type TransferInventory = { totalBytes: number; totalFiles: number }
/** The callback bag both SFTP downloads accept; every callback is advisory (a throw must not abort a transfer).
 * `caseInsensitive` defaults to the local platform, `ignoreWindowsNames` to Windows only. */
export interface SftpDownloadOptions {
  onProgress?: (info: TransferProgress) => void
  onInventory?: (info: TransferInventory) => void
  onIgnored?: (names: string[]) => void
  isCancelled?: () => boolean
  caseInsensitive?: boolean
  ignoreWindowsNames?: boolean
}

/** What a read-only inspection of one remote path reports. */
export type SshRemoteFileInfo = { isFile: boolean; isDirectory: boolean; size: number; mtime: number }
/** A read-one-remote-file result: the bytes (or text) and the size the adapter read. */
export type RemoteFileData = { data?: Buffer | string; size?: number }
/** What a tree download reports: where it landed, what it moved, and what it skipped. */
export interface SshTreeDownloadResult {
  destination: string
  totalBytes: number
  totalFiles: number
  renamedFiles?: number
  ignoredNames?: string[]
  cancelled?: boolean
}

/** The events an adapter emits: a side channel, not control flow (`connect()`'s Promise is "the link is up", `close` is
 * "it is gone"). `error` carries the raw `Error` and throws with no listener, so every adapter MUST attach one. */
export interface SshPortEvents {
  /** The handshake completed; emitted with the same info `connect()` resolves with. */
  ready: [info: ConnectInfo]
  error: [error: Error]
  /** The link closed. During a handshake the adapter emits it **before** rejecting `connect()`. */
  close: []
  'hostkey-pending': [info: HostKeyInfo]
  'hostkey-accepted': [info: HostKeyInfo]
  'hostkey-rejected': [info: HostKeyInfo]
}

/** The transport surface the host half drives: `connect()`/`exec()`/`forwardOut()` reject with a `RemoteGoError` (or
 * the underlying `Error` for abort/stream failures); optional capabilities are feature-detected, never re-wrapped. */
export interface SshPort {
  /** The link is established and not closed. Never a promise about the next call succeeding. */
  readonly connected: boolean

  /** Dial one endpoint. Resolves when the handshake is complete and the host key is settled. */
  connect(): Promise<ConnectInfo>

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult>

  /** Dial one TCP destination from the remote side; `srcPort` only shapes what the remote sees. */
  forwardOut(destHost: string, destPort: number, srcHost?: string, srcPort?: number): Promise<Duplex>

  /** Idempotent release; it does not wait for the remote, only bounds its own transport close. */
  dispose(): Promise<void>

  // Optional capabilities: absent means "this adapter cannot download".
  openSftp?(): Promise<unknown>
  saveRemoteFile?(remotePath: string, localPath: string, options?: SftpDownloadOptions): Promise<{ size: number }>
  saveRemoteTree?(remotePath: string, targetRoot: string, options?: SftpDownloadOptions): Promise<SshTreeDownloadResult>
  inspectRemotePath?(remotePath: string): Promise<SshRemoteFileInfo>
  /** No adapter implements it today, but call sites feature-detect it; see `remote-web/resolve.ts`. */
  readRemoteFile?(remotePath: string, options?: { maxBytes?: number }): Promise<RemoteFileData>

  // The EventEmitter shape (structural, so an adapter does not have to extend EventEmitter).
  on<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
  once<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
  off<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
  emit<E extends keyof SshPortEvents>(event: E, ...args: SshPortEvents[E]): boolean
  removeListener<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
}

/** How the service obtains a transport: one factory call per dial attempt. */
export type SshFactory = (options: SshConnectOptions) => SshPort

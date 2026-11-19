/**
 * The SSH port: what the host half is allowed to ask of a transport, and the only shape an
 * adapter has to satisfy (design-ssh §3, decision D1).
 *
 * `src/ssh.ts` is the ssh2 adapter (`SshConnection` + `createSsh2Port`); the test double
 * `test/helpers/fake-ssh-port.js` implements the same surface, so a second transport never has to
 * be the ssh2 one. Nothing here depends on ssh2, and nothing here touches disk, network or logs.
 *
 * The SFTP members are optional on purpose: an adapter that cannot download simply does not
 * declare them, and `local-download.ts` / `remote-files.ts` keep feature-detecting them
 * (`typeof port.saveRemoteFile === 'function'`). Absence means "this transport has no such
 * capability" — it is not an error and must not be turned into a rejection on the port.
 *
 * Two `exec` rules are contract, not implementation detail:
 *   - a timeout is a **result field** (`timedOut: true`) and never a rejection;
 *   - `maxBytes` truncation is silent: no error, no flag, the excess is dropped.
 */
import type { Duplex } from 'node:stream'

/** `exec`'s default deadline; `timeoutMs <= 0` disables the timer. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000

/** `exec`'s default capture cap, applied to stdout and stderr separately. */
export const DEFAULT_EXEC_MAX_BYTES = 2 * 1024 * 1024

/**
 * How one failure was classified.
 *
 * An adapter passes the kind it already knows (a host-key rejection is a policy decision, not a
 * network blip); `classifySshFailure` falls back to its message/code rules when it does not.
 */
export type SshFailureKind = 'auth' | 'hostkey' | 'transport' | 'closed' | 'timeout'

/**
 * The two host-key policies. `first-use` asks (`onHostKey`) or refuses when nobody is listening;
 * `strict` only accepts a pinned/known fingerprint.
 */
export type SshHostKeyPolicy = 'first-use' | 'strict'

/** The auth choice a host entry carries; `agent` is gone from the product, key files replaced it. */
export interface SshAuthOptions {
  type: 'key' | 'password'
  /** Already `~`-expanded private key path (`connect-pipeline` expands it against `userHome()`). */
  keyPath?: string | null
  /** One-time or saved password; never written to disk by the transport layer, never logged. */
  password?: string | null
}

/** The host key a confirmation is about; the key material itself never travels. */
export interface HostKeyInfo {
  sha256: string
  keyType: string
  /** Whether `sha256` is the fingerprint the host entry pins. */
  pinned: boolean
}

/** What a completed handshake reports: the observed key plus the server's banner, when it sent one. */
export interface ConnectInfo {
  fingerprint: string
  keyType: string
  /** ssh2's `banner` (the server greeting); diagnostic only, `null` when there is none. */
  serverBanner?: string | null
}

/**
 * Everything an adapter needs to dial one endpoint.
 *
 * The jump-host case is the same shape with `sock` set: the caller first dials the jump host and
 * forwards the target's SSH port, then hands that stream to the target's own options. The port
 * does not merge the two security contexts (each has its own policy, pin and `onHostKey`).
 */
export interface SshConnectOptions {
  host: string
  /** Default 22. */
  port?: number
  username?: string | null
  /** Base directory `~/.ssh/...` expands against; defaults to the OS home. */
  home?: string
  auth?: SshAuthOptions
  /** `~/.ssh/config` IdentityFile list, tried in order after `auth.keyPath`. */
  identityFiles?: string[]
  hostKeyPolicy?: SshHostKeyPolicy
  /** The pinned fingerprint for this endpoint, if the host entry has one. */
  pinnedFingerprint?: string | null
  /** Fingerprints known_hosts has for this endpoint; any match is accepted. */
  knownHostFingerprints?: string[]
  /** Automation only: accept an unknown key without asking. */
  acceptUnknownHostKey?: boolean
  /** Handshake deadline; the default is the adapter's own. */
  readyTimeoutMs?: number
  /** Keepalive interval; the default is the adapter's own. */
  keepaliveIntervalMs?: number
  /** First-use confirmation; returning `true` continues the handshake. */
  onHostKey?: (info: HostKeyInfo) => boolean | Promise<boolean>
  /** Jump host only: the already-forwarded stream to dial through. */
  sock?: Duplex
}

/** Per-command knobs; every caller may omit them. */
export interface SshExecOptions {
  /** Default {@link DEFAULT_EXEC_TIMEOUT_MS}; `<= 0` means no deadline. */
  timeoutMs?: number
  /** Default {@link DEFAULT_EXEC_MAX_BYTES}, per stream; the excess is dropped silently. */
  maxBytes?: number
  env?: Record<string, string>
  /** Content for the remote stdin, so a secret never appears on the remote command line. */
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
export interface TransferProgress {
  doneBytes: number
  totalBytes: number
  doneFiles: number
  totalFiles: number
}

/** The tree transfer's inventory: sizes rolled up before the first byte is copied. */
export interface TransferInventory {
  totalBytes: number
  totalFiles: number
}

/**
 * The callback bag both SFTP downloads accept. Every callback is advisory: the adapter catches a
 * consumer's exception, because a progress reporter must never abort a transfer.
 */
export interface SftpDownloadOptions {
  onProgress?: (info: TransferProgress) => void
  onInventory?: (info: TransferInventory) => void
  onIgnored?: (names: string[]) => void
  isCancelled?: () => boolean
  /** Case-insensitive local volume; defaults to the local platform (Windows/macOS). */
  caseInsensitive?: boolean
  /** Skip Windows metadata/shell names; defaults to Windows only. */
  ignoreWindowsNames?: boolean
}

/** What a read-only inspection of one remote path reports. */
export interface SshRemoteFileInfo {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtime: number
}

/** What a tree download reports: where it landed, what it moved, and what it skipped. */
export interface SshTreeDownloadResult {
  destination: string
  totalBytes: number
  totalFiles: number
  renamedFiles?: number
  ignoredNames?: string[]
  cancelled?: boolean
}

/**
 * The events an adapter emits. They are a side channel, not control flow: `connect()`'s Promise is
 * the only "the link is up" signal, and `close` is the only "it went away" signal.
 *
 * `error` carries the raw transport `Error` (not a `RemoteGoError`): the payload has always been
 * the ssh2/client error, and the one listener that reads it (the regression test that proves a
 * post-connect error cannot crash the Host) asserts its message. `classifySshFailure` is the way to
 * turn it into the client-facing error, and the adapter does that on every path it reports.
 *
 * An `error` event with no listener throws (Node's `EventEmitter` contract), so every adapter MUST
 * attach a permanent listener in its constructor (decision D5).
 */
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

/**
 * The transport surface the host half drives.
 *
 * `connect()` / `exec()` / `forwardOut()` reject with `RemoteGoError` (or, for `exec`'s abort and
 * stream failures, with the underlying `Error`); callers that need the client-facing code read
 * `classifySshFailure`'s output on the paths where the port does not produce it. A port never
 * re-wraps a `RemoteGoError` it already threw.
 */
export interface SshPort {
  /** The link is established and not closed. Never a promise about the next call succeeding. */
  readonly connected: boolean

  /** Dial one endpoint. Resolves when the handshake is complete and the host key is settled. */
  connect(): Promise<ConnectInfo>

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult>

  /** Dial one TCP destination from the remote side; `srcPort` only shapes what the remote sees. */
  forwardOut(destHost: string, destPort: number, srcHost?: string, srcPort?: number): Promise<Duplex>

  /**
   * Idempotent release. It does not wait for the remote to acknowledge; the adapter bounds the
   * wait for its own transport to close.
   */
  dispose(): Promise<void>

  // Optional capabilities: absent means "this adapter cannot download".
  openSftp?(): Promise<unknown>
  saveRemoteFile?(remotePath: string, localPath: string, options?: SftpDownloadOptions): Promise<{ size: number }>
  saveRemoteTree?(remotePath: string, targetRoot: string, options?: SftpDownloadOptions): Promise<SshTreeDownloadResult>
  inspectRemotePath?(remotePath: string): Promise<SshRemoteFileInfo>
  /**
   * A read-one-remote-file capability. No adapter implements it today, and every call site
   * feature-detects it (`typeof port.readRemoteFile === 'function'`), so it stays declared instead
   * of forcing that branch to be deleted: `remote-web/resolve.ts` keeps its "read the loaded
   * package.json over SFTP" probe ready for an adapter that grows the capability.
   */
  readRemoteFile?(
    remotePath: string,
    options?: { maxBytes?: number },
  ): Promise<{ data?: Buffer | string; size?: number }>

  // The EventEmitter shape (structural, so an adapter does not have to extend EventEmitter).
  on<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
  once<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
  off<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
  emit<E extends keyof SshPortEvents>(event: E, ...args: SshPortEvents[E]): boolean
  removeListener<E extends keyof SshPortEvents>(event: E, listener: (...args: SshPortEvents[E]) => void): this
}

/**
 * How the service obtains a transport: one factory call per dial attempt.
 *
 * The shape is frozen (decision D4): tests inject their own implementation through
 * `ServiceOptions.sshFactory`, and the production default is `createSsh2Port`.
 */
export type SshFactory = (options: SshConnectOptions) => SshPort

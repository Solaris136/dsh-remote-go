/**
 * Thin promise wrapper over `ssh2` that carries everything the plugin needs:
 * host-key policy/confirmation, auth-method fallback, one-shot `exec` with
 * streamed output, and TCP forwarding for the loopback tunnel.
 */
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import ssh2 from '../vendor/ssh2.bundle.cjs'
import { fingerprintFromBlob } from './known-hosts.js'
import { expandHome, headTail, isLoopbackHost } from './util.js'
import { errors, RemoteGoError } from './errors.js'

const { Client } = ssh2

/** Windows OpenSSH agent pipe; POSIX uses SSH_AUTH_SOCK. */
export const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** @param {Buffer | Uint8Array} blob */
export function parseSshKeyType(blob) {
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
 * @typedef {{
 *   host: string,
 *   port?: number,
 *   username?: string | null,
 *   auth?: { type: 'agent' | 'key' | 'password', keyPath?: string | null, password?: string | null, passphrase?: string | null },
 *   identityFiles?: string[],
 *   hostKeyPolicy?: 'first-use' | 'strict',
 *   pinnedFingerprint?: string | null,
 *   knownHostFingerprints?: string[],
 *   sock?: import('node:stream').Duplex,
 *   onHostKey?: (info: { sha256: string, keyType: string, pinned: boolean }) => Promise<boolean>,
 *   acceptUnknownHostKey?: boolean,
 *   readyTimeoutMs?: number,
 *   keepaliveIntervalMs?: number,
 *   home?: string,
 * }} SshConnectOptions
 */

export class SshConnection extends EventEmitter {
  /**
   * @param {SshConnectOptions} options
   */
  constructor(options) {
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
    /** @type {string | null} */
    this.fingerprint = null
    /** @type {string | null} */
    this.keyType = null
    this.closed = false
    this.disposed = false
    /** @type {Promise<boolean> | null} */
    this.hostKeyDecision = null
    /** @type {{ sha256: string, keyType: string, pinned: boolean } | null} */
    this.hostKeyInfo = null
    this.execSeq = 0
  }

  get connected() {
    return this.client !== null && !this.closed
  }

  /**
   * Connect with auth-method fallback. Resolves once the transport is ready.
   * @returns {Promise<{ fingerprint: string, keyType: string, serverBanner: string | null }>}
   */
  async connect() {
    if (this.connected) return { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '', serverBanner: null }
    const candidates = await this.resolveAuthCandidates()
    if (candidates.length === 0) {
      throw errors.invalidInput('auth', {
        zh: '没有可用的 SSH 认证方式：请选择 SSH Agent、可读的密钥文件，或输入一次密码。',
        en: 'No usable SSH authentication: pick the agent, a readable key file, or enter a one-time password.',
      })
    }
    /** @type {unknown} */
    let lastError = null
    for (const candidate of candidates) {
      try {
        const info = await this.connectOnce(candidate)
        this.client?.on('close', () => {
          this.closed = true
          this.emit('close')
        })
        this.client?.on('error', (error) => {
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

  /**
   * @param {Record<string, unknown>} authConfig
   * @returns {Promise<{ fingerprint: string, keyType: string, serverBanner: string | null }>}
   */
  connectOnce(authConfig) {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (/** @type {Error | null} */ error, /** @type {any} */ value) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve(value)
      }
      const client = new Client()
      this.client = client
      /** @type {string | null} */
      let serverBanner = null
      client.on('banner', (message) => {
        serverBanner = String(message).trim()
      })
      client.once('ready', () => {
        settle(null, { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '', serverBanner })
      })
      client.once('error', (error) => {
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
        hostVerifier: (/** @type {Buffer} */ keyBlob, /** @type {any} */ verify) => {
          this.verifyHostKey(keyBlob)
            .then((accepted) => verify(accepted))
            .catch(() => verify(false))
        },
      }
      try {
        client.connect(config)
      } catch (error) {
        settle(toSshError(error, this.options.host, this.options.port))
      }
    })
  }

  /**
   * Host-key policy (§9.1): pin comparison, then user confirmation for first
   * use, then strict rejection when no pin exists.
   * @param {Buffer} keyBlob
   * @returns {Promise<boolean>}
   */
  async verifyHostKey(keyBlob) {
    const sha256 = fingerprintFromBlob(keyBlob)
    const keyType = parseSshKeyType(keyBlob)
    this.fingerprint = sha256
    this.keyType = keyType
    const pinned = this.options.pinnedFingerprint
    const known = this.options.knownHostFingerprints ?? []
    const info = { sha256, keyType, pinned: Boolean(pinned && pinned === sha256) }
    this.hostKeyInfo = info
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
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async resolveAuthCandidates() {
    const auth = this.options.auth ?? { type: 'agent' }
    /** @type {Record<string, unknown>[]} */
    const out = []
    if (auth.type === 'password') {
      if (auth.password) out.push({ password: auth.password, tryKeyboard: true })
      return out
    }
    if (auth.type === 'key') {
      const keyPath = auth.keyPath ? expandHome(auth.keyPath, this.options.home) : null
      if (keyPath) {
        const privateKey = await readKey(keyPath)
        if (privateKey) out.push({ privateKey, passphrase: auth.passphrase ?? undefined })
      }
      return out
    }
    // agent / auto
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? WINDOWS_AGENT_PIPE : null)
    if (agent) out.push({ agent })
    const keyPaths = [
      ...(this.options.identityFiles ?? []),
      path.join(this.options.home, '.ssh', 'id_ed25519'),
      path.join(this.options.home, '.ssh', 'id_rsa'),
      path.join(this.options.home, '.ssh', 'id_ecdsa'),
    ]
    const seen = new Set()
    for (const keyPath of keyPaths) {
      if (!keyPath || seen.has(keyPath)) continue
      seen.add(keyPath)
      const privateKey = await readKey(keyPath)
      if (privateKey) out.push({ privateKey, passphrase: auth.passphrase ?? undefined })
    }
    return out
  }

  /**
   * Run one command. Output is collected and streamed to the callbacks.
   * @param {string} command
   * @param {{ timeoutMs?: number, env?: Record<string, string>, maxBytes?: number, onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void, signal?: AbortSignal }} [options]
   * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean }>}
   */
  exec(command, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(new Error('SSH connection is not open'))
        return
      }
      let settled = false
      let timedOut = false
      /** @type {NodeJS.Timeout | null} */
      let timer = null
      const chunks = { stdout: '', stderr: '' }
      const finish = (/** @type {any} */ error, /** @type {any} */ value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
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
        stream.on('data', (/** @type {Buffer} */ data) => {
          const text = data.toString('utf8')
          if (chunks.stdout.length < maxBytes) {
            chunks.stdout += text
            options.onStdout?.(text)
          }
        })
        stream.stderr.on('data', (/** @type {Buffer} */ data) => {
          const text = data.toString('utf8')
          if (chunks.stderr.length < maxBytes) {
            chunks.stderr += text
            options.onStderr?.(text)
          }
        })
        stream.on('close', (/** @type {number | null} */ code, /** @type {string | null} */ signal) => {
          finish(null, {
            code: code ?? null,
            signal: signal ?? null,
            stdout: chunks.stdout,
            stderr: chunks.stderr,
            timedOut,
          })
        })
        stream.on('error', (streamError) => finish(streamError))
      })
    })
  }

  /**
   * Forward one TCP connection through an SSH channel (`ssh -L` equivalent).
   * @param {string} destHost
   * @param {number} destPort
   * @param {string} [srcHost]
   * @param {number} [srcPort]
   * @returns {Promise<import('node:stream').Duplex>}
   */
  forwardOut(destHost, destPort, srcHost = '127.0.0.1', srcPort = 0) {
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(new Error('SSH connection is not open'))
        return
      }
      this.client.forwardOut(srcHost, srcPort, destHost, destPort, (error, stream) => {
        if (error) reject(error)
        else resolve(stream)
      })
    })
  }

  /** @returns {Promise<void>} */
  async dispose() {
    this.disposed = true
    const client = this.client
    this.cleanupClient()
    if (!client) return
    await new Promise((resolve) => {
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

  cleanupClient() {
    const client = this.client
    this.client = null
    this.closed = true
    if (client) {
      try {
        client.end()
      } catch {
        /* already gone */
      }
    }
  }

  /** Assert that the remote of a probe is the loopback host we expect. */
  assertLoopbackForward() {
    if (!isLoopbackHost(this.options.host)) {
      throw errors.invalidInput('host', {
        zh: '远端界面只能绑定回环地址；隧道目标必须是远端自身的 127.0.0.1。',
        en: 'The remote UI binds loopback only; the tunnel target must be the remote 127.0.0.1.',
      })
    }
  }
}

/**
 * @param {string} keyPath
 * @returns {Promise<Buffer | null>}
 */
async function readKey(keyPath) {
  try {
    if (!existsSync(keyPath)) return null
    return await readFile(keyPath)
  } catch {
    return null
  }
}

/**
 * Classify ssh2 connect errors into the plugin's user-facing taxonomy.
 * @param {any} error
 * @param {string} host
 * @param {number} port
 */
export function toSshError(error, host, port) {
  if (!error) return errors.internal('unknown ssh error')
  if (error instanceof RemoteGoError) return error
  const message = String(error.message ?? error)
  const code = String(/** @type {any} */ (error).code ?? '')
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

/** @param {unknown} error */
function isHostKeyError(error) {
  const code = /** @type {any} */ (error)?.code
  return code === 'host-key-changed' || code === 'host-key-unknown'
}

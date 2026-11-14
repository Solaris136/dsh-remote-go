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
import { expandHome, headTail } from './util.js'
import { errors, RemoteGoError } from './errors.js'

const { Client } = ssh2

/** Settle a promise at most once; later calls are ignored, so callers need no flag. */
function oneShot(resolve, reject, cleanup) {
  let settled = false
  return (error, value) => {
    if (settled) return
    settled = true
    cleanup?.()
    if (error) reject(error)
    else resolve(value)
  }
}

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

export class SshConnection extends EventEmitter {
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

  get connected() {
    return this.client !== null && !this.closed
  }

  async connect() {
    if (this.connected) return { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '' }
    const candidates = await this.resolveAuthCandidates()
    if (candidates.length === 0) {
      throw errors.invalidInput('auth', {
        zh: '没有可用的 SSH 认证方式：请选择一个可读的私钥文件（或输入一次密码）。',
        en: 'No usable SSH authentication: choose a readable private-key file (or enter a one-time password).',
      })
    }
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

  connectOnce(authConfig) {
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
      client.once('ready', () => {
        settle(null, { fingerprint: this.fingerprint ?? '', keyType: this.keyType ?? '' })
      })
      // Permanent listener: settle the promise on the first error, swallow any
      // later teardown errors (they are already reflected in the rejection).
      client.on('error', (error) => {
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

  async verifyHostKey(keyBlob) {
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

  async resolveAuthCandidates() {
    const auth = this.options.auth ?? { type: 'key' }
    const out = []
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
    const seen = new Set()
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

  exec(command, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) {
        reject(new Error('SSH connection is not open'))
        return
      }
      let timedOut = false
      let timer = null
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
        // Keep an error sink attached: ssh2 may still emit during teardown.
        client.on('error', () => {})
        client.end()
      } catch {}
    }
  }
}

async function readKey(keyPath) {
  try {
    if (!existsSync(keyPath)) return null
    return await readFile(keyPath)
  } catch {
    return null
  }
}

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

function isHostKeyError(error) {
  const code = /** @type {any} */ (error)?.code
  return code === 'host-key-changed' || code === 'host-key-unknown'
}

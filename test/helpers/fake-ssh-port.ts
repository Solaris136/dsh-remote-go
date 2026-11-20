import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import { closedError } from '../../dist/src/ssh-failures.js'
/* The test double for `SshPort` (design-ssh §7). It is a *reference implementation of the contract*, not a stub: the
 * same conformance suite runs against this class and the real ssh2 adapter, so a behaviour only one of them has is a
 * contract hole. It deliberately lacks the four optional download capabilities — like the pre-P5 fake — so
 * `local-download.ts` / `remote-files.ts` keep exercising their "unsupported" branches. Simulation knobs are
 * constructor inputs only, no extra prototype methods (which `fake-remote.test.js`'s guard checks): `connect` replaces
 * the handshake and `onConnectRequest(options)` observes the dial options; `exec` replaces one command, while
 * `output`/`outputChunks`/`hangOnExec` shape the default; `connectError` + `closeBeforeConnectReject` is a handshake
 * that dies (close first, then reject); `hostKey` emits `hostkey-pending` before the handshake completes.
 * `connected` stays writable on purpose: suites drive a live transport by assigning it; a getter would break them. */
export class FakeSshPort extends EventEmitter {
  constructor(input = {}) {
    super()
    this.connected = false
    this.disposed = false
    this.options = input.options ?? {}
    this.calls = []
    this.execImpl = input.exec
    this.connectImpl = input.connect
    this.onConnectRequest = input.onConnectRequest
    this.files = input.files ?? new Map()
    /** The single-chunk stdout of a default `exec`; `''` keeps the historical empty result. */
    this.output = input.output ?? ''
    /** Multi-chunk stdout for the `maxBytes` contract (a cap only starts/stops whole chunks). */
    this.outputChunks = input.outputChunks ?? (this.output === '' ? [] : [this.output])
    /** Resolve the default `exec` with `timedOut: true` after `timeoutMs` (never reject). */
    this.hangOnExec = input.hangOnExec === true
    /** A handshake failure to throw; with `closeBeforeConnectReject`, `close` is emitted first. */
    this.connectError = input.connectError ?? null
    this.closeBeforeConnectReject = input.closeBeforeConnectReject === true
    /** A host key to announce (`hostkey-pending`) before the handshake resolves. */
    this.hostKey = input.hostKey ?? null
    this.info = input.info ?? { fingerprint: 'SHA256:fake', keyType: 'ssh-ed25519', serverBanner: null }
    // Same safety rule as the real adapter: an adapter that can emit `error` keeps a permanent listener, so a stray
    // emit can never throw through the Host process; the double emits none, but the suite pins it for both.
    this.on('error', () => {})
  }
  async connect() {
    this.onConnectRequest?.(this.options)
    if (this.connectImpl) return this.connectImpl()
    if (this.connectError) {
      if (this.closeBeforeConnectReject) {
        this.connected = false
        // Contract: the event arrives before the rejection, so the pipeline can settle a prompt parked on it.
        this.emit('close')
      }
      throw this.connectError
    }
    if (this.hostKey) this.emit('hostkey-pending', this.hostKey)
    this.connected = true
    this.emit('ready', this.info)
    return this.info
  }
  async exec(command, options = {}) {
    this.calls.push({ command, options })
    if (!this.connected) throw closedError()
    if (this.execImpl) return this.execImpl(command, options)
    if (this.hangOnExec) {
      const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0
      if (timeoutMs > 0) await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      return { code: null, signal: null, stdout: '', stderr: '', timedOut: true }
    }
    // Mirror the adapter's capture rule: a chunk is appended whole while the capture is under `maxBytes`, never after.
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : Number.POSITIVE_INFINITY
    let stdout = ''
    for (const chunk of this.outputChunks) {
      if (stdout.length >= maxBytes) break
      stdout += chunk
      // A progress listener is advisory: its failure must not abort the command.
      try {
        options.onStdout?.(chunk)
      } catch {
        /* stdout listeners must not break the command */
      }
    }
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
  }
  async forwardOut() {
    if (!this.connected) throw closedError()
    return new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
  }
  async dispose() {
    this.disposed = true
    this.connected = false
    this.emit('close')
  }
  simulateClose() {
    this.connected = false
    this.emit('close')
  }
}

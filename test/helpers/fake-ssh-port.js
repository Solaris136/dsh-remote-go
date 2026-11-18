import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import { closedError } from '../../src/ssh-failures.js'

/**
 * The test double for `SshPort` (design-ssh §7).
 *
 * It is a *reference implementation of the contract*, not a stub: the same conformance suite
 * (`test/unit/ssh-port-contract.test.js`) runs against this class and against the real ssh2
 * adapter, so any behaviour that only one of them has is a contract hole. What it deliberately
 * does not implement is the four optional download capabilities — exactly like the pre-P5 fake,
 * so `local-download.ts` / `remote-files.ts` keep exercising their "unsupported" branches.
 *
 * Simulation knobs (all constructor inputs, no extra prototype methods, so
 * `test/unit/fake-remote.test.js`'s "the fake only stands in for real methods" guard keeps
 * passing):
 *   - `connect`: replace the handshake; `onConnectRequest(options)` observes the dial options.
 *   - `exec`: replace one command's result; otherwise `output`/`outputChunks`/`hangOnExec` shape
 *     the default command.
 *   - `connectError` + `closeBeforeConnectReject`: a handshake that dies (close first, then reject).
 *   - `hostKey`: emit `hostkey-pending` before the handshake completes.
 *
 * The class keeps `connected` a writable field on purpose: several suites drive a live transport
 * by assigning it (`ssh.connected = true`), and a getter would break them.
 */
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
    // Same safety rule as the real adapter (decision D5): an adapter that can emit `error` keeps a
    // permanent listener, so a stray emit can never throw through the Host process. The double
    // emits none today, but the conformance suite pins the rule for both implementations.
    this.on('error', () => {})
  }

  async connect() {
    this.onConnectRequest?.(this.options)
    if (this.connectImpl) return this.connectImpl()
    if (this.connectError) {
      if (this.closeBeforeConnectReject) {
        this.connected = false
        // Contract (decision D3): the event arrives before the rejection. The pipeline's watchers
        // depend on it to settle a prompt parked on a handshake that died.
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
    // Mirror the adapter's capture rule: a chunk is appended whole while the capture is still
    // under `maxBytes`, and nothing is appended once it is not. No error, no flag (contract).
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

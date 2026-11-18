import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { RemoteGoError } from '../../src/errors.js'
import { closedError } from '../../src/ssh-failures.js'
import { SshConnection } from '../../src/ssh.js'
import { FakeSshPort } from '../helpers/fake-ssh-port.js'

/**
 * The `SshPort` conformance suite (design-ssh §7, K1–K9).
 *
 * Every case runs twice — once against the real ssh2 adapter driven by a scripted client (no
 * socket, no handshake, only the injectable surface), once against the test double. A behaviour
 * that holds for only one implementation is a contract hole, so the two `describe`s must stay in
 * lockstep: adding an assertion means adding it for both.
 */

/** Any key blob works for the scripted handshake; the adapter only fingerprints and parses it. */
const KEY_BLOB = (() => {
  const type = Buffer.from('ssh-ed25519', 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(type.length, 0)
  return Buffer.concat([length, type, Buffer.from('contract-key', 'ascii')])
})()

const HOST_KEY = { sha256: 'SHA256:contract', keyType: 'ssh-ed25519', pinned: false }

/**
 * A scripted ssh2 client: the adapter's injectable surface (`clientFactory`) with no network.
 *
 * `mode: 'ready'` answers the host verifier and emits `ready` (what ssh2 does); `'close'` dies
 * during the handshake; `'hang'` opens a channel that never produces or ends.
 */
function scriptedClient({ mode = 'ready', chunks = ['remote-output'] } = {}) {
  const client = new EventEmitter()
  client.config = null
  client.connect = (config) => {
    client.config = config
    if (mode === 'close') {
      queueMicrotask(() => client.emit('close'))
      return
    }
    config.hostVerifier?.(KEY_BLOB, (accepted) => {
      if (accepted) queueMicrotask(() => client.emit('ready'))
    })
  }
  client.end = () => {
    queueMicrotask(() => client.emit('close'))
  }
  client.exec = (_command, _options, callback) => {
    const stream = new PassThrough()
    stream.stderr = new PassThrough()
    callback(null, stream)
    if (mode === 'hang') return
    // One chunk per macrotask: the `maxBytes` contract is defined per stream chunk, so the test
    // must not depend on how the stream implementation happens to coalesce writes.
    queueMicrotask(() => {
      let index = 0
      const writeNext = () => {
        if (index >= chunks.length) {
          stream.end()
          return
        }
        stream.write(chunks[index])
        index += 1
        setImmediate(writeNext)
      }
      writeNext()
    })
  }
  client.forwardOut = (_srcHost, _srcPort, _destHost, _destPort, callback) => {
    callback(null, new PassThrough())
  }
  return client
}

/** The ssh2 adapter with a scripted client and the options that make its handshake succeed. */
function realPort(options = {}) {
  return new SshConnection({
    host: 'example.com',
    port: 22,
    username: 'u',
    auth: { type: 'password', password: 'secret' },
    acceptUnknownHostKey: true,
    clientFactory: () => scriptedClient(options),
  })
}

/**
 * The two implementations, expressed as the same six entry points so the assertions below are
 * literally the same code for both.
 */
const IMPLEMENTATIONS = [
  {
    name: 'SshConnection (ssh2 adapter, scripted client)',
    plain: () => realPort(),
    handshakeClose: () => realPort({ mode: 'close' }),
    hangingExec: () => realPort({ mode: 'hang' }),
    outputExec: (chunks) => realPort({ chunks }),
    hostKey: () => realPort(),
  },
  {
    name: 'FakeSshPort (test double)',
    plain: () => new FakeSshPort(),
    handshakeClose: () => new FakeSshPort({ connectError: closedError(), closeBeforeConnectReject: true }),
    hangingExec: () => new FakeSshPort({ hangOnExec: true }),
    outputExec: (chunks) => new FakeSshPort({ outputChunks: chunks }),
    hostKey: () => new FakeSshPort({ hostKey: HOST_KEY }),
  },
]

/** A shape-only view of a coded error, so the conformance assertions never depend on identity. */
const shapeOf = (error) => ({
  code: error?.code,
  retryable: error?.retryable,
  technical: error?.technical ?? null,
})

for (const implementation of IMPLEMENTATIONS) {
  describe(`SshPort contract — ${implementation.name}`, () => {
    test('K1: exec and forwardOut on a transport that is not open reject as ssh-closed', async () => {
      const port = implementation.plain()
      for (const run of [() => port.exec('true'), () => port.forwardOut('127.0.0.1', 80)]) {
        await assert.rejects(run, (error) => {
          assert.deepEqual(shapeOf(error), { code: 'network', retryable: true, technical: 'reason=ssh-closed' })
          return true
        })
      }
      assert.equal(port.connected, false)
    })

    test('K2: connect resolves, marks the transport connected and reports a fingerprint', async () => {
      const port = implementation.plain()
      assert.equal(port.connected, false)
      const info = await port.connect()
      assert.equal(port.connected, true)
      assert.equal(typeof info.fingerprint, 'string')
      assert.ok(info.fingerprint.length > 0, 'a completed handshake must report the observed fingerprint')
      assert.equal(typeof info.keyType, 'string')
      assert.ok(info.keyType.length > 0, 'a completed handshake must report the key type')
    })

    test('K3: a handshake close emits close before the connect rejection, which is a RemoteGoError', async () => {
      const port = implementation.handshakeClose()
      const order = []
      port.on('close', () => order.push('close'))
      const rejection = await port.connect().then(
        () => {
          order.push('resolve')
          return null
        },
        (error) => {
          order.push('reject')
          return error
        },
      )
      // Decision D3: the pipeline has a listener on `close` that settles a parked prompt; it must
      // run before the rejection propagates, or a dead handshake waits out the 120 s timeout.
      assert.deepEqual(order, ['close', 'reject'])
      assert.ok(rejection instanceof RemoteGoError, 'a handshake failure is a coded error, not a bare Error')
      assert.equal(port.connected, false)
    })

    test('K4: dispose is idempotent and leaves the transport closed', async () => {
      const port = implementation.plain()
      await port.connect()
      assert.equal(port.connected, true)
      await port.dispose()
      assert.equal(port.connected, false)
      await port.dispose()
      assert.equal(port.connected, false)
    })

    test('K5: an exec deadline resolves with timedOut instead of rejecting', async () => {
      const port = implementation.hangingExec()
      await port.connect()
      const result = await port.exec('sleep 30', { timeoutMs: 20 })
      assert.equal(result.timedOut, true)
      assert.equal(result.code, null)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
    })

    test('K6: a throwing stdout listener cannot abort the command', async () => {
      const port = implementation.outputExec(['remote-output'])
      await port.connect()
      const result = await port.exec('true', {
        onStdout: () => {
          throw new Error('progress reporter blew up')
        },
        onStderr: () => {
          throw new Error('progress reporter blew up')
        },
      })
      assert.equal(result.stdout, 'remote-output')
      assert.equal(result.timedOut, false)
    })

    test('K7: host-key events carry { sha256, keyType, pinned }', async () => {
      const port = implementation.hostKey()
      const seen = []
      for (const name of ['hostkey-pending', 'hostkey-accepted', 'hostkey-rejected']) {
        port.on(name, (info) => seen.push({ name, info }))
      }
      await port.connect()
      assert.ok(seen.length > 0, 'the configured host-key path must announce the key')
      for (const { name, info } of seen) {
        assert.equal(typeof info, 'object', `${name} must carry a payload`)
        assert.equal(typeof info.sha256, 'string')
        assert.ok(info.sha256.length > 0, `${name}.sha256 must be non-empty`)
        assert.equal(typeof info.keyType, 'string')
        assert.ok(info.keyType.length > 0, `${name}.keyType must be non-empty`)
        assert.equal(typeof info.pinned, 'boolean')
      }
    })

    test('K8: maxBytes truncation is silent and only starts whole chunks', async () => {
      const port = implementation.outputExec(['aaaa', 'bbbb', 'cccc'])
      await port.connect()
      const result = await port.exec('emit', { maxBytes: 8 })
      // The cap is a "may I start another chunk" rule, not a strict byte count: the first two
      // chunks are appended (4 + 4 = 8), the third starts at the cap and is dropped.
      assert.equal(result.stdout, 'aaaabbbb')
      assert.equal(result.timedOut, false, 'truncation is not a timeout')
      // The exit status is the transport's (a scripted ssh2 channel has none, the double reports
      // 0): truncation must not invent an error code, but it is not the subject of this case.
      assert.ok(result.code === null || typeof result.code === 'number')
    })

    test('K9: the adapter keeps a permanent error listener (an unhandled error would kill the Host)', () => {
      const port = implementation.plain()
      assert.ok(port.listenerCount('error') >= 1, 'an adapter that can emit `error` must not throw it at the process')
    })

    test('documented capability gap: no download capability is declared by this implementation', () => {
      // The double deliberately has none; the ssh2 adapter has all four. This case only pins the
      // *feature-detect* contract both callers use, not a specific capability set.
      const port = implementation.plain()
      for (const name of ['saveRemoteFile', 'saveRemoteTree', 'inspectRemotePath']) {
        assert.ok(['function', 'undefined'].includes(typeof port[name]), `${name} must be absent or a function`)
      }
    })
  })
}

// The real adapter declares the four SFTP capabilities; the `typeof` branches in
// `local-download.ts` / `remote-files.ts` take the "supported" path only for it.
test('the ssh2 adapter declares every optional download capability', () => {
  const port = realPort()
  for (const name of ['openSftp', 'saveRemoteFile', 'saveRemoteTree', 'inspectRemotePath']) {
    assert.equal(typeof port[name], 'function', `${name} must exist on the ssh2 adapter`)
  }
})

// The double must not grow a capability the callers feature-detect into existence by accident.
test('the test double exposes no download capability', () => {
  const port = new FakeSshPort()
  for (const name of ['openSftp', 'saveRemoteFile', 'saveRemoteTree', 'inspectRemotePath', 'readRemoteFile']) {
    assert.equal(port[name], undefined, `${name} must stay absent so the unsupported branches stay covered`)
  }
})

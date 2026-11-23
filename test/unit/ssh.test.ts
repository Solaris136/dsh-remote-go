import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshConnection, parseSshKeyType } from '../../dist/src/ssh.js'
import { fingerprintFromBlob } from '../../dist/src/known-hosts.js'
import { errors, RemoteGoError } from '../../dist/src/errors.js'
import { classifySshFailure, closedError, toSshError } from '../../dist/src/ssh-failures.js'
import { headTail } from '../../dist/src/util.js'

const tempDir = (label) => mkdtemp(path.join(tmpdir(), `dsh-${label}-`))
function makeKeyBlob(keyType = 'ssh-ed25519', payload = 'key-material') {
  const type = Buffer.from(keyType, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length, 0)
  return Buffer.concat([len, type, Buffer.from(payload, 'ascii')])
}
/** An ssh2 client double whose `connect()` runs `behaviour`; `end()` is always a no-op. */
function fakeClient(behaviour) {
  const client = new EventEmitter()
  client.connect = () => behaviour(client)
  client.end = () => {}
  return client
}
/** The password-auth adapter every client-double case starts from. */
const sshWith = (clientFactory, overrides = {}) =>
  new SshConnection({
    host: 'example.com',
    username: 'u',
    auth: { type: 'password', password: 'x' },
    clientFactory,
    ...overrides,
  })
/** The standard offline failure: `ssh2` reports it, then the transport closes. */
const authFailure = () =>
  Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })

test('parseSshKeyType reads the SSH wire key type', () => {
  assert.equal(parseSshKeyType(makeKeyBlob('ssh-ed25519')), 'ssh-ed25519')
  assert.equal(parseSshKeyType(makeKeyBlob('ecdsa-sha2-nistp256')), 'ecdsa-sha2-nistp256')
  assert.equal(parseSshKeyType(Buffer.alloc(0)), 'unknown')
  assert.equal(parseSshKeyType(Buffer.from([0, 0, 0, 99, 1, 2])), 'unknown')
})

test('the adapter hands ssh2 the keepalive tolerance that rides out a stalled link', async () => {
  /** One client double that records the config `connect()` received and then reports a completed handshake. */
  const recording = () => {
    const client = new EventEmitter()
    client.config = null
    client.connect = (config) => {
      client.config = config
      queueMicrotask(() => client.emit('ready'))
    }
    client.end = () => {}
    return client
  }
  const plain = recording()
  await sshWith(() => plain).connect()
  assert.equal(plain.config.keepaliveInterval, 15_000)
  assert.equal(plain.config.keepaliveCountMax, 4, 'four missed keepalives ride out a ~60s stall')
  assert.equal(plain.config.readyTimeout, 20_000)

  const tuned = recording()
  await sshWith(() => tuned, { keepaliveIntervalMs: 5_000, keepaliveCountMax: 6 }).connect()
  assert.equal(tuned.config.keepaliveInterval, 5_000)
  assert.equal(tuned.config.keepaliveCountMax, 6, 'an adapter option overrides the tolerant default')
})

test('toSshError classifies auth, network and host-key failures', () => {
  assert.equal(toSshError(new Error('All configured authentication methods failed'), 'h', 22).code, 'auth')
  assert.equal(toSshError(new Error('connect ECONNREFUSED 1.2.3.4:22'), 'h', 22).code, 'network')
  assert.equal(toSshError(new Error('Timed out while waiting for handshake'), 'h', 22).code, 'network')
  assert.equal(toSshError(new Error('Host key verification failed'), 'h', 22).code, 'network')
  assert.equal(toSshError(errors.auth(), 'h', 22).code, 'auth')
  assert.equal(toSshError(errors.hostKeyChanged('SHA256:a', 'SHA256:b'), 'h', 22).code, 'host-key-changed')
})

test('verifyHostKey accepts a matching pinned fingerprint', async () => {
  const blob = makeKeyBlob()
  const fingerprint = fingerprintFromBlob(blob)
  const ssh = new SshConnection({ host: 'example.com', pinnedFingerprint: fingerprint })
  assert.equal(await ssh.verifyHostKey(blob), true)
  assert.equal(ssh.fingerprint, fingerprint)
  assert.equal(ssh.keyType, 'ssh-ed25519')
})

test('verifyHostKey rejects a changed pinned fingerprint', async () => {
  const blob = makeKeyBlob()
  const ssh = new SshConnection({ host: 'example.com', pinnedFingerprint: 'SHA256:somethingelse' })
  await assert.rejects(
    () => ssh.verifyHostKey(blob),
    (error) => error.code === 'host-key-changed',
  )
})

test('verifyHostKey accepts any fingerprint present in known_hosts', async () => {
  const blob = makeKeyBlob()
  const ssh = new SshConnection({
    host: 'example.com',
    knownHostFingerprints: ['SHA256:other', fingerprintFromBlob(blob)],
  })
  assert.equal(await ssh.verifyHostKey(blob), true)
})

test('verifyHostKey rejects an unknown fingerprint under strict policy', async () => {
  const ssh = new SshConnection({ host: 'example.com', hostKeyPolicy: 'strict' })
  await assert.rejects(
    () => ssh.verifyHostKey(makeKeyBlob()),
    (error) => error.code === 'host-key-unknown',
  )
})

test('verifyHostKey asks the UI on first use and honors the answer', async () => {
  const blob = makeKeyBlob()
  let asked = null
  const accept = new SshConnection({
    host: 'example.com',
    onHostKey: async (info) => {
      asked = info
      return true
    },
  })
  assert.equal(await accept.verifyHostKey(blob), true)
  assert.equal(asked.sha256, fingerprintFromBlob(blob))
  assert.equal(asked.keyType, 'ssh-ed25519')
  const reject = new SshConnection({ host: 'example.com', onHostKey: async () => false })
  await assert.rejects(
    () => reject.verifyHostKey(blob),
    (error) => error.code === 'host-key-unknown',
  )
})

test('verifyHostKey refuses unknown keys when no UI is attached', async () => {
  const ssh = new SshConnection({ host: 'example.com' })
  await assert.rejects(
    () => ssh.verifyHostKey(makeKeyBlob()),
    (error) => error.code === 'host-key-unknown',
  )
})

test('verifyHostKey can be told to accept unknown keys (automation)', async () => {
  const ssh = new SshConnection({ host: 'example.com', acceptUnknownHostKey: true })
  assert.equal(await ssh.verifyHostKey(makeKeyBlob()), true)
})

test('resolveAuthCandidates returns password and key-file candidates only', async () => {
  const dir = await tempDir('key')
  const keyFile = path.join(dir, 'id_test')
  await writeFile(keyFile, 'PRIVATE-KEY-BYTES', 'utf8')
  const password = new SshConnection({ host: 'h', auth: { type: 'password', password: 'pw' } })
  assert.deepEqual(await password.resolveAuthCandidates(), [{ password: 'pw', tryKeyboard: true }])
  const key = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: keyFile }, home: dir })
  const keyCandidates = await key.resolveAuthCandidates()
  assert.equal(keyCandidates.length, 1)
  assert.equal(Buffer.from(keyCandidates[0].privateKey).toString('utf8'), 'PRIVATE-KEY-BYTES')
  const missing = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: path.join(dir, 'nope') }, home: dir })
  assert.deepEqual(await missing.resolveAuthCandidates(), [])
  const conventional = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: '~/.ssh/id_ed25519' }, home: dir })
  await mkdir(path.join(dir, '.ssh'), { recursive: true })
  await writeFile(path.join(dir, '.ssh', 'id_ed25519'), 'DEFAULT-KEY-BYTES', 'utf8')
  const conventionalCandidates = await conventional.resolveAuthCandidates()
  assert.ok(conventionalCandidates.length >= 1)
  assert.equal(Buffer.from(conventionalCandidates[0].privateKey).toString('utf8'), 'DEFAULT-KEY-BYTES')
  const previousAgent = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
  try {
    const agent = new SshConnection({ host: 'h', auth: { type: 'agent' }, home: dir })
    const agentCandidates = await agent.resolveAuthCandidates()
    assert.equal(
      agentCandidates.some((candidate) => 'agent' in candidate),
      false,
      'no agent candidate may be produced',
    )
  } finally {
    if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = previousAgent
  }
})

test('exec refuses to run without an open connection', async () => {
  const ssh = new SshConnection({ host: 'example.com' })
  await assert.rejects(() => ssh.exec('true'), /not open/)
  await assert.rejects(() => ssh.forwardOut('127.0.0.1', 80), /not open/)
})

test('a closed transport is a typed network failure, never an internal one', async () => {
  const ssh = new SshConnection({ host: 'example.com' })
  for (const run of [() => ssh.exec('true'), () => ssh.openSftp(), () => ssh.forwardOut('127.0.0.1', 80)]) {
    await assert.rejects(
      run,
      (error) => error.code === 'network' && error.retryable === true && /ssh-closed/.test(error.technical ?? ''),
    )
  }
})

test('a throwing progress listener cannot abort a running command', async () => {
  const client = fakeClient((self) => queueMicrotask(() => self.emit('ready')))
  client.exec = (_command, _options, callback) => {
    const stream = new PassThrough()
    stream.stderr = new PassThrough()
    callback(null, stream)
    queueMicrotask(() => {
      stream.write('remote-output')
      stream.end()
    })
  }
  const ssh = sshWith(() => client)
  await ssh.connect()
  const reporter = () => {
    throw new Error('progress reporter blew up')
  }
  const result = await ssh.exec('true', { onStdout: reporter, onStderr: reporter })
  assert.equal(result.stdout, 'remote-output')
})

test('late ssh2 errors after a failed auth attempt never crash the host process', async () => {
  const client = fakeClient((self) =>
    queueMicrotask(() => {
      self.emit('error', authFailure())
      self.emit('error', new Error('late teardown error'))
    }),
  )
  const ssh = sshWith(() => client)
  await assert.rejects(ssh.connect(), (error) => error?.code === 'auth')
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('a failed auth candidate does not leave the fallback connection marked closed', async () => {
  const dir = await tempDir('fallback')
  const keyFile = path.join(dir, 'id_test')
  await writeFile(keyFile, 'PRIVATE-KEY-BYTES', 'utf8')
  const secondKey = path.join(dir, 'id_second')
  await writeFile(secondKey, 'SECOND-KEY-BYTES', 'utf8')
  let attempt = 0
  const clientFactory = () =>
    fakeClient((self) => {
      attempt += 1
      if (attempt === 1) {
        queueMicrotask(() => self.emit('error', authFailure()))
        return
      }
      queueMicrotask(() => self.emit('ready'))
    })
  const ssh = sshWith(clientFactory, { auth: { type: 'key', keyPath: keyFile }, identityFiles: [secondKey], home: dir })
  await ssh.connect()
  assert.equal(attempt, 2, 'the second candidate must be tried after the first fails')
  assert.equal(ssh.connected, true, 'the successful fallback must not stay marked closed')
})

test('post-connect ssh errors are contained and reach optional listeners', async () => {
  const client = fakeClient((self) => queueMicrotask(() => self.emit('ready')))
  const ssh = sshWith(() => client)
  await ssh.connect()
  const seen = []
  ssh.on('error', (error) => seen.push(error.message))
  assert.doesNotThrow(() => client.emit('error', new Error('connection lost')))
  assert.deepEqual(seen, ['connection lost'])
})
/** One SFTP directory-listing row; `attrs` carries exactly the predicates the walker reads. */
const entry = (filename, attrs) => ({ filename, attrs })
const fileEntry = (filename, size) => entry(filename, { isFile: () => true, size, mtime: 0 })
const dirEntry = (filename) => entry(filename, { isDirectory: () => true, mtime: 0 })
/** The SFTP error ssh2 reports for a path that is not there (a missing file or directory). */
const missing = (what) => Object.assign(new Error(`No such ${what}`), { code: 2 })
function fakeSftp(files, directories = {}) {
  const ended = { value: false }
  const attrsOf = (file) => ({
    size: file.bytes.length,
    mtime: 0,
    isDirectory: () => file.directory === true,
    isFile: () => file.directory !== true,
  })
  const wrapper = {
    stat(path, callback) {
      if (directories[path] !== undefined) {
        callback(null, { size: 0, mtime: 0, isDirectory: () => true, isFile: () => false })
        return
      }
      if (files[path] === undefined) return callback(missing('file'))
      callback(null, attrsOf(files[path]))
    },
    readdir(path, callback) {
      if (directories[path] === undefined) return callback(missing('directory'))
      callback(null, directories[path])
    },
    createReadStream(path) {
      if (files[path] === undefined) throw missing('file')
      return Readable.from([files[path].bytes])
    },
    readFile(path, callback) {
      if (files[path] === undefined) return callback(missing('file'))
      callback(null, files[path].bytes)
    },
    end() {
      ended.value = true
    },
  }
  return { wrapper, ended }
}
function sshWithSftp(files, directories) {
  const ssh = new SshConnection({ host: 'example.com' })
  const { wrapper, ended } = fakeSftp(files, directories)
  ssh.client = { sftp: (callback) => callback(null, wrapper) }
  ssh.closed = false
  return { ssh, ended }
}

test('saveRemoteFile streams a regular file to disk and ends the session', async () => {
  const { ssh, ended } = sshWithSftp({ '/home/ubuntu/report.md': { bytes: Buffer.from('hello remote') } })
  const target = path.join(await tempDir('save-file'), 'report.md')
  const progress = []
  const result = await ssh.saveRemoteFile('/home/ubuntu/report.md', target, {
    onProgress: (info) => progress.push(info),
  })
  assert.equal(result.size, 12)
  assert.equal(await readFile(target, 'utf8'), 'hello remote')
  assert.equal(progress.at(-1).doneBytes, 12)
  assert.equal(progress.at(-1).totalBytes, 12)
  assert.equal(ended.value, true)
})

test('saveRemoteFile refuses directories and has no size cap', async () => {
  const directory = sshWithSftp({ '/home/ubuntu/folder': { bytes: Buffer.alloc(0), directory: true } })
  const first = path.join(await tempDir('save-dir'), 'folder')
  await assert.rejects(directory.ssh.saveRemoteFile('/home/ubuntu/folder', first), /remote-file-unavailable/)
  assert.equal(directory.ended.value, true)
  const large = sshWithSftp({ '/home/ubuntu/big.bin': { bytes: Buffer.alloc(32) } })
  const target = path.join(await tempDir('save-large'), 'big.bin')
  const result = await large.ssh.saveRemoteFile('/home/ubuntu/big.bin', target)
  assert.equal(result.size, 32)
  assert.equal((await readFile(target)).length, 32)
  assert.equal(large.ended.value, true)
})

test('saveRemoteFile removes the partial file when cancelled mid-stream', async () => {
  const { ssh } = sshWithSftp({ '/home/ubuntu/report.md': { bytes: Buffer.from('hello remote') } })
  const target = path.join(await tempDir('save-cancel-file'), 'report.md')
  await assert.rejects(
    ssh.saveRemoteFile('/home/ubuntu/report.md', target, { isCancelled: () => true }),
    /download-cancelled/,
  )
  await assert.rejects(readFile(target), /ENOENT/)
})

test('saveRemoteTree writes files and empty directories into a local target', async () => {
  const { ssh, ended } = sshWithSftp(
    {
      '/home/ubuntu/project/a.txt': { bytes: Buffer.from('aaa') },
      '/home/ubuntu/project/sub/b.txt': { bytes: Buffer.from('bbb') },
    },
    {
      '/home/ubuntu/project': [
        dirEntry('sub'),
        fileEntry('a.txt', 3),
        dirEntry('empty'),
        entry('link', { isSymbolicLink: () => true }),
      ],
      '/home/ubuntu/project/sub': [fileEntry('b.txt', 3)],
      '/home/ubuntu/project/empty': [],
    },
  )
  const target = path.join(await tempDir('save-tree'), 'project')
  const inventory = []
  const progress = []
  const result = await ssh.saveRemoteTree('/home/ubuntu/project', target, {
    onInventory: (info) => inventory.push(info),
    onProgress: (info) => progress.push(info),
  })
  assert.deepEqual(inventory, [{ totalBytes: 6, totalFiles: 2 }])
  assert.equal(result.destination, path.resolve(target))
  assert.equal(await readFile(path.join(target, 'a.txt'), 'utf8'), 'aaa')
  assert.equal(await readFile(path.join(target, 'sub', 'b.txt'), 'utf8'), 'bbb')
  assert.deepEqual(await readdir(path.join(target, 'empty')), [])
  assert.equal(progress.at(-1).doneFiles, 2)
  assert.equal(progress.at(-1).doneBytes, 6)
  assert.equal(ended.value, true)
})

test('saveRemoteTree has no byte or entry cap', async () => {
  const { ssh } = sshWithSftp(
    {
      '/home/ubuntu/big/a.bin': { bytes: Buffer.alloc(32) },
      '/home/ubuntu/big/b.bin': { bytes: Buffer.alloc(32) },
    },
    {
      '/home/ubuntu/big': [fileEntry('a.bin', 32), fileEntry('b.bin', 32)],
    },
  )
  const target = path.join(await tempDir('save-big'), 'big')
  const result = await ssh.saveRemoteTree('/home/ubuntu/big', target)
  assert.equal(result.totalBytes, 64)
  assert.equal(result.totalFiles, 2)
  assert.equal((await readFile(path.join(target, 'a.bin'))).length, 32)
})

test('saveRemoteTree can stop before the next file', async () => {
  const { ssh } = sshWithSftp(
    { '/home/ubuntu/project/a.txt': { bytes: Buffer.from('aaa') } },
    { '/home/ubuntu/project': [fileEntry('a.txt', 3)] },
  )
  const target = path.join(await tempDir('save-cancel'), 'project')
  const result = await ssh.saveRemoteTree('/home/ubuntu/project', target, { isCancelled: () => true })
  assert.equal(result.cancelled, true)
  await assert.rejects(readdir(target), /ENOENT/)
})

test('saveRemoteTree rejects a non-directory root', async () => {
  const { ssh } = sshWithSftp({ '/home/ubuntu/a.txt': { bytes: Buffer.from('a') } })
  const target = path.join(await tempDir('save-file'), 'a.txt')
  await assert.rejects(ssh.saveRemoteTree('/home/ubuntu/a.txt', target), /remote-file-unavailable/)
})

test('saveRemoteTree keeps both files when two names differ only by case', async () => {
  const { ssh } = sshWithSftp(
    {
      '/home/ubuntu/report/Report.md': { bytes: Buffer.from('upper') },
      '/home/ubuntu/report/report.md': { bytes: Buffer.from('lower') },
    },
    {
      '/home/ubuntu/report': [fileEntry('Report.md', 5), fileEntry('report.md', 5)],
    },
  )
  const target = path.join(await tempDir('save-case'), 'report')
  // Force the case-insensitive behavior a Windows/macOS Desktop has, whatever this host is.
  const result = await ssh.saveRemoteTree('/home/ubuntu/report', target, { caseInsensitive: true })
  assert.equal(result.totalFiles, 2)
  assert.equal(result.renamedFiles, 1)
  const names = (await readdir(target)).sort()
  assert.deepEqual(
    names.map((name) => name.toLowerCase()),
    ['report (2).md', 'report.md'],
  )
  const contents = await Promise.all(names.map((name) => readFile(path.join(target, name), 'utf8')))
  assert.deepEqual(contents.sort(), ['lower', 'upper'], 'no remote file may be silently overwritten')
})

test('saveRemoteTree leaves Windows metadata and shell shortcut files out', async () => {
  const { ssh } = sshWithSftp(
    { '/home/ubuntu/mixed/readme.txt': { bytes: Buffer.from('keep') } },
    {
      '/home/ubuntu/mixed': [
        fileEntry('readme.txt', 4),
        fileEntry('desktop.ini', 9),
        fileEntry('Thumbs.db', 9),
        fileEntry('setup.lnk', 9),
        fileEntry('docs.url', 9),
        dirEntry('notes'),
      ],
      '/home/ubuntu/mixed/notes': [],
    },
  )
  const target = path.join(await tempDir('save-junk'), 'mixed')
  const reported = []
  const result = await ssh.saveRemoteTree('/home/ubuntu/mixed', target, {
    ignoreWindowsNames: true,
    onIgnored: (names) => reported.push(names),
  })
  assert.equal(result.totalFiles, 1)
  assert.deepEqual((await readdir(target)).sort(), ['notes', 'readme.txt'])
  assert.deepEqual(result.ignoredNames.sort(), ['Thumbs.db', 'desktop.ini', 'docs.url', 'setup.lnk'])
  // The download job surfaces what was skipped instead of dropping it silently.
  assert.equal(reported.length, 1)
  assert.deepEqual(reported[0].sort(), ['Thumbs.db', 'desktop.ini', 'docs.url', 'setup.lnk'])
})

test('saveRemoteFile surfaces a missing SFTP session and a missing file', async () => {
  const closed = new SshConnection({ host: 'example.com' })
  const target = path.join(await tempDir('save-closed'), 'a')
  await assert.rejects(closed.saveRemoteFile('/home/ubuntu/a', target), /SSH connection is not open/)
  const missingFile = sshWithSftp({})
  const missingTarget = path.join(await tempDir('save-missing'), 'missing')
  await assert.rejects(missingFile.ssh.saveRemoteFile('/home/ubuntu/missing', missingTarget), /No such file/)
})

test('readKey skips a huge file and a non-regular file at the configured key path', async () => {
  const dir = await tempDir('hugekey')
  const big = path.join(dir, 'huge.key')
  await writeFile(big, Buffer.alloc(1024 * 1024 + 1, 0x41))
  const fromBig = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: big }, home: dir })
  assert.deepEqual(await fromBig.resolveAuthCandidates(), [], 'a >1 MiB file is not a private key')
  const dirPath = path.join(dir, 'keydir')
  await mkdir(dirPath)
  const fromDir = new SshConnection({ host: 'h', auth: { type: 'key', keyPath: dirPath }, home: dir })
  assert.deepEqual(await fromDir.resolveAuthCandidates(), [], 'a directory is not a private key')
})

test('the Windows-only name filter can be turned off (other platforms keep those files)', async () => {
  const { ssh } = sshWithSftp(
    {
      '/home/ubuntu/posix/desktop.ini': { bytes: Buffer.from('a') },
      '/home/ubuntu/posix/setup.lnk': { bytes: Buffer.from('b') },
      '/home/ubuntu/posix/readme.txt': { bytes: Buffer.from('c') },
    },
    {
      '/home/ubuntu/posix': [fileEntry('desktop.ini', 1), fileEntry('readme.txt', 1), fileEntry('setup.lnk', 1)],
    },
  )
  const target = path.join(await tempDir('save-posix'), 'posix')
  const kept = await ssh.saveRemoteTree('/home/ubuntu/posix', target, {
    ignoreWindowsNames: false,
    caseInsensitive: false,
  })
  assert.equal(kept.totalFiles, 3)
  assert.deepEqual(kept.ignoredNames, [])
  assert.deepEqual((await readdir(target)).sort(), ['desktop.ini', 'readme.txt', 'setup.lnk'])
})

test('a handshake-time close is observable and rejects the connect instead of hanging', async () => {
  // The transport dies before `ready`: exactly the window a host-key prompt sits in.
  const client = fakeClient((self) => queueMicrotask(() => self.emit('close')))
  const ssh = sshWith(() => client)
  const closes = []
  ssh.on('close', () => closes.push('close'))
  await assert.rejects(
    () => ssh.connect(),
    (error) => error.code === 'network' && /closed during the SSH handshake/.test(error.detail.en),
  )
  assert.deepEqual(closes, ['close'], 'the pipeline needs the close to cancel its parked prompt')
  assert.equal(ssh.connected, false)
})

test('a synchronous error+close during the handshake is one failure, not a dropped link', async () => {
  const client = fakeClient((self) => {
    // ssh2's DNS resolution failure: error then close in the same tick.
    const error = new Error('getaddrinfo ENOTFOUND example.com')
    error.code = 'ENOTFOUND'
    self.emit('error', error)
    self.emit('close')
  })
  const ssh = sshWith(() => client)
  const closes = []
  ssh.on('close', () => closes.push('close'))
  await assert.rejects(
    () => ssh.connect(),
    (error) => error.code === 'network',
  )
  assert.deepEqual(closes, [], 'the teardown of a failed attempt must not read as a lost link')
  assert.equal(ssh.connected, false)
})

/* ── error-classification equivalence (P5 / decision D2) ────────────────────────────────────────
 * `toSshError` was extracted into `classifySshFailure` (and `toSshError` became an alias). The extraction is only
 * allowed if the client-visible code and wording didn't move, so these cases compare the new classifier against a
 * verbatim copy of HEAD's `toSshError` / `closedError` — the *old* rules, not the alias (an alias compared
 * with itself proves nothing). */

/** HEAD `src/ssh.ts:876-903` (pre-P5 `toSshError`), copied verbatim as the oracle. */
function headToSshError(error, host, port) {
  if (!error) return errors.internal('unknown ssh error')
  if (error instanceof RemoteGoError) return error
  const message = String(error?.message ?? error)
  const code = String(error?.code ?? '')
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
/** HEAD `src/ssh.ts:42-51` (pre-P5 `closedError`), copied verbatim as the oracle. */
function headClosedError() {
  return errors.network(
    {
      zh: 'SSH 连接已断开，本次操作没有完成；如果主机仍在线，重连即可继续。',
      en: 'SSH connection is not open; the transport closed before this step finished.',
    },
    { technical: 'reason=ssh-closed' },
  )
}
/** Everything the client can observe of one coded error (identity deliberately excluded). */
const codedShape = (error) => ({
  code: error.code,
  detail: error.detail,
  retryable: error.retryable,
  technical: error.technical ?? null,
  nextSteps: error.nextSteps,
})

test('ssh-failures.ts is the single source: the adapter no longer re-exports the classifier', async () => {
  // The classifier used to be re-exported from `ssh.ts` for old call sites; the barrel gate forbids `export … from`, so
  // the owner module is the only exporter. Importing it here proves both the name and the deletion.
  const adapter = await import('../../dist/src/ssh.js')
  assert.equal('toSshError' in adapter, false)
  assert.equal(typeof toSshError, 'function')
  assert.equal(typeof classifySshFailure, 'function')
})

test('classifySshFailure is message-for-message equivalent to HEAD toSshError', () => {
  const cases = [
    { label: 'auth', make: () => new Error('All configured authentication methods failed') },
    { label: 'auth (permission denied)', make: () => new Error('Permission denied (publickey,password)') },
    {
      label: 'transport (ECONNREFUSED)',
      make: () => Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:22'), { code: 'ECONNREFUSED' }),
    },
    { label: 'transport (handshake timeout)', make: () => new Error('Timed out while waiting for handshake') },
    { label: 'hostkey', make: () => new Error('Host key verification failed') },
    { label: 'fallback', make: () => new Error('something odd happened') },
    { label: 'thrown string', make: () => 'not an Error' },
  ]
  for (const { label, make } of cases) {
    const error = make()
    const expected = codedShape(headToSshError(error, 'h', 22))
    assert.deepEqual(codedShape(classifySshFailure(error, { host: 'h', port: 22 })), expected, label)
    assert.deepEqual(codedShape(toSshError(error, 'h', 22)), expected, `${label} (alias)`)
  }
})

test('an explicit failure kind keeps the same code and wording HEAD produced for it', () => {
  // Each row: an adapter that already knows the kind must not invent different client text.
  const rows = [
    { label: 'auth', kind: 'auth', head: () => new Error('All configured authentication methods failed') },
    {
      label: 'transport',
      kind: 'transport',
      head: () => Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    },
    { label: 'hostkey', kind: 'hostkey', head: () => new Error('Host key verification failed') },
    { label: 'timeout', kind: 'timeout', head: () => new Error('Timed out while waiting for handshake') },
  ]
  for (const { label, kind, head } of rows) {
    assert.deepEqual(
      codedShape(classifySshFailure(new Error('an adapter that already knows'), { kind, host: 'h', port: 22 })),
      codedShape(headToSshError(head(), 'h', 22)),
      label,
    )
  }
  assert.deepEqual(
    codedShape(classifySshFailure(new Error('closed'), { kind: 'closed' })),
    codedShape(headClosedError()),
    'closed',
  )
  assert.deepEqual(codedShape(closedError()), codedShape(headClosedError()), 'closedError')
})

test('a coded error passes through the classifier untouched, whatever kind is claimed', () => {
  const typed = errors.hostKeyChanged('SHA256:a', 'SHA256:b')
  assert.equal(classifySshFailure(typed, { kind: 'transport' }), typed)
  assert.equal(classifySshFailure(typed, { host: 'h', port: 22 }), typed)
  assert.equal(toSshError(typed, 'h', 22), typed)
})

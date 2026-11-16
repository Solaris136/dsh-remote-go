import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshConnection, parseSshKeyType, toSshError } from '../../src/ssh.js'
import { fingerprintFromBlob } from '../../src/known-hosts.js'
import { errors } from '../../src/errors.js'

function makeKeyBlob(keyType = 'ssh-ed25519', payload = 'key-material') {
  const type = Buffer.from(keyType, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(type.length, 0)
  return Buffer.concat([len, type, Buffer.from(payload, 'ascii')])
}

test('parseSshKeyType reads the SSH wire key type', () => {
  assert.equal(parseSshKeyType(makeKeyBlob('ssh-ed25519')), 'ssh-ed25519')
  assert.equal(parseSshKeyType(makeKeyBlob('ecdsa-sha2-nistp256')), 'ecdsa-sha2-nistp256')
  assert.equal(parseSshKeyType(Buffer.alloc(0)), 'unknown')
  assert.equal(parseSshKeyType(Buffer.from([0, 0, 0, 99, 1, 2])), 'unknown')
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
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-key-'))
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
  const { PassThrough } = await import('node:stream')
  class FakeClient extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'))
    }
    end() {}
    exec(_command, _options, callback) {
      const stream = new PassThrough()
      stream.stderr = new PassThrough()
      callback(null, stream)
      queueMicrotask(() => {
        stream.write('remote-output')
        stream.end()
      })
    }
  }
  const ssh = new SshConnection({
    host: 'example.com',
    username: 'u',
    auth: { type: 'password', password: 'x' },
    clientFactory: () => new FakeClient(),
  })
  await ssh.connect()
  const result = await ssh.exec('true', {
    onStdout: () => {
      throw new Error('progress reporter blew up')
    },
    onStderr: () => {
      throw new Error('progress reporter blew up')
    },
  })
  assert.equal(result.stdout, 'remote-output')
})

test('late ssh2 errors after a failed auth attempt never crash the host process', async () => {
  class FakeClient extends EventEmitter {
    connect() {
      queueMicrotask(() => {
        this.emit(
          'error',
          Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }),
        )
        this.emit('error', new Error('late teardown error'))
      })
    }
    end() {}
  }
  const ssh = new SshConnection({
    host: 'example.com',
    username: 'u',
    auth: { type: 'password', password: 'x' },
    clientFactory: () => new FakeClient(),
  })
  await assert.rejects(ssh.connect(), (error) => error?.code === 'auth')
  await new Promise((resolve) => setTimeout(resolve, 20))
})

test('a failed auth candidate does not leave the fallback connection marked closed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-fallback-'))
  const keyFile = path.join(dir, 'id_test')
  await writeFile(keyFile, 'PRIVATE-KEY-BYTES', 'utf8')
  let attempt = 0
  class FakeClient extends EventEmitter {
    connect() {
      attempt += 1
      if (attempt === 1) {
        queueMicrotask(() => {
          this.emit(
            'error',
            Object.assign(new Error('All configured authentication methods failed'), {
              level: 'client-authentication',
            }),
          )
        })
        return
      }
      queueMicrotask(() => this.emit('ready'))
    }
    end() {}
  }
  const secondKey = path.join(dir, 'id_second')
  await writeFile(secondKey, 'SECOND-KEY-BYTES', 'utf8')
  const ssh = new SshConnection({
    host: 'example.com',
    username: 'u',
    auth: { type: 'key', keyPath: keyFile },
    identityFiles: [secondKey],
    home: dir,
    clientFactory: () => new FakeClient(),
  })
  await ssh.connect()
  assert.equal(attempt, 2, 'the second candidate must be tried after the first fails')
  assert.equal(ssh.connected, true, 'the successful fallback must not stay marked closed')
})

test('post-connect ssh errors are contained and reach optional listeners', async () => {
  class FakeClient extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'))
    }
    end() {}
  }
  const fake = new FakeClient()
  const ssh = new SshConnection({
    host: 'example.com',
    username: 'u',
    auth: { type: 'password', password: 'x' },
    clientFactory: () => fake,
  })
  await ssh.connect()
  const seen = []
  ssh.on('error', (error) => seen.push(error.message))
  assert.doesNotThrow(() => fake.emit('error', new Error('connection lost')))
  assert.deepEqual(seen, ['connection lost'])
})

function fakeSftp(files, directories = {}) {
  const ended = { value: false }
  const wrapper = {
    stat(path, callback) {
      if (directories[path] !== undefined) {
        callback(null, {
          size: 0,
          mtime: 0,
          isDirectory: () => true,
          isFile: () => false,
        })
        return
      }
      const file = files[path]
      if (file === undefined) {
        const error = new Error('No such file')
        error.code = 2
        callback(error)
        return
      }
      callback(null, {
        size: file.bytes.length,
        mtime: 0,
        isDirectory: () => file.directory === true,
        isFile: () => file.directory !== true,
      })
    },
    readdir(path, callback) {
      const listing = directories[path]
      if (listing === undefined) {
        const error = new Error('No such directory')
        error.code = 2
        callback(error)
        return
      }
      callback(null, listing)
    },
    createReadStream(path) {
      const file = files[path]
      if (file === undefined) {
        const error = new Error('No such file')
        error.code = 2
        throw error
      }
      return Readable.from([file.bytes])
    },
    readFile(path, callback) {
      const file = files[path]
      if (file === undefined) {
        const error = new Error('No such file')
        error.code = 2
        callback(error)
        return
      }
      callback(null, file.bytes)
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
  const { ssh, ended } = sshWithSftp({
    '/home/ubuntu/report.md': { bytes: Buffer.from('hello remote') },
  })
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-file-')), 'report.md')
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
  const first = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-dir-')), 'folder')
  await assert.rejects(directory.ssh.saveRemoteFile('/home/ubuntu/folder', first), /remote-file-unavailable/)
  assert.equal(directory.ended.value, true)
  const large = sshWithSftp({ '/home/ubuntu/big.bin': { bytes: Buffer.alloc(32) } })
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-large-')), 'big.bin')
  const result = await large.ssh.saveRemoteFile('/home/ubuntu/big.bin', target)
  assert.equal(result.size, 32)
  assert.equal((await readFile(target)).length, 32)
  assert.equal(large.ended.value, true)
})

test('saveRemoteFile removes the partial file when cancelled mid-stream', async () => {
  const { ssh } = sshWithSftp({ '/home/ubuntu/report.md': { bytes: Buffer.from('hello remote') } })
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-cancel-file-')), 'report.md')
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
        { filename: 'sub', attrs: { isDirectory: () => true, mtime: 0 } },
        { filename: 'a.txt', attrs: { isFile: () => true, size: 3, mtime: 0 } },
        { filename: 'empty', attrs: { isDirectory: () => true, mtime: 0 } },
        { filename: 'link', attrs: { isSymbolicLink: () => true } },
      ],
      '/home/ubuntu/project/sub': [{ filename: 'b.txt', attrs: { isFile: () => true, size: 3, mtime: 0 } }],
      '/home/ubuntu/project/empty': [],
    },
  )
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-tree-')), 'project')
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
  const files = {
    '/home/ubuntu/big/a.bin': { bytes: Buffer.alloc(32) },
    '/home/ubuntu/big/b.bin': { bytes: Buffer.alloc(32) },
  }
  const directories = {
    '/home/ubuntu/big': [
      { filename: 'a.bin', attrs: { isFile: () => true, size: 32 } },
      { filename: 'b.bin', attrs: { isFile: () => true, size: 32 } },
    ],
  }
  const { ssh } = sshWithSftp(files, directories)
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-big-')), 'big')
  const result = await ssh.saveRemoteTree('/home/ubuntu/big', target)
  assert.equal(result.totalBytes, 64)
  assert.equal(result.totalFiles, 2)
  assert.equal((await readFile(path.join(target, 'a.bin'))).length, 32)
})

test('saveRemoteTree can stop before the next file', async () => {
  const { ssh } = sshWithSftp(
    { '/home/ubuntu/project/a.txt': { bytes: Buffer.from('aaa') } },
    {
      '/home/ubuntu/project': [{ filename: 'a.txt', attrs: { isFile: () => true, size: 3 } }],
    },
  )
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-cancel-')), 'project')
  const result = await ssh.saveRemoteTree('/home/ubuntu/project', target, { isCancelled: () => true })
  assert.equal(result.cancelled, true)
  await assert.rejects(readdir(target), /ENOENT/)
})

test('saveRemoteTree rejects a non-directory root', async () => {
  const { ssh } = sshWithSftp({ '/home/ubuntu/a.txt': { bytes: Buffer.from('a') } })
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-file-')), 'a.txt')
  await assert.rejects(ssh.saveRemoteTree('/home/ubuntu/a.txt', target), /remote-file-unavailable/)
})

test('saveRemoteTree keeps both files when two names differ only by case', async () => {
  const { ssh } = sshWithSftp(
    {
      '/home/ubuntu/report/Report.md': { bytes: Buffer.from('upper') },
      '/home/ubuntu/report/report.md': { bytes: Buffer.from('lower') },
    },
    {
      '/home/ubuntu/report': [
        { filename: 'Report.md', attrs: { isFile: () => true, size: 5 } },
        { filename: 'report.md', attrs: { isFile: () => true, size: 5 } },
      ],
    },
  )
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-case-')), 'report')
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
    {
      '/home/ubuntu/mixed/readme.txt': { bytes: Buffer.from('keep') },
    },
    {
      '/home/ubuntu/mixed': [
        { filename: 'readme.txt', attrs: { isFile: () => true, size: 4 } },
        { filename: 'desktop.ini', attrs: { isFile: () => true, size: 9 } },
        { filename: 'Thumbs.db', attrs: { isFile: () => true, size: 9 } },
        { filename: 'setup.lnk', attrs: { isFile: () => true, size: 9 } },
        { filename: 'docs.url', attrs: { isFile: () => true, size: 9 } },
        { filename: 'notes', attrs: { isDirectory: () => true } },
      ],
      '/home/ubuntu/mixed/notes': [],
    },
  )
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-junk-')), 'mixed')
  const result = await ssh.saveRemoteTree('/home/ubuntu/mixed', target, { ignoreWindowsNames: true })
  assert.equal(result.totalFiles, 1)
  assert.deepEqual((await readdir(target)).sort(), ['notes', 'readme.txt'])
  assert.deepEqual(result.ignoredNames.sort(), ['Thumbs.db', 'desktop.ini', 'docs.url', 'setup.lnk'])
})

test('saveRemoteFile surfaces a missing SFTP session and a missing file', async () => {
  const closed = new SshConnection({ host: 'example.com' })
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-closed-')), 'a')
  await assert.rejects(closed.saveRemoteFile('/home/ubuntu/a', target), /SSH connection is not open/)
  const missing = sshWithSftp({})
  const missingTarget = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-missing-')), 'missing')
  await assert.rejects(missing.ssh.saveRemoteFile('/home/ubuntu/missing', missingTarget), /No such file/)
})

test('readKey skips a huge file and a non-regular file at the configured key path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-hugekey-'))
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
      '/home/ubuntu/posix': [
        { filename: 'desktop.ini', attrs: { isFile: () => true, size: 1 } },
        { filename: 'readme.txt', attrs: { isFile: () => true, size: 1 } },
        { filename: 'setup.lnk', attrs: { isFile: () => true, size: 1 } },
      ],
    },
  )
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-save-posix-')), 'posix')
  const kept = await ssh.saveRemoteTree('/home/ubuntu/posix', target, {
    ignoreWindowsNames: false,
    caseInsensitive: false,
  })
  assert.equal(kept.totalFiles, 3)
  assert.deepEqual(kept.ignoredNames, [])
  assert.deepEqual((await readdir(target)).sort(), ['desktop.ini', 'readme.txt', 'setup.lnk'])
})

test('a handshake-time close is observable and rejects the connect instead of hanging', async () => {
  class FakeClient extends EventEmitter {
    connect() {
      // The transport dies before `ready`: exactly the window a host-key prompt sits in.
      queueMicrotask(() => this.emit('close'))
    }
    end() {}
  }
  const ssh = new SshConnection({
    host: 'example.com',
    username: 'u',
    auth: { type: 'password', password: 'x' },
    clientFactory: () => new FakeClient(),
  })
  const closes = []
  ssh.on('close', () => closes.push('close'))
  await assert.rejects(
    () => ssh.connect(),
    (error) => error.code === 'network' && /closed during the SSH handshake/.test(error.detail.en),
  )
  assert.deepEqual(closes, ['close'], 'the pipeline needs the close to cancel its parked prompt')
  assert.equal(ssh.connected, false)
})

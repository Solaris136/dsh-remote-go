import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeRemoteFilePath, readHostDownload, remoteFileName, toRemoteFileError } from '../../src/remote-files.js'

function runtimeWith(ssh) {
  return { id: 'h_1', status: 'connected', ssh }
}

test('normalizeRemoteFilePath accepts absolute POSIX paths and collapses redundant segments', () => {
  assert.equal(normalizeRemoteFilePath('/home/ubuntu/report.md'), '/home/ubuntu/report.md')
  assert.equal(normalizeRemoteFilePath('/home//ubuntu/./report.md'), '/home/ubuntu/report.md')
  assert.equal(normalizeRemoteFilePath('/home/ubuntu/../ubuntu/report.md'), '/home/ubuntu/report.md')
  assert.equal(remoteFileName('/home/ubuntu/report.md'), 'report.md')
  assert.equal(remoteFileName('/'), 'download')
})

test('normalizeRemoteFilePath rejects relative, empty and control-character paths', () => {
  for (const value of ['', '  ', 'home/ubuntu/a.txt', 'C:\\Users\\a.txt', '/home/\0/a', '/home/a\nb']) {
    assert.throws(() => normalizeRemoteFilePath(value), /invalid-input/)
  }
  assert.throws(() => normalizeRemoteFilePath(null), /invalid-input/)
})

test('readHostDownload streams a file into a unique local file', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-file-download-'))
  await writeFile(path.join(base, 'report.md'), 'already here')
  const calls = []
  const runtime = runtimeWith({
    async inspectRemotePath() {
      return { isFile: true, isDirectory: false, size: 12, mtime: 0 }
    },
    async saveRemoteFile(remotePath, localPath, options) {
      calls.push({ remotePath, localPath, options })
      await writeFile(localPath, 'hello remote')
      return { size: 12 }
    },
  })
  const result = await readHostDownload(runtime, '/home/ubuntu/report.md', { destination: base, home: tmpdir() })
  assert.equal(result.kind, 'file')
  assert.equal(result.name, 'report (2).md')
  assert.equal(result.destination, path.join(base, 'report (2).md'))
  assert.equal(result.files, 1)
  assert.equal(await readFile(result.destination, 'utf8'), 'hello remote')
  assert.equal(calls.length, 1)
})

test('readHostDownload saves a folder into a unique local directory', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-folder-download-'))
  const calls = []
  const runtime = runtimeWith({
    async inspectRemotePath() {
      return { isFile: false, isDirectory: true, size: 0, mtime: 0 }
    },
    async saveRemoteTree(remotePath, targetRoot, options) {
      calls.push({ remotePath, targetRoot, options })
      await mkdir(targetRoot, { recursive: true })
      await writeFile(path.join(targetRoot, 'a.txt'), 'abc')
      return { destination: targetRoot, totalBytes: 3, totalFiles: 1 }
    },
  })
  const result = await readHostDownload(runtime, '/home/ubuntu/project', { destination: base, home: tmpdir() })
  assert.equal(result.kind, 'folder')
  assert.equal(result.name, 'project')
  assert.equal(result.destination, path.join(base, 'project'))
  assert.equal(result.files, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].targetRoot, path.join(base, 'project'))
  const second = await readHostDownload(runtime, '/home/ubuntu/project', { destination: base, home: tmpdir() })
  assert.equal(second.destination, path.join(base, 'project (2)'))
})

test('readHostDownload renames the target file/folder when a file has the same name', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-folder-file-'))
  await writeFile(path.join(base, 'project'), 'existing file')
  const runtime = runtimeWith({
    async inspectRemotePath() {
      return { isFile: false, isDirectory: true, size: 0, mtime: 0 }
    },
    async saveRemoteTree(_remotePath, targetRoot) {
      await mkdir(targetRoot, { recursive: true })
      return { destination: targetRoot, totalBytes: 0, totalFiles: 0 }
    },
  })
  const result = await readHostDownload(runtime, '/home/ubuntu/project', { destination: base, home: tmpdir() })
  assert.equal(result.destination, path.join(base, 'project (2)'))
})

test('readHostDownload requires a destination for every download', async () => {
  const runtime = runtimeWith({
    async inspectRemotePath() {
      return { isFile: true, isDirectory: false, size: 0, mtime: 0 }
    },
  })
  await assert.rejects(readHostDownload(runtime, '/home/ubuntu/report.md'), /invalid-input/)
})

test('readHostDownload rejects unsupported paths and disconnected hosts', async () => {
  await assert.rejects(
    readHostDownload({ status: 'disconnected', ssh: null }, '/home/ubuntu/a.txt', {
      destination: tmpdir(),
      home: tmpdir(),
    }),
    /remote-file-unavailable/,
  )
  const weird = runtimeWith({
    async inspectRemotePath() {
      return { isFile: false, isDirectory: false, size: 0 }
    },
  })
  await assert.rejects(
    readHostDownload(weird, '/home/ubuntu/socket', { destination: tmpdir(), home: tmpdir() }),
    /remote-file-unavailable/,
  )
})

test('toRemoteFileError maps transport codes without leaking internals', () => {
  const missing = toRemoteFileError(Object.assign(new Error('No such file'), { code: 2 }))
  assert.equal(missing.code, 'remote-file-unavailable')
  assert.match(missing.detail.en, /no longer exists/)
  const denied = toRemoteFileError(Object.assign(new Error('Permission denied'), { code: 3 }))
  assert.equal(denied.code, 'remote-file-unavailable')
  assert.match(denied.detail.en, /not allowed/)
  const other = toRemoteFileError(new Error('unexpected disconnect'))
  assert.equal(other.technical, 'unexpected disconnect')
})

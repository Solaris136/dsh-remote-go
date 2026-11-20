import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeRemoteFilePath, remoteFileName } from '../../dist/src/remote-path.js'
import { readHostDownload, toRemoteFileError } from '../../dist/src/remote-files.js'

const runtimeWith = (ssh) => ({ id: 'h_1', status: 'connected', ssh })
const download = (runtime, remotePath, destination) =>
  readHostDownload(runtime, remotePath, { destination, home: tmpdir() })
/** One fake transport for both shapes; the kind only picks which inspect/save pair runs. */
function hostSsh({ kind, calls }) {
  const isFile = kind === 'file'
  return {
    inspectRemotePath: async () => ({ isFile, isDirectory: !isFile, size: 0, mtime: 0 }),
    async saveRemoteFile(remotePath, localPath, options) {
      calls.push({ remotePath, localPath, options })
      await writeFile(localPath, 'hello remote')
      return { size: 12 }
    },
    async saveRemoteTree(remotePath, targetRoot, options) {
      calls.push({ remotePath, targetRoot, options })
      await mkdir(targetRoot, { recursive: true })
      await writeFile(path.join(targetRoot, 'a.txt'), 'abc')
      return { destination: targetRoot, totalBytes: 3, totalFiles: 1 }
    },
  }
}

test('normalizeRemoteFilePath accepts absolute POSIX paths and rejects everything else', () => {
  assert.equal(normalizeRemoteFilePath('/home/ubuntu/report.md'), '/home/ubuntu/report.md')
  assert.equal(normalizeRemoteFilePath('/home//ubuntu/./report.md'), '/home/ubuntu/report.md')
  assert.equal(normalizeRemoteFilePath('/home/ubuntu/../ubuntu/report.md'), '/home/ubuntu/report.md')
  assert.equal(remoteFileName('/home/ubuntu/report.md'), 'report.md')
  assert.equal(remoteFileName('/'), 'download')
  // Relative, empty and control-character paths are rejected.
  for (const value of ['', '  ', 'home/ubuntu/a.txt', 'C:\\Users\\a.txt', '/home/\0/a', '/home/a\nb', null]) {
    assert.throws(() => normalizeRemoteFilePath(value), /invalid-input/)
  }
})

test('readHostDownload streams a file or folder into a unique local path', async () => {
  const fileBase = await mkdtemp(path.join(tmpdir(), 'dsh-file-download-'))
  await writeFile(path.join(fileBase, 'report.md'), 'already here')
  const fileCalls = []
  const fileRuntime = runtimeWith(hostSsh({ kind: 'file', calls: fileCalls }))
  const file = await download(fileRuntime, '/home/ubuntu/report.md', fileBase)
  assert.deepEqual([file.kind, file.name, file.files, fileCalls.length], ['file', 'report (2).md', 1, 1])
  assert.equal(file.destination, path.join(fileBase, 'report (2).md'))
  assert.equal(await readFile(file.destination, 'utf8'), 'hello remote')
  const folderBase = await mkdtemp(path.join(tmpdir(), 'dsh-folder-download-'))
  const folderCalls = []
  const folderRuntime = runtimeWith(hostSsh({ kind: 'folder', calls: folderCalls }))
  const folder = await download(folderRuntime, '/home/ubuntu/project', folderBase)
  assert.deepEqual([folder.kind, folder.name, folder.files, folderCalls.length], ['folder', 'project', 1, 1])
  assert.equal(folder.destination, path.join(folderBase, 'project'))
  assert.equal(folderCalls[0].targetRoot, path.join(folderBase, 'project'))
  const second = await download(folderRuntime, '/home/ubuntu/project', folderBase)
  assert.equal(second.destination, path.join(folderBase, 'project (2)'))
  // A plain file already holding the folder's name is renamed too, never overwritten.
  const collided = await mkdtemp(path.join(tmpdir(), 'dsh-folder-file-'))
  await writeFile(path.join(collided, 'project'), 'existing file')
  const collidedResult = await download(folderRuntime, '/home/ubuntu/project', collided)
  assert.equal(collidedResult.destination, path.join(collided, 'project (2)'))
})

test('readHostDownload requires a destination and rejects unavailable paths', async () => {
  const withDestination = runtimeWith(hostSsh({ kind: 'file', calls: [] }))
  await assert.rejects(readHostDownload(withDestination, '/home/ubuntu/report.md'), /invalid-input/)
  const options = { destination: tmpdir(), home: tmpdir() }
  const unavailable = (runtime, remotePath) =>
    assert.rejects(readHostDownload(runtime, remotePath, options), /remote-file-unavailable/)
  await unavailable({ status: 'disconnected', ssh: null }, '/home/ubuntu/a.txt')
  const socket = {
    id: 'h_1',
    status: 'connected',
    ssh: { inspectRemotePath: async () => ({ isFile: false, isDirectory: false, size: 0 }) },
  }
  await unavailable(socket, '/home/ubuntu/socket')
  const missing = toRemoteFileError(Object.assign(new Error('No such file'), { code: 2 }))
  assert.equal(missing.code, 'remote-file-unavailable')
  assert.match(missing.detail.en, /no longer exists/)
  const denied = toRemoteFileError(Object.assign(new Error('Permission denied'), { code: 3 }))
  assert.equal(denied.code, 'remote-file-unavailable')
  assert.match(denied.detail.en, /not allowed/)
  assert.equal(toRemoteFileError(new Error('unexpected disconnect')).technical, 'unexpected disconnect')
})

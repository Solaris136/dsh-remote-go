import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveHostFile, saveHostFolder, requireDestination } from '../../src/local-download.js'
import { isRemoteGoError } from '../../src/errors.js'

const connected = (ssh) => ({ status: 'connected', ssh })

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** assert.rejects matcher: a RemoteGoError carrying exactly `code`. */
const coded = (code) => (error) => {
  assert.ok(isRemoteGoError(error), `expected a RemoteGoError, got ${error?.name}: ${error?.message}`)
  assert.equal(error.code, code)
  return true
}

test('requireDestination accepts an existing directory and rejects everything else', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-destination-')
  assert.equal(await requireDestination(root), path.resolve(root))

  for (const value of [undefined, null, '', '   ', `${root}\0suffix`]) {
    await assert.rejects(() => requireDestination(value), coded('invalid-input'), `value ${JSON.stringify(value)}`)
  }

  const file = path.join(root, 'not-a-directory.txt')
  await writeFile(file, 'x')
  await assert.rejects(() => requireDestination(file), coded('invalid-input'))
  await assert.rejects(() => requireDestination(path.join(root, 'missing')), coded('invalid-input'))
})

test('saveHostFile requires a connected host with a file-capable transport', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-file-')
  await assert.rejects(() => saveHostFile(null, '/home/ubuntu/a.txt', root), coded('remote-file-unavailable'))
  await assert.rejects(
    () => saveHostFile({ status: 'disconnected', ssh: {} }, '/home/ubuntu/a.txt', root),
    coded('remote-file-unavailable'),
  )
  await assert.rejects(() => saveHostFile(connected({}), '/home/ubuntu/a.txt', root), coded('internal'))
})

test('saveHostFile streams one file and auto-renames an existing target', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-file-')
  const written = []
  const ssh = {
    async saveRemoteFile(remotePath, localPath, options) {
      written.push({ remotePath, localPath, options })
      await writeFile(localPath, 'downloaded')
      return { size: 10 }
    },
  }

  const first = await saveHostFile(connected(ssh), '/home/ubuntu/notes.txt', root, { onProgress() {} })
  assert.deepEqual(
    { kind: first.kind, name: first.name, path: first.path, files: first.files, totalBytes: first.totalBytes },
    {
      kind: 'file',
      name: 'notes.txt',
      path: '/home/ubuntu/notes.txt',
      files: 1,
      totalBytes: 10,
    },
  )
  assert.equal(first.destination, path.join(root, 'notes.txt'))
  assert.equal(await readFile(first.destination, 'utf8'), 'downloaded')
  assert.equal(written.length, 1)

  const second = await saveHostFile(connected(ssh), '/home/ubuntu/notes.txt', root)
  assert.equal(second.name, 'notes (2).txt')
  assert.equal(second.destination, path.join(root, 'notes (2).txt'))
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'downloaded')
})

test('saveHostFile removes a partial local file and maps an unknown transport failure', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-file-')
  const ssh = {
    async saveRemoteFile(_remotePath, localPath) {
      await writeFile(localPath, 'partial')
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    },
  }
  await assert.rejects(
    () => saveHostFile(connected(ssh), '/home/ubuntu/big.bin', root),
    (error) => coded('remote-file-unavailable')(error) && /connection reset/.test(error.technical),
  )
  await assert.rejects(() => stat(path.join(root, 'big.bin')), /ENOENT/)
})

test('saveHostFile preserves a coded error and still cleans the partial file', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-file-')
  const { errors } = await import('../../src/errors.js')
  const ssh = {
    async saveRemoteFile(_remotePath, localPath) {
      await writeFile(localPath, 'partial')
      throw errors.remoteFileUnavailable({ zh: '远端文件不存在。', en: 'The remote file does not exist.' })
    },
  }
  await assert.rejects(
    () => saveHostFile(connected(ssh), '/home/ubuntu/gone.bin', root),
    coded('remote-file-unavailable'),
  )
  await assert.rejects(() => stat(path.join(root, 'gone.bin')), /ENOENT/)
})

test('saveHostFolder requires a connected host with a tree-capable transport', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-folder-')
  await assert.rejects(() => saveHostFolder(null, '/home/ubuntu/reports', root), coded('remote-file-unavailable'))
  await assert.rejects(() => saveHostFolder(connected({}), '/home/ubuntu/reports', root), coded('internal'))
})

test('saveHostFolder copies one folder and auto-renames an existing target', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-folder-')
  const trees = []
  const ssh = {
    async saveRemoteTree(remotePath, targetRoot, options) {
      trees.push({ remotePath, targetRoot, options })
      await mkdir(path.join(targetRoot, 'nested'), { recursive: true })
      await writeFile(path.join(targetRoot, 'nested', 'a.txt'), 'a')
      return { destination: targetRoot, totalBytes: 1, totalFiles: 1 }
    },
  }

  const first = await saveHostFolder(connected(ssh), '/home/ubuntu/reports', root, { onInventory() {} })
  assert.deepEqual(
    { kind: first.kind, name: first.name, path: first.path, files: first.files, totalBytes: first.totalBytes },
    { kind: 'folder', name: 'reports', path: '/home/ubuntu/reports', files: 1, totalBytes: 1 },
  )
  assert.equal(first.destination, path.join(root, 'reports'))
  assert.equal(await readFile(path.join(first.destination, 'nested', 'a.txt'), 'utf8'), 'a')
  assert.equal(trees.length, 1)

  const second = await saveHostFolder(connected(ssh), '/home/ubuntu/reports', root)
  // A folder download keeps the remote name in `name`; only the local directory is renamed.
  assert.equal(second.name, 'reports')
  assert.equal(second.destination, path.join(root, 'reports (2)'))
})

test('saveHostFolder reports cancellation and removes a failed copy', async (t) => {
  const root = await tempRoot(t, 'dsh-remote-go-save-folder-')
  const cancelling = {
    async saveRemoteTree(_remotePath, targetRoot) {
      return { destination: targetRoot, totalBytes: 3, totalFiles: 2, cancelled: true }
    },
  }
  const cancelled = await saveHostFolder(connected(cancelling), '/home/ubuntu/partial', root)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.files, 2)

  const failing = {
    async saveRemoteTree() {
      throw Object.assign(new Error('SFTP closed'), { code: 'ECONNRESET' })
    },
  }
  await assert.rejects(
    () => saveHostFolder(connected(failing), '/home/ubuntu/broken', root),
    (error) => coded('remote-file-unavailable')(error) && /SFTP closed/.test(error.technical),
  )
  await assert.rejects(() => stat(path.join(root, 'broken')), /ENOENT/)
})

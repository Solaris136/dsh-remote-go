import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listKeyFiles } from '../../src/key-files.js'

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-keyfiles-'))
  await mkdir(path.join(home, '.ssh'), { recursive: true })
  await writeFile(path.join(home, '.ssh', 'id_ed25519'), 'KEY', 'utf8')
  await writeFile(path.join(home, '.ssh', 'config'), 'Host x', 'utf8')
  await writeFile(path.join(home, '.ssh', 'notes.txt'), 'hi', 'utf8')
  await mkdir(path.join(home, '.ssh', 'sub'), { recursive: true })
  return home
}

async function assertSamePath(actual, expected) {
  assert.equal(await realpath(actual), await realpath(expected))
}

test('listKeyFiles defaults to ~/.ssh and lists folders before files', async () => {
  const home = await makeHome()
  const listing = await listKeyFiles({ home })
  await assertSamePath(listing.path, path.join(home, '.ssh'))
  assert.equal(listing.entries[0].isDirectory, true)
  assert.equal(listing.entries[0].name, 'sub')
  const names = listing.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name)
  assert.deepEqual(names, ['config', 'id_ed25519', 'notes.txt'])
  assert.equal(listing.truncated, false)
  await assertSamePath(listing.parent, home)
})

test('listKeyFiles expands a leading tilde and walks into subdirectories', async () => {
  const home = await makeHome()
  const listing = await listKeyFiles({ home, dir: '~/.ssh/sub' })
  await assertSamePath(listing.path, path.join(home, '.ssh', 'sub'))
  assert.deepEqual(listing.entries, [])
  await assertSamePath(listing.parent, path.join(home, '.ssh'))
})

test('listKeyFiles refuses to escape the home directory', async () => {
  const home = await makeHome()
  await assert.rejects(() => listKeyFiles({ home, dir: path.join(home, '..') }), /inside the home directory/)
  await assert.rejects(() => listKeyFiles({ home, dir: path.join(home, '..', '..') }), /inside the home directory/)
  await assert.rejects(() => listKeyFiles({ home, dir: tmpdir() }), /inside the home directory/)
})

test('listKeyFiles reports a missing directory instead of inventing an empty one', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-keyfiles-empty-'))
  await assert.rejects(() => listKeyFiles({ home }), /ENOENT/)
})

test('listKeyFiles only reports regular files and directories', async () => {
  const home = await makeHome()
  const listing = await listKeyFiles({ home })
  for (const entry of listing.entries) {
    assert.equal(typeof entry.name, 'string')
    await assertSamePath(path.dirname(entry.path), path.join(home, '.ssh'))
    assert.equal(typeof entry.isDirectory, 'boolean')
  }
})

test('listKeyFiles stays internally consistent when realpath reports another spelling', async () => {
  const requested = path.resolve(path.join('spelling-input'))
  const canonical = requested + '-canonical'
  const fsImpl = {
    async realpath(value) {
      if (value === requested) return canonical
      if (value === path.join(requested, '.ssh')) return path.join(canonical, '.ssh')
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readdir(dir) {
      assert.equal(dir, path.join(canonical, '.ssh'))
      return [
        { name: 'id_ed25519', isDirectory: () => false, isFile: () => true },
        { name: 'sub', isDirectory: () => true, isFile: () => false },
      ]
    },
  }
  const listing = await listKeyFiles({ home: requested, fsImpl })
  assert.equal(listing.path, path.join(canonical, '.ssh'))
  assert.equal(listing.parent, canonical)
  assert.deepEqual(
    listing.entries.map((entry) => entry.path),
    [path.join(canonical, '.ssh', 'sub'), path.join(canonical, '.ssh', 'id_ed25519')],
  )
})

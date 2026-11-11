import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseWorkspaceStorage,
  readLocalWorkspaces,
  readRemoteWorkspaces,
  remoteWorkspaceStoragePath,
} from '../../src/workspaces.js'

const STORAGE = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: 'ws-default',
    workspaceIds: ['ws-b', 'ws-a', 'ws-default'],
  },
  tables: {
    workspaces: {
      'ws-default': {
        path: '/home/u/default-workspace',
        title: 'default-workspace',
        sessionIds: ['s1', 's2'],
        createdAt: 'c',
        updatedAt: 'u',
      },
      'ws-a': { path: '/home/u/proj-a', title: '', sessionIds: [] },
      'ws-b': { path: '/home/u/proj-b', title: 'project B', sessionIds: ['s3'], createdAt: 'c2', updatedAt: 'u2' },
      'ws-orphan': { path: '/home/u/orphan', title: 'orphan', sessionIds: [] },
    },
  },
}

test('parseWorkspaceStorage follows the global order and appends orphans', () => {
  const parsed = parseWorkspaceStorage(STORAGE)
  assert.equal(parsed.initialized, true)
  assert.equal(parsed.defaultWorkspaceId, 'ws-default')
  assert.deepEqual(
    parsed.workspaces.map((workspace) => workspace.id),
    ['ws-b', 'ws-a', 'ws-default', 'ws-orphan'],
  )
  const [b, a, def] = parsed.workspaces
  assert.equal(b.title, 'project B')
  assert.equal(b.sessionCount, 1)
  assert.equal(b.isDefault, false)
  // Empty title falls back to the path basename.
  assert.equal(a.title, 'proj-a')
  assert.equal(def.isDefault, true)
  assert.equal(def.sessionCount, 2)
  // v1.1 additive field: the L1 mirror plans one descriptor per session id.
  assert.deepEqual(def.sessionIds, ['s1', 's2'])
  assert.deepEqual(b.sessionIds, ['s3'])
  assert.deepEqual(a.sessionIds, [])
})

test('parseWorkspaceStorage is defensive about missing/malformed data', () => {
  assert.deepEqual(parseWorkspaceStorage(null), { initialized: false, defaultWorkspaceId: null, workspaces: [] })
  assert.deepEqual(parseWorkspaceStorage('nope'), { initialized: false, defaultWorkspaceId: null, workspaces: [] })
  const partial = parseWorkspaceStorage({
    global: { initialized: true, workspaceIds: ['x'] },
    tables: { workspaces: { x: { path: '/p/x' } } },
  })
  assert.equal(partial.workspaces.length, 1)
  assert.equal(partial.workspaces[0].title, 'x')
  assert.equal(partial.workspaces[0].sessionCount, 0)
  assert.equal(partial.workspaces[0].isDefault, false)
})

test('readLocalWorkspaces reads the local registry file and tolerates missing/corrupt files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-ws-'))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path.join(home, 'storages'), { recursive: true })
  await writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify(STORAGE), 'utf8')
  const loaded = await readLocalWorkspaces({ home })
  assert.equal(loaded.source, 'file')
  assert.equal(loaded.workspaces.length, 4)

  const emptyHome = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-ws-empty-'))
  const missing = await readLocalWorkspaces({ home: emptyHome })
  assert.equal(missing.initialized, false)
  assert.deepEqual(missing.workspaces, [])

  await mkdir(path.join(emptyHome, 'storages'), { recursive: true })
  await writeFile(path.join(emptyHome, 'storages', 'workspace.json'), '{broken', 'utf8')
  const corrupt = await readLocalWorkspaces({ home: emptyHome })
  assert.equal(corrupt.initialized, false)
})

test('remoteWorkspaceStoragePath and readRemoteWorkspaces use the SSH exec channel', async () => {
  assert.equal(
    remoteWorkspaceStoragePath('/home/u/.dsh-remote-go/home/'),
    '/home/u/.dsh-remote-go/home/storages/workspace.json',
  )
  const calls = []
  const ssh = {
    async exec(command) {
      calls.push(command)
      return { code: 0, stdout: JSON.stringify(STORAGE), stderr: '' }
    },
  }
  const result = await readRemoteWorkspaces(ssh, '/home/u/.dsh-remote-go/home')
  assert.equal(result.ok, true)
  assert.equal(result.workspaces.length, 4)
  assert.match(calls[0], /cat '\/home\/u\/\.dsh-remote-go\/home\/storages\/workspace\.json'/)

  const missing = {
    async exec() {
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  assert.equal((await readRemoteWorkspaces(missing, '/home/u/home')).ok, false)
  const broken = {
    async exec() {
      return { code: 0, stdout: '{oops', stderr: '' }
    },
  }
  const brokenResult = await readRemoteWorkspaces(broken, '/home/u/home')
  assert.equal(brokenResult.ok, false)
  assert.equal(brokenResult.reason, 'malformed')
})

test('sessionIds are deduplicated so sessionCount keeps the v1 count of sessions', () => {
  // Duplicates and non-string junk are not separate sessions; the v1 count must
  // equal the deduplicated list the L1 mirror plans one descriptor per.
  const parsed = parseWorkspaceStorage({
    global: { initialized: true, workspaceIds: ['ws'] },
    tables: {
      workspaces: { ws: { path: '/p/ws', sessionIds: ['a', 'a', '', 'b', 42, 'b', 'c'] } },
    },
  })
  const [workspace] = parsed.workspaces
  assert.deepEqual(workspace.sessionIds, ['a', 'b', 'c'])
  assert.equal(workspace.sessionCount, 3)
  assert.equal(workspace.sessionCount, new Set(workspace.sessionIds).size)
})

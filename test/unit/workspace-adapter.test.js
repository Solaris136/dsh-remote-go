/**
 * Unit coverage for the sidebar workspace adapter (src/workspace-adapter.js).
 *
 * The fake registry below reproduces only the four `workspaceRegistry` behaviours
 * this adapter relies on (verified with Cordis Inspect, docs/session-design.md
 * §4.3): `create(path, title)` requires an existing directory and is idempotent
 * per canonical path, `resolveByPath(path)` answers without creating, `delete(id)`
 * removes the registration, and `Workspace.setTitle()` renames one.
 *
 * No real DSH host is involved, so the suite also proves the "never throw into
 * the connect path" contract by making the registry reject.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSessionAdapter } from '../../src/session-adapter.js'
import { createWorkspaceAdapter, hostWorkspaceTitle, WORKSPACE_TITLE_PREFIX } from '../../src/workspace-adapter.js'

/**
 * A registry double with the durable-registry semantics the adapter needs.
 * @param {{ failCreate?: boolean, failDelete?: boolean, failResolve?: boolean }} [options]
 */
function createFakeRegistry(options = {}) {
  /** @type {{ create: { path: string, title: string | undefined }[], resolve: string[], delete: string[] }} */
  const calls = { create: [], resolve: [], delete: [] }
  /** @type {Map<string, any>} */
  const byPath = new Map()
  /** @type {Map<string, any>} */
  const byId = new Map()
  let seq = 0
  const registry = {
    /** @type {string[]} */
    get order() {
      return [...byPath.keys()]
    },
    async create(dir, title) {
      calls.create.push({ path: dir, title })
      if (options.failCreate === true) throw new Error('registry refused the create')
      const existing = byPath.get(dir)
      // Idempotent per contract: same canonical path returns the same entity and
      // does not retitle it.
      if (existing) return existing
      const workspace = {
        id: `ws_${(seq += 1)}`,
        path: dir,
        title: title ?? path.basename(dir),
        createdAt: '2026-11-11T00:00:00.000Z',
        updatedAt: '2026-11-11T00:00:00.000Z',
        /** @type {string[]} */
        sessionIds: [],
        /** @param {string} next */
        async setTitle(next) {
          workspace.title = next
        },
      }
      byPath.set(dir, workspace)
      byId.set(workspace.id, workspace)
      return workspace
    },
    async resolveByPath(dir) {
      calls.resolve.push(dir)
      if (options.failResolve === true) throw new Error('realpath failed')
      return byPath.get(dir)
    },
    async delete(id) {
      calls.delete.push(id)
      if (options.failDelete === true) throw new Error('registry refused the delete')
      const workspace = byId.get(id)
      if (!workspace) return false
      byId.delete(id)
      byPath.delete(workspace.path)
      return true
    },
    list() {
      return [...byId.values()]
    },
  }
  return { registry, calls }
}

/** Collect warnings instead of printing them. @param {string[]} lines */
function createLogger(lines) {
  return {
    warn: (...args) => lines.push(args.map((value) => String(value)).join(' ')),
    info: () => {},
    debug: () => {},
  }
}

/** @returns {Promise<string>} */
async function makeTempRoot() {
  return await mkdtemp(path.join(tmpdir(), 'dsh-workspace-adapter-'))
}

test('hostWorkspaceTitle prefixes the host name and always yields a title', () => {
  assert.equal(hostWorkspaceTitle('Tencent VM'), 'Remote: Tencent VM')
  assert.equal(hostWorkspaceTitle('  spaced  '), 'Remote: spaced')
  assert.equal(hostWorkspaceTitle('', 'h_123'), 'Remote: h_123')
  assert.equal(hostWorkspaceTitle(null, ''), 'Remote: remote')
  assert.ok(hostWorkspaceTitle('x').startsWith(WORKSPACE_TITLE_PREFIX))
})

test('ensureHostWorkspace registers one workspace at the per-host mirror directory', async () => {
  const root = await makeTempRoot()
  /** @type {string[]} */
  const warnings = []
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root, logger: createLogger(warnings) })
    const result = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })

    assert.equal(result.ok, true)
    assert.equal(result.created, true)
    assert.equal(result.enabled, true)
    assert.equal(result.reason, null)
    assert.equal(result.path, path.join(root, 'h_abc'))
    assert.equal(result.title, 'Remote: Tencent VM')
    assert.match(String(result.workspaceId), /^ws_/)
    assert.deepEqual(calls.create, [{ path: path.join(root, 'h_abc'), title: 'Remote: Tencent VM' }])
    assert.equal(registry.list().length, 1)
    assert.deepEqual(warnings, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureHostWorkspace is idempotent across reconnects', async () => {
  const root = await makeTempRoot()
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    const first = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })
    const second = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })

    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.workspaceId, first.workspaceId)
    // The registry is asked once; the second call resolves the existing entity.
    assert.equal(calls.create.length, 1)
    assert.equal(registry.list().length, 1, 'a reconnect must not create a duplicate workspace')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureHostWorkspace is a no-op when the setting is off', async () => {
  const root = await makeTempRoot()
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    const result = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM', enabled: false })

    assert.equal(result.ok, true)
    assert.equal(result.enabled, false)
    assert.equal(result.reason, 'disabled')
    assert.equal(result.workspaceId, null)
    assert.equal(result.path, null)
    assert.deepEqual(calls.create, [])
    assert.deepEqual(calls.resolve, [])
    assert.equal(registry.list().length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removeHostWorkspace deletes the registration and stays safe when repeated', async () => {
  const root = await makeTempRoot()
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    const ensured = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })

    const removed = await adapter.removeHostWorkspace({ hostId: 'h_abc' })
    assert.equal(removed.ok, true)
    assert.equal(removed.removed, true)
    assert.equal(removed.workspaceId, ensured.workspaceId)
    assert.deepEqual(calls.delete, [ensured.workspaceId])
    assert.equal(registry.list().length, 0)

    // A second delete (double click, retry after a crash) is a no-op, not an error.
    const again = await adapter.removeHostWorkspace({ hostId: 'h_abc' })
    assert.equal(again.ok, true)
    assert.equal(again.removed, false)
    assert.equal(again.reason, 'not-found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing registry is logged and degrades instead of throwing', async () => {
  const root = await makeTempRoot()
  /** @type {string[]} */
  const warnings = []
  try {
    const { registry } = createFakeRegistry({ failCreate: true })
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root, logger: createLogger(warnings) })

    const result = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'create-failed')
    assert.match(String(result.error), /registry refused the create/)
    assert.equal(warnings.length, 1, 'the failure must be logged')
    assert.match(warnings[0], /cannot register the mirror workspace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing delete is logged and degrades instead of throwing', async () => {
  const root = await makeTempRoot()
  /** @type {string[]} */
  const warnings = []
  try {
    const { registry } = createFakeRegistry({ failDelete: true })
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root, logger: createLogger(warnings) })
    await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })

    const removed = await adapter.removeHostWorkspace({ hostId: 'h_abc' })
    assert.equal(removed.ok, false)
    assert.equal(removed.reason, 'delete-failed')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /cannot remove the mirror workspace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an absent registry or mirror root answers typed reasons', async () => {
  const adapter = createWorkspaceAdapter({ mirrorRoot: null })
  assert.equal(adapter.available(), false)
  const ensured = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'x' })
  assert.equal(ensured.ok, false)
  assert.equal(ensured.reason, 'no-mirror-root')

  const root = await makeTempRoot()
  try {
    const { registry } = createFakeRegistry()
    const withRoot = createWorkspaceAdapter({ registry, mirrorRoot: root })
    assert.equal(withRoot.available(), true)
    const invalid = await withRoot.ensureHostWorkspace({ hostId: '' })
    assert.equal(invalid.reason, 'invalid-host')

    const withoutService = createWorkspaceAdapter({ mirrorRoot: root })
    const unavailable = await withoutService.ensureHostWorkspace({ hostId: 'h_abc' })
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.reason, 'workspaces-unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a host rename retitles plugin-owned workspaces but never a user rename', async () => {
  const root = await makeTempRoot()
  try {
    const { registry } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'old name' })

    const renamed = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'new name' })
    assert.equal(renamed.ok, true)
    assert.equal(renamed.created, false)
    assert.equal(renamed.renamed, true)
    assert.equal(renamed.title, 'Remote: new name')
    assert.equal(registry.list()[0].title, 'Remote: new name')

    // A title the user typed no longer carries our prefix; keep it.
    await registry.list()[0].setTitle('My own grouping')
    const kept = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'third name' })
    assert.equal(kept.renamed, false)
    assert.equal(registry.list()[0].title, 'My own grouping')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the workspace path is exactly the cwd the session adapter gives its sessions', async () => {
  const root = await makeTempRoot()
  try {
    const { registry } = createFakeRegistry()
    const workspaceAdapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    /** @type {{ id: string, options: any }[]} */
    const created = []
    const sessions = {
      create(id, options) {
        created.push({ id, options })
        return { id, append() {} }
      },
      get() {
        return undefined
      },
    }
    const sessionAdapter = createSessionAdapter({ sessions, mirrorRoot: root })
    sessionAdapter.ensureMirrorSession({ hostId: 'h_abc', remoteSessionId: 'sess-1' })

    // DSH derives workspace membership from the session header's canonical cwd,
    // so these two paths must be byte-identical, not merely "equivalent".
    assert.equal(created.length, 1)
    assert.equal(created[0].options.meta.cwd, workspaceAdapter.hostDir('h_abc'))
    assert.equal(created[0].options.meta.cwd, path.join(root, 'h_abc'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host ids cannot escape the mirror root', async () => {
  const root = await makeTempRoot()
  try {
    const adapter = createWorkspaceAdapter({ registry: createFakeRegistry().registry, mirrorRoot: root })
    for (const hostile of ['../../etc', '..', '.', '', 'a/b\\c']) {
      const dir = adapter.hostDir(hostile)
      assert.ok(dir, `no directory for ${JSON.stringify(hostile)}`)
      assert.equal(path.dirname(dir), path.resolve(root), `${JSON.stringify(hostile)} escaped the mirror root`)
      assert.ok(dir.startsWith(path.resolve(root) + path.sep), `unexpected directory for ${JSON.stringify(hostile)}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

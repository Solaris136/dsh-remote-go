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
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { canonicalMirrorRoot, createSessionAdapter } from '../../src/session-adapter.js'
import { createWorkspaceAdapter, hostWorkspaceTitle, WORKSPACE_TITLE_PREFIX } from '../../src/workspace-adapter.js'

/**
 * A registry double with the durable-registry semantics the adapter needs.
 * `canonicalPath` emulates `fs.realpath` inside the real registry: the stored
 * entity (and every lookup) uses that path, so a test can prove the adapter
 * reports the registry's canonical spelling rather than the literal input.
 * @param {{ failCreate?: boolean, failDelete?: boolean, failResolve?: boolean, canonicalPath?: (dir: string) => string }} [options]
 */
function createFakeRegistry(options = {}) {
  /** @type {{ create: { path: string, title: string | undefined }[], resolve: string[], delete: string[] }} */
  const calls = { create: [], resolve: [], delete: [] }
  /** @type {Map<string, any>} */
  const byPath = new Map()
  /** @type {Map<string, any>} */
  const byId = new Map()
  let seq = 0
  /** @param {string} dir */
  const canonical = (dir) => (typeof options.canonicalPath === 'function' ? options.canonicalPath(dir) : dir)
  const registry = {
    /** @type {string[]} */
    get order() {
      return [...byPath.keys()]
    },
    async create(dir, title) {
      calls.create.push({ path: dir, title })
      if (options.failCreate === true) throw new Error('registry refused the create')
      const key = canonical(dir)
      const existing = byPath.get(key)
      // Idempotent per contract: same canonical path returns the same entity and
      // does not retitle it.
      if (existing) return existing
      const workspace = {
        id: `ws_${(seq += 1)}`,
        path: key,
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
      byPath.set(key, workspace)
      byId.set(workspace.id, workspace)
      return workspace
    },
    async resolveByPath(dir) {
      calls.resolve.push(dir)
      if (options.failResolve === true) throw new Error('realpath failed')
      return byPath.get(canonical(dir))
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
    /** Test-only: register an entity the adapter never created. @param {string} dir @param {string} title */
    async seed(dir, title = 'seeded') {
      return await registry.create(canonical(dir), title)
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

test('enabled:false unregisters an existing workspace instead of only skipping', async () => {
  const root = await makeTempRoot()
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    const ensured = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })
    assert.equal(ensured.created, true)

    // Turning the setting off must remove the group: a plain skip would leave
    // "Remote: Tencent VM" visible forever (mirror sessions are memory-only).
    const disabled = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM', enabled: false })
    assert.equal(disabled.ok, true)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.reason, 'disabled')
    assert.equal(disabled.removed, true)
    assert.equal(disabled.workspaceId, ensured.workspaceId)
    assert.equal(disabled.path, ensured.path)
    assert.deepEqual(calls.delete, [ensured.workspaceId])
    assert.equal(registry.list().length, 0)

    // Idempotent: a second disable has nothing left to remove and stays ok.
    const again = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM', enabled: false })
    assert.equal(again.ok, true)
    assert.equal(again.removed, false)
    assert.equal(again.reason, 'disabled')
    assert.equal(calls.delete.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enabled:false never creates a workspace when nothing is registered', async () => {
  const root = await makeTempRoot()
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    const result = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM', enabled: false })

    assert.equal(result.ok, true)
    assert.equal(result.enabled, false)
    assert.equal(result.reason, 'disabled')
    assert.equal(result.removed, false)
    assert.equal(result.workspaceId, null)
    assert.deepEqual(calls.create, [])
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

// ---------------------------------------------------------------------------
// ctx resolution: the production path is ctx.get('workspaceRegistry')
// ---------------------------------------------------------------------------

test('the registry resolves through ctx.get and a throwing ctx degrades', async () => {
  const root = await makeTempRoot()
  /** @type {string[]} */
  const warnings = []
  try {
    const { registry, calls } = createFakeRegistry()

    const viaCtx = createWorkspaceAdapter({
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
      mirrorRoot: root,
      logger: createLogger(warnings),
    })
    assert.equal(viaCtx.available(), true)
    const ensured = await viaCtx.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'Tencent VM' })
    assert.equal(ensured.ok, true)
    assert.equal(ensured.created, true)
    assert.equal(calls.create.length, 1)

    // The plugin must keep working when the optional service is absent…
    const missing = createWorkspaceAdapter({
      ctx: { get: () => undefined },
      mirrorRoot: root,
      logger: createLogger(warnings),
    })
    assert.equal(missing.available(), false)
    const unavailable = await missing.ensureHostWorkspace({ hostId: 'h_abc' })
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.reason, 'workspaces-unavailable')
    // …and when resolving it throws.
    const broken = createWorkspaceAdapter({
      ctx: {
        get() {
          throw new Error('cordis exploded')
        },
      },
      mirrorRoot: root,
      logger: createLogger(warnings),
    })
    assert.equal(broken.available(), false)
    assert.equal((await broken.ensureHostWorkspace({ hostId: 'h_abc' })).reason, 'workspaces-unavailable')
    assert.equal(warnings.filter((line) => line.includes('cannot resolve the workspace registry')).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removeHostWorkspace without a registry answers workspaces-unavailable', async () => {
  const root = await makeTempRoot()
  try {
    const adapter = createWorkspaceAdapter({ mirrorRoot: root })
    const removed = await adapter.removeHostWorkspace({ hostId: 'h_abc' })
    assert.equal(removed.ok, false)
    assert.equal(removed.reason, 'workspaces-unavailable')
    assert.equal(removed.removed, false)
    assert.equal(removed.path, path.join(root, 'h_abc'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// canonical path reporting (the registry realpaths every registration)
// ---------------------------------------------------------------------------

test('the reported path is the registry-canonical one, not the literal directory', async () => {
  const root = await makeTempRoot()
  try {
    // Emulate a junctioned root: the registry records the realpath, while the
    // adapter asked with the literal spelling.
    const canonicalRoot = path.join(root, 'real-mirrors')
    const literalRoot = path.join(root, 'linked-mirrors')
    const { registry } = createFakeRegistry({
      canonicalPath: (dir) => path.join(canonicalRoot, path.basename(dir)),
    })
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: literalRoot })

    const created = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'VM' })
    assert.equal(created.ok, true)
    assert.equal(created.path, path.join(canonicalRoot, 'h_abc'), 'created: report the canonical path')

    const reused = await adapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'VM' })
    assert.equal(reused.created, false)
    assert.equal(reused.path, path.join(canonicalRoot, 'h_abc'), 'reused: report the canonical path')

    const removed = await adapter.removeHostWorkspace({ hostId: 'h_abc' })
    assert.equal(removed.ok, true)
    assert.equal(removed.path, path.join(canonicalRoot, 'h_abc'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// orphan sweep (ghost groups left by a failed unregister)
// ---------------------------------------------------------------------------

test('pruneOrphanWorkspaces deletes registrations whose host is gone, and nothing else', async () => {
  const root = await makeTempRoot()
  try {
    const { registry, calls } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root })
    // Two live hosts, one ghost, plus registrations the plugin must not touch.
    await adapter.ensureHostWorkspace({ hostId: 'h_live', hostName: 'live' })
    await adapter.ensureHostWorkspace({ hostId: 'h_live2', hostName: 'live2' })
    // The ghost's directory exists (the plugin created it while the host lived).
    await mkdir(path.join(root, 'h_ghost'), { recursive: true })
    await registry.seed(path.join(root, 'h_ghost'), 'Remote: ghost')
    const outside = path.join(root, '..', 'somewhere-else')
    await registry.seed(outside, 'Not ours')
    await registry.seed(root, 'The root itself')

    const result = await adapter.pruneOrphanWorkspaces({ hostIds: ['h_live', 'h_live2'] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.removed, [path.join(root, 'h_ghost')])
    assert.equal(result.kept, 4, 'both live hosts, the outside registration and the root stay')
    assert.deepEqual(
      registry
        .list()
        .map((workspace) => path.basename(workspace.path))
        .sort(),
      ['h_live', 'h_live2', path.basename(root), 'somewhere-else'].sort(),
    )
    assert.deepEqual(calls.delete.length, 1)
    // Only the registration goes away: the directories stay on disk.
    assert.equal((await stat(path.join(root, 'h_ghost'))).isDirectory(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pruneOrphanWorkspaces keeps everything on an unusable registry and never throws', async () => {
  const root = await makeTempRoot()
  /** @type {string[]} */
  const warnings = []
  try {
    const withoutService = createWorkspaceAdapter({ mirrorRoot: root, logger: createLogger(warnings) })
    const unavailable = await withoutService.pruneOrphanWorkspaces({ hostIds: [] })
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.reason, 'workspaces-unavailable')
    assert.deepEqual(unavailable.removed, [])

    const { registry } = createFakeRegistry()
    const adapter = createWorkspaceAdapter({ registry, mirrorRoot: root, logger: createLogger(warnings) })
    await registry.seed(path.join(root, 'h_ghost'))
    const failing = {
      list: () => registry.list(),
      delete: async () => {
        throw new Error('delete exploded')
      },
    }
    const broken = createWorkspaceAdapter({ registry: failing, mirrorRoot: root, logger: createLogger(warnings) })
    const result = await broken.pruneOrphanWorkspaces({ hostIds: [] })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'prune-failed')
    assert.equal(warnings.filter((line) => line.includes('cannot prune orphan mirror workspaces')).length, 1)
    assert.equal(adapter.available(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// canonical mirror root (symlinked / junctioned $DSH_HOME)
// ---------------------------------------------------------------------------

test('canonicalMirrorRoot resolves a symlinked root so both adapters agree', async () => {
  const root = await makeTempRoot()
  try {
    const real = path.join(root, 'real-mirrors')
    const link = path.join(root, 'linked-mirrors')
    await mkdir(real, { recursive: true })
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')

    const canonical = canonicalMirrorRoot(link)
    // A junction may store the 8.3 short spelling of its target (GitHub's Windows
    // runner does), so compare the fully resolved physical directories rather than
    // the literal strings the junction happened to be created with.
    assert.equal(await realpath(canonical), await realpath(real))
    // Deliberately *not* asserting that `canonical` is a realpath fixed point: on some Windows
    // volumes (GitHub's runner among them) the sync and async realpath results disagree on 8.3
    // short names, so that assumption does not hold universally. What matters for grouping is
    // that both adapters receive this one string, which the assertions below cover.

    // Both adapters are fed that one canonical root, so the session's cwd and the
    // workspace path are the same string by construction — even though the user's
    // DSH_HOME reaches the root through a junction.
    const { registry } = createFakeRegistry()
    const workspaceAdapter = createWorkspaceAdapter({ registry, mirrorRoot: canonical })
    /** @type {any[]} */
    const created = []
    const sessionAdapter = createSessionAdapter({
      sessions: {
        create(id, options) {
          created.push({ id, options })
          return { id, append() {} }
        },
        get: () => undefined,
      },
      mirrorRoot: canonical,
    })
    sessionAdapter.ensureMirrorSession({ hostId: 'h_abc', remoteSessionId: 'sess-1' })
    const ensured = await workspaceAdapter.ensureHostWorkspace({ hostId: 'h_abc', hostName: 'VM' })

    assert.equal(created[0].options.meta.cwd, ensured.path)
    assert.equal(ensured.path, path.join(canonical, 'h_abc'))
    assert.ok(!ensured.path.startsWith(link), 'the literal (linked) spelling must not leak out')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('canonicalMirrorRoot creates a missing root and falls back on failure', async () => {
  const root = await makeTempRoot()
  /** @type {string[]} */
  const warnings = []
  try {
    const missing = path.join(root, 'not-yet', 'mirrors')
    const canonical = canonicalMirrorRoot(missing)
    assert.equal(await realpath(canonical), await realpath(missing))
    assert.equal((await stat(canonical)).isDirectory(), true)

    // A path whose parent is a file cannot be created: fall back to the literal.
    const blocker = path.join(root, 'blocker')
    await writeFile(blocker, 'not a directory')
    const impossible = path.join(blocker, 'mirrors')
    assert.equal(canonicalMirrorRoot(impossible, { logger: createLogger(warnings) }), impossible)
    assert.equal(warnings.filter((line) => line.includes('cannot canonicalize the mirror root')).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the production call site hands canonicalMirrorRoot an options object', async () => {
  // Regression: `canonicalMirrorRoot(dir, logger)` silently used console instead of the plugin
  // logger, because the second parameter is an options bag (`{ logger }`), not a logger.
  const source = await readFile(new URL('../../src/index.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /canonicalMirrorRoot\(\s*path\.join\(stateDir,\s*'mirrors'\),\s*\{\s*logger\s*\}\s*\)/,
    'src/index.js must call canonicalMirrorRoot with an options object',
  )
  assert.equal(
    /canonicalMirrorRoot\([^)]*,\s*logger\s*\)/.test(source),
    false,
    'src/index.js must not pass the logger itself as the options bag',
  )
})

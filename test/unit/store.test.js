import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as realFs, existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HostStore, resolveDshHome, resolveStateDir } from '../../src/store.js'

/**
 * An fs shim that gates the first temp-file write so a test can interleave a
 * second write deterministically. It works for both writer shapes the stores have
 * used (`open(tmp, 'wx')` + handle write, and `writeFile(tmp, …)`), so the same
 * test fails on a writer without a lock.
 */
function gatedFirstWriteFs() {
  let openFirst = () => {}
  const firstOpened = new Promise((resolve) => {
    openFirst = () => resolve(undefined)
  })
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined)
  })
  let gated = false
  /** @type {string[]} */
  const opened = []
  /** @type {string[]} */
  const unlinked = []
  let signalRename = () => {}
  const renamed = new Promise((resolve) => {
    signalRename = () => {
      resolve(undefined)
      // Keep later renames from re-resolving (Promise ignores them anyway).
      signalRename = () => {}
    }
  })
  /** @param {unknown} target */
  const gateOnce = (target) => {
    if (gated || typeof target !== 'string' || !target.endsWith('.tmp')) return false
    gated = true
    openFirst()
    return true
  }
  const fsImpl = new Proxy(realFs, {
    get(target, prop, receiver) {
      if (prop === 'open') {
        return async (/** @type {string} */ file, /** @type {string} */ flags, /** @type {number} */ mode) => {
          const handle = await realFs.open(file, flags, mode)
          opened.push(file)
          if (!gateOnce(file)) return handle
          return {
            writeFile: async (/** @type {string} */ text, /** @type {string} */ encoding) => {
              await gate
              return handle.writeFile(text, encoding)
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          }
        }
      }
      if (prop === 'writeFile') {
        return async (/** @type {string} */ file, ...rest) => {
          if (gateOnce(file)) await gate
          return realFs.writeFile(file, ...rest)
        }
      }
      if (prop === 'unlink') {
        return async (/** @type {string} */ file) => {
          unlinked.push(file)
          return realFs.unlink(file)
        }
      }
      if (prop === 'rename') {
        return async (/** @type {string} */ from, /** @type {string} */ to) => {
          const result = await realFs.rename(from, to)
          if (typeof to === 'string' && to.endsWith('hosts.json')) signalRename()
          return result
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { fs: fsImpl, firstOpened, release, renamed, opened, unlinked }
}

/**
 * Wrap the real fs and throw `EPERM` on the first `failures` renames whose target
 * ends with `suffix` (Windows behaviour when another process briefly holds it).
 * @param {string} suffix
 * @param {number} failures
 */
function flakyRenameFs(suffix, failures) {
  let remaining = failures
  return new Proxy(realFs, {
    get(target, prop, receiver) {
      if (prop === 'rename') {
        return async (/** @type {string} */ from, /** @type {string} */ to) => {
          if (typeof to === 'string' && to.endsWith(suffix) && remaining > 0) {
            remaining -= 1
            const error = new Error('busy')
            error.code = 'EPERM'
            throw error
          }
          return realFs.rename(from, to)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-store-'))
  const store = new HostStore({ dir, logger: { warn() {} } })
  await store.load()
  return { store, dir }
}

test('a fresh store has defaults and no hosts', async () => {
  const { store } = await tempStore()
  assert.deepEqual(store.listHosts(), [])
  assert.equal(store.getSettings().defaultPort, 22)
  assert.equal(store.getSettings().saveTokens, false)
})

test('upsertHost persists and is reloaded by a new store instance', async () => {
  const { store, dir } = await tempStore()
  const created = await store.upsertHost({ name: 'VM', address: 'ubuntu@example.com', port: 2222 })
  assert.ok(created.id.startsWith('h_'))
  assert.equal(store.listHosts().length, 1)

  const reloaded = new HostStore({ dir, logger: { warn() {} } })
  await reloaded.load()
  const hosts = reloaded.listHosts()
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].address, 'ubuntu@example.com')
  assert.equal(hosts[0].port, 2222)
  assert.equal(hosts[0].username, 'ubuntu')
})

test('upsertHost with an existing id updates instead of duplicating', async () => {
  const { store } = await tempStore()
  const created = await store.upsertHost({ address: 'host-a' })
  const updated = await store.upsertHost({ id: created.id, address: 'host-b', name: 'renamed' })
  assert.equal(store.listHosts().length, 1)
  assert.equal(updated.address, 'host-b')
  assert.equal(updated.name, 'renamed')
  assert.equal(updated.createdAt, created.createdAt)
})

test('patchHost merges fields and removeHost deletes', async () => {
  const { store } = await tempStore()
  const host = await store.upsertHost({ address: 'example.com' })
  const patched = await store.patchHost(host.id, {
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    pinnedFingerprint: 'SHA256:abc',
  })
  assert.equal(patched.lastOpenedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(patched.pinnedFingerprint, 'SHA256:abc')
  assert.equal(await store.removeHost(host.id), true)
  assert.equal(store.listHosts().length, 0)
  assert.equal(await store.removeHost('missing'), false)
})

test('settings round-trip and malformed file recovery', async () => {
  const { store, dir } = await tempStore()
  await store.saveSettings({ defaultPort: 2200, language: 'zh' })
  const reloaded = new HostStore({ dir, logger: { warn() {} } })
  await reloaded.load()
  assert.equal(reloaded.getSettings().defaultPort, 2200)
  assert.equal(reloaded.getSettings().language, 'zh')

  await writeFile(path.join(dir, 'settings.json'), '{not json', 'utf8')
  const recovered = new HostStore({ dir, logger: { warn() {} } })
  await recovered.load()
  assert.equal(recovered.getSettings().defaultPort, 22)
})

test('tokens are only stored when saveTokens is enabled', async () => {
  const { store, dir } = await tempStore()
  const host = await store.upsertHost({ address: 'example.com' })
  await store.saveToken(host.id, 'token-a')
  assert.equal(store.getToken(host.id), null)

  await store.saveSettings({ saveTokens: true })
  await store.saveToken(host.id, 'token-a')
  assert.equal(store.getToken(host.id), 'token-a')
  const secrets = JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8'))
  assert.equal(secrets[host.id], 'token-a')

  await store.saveSettings({ saveTokens: false })
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8')), {})
})

test('hosts.json never contains password fields', async () => {
  const { store, dir } = await tempStore()
  await store.upsertHost({ address: 'example.com', auth: { type: 'password' } })
  const raw = await readFile(path.join(dir, 'hosts.json'), 'utf8')
  // The auth *type* is fine; no secret value or token may ever be persisted.
  assert.doesNotMatch(raw, /"(passwordValue|passwordActual|passphrase|secret|token)"/)
  const parsed = JSON.parse(raw)
  assert.deepEqual(Object.keys(parsed[0].auth), ['type'])
})

test('resolveDshHome prefers DSH_HOME and falls back to the user home', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh')
  assert.equal(resolveDshHome({ USERPROFILE: 'C:\\Users\\u' }), path.join('C:\\Users\\u', '.dsh'))
  assert.equal(resolveStateDir('/custom/dsh'), path.join('/custom/dsh', 'remote-go'))
})

test('the shared atomic writer retries a busy rename for hosts.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-store-retry-'))
  // Two transient EPERM failures, then success: the old writer threw at once.
  const store = new HostStore({ dir, logger: { warn() {} }, fsImpl: flakyRenameFs('hosts.json', 2) })
  await store.load()
  const host = await store.upsertHost({ address: 'retry.example.com' })
  assert.ok(host.id)
  const raw = JSON.parse(await readFile(path.join(dir, 'hosts.json'), 'utf8'))
  assert.equal(raw[0].address, 'retry.example.com')
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('a failed hosts.json write leaves no temp file behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-store-fail-'))
  const store = new HostStore({ dir, logger: { warn() {} }, fsImpl: flakyRenameFs('hosts.json', 99) })
  await store.load()
  await assert.rejects(() => store.upsertHost({ address: 'fail.example.com' }))
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('concurrent host writes are serialized by the file lock (no lost update)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-store-concurrent-'))
  const shim = gatedFirstWriteFs()
  const store = new HostStore({ dir, logger: { warn() {} }, fsImpl: shim.fs })
  await store.load()

  // Hold the first write's temp file open, start a second upsert, then let the
  // first finish. Without a lock the older [one] snapshot lands last and drops
  // host two; with the lock the second writer waits and persists both.
  const first = store.upsertHost({ name: 'one', address: 'one.example.com' })
  await shim.firstOpened
  const second = store.upsertHost({ name: 'two', address: 'two.example.com' })
  // Unlocked: the second rename lands while the first is still gated. Locked: it
  // cannot, so the race times out and the gate is released.
  await Promise.race([shim.renamed, new Promise((resolve) => setTimeout(resolve, 100))])
  shim.release()
  await Promise.all([first, second])

  const onDisk = JSON.parse(await readFile(path.join(dir, 'hosts.json'), 'utf8'))
  assert.deepEqual(
    onDisk.map((host) => host.name).sort(),
    store
      .listHosts()
      .map((host) => host.name)
      .sort(),
  )
  assert.equal(onDisk.length, 2, 'both concurrent hosts must survive')
  // The lock is real: it was created for the write and removed afterwards.
  assert.equal(
    shim.opened.some((file) => file.endsWith('hosts.json.lock')),
    true,
  )
  assert.equal(
    shim.unlinked.some((file) => file.endsWith('hosts.json.lock')),
    true,
  )
  assert.equal(existsSync(path.join(dir, 'hosts.json.lock')), false)
})

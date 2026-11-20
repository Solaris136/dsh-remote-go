import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as realFs, existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HostStore, resolveDshHome, resolveStateDir } from '../../dist/src/store.js'
/** The store under test; the logger is silenced because the recovery cases expect warnings. */
const storeIn = (dir, fsImpl) => new HostStore({ dir, logger: { warn() {} }, fsImpl })
const tempDir = (prefix) => mkdtemp(path.join(tmpdir(), prefix))
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const namesWithSuffix = async (dir, suffix) => (await readdir(dir)).filter((name) => name.endsWith(suffix))
const namesWithPrefix = async (dir, prefix) => (await readdir(dir)).filter((name) => name.startsWith(prefix))
/** A promise and the resolver that settles it, for the gate/signal fixtures below. */
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
/** A loaded store in a fresh directory, plus that directory. */
async function tempStore(prefix = 'dsh-remote-go-store-', fsImpl) {
  const dir = await tempDir(prefix)
  return { store: await reload(dir, fsImpl), dir }
}
/** A second store instance over the same directory, as a restarted Host would open it. */
async function reload(dir, fsImpl) {
  const store = storeIn(dir, fsImpl)
  await store.load()
  return store
}
/** A copy of the real promises API whose write path is instrumented, with the first `.tmp` write gated. */
function gatedFirstWriteFs() {
  const firstOpened = deferred()
  const gate = deferred()
  const renamed = deferred()
  let gated = false
  const opened = []
  const unlinked = []
  const gateOnce = (target) => {
    if (gated || typeof target !== 'string' || !target.endsWith('.tmp')) return false
    gated = true
    firstOpened.resolve()
    return true
  }
  const fsImpl = {
    ...realFs,
    async open(file, flags, mode) {
      const handle = await realFs.open(file, flags, mode)
      opened.push(file)
      if (!gateOnce(file)) return handle
      return {
        writeFile: async (text, encoding) => {
          await gate.promise
          return handle.writeFile(text, encoding)
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      }
    },
    async writeFile(file, ...rest) {
      if (gateOnce(file)) await gate.promise
      return realFs.writeFile(file, ...rest)
    },
    async unlink(file) {
      unlinked.push(file)
      return realFs.unlink(file)
    },
    async rename(from, to) {
      const result = await realFs.rename(from, to)
      if (typeof to === 'string' && to.endsWith('hosts.json')) renamed.resolve()
      return result
    },
  }
  return {
    fs: fsImpl,
    firstOpened: firstOpened.promise,
    release: gate.resolve,
    renamed: renamed.promise,
    opened,
    unlinked,
  }
}
/** A filesystem whose `rename` to `suffix` fails `failures` times with EPERM before succeeding. */
function flakyRenameFs(suffix, failures) {
  let remaining = failures
  return {
    ...realFs,
    async rename(from, to) {
      if (typeof to === 'string' && to.endsWith(suffix) && remaining > 0) {
        remaining -= 1
        throw Object.assign(new Error('busy'), { code: 'EPERM' })
      }
      return realFs.rename(from, to)
    },
  }
}
/** A filesystem whose read of `suffix` fails like a permission problem, not like bad JSON. */
function unreadableFs(suffix) {
  return {
    ...realFs,
    async readFile(file, ...rest) {
      if (typeof file === 'string' && file.endsWith(suffix)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return realFs.readFile(file, ...rest)
    },
  }
}

test('a fresh store has defaults and no hosts', async () => {
  const { store } = await tempStore()
  assert.deepEqual(store.listHosts(), [])
  assert.equal(store.getSettings().defaultPort, 22)
  assert.equal(store.getSettings().saveTokens, false)
})

test('upsertHost persists, updates in place and is reloaded by a new instance', async () => {
  const { store, dir } = await tempStore()
  const created = await store.upsertHost({ name: 'VM', address: 'ubuntu@example.com', port: 2222 })
  assert.ok(created.id.startsWith('h_'))
  assert.equal(store.listHosts().length, 1)
  const hosts = (await reload(dir)).listHosts()
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].address, 'ubuntu@example.com')
  assert.equal(hosts[0].port, 2222)
  assert.equal(hosts[0].username, 'ubuntu')
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
  const reloaded = await reload(dir)
  assert.equal(reloaded.getSettings().defaultPort, 2200)
  assert.equal(reloaded.getSettings().language, 'zh')
  await writeFile(path.join(dir, 'settings.json'), '{not json', 'utf8')
  const recovered = await reload(dir)
  assert.equal(recovered.getSettings().defaultPort, 22)
  // The damaged bytes survive as a `.corrupt-<stamp>` copy beside the recovered file.
  const backups = await namesWithPrefix(dir, 'settings.json.corrupt-')
  assert.equal(backups.length, 1)
  assert.equal(await readFile(path.join(dir, backups[0]), 'utf8'), '{not json')
})

test('a corrupt hosts.json is kept aside instead of being silently overwritten', async () => {
  const dir = await tempDir('dsh-remote-go-store-corrupt-')
  const original = '{"hosts":[{"id":"h_pinned","pinnedFingerprint":"SHA256:abc"'
  await writeFile(path.join(dir, 'hosts.json'), original, 'utf8')
  const store = await reload(dir)
  assert.deepEqual(store.listHosts(), [])
  assert.equal(store.hostsCorrupt, true)
  const backups = await namesWithPrefix(dir, 'hosts.json.corrupt-')
  assert.equal(backups.length, 1)
  // One write after the recovery must touch the recovered file only, never the copy.
  await store.upsertHost({ address: 'new.example.com' })
  assert.deepEqual(
    (await readJson(path.join(dir, 'hosts.json'))).map((host) => host.address),
    ['new.example.com'],
  )
  assert.equal(await readFile(path.join(dir, backups[0]), 'utf8'), original)
  // The recovered file is authoritative again: no permanent "corrupt" warning.
  assert.equal(store.hostsCorrupt, false)
})

test('a file that merely could not be read is left in place, not quarantined', async () => {
  const dir = await tempDir('dsh-remote-go-store-unreadable-')
  await writeFile(path.join(dir, 'hosts.json'), '[{"id":"h_x","address":"kept.example.com"}]', 'utf8')
  const store = await reload(dir, unreadableFs('hosts.json'))
  // This run falls back to an empty list…
  assert.deepEqual(store.listHosts(), [])
  assert.equal(store.hostsCorrupt, false, 'a read error is not corruption')
  // …but the bytes are still there for the next run, and nothing was renamed: no quarantine copy may appear here.
  const names = await readdir(dir)
  assert.deepEqual(
    names.filter((name) => name.includes('.corrupt-')),
    [],
  )
  const kept = await readJson(path.join(dir, 'hosts.json'))
  assert.equal(kept[0].address, 'kept.example.com')
})

test('saveSettings patches the current settings instead of resetting sibling fields', async () => {
  const { store } = await tempStore()
  await store.saveSettings({ autoReconnect: { maxAttempts: 12, baseDelayMs: 5000 } })
  assert.equal(store.getSettings().autoReconnect.baseDelayMs, 5000)
  // A nested patch used to be spread over the defaults, so this call rewound baseDelayMs 5000 -> 800.
  const patched = await store.saveSettings({ autoReconnect: { maxAttempts: 3 } })
  assert.equal(patched.autoReconnect.maxAttempts, 3)
  assert.equal(patched.autoReconnect.baseDelayMs, 5000)
  assert.equal(patched.autoReconnect.enabled, true)
  assert.equal(patched.defaultPort, 22)
})

test('a host id is issued by the store, never taken from the caller', async () => {
  const { store } = await tempStore()
  const created = await store.upsertHost({ id: 'pwned', address: 'a.example.com' })
  assert.match(created.id, /^h_[a-z0-9]{1,32}$/)
  assert.notEqual(created.id, 'pwned')
  const updated = await store.upsertHost({ id: created.id, address: 'b.example.com' })
  assert.equal(updated.id, created.id)
  assert.equal(updated.address, 'b.example.com')
  const oversized = `h_${'z'.repeat(200)}`
  const forged = await store.upsertHost({ id: oversized, address: 'c.example.com' })
  assert.match(forged.id, /^h_[a-z0-9]{1,32}$/)
  assert.notEqual(forged.id, oversized)
  // Two hosts: the second call updated the first; the forged id added its own entry.
  assert.equal(store.listHosts().length, 2)
})

test('tokens are only stored when saveTokens is enabled', async () => {
  const { store, dir } = await tempStore()
  const host = await store.upsertHost({ address: 'example.com' })
  const secretsFile = path.join(dir, 'secrets.json')
  await store.saveToken(host.id, 'token-a')
  await assert.rejects(readFile(secretsFile, 'utf8'))
  await store.saveSettings({ saveTokens: true })
  await store.saveToken(host.id, 'token-a')
  assert.equal((await readJson(secretsFile))[host.id], 'token-a')
  await store.saveSettings({ saveTokens: false })
  assert.deepEqual(await readJson(secretsFile), {})
})

test('saveToken reads the secrets file before writing it', async () => {
  const { store, dir } = await tempStore()
  await store.saveSettings({ saveTokens: true })
  const hostA = await store.upsertHost({ address: 'a.example.com' })
  const hostB = await store.upsertHost({ address: 'b.example.com' })
  await store.saveToken(hostA.id, 'token-a')
  // A fresh instance (nothing loaded yet) used to write `{ b: token-b }` over the whole file.
  await storeIn(dir).saveToken(hostB.id, 'token-b')
  const secrets = await readJson(path.join(dir, 'secrets.json'))
  assert.equal(secrets[hostA.id], 'token-a')
  assert.equal(secrets[hostB.id], 'token-b')
})

test('hosts.json never contains password fields', async () => {
  const { store, dir } = await tempStore()
  await store.upsertHost({ address: 'example.com', auth: { type: 'password' } })
  const raw = await readFile(path.join(dir, 'hosts.json'), 'utf8')
  assert.doesNotMatch(raw, /"(passwordValue|passwordActual|passphrase|secret|token)"/)
  assert.deepEqual(Object.keys(JSON.parse(raw)[0].auth), ['type'])
})

test('resolveDshHome prefers DSH_HOME and falls back to the user home', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh')
  assert.equal(resolveDshHome({ USERPROFILE: 'C:\\Users\\u' }), path.join('C:\\Users\\u', '.dsh'))
  assert.equal(resolveStateDir('/custom/dsh'), path.join('/custom/dsh', 'remote-go'))
})

test('the shared atomic writer retries a busy rename for hosts.json', async () => {
  const dir = await tempDir('dsh-remote-go-store-retry-')
  const store = await reload(dir, flakyRenameFs('hosts.json', 2))
  assert.ok((await store.upsertHost({ address: 'retry.example.com' })).id)
  assert.equal((await readJson(path.join(dir, 'hosts.json')))[0].address, 'retry.example.com')
  assert.deepEqual(await namesWithSuffix(dir, '.tmp'), [])
})

test('a failed hosts.json write leaves no temp file behind', async () => {
  const dir = await tempDir('dsh-remote-go-store-fail-')
  const store = await reload(dir, flakyRenameFs('hosts.json', 99))
  await assert.rejects(() => store.upsertHost({ address: 'fail.example.com' }))
  assert.deepEqual(await namesWithSuffix(dir, '.tmp'), [])
})

test('concurrent host writes are serialized by the file lock (no lost update)', async () => {
  const dir = await tempDir('dsh-remote-go-store-concurrent-')
  const shim = gatedFirstWriteFs()
  const store = await reload(dir, shim.fs)
  const first = store.upsertHost({ name: 'one', address: 'one.example.com' })
  await shim.firstOpened
  const second = store.upsertHost({ name: 'two', address: 'two.example.com' })
  await Promise.race([shim.renamed, new Promise((resolve) => setTimeout(resolve, 100))])
  shim.release()
  await Promise.all([first, second])
  const onDisk = await readJson(path.join(dir, 'hosts.json'))
  assert.deepEqual(
    onDisk.map((host) => host.name).sort(),
    store
      .listHosts()
      .map((host) => host.name)
      .sort(),
  )
  assert.equal(onDisk.length, 2, 'both concurrent hosts must survive')
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

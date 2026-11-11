import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeDescriptorDeltas, withMirrorQueue, withMirrorWriter } from '../../src/mirror-writer.js'

// The single writer (§6.3). The bug this guards is a lost update: the history sync and a stream
// apply both persist descriptors, and a stale snapshot from one used to drop the other's cursor.
// Ordering is forced with an injected read/write pair, never with sleeps.

/**
 * An in-memory descriptor store whose `write` yields for a macrotask, which is exactly where a
 * non-serialised implementation would let a second writer read the pre-state.
 */
function makeStore(seed) {
  /** @type {any[]} */
  let rows = seed.map((entry) => ({ ...entry }))
  return {
    rows: () => rows,
    read: () => rows.map((entry) => ({ ...entry })),
    async write(next) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      rows = next
      return rows
    },
  }
}

test('the writer serialises concurrent mutations without losing either cursor', async () => {
  const store = makeStore([
    { localSessionId: 'mirror_a', cursor: 0 },
    { localSessionId: 'mirror_b', cursor: 0 },
  ])
  /** @type {any} */
  const runtime = { id: 'h_writer' }

  // Two writers started together, each advancing a different descriptor. Without serialisation one
  // reads the pre-state and its persist drops the other's advance.
  await Promise.all([
    withMirrorWriter(runtime, store.read, store.write, (current) =>
      mergeDescriptorDeltas(
        current,
        current.map((entry) => ({ ...entry, cursor: entry.localSessionId === 'mirror_a' ? 5 : entry.cursor })),
      ),
    ),
    withMirrorWriter(runtime, store.read, store.write, (current) =>
      mergeDescriptorDeltas(
        current,
        current.map((entry) => ({ ...entry, cursor: entry.localSessionId === 'mirror_b' ? 7 : entry.cursor })),
      ),
    ),
  ])

  const final = store.rows()
  assert.equal(final.find((entry) => entry.localSessionId === 'mirror_a').cursor, 5, 'writer 1 cursor survived')
  assert.equal(final.find((entry) => entry.localSessionId === 'mirror_b').cursor, 7, 'writer 2 cursor survived')
})

test('a concurrent run equals one serial run', async () => {
  const seed = [
    { localSessionId: 'mirror_a', cursor: 0 },
    { localSessionId: 'mirror_b', cursor: 0 },
  ]
  /** @param {number} cursorA @param {boolean} concurrent */
  const run = async (cursorA, concurrent) => {
    const store = makeStore(seed)
    /** @type {any} */
    const runtime = { id: 'h_same' }
    const first = () =>
      withMirrorWriter(runtime, store.read, store.write, (current) =>
        mergeDescriptorDeltas(
          current,
          current.map((entry) => ({ ...entry, cursor: entry.localSessionId === 'mirror_a' ? cursorA : entry.cursor })),
        ),
      )
    const second = () =>
      withMirrorWriter(runtime, store.read, store.write, (current) =>
        mergeDescriptorDeltas(
          current,
          current.map((entry) => ({ ...entry, cursor: entry.localSessionId === 'mirror_b' ? 9 : entry.cursor })),
        ),
      )
    if (concurrent === true) await Promise.all([first(), second()])
    else {
      await first()
      await second()
    }
    return store
      .rows()
      .map((entry) => ({ id: entry.localSessionId, cursor: entry.cursor }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  assert.deepEqual(await run(3, true), await run(3, false), 'concurrent must equal serialised')
})

test('the monotonic fields never move backwards under a merge', () => {
  const current = [{ localSessionId: 'mirror_a', cursor: 9, epoch: 4, conflictCount: 2, level: 'L2' }]
  // A writer holding a stale snapshot tries to lower all three.
  const merged = mergeDescriptorDeltas(current, [{ localSessionId: 'mirror_a', cursor: 2, epoch: 1, conflictCount: 0 }])
  assert.equal(merged[0].cursor, 9, 'cursor is monotonic')
  assert.equal(merged[0].epoch, 4, 'epoch is monotonic')
  assert.equal(merged[0].conflictCount, 2, 'the conflict counter is monotonic')
})

test('a delta that omits a descriptor does not drop it', () => {
  const current = [
    { localSessionId: 'mirror_a', cursor: 1 },
    { localSessionId: 'mirror_b', cursor: 2 },
  ]
  const merged = mergeDescriptorDeltas(current, [{ localSessionId: 'mirror_a', cursor: 5 }])
  assert.deepEqual(
    merged.map((entry) => entry.localSessionId).sort(),
    ['mirror_a', 'mirror_b'],
    'an untouched descriptor is preserved',
  )
  assert.equal(merged.find((entry) => entry.localSessionId === 'mirror_b').cursor, 2)
})

test('a throwing mutation does not wedge the queue', async () => {
  const store = makeStore([{ localSessionId: 'mirror_a', cursor: 0 }])
  /** @type {any} */
  const runtime = { id: 'h_throw' }

  await assert.rejects(
    withMirrorWriter(runtime, store.read, store.write, () => {
      throw new Error('boom')
    }),
  )
  // The next writer still runs: a failed delta must not leave the chain rejected.
  await withMirrorWriter(runtime, store.read, store.write, (current) =>
    mergeDescriptorDeltas(
      current,
      current.map((entry) => ({ ...entry, cursor: 4 })),
    ),
  )
  assert.equal(store.rows()[0].cursor, 4)
})

test('a merge never resurrects a descriptor that was deleted', () => {
  // The rule from §6.3: a merge is an update, not an upsert. A delta whose descriptor is gone from
  // `current` means it was deleted after the writer read its snapshot, so re-inserting it would
  // bring a deleted host's mirrors back.
  const deleted = { localSessionId: 'mirror_gone', cursor: 7 }
  const merged = mergeDescriptorDeltas([], [deleted])
  assert.deepEqual(merged, [], 'a delta for a descriptor no longer present is dropped, not inserted')

  // The same delta alongside a live one only updates the live one.
  const current = [{ localSessionId: 'mirror_live', cursor: 1 }]
  const mixed = mergeDescriptorDeltas(current, [{ localSessionId: 'mirror_live', cursor: 4 }, deleted])
  assert.deepEqual(
    mixed.map((entry) => entry.localSessionId),
    ['mirror_live'],
    'only descriptors still present are written',
  )
  assert.equal(mixed[0].cursor, 4)
})

test('deletion ordered against an in-flight sync leaves nothing behind', async () => {
  // Deterministic interleaving: the sync's write is held at a gate while the deletion is queued
  // behind it, then both drain. No sleeps — the gate is an explicit promise.
  /** @type {any[]} */
  let rows = [{ localSessionId: 'mirror_a', cursor: 3 }]
  /** @type {() => void} */
  let releaseSync = () => {}
  const gate = new Promise((resolve) => {
    releaseSync = () => resolve(undefined)
  })
  /** @type {any} */
  const runtime = { id: 'h_delete' }

  // The "sync": reads the snapshot, then holds its write open.
  const sync = withMirrorWriter(
    runtime,
    () => rows.map((entry) => ({ ...entry })),
    async (next) => {
      await gate
      rows = next
      return rows
    },
    (current) =>
      mergeDescriptorDeltas(
        current,
        current.map((entry) => ({ ...entry, cursor: 9 })),
      ),
  )
  // The deletion is queued behind the sync.
  const deletion = withMirrorQueue(runtime, async () => {
    rows = []
    return []
  })

  releaseSync()
  await Promise.all([sync, deletion])

  assert.deepEqual(rows, [], 'the deleted host keeps no descriptors')
})

test('the tombstone is set by removeHost, not by the test', async () => {
  // The previous version of this file set `runtime.mirrorDeleted` itself, so it could never fail
  // for a missing assignment — the "test asserts against a seam it introduced" failure mode.
  // This one only calls production code and then checks the flag it relies on.
  const { RemoteGoService } = await import('../../src/service.js')
  const { HostStore } = await import('../../src/store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-tombstone-'))
  const quiet = { warn() {}, info() {}, debug() {}, error() {} }
  /** @type {any} */
  let service = null
  try {
    service = new RemoteGoService({
      store: new HostStore({ dir, logger: quiet }),
      home: dir,
      localVersion: '0.2.2-rc.1',
      logger: quiet,
      loadSshMaterial: async () => ({ configText: '', knownHostsText: '' }),
      resolveTarget: () => ({ targetVersion: '0.2.2-rc.1', source: 'test' }),
      sessionAdapter: null,
      workspaceAdapter: null,
    })
    await service.init()
    const host = await service.saveHost({
      name: 'tombstone',
      address: '127.0.0.1',
      username: 'sim',
      auth: { type: 'password' },
    })
    const runtime = service.runtimes.get(host.id)
    assert.equal(runtime.mirrorDeleted === true, false, 'a live host is not tombstoned')
    await service.removeHost(host.id)
    assert.equal(
      runtime.mirrorDeleted,
      true,
      'removeHost must tombstone the runtime itself; the write guard is inert without it',
    )
  } finally {
    await service?.shutdown?.().catch?.(() => null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("delete-then-reconcile cannot recreate the deleted host's mirrors", async () => {
  // The sharp case: reconcile returns the WHOLE planned set, so update-never-upsert does not
  // protect it — when the write lands after deletion, `current` is [] and reconcile plans every
  // session as new. Driven through the real `removeHost` and the real `withMirrorWriter`; nothing
  // here hands the writer a tombstone.
  const { RemoteGoService } = await import('../../src/service.js')
  const { HostStore } = await import('../../src/store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-delete-reconcile-'))
  const quiet = { warn() {}, info() {}, debug() {}, error() {} }
  /** @type {any} */
  let service = null
  try {
    service = new RemoteGoService({
      store: new HostStore({ dir, logger: quiet }),
      home: dir,
      localVersion: '0.2.2-rc.1',
      logger: quiet,
      loadSshMaterial: async () => ({ configText: '', knownHostsText: '' }),
      resolveTarget: () => ({ targetVersion: '0.2.2-rc.1', source: 'test' }),
      sessionAdapter: null,
      workspaceAdapter: null,
    })
    await service.init()
    const host = await service.saveHost({
      name: 'delete-reconcile',
      address: '127.0.0.1',
      username: 'sim',
      auth: { type: 'password' },
    })
    /** @type {any} */
    const planned = [{ localSessionId: 'mirror_a', hostId: host.id, remoteSessionId: 'a', cursor: 0 }]
    await service.mirrorStore.replaceHostMirrors(host.id, planned)
    const runtime = service.runtimes.get(host.id)

    // The dangerous order, deterministically: let the deletion *complete*, then attempt a
    // reconcile-shaped write (which returns the whole planned set, so update-never-upsert cannot
    // save it). Nothing here hands the writer a tombstone — it must come from `removeHost`.
    await service.removeHost(host.id)

    await withMirrorWriter(
      runtime,
      () => service.mirrorStore.listMirrors({ hostId: host.id }),
      (next) => service.mirrorStore.replaceHostMirrors(host.id, next),
      () => planned.map((entry) => ({ ...entry })),
    )
    assert.deepEqual(
      service.mirrorStore.listMirrors({ hostId: host.id }),
      [],
      'the reconcile write must be a no-op once the host is deleted',
    )
  } finally {
    await service?.shutdown?.().catch?.(() => null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('every descriptor store mutation is inside a queue-owning method', async () => {
  // Structural guard, same spirit as the wait-predicate scanner: the resurrection bug came from a
  // *direct* store call bypassing the queue, so assert the shape rather than trusting review.
  //
  // The criterion is structural, not textual: split the class into method bodies and require every
  // `removeHostMirrors` / `replaceHostMirrors` call to sit inside the two methods that own the
  // queue. An earlier version matched a literal spelling (and only the optional-call form), so a
  // plain `store.replaceHostMirrors(...)` bypass was invisible to it.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../src/service.js', import.meta.url), 'utf8')

  /** Offsets of every method body in the class: `  async #name(` / `  #name(` / `  async name(`. */
  const bodies = []
  const methodRe = /^ {2}(?:async )?(#?[A-Za-z_$][\w$]*)\([^)]*\) \{$/gm
  /** @type {RegExpExecArray | null} */
  let match = methodRe.exec(source)
  while (match !== null) {
    const name = match[1]
    const bodyStart = match.index + match[0].length
    // The body ends at the next top-level member, i.e. the next `\n  }` followed by a blank line.
    const rest = source.slice(bodyStart)
    const closeAt = rest.search(/\n {2}\}/)
    const bodyEnd = closeAt < 0 ? source.length : bodyStart + closeAt
    // Private members keep their `#`; normalise so the allow-list reads as method names.
    bodies.push({ name: name.replace(/^#/, ''), start: match.index, end: bodyEnd })
    match = methodRe.exec(source)
  }
  assert.ok(bodies.length > 0, 'the service methods must be discoverable')

  /** The only methods allowed to touch the descriptor store: they own the per-host queue. */
  const ALLOWED = new Set(['mutateMirrors', 'removeMirrorsForHost'])
  const offenders = []
  for (const issue of source.matchAll(/\.(removeHostMirrors|replaceHostMirrors)\s*\??\.?\s*\(/g)) {
    const at = issue.index ?? 0
    const owner = bodies.find((body) => at > body.start && at < body.end)
    if (owner === undefined || !ALLOWED.has(owner.name)) {
      const line = source.slice(0, at).split('\n').length
      offenders.push(`service.js:${line} → ${issue[0]} (owner: ${owner?.name ?? '<top level>'})`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'descriptor store calls must live inside #mutateMirrors or #removeMirrorsForHost, which own the queue',
  )
})

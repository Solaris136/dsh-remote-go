import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeDescriptorDeltas, withMirrorWriter } from '../../src/mirror-writer.js'

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

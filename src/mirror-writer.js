/**
 * The single writer for a host's mirror descriptors.
 *
 * The history sync and the stream apply both persist descriptors; before this module a stale
 * snapshot from one could drop the other's cursor (a lost update). Every mutation now goes through
 * `withMirrorWriter`, which serialises read → delta → persist per host.
 *
 * @module
 */

/**
 * The single writer for one host's descriptors (design §6.3).
 *
 * Every mutation of a host's mirror descriptors goes through here. The failure it prevents is a
 * lost update: the history sync and a stream apply both persist, and a stale snapshot from one
 * used to drop the other's cursor.
 *
 * The queue is per runtime and lives on `runtime.mirrorQueue`, so two hosts never wait on each
 * other. The delta function must be synchronous — if it awaited between reading and returning, a
 * second writer could still interleave.
 *
 * @param {{ id: string, mirrorQueue?: Promise<unknown> }} runtime
 * @param {() => any[]} read current descriptors
 * @param {(next: any[]) => Promise<any[]>} write persist
 * @param {(current: any[]) => any[]} delta
 * @returns {Promise<any[]>}
 */
export async function withMirrorWriter(runtime, read, write, delta) {
  return withMirrorQueue(runtime, async () => {
    const current = read()
    const next = delta(current)
    if (!Array.isArray(next)) return current
    return write(next)
  })
}

/**
 * Run one operation on a host's mirror queue.
 *
 * Every mutation of a host's mirror state shares this queue — descriptor writes *and* host
 * deletion. That is what stops a deletion from interleaving inside a sync's
 * read → delta → persist, which is how an in-flight sync used to resurrect deleted mirrors.
 *
 * The chain survives a throwing operation, so a failure cannot wedge the queue for that host.
 * @param {{ id: string, mirrorQueue?: Promise<unknown> }} runtime
 * @param {() => Promise<any>} run
 * @returns {Promise<any>}
 */
export async function withMirrorQueue(runtime, run) {
  const queued = (runtime.mirrorQueue ?? Promise.resolve()).then(run, run)
  runtime.mirrorQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

/**
 * Merge descriptor deltas onto the current set.
 *
 * Two rules, both load-bearing (design §6.3):
 *
 * 1. **Update-only — a merge never creates.** A delta whose `localSessionId` is no longer present
 *    in `current` is dropped. That case means the descriptor was deleted after this writer read
 *    its snapshot, so re-inserting it would resurrect a deleted host's mirrors. Creation is the
 *    reconcile's job (it returns the full planned set), not a merge's.
 * 2. **Monotonic fields only move forward.** `cursor`, `epoch` and `conflictCount` take the
 *    maximum, so two writers that legitimately race on them cannot lower either. Other fields
 *    follow the delta, because the last serialised writer is the most recent opinion about them.
 *
 * A descriptor the delta does not mention is preserved untouched.
 * @param {any[]} current @param {any[]} deltas
 * @returns {any[]}
 */
export function mergeDescriptorDeltas(current, deltas) {
  /** @type {any[]} */
  const out = current.map((entry) => ({ ...entry }))
  /** @type {Map<string, number>} */
  const index = new Map(out.map((entry, at) => [entry.localSessionId, at]))
  for (const delta of deltas) {
    const at = index.get(delta.localSessionId)
    // Update-only: absent means deleted since the snapshot was read, so it stays deleted.
    if (at === undefined) continue
    const base = out[at]
    out[at] = {
      ...base,
      ...delta,
      cursor: Math.max(base.cursor ?? 0, delta.cursor ?? 0),
      epoch: Math.max(base.epoch ?? 0, delta.epoch ?? 0),
      conflictCount: Math.max(base.conflictCount ?? 0, delta.conflictCount ?? 0),
    }
  }
  return out
}

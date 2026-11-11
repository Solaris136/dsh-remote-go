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
  const run = async () => {
    const current = read()
    const next = delta(current)
    if (!Array.isArray(next)) return current
    return write(next)
  }
  const queued = (runtime.mirrorQueue ?? Promise.resolve()).then(run, run)
  // Keep the chain alive even if one writer throws: a failure must not wedge the queue.
  runtime.mirrorQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

/**
 * Merge descriptor deltas onto the current set, keeping the monotonic fields monotonic.
 *
 * `cursor`, `epoch` and `conflictCount` only ever move forward: two writers that legitimately
 * race on them must not be able to lower either. Other fields follow the delta, because the last
 * serialised writer is the most recent opinion about them.
 * @param {any[]} current @param {any[]} deltas
 * @returns {any[]}
 */
export function mergeDescriptorDeltas(current, deltas) {
  const byId = new Map(current.map((entry) => [entry.localSessionId, entry]))
  const seen = new Set()
  /** @type {any[]} */
  const out = []
  for (const delta of deltas) {
    seen.add(delta.localSessionId)
    const base = byId.get(delta.localSessionId)
    if (base === undefined) {
      out.push(delta)
      continue
    }
    out.push({
      ...base,
      ...delta,
      cursor: Math.max(base.cursor ?? 0, delta.cursor ?? 0),
      epoch: Math.max(base.epoch ?? 0, delta.epoch ?? 0),
      conflictCount: Math.max(base.conflictCount ?? 0, delta.conflictCount ?? 0),
    })
  }
  // A descriptor the delta did not mention is preserved, never dropped.
  for (const entry of current) if (!seen.has(entry.localSessionId)) out.push(entry)
  return out
}

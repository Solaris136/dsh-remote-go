/**
 * Host-faithful `ctx.sessions` double (design §4.1).
 *
 * One double for every suite (unit adapter tests, `history.e2e.js`, both
 * `mirror.e2e.js` variants) so a divergence between the fake and the live service
 * shows up once, in the suites that actually exercise the behaviour, instead of
 * leaking one field at a time. The rules below are the ones the live service
 * enforces (verified with Cordis Inspect and the DSH source):
 *
 * - `create(id?, { seed, inheritedEventCount, meta })` throws exactly like the host
 *   when `meta.isSeeded === true` without an explicit `seed` / `inheritedEventCount`
 *   (`dsh-session` throws "seeded session requires an explicit constructor seed" and
 *   "seeded session requires an inherited event count"); a duplicate id throws too.
 * - A `Session` exposes `snapshotEvents()`, `ownEvents()`, `eventAt()`, `seq`,
 *   `append(type, data, intent?)` and `header` — and **no `events` array**, which the
 *   real Session also does not have.
 * - Seqs are 0-based (`SessionLogOffset`); `snapshotEvents(from, toExclusive)` is
 *   half-open.
 * - Surface events require a `SurfaceIntent` third argument.
 *
 * Records for assertions:
 * - `calls`: `{ op: 'create' | 'get' | 'append', id, options?, args? }` in order.
 * - `createCalls`: `{ id, options }` for each create.
 * - `appends`: `{ id, type, data }` for each appended event.
 * - `live`: the id → Session map.
 */
import { SURFACE_EVENT_TYPES } from '../../src/session-adapter.js'

/**
 * @typedef {{
 *   type: string,
 *   seq: number,
 *   time: number,
 *   data: any,
 *   surfaceOp?: any,
 *   sourceEventSeqs?: any,
 * }} FakeSessionEvent
 */

/**
 * @typedef {{
 *   id: string,
 *   header: Record<string, any>,
 *   readonly seq: number,
 *   append: (...args: any[]) => FakeSessionEvent,
 *   snapshotEvents: (fromSeq?: number, toSeqExclusive?: number) => FakeSessionEvent[],
 *   ownEvents: () => FakeSessionEvent[],
 *   eventAt: (seq: number) => FakeSessionEvent | undefined,
 * }} FakeSession
 */

/**
 * The host's rule for seeded creation, in one place so every double and the shared
 * one cannot drift: with `meta.isSeeded === true` the caller must pass `seed` and
 * `inheritedEventCount` explicitly (dsh-session throws exactly these two messages).
 *
 * Exported so a suite that keeps its own minimal double can enforce the same rule
 * without copying it — the double stays local, the *contract* stays single-sourced.
 * @param {any} options
 */
export function assertSeededCreateOptions(options) {
  if (options?.meta?.isSeeded !== true) return
  if (options.seed === undefined) {
    throw new Error('seeded session requires an explicit constructor seed')
  }
  if (options.inheritedEventCount === undefined) {
    throw new Error('seeded session requires an inherited event count')
  }
}

/** @param {any} meta @param {string} id */
function buildHeader(meta, id) {
  /** @type {Record<string, any>} */
  const header = {
    version: 1,
    id,
    createdAt: Date.now(),
    isSeeded: meta?.isSeeded === true,
  }
  if (typeof meta?.cwd === 'string') header.cwd = meta.cwd
  if (typeof meta?.parentSession === 'string') header.parentSession = meta.parentSession
  return header
}

/**
 * Create one sessions service double.
 * @returns {{
 *   calls: any[],
 *   createCalls: { id: string, options: any }[],
 *   appends: { id: string, type: string, data: any }[],
 *   live: Map<string, FakeSession>,
 *   create: (id?: string, options?: any) => FakeSession,
 *   get: (id: string) => FakeSession | undefined,
 *   list: () => FakeSession[],
 * }}
 */
export function createFakeSessions() {
  /** @type {any[]} */
  const calls = []
  /** @type {{ id: string, options: any }[]} */
  const createCalls = []
  /** @type {{ id: string, type: string, data: any }[]} */
  const appends = []
  /** @type {Map<string, FakeSession>} */
  const live = new Map()
  let seqCounter = 0

  /** @param {string} id @param {any} options @returns {FakeSession} */
  function makeSession(id, options) {
    /** @type {FakeSessionEvent[]} */
    let committed = []
    const seed = Array.isArray(options?.seed) ? options.seed : []
    committed = seed.map((event, index) => ({ ...event, seq: index }))

    const session = {
      id,
      header: buildHeader(options?.meta, id),
      get seq() {
        return committed.length
      },
      append(...args) {
        calls.push({ op: 'append', id, args })
        const [type, data, intent] = args
        if (SURFACE_EVENT_TYPES.includes(type) && intent === undefined) {
          throw new Error(`surface event ${type} requires a surface intent`)
        }
        const event = { type, seq: committed.length, time: Date.now(), data }
        if (intent !== undefined) {
          Object.assign(event, intent)
        }
        committed = [...committed, event]
        appends.push({ id, type, data })
        return event
      },
      snapshotEvents(fromSeq = 0, toSeqExclusive = committed.length) {
        return committed.filter((event) => event.seq >= fromSeq && event.seq < toSeqExclusive)
      },
      ownEvents() {
        return committed.slice()
      },
      eventAt(seq) {
        return committed.find((event) => event.seq === seq)
      },
    }
    return session
  }

  /**
   * @param {string} [id]
   * @param {any} [options]
   * @returns {FakeSession}
   */
  function create(id, options = {}) {
    const sessionId = typeof id === 'string' && id !== '' ? id : `session-${(seqCounter += 1)}`
    if (live.has(sessionId)) throw new Error(`session ${sessionId} already exists`)
    // The live service rejects a seeded header that does not say what it inherited.
    assertSeededCreateOptions(options)
    const session = makeSession(sessionId, options)
    calls.push({ op: 'create', id: sessionId, options })
    createCalls.push({ id: sessionId, options })
    live.set(sessionId, session)
    return session
  }

  /** @param {string} id @returns {FakeSession | undefined} */
  function get(id) {
    calls.push({ op: 'get', id })
    return live.get(id)
  }

  /** @returns {FakeSession[]} */
  function list() {
    return [...live.values()]
  }

  return { calls, createCalls, appends, live, create, get, list }
}

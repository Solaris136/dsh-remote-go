/**
 * Narrow, optional adapter over the Cordis `sessions` service (`ctx.sessions`).
 *
 * P0 scope: create the local session that backs one mirror descriptor and append
 * events to it. Two host facts drive the shape, both verified against the live
 * Host service (docs/session-design.md §4.1):
 *
 * - `create(id?, { seed, meta })` builds a live session; `seed` replays history
 *   and `meta.cwd` must be absolute. `meta` cannot carry `hostId` /
 *   `remoteSessionId`, so mirror lineage lives in the persisted descriptor.
 * - `Session.append(type, data, intent?)` — surface events (`system/message`,
 *   `developer/message`, `user/message`, `assistant/message`, `tool/result`)
 *   MUST pass `{ surfaceOp: 'append' }`; every other event type takes exactly two
 *   arguments. A surface event appended without the intent lands in the log but
 *   is never projected as conversation content.
 *
 * Persistence caveat (design §4.1): `ctx.sessions` is an in-memory store whose
 * persistence comes from the session-log writer the agent lifecycle attaches. A
 * session created here, outside that lifecycle, persists nothing — so after a
 * restart `ensureMirrorSession()` has to re-create it and the mirror re-pulls
 * from the remote. P0 accepts this (no writer attach); every result carries the
 * `resync` decision so the UI can say so instead of showing an empty session.
 *
 * No DSH package is imported: the service object (or a `ctx` that can resolve
 * it) is injected, so every branch is unit-testable with a fake.
 */
import { decideResync, mirrorSessionId } from './mirror.js'

/** Event types the host projects as conversation content (design §4.1). */
export const SURFACE_EVENT_TYPES = Object.freeze([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * @typedef {{
 *   ok: boolean,
 *   reason?: string | null,
 *   localSessionId?: string | null,
 *   created?: boolean,
 *   removed?: boolean,
 *   cursor?: number,
 *   type?: string,
 *   surface?: boolean,
 *   seq?: number | null,
 *   resync?: ReturnType<typeof decideResync> | null,
 *   notice?: { zh: string, en: string } | null,
 *   error?: string,
 * }} AdapterResult
 */

/**
 * Build the adapter for one plugin lifetime.
 *
 * The service is resolved lazily on every call, so a composition that publishes
 * `sessions` after this plugin loads still works, and a composition that never
 * publishes it keeps the plugin running with typed `sessions-unavailable`
 * results (design §4.2: the adapter is optional).
 *
 * @param {{
 *   ctx?: any,
 *   sessions?: any,
 *   cwd?: string | null,
 *   logger?: { warn?: (...args: any[]) => void },
 * }} [options]
 * @returns {{
 *   available: () => boolean,
 *   ensureMirrorSession: (descriptor: any) => AdapterResult,
 *   appendEvent: (localSessionId: string, event: any) => AdapterResult,
 *   removeMirrorSession: (localSessionId: string) => AdapterResult,
 * }}
 */
export function createSessionAdapter(options = {}) {
  const logger = options.logger ?? console

  /** @returns {any | null} */
  function resolveSessions() {
    if (options.sessions && typeof options.sessions === 'object') return options.sessions
    const ctx = options.ctx ?? null
    if (!ctx || typeof ctx.get !== 'function') return null
    try {
      const sessions = ctx.get('sessions')
      return sessions && typeof sessions === 'object' ? sessions : null
    } catch (error) {
      logger.warn?.('[dsh-remote-go] cannot resolve the sessions service:', error)
      return null
    }
  }

  /** @returns {boolean} */
  function available() {
    const sessions = resolveSessions()
    return Boolean(sessions && typeof sessions.create === 'function')
  }

  /**
   * Create (or find) the local session for one mirror descriptor.
   *
   * Synchronous by design: the host `sessions` service is an in-memory store, so
   * there is no I/O to await in P0. A session that is already live is returned
   * unmodified (`created: false`). A missing session is created with an empty
   * seed (P0 mirrors the directory only) and the result explains that the mirror
   * must re-pull from the remote.
   *
   * @param {any} descriptor
   * @returns {AdapterResult}
   */
  function ensureMirrorSession(descriptor) {
    const sessions = resolveSessions()
    const hostId = typeof descriptor?.hostId === 'string' ? descriptor.hostId : ''
    const remoteSessionId = typeof descriptor?.remoteSessionId === 'string' ? descriptor.remoteSessionId : ''
    const localSessionId =
      typeof descriptor?.localSessionId === 'string' && descriptor.localSessionId.trim() !== ''
        ? descriptor.localSessionId.trim()
        : mirrorSessionId(hostId, remoteSessionId)
    if (localSessionId === null) {
      return { ok: false, reason: 'invalid-descriptor', localSessionId: null }
    }
    if (!sessions || typeof sessions.create !== 'function') {
      return { ok: false, reason: 'sessions-unavailable', localSessionId }
    }
    const live = typeof sessions.get === 'function' ? sessions.get(localSessionId) : undefined
    const resync = decideResync({ cursor: descriptor?.cursor, live: Boolean(live) })
    if (live) {
      return { ok: true, created: false, localSessionId, cursor: resync.from, resync: null }
    }
    try {
      sessions.create(localSessionId, buildCreateOptions(descriptor))
    } catch (error) {
      logger.warn?.('[dsh-remote-go] cannot create the mirror session:', error)
      return { ok: false, reason: 'create-failed', localSessionId, error: messageOf(error) }
    }
    return {
      ok: true,
      created: true,
      localSessionId,
      cursor: resync.from,
      resync,
      notice: resync.notice,
    }
  }

  /**
   * Append one remote event to the local mirror session.
   *
   * `surfaceOp: 'append'` is added only for the five surface event types; other
   * events are appended with the two-argument form the host expects.
   *
   * @param {string} localSessionId
   * @param {any} event `{ type, data }`
   * @returns {AdapterResult}
   */
  function appendEvent(localSessionId, event) {
    const id = typeof localSessionId === 'string' ? localSessionId : ''
    const type = typeof event?.type === 'string' ? event.type.trim() : ''
    if (id === '' || type === '') return { ok: false, reason: 'invalid-event', localSessionId: id || null }
    const sessions = resolveSessions()
    if (!sessions || typeof sessions.get !== 'function') {
      return { ok: false, reason: 'sessions-unavailable', localSessionId: id }
    }
    const session = sessions.get(id)
    if (!session || typeof session.append !== 'function') {
      return { ok: false, reason: 'session-unavailable', localSessionId: id }
    }
    const data = event.data === undefined ? {} : event.data
    const surface = SURFACE_EVENT_TYPES.includes(type)
    try {
      const appended = surface ? session.append(type, data, { surfaceOp: 'append' }) : session.append(type, data)
      return { ok: true, localSessionId: id, type, surface, seq: appended?.seq ?? null }
    } catch (error) {
      logger.warn?.('[dsh-remote-go] cannot append to the mirror session:', error)
      return { ok: false, reason: 'append-failed', localSessionId: id, error: messageOf(error) }
    }
  }

  /**
   * Forget a mirror session.
   *
   * The v1 `sessions` service publishes no delete: a session created here is
   * owned by the plugin fiber and is removed when that fiber is disposed (plugin
   * unload), which is why the result reports `removed: false` /
   * `reason: 'fiber-owned'` instead of pretending to delete. A host that later
   * adds `removeSession`/`remove`/`delete` is used through that escape hatch.
   *
   * @param {string} localSessionId
   * @returns {AdapterResult}
   */
  function removeMirrorSession(localSessionId) {
    const sessions = resolveSessions()
    const id = typeof localSessionId === 'string' ? localSessionId.trim() : ''
    if (id === '') return { ok: false, reason: 'invalid-descriptor', localSessionId: null }
    if (!sessions) return { ok: false, reason: 'sessions-unavailable', localSessionId: id }
    const live = typeof sessions.get === 'function' ? sessions.get(id) : undefined
    if (!live) return { ok: true, localSessionId: id, removed: false, reason: 'not-found' }
    const remover = sessions.removeSession ?? sessions.remove ?? sessions.delete
    if (typeof remover === 'function') {
      try {
        remover.call(sessions, id)
        return { ok: true, localSessionId: id, removed: true, reason: null }
      } catch (error) {
        logger.warn?.('[dsh-remote-go] cannot remove the mirror session:', error)
        return { ok: false, reason: 'remove-failed', localSessionId: id, error: messageOf(error) }
      }
    }
    return { ok: true, localSessionId: id, removed: false, reason: 'fiber-owned' }
  }

  /**
   * Translate a descriptor into `create` options. `meta.cwd` is only passed when
   * it is absolute (the host rejects anything else); P0 has no seed because the
   * directory level carries no history.
   * @param {any} descriptor
   * @returns {{ seed?: any[], meta?: Record<string, any> }}
   */
  function buildCreateOptions(descriptor) {
    /** @type {{ seed?: any[], meta?: Record<string, any> }} */
    const createOptions = {}
    if (Array.isArray(descriptor?.seed) && descriptor.seed.length > 0) {
      createOptions.seed = descriptor.seed.map((event) => ({ ...event }))
    }
    const cwd = typeof descriptor?.cwd === 'string' ? descriptor.cwd : options.cwd
    if (isAbsolutePath(cwd)) createOptions.meta = { cwd }
    return createOptions
  }

  return { available, ensureMirrorSession, appendEvent, removeMirrorSession }
}

/** @param {unknown} value @returns {boolean} */
function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  return /^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
}

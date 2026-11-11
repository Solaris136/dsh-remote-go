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
import { mkdirSync, realpathSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { MIRROR_ID_PREFIX, decideResync, mirrorSessionId } from './mirror.js'

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
 *   mirrorRoot?: string | null,
 *   cwd?: string | null,
 *   logger?: { warn?: (...args: any[]) => void },
 * }} [options] `mirrorRoot` is the per-host session cwd root; `cwd` is the
 * fallback used when no mirror root is configured. Both must be absolute to be
 * passed to the host (`meta.cwd` is validated).
 * @returns {{
 *   available: () => boolean,
 *   ensureMirrorSession: (descriptor: any) => AdapterResult,
 *   ensureMirrorCwd: (descriptor: any) => Promise<string | null>,
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
   * Resolve the local session id of a descriptor.
   *
   * A persisted/remote-supplied id is only trusted when it carries the `mirror_`
   * prefix and equals the value derived from `hostId` + `remoteSessionId`;
   * otherwise it is re-derived. This keeps a corrupt or hostile descriptor from
   * addressing an unrelated local session.
   * @param {any} descriptor
   * @returns {string | null}
   */
  function resolveLocalSessionId(descriptor) {
    const hostId = typeof descriptor?.hostId === 'string' ? descriptor.hostId : ''
    const remoteSessionId = typeof descriptor?.remoteSessionId === 'string' ? descriptor.remoteSessionId : ''
    const derived = mirrorSessionId(hostId, remoteSessionId)
    if (derived === null) return null
    const candidate = typeof descriptor?.localSessionId === 'string' ? descriptor.localSessionId.trim() : ''
    return candidate.startsWith(MIRROR_ID_PREFIX) && candidate === derived ? candidate : derived
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
    const localSessionId = resolveLocalSessionId(descriptor)
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
   * events are appended with the two-argument form the host expects. The target
   * must be a mirror session id (`mirror_` prefix), so this helper can never
   * inject events into an unrelated local session.
   *
   * @param {string} localSessionId
   * @param {any} event `{ type, data }`
   * @returns {AdapterResult}
   */
  function appendEvent(localSessionId, event) {
    const id = typeof localSessionId === 'string' ? localSessionId.trim() : ''
    const type = typeof event?.type === 'string' ? event.type.trim() : ''
    if (id === '' || !id.startsWith(MIRROR_ID_PREFIX)) {
      return { ok: false, reason: 'invalid-session-id', localSessionId: id || null }
    }
    if (type === '') return { ok: false, reason: 'invalid-event', localSessionId: id }
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
   * The local working directory for one mirror session.
   *
   * All mirrors sharing `$DSH_HOME` as cwd would look identical and would write
   * into the plugin's own state directory. Each host gets its own directory under
   * the mirror root instead. The remote workspace path is never used: it is a
   * remote path that may not exist on this machine. `null` means "no absolute
   * cwd available", so the host default applies.
   * @param {any} descriptor
   * @returns {string | null}
   */
  function mirrorCwd(descriptor) {
    const mirrorRoot = typeof options.mirrorRoot === 'string' ? options.mirrorRoot.trim() : ''
    if (mirrorRoot !== '') {
      // A configured root owns the cwd. A relative root would produce a relative
      // `meta.cwd`, which the host rejects ("cwd must be an absolute path"), so it
      // is ignored entirely — deliberately without falling back to another cwd —
      // so the host default applies instead of failing every mirror session.
      return mirrorHostDir(mirrorRoot, descriptor?.hostId)
    }
    const cwd = typeof descriptor?.cwd === 'string' ? descriptor.cwd : options.cwd
    return isAbsolutePath(cwd) ? cwd : null
  }

  /**
   * Create the per-host mirror working directory, if one is configured. The host
   * keys storage off `meta.cwd`, so the directory must exist before the session
   * is created. Never throws: a failure only means the host default cwd is used.
   * @param {any} descriptor
   * @returns {Promise<string | null>}
   */
  async function ensureMirrorCwd(descriptor) {
    const cwd = mirrorCwd(descriptor)
    if (cwd === null) return null
    try {
      await fsp.mkdir(cwd, { recursive: true, mode: 0o700 })
      return cwd
    } catch (error) {
      logger.warn?.('[dsh-remote-go] cannot create the mirror session directory:', error)
      return null
    }
  }

  /**
   * Translate a descriptor into `create` options.
   *
   * `meta.cwd` is only passed when absolute (the host rejects anything else) and
   * `meta.isSeeded` marks the session as a replay/projection, so a leftover mirror
   * is identifiable after a restart. DSH cannot carry `hostId`/`remoteSessionId`
   * in `meta` (fixed `SessionHeader`), so that lineage stays in `mirrors.json`.
   * P0 has no seed because the directory level carries no history.
   * @param {any} descriptor
   * @returns {{ seed?: any[], meta?: Record<string, any> }}
   */
  function buildCreateOptions(descriptor) {
    /** @type {{ seed?: any[], meta?: Record<string, any> }} */
    const createOptions = {}
    if (Array.isArray(descriptor?.seed) && descriptor.seed.length > 0) {
      createOptions.seed = descriptor.seed.map((event) => ({ ...event }))
    }
    /** @type {Record<string, any>} */
    const meta = { isSeeded: true }
    const cwd = mirrorCwd(descriptor)
    if (cwd !== null) meta.cwd = cwd
    createOptions.meta = meta
    return createOptions
  }

  return { available, ensureMirrorSession, ensureMirrorCwd, appendEvent, removeMirrorSession }
}

/**
 * The per-host mirror directory, shared with the sidebar workspace registration
 * so a workspace and the sessions it groups can never disagree about the path.
 *
 * One sanitization rule for both callers: the host id keeps only
 * `[A-Za-z0-9._-]` (a remote-supplied id must never traverse directories), and an
 * empty/`.`/`..` segment falls back to `unknown`.
 *
 * @param {unknown} mirrorRoot absolute mirror root, or a non-absolute value.
 * @param {unknown} hostId
 * @returns {string | null} the absolute per-host directory, or `null` when no
 * absolute mirror root is configured (the caller then has no sidebar grouping).
 */
export function mirrorHostDir(mirrorRoot, hostId) {
  if (!isAbsolutePath(mirrorRoot)) return null
  const hostSegment = String(hostId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+$/, '')
  return path.join(String(mirrorRoot).trim(), hostSegment || 'unknown')
}

/**
 * Canonicalize the mirror root **once**, at plugin load.
 *
 * The host's `workspaceRegistry` canonicalizes every registration through
 * `fs.realpath`, while a session header keeps the exact `meta.cwd` we hand it. If
 * the mirror root is reached through a symlink or a Windows junction, the literal
 * spelling and the registry's canonical spelling differ, and sidebar grouping
 * then depends on the registry canonicalizing the *header* as well — an
 * assumption this plugin cannot verify. Realpathing the root once and giving the
 * same canonical root to both adapters makes the two spellings identical by
 * construction, on every filesystem.
 *
 * Tolerant by design: the directory is created when missing (the plugin owns
 * `$DSH_HOME/remote-go/mirrors`), and any failure falls back to the literal path,
 * so an unusual filesystem only loses the symlink guarantee — never the feature.
 *
 * @param {unknown} dir absolute mirror root as configured.
 * @param {{ logger?: { warn?: (...args: any[]) => void } }} [options]
 * @returns {string} the canonical mirror root, or the literal path on failure.
 */
export function canonicalMirrorRoot(dir, options = {}) {
  const literal = typeof dir === 'string' ? dir.trim() : ''
  if (literal === '') return literal
  try {
    mkdirSync(literal, { recursive: true, mode: 0o700 })
    return realpathSync(literal)
  } catch (error) {
    const logger = options.logger ?? console
    logger.warn?.('[dsh-remote-go] cannot canonicalize the mirror root; using the literal path:', error)
    return literal
  }
}

/** @param {unknown} value @returns {boolean} */
function isAbsolutePath(value) {
  return typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value.trim())
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
}

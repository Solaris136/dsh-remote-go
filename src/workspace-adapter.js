/**
 * Optional adapter over the Host `workspaceRegistry` service (`ctx.workspaceRegistry`).
 *
 * Why this exists: the P0 directory mirror creates one local session per remote
 * session, each with `meta.cwd = $DSH_HOME/remote-go/mirrors/<hostId>`. DSH's
 * sidebar lists sessions **per workspace**, and workspace membership is derived
 * from the session header's canonical cwd — the workspace registry builds one
 * canonical-cwd header index and every `Workspace.sessionIds` getter is filtered
 * by it (verified with Cordis Inspect; docs/session-design.md §4.3). So a mirror
 * directory that is not registered as a workspace leaves every mirrored session
 * invisible in the UI.
 *
 * Facts this module is written against (Host `workspaceRegistry`, verified):
 *
 * - `create(path, title?)` requires an **existing** directory, canonicalizes it
 *   through `fs.realpath`, and is idempotent: repeated calls for the same
 *   canonical path return the existing entity without changing its title.
 * - `resolveByPath(path)` resolves without creating; an unowned directory (or a
 *   missing path, which rejects) means "not registered yet".
 * - `delete(id)` removes the registration, keeps the directory and every session
 *   log, and is an idempotent no-op for unknown ids.
 * - `Workspace.setTitle(title)` renames an existing registration.
 *
 * Every method returns a typed result instead of throwing: a missing or broken
 * registry must degrade the sidebar grouping, never the connect path. No DSH
 * package is imported, so each branch is unit-testable with a fake registry.
 */
import { promises as fsp } from 'node:fs'
import { mirrorHostDir } from './session-adapter.js'

/** Title prefix that marks a workspace as plugin-owned (see `hostWorkspaceTitle`). */
export const WORKSPACE_TITLE_PREFIX = 'Remote: '

/**
 * @typedef {{
 *   ok: boolean,
 *   enabled: boolean,
 *   reason: string | null,
 *   hostId: string | null,
 *   path: string | null,
 *   title: string | null,
 *   workspaceId: string | null,
 *   created: boolean,
 *   renamed: boolean,
 *   error?: string,
 * }} EnsureWorkspaceResult
 * @typedef {{
 *   ok: boolean,
 *   reason: string | null,
 *   hostId: string | null,
 *   path: string | null,
 *   workspaceId: string | null,
 *   removed: boolean,
 *   error?: string,
 * }} RemoveWorkspaceResult
 */

/**
 * The sidebar title of one host's mirror workspace.
 *
 * The prefix makes plugin-owned groups recognisable at a glance and lets a
 * title sync distinguish "we own this title" from "the user renamed it".
 * @param {unknown} hostName
 * @param {unknown} [hostId] fallback when the host has no name yet.
 * @returns {string}
 */
export function hostWorkspaceTitle(hostName, hostId = '') {
  const name = typeof hostName === 'string' ? hostName.trim() : ''
  const fallback = typeof hostId === 'string' ? hostId.trim() : ''
  return `${WORKSPACE_TITLE_PREFIX}${name || fallback || 'remote'}`
}

/**
 * Build the adapter for one plugin lifetime.
 *
 * @param {{
 *   ctx?: any,
 *   registry?: any,
 *   mirrorRoot?: string | null,
 *   logger?: { warn?: (...args: any[]) => void },
 * }} [options] `registry` injects the service directly (tests); otherwise it is
 * resolved lazily from `ctx.get('workspaceRegistry')` on every call, so a
 * composition that publishes the registry after this plugin loads still works.
 * @returns {{
 *   available: () => boolean,
 *   hostDir: (hostId: unknown) => string | null,
 *   ensureHostWorkspace: (request: { hostId?: unknown, hostName?: unknown, enabled?: boolean }) => Promise<EnsureWorkspaceResult>,
 *   removeHostWorkspace: (request: { hostId?: unknown }) => Promise<RemoveWorkspaceResult>,
 * }}
 */
export function createWorkspaceAdapter(options = {}) {
  const logger = options.logger ?? console

  /** @returns {any | null} */
  function resolveRegistry() {
    if (options.registry && typeof options.registry === 'object') return options.registry
    const ctx = options.ctx ?? null
    if (!ctx || typeof ctx.get !== 'function') return null
    try {
      const registry = ctx.get('workspaceRegistry')
      return registry && typeof registry === 'object' ? registry : null
    } catch (error) {
      logger.warn?.('[dsh-remote-go] cannot resolve the workspace registry service:', error)
      return null
    }
  }

  /** @returns {boolean} */
  function available() {
    const registry = resolveRegistry()
    return Boolean(registry && typeof registry.create === 'function')
  }

  /**
   * The mirror directory of one host (shared with the session adapter, so the
   * workspace and the sessions it groups always agree on the path).
   * @param {unknown} hostId
   * @returns {string | null}
   */
  function hostDir(hostId) {
    return mirrorHostDir(options.mirrorRoot, hostId)
  }

  /**
   * Ensure the host's mirror directory is registered as a sidebar workspace.
   *
   * Idempotent: re-running on reconnect resolves the existing registration
   * instead of creating a second one. A host rename updates the title only while
   * the registration still carries the plugin-owned prefix, so a deliberate user
   * rename is never overwritten.
   *
   * @param {{ hostId?: unknown, hostName?: unknown, enabled?: boolean }} [request]
   * @returns {Promise<EnsureWorkspaceResult>}
   */
  async function ensureHostWorkspace(request = {}) {
    const hostId = typeof request.hostId === 'string' ? request.hostId.trim() : ''
    /** @type {EnsureWorkspaceResult} */
    const base = {
      ok: false,
      enabled: request.enabled !== false,
      reason: null,
      hostId: hostId || null,
      path: null,
      title: null,
      workspaceId: null,
      created: false,
      renamed: false,
    }
    if (!base.enabled) return { ...base, ok: true, reason: 'disabled' }
    if (hostId === '') return { ...base, reason: 'invalid-host' }
    const dir = hostDir(hostId)
    if (dir === null) return { ...base, reason: 'no-mirror-root' }
    const title = hostWorkspaceTitle(request.hostName, hostId)
    const registry = resolveRegistry()
    if (!registry || typeof registry.create !== 'function') {
      return { ...base, path: dir, title, reason: 'workspaces-unavailable' }
    }
    try {
      // `create` rejects a missing directory (realpath), so make sure the
      // per-host mirror directory exists first. `recursive` keeps it idempotent.
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      /** @type {any} */
      let existing = null
      if (typeof registry.resolveByPath === 'function') {
        try {
          existing = await registry.resolveByPath(dir)
        } catch {
          // A missing path rejects during realpath; `create` below is itself
          // idempotent, so this only costs the precise `created` flag.
          existing = null
        }
      }
      if (existing && typeof existing === 'object') {
        let renamed = false
        const currentTitle = typeof existing.title === 'string' ? existing.title : ''
        if (currentTitle !== title && currentTitle.startsWith(WORKSPACE_TITLE_PREFIX)) {
          if (typeof existing.setTitle === 'function') {
            await existing.setTitle(title)
            renamed = true
          }
        }
        return {
          ...base,
          ok: true,
          path: dir,
          title,
          workspaceId: typeof existing.id === 'string' ? existing.id : null,
          created: false,
          renamed,
        }
      }
      const workspace = await registry.create(dir, title)
      return {
        ...base,
        ok: true,
        path: dir,
        title,
        workspaceId: workspace && typeof workspace.id === 'string' ? workspace.id : null,
        created: true,
      }
    } catch (error) {
      // Sidebar grouping is a convenience: log and degrade, never fail a connect.
      logger.warn?.('[dsh-remote-go] cannot register the mirror workspace:', error)
      return { ...base, path: dir, title, reason: 'create-failed', error: messageOf(error) }
    }
  }

  /**
   * Remove one host's sidebar workspace registration (host deleted / mirrors
   * disabled for good). Retains the directory, so a later reconnect can recreate
   * the registration with the same path and sessions keep their ids.
   *
   * @param {{ hostId?: unknown }} [request]
   * @returns {Promise<RemoveWorkspaceResult>}
   */
  async function removeHostWorkspace(request = {}) {
    const hostId = typeof request.hostId === 'string' ? request.hostId.trim() : ''
    /** @type {RemoveWorkspaceResult} */
    const base = {
      ok: false,
      reason: null,
      hostId: hostId || null,
      path: null,
      workspaceId: null,
      removed: false,
    }
    if (hostId === '') return { ...base, reason: 'invalid-host' }
    const dir = hostDir(hostId)
    if (dir === null) return { ...base, reason: 'no-mirror-root' }
    const registry = resolveRegistry()
    if (!registry || typeof registry.delete !== 'function') {
      return { ...base, path: dir, reason: 'workspaces-unavailable' }
    }
    try {
      /** @type {any} */
      let existing = null
      if (typeof registry.resolveByPath === 'function') {
        try {
          existing = await registry.resolveByPath(dir)
        } catch {
          existing = null
        }
      }
      if (!existing || typeof existing !== 'object') {
        return { ...base, ok: true, path: dir, reason: 'not-found' }
      }
      const workspaceId = typeof existing.id === 'string' ? existing.id : null
      if (workspaceId === null) return { ...base, ok: true, path: dir, reason: 'not-found' }
      const removed = await registry.delete(workspaceId)
      return { ...base, ok: true, path: dir, workspaceId, removed: removed !== false, reason: null }
    } catch (error) {
      logger.warn?.('[dsh-remote-go] cannot remove the mirror workspace:', error)
      return { ...base, path: dir, reason: 'delete-failed', error: messageOf(error) }
    }
  }

  return { available, hostDir, ensureHostWorkspace, removeHostWorkspace }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
}

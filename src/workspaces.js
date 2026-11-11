/**
 * Workspace inventory for the panel's workspace rail (local + per-remote).
 *
 * DSH's durable Workspace registry is `${DSH_HOME}/storages/workspace.json`
 * (unit name `workspace`, version 2): `global.workspaceIds` holds the display
 * order and `tables.workspaces[id]` holds `{ path, title, sessionIds, ... }`.
 * The local half reads this file directly; the remote half reads the same file
 * over the existing SSH connection, so the panel can group workspaces by
 * remote without reimplementing DSH's Workspace UI.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   path: string,
 *   sessionCount: number,
 *   sessionIds: string[],
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   isDefault: boolean,
 * }} WorkspaceItem
 */

/**
 * @param {unknown} value
 * @returns {{ initialized: boolean, defaultWorkspaceId: string | null, workspaces: WorkspaceItem[] }}
 */
export function parseWorkspaceStorage(value) {
  const empty = { initialized: false, defaultWorkspaceId: null, workspaces: [] }
  if (!value || typeof value !== 'object') return empty
  const root = /** @type {any} */ (value)
  const global = root.global && typeof root.global === 'object' ? root.global : {}
  const table = root.tables?.workspaces && typeof root.tables.workspaces === 'object' ? root.tables.workspaces : {}
  const defaultWorkspaceId = typeof global.defaultWorkspaceId === 'string' ? global.defaultWorkspaceId : null
  /** @type {string[]} */
  const ordered = Array.isArray(global.workspaceIds)
    ? global.workspaceIds.filter((id) => typeof id === 'string' && id in table)
    : []
  // Any workspace missing from the order list still exists; append deterministically.
  for (const id of Object.keys(table)) if (!ordered.includes(id)) ordered.push(id)
  const workspaces = ordered.map((id) => {
    const entry = table[id] ?? {}
    const rawTitle = typeof entry.title === 'string' ? entry.title.trim() : ''
    const rawPath = typeof entry.path === 'string' ? entry.path : ''
    const title = rawTitle || rawPath.split(/[\\/]/).filter(Boolean).pop() || id
    // One entry per distinct session: duplicates are not separate sessions, and
    // `sessionCount` must keep its v1 meaning (number of sessions) and equal the
    // deduplicated list the L1 mirror plans one descriptor per.
    const seen = new Set()
    /** @type {string[]} */
    const sessionIds = []
    if (Array.isArray(entry.sessionIds)) {
      for (const raw of entry.sessionIds) {
        if (typeof raw !== 'string' || raw === '' || seen.has(raw)) continue
        seen.add(raw)
        sessionIds.push(raw)
      }
    }
    return {
      id,
      title,
      path: rawPath,
      sessionCount: sessionIds.length,
      // Additive v1.1 field: the L1 mirror needs the ids, not just the count.
      sessionIds,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
      isDefault: id === defaultWorkspaceId,
    }
  })
  return { initialized: global.initialized === true, defaultWorkspaceId, workspaces }
}

/**
 * Read the local DSH Workspace registry from disk.
 * @param {{ home: string, readFileImpl?: typeof readFile, exists?: (path: string) => boolean }} input
 */
export async function readLocalWorkspaces(input) {
  const file = path.join(input.home, 'storages', 'workspace.json')
  const exists = input.exists ?? existsSync
  const read = input.readFileImpl ?? readFile
  if (!exists(file)) return { source: 'file', file, ...parseWorkspaceStorage(null) }
  try {
    const text = await read(file, 'utf8')
    return { source: 'file', file, ...parseWorkspaceStorage(JSON.parse(text)) }
  } catch {
    return { source: 'file', file, ...parseWorkspaceStorage(null) }
  }
}

/**
 * Path of the remote registry inside a remote DSH_HOME.
 * @param {string} remoteDshHome absolute POSIX path (e.g. /home/ubuntu/.dsh-remote-go/home)
 */
export function remoteWorkspaceStoragePath(remoteDshHome) {
  return `${String(remoteDshHome).replace(/\/+$/, '')}/storages/workspace.json`
}

/**
 * Read the remote DSH Workspace registry over an existing SSH connection.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {string} remoteDshHome
 * @param {{ timeoutMs?: number }} [options]
 */
export async function readRemoteWorkspaces(ssh, remoteDshHome, options = {}) {
  const file = remoteWorkspaceStoragePath(remoteDshHome)
  const quoted = `'${file.replaceAll("'", `'\\''`)}'`
  const result = await ssh.exec(`cat ${quoted} 2>/dev/null || true`, {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBytes: 4 * 1024 * 1024,
  })
  if (result.code !== 0 || result.stdout.trim() === '') {
    return { ok: false, file, reason: 'missing', ...parseWorkspaceStorage(null) }
  }
  try {
    return { ok: true, file, ...parseWorkspaceStorage(JSON.parse(result.stdout)) }
  } catch {
    return { ok: false, file, reason: 'malformed', ...parseWorkspaceStorage(null) }
  }
}

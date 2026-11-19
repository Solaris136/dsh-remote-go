/**
 * The URL shapes of the same-origin proxy: which view path names which host, and the exact
 * upgrade pathname one host's stream arrives on.
 */
import { REMOTE_VIEW_PREFIX } from '../constants.js'

/** How long the remote web UI's own stream route is (the only upgrade a DSH web serves). */
const REMOTE_STREAM_PATH = '/api/remote.mux'

/** One host id, as the view prefix and the run registry spell it. */
export const HOST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** One well-formed view path: the host it addresses and the path to forward upstream. */
export interface ViewPath {
  hostId: string
  path: string
}

/**
 * Split `/dsh-remote-go/remote/<hostId>/<rest>` into its host and the upstream path.
 * Returns null for anything that is not one well-formed view path (encoded slashes included).
 * @param pathname - URL pathname; anything else is refused, so the guard stays.
 */
export function parseViewPath(pathname: string): ViewPath | null {
  if (typeof pathname !== 'string' || !pathname.startsWith(REMOTE_VIEW_PREFIX)) return null
  const rest = pathname.slice(REMOTE_VIEW_PREFIX.length)
  const slash = rest.indexOf('/')
  const rawId = slash === -1 ? rest : rest.slice(0, slash)
  let hostId: string
  try {
    hostId = decodeURIComponent(rawId)
  } catch {
    return null
  }
  if (!HOST_ID_PATTERN.test(hostId)) return null
  // The seat is always `<prefix><hostId>/`: the bare id is not a page.
  if (slash === -1) return null
  const upstream = rest.slice(slash)
  return { hostId, path: upstream === '' ? '/' : upstream }
}

/** Exact pathname the remote's stream upgrade arrives on. */
export function upgradePath(hostId: string): string {
  return `${REMOTE_VIEW_PREFIX}${hostId}${REMOTE_STREAM_PATH}`
}

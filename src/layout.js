/**
 * Remote directory layout: everything the plugin writes lives under `$DSH_HOME/remote-go`, so a host only gets `~/.dsh` plus that one subdirectory.
 */
import { REMOTE_DSH_DIR, REMOTE_STATE_DIR } from './constants.js'
import { errors } from './errors.js'

/**
 * Build the remote layout for a known home directory.
 *
 * The home has to be a real absolute path: an unexpanded `~` is not expanded by a
 * non-interactive shell, so a layout built without it would silently address a literal
 * `~` directory (`kill -0` a `~`-path pid is a no-op that still exits 0). Refusing here
 * keeps every caller honest instead of pretending such a command worked.
 *
 * @param {string} home - the remote user's absolute home directory.
 * @returns {{ root: string, stateHome: string, dshHome: string, nodeDir: string,
 *   downloadDir: string, logsDir: string, logFile: string, runDir: string, runFile: string }}
 */
export function remoteLayout(home) {
  const base = typeof home === 'string' ? home.trim().replace(/\/+$/, '') : ''
  if (!base.startsWith('/')) {
    throw errors.internal(
      new Error(`the remote home directory is unknown (${JSON.stringify(home)}); refusing to build a "~" layout`),
    )
  }
  const dshHome = `${base}/${REMOTE_DSH_DIR}`
  const root = `${dshHome}/${REMOTE_STATE_DIR}`
  return {
    root,
    // Kept for callers that resolve the remote DSH home separately from the
    // plugin's own state directory.
    stateHome: dshHome,
    // The remote DSH runs with its real home, so its data is the user's own.
    dshHome,
    nodeDir: `${root}/node`,
    downloadDir: `${root}/downloads`,
    logsDir: `${root}/logs`,
    logFile: `${root}/logs/web.log`,
    runDir: `${root}/run`,
    runFile: `${root}/run/web.json`,
  }
}

/**
 * The layout a host runtime describes: the facts its live connection probed, or the home
 * it remembered before those facts were cleared (keep-alive / idle policy).
 * @param {{ facts?: { home?: string } | null, remoteHome?: string | null }} runtime
 * @returns {ReturnType<typeof remoteLayout>}
 */
export function layoutForRuntime(runtime) {
  const home = runtime?.facts?.home ?? runtime?.remoteHome ?? null
  return remoteLayout(home)
}

/**
 * Remote directory layout.
 *
 * Everything the plugin writes on the remote lives inside the remote DSH home:
 * `$DSH_HOME/remote-go` holds logs, the run registry and the managed Node runtime,
 * so a host only ever gets `~/.dsh` (the user's own DSH data) plus this one
 * subdirectory — no root, no global installs.
 *
 * `home` comes from the probe. Before the probe the tilde is preserved; callers
 * must expand it before any shell use (every connect-time caller has the facts).
 */
import { REMOTE_DSH_DIR, REMOTE_STATE_DIR } from './constants.js'

/**
 * @param {string | null} [home] remote user home directory reported by the probe
 * @returns {{
 *   root: string,
 *   stateHome: string,
 *   dshHome: string,
 *   nodeDir: string,
 *   downloadDir: string,
 *   logsDir: string,
 *   logFile: string,
 *   runDir: string,
 *   runFile: string,
 * }}
 */
export function remoteLayout(home = null) {
  const dshHome = expandRemoteTilde(`~/${REMOTE_DSH_DIR}`, home).replace(/\/+$/, '')
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
 * Expand a leading `~` (or `~/`) with a known remote home. When `home` is not
 * known yet the tilde is preserved; callers must expand before shell use.
 * @param {string} value
 * @param {string | null | undefined} home
 */
export function expandRemoteTilde(value, home) {
  const text = String(value ?? '')
  if (!home) return text
  if (text === '~') return home
  if (text.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${text.slice(2)}`
  return text
}

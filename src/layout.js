/**
 * Remote directory layout: the remote DSH keeps its own data in `$HOME/.dsh`, while
 * the plugin keeps only its bookkeeping (logs, run registry, lease/helper files) in
 * a user-owned state directory. No root, no global installs.
 *
 * `remoteDir` may be written with a leading `~`; once the remote home is known
 * (probe) callers pass it so the layout holds absolute paths that shell-quote
 * safely. Before the probe, `expandRemoteTilde` runs inside the probe script
 * itself, so no shell ever sees a literal `~`.
 */
import { REMOTE_DSH_DIR } from './constants.js'

/**
 * @param {string} remoteDir
 * @param {string | null} [home]
 * @returns {{
 *   root: string,
 *   stateHome: string,
 *   dshHome: string,
 *   logsDir: string,
 *   logFile: string,
 *   runDir: string,
 *   runFile: string,
 * }}
 */
export function remoteLayout(remoteDir, home = null) {
  const root = expandRemoteTilde(remoteDir || '~/.dsh-remote-go', home).replace(/\/+$/, '')
  return {
    root,
    // Lease records and the follower helper are plugin bookkeeping, not DSH data.
    // They live under the plugin's own root so `$HOME/.dsh` stays the remote DSH's.
    stateHome: root,
    // The remote DSH is deliberately run with its real home, so credentials,
    // sessions and workspaces are the user's own (`~/.dsh`).
    dshHome: expandRemoteTilde(`~/${REMOTE_DSH_DIR}`, home).replace(/\/+$/, ''),
    logsDir: `${root}/logs`,
    logFile: `${root}/logs/web.log`,
    runDir: `${root}/run`,
    runFile: `${root}/run/web.json`,
  }
}

/**
 * Expand a leading `~` (or `~/`) with a known remote home. When `home` is not
 * known yet the tilde is preserved; callers must expand before shell use.
 * @param {string} remoteDir
 * @param {string | null | undefined} home
 */
export function expandRemoteTilde(remoteDir, home) {
  const text = String(remoteDir ?? '')
  if (!home) return text
  if (text === '~') return home
  if (text.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${text.slice(2)}`
  return text
}

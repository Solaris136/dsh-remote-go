/**
 * Remote directory layout: everything the plugin writes lives under `$DSH_HOME/remote-go`, so a host only gets `~/.dsh` plus that one subdirectory.
 */
import { REMOTE_DSH_DIR, REMOTE_STATE_DIR } from './constants.js'

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
 */
function expandRemoteTilde(value, home) {
  const text = String(value ?? '')
  if (!home) return text
  if (text === '~') return home
  if (text.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${text.slice(2)}`
  return text
}

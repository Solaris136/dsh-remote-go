/** Remote directory layout: everything the plugin writes lives under `$DSH_HOME/remote-go`, so a host gets only
 * `~/.dsh` plus that one subdirectory. */
import { REMOTE_DSH_DIR, REMOTE_STATE_DIR } from './constants.js'
import { errors } from './errors.js'
export interface RemoteLayout {
  root: string
  stateHome: string
  dshHome: string
  nodeDir: string
  downloadDir: string
  logsDir: string
  logFile: string
  runDir: string
  runFile: string
}

export function remoteLayout(home: unknown): RemoteLayout {
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
    stateHome: dshHome,
    dshHome,
    nodeDir: `${root}/node`,
    downloadDir: `${root}/downloads`,
    logsDir: `${root}/logs`,
    logFile: `${root}/logs/web.log`,
    runDir: `${root}/run`,
    runFile: `${root}/run/web.json`,
  }
}

export function layoutForRuntime(
  runtime: { facts?: { home?: string | null } | null; remoteHome?: string | null } | null | undefined,
): RemoteLayout {
  return remoteLayout(runtime?.facts?.home ?? runtime?.remoteHome ?? null)
}

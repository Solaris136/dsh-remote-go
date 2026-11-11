/**
 * Remote directory layout: everything the plugin creates on the remote host
 * lives under one user-owned directory (no root, no global installs; design §16.2).
 *
 * `remoteDir` may be written with a leading `~`; once the remote home is known
 * (probe) callers pass it so the layout holds absolute paths that shell-quote
 * safely. Before the probe, `expandRemoteTilde` runs inside the probe script
 * itself, so no shell ever sees a literal `~`.
 */

/**
 * @param {string} remoteDir
 * @param {string | null} [home]
 */
export function remoteLayout(remoteDir, home = null) {
  const root = expandRemoteTilde(remoteDir || '~/.dsh-remote-go', home).replace(/\/+$/, '')
  return {
    root,
    nodeDir: `${root}/node`,
    nodeBin: `${root}/node/bin/node`,
    nodeBinDir: `${root}/node/bin`,
    npxBin: `${root}/node/bin/npx`,
    home: `${root}/home`,
    dshHome: `${root}/dsh-home`,
    dshBin: `${root}/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js`,
    dshPkg: `${root}/dsh-home/node_modules/@deepseek-ai/dsh/package.json`,
    downloadsDir: `${root}/downloads`,
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

/** Files worth uploading for the deferred offline bootstrap (V1.1 hook). */
export function offlineExpectations(layout) {
  return {
    nodeArchive: `${layout.downloadsDir}/node-linux-x64.tar.xz`,
    dshTarball: `${layout.downloadsDir}/deepseek-ai-dsh.tgz`,
  }
}

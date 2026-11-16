/**
 * Remote DSH web lifecycle — the surface callers import: `remote-web.js` owns start/stop/adopt, `remote-proc.js` the scan and reachability primitives.
 */
export {
  LAUNCH_MARKER,
  BROWSER_CARRIER_PATCH_FILE,
  parseWebLine,
  buildStartCommand,
  buildBrowserCarrierProbe,
  ensureBrowserCarrier,
  buildStartScript,
  startRemoteWeb,
  stopRemoteWeb,
  clearRunRegistry,
  readRunRegistry,
  readWebLineFromLog,
  remotePidAlive,
  adoptRemoteWeb,
  buildRunRegistryRecord,
  writeRunRegistry,
  commandMatchesProfile,
  versionFromCommand,
  dshPackageDirFromCommand,
  remoteDshVersion,
  resolveRemoteWeb,
} from './remote-web.js'

export {
  buildForeignDshCommand,
  parseForeignDshOutput,
  findForeignDshProcesses,
  stopForeignDshProcesses,
  parseListenPorts,
  remoteListenPorts,
  remotePortOwnerPid,
  parseProcessIdentity,
  remoteProcessIdentity,
  remoteHttpStatus,
  waitForRemoteUi,
  exchangeTokenOverTunnel,
} from './remote-proc.js'

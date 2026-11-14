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
  readRunRegistry,
  readWebLineFromLog,
  remotePidAlive,
  adoptRemoteWeb,
} from './remote-web.js'

export {
  buildForeignDshCommand,
  parseForeignDshOutput,
  findForeignDshProcesses,
  stopForeignDshProcesses,
  remoteHttpStatus,
  waitForRemoteUi,
  exchangeTokenOverTunnel,
} from './remote-proc.js'

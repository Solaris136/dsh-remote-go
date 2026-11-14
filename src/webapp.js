/**
 * Remote DSH web lifecycle — the public surface of the two modules behind it:
 * `remote-web.js` owns start/stop/adopt, `remote-proc.js` owns the process scan
 * and reachability primitives. Callers keep importing from here.
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

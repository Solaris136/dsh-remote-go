/**
 * Everything the pipeline needs to move bytes: resolve the SSH destination (entry + local ssh
 * config), remember the session fingerprint, open the loopback listener and settle the SSH
 * password once the handshake proved it.
 *
 * The dial itself (`openTransport`) and its close listener live in `pipeline.ts` although
 * design-arch §3.2 files them here: the listener asks the retry policy to re-enter the pipeline
 * (`retryNow`), so keeping it here would close an import cycle `pipeline -> transport -> pipeline`
 * (P2d acceptance: no cycles between `src/connect/*`). Everything below is acyclic: it imports
 * `guards` and the service leaves only.
 */
import type { Config, HostState, Reporter, Store, Transport } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import { findKnownHostEntries, parseKnownHosts } from '../known-hosts.js'
import type { HostEntry } from '../settings.js'
import { resolveDestination } from '../ssh-config.js'
import type { ResolvedDestination } from '../ssh-config.js'
import type { Tunnel } from '../tunnel.js'
import { isPid } from '../util.js'
import { assertStillWanted, assertTransportOpen } from './guards.js'
import type { ConnectLogWriter } from './guards.js'

/** A resolved dial target: what the host entry plus the local ssh config turned into. */
export interface DialTarget {
  host: string
  port: number
  user?: string | null
  username: string | null
  identityFiles: string[]
  knownFingerprints: string[]
}

/** One resolved target, the entry it came from and (separately) its own jump host. */
export interface ConnectTarget extends DialTarget {
  jumpHost: ResolvedDestination | null
  entry: HostEntry
}

/** Resolve the SSH destination from the entry + local ssh config, before dialling. */
export async function resolveTargetForRuntime(ctx: Config & Transport, runtime: HostRuntime): Promise<ConnectTarget> {
  const material = await ctx.deps.loadSshMaterial({ home: ctx.userHome() })
  const entry = runtime.entry
  const resolved = resolveDestination(entry.address, { configText: material.configText, home: ctx.userHome() })
  const host = resolved.host || entry.address
  const port = entry.port && entry.port !== 22 ? entry.port : (resolved.port ?? 22)
  const knownFingerprints = findKnownHostEntries(parseKnownHosts(material.knownHostsText), host, port).map(
    (item) => item.fingerprint,
  )
  return {
    host,
    port,
    username: entry.username || resolved.user || null,
    identityFiles: resolved.identityFiles ?? [],
    knownFingerprints,
    jumpHost: entry.jumpHost
      ? resolveDestination(entry.jumpHost, { configText: material.configText, home: ctx.userHome() })
      : null,
    entry,
  }
}

/** Remember the session fingerprint so the host card shows it even without a pin. */
export function captureFingerprint(
  ctx: Reporter,
  runtime: HostRuntime,
  info: { fingerprint?: string; keyType?: string } | null,
): void {
  if (!info?.fingerprint) return
  const pinned = runtime.entry.pinnedFingerprint ?? null
  runtime.fingerprint = {
    sha256: info.fingerprint,
    keyType: info.keyType ?? 'unknown',
    status: pinned === info.fingerprint ? 'pinned' : pinned ? 'changed' : 'observed',
    pinned,
  }
  ctx.progress.log(
    runtime,
    pinned === info.fingerprint ? 'debug' : 'info',
    `host key ${info.keyType ?? 'unknown'}: ${info.fingerprint}${
      pinned === info.fingerprint ? ' (matches the pinned key)' : pinned ? ' (CHANGED from the pinned key)' : ''
    }`,
  )
  ctx.emitState()
}

/** Open the loopback tunnel for one remote port; tunnel-level failures feed the liveness confirmation. */
export async function openTunnelFor(
  ctx: HostState & Transport & Reporter,
  runtime: HostRuntime,
  remotePort: number,
): Promise<Tunnel> {
  // Never hand the tunnel factory a missing transport: a listener created with no SSH channel
  // would crash the host process on the first connection (see tunnel.js's own guard).
  assertTransportOpen(runtime)
  if (!isPid(remotePort) || remotePort > 65535) {
    throw errors.internal(new Error(`invalid remote port for the tunnel: ${remotePort}`))
  }
  const onError = () => ctx.noteRemoteUnreachable?.(runtime, 'tunnel')
  const tunnel = await ctx.deps.tunnelFactory({ ssh: runtime.ssh, remotePort, onError })
  const localPort = Number(tunnel?.localPort)
  if (!Number.isInteger(localPort) || !isPid(localPort) || localPort > 65535) {
    try {
      await tunnel?.close?.()
    } catch {}
    throw errors.internal(new Error(`the tunnel factory returned no usable local port (${tunnel?.localPort})`))
  }
  // The listener was created while the caller awaited the factory: a disconnect or a host
  // removal in that window must close it instead of publishing it (H4).
  try {
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
  } catch (error) {
    try {
      await tunnel.close()
    } catch {}
    throw error
  }
  runtime.tunnel = tunnel
  runtime.remote.localPort = localPort
  ctx.progress.log(runtime, 'info', `tunnel open: 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort}`)
  return tunnel
}

/**
 * Persist (or forget) the SSH password now that the transport accepted it. Doing this right
 * after the handshake rather than after `connected` keeps a credential the server already
 * proved even when a later bootstrap step fails, so the next attempt does not ask again.
 * @param ctx - service context.
 * @param runtime - host runtime.
 * @param log - connect log writer.
 */
export async function settlePasswordStorage(ctx: Store, runtime: HostRuntime, log: ConnectLogWriter): Promise<void> {
  const save = runtime.savePassword === true
  const forget = runtime.forgetPassword === true
  runtime.savePassword = false
  runtime.forgetPassword = false
  if (!ctx.secrets || typeof runtime.password !== 'string' || runtime.password === '') return
  if (save) {
    runtime.passwordSaved = await ctx.secrets.set(runtime.id, runtime.password)
    if (runtime.passwordSaved) log('debug', 'saved the SSH password in the credential store')
    else log('warn', 'could not save the SSH password in the credential store')
    return
  }
  if (forget) {
    const removed = await ctx.secrets.remove(runtime.id)
    runtime.passwordSaved = !removed
  }
}

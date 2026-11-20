/** Everything the pipeline needs to move bytes: resolve the SSH destination (entry + local ssh config), remember the session fingerprint, open the loopback listener and settle the SSH password once the handshake proved it. The dial and its close listener live in `pipeline.ts` although they belong here topically: the listener asks the retry policy to re-enter the pipeline, so keeping it here would close an import cycle `pipeline -> transport -> pipeline`. */
import type { Config, Reporter, Store, Transport, WatchdogCtx } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import { findKnownHostEntries, parseKnownHosts } from '../known-hosts.js'
import type { HostEntry } from '../settings.js'
import { resolveDestination, type ResolvedDestination } from '../ssh-config.js'
import type { Tunnel } from '../tunnel.js'
import { isPid } from '../util.js'
import { noteRemoteUnreachable } from '../watchdog.js'
import { assertStillWanted, assertTransportOpen } from './guards.js'
import { type ConnectLogWriter } from './guards.js'

export interface DialTarget {
  host: string
  port: number
  user?: string | null
  username: string | null
  identityFiles: string[]
  knownFingerprints: string[]
}

export type ConnectTarget = DialTarget & { jumpHost: ResolvedDestination | null; entry: HostEntry }

/** The known_hosts fingerprints for one host:port, from the SSH material the caller already read: the one lookup both a direct destination and a jump host use. */
export function knownFingerprintsFor(material: { knownHostsText: string }, host: string, port: number): string[] {
  return findKnownHostEntries(parseKnownHosts(material.knownHostsText), host, port).map((item) => item.fingerprint)
}

export async function resolveTargetForRuntime(ctx: Config & Transport, runtime: HostRuntime): Promise<ConnectTarget> {
  const material = await ctx.deps.loadSshMaterial({ home: ctx.userHome() })
  const entry = runtime.entry
  const resolved = resolveDestination(entry.address, { configText: material.configText, home: ctx.userHome() })
  const host = resolved.host || entry.address
  const port = entry.port && entry.port !== 22 ? entry.port : (resolved.port ?? 22)
  const knownFingerprints = knownFingerprintsFor(material, host, port)
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

export function captureFingerprint(
  ctx: Reporter,
  runtime: HostRuntime,
  info: { fingerprint?: string; keyType?: string } | null,
): void {
  if (!info?.fingerprint) return
  const pinned = runtime.entry.pinnedFingerprint ?? null
  const matches = pinned === info.fingerprint
  runtime.fingerprint = {
    sha256: info.fingerprint,
    keyType: info.keyType ?? 'unknown',
    status: matches ? 'pinned' : pinned ? 'changed' : 'observed',
    pinned,
  }
  ctx.progress.log(
    runtime,
    matches ? 'debug' : 'info',
    `host key ${info.keyType ?? 'unknown'}: ${info.fingerprint}${
      matches ? ' (matches the pinned key)' : pinned ? ' (CHANGED from the pinned key)' : ''
    }`,
  )
  ctx.emitState()
}

/** Open the loopback tunnel for one remote port; tunnel-level failures feed the liveness confirmation. */
export async function openTunnelFor(ctx: WatchdogCtx, runtime: HostRuntime, remotePort: number): Promise<Tunnel> {
  // Never hand the tunnel factory a missing transport: a listener with no SSH channel would crash the
  // host process on the first connection.
  assertTransportOpen(runtime)
  if (!isPid(remotePort) || remotePort > 65535) {
    throw errors.internal(new Error(`invalid remote port for the tunnel: ${remotePort}`))
  }
  const onError = () => noteRemoteUnreachable(ctx, runtime, 'tunnel')
  const tunnel = await ctx.deps.tunnelFactory({ ssh: runtime.ssh, remotePort, onError })
  const localPort = Number(tunnel?.localPort)
  if (!Number.isInteger(localPort) || !isPid(localPort) || localPort > 65535) {
    try {
      await tunnel?.close?.()
    } catch {
      // swallow-ok: the listener never carried a caller; the internal error is what matters
    }
    throw errors.internal(new Error(`the tunnel factory returned no usable local port (${tunnel?.localPort})`))
  }
  try {
    assertStillWanted(ctx, runtime)
    assertTransportOpen(runtime)
  } catch (error) {
    try {
      await tunnel.close()
    } catch {
      // swallow-ok: the cancellation error must be rethrown, not masked by a close error
    }
    throw error
  }
  runtime.tunnel = tunnel
  runtime.remote.localPort = localPort
  ctx.progress.log(runtime, 'info', `tunnel open: 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort}`)
  return tunnel
}

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

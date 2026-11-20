/** Run-registry reads that must not fail their caller: a missing or unreadable `run/web.json` only means the action cannot attribute the running pid, which is one debug line, not a connection failure. */
import type { RemoteDeps, Reporter } from '../context.js'
import type { HostRuntime } from '../host-runtime.js'
import type { RemoteLayout } from '../layout.js'
import type { RunRegistryRecord } from '../remote-web/registry.js'
import { messageOf } from '../util.js'

export async function readRegistryQuietly(
  ctx: RemoteDeps & Reporter,
  runtime: HostRuntime,
  layout: RemoteLayout,
): Promise<RunRegistryRecord | null> {
  try {
    return await ctx.deps.readRegistry(runtime.ssh, layout)
  } catch (error) {
    ctx.progress.log(runtime, 'debug', 'restart: registry read failed:', messageOf(error))
    return null
  }
}

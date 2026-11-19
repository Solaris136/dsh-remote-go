/**
 * The launch plan recomputed from the probe facts the connection already recorded: a restart
 * reuses the same managed Node, profile and pinned version, so `[ssh]`, `[probe]` and
 * `[bootstrap]` are deliberately not run again (design-arch §3.3: single implementation).
 */
import type { LaunchPlan } from '../bootstrap.js'
import type { Config, Transport } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import type { RemoteFacts } from '../probe.js'

/**
 * Recompute the launch plan from the probe facts the connection already recorded. A
 * restart reuses the same managed Node, profile and pinned version, so `[ssh]`,
 * `[probe]` and `[bootstrap]` are deliberately not run again.
 */
export function planForRuntime(
  ctx: Config & Transport,
  runtime: HostRuntime,
  profile: string,
): { plan: LaunchPlan; targetVersion: string; facts: RemoteFacts } {
  const facts = runtime.facts
  const targetVersion = ctx.localVersion()
  if (!facts || !targetVersion) {
    throw errors.internal(new Error('the connected host has no recorded probe facts or local version'))
  }
  return { plan: ctx.deps.plan({ facts, targetVersion, profile }), targetVersion, facts }
}

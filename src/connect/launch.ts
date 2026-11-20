/** The `[start]` step: the one notice a browser-carrier-patched launch logs, and the one decision about a remote DSH this plugin did not start — put it in front of the user (stop it, keep it alongside, or cancel) instead of silently racing it with a second instance that shares the same `~/.dsh` profile. */
import type { PromptCtx, RemoteDeps } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import type { RemoteLayout } from '../layout.js'
import { askConflict } from '../prompts.js'
import { isPid, messageOf } from '../util.js'

/** The note a launch logs after it had to re-enable the remote profile's browser Remote-Event carrier. */
export const PATCHED_CARRIER_NOTE =
  'the remote profile disables api-remotes (browser Remote-Event carrier); re-enabled it for this launch'

export type KnownProcess = { pid: number; command: string }

type ForeignConflictOptions = { ignoredPids?: number[]; knownProcess?: KnownProcess | null }

/** Warn when the remote already runs a DSH this plugin did not start, and let the user decide: stop it, keep it alongside, or cancel. */
export async function resolveForeignConflict(
  ctx: PromptCtx & RemoteDeps,
  runtime: HostRuntime,
  layout: RemoteLayout,
  profile: string,
  options: ForeignConflictOptions = {},
): Promise<'stop' | 'alongside' | null> {
  // Processes the user already chose to keep alongside this connection are not asked about again.
  const answered = Array.isArray(options.ignoredPids) ? options.ignoredPids : []
  const keptAlongside = answered.map(Number)
  const ignorePids = answered.filter((pid) => isPid(pid))
  try {
    const registry = await ctx.deps.readRegistry(runtime.ssh, layout)
    const pid = Number(registry?.pid)
    if (isPid(pid) && registry?.dshHome === layout.dshHome && registry?.profile === profile) ignorePids.push(pid)
  } catch (error) {
    // swallow-ok: registry absence is normal; the scan below still finds foreign processes
    ctx.progress.log(runtime, 'debug', 'foreign DSH: registry read failed:', messageOf(error))
  }
  const found = await ctx.deps.findForeign(runtime.ssh, { ignorePids })
  const processes = found.ok === true && Array.isArray(found.processes) ? [...found.processes] : []
  // The registry-named instance is normally ignored by the scan, but when the caller cannot stop it it must still be
  // shown: a second instance must never start silently next to it. Merged before failing open, since /proc proved it.
  const known = options.knownProcess
  const knownPid = Number(known?.pid)
  if (
    isPid(knownPid) &&
    !keptAlongside.includes(knownPid) &&
    !processes.some((entry) => Number(entry?.pid) === knownPid)
  ) {
    processes.push({
      pid: knownPid,
      command: typeof known.command === 'string' && known.command !== '' ? known.command : `dsh --profile ${profile}`,
    })
  }
  if (found.ok !== true) {
    ctx.progress.log(runtime, 'debug', 'foreign DSH: scan failed:', found.reason ?? found.technical ?? 'unknown')
    if (processes.length === 0) return null
  }
  if (processes.length === 0) return null
  const pidList = processes.map((entry) => `pid ${entry.pid}`).join(', ')
  ctx.progress.log(
    runtime,
    'warn',
    `foreign DSH on the remote: ${processes.length} process(es) sharing this ~/.dsh (${pidList})`,
  )
  const decision = await askConflict(ctx, runtime, processes)
  // The user said no: retrying would ask the same question again (`conflict.answered` already owns the flag).
  if (decision.action === 'cancel') throw errors.remoteDshRunning()
  if (decision.action === 'alongside') {
    runtime.alongsidePids = processes.map((entry) => entry.pid).filter((pid) => isPid(pid))
    runtime.warning = {
      zh: '远端已有手工启动的 DSH；已按你的选择并存运行，两者共享 ~/.dsh，请避免同时操作同一会话。',
      en: 'A manually started DSH is already running; it was kept as you chose. Both share ~/.dsh, so avoid editing the same session in both.',
    }
    runtime.warningSource = 'alongside'
    return 'alongside'
  }
  const stopped = await ctx.deps.stopForeign(runtime.ssh, processes)
  if (stopped.ok !== true) {
    throw errors.remoteDshRunning(
      {
        zh: '远端的手工 DSH 进程没有停下来，连接已中止。',
        en: 'The manual remote DSH process did not stop, so the connection was aborted.',
      },
      {
        technical: `alive=${stopped.alive.join(',') || 'unknown'} output=${String(stopped.output ?? '').slice(0, 800)}`,
      },
    )
  }
  runtime.alongsidePids = []
  ctx.progress.log(runtime, 'info', `stopped ${processes.length} manual remote DSH process(es)`)
  return 'stop'
}

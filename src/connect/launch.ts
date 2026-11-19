/**
 * The `[start]` step's one decision: a remote DSH this plugin did not start is put in front of the
 * user (stop it, keep it alongside, or cancel) instead of being silently raced by a second
 * instance that shares the same `~/.dsh` profile (docs/design.md §5.5).
 */
import type { PromptCtx, RemoteDeps } from '../context.js'
import { errors } from '../errors.js'
import type { HostRuntime } from '../host-runtime.js'
import type { RemoteLayout } from '../layout.js'
import { askConflict } from '../prompts.js'
import { isPid, messageOf } from '../util.js'

/** One foreign DSH the conflict prompt describes. */
export interface KnownProcess {
  pid: number
  command: string
}

/** What `resolveForeignConflict` may be told about pids the user already answered for. */
interface ForeignConflictOptions {
  ignoredPids?: number[]
  knownProcess?: KnownProcess | null
}

/**
 * Warn when the remote already runs a DSH this plugin did not start, and let the
 * user decide: stop it, keep it alongside, or cancel.
 * @returns the decision, or null when no prompt was needed.
 */
export async function resolveForeignConflict(
  ctx: PromptCtx & RemoteDeps,
  runtime: HostRuntime,
  layout: RemoteLayout,
  profile: string,
  options: ForeignConflictOptions = {},
): Promise<'stop' | 'alongside' | null> {
  // Processes the user already chose to keep alongside this connection are not asked
  // about again (a local restart must not turn that choice into a prompt every time).
  const ignorePids = (Array.isArray(options.ignoredPids) ? options.ignoredPids : []).filter((pid) => isPid(pid))
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
  // The registry-named instance is normally ignored by the scan (it is this connection's own
  // process). When the caller cannot stop it - a pid a re-attach discovered - it still must be
  // put in front of the user: a second instance must never start silently next to it. Merge it
  // before failing open on a scan error: its identity came from /proc, not from the scan.
  const known = options.knownProcess
  const knownPid = Number(known?.pid)
  // A pid the user already chose to keep alongside is never asked about again; the
  // registry-named pid, however, must be shown when it could not be stopped.
  const keptAlongside = (Array.isArray(options.ignoredPids) ? options.ignoredPids : []).map(Number)
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
    // A broken scan must never allow a silent second instance: with a known live process we
    // still ask; with nothing known there is nothing to conflict with (the old behavior).
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
  if (decision.action === 'cancel') {
    // The user said no: retrying would ask the same question again. The `conflict.answered`
    // transition already recorded that (its rule owns `connectCancelled`); this is only the throw.
    throw errors.remoteDshRunning()
  }
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

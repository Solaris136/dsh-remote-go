/** Remote runtime preparation: `npx` pinned to the local DSH version against the remote's real `$DSH_HOME`; the
 * executor runs only fixed templates. */
import { errors } from './errors.js'
import { headTail, shellQuote, type BilingualText } from './util.js'
import { isNodeVersionSupported, normalizeVersion, parseVersion, versionsEqual } from './version.js'
import type { RemoteFacts } from './probe.js'
import type { SshPort } from './ssh-port.js'
export interface LaunchStart {
  kind: 'npx'
  npxPath: string | null
  nodePath?: string
  nodeBinDir?: string
  targetVersion: string
}
export interface LaunchPlan {
  level: 'npx'
  profile: string
  targetVersion: string
  reason: BilingualText
  start: LaunchStart
}
export interface PlanNpxInput {
  targetVersion: unknown
  facts: RemoteFacts
  profile: string
}
export interface PreflightOptions {
  timeoutMs?: number
  maxBytes?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export function assertSupportedRemote(facts: Pick<RemoteFacts, 'os' | 'arch'>): void {
  if (facts.os !== 'Linux') throw errors.unsupportedOs(`${facts.os} ${facts.arch}`.trim())
}

export function planNpx(input: PlanNpxInput): LaunchPlan {
  const targetVersion = normalizeVersion(input.targetVersion)

  if (!parseVersion(targetVersion)) {
    throw errors.invalidInput('targetVersion', {
      zh: `目标版本「${input.targetVersion}」不是合法版本号。`,
      en: `Target version "${input.targetVersion}" is not a valid version.`,
    })
  }

  assertSupportedRemote(input.facts)
  const facts = input.facts
  if (!isNodeVersionSupported(facts.nodeVersion)) {
    throw errors.remoteDshMissing({
      zh: `远端 Node 不可用或版本过低（需要 ≥ 24.9.0，检测到 ${facts.nodeVersion ?? '无'}），自动准备也没有完成。请检查远端网络，或在远端安装 Node 后重试。`,
      en: `The remote Node is missing or too old (>= 24.9.0 required, detected ${facts.nodeVersion ?? 'none'}) and automatic preparation did not finish. Check the remote network, or install Node on the remote and retry.`,
    })
  }

  if (!facts.npxPath) {
    throw errors.remoteDshMissing({
      zh: '远端没有找到 npx。请安装 npm（随 Node 一起提供），或把 npm 的 bin 目录加入远程 shell 的 PATH。',
      en: 'npx was not found on the remote. Install npm (shipped with Node) or add its bin directory to the remote shell PATH.',
    })
  }

  if (!facts.curlPath && !facts.wgetPath) {
    throw errors.remoteDshMissing({
      zh: '远端既没有 curl 也没有 wget，无法在启动后探活远端界面。请安装其中之一。',
      en: 'The remote has neither curl nor wget, so the remote UI cannot be health-checked after start. Install one of them.',
    })
  }
  return {
    level: 'npx',
    profile: input.profile,
    targetVersion,
    reason: {
      zh: `用 npx 精确版本 ${targetVersion} 启动远端 DSH（Node 运行时由插件准备）`,
      en: `Launch the remote DSH with npx pinned to ${targetVersion} (Node runtime prepared by the plugin)`,
    },
    start: {
      kind: 'npx',
      npxPath: facts.npxPath,
      nodePath: facts.nodePath ?? undefined,
      nodeBinDir: facts.nodePath ? facts.nodePath.replace(/\/node$/, '') : undefined,
      targetVersion,
    },
  }
}
/** The npx preflight: resolve and run the exact package once, so a first-run download happens in the foreground.
 * `npm_config_loglevel=http` makes npm report fetches on stderr without a TTY; the caller turns those lines into
 * progress. */
export function buildPreflightCommand(plan: LaunchPlan): string {
  const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
  return `set -eu
${pathPrefix}npm_config_loglevel=http ${shellQuote(plan.start.npxPath)} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} --version`
}

export async function verifyNpxVersion(
  ssh: SshPort,
  plan: LaunchPlan,
  options: PreflightOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 0
  const result = await ssh.exec(buildPreflightCommand(plan), {
    timeoutMs,
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  })
  // `timeoutMs: 0` means "no timeout" (a cold npx download is unbounded by design); only a
  // caller-supplied deadline can time out, and that is a network condition, not a missing runtime.
  if (result.timedOut === true) {
    throw errors.network(
      {
        zh: `远端 npx 预检超过 ${Math.round(timeoutMs / 1000)} 秒没有完成，可能是下载很慢或远端负载过高。`,
        en: `The remote npx preflight did not finish within ${Math.round(timeoutMs / 1000)}s; the download may be slow or the remote overloaded.`,
      },
      { technical: `reason=preflight-timeout timeoutMs=${timeoutMs}` },
    )
  }
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0) {
    const failure = errors.remoteDshMissing({
      zh: `无法通过 npx 运行 @deepseek-ai/dsh@${plan.start.targetVersion}（退出码 ${result.code}）。请确认远端能访问 npm registry，且 Node/npm 版本满足要求。`,
      en: `Could not run @deepseek-ai/dsh@${plan.start.targetVersion} through npx (exit ${result.code}). Make sure the remote can reach the npm registry and Node/npm meet the requirements.`,
    })
    failure.technical = headTail(combined, 1500)
    throw failure
  }
  const lines = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const reported = normalizeVersion(lines[lines.length - 1] ?? '')

  if (!versionsEqual(reported, plan.targetVersion))
    throw errors.versionMismatch(plan.targetVersion, reported || 'unknown')
  return reported
}

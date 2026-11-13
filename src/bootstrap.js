/**
 * Remote runtime preparation, reduced to the one supported shape: run DSH with
 * `npx` pinned to the local DSH version, against the remote's real `$DSH_HOME`
 * (`~/.dsh`). There is no isolated install and no Node download — a remote that
 * cannot run `npx` fails with instructions instead.
 *
 * The planner is pure and testable; the executor only runs the planner's fixed
 * command template (design §16.8: never a user-composed shell).
 */
import { REMOTE_PREFLIGHT_TIMEOUT_MS } from './constants.js'
import { errors } from './errors.js'
import { headTail, shellQuote } from './util.js'
import { isNodeVersionSupported, normalizeVersion, parseVersion, versionsEqual } from './version.js'

/**
 * @typedef {{
 *   kind: 'npx',
 *   npxPath: string,
 *   nodePath?: string,
 *   nodeBinDir?: string,
 *   targetVersion: string,
 * }} StartPlan
 * @typedef {{
 *   level: 'npx',
 *   profile: string,
 *   targetVersion: string,
 *   reason: { zh: string, en: string },
 *   start: StartPlan,
 * }} RuntimePlan
 */

/** @param {import('./probe.js').ProbeFacts} facts */
export function assertSupportedRemote(facts) {
  if (facts.os !== 'Linux') {
    throw errors.unsupportedOs(`${facts.os} ${facts.arch}`.trim())
  }
}

/**
 * Decide how to launch the remote runtime. Pure: no filesystem, no SSH.
 * @param {{
 *   facts: import('./probe.js').ProbeFacts,
 *   targetVersion: string,
 *   profile: string,
 * }} input
 * @returns {RuntimePlan}
 */
export function planNpx(input) {
  const targetVersion = normalizeVersion(input.targetVersion)
  if (!parseVersion(targetVersion)) {
    throw errors.invalidInput('targetVersion', {
      zh: `目标版本「${input.targetVersion}」不是合法版本号。`,
      en: `Target version "${input.targetVersion}" is not a valid version.`,
    })
  }
  assertSupportedRemote(input.facts)
  if (!isNodeVersionSupported(input.facts.nodeVersion)) {
    throw errors.remoteDshMissing({
      zh: `远端 Node 不可用或版本过低（需要 ≥ 24.9.0，检测到 ${input.facts.nodeVersion ?? '无'}）。请先在远端安装 Node。`,
      en: `The remote Node is missing or too old (>= 24.9.0 required, detected ${input.facts.nodeVersion ?? 'none'}). Install Node on the remote first.`,
    })
  }
  if (!input.facts.npxPath) {
    throw errors.remoteDshMissing({
      zh: '远端没有找到 npx。请安装 npm（随 Node 一起提供），或把 npm 的 bin 目录加入远程 shell 的 PATH。',
      en: 'npx was not found on the remote. Install npm (shipped with Node) or add its bin directory to the remote shell PATH.',
    })
  }
  if (!input.facts.curlPath) {
    throw errors.remoteDshMissing({
      zh: '远端没有找到 curl，无法在启动后探活远端界面。请安装 curl。',
      en: 'curl was not found on the remote, so the remote UI cannot be health-checked after start. Install curl.',
    })
  }
  const nodeBinDir = input.facts.nodePath ? input.facts.nodePath.replace(/\/node$/, '') : undefined
  return {
    level: 'npx',
    profile: input.profile,
    targetVersion,
    reason: {
      zh: `用 npx 精确版本 ${targetVersion} 启动远端 DSH（无需安装）`,
      en: `Launch the remote DSH with npx pinned to ${targetVersion} (no install)`,
    },
    start: {
      kind: 'npx',
      npxPath: input.facts.npxPath,
      nodePath: input.facts.nodePath ?? undefined,
      nodeBinDir,
      targetVersion,
    },
  }
}

/**
 * The npx preflight: resolve and run the exact package once, so a first-run
 * download happens in the foreground (and fails with a readable error) instead
 * of inside the detached start script.
 * @param {RuntimePlan} plan
 * @returns {string}
 */
export function buildPreflightCommand(plan) {
  const pathPrefix = plan.start.nodeBinDir ? `PATH=${shellQuote(plan.start.nodeBinDir)}:"$PATH" ` : ''
  return `set -eu
${pathPrefix}${shellQuote(plan.start.npxPath)} -y @deepseek-ai/dsh@${normalizeVersion(plan.start.targetVersion)} --version`
}

/**
 * Verify that `npx` can run exactly the local DSH version. Returns the version
 * actually reported, or throws a typed error. This also warms the npx cache for
 * the detached start that follows.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {RuntimePlan} plan
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function verifyNpxVersion(ssh, plan, options = {}) {
  const result = await ssh.exec(buildPreflightCommand(plan), {
    timeoutMs: options.timeoutMs ?? REMOTE_PREFLIGHT_TIMEOUT_MS,
    maxBytes: 200_000,
  })
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
  if (!versionsEqual(reported, plan.targetVersion)) {
    throw errors.versionMismatch(plan.targetVersion, reported || 'unknown')
  }
  return reported
}

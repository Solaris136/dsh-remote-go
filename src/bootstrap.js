/**
 * Remote runtime bootstrap (design §16.2). The planner is pure and testable;
 * the executor only runs the planner's fixed command templates — it never
 * accepts user-composed shell (design §16.8).
 */
import { errors } from './errors.js'
import {
  DEFAULT_NODE_VERSION,
  NODE_DIST_BASE,
} from './constants.js'
import { remoteLayout } from './layout.js'
import { headTail, shellQuote } from './util.js'
import { isNodeVersionSupported, normalizeVersion, parseVersion, versionsEqual } from './version.js'

/**
 * @typedef {{ id: string, title: { zh: string, en: string }, command: string, timeoutMs?: number }} BootstrapStep
 * @typedef {{
 *   kind: 'dsh' | 'node-bin' | 'npx',
 *   dshPath?: string,
 *   nodePath?: string,
 *   dshBinPath?: string,
 *   npxPath?: string,
 *   nodeBinDir?: string,
 *   targetVersion: string,
 * }} StartPlan
 * @typedef {{
 *   level: 'T0' | 'T0-local' | 'T1' | 'T2' | 'T3',
 *   reason: { zh: string, en: string },
 *   steps: BootstrapStep[],
 *   start: StartPlan,
 *   layout: ReturnType<typeof remoteLayout>,
 * }} BootstrapPlan
 */

/** @param {import('./probe.js').ProbeFacts} facts */
export function assertSupportedRemote(facts) {
  if (facts.os !== 'Linux') {
    throw errors.unsupportedOs(`${facts.os} ${facts.arch}`.trim())
  }
}

/**
 * Map Node's `uname -m` to the official Node dist arch name.
 * @param {string} arch
 */
export function nodeDistArch(arch) {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64'
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64'
  if (arch === 'armv7l') return 'armv7l'
  return null
}

/**
 * @param {string} nodeVersion
 * @param {string} arch
 */
export function nodeDownloadNames(nodeVersion, arch) {
  const distArch = nodeDistArch(arch)
  if (!distArch) return null
  const file = `node-v${normalizeVersion(nodeVersion)}-linux-${distArch}.tar.xz`
  return { file, url: `${NODE_DIST_BASE}/v${normalizeVersion(nodeVersion)}/${file}`, distArch }
}

/**
 * Fixed template for a Node download with SHA-256 verification (T3).
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {string} nodeVersion
 * @param {string} arch
 * @returns {BootstrapStep | null}
 */
export function nodeDownloadStep(layout, nodeVersion, arch) {
  const names = nodeDownloadNames(nodeVersion, arch)
  if (!names) return null
  const dir = shellQuote(layout.downloadsDir)
  const nodeDir = shellQuote(layout.nodeDir)
  const nodeBin = shellQuote(layout.nodeBin)
  const base = `${NODE_DIST_BASE}/v${normalizeVersion(nodeVersion)}`
  return {
    id: 'install-node',
    title: { zh: `下载并校验 Node ${normalizeVersion(nodeVersion)}（无需 root）`, en: `Download and verify Node ${normalizeVersion(nodeVersion)} (no root)` },
    timeoutMs: 300_000,
    command: `set -eu
mkdir -p ${dir}
cd ${dir}
FILE=${shellQuote(names.file)}
if [ ! -s "$FILE" ]; then curl -fsSL --retry 3 -o "$FILE" ${shellQuote(`${base}/${names.file}`)}; fi
curl -fsSL --retry 3 -o SHASUMS256.txt ${shellQuote(`${base}/SHASUMS256.txt`)}
grep " $FILE\$" SHASUMS256.txt | sha256sum -c -
rm -rf ${nodeDir}
mkdir -p ${nodeDir}
tar -xJf "$FILE" -C ${nodeDir} --strip-components=1
${nodeBin} -v`,
  }
}

/**
 * @param {ReturnType<typeof remoteLayout>} layout
 * @param {string} targetVersion
 * @param {{ npmPath: string, nodeBin: string, nodeBinDir?: string }} tools
 * @returns {BootstrapStep}
 */
export function isolatedInstallStep(layout, targetVersion, tools) {
  const dshHome = shellQuote(layout.dshHome)
  const pkg = shellQuote(`@deepseek-ai/dsh@${normalizeVersion(targetVersion)}`)
  const npm = shellQuote(tools.npmPath)
  const pathPrefix = tools.nodeBinDir ? `PATH=${shellQuote(tools.nodeBinDir)}:"$PATH" ` : ''
  return {
    id: 'install-dsh-isolated',
    title: { zh: `安装 DSH ${normalizeVersion(targetVersion)} 到用户目录（无需 root）`, en: `Install DSH ${normalizeVersion(targetVersion)} into the user directory (no root)` },
    timeoutMs: 600_000,
    command: `set -eu
mkdir -p ${dshHome}
${pathPrefix}${npm} install --prefix ${dshHome} --no-audit --no-fund --loglevel=error ${pkg}
${shellQuote(tools.nodeBin)} -p "require(${JSON.stringify(layout.dshPkg)}).version"`,
  }
}

/**
 * @param {string} level
 * @param {{ zh: string, en: string }} reason
 * @param {BootstrapStep[]} steps
 * @param {StartPlan} start
 * @param {string} remoteDir
 * @returns {BootstrapPlan}
 */
function makePlan(level, reason, steps, start, remoteDir, home = null) {
  return { level, reason, steps, start, layout: remoteLayout(remoteDir, home) }
}

/**
 * Decide how to obtain the remote runtime (T0–T5 in design §16.2).
 * @param {{
 *   facts: import('./probe.js').ProbeFacts,
 *   targetVersion: string,
 *   remoteDir: string,
 *   mode?: 'auto' | 'reuse' | 'npx' | 'isolated',
 *   nodeVersion?: string,
 * }} input
 * @returns {BootstrapPlan}
 */
export function planBootstrap(input) {
  const facts = input.facts
  const mode = input.mode ?? 'auto'
  const remoteDir = input.remoteDir
  const targetVersion = normalizeVersion(input.targetVersion)
  if (!parseVersion(targetVersion)) {
    throw errors.invalidInput('targetVersion', {
      zh: `目标版本「${input.targetVersion}」不是合法版本号。`,
      en: `Target version "${input.targetVersion}" is not a valid version.`,
    })
  }
  assertSupportedRemote(facts)
  const layout = remoteLayout(remoteDir, facts.home)

  if (mode !== 'isolated' && mode !== 'npx') {
    if (facts.dshPath && facts.dshVersion && versionsEqual(facts.dshVersion, targetVersion) && isNodeVersionSupported(facts.nodeVersion)) {
      return makePlan(
        'T0',
        { zh: `复用远端已安装的 DSH ${facts.dshVersion}`, en: `Reuse the remote DSH ${facts.dshVersion}` },
        [],
        { kind: 'dsh', dshPath: facts.dshPath, nodePath: facts.nodePath ?? undefined, targetVersion },
        remoteDir,
        facts.home,
      )
    }
    if (
      facts.isolatedDshVersion &&
      facts.isolatedDshBinPath &&
      facts.isolatedNodePath &&
      versionsEqual(facts.isolatedDshVersion, targetVersion) &&
      isNodeVersionSupported(facts.isolatedNodeVersion)
    ) {
      return makePlan(
        'T0-local',
        { zh: `复用本插件之前准备的隔离运行时 ${facts.isolatedDshVersion}`, en: `Reuse the isolated runtime prepared earlier (${facts.isolatedDshVersion})` },
        [],
        {
          kind: 'node-bin',
          nodePath: facts.isolatedNodePath,
          dshBinPath: facts.isolatedDshBinPath,
          targetVersion,
        },
        remoteDir,
        facts.home,
      )
    }
  }

  if (mode === 'reuse') {
    throw errors.remoteDshMissing({
      zh: `远端没有 ${targetVersion} 的同版本 DSH。可以改用「自动准备」或「安装到用户目录」。`,
      en: `The remote host has no DSH ${targetVersion}. Switch to automatic or isolated installation.`,
    })
  }

  const systemNodeOk = isNodeVersionSupported(facts.nodeVersion)
  const canNpx = Boolean(facts.npxPath) && systemNodeOk
  const canNpm = Boolean(facts.npmPath) && systemNodeOk
  const canDownloadNode =
    Boolean(facts.curlPath) && Boolean(facts.tarPath) && Boolean(facts.sha256Path) && nodeDownloadNames(input.nodeVersion ?? DEFAULT_NODE_VERSION, facts.arch) !== null

  const wantNpx = mode === 'npx' || (mode === 'auto' && canNpx)
  if (wantNpx) {
    if (!canNpx) {
      throw errors.remoteDshMissing({
        zh: '远端 Node 版本过低或缺少 npx，无法用 npx 方式启动 DSH。',
        en: 'The remote Node is too old or npx is missing, so npx cannot launch DSH.',
      })
    }
    return makePlan(
      'T1',
      { zh: `用 npx 精确版本 ${targetVersion} 启动（不全局安装）`, en: `Launch with npx pinned to ${targetVersion} (no global install)` },
      [],
      { kind: 'npx', npxPath: facts.npxPath ?? 'npx', nodePath: facts.nodePath ?? undefined, nodeBinDir: facts.nodePath ? facts.nodePath.replace(/\/node$/, '') : undefined, targetVersion },
        remoteDir,
        facts.home,
      )
  }

  if ((mode === 'isolated' || mode === 'auto') && canNpm) {
    const nodeBin = facts.nodePath ?? 'node'
    return makePlan(
      'T2',
      { zh: `安装 DSH ${targetVersion} 到远端用户目录（无需 root）`, en: `Install DSH ${targetVersion} into the remote user directory (no root)` },
      [isolatedInstallStep(layout, targetVersion, { npmPath: facts.npmPath ?? 'npm', nodeBin })],
      { kind: 'node-bin', nodePath: nodeBin, dshBinPath: layout.dshBin, targetVersion },
        remoteDir,
        facts.home,
      )
  }

  if (canDownloadNode) {
    const nodeVersion = normalizeVersion(input.nodeVersion ?? DEFAULT_NODE_VERSION)
    const download = nodeDownloadStep(layout, nodeVersion, facts.arch)
    if (download) {
      const steps = [
        {
          id: 'prepare-dirs',
          title: { zh: '创建远端用户目录', en: 'Create remote user directories' },
          command: `set -eu
mkdir -p ${[layout.root, layout.downloadsDir, layout.logsDir, layout.runDir, layout.home, layout.dshHome].map(shellQuote).join(' ')}`,
        },
        download,
        isolatedInstallStep(layout, targetVersion, { npmPath: `${layout.nodeBin.replace(/\/node$/, '')}/npm`, nodeBin: layout.nodeBin, nodeBinDir: layout.nodeBinDir }),
      ]
      return makePlan(
        'T3',
        { zh: `远端无可用 Node：先下载 Node ${nodeVersion}（校验 SHA-256），再安装 DSH ${targetVersion}`, en: `No usable Node: download Node ${nodeVersion} (SHA-256 verified), then install DSH ${targetVersion}` },
        steps,
        { kind: 'node-bin', nodePath: layout.nodeBin, dshBinPath: layout.dshBin, targetVersion },
        remoteDir,
        facts.home,
      )
    }
  }

  throw errors.remoteDshMissing({
    zh: '远端缺少 Node/DSH，且没有 curl/tar/sha256sum 可用来下载安装。请在镜像层面准备，或复制下面需要手动执行的步骤。',
    en: 'The remote lacks Node/DSH and curl/tar/sha256sum, so it cannot be provisioned over SSH. Prepare the image, or run the documented steps manually.',
  })
}

/**
 * @param {BootstrapPlan} plan
 * @param {string} targetVersion
 */
export function verifyPlanTarget(plan, targetVersion) {
  if (plan.level === 'T1') return
  if (plan.level === 'T0' || plan.level === 'T0-local') return
  // T2/T3 verified by the install step's own `node -p ...version`.
  if (!versionsEqual(plan.start.targetVersion, targetVersion)) {
    throw errors.versionMismatch(targetVersion, plan.start.targetVersion)
  }
}

/**
 * @typedef {{
 *   step: BootstrapStep,
 *   index: number,
 *   state: 'running' | 'done' | 'failed',
 *   output?: string,
 * }} StepProgress
 */

/**
 * Execute the planner's steps over an SSH connection.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {BootstrapPlan} plan
 * @param {{ onProgress?: (progress: StepProgress) => void, signal?: AbortSignal }} [options]
 */
export async function executeBootstrap(ssh, plan, options = {}) {
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index]
    options.onProgress?.({ step, index, state: 'running' })
    const result = await ssh.exec(step.command, {
      timeoutMs: step.timeoutMs ?? 300_000,
      maxBytes: 1_000_000,
      signal: options.signal,
      onStdout: (chunk) => options.onProgress?.({ step, index, state: 'running', output: chunk }),
      onStderr: (chunk) => options.onProgress?.({ step, index, state: 'running', output: chunk }),
    })
    if (result.code !== 0) {
      options.onProgress?.({ step, index, state: 'failed', output: result.stderr || result.stdout })
      const failure = errors.remoteDshMissing({
        zh: `远端准备步骤「${step.title.zh}」失败（退出码 ${result.code}）。`,
        en: `Remote bootstrap step "${step.title.en}" failed (exit ${result.code}).`,
      })
      failure.technical = headTail(result.stderr || result.stdout, 1500)
      throw failure
    }
    options.onProgress?.({ step, index, state: 'done', output: result.stdout })
  }
  return plan
}

/**
 * Read the installed DSH version back when the plan installed into the isolated
 * directory, so a wrong version never silently proceeds.
 * @param {{ exec: (command: string, options?: any) => Promise<{ code: number | null, stdout: string, stderr: string }> }} ssh
 * @param {BootstrapPlan} plan
 */
export async function verifyInstalledVersion(ssh, plan) {
  if (plan.level !== 'T2' && plan.level !== 'T3') return null
  const node = shellQuote(plan.start.nodePath ?? 'node')
  const script = `${node} -p "require(${JSON.stringify(plan.layout.dshPkg)}).version"`
  const result = await ssh.exec(script, { timeoutMs: 30_000 })
  const version = normalizeVersion(result.stdout.trim())
  if (result.code !== 0 || !versionsEqual(version, plan.start.targetVersion)) {
    throw errors.versionMismatch(normalizeVersion(plan.start.targetVersion), version || 'unknown')
  }
  return version
}

/**
 * Human-readable summary used by the wizard's capability list.
 * @param {BootstrapPlan} plan
 */
export function summarizePlan(plan) {
  return {
    level: plan.level,
    reason: plan.reason,
    steps: plan.steps.map((step) => ({ id: step.id, title: step.title })),
    startKind: plan.start.kind,
    targetVersion: plan.start.targetVersion,
  }
}

/**
 * Diagnostic text for the T5 dead end; kept short enough for the UI.
 * @param {import('./probe.js').ProbeFacts} facts
 */
export function manualPreparationHint(facts) {
  return headTail(
    [
      'Manual preparation (design §16.2 T5):',
      '  1. Install Node >= 24.9.0 and npm on the remote host, or copy an offline Node archive.',
      '  2. Run: npm install --prefix ~/.dsh-remote-go/dsh-home @deepseek-ai/dsh@<local version>',
      '  3. Retry the connection; the plugin will reuse the isolated runtime.',
      `Detected: os=${facts.os} arch=${facts.arch} node=${facts.nodeVersion ?? 'none'} curl=${Boolean(facts.curlPath)} tar=${Boolean(facts.tarPath)}`,
    ].join('\n'),
    1200,
  )
}


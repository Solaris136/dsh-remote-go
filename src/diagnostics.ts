/**
 * The diagnostic checklist: read-only, opens no new connections.
 */
import { isNodeVersionSupported, versionParity } from './version.js'
import { nowIso } from './util.js'
import type { BilingualText } from './util.js'
import { redactObject } from './redact.js'
import type { HostRuntime } from './host-runtime.js'

/** One checklist row: a stable id, its label and the verdict. */
export interface DiagnosticCheck {
  id: string
  title: BilingualText
  status: 'pass' | 'fail' | 'unknown'
  detail: BilingualText
}

/** The exported report (`docs/api.md` diagnostics): already redacted when it leaves here. */
export interface DiagnosticsReport {
  summary: 'ok' | 'warning' | 'error'
  checks: DiagnosticCheck[]
  redacted: true
  generatedAt: string
  restarts: Array<Record<string, unknown>>
  logs: string[]
}

/** Check labels, so each `push` below is only about status and detail. */
const TITLES: Record<string, BilingualText> = {
  'ssh-reachable': { zh: 'SSH 可达性', en: 'SSH reachability' },
  auth: { zh: '认证方式', en: 'Authentication' },
  'host-key': { zh: '主机指纹', en: 'Host key' },
  tunnel: { zh: '本地回环隧道', en: 'Loopback tunnel' },
  'remote-service': { zh: '远端 DSH 服务', en: 'Remote DSH service' },
  'remote-ui': { zh: '远端界面可达性', en: 'Remote UI reachability' },
  'remote-node': { zh: '远端 Node 运行时', en: 'Remote Node runtime' },
  'remote-version': { zh: '远端 DSH 版本', en: 'Remote DSH version' },
  'model-credentials': { zh: '模型凭据', en: 'Model credentials' },
  'desktop-guard': { zh: '远端桌面功能检查', en: 'Remote desktop guard' },
}

const NOT_PROBED: BilingualText = { zh: '未探测远端环境。', en: 'Remote environment has not been probed.' }

const t = (zh: string, en: string): BilingualText => ({ zh, en })

export async function diagnoseHost(runtime: HostRuntime, ctx: { targetVersion: string }): Promise<DiagnosticsReport> {
  const checks: DiagnosticCheck[] = []
  const push = (id: string, status: DiagnosticCheck['status'], detail: BilingualText): void => {
    checks.push({ id, title: TITLES[id], status, detail })
  }
  const entry = runtime.entry
  const facts = runtime.facts
  const sshLive = Boolean(runtime.ssh?.connected)

  push(
    'ssh-reachable',
    sshLive ? 'pass' : runtime.error ? 'fail' : 'unknown',
    sshLive
      ? t(`已连接 ${entry.address}`, `Connected to ${entry.address}`)
      : (runtime.error?.detail ?? t('尚未连接，请先连接一次。', 'Not connected yet; connect once first.')),
  )

  const authType = entry.auth?.type ?? 'agent'
  push(
    'auth',
    sshLive ? 'pass' : 'unknown',
    sshLive
      ? t(`认证方式：${authType}（凭据不会保存在本机）`, `Method: ${authType} (no credentials are stored locally)`)
      : t('连接后检查', 'Checked after connecting'),
  )

  const pinned = entry.pinnedFingerprint
  const liveFingerprint = runtime.fingerprint?.sha256 ?? null
  const keyStatus = pinned && liveFingerprint ? (pinned === liveFingerprint ? 'pass' : 'fail') : 'unknown'
  let keyDetail = t('尚未记录指纹，首次连接时会询问。', 'No host key recorded yet; it is asked on first connect.')
  if (pinned) {
    const session = liveFingerprint ? `，本次 ${liveFingerprint}` : ''
    keyDetail = t(
      `已记录 ${pinned}${session}`,
      `Pinned ${pinned}${liveFingerprint ? `, this session ${liveFingerprint}` : ''}`,
    )
  } else if (liveFingerprint) {
    keyDetail = t(`本次会话 ${liveFingerprint}（尚未记录）`, `This session ${liveFingerprint} (not pinned yet)`)
  }
  push('host-key', keyStatus, keyDetail)

  const tunnel = runtime.tunnel
  push(
    'tunnel',
    tunnel ? 'pass' : 'fail',
    tunnel
      ? t(
          `127.0.0.1:${tunnel.localPort} → 远端 127.0.0.1:${runtime.remote.port ?? '未知'}`,
          `127.0.0.1:${tunnel.localPort} → remote 127.0.0.1:${runtime.remote.port ?? 'unknown'}`,
        )
      : t('隧道未建立（连接断开或尚未连接）。', 'The tunnel is not established (disconnected or not connected yet).'),
  )

  const remoteAlive = sshLive && runtime.exchange?.status === 200
  push(
    'remote-service',
    remoteAlive ? 'pass' : sshLive ? 'fail' : 'unknown',
    remoteAlive
      ? t(
          `远端进程 pid=${runtime.remote.pid ?? '未知'}，本地端口 ${runtime.remote.localPort ?? '未知'}`,
          `Remote pid ${runtime.remote.pid ?? 'unknown'}, local port ${runtime.remote.localPort ?? 'unknown'}`,
        )
      : t('远端服务未确认在运行。', 'The remote service is not confirmed running.'),
  )

  push(
    'remote-ui',
    runtime.exchange?.ok ? 'pass' : sshLive ? 'fail' : 'unknown',
    runtime.exchange?.ok
      ? t(`页面标题：${runtime.exchange.title ?? '（无）'}`, `Page title: ${runtime.exchange.title ?? '(none)'}`)
      : t('尚未完成远端界面的鉴权握手。', 'The remote UI authentication handshake has not completed.'),
  )

  const nodeVersion = facts?.nodeVersion ?? null
  const nodeOk = isNodeVersionSupported(nodeVersion) && Boolean(facts?.npxPath)
  let nodeDetail = NOT_PROBED
  if (facts) {
    nodeDetail = nodeOk
      ? t(`Node ${nodeVersion}（插件托管），npx 可用`, `Node ${nodeVersion} (plugin-managed) with npx available`)
      : t(
          `Node ${nodeVersion ?? '未检测到'}${facts.npxPath ? '' : '，缺少 npx'}，不满足 ≥ 24.9。`,
          `Node ${nodeVersion ?? 'not detected'}${facts.npxPath ? '' : ' (npx missing)'} does not meet >= 24.9.`,
        )
  }
  push('remote-node', facts ? (nodeOk ? 'pass' : 'fail') : 'unknown', nodeDetail)

  const parity = versionParity(ctx.targetVersion, runtime.remote.version ?? null)
  push('remote-version', parity.status === 'same' ? 'pass' : parity.status === 'different' ? 'fail' : 'unknown', {
    zh: parity.message.zh,
    en: parity.message.en,
  })

  const credentials = facts
    ? Boolean(facts.credentialsFile || facts.deepseekKeyEnv || facts.providerEnvKeys.length > 0)
    : false
  push(
    'model-credentials',
    facts ? (credentials ? 'pass' : 'unknown') : 'unknown',
    facts
      ? credentials
        ? t('远端已检测到模型凭据配置。', 'Remote model credentials were detected.')
        : t('未检测到模型凭据；请在远端界面里配置。', 'No model credentials detected; configure them in the remote UI.')
      : NOT_PROBED,
  )

  push(
    'desktop-guard',
    facts ? (facts.sshConnection ? 'pass' : 'unknown') : 'unknown',
    facts
      ? facts.sshConnection
        ? t(
            '远端 DSH 经 SSH 会话启动，宿主桌面功能已关闭。',
            'The remote DSH runs inside an SSH session, so host desktop features stay off.',
          )
        : t(
            '远端未检测到 SSH 会话标记，目录对话框可能弹在远端屏幕上。',
            'No SSH session marker on the remote; directory dialogs may appear on the remote screen.',
          )
      : NOT_PROBED,
  )

  const failed = checks.filter((check) => check.status === 'fail').length
  const unknown = checks.filter((check) => check.status === 'unknown').length
  const summary = failed > 0 ? 'error' : unknown > 0 ? 'warning' : 'ok'
  // Redaction is the contract of the exported report: tokens, passwords, private
  // keys and home directories never leave the machine.
  return redactObject({
    summary,
    checks,
    redacted: true,
    generatedAt: nowIso(),
    // One entry per restart / re-attach, so an exported report can tell a local restart
    // apart from a remote one without re-reading the whole connect log.
    restarts: (Array.isArray(runtime.restarts) ? runtime.restarts : []).slice(-10),
    logs: runtime.logs.slice(-40).map((entry) => entry.line),
  })
}

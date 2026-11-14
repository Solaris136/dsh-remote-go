/**
 * The diagnostic checklist (docs/design.md（诊断与设置）): read-only, no new connections.
 */
import { remoteHttpStatus } from './webapp.js'
import { isNodeVersionSupported, versionParity } from './version.js'
import { nowIso } from './util.js'

/**
 * @param {any} runtime
 * @param {{ targetVersion: string | null }} ctx
 */
export async function diagnoseHost(runtime, ctx) {
  /** @type {{ id: string, title: { zh: string, en: string }, status: 'pass'|'fail'|'unknown', detail: { zh: string, en: string } }[]} */
  const checks = []
  const push = (checkId, title, status, detail) => checks.push({ id: checkId, title, status, detail })
  const sshLive = Boolean(runtime.ssh?.connected)

  push(
    'ssh-reachable',
    { zh: 'SSH 可达性', en: 'SSH reachability' },
    sshLive ? 'pass' : runtime.error ? 'fail' : 'unknown',
    sshLive
      ? { zh: `已连接 ${runtime.entry.address}`, en: `Connected to ${runtime.entry.address}` }
      : runtime.error
        ? runtime.error.detail
        : { zh: '尚未连接，请先连接一次。', en: 'Not connected yet; connect once first.' },
  )

  push(
    'auth',
    { zh: '认证方式', en: 'Authentication' },
    sshLive ? 'pass' : 'unknown',
    sshLive
      ? {
          zh: `认证方式：${runtime.entry.auth?.type ?? 'agent'}（凭据不会保存在本机）`,
          en: `Method: ${runtime.entry.auth?.type ?? 'agent'} (no credentials are stored locally)`,
        }
      : { zh: '连接后检查', en: 'Checked after connecting' },
  )

  const pinned = runtime.entry.pinnedFingerprint
  const liveFingerprint = runtime.fingerprint?.sha256 ?? null
  push(
    'host-key',
    { zh: '主机指纹', en: 'Host key' },
    pinned && liveFingerprint ? (pinned === liveFingerprint ? 'pass' : 'fail') : pinned ? 'unknown' : 'unknown',
    pinned
      ? {
          zh: `已记录 ${pinned}${liveFingerprint ? `，本次 ${liveFingerprint}` : ''}`,
          en: `Pinned ${pinned}${liveFingerprint ? `, this session ${liveFingerprint}` : ''}`,
        }
      : liveFingerprint
        ? { zh: `本次会话 ${liveFingerprint}（尚未记录）`, en: `This session ${liveFingerprint} (not pinned yet)` }
        : { zh: '尚未记录指纹，首次连接时会询问。', en: 'No host key recorded yet; it is asked on first connect.' },
  )

  const tunnel = runtime.tunnel
  push(
    'tunnel',
    { zh: '本地回环隧道', en: 'Loopback tunnel' },
    tunnel ? 'pass' : 'fail',
    tunnel
      ? {
          zh: `127.0.0.1:${tunnel.localPort} → 远端 127.0.0.1:${runtime.remote.port ?? '未知'}`,
          en: `127.0.0.1:${tunnel.localPort} → remote 127.0.0.1:${runtime.remote.port ?? 'unknown'}`,
        }
      : {
          zh: '隧道未建立（连接断开或尚未连接）。',
          en: 'The tunnel is not established (disconnected or not connected yet).',
        },
  )

  const remotePort = runtime.remote.port ?? runtime.remote.localPort ?? 0
  const serverStatus = sshLive ? await remoteHttpStatus(runtime.ssh, remotePort) : null
  const remoteAlive = sshLive && runtime.exchange?.status === 200
  push(
    'remote-service',
    { zh: '远端 DSH 服务', en: 'Remote DSH service' },
    remoteAlive ? 'pass' : sshLive ? 'fail' : 'unknown',
    remoteAlive
      ? {
          zh: `远端进程 pid=${runtime.remote.pid ?? '未知'}，本地端口 ${runtime.remote.localPort ?? '未知'}`,
          en: `Remote pid ${runtime.remote.pid ?? 'unknown'}, local port ${runtime.remote.localPort ?? 'unknown'}`,
        }
      : { zh: '远端服务未确认在运行。', en: 'The remote service is not confirmed running.' },
  )

  push(
    'remote-ui',
    { zh: '远端界面可达性', en: 'Remote UI reachability' },
    runtime.exchange?.ok ? 'pass' : sshLive ? 'fail' : 'unknown',
    runtime.exchange?.ok
      ? {
          zh: `页面标题：${runtime.exchange.title ?? '（无）'}`,
          en: `Page title: ${runtime.exchange.title ?? '(none)'}`,
        }
      : { zh: '尚未完成远端界面的鉴权握手。', en: 'The remote UI authentication handshake has not completed.' },
  )

  const nodeVersion = runtime.facts?.nodeVersion ?? null
  const nodeOk = isNodeVersionSupported(nodeVersion) && Boolean(runtime.facts?.npxPath)
  push(
    'remote-node',
    { zh: '远端 Node 运行时', en: 'Remote Node runtime' },
    runtime.facts ? (nodeOk ? 'pass' : 'fail') : 'unknown',
    runtime.facts
      ? nodeOk
        ? {
            zh: `Node ${nodeVersion}（插件托管），npx 可用`,
            en: `Node ${nodeVersion} (plugin-managed) with npx available`,
          }
        : {
            zh: `Node ${nodeVersion ?? '未检测到'}${runtime.facts.npxPath ? '' : '，缺少 npx'}，不满足 ≥ 24.9。`,
            en: `Node ${nodeVersion ?? 'not detected'}${runtime.facts.npxPath ? '' : ' (npx missing)'} does not meet >= 24.9.`,
          }
      : { zh: '未探测远端环境。', en: 'Remote environment has not been probed.' },
  )

  const target = ctx.targetVersion
  const remoteVersion = runtime.remote.version ?? null
  const parity = versionParity(target, remoteVersion)
  push(
    'remote-version',
    { zh: '远端 DSH 版本', en: 'Remote DSH version' },
    parity.status === 'same' ? 'pass' : parity.status === 'different' ? 'fail' : 'unknown',
    { zh: parity.message.zh, en: parity.message.en },
  )

  const credentials = runtime.facts
    ? runtime.facts.credentialsFile || runtime.facts.deepseekKeyEnv || runtime.facts.providerEnvKeys.length > 0
    : false
  push(
    'model-credentials',
    { zh: '模型凭据', en: 'Model credentials' },
    runtime.facts ? (credentials ? 'pass' : 'unknown') : 'unknown',
    runtime.facts
      ? credentials
        ? { zh: '远端已检测到模型凭据配置。', en: 'Remote model credentials were detected.' }
        : {
            zh: '未检测到模型凭据；请在远端界面里配置。',
            en: 'No model credentials detected; configure them in the remote UI.',
          }
      : { zh: '未探测远端环境。', en: 'Remote environment has not been probed.' },
  )

  push(
    'desktop-guard',
    { zh: '远端桌面功能检查', en: 'Remote desktop guard' },
    runtime.facts ? (runtime.facts.sshConnection ? 'pass' : 'unknown') : 'unknown',
    runtime.facts
      ? runtime.facts.sshConnection
        ? {
            zh: '远端 DSH 经 SSH 会话启动，宿主桌面功能已关闭。',
            en: 'The remote DSH runs inside an SSH session, so host desktop features stay off.',
          }
        : {
            zh: '远端未检测到 SSH 会话标记，目录对话框可能弹在远端屏幕上。',
            en: 'No SSH session marker on the remote; directory dialogs may appear on the remote screen.',
          }
      : { zh: '未探测远端环境。', en: 'Remote environment has not been probed.' },
  )

  const failed = checks.filter((check) => check.status === 'fail').length
  const unknown = checks.filter((check) => check.status === 'unknown').length
  const summary = failed > 0 ? 'error' : unknown > 0 ? 'warning' : 'ok'
  return {
    summary,
    checks,
    redacted: true,
    generatedAt: nowIso(),
    logs: runtime.logs.slice(-40).map((entry) => entry.line),
    serverStatus,
  }
}

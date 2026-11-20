/** Coded, bilingual errors; `toErrorView` is the only shape the Client ever sees. */
import { redactObject, redactText } from './redact.js'
import { headTail } from './util.js'
import type { BilingualText } from './util.js'

/** The only ErrorView the Client renders (docs/api.md). */
export interface ErrorView {
  code: string
  title: BilingualText
  detail: BilingualText
  nextSteps: BilingualText[]
  retryable: boolean
  technical?: string
}
/** Per-error overrides a producer may pass; `retryable` defaults to the code's catalogue entry. */
export interface RemoteGoErrorOptions {
  nextSteps?: BilingualText[]
  technical?: string
  retryable?: boolean
}
/** One catalogue row: rows are retryable unless they say otherwise; a parameterized entry builds its own detail. */
interface ErrorRow {
  retryable?: boolean
  title: BilingualText
  detail?: BilingualText
  steps?: [string, string][]
}
const say = (zh: string, en: string): BilingualText => ({ zh, en })
/** Every coded error: the Client's title, the retry default, and the detail and steps a bare call renders. */
const CATALOGUE = {
  network: {
    title: say('连不上这台服务器', 'Cannot reach this server'),
    detail: say(
      '网络不可达，可能被防火墙拦截或地址写错。',
      'The network is unreachable — check the address, port and firewall.',
    ),
    steps: [
      ['检查地址、端口与网络连通性', 'Check the address, port and network reachability'],
      ['如果有跳板机，先确认跳板机可达', 'If a jump host is configured, verify it first'],
    ],
  },
  auth: {
    title: say('SSH 认证没有通过', 'SSH authentication failed'),
    detail: say('远端拒绝了这次 SSH 认证。', 'The remote host rejected this SSH authentication.'),
    steps: [
      ['检查用户名与密钥 / SSH Agent', 'Check the user name and key / SSH agent'],
      ['确认密钥文件路径与权限（0600）', 'Confirm the key file path and its 0600 permissions'],
    ],
  },
  'host-key-changed': {
    retryable: false,
    title: say('主机指纹变了', 'The host key changed'),
  },
  'host-key-unknown': {
    title: say('确认服务器指纹', 'Confirm the host key'),
  },
  'remote-dsh-missing': {
    title: say('远端没有可用的 DSH', 'No usable DSH on the remote host'),
    detail: say(
      '远端没有找到可用的 DSH，本机也无法自动准备运行环境。',
      'No usable DSH was found and the runtime could not be prepared automatically.',
    ),
    steps: [
      ['确认远端可以访问网络，或配置离线包', 'Check remote network access, or configure an offline package'],
      ['也可以在远端手动安装 DSH 后重试', 'You can also install DSH manually on the remote host and retry'],
    ],
  },
  'remote-node-install-failed': {
    title: say('远端 Node 自动安装失败', 'Automatic Node installation failed'),
    detail: say(
      '远端没有可用的 Node，自动安装也没有成功。',
      'The remote has no usable Node and automatic installation did not succeed.',
    ),
    steps: [
      [
        '让远端可以访问 nodejs.org 或 npmmirror.com 后重试',
        'Allow the remote to reach nodejs.org or npmmirror.com and retry',
      ],
      [
        '确认远端磁盘 ≥ 400 MB，且是受支持的 glibc 架构（musl/Alpine 不支持）',
        'Make sure the remote has >= 400 MB free and a supported glibc architecture (musl/Alpine is not supported)',
      ],
    ],
  },
  'remote-dsh-start-failed': {
    title: say('远端 DSH 启动失败', 'The remote DSH failed to start'),
  },
  'remote-dsh-running': {
    title: say('远端已有手工启动的 DSH', 'A manually started DSH is already running'),
    detail: say(
      '远端检测到不是本插件启动的 DSH 进程，连接已按你的选择取消。',
      'The remote has a DSH process this plugin did not start; the connection was cancelled as you chose.',
    ),
    steps: [
      [
        '重新连接，并选择「停止它并启动受管实例」或「保留它，另起一个」',
        'Reconnect and choose "Stop it and start the managed instance" or "Keep it and start alongside"',
      ],
    ],
  },
  'remote-ui-unreachable': {
    title: say('远端界面打不开', 'The remote interface is unreachable'),
    detail: say(
      '隧道的本地回环端口无法完成远端界面的鉴权握手。',
      'The loopback tunnel could not complete the remote UI authentication handshake.',
    ),
    steps: [
      ['点「重连」重试一次', 'Retry with Reconnect'],
      ['查看诊断中的隧道与界面可达性检查', 'Check tunnel and UI reachability in diagnostics'],
    ],
  },
  'remote-unreachable': {
    title: say('远端 DSH 已不在运行', 'The remote DSH is no longer running'),
    detail: say(
      '远端 DSH 已经停止响应，而且没有找到可以重新挂载的实例；主机配置保留。',
      'The remote DSH stopped responding and no instance could be re-attached to; the host configuration is kept.',
    ),
    steps: [
      [
        '点「重启」用同一份配置重新拉起远端进程',
        'Use "Restart" to start the remote process again with the same settings',
      ],
      ['点「重连」按存活策略重新连接', 'Use Reconnect to connect again under the keep-alive policy'],
    ],
  },
  'restart-unavailable': {
    title: say('现在不能重启远端 DSH', 'The remote DSH cannot be restarted now'),
    detail: say(
      '只有已连接、或远端不可达但仍保留 SSH 连接的主机才能重启远端 DSH。',
      'The remote DSH can only be restarted while this host is connected, or after a remote-unreachable failure that kept the SSH session.',
    ),
    steps: [
      ['先连接这台主机，再点「重启」', 'Connect the host first, then use "Restart"'],
      ['如果连接已断开，点「重连」重新建立连接', 'If the link dropped, use Reconnect to establish it again'],
    ],
  },
  'stop-unavailable': {
    title: say('现在不能关闭远端 DSH', 'The remote DSH cannot be stopped now'),
    detail: say(
      '只有已连接、或远端不可达但仍保留 SSH 连接的主机才能关闭远端 DSH，而且只能关闭本连接启动或接管的那一个进程。',
      'The remote DSH can only be stopped while this host is connected (or after a remote-unreachable failure that kept the SSH session), and only when it is the process this connection launched or took over.',
    ),
    steps: [
      ['先连接这台主机，再点「关闭」', 'Connect the host first, then use "Stop"'],
      [
        '如果强烈怀疑远端进程不属于本连接，点「重连」重建连接后再试',
        'If the remote process may not belong to this connection, use Reconnect and try again',
      ],
    ],
  },
  'remote-file-unavailable': {
    title: say('无法读取远端文件', 'Cannot read the remote file'),
    detail: say(
      '远端路径不存在、不可读，或无法写入本地保存位置。',
      'The remote path does not exist, is not readable, or the local destination cannot be written.',
    ),
    steps: [
      ['确认文件仍在远端，且当前 SSH 用户可以读取', 'Confirm the file still exists and the SSH user can read it'],
      [
        '检查文件大小；过大的文件请先在远端压缩或拆分',
        'Check the file size; compress or split large files on the remote first',
      ],
    ],
  },
  'download-not-ready': {
    title: say('下载尚未准备好', 'The download is not ready'),
    detail: say(
      '这个下载还在准备中，或已经失效；请重新发起下载。',
      'This download is still being prepared or has expired; start it again.',
    ),
    steps: [
      ['等待进度条完成后再试', 'Wait for the progress bar to finish and retry'],
      ['如果任务已失效，从远端文件树重新下载', 'If it expired, start the download again from the remote file tree'],
    ],
  },
  'download-busy': {
    title: say('下载任务太多', 'Too many downloads are running'),
    detail: say(
      '同时准备的下载任务过多，请等一个完成后再试。',
      'Too many downloads are being prepared at once; wait for one to finish and retry.',
    ),
    steps: [['取消不需要的下载，或稍后重试', 'Cancel an unneeded download, or retry later']],
  },
  'version-mismatch': {
    title: say('远端 DSH 版本与本机不一致', 'Remote DSH version differs from this machine'),
  },
  'unsupported-os': {
    retryable: false,
    title: say('远端系统暂不支持', 'This remote system is not supported yet'),
  },
  'invalid-input': {
    retryable: false,
    title: say('填写的信息有误', 'Some fields are invalid'),
  },
  internal: {
    title: say('插件内部错误', 'Internal plugin error'),
  },
} satisfies Record<string, ErrorRow>
type ErrorCode = keyof typeof CATALOGUE
/** One catalogue row by code, or `undefined` for a code this build does not know. */
function rowOf(code: string): ErrorRow | undefined {
  return code in CATALOGUE ? CATALOGUE[code as ErrorCode] : undefined
}
export class RemoteGoError extends Error {
  declare code: string
  declare detail: BilingualText
  declare nextSteps: BilingualText[]
  declare technical?: string
  declare retryable: boolean
  /** The HTTP status a producer overrides for this refusal; only the API dispatcher reads it (a body over the size limit is 413, not 400/409). */
  declare httpStatus?: number
  constructor(code: string, detail: BilingualText, options: RemoteGoErrorOptions = {}) {
    super(`${code}: ${detail.en}`)
    this.name = 'RemoteGoError'
    this.code = code
    this.detail = detail
    this.nextSteps = options.nextSteps ?? []
    this.technical = options.technical
    this.retryable = options.retryable ?? rowOf(code)?.retryable ?? true
  }
}
function fail(
  code: string,
  detail: BilingualText,
  steps: [string, string][],
  options: RemoteGoErrorOptions = {},
): RemoteGoError {
  return new RemoteGoError(code, detail, { nextSteps: steps.map(([zh, en]) => say(zh, en)), ...options })
}
/** The entry for one plain catalogue row: a caller-supplied detail wins over the default. */
function plain(code: ErrorCode): (detail?: BilingualText, options?: RemoteGoErrorOptions) => RemoteGoError {
  const row: ErrorRow = CATALOGUE[code]
  return (detail: BilingualText = { ...row.detail }, options?: RemoteGoErrorOptions) =>
    fail(code, detail, row.steps, options)
}
export const errors = {
  network: plain('network'),
  auth: plain('auth'),
  hostKeyChanged: (pinned: string, actual: string) =>
    fail(
      'host-key-changed',
      say(
        `主机指纹和已记录的不一致：记录 ${pinned}，实际 ${actual}。`,
        `The host key no longer matches the pinned value: pinned ${pinned}, actual ${actual}.`,
      ),
      [
        [
          '确认服务器是否重装或更换了证书；确认后再更新指纹',
          'Confirm the server was not reinstalled or tampered with before updating the pin',
        ],
      ],
      { retryable: false, technical: `pinned=${pinned} actual=${actual}` },
    ),
  hostKeyUnknown: (fingerprint: string) =>
    fail(
      'host-key-unknown',
      say(
        `首次连接该服务器（指纹 ${fingerprint}），需要你确认。`,
        `First connection to this host (fingerprint ${fingerprint}); confirmation required.`,
      ),
      [['核对指纹后选择「接受并记住」或取消', 'Verify the fingerprint, then accept and remember it or cancel']],
    ),
  remoteDshMissing: plain('remote-dsh-missing'),
  nodeInstallFailed: plain('remote-node-install-failed'),
  remoteDshRunning: plain('remote-dsh-running'),
  remoteDshStartFailed: (tail: string) =>
    fail(
      'remote-dsh-start-failed',
      say(
        '远端 DSH 进程没有成功打印 Web 地址，可能启动即失败。',
        'The remote DSH process did not print its Web URL; startup likely failed.',
      ),
      [
        ['查看诊断里的远端日志尾部', 'Inspect the remote log tail in diagnostics'],
        ['确认远端磁盘空间与端口可用', 'Check remote disk space and usable ports'],
        [
          '重试一次，若仍失败可手动在远端验证 `dsh --profile web --no-open`',
          'Retry, or verify `dsh --profile web --no-open` manually on the remote host',
        ],
      ],
      { technical: tail },
    ),
  remoteUiUnreachable: plain('remote-ui-unreachable'),
  // Kept apart from `remote-ui-unreachable`: here the tunnel may be fine and the process is what is
  // missing, which is what the restart button exists for.
  remoteUnreachable: plain('remote-unreachable'),
  // A restart is only offered while the host is connected or its SSH session survived a failure.
  restartUnavailable: plain('restart-unavailable'),
  // A stop must also prove the remote pid is the process this connection launched or took over.
  stopRemoteUnavailable: plain('stop-unavailable'),
  remoteFileUnavailable: plain('remote-file-unavailable'),
  downloadNotReady: plain('download-not-ready'),
  downloadBusy: plain('download-busy'),
  versionMismatch: (local: string, remote: string) =>
    fail(
      'version-mismatch',
      say(
        `本机 DSH 是 ${local}，远端是 ${remote}；界面可能不一致，默认不静默混用。`,
        `This machine runs DSH ${local} while the remote runs ${remote}; the UI may differ and mixing silently is not allowed.`,
      ),
      [
        ['选择「准备同版本运行时」后重试（推荐）', 'Prepare a matching runtime and retry (recommended)'],
        ['明确选择「沿用远端版本」继续', 'Explicitly continue with the remote version'],
      ],
    ),
  unsupportedOs: (os: string) =>
    fail(
      'unsupported-os',
      say(`V1 仅支持 Linux 远端，检测到 ${os}。`, `V1 supports Linux remotes only; detected ${os}.`),
      [['换一台 Linux 服务器，或等待后续版本', 'Use a Linux server, or wait for a later release']],
      { retryable: false },
    ),
  invalidInput: (field: string, detail?: BilingualText) =>
    fail(
      'invalid-input',
      detail ?? say(`字段「${field}」不合法。`, `The field "${field}" is invalid.`),
      [['修正后重试', 'Fix it and retry']],
      { retryable: false },
    ),
  internal: (cause: unknown) =>
    fail(
      'internal',
      say('插件内部出现异常，可重试或查看诊断。', 'The plugin hit an internal error; retry or check diagnostics.'),
      [],
      { technical: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? '') },
    ),
}
/** How much of one `ErrorView.technical` string the API will carry: producers hand over captured process output. */
export const TECHNICAL_LIMIT = 1200
/** The only ErrorView a caller may send: redaction is part of the contract, not an opt-in. `technical` is the risky
 * field — the first line of a remote `web.log` is the launch URL with its session token — so it is redacted and
 * length-capped first, then the whole view crosses `redactObject` so a detail quoting such a line is covered too. */
export function toErrorView(error: unknown): ErrorView {
  if (error instanceof RemoteGoError) {
    const row = rowOf(error.code)
    const view: ErrorView = {
      code: error.code,
      title: row?.title ?? say('未知错误', 'Unknown error'),
      detail: error.detail,
      nextSteps: error.nextSteps,
      retryable: error.retryable,
    }
    if (error.technical) view.technical = headTail(redactText(error.technical), TECHNICAL_LIMIT)
    return redactObject(view)
  }
  return toErrorView(errors.internal(error))
}
export function isRemoteGoError(error: unknown): boolean {
  return error instanceof RemoteGoError
}

/**
 * Coded, bilingual errors; `toErrorView` is the only shape the Client ever sees.
 */
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

/** Per-error overrides a producer may pass; `retryable` defaults to the code's table entry. */
export interface RemoteGoErrorOptions {
  nextSteps?: BilingualText[]
  technical?: string
  retryable?: boolean
}

/** One row of the code table: whether the Client may offer a retry, and the fallback title. */
interface ErrorCodeRow {
  retryable: boolean
  title: BilingualText
}

const ErrorCode = Object.freeze({
  NETWORK: 'network',
  AUTH: 'auth',
  HOST_KEY_CHANGED: 'host-key-changed',
  HOST_KEY_UNKNOWN: 'host-key-unknown',
  REMOTE_DSH_MISSING: 'remote-dsh-missing',
  REMOTE_NODE_INSTALL_FAILED: 'remote-node-install-failed',
  REMOTE_DSH_START_FAILED: 'remote-dsh-start-failed',
  REMOTE_DSH_RUNNING: 'remote-dsh-running',
  REMOTE_UI_UNREACHABLE: 'remote-ui-unreachable',
  REMOTE_UNREACHABLE: 'remote-unreachable',
  RESTART_UNAVAILABLE: 'restart-unavailable',
  STOP_UNAVAILABLE: 'stop-unavailable',
  REMOTE_FILE_UNAVAILABLE: 'remote-file-unavailable',
  DOWNLOAD_NOT_READY: 'download-not-ready',
  DOWNLOAD_BUSY: 'download-busy',
  VERSION_MISMATCH: 'version-mismatch',
  UNSUPPORTED_OS: 'unsupported-os',
  INVALID_INPUT: 'invalid-input',
  INTERNAL: 'internal',
})

const CODE_TABLE: Record<string, ErrorCodeRow> = {
  [ErrorCode.NETWORK]: { retryable: true, title: { zh: '连不上这台服务器', en: 'Cannot reach this server' } },
  [ErrorCode.AUTH]: { retryable: true, title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' } },
  [ErrorCode.HOST_KEY_CHANGED]: { retryable: false, title: { zh: '主机指纹变了', en: 'The host key changed' } },
  [ErrorCode.HOST_KEY_UNKNOWN]: { retryable: true, title: { zh: '确认服务器指纹', en: 'Confirm the host key' } },
  [ErrorCode.REMOTE_DSH_MISSING]: {
    retryable: true,
    title: { zh: '远端没有可用的 DSH', en: 'No usable DSH on the remote host' },
  },
  [ErrorCode.REMOTE_NODE_INSTALL_FAILED]: {
    retryable: true,
    title: { zh: '远端 Node 自动安装失败', en: 'Automatic Node installation failed' },
  },
  [ErrorCode.REMOTE_DSH_START_FAILED]: {
    retryable: true,
    title: { zh: '远端 DSH 启动失败', en: 'The remote DSH failed to start' },
  },
  [ErrorCode.REMOTE_DSH_RUNNING]: {
    retryable: true,
    title: { zh: '远端已有手工启动的 DSH', en: 'A manually started DSH is already running' },
  },
  [ErrorCode.REMOTE_UI_UNREACHABLE]: {
    retryable: true,
    title: { zh: '远端界面打不开', en: 'The remote interface is unreachable' },
  },
  [ErrorCode.REMOTE_UNREACHABLE]: {
    retryable: true,
    title: { zh: '远端 DSH 已不在运行', en: 'The remote DSH is no longer running' },
  },
  [ErrorCode.RESTART_UNAVAILABLE]: {
    retryable: true,
    title: { zh: '现在不能重启远端 DSH', en: 'The remote DSH cannot be restarted now' },
  },
  [ErrorCode.STOP_UNAVAILABLE]: {
    retryable: true,
    title: { zh: '现在不能关闭远端 DSH', en: 'The remote DSH cannot be stopped now' },
  },
  [ErrorCode.REMOTE_FILE_UNAVAILABLE]: {
    retryable: true,
    title: { zh: '无法读取远端文件', en: 'Cannot read the remote file' },
  },
  [ErrorCode.DOWNLOAD_NOT_READY]: {
    retryable: true,
    title: { zh: '下载尚未准备好', en: 'The download is not ready' },
  },
  [ErrorCode.DOWNLOAD_BUSY]: {
    retryable: true,
    title: { zh: '下载任务太多', en: 'Too many downloads are running' },
  },
  [ErrorCode.VERSION_MISMATCH]: {
    retryable: true,
    title: { zh: '远端 DSH 版本与本机不一致', en: 'Remote DSH version differs from this machine' },
  },
  [ErrorCode.UNSUPPORTED_OS]: {
    retryable: false,
    title: { zh: '远端系统暂不支持', en: 'This remote system is not supported yet' },
  },
  [ErrorCode.INVALID_INPUT]: { retryable: false, title: { zh: '填写的信息有误', en: 'Some fields are invalid' } },
  [ErrorCode.INTERNAL]: { retryable: true, title: { zh: '插件内部错误', en: 'Internal plugin error' } },
}

export class RemoteGoError extends Error {
  declare code: string
  declare detail: BilingualText
  declare nextSteps: BilingualText[]
  declare technical?: string
  declare retryable: boolean

  constructor(code: string, detail: BilingualText, options: RemoteGoErrorOptions = {}) {
    super(`${code}: ${detail.en}`)
    this.name = 'RemoteGoError'
    this.code = code
    this.detail = detail
    this.nextSteps = options.nextSteps ?? []
    this.technical = options.technical
    this.retryable = options.retryable ?? CODE_TABLE[code]?.retryable ?? true
  }
}

const say = (zh: string, en: string): BilingualText => ({ zh, en })

function fail(
  code: string,
  detail: BilingualText,
  steps: [string, string][],
  options: RemoteGoErrorOptions = {},
): RemoteGoError {
  return new RemoteGoError(code, detail, { nextSteps: steps.map(([zh, en]) => say(zh, en)), ...options })
}

export const errors = {
  network: (
    detail: BilingualText = say(
      '网络不可达，可能被防火墙拦截或地址写错。',
      'The network is unreachable — check the address, port and firewall.',
    ),
    options?: RemoteGoErrorOptions,
  ) =>
    fail(
      ErrorCode.NETWORK,
      detail,
      [
        ['检查地址、端口与网络连通性', 'Check the address, port and network reachability'],
        ['如果有跳板机，先确认跳板机可达', 'If a jump host is configured, verify it first'],
      ],
      options,
    ),
  auth: (
    detail: BilingualText = say('远端拒绝了这次 SSH 认证。', 'The remote host rejected this SSH authentication.'),
    options?: RemoteGoErrorOptions,
  ) =>
    fail(
      ErrorCode.AUTH,
      detail,
      [
        ['检查用户名与密钥 / SSH Agent', 'Check the user name and key / SSH agent'],
        ['确认密钥文件路径与权限（0600）', 'Confirm the key file path and its 0600 permissions'],
      ],
      options,
    ),
  hostKeyChanged: (pinned: string, actual: string) =>
    fail(
      ErrorCode.HOST_KEY_CHANGED,
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
      ErrorCode.HOST_KEY_UNKNOWN,
      say(
        `首次连接该服务器（指纹 ${fingerprint}），需要你确认。`,
        `First connection to this host (fingerprint ${fingerprint}); confirmation required.`,
      ),
      [['核对指纹后选择「接受并记住」或取消', 'Verify the fingerprint, then accept and remember it or cancel']],
    ),
  remoteDshMissing: (detail?: BilingualText) =>
    fail(
      ErrorCode.REMOTE_DSH_MISSING,
      detail ??
        say(
          '远端没有找到可用的 DSH，本机也无法自动准备运行环境。',
          'No usable DSH was found and the runtime could not be prepared automatically.',
        ),
      [
        ['确认远端可以访问网络，或配置离线包', 'Check remote network access, or configure an offline package'],
        ['也可以在远端手动安装 DSH 后重试', 'You can also install DSH manually on the remote host and retry'],
      ],
    ),
  nodeInstallFailed: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.REMOTE_NODE_INSTALL_FAILED,
      detail ??
        say(
          '远端没有可用的 Node，自动安装也没有成功。',
          'The remote has no usable Node and automatic installation did not succeed.',
        ),
      [
        [
          '让远端可以访问 nodejs.org 或 npmmirror.com 后重试',
          'Allow the remote to reach nodejs.org or npmmirror.com and retry',
        ],
        [
          '确认远端磁盘 ≥ 400 MB，且是受支持的 glibc 架构（musl/Alpine 不支持）',
          'Make sure the remote has >= 400 MB free and a supported glibc architecture (musl/Alpine is not supported)',
        ],
      ],
      options,
    ),
  remoteDshRunning: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.REMOTE_DSH_RUNNING,
      detail ??
        say(
          '远端检测到不是本插件启动的 DSH 进程，连接已按你的选择取消。',
          'The remote has a DSH process this plugin did not start; the connection was cancelled as you chose.',
        ),
      [
        [
          '重新连接，并选择「停止它并启动受管实例」或「保留它，另起一个」',
          'Reconnect and choose "Stop it and start the managed instance" or "Keep it and start alongside"',
        ],
      ],
      options,
    ),
  remoteDshStartFailed: (tail: string) =>
    fail(
      ErrorCode.REMOTE_DSH_START_FAILED,
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
  remoteUiUnreachable: (detail?: BilingualText) =>
    fail(
      ErrorCode.REMOTE_UI_UNREACHABLE,
      detail ??
        say(
          '隧道的本地回环端口无法完成远端界面的鉴权握手。',
          'The loopback tunnel could not complete the remote UI authentication handshake.',
        ),
      [
        ['点「重连」重试一次', 'Retry with Reconnect'],
        ['查看诊断中的隧道与界面可达性检查', 'Check tunnel and UI reachability in diagnostics'],
      ],
    ),
  /**
   * The remote web went away and nothing adoptable came back. Kept apart from
   * `remote-ui-unreachable`: here the tunnel may be perfectly fine and the process
   * is what is missing, which is what the restart button exists for.
   */
  remoteUnreachable: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.REMOTE_UNREACHABLE,
      detail ??
        say(
          '远端 DSH 已经停止响应，而且没有找到可以重新挂载的实例；主机配置保留。',
          'The remote DSH stopped responding and no instance could be re-attached to; the host configuration is kept.',
        ),
      [
        [
          '点「重启」用同一份配置重新拉起远端进程',
          'Use "Restart" to start the remote process again with the same settings',
        ],
        ['点「重连」按存活策略重新连接', 'Use Reconnect to connect again under the keep-alive policy'],
      ],
      options,
    ),
  /**
   * One-shot restart requested in a state that cannot support it (not connected, no live
   * SSH, or already busy with another action). The HTTP API answers 409 for this.
   */
  restartUnavailable: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.RESTART_UNAVAILABLE,
      detail ??
        say(
          '只有已连接、或远端不可达但仍保留 SSH 连接的主机才能重启远端 DSH。',
          'The remote DSH can only be restarted while this host is connected, or after a remote-unreachable failure that kept the SSH session.',
        ),
      [
        ['先连接这台主机，再点「重启」', 'Connect the host first, then use "Restart"'],
        ['如果连接已断开，点「重连」重新建立连接', 'If the link dropped, use Reconnect to establish it again'],
      ],
      options,
    ),
  /**
   * The explicit "stop remote DSH" action was refused: wrong state, another link action in
   * flight, or the bound process could not be proven to be this connection's own. The HTTP
   * API answers 409 for this.
   */
  stopRemoteUnavailable: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.STOP_UNAVAILABLE,
      detail ??
        say(
          '只有已连接、或远端不可达但仍保留 SSH 连接的主机才能关闭远端 DSH，而且只能关闭本连接启动或接管的那一个进程。',
          'The remote DSH can only be stopped while this host is connected (or after a remote-unreachable failure that kept the SSH session), and only when it is the process this connection launched or took over.',
        ),
      [
        ['先连接这台主机，再点「关闭」', 'Connect the host first, then use "Stop"'],
        [
          '如果强烈怀疑远端进程不属于本连接，点「重连」重建连接后再试',
          'If the remote process may not belong to this connection, use Reconnect and try again',
        ],
      ],
      options,
    ),
  remoteFileUnavailable: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.REMOTE_FILE_UNAVAILABLE,
      detail ??
        say(
          '远端路径不存在、不可读，或无法写入本地保存位置。',
          'The remote path does not exist, is not readable, or the local destination cannot be written.',
        ),
      [
        ['确认文件仍在远端，且当前 SSH 用户可以读取', 'Confirm the file still exists and the SSH user can read it'],
        [
          '检查文件大小；过大的文件请先在远端压缩或拆分',
          'Check the file size; compress or split large files on the remote first',
        ],
      ],
      options,
    ),
  downloadNotReady: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.DOWNLOAD_NOT_READY,
      detail ??
        say(
          '这个下载还在准备中，或已经失效；请重新发起下载。',
          'This download is still being prepared or has expired; start it again.',
        ),
      [
        ['等待进度条完成后再试', 'Wait for the progress bar to finish and retry'],
        ['如果任务已失效，从远端文件树重新下载', 'If it expired, start the download again from the remote file tree'],
      ],
      options,
    ),
  downloadBusy: (detail?: BilingualText, options?: RemoteGoErrorOptions) =>
    fail(
      ErrorCode.DOWNLOAD_BUSY,
      detail ??
        say(
          '同时准备的下载任务过多，请等一个完成后再试。',
          'Too many downloads are being prepared at once; wait for one to finish and retry.',
        ),
      [['取消不需要的下载，或稍后重试', 'Cancel an unneeded download, or retry later']],
      options,
    ),
  versionMismatch: (local: string, remote: string) =>
    fail(
      ErrorCode.VERSION_MISMATCH,
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
      ErrorCode.UNSUPPORTED_OS,
      say(`V1 仅支持 Linux 远端，检测到 ${os}。`, `V1 supports Linux remotes only; detected ${os}.`),
      [['换一台 Linux 服务器，或等待后续版本', 'Use a Linux server, or wait for a later release']],
      { retryable: false },
    ),
  invalidInput: (field: string, detail?: BilingualText) =>
    fail(
      ErrorCode.INVALID_INPUT,
      detail ?? say(`字段「${field}」不合法。`, `The field "${field}" is invalid.`),
      [['修正后重试', 'Fix it and retry']],
      { retryable: false },
    ),
  internal: (cause: unknown) =>
    fail(
      ErrorCode.INTERNAL,
      say('插件内部出现异常，可重试或查看诊断。', 'The plugin hit an internal error; retry or check diagnostics.'),
      [],
      { technical: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? '') },
    ),
}

/**
 * How much of one `ErrorView.technical` string the API will carry. The producers hand over
 * captured process output (a remote `web.log` tail, an SFTP failure); the API response is the
 * one place that must never carry the whole of it.
 */
export const TECHNICAL_LIMIT = 1200

/**
 * The only ErrorView a caller may send: redaction is part of the contract, not an opt-in.
 * `technical` is the risky field — producers put remote process output there, and the first
 * line of a remote `web.log` is the launch URL with its session token. It is redacted and
 * length-capped, then the whole view goes through `redactObject` so a detail/next-step that
 * quotes one of those lines is covered too (docs/api.md: "已脱敏").
 */
export function toErrorView(error: unknown): ErrorView {
  if (error instanceof RemoteGoError) {
    const table = CODE_TABLE[error.code] ?? { retryable: true, title: { zh: '未知错误', en: 'Unknown error' } }
    const view: ErrorView = {
      code: error.code,
      title: table.title,
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

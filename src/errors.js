/**
 * Coded, bilingual errors; `toErrorView` is the only shape the Client ever sees.
 */

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
  VERSION_MISMATCH: 'version-mismatch',
  UNSUPPORTED_OS: 'unsupported-os',
  SYNC_FAILED: 'sync-failed',
  INVALID_INPUT: 'invalid-input',
  INTERNAL: 'internal',
})

const CODE_TABLE = {
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
  [ErrorCode.VERSION_MISMATCH]: {
    retryable: true,
    title: { zh: '远端 DSH 版本与本机不一致', en: 'Remote DSH version differs from this machine' },
  },
  [ErrorCode.UNSUPPORTED_OS]: {
    retryable: false,
    title: { zh: '远端系统暂不支持', en: 'This remote system is not supported yet' },
  },
  [ErrorCode.SYNC_FAILED]: {
    retryable: true,
    title: { zh: '同步本地配置失败', en: 'Syncing the local configuration failed' },
  },
  [ErrorCode.INVALID_INPUT]: { retryable: false, title: { zh: '填写的信息有误', en: 'Some fields are invalid' } },
  [ErrorCode.INTERNAL]: { retryable: true, title: { zh: '插件内部错误', en: 'Internal plugin error' } },
}

export class RemoteGoError extends Error {
  constructor(code, detail, options = {}) {
    super(`${code}: ${detail.en}`)
    this.name = 'RemoteGoError'
    this.code = code
    this.detail = detail
    this.nextSteps = options.nextSteps ?? []
    this.technical = options.technical
    this.retryable = options.retryable ?? CODE_TABLE[code]?.retryable ?? true
  }
}

const say = (zh, en) => ({ zh, en })

function fail(code, detail, steps, options = {}) {
  return new RemoteGoError(code, detail, { nextSteps: steps.map(([zh, en]) => say(zh, en)), ...options })
}

export const errors = {
  network: (
    detail = say(
      '网络不可达，可能被防火墙拦截或地址写错。',
      'The network is unreachable — check the address, port and firewall.',
    ),
    options,
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
  auth: (detail = say('远端拒绝了这次 SSH 认证。', 'The remote host rejected this SSH authentication.'), options) =>
    fail(
      ErrorCode.AUTH,
      detail,
      [
        ['检查用户名与密钥 / SSH Agent', 'Check the user name and key / SSH agent'],
        ['确认密钥文件路径与权限（0600）', 'Confirm the key file path and its 0600 permissions'],
      ],
      options,
    ),
  hostKeyChanged: (pinned, actual) =>
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
  hostKeyUnknown: (fingerprint) =>
    fail(
      ErrorCode.HOST_KEY_UNKNOWN,
      say(
        `首次连接该服务器（指纹 ${fingerprint}），需要你确认。`,
        `First connection to this host (fingerprint ${fingerprint}); confirmation required.`,
      ),
      [['核对指纹后选择「接受并记住」或取消', 'Verify the fingerprint, then accept and remember it or cancel']],
    ),
  remoteDshMissing: (detail) =>
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
  nodeInstallFailed: (detail, options) =>
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
  remoteDshRunning: (detail, options) =>
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
  remoteDshStartFailed: (tail) =>
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
  remoteUiUnreachable: (detail) =>
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
  versionMismatch: (local, remote) =>
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
  unsupportedOs: (os) =>
    fail(
      ErrorCode.UNSUPPORTED_OS,
      say(`V1 仅支持 Linux 远端，检测到 ${os}。`, `V1 supports Linux remotes only; detected ${os}.`),
      [['换一台 Linux 服务器，或等待后续版本', 'Use a Linux server, or wait for a later release']],
      { retryable: false },
    ),
  syncFailed: (detail, options) =>
    fail(
      ErrorCode.SYNC_FAILED,
      detail ??
        say(
          '把本机的插件与配置同步到远端时失败，远端文件已尽量恢复。',
          'Syncing this machine’s plugins and configuration to the remote failed; the remote files were restored where possible.',
        ),
      [
        [
          '重试一次；若仍失败，可先关闭该主机的同步选项再连接',
          'Retry; if it keeps failing, turn the host’s sync options off and connect again',
        ],
        [
          '查看连接日志里的 sync: 行，确认是哪一步失败',
          'Check the sync: lines in the connection log to see which step failed',
        ],
      ],
      options,
    ),
  invalidInput: (field, detail) =>
    fail(
      ErrorCode.INVALID_INPUT,
      detail ?? say(`字段「${field}」不合法。`, `The field "${field}" is invalid.`),
      [['修正后重试', 'Fix it and retry']],
      { retryable: false },
    ),
  internal: (cause) =>
    fail(
      ErrorCode.INTERNAL,
      say('插件内部出现异常，可重试或查看诊断。', 'The plugin hit an internal error; retry or check diagnostics.'),
      [],
      { technical: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? '') },
    ),
}

export function toErrorView(error) {
  if (error instanceof RemoteGoError) {
    const table = CODE_TABLE[error.code] ?? { retryable: true, title: { zh: '未知错误', en: 'Unknown error' } }
    const view = {
      code: error.code,
      title: table.title,
      detail: error.detail,
      nextSteps: error.nextSteps,
      retryable: error.retryable,
    }
    if (error.technical) view.technical = error.technical
    return view
  }
  return toErrorView(errors.internal(error))
}

export function isRemoteGoError(error) {
  return error instanceof RemoteGoError
}

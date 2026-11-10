/**
 * Coded, bilingual errors. The user-visible taxonomy follows design §8.4;
 * `toErrorView` is the only shape the Client ever sees.
 */

/** @typedef {{ zh: string, en: string }} I18nText */
/** @typedef {{ zh: string, en: string }[]} I18nList */

export const ErrorCode = Object.freeze({
  NETWORK: 'network',
  AUTH: 'auth',
  HOST_KEY_CHANGED: 'host-key-changed',
  HOST_KEY_UNKNOWN: 'host-key-unknown',
  REMOTE_DSH_MISSING: 'remote-dsh-missing',
  REMOTE_DSH_START_FAILED: 'remote-dsh-start-failed',
  REMOTE_UI_UNREACHABLE: 'remote-ui-unreachable',
  VERSION_MISMATCH: 'version-mismatch',
  UNSUPPORTED_OS: 'unsupported-os',
  OFFLINE: 'offline',
  INVALID_INPUT: 'invalid-input',
  INTERNAL: 'internal',
})

/** @type {Record<string, { retryable: boolean, title: I18nText }>} */
const CODE_TABLE = {
  [ErrorCode.NETWORK]: {
    retryable: true,
    title: { zh: '连不上这台服务器', en: 'Cannot reach this server' },
  },
  [ErrorCode.AUTH]: {
    retryable: true,
    title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
  },
  [ErrorCode.HOST_KEY_CHANGED]: {
    retryable: false,
    title: { zh: '主机指纹变了', en: 'The host key changed' },
  },
  [ErrorCode.HOST_KEY_UNKNOWN]: {
    retryable: true,
    title: { zh: '确认服务器指纹', en: 'Confirm the host key' },
  },
  [ErrorCode.REMOTE_DSH_MISSING]: {
    retryable: true,
    title: { zh: '远端没有可用的 DSH', en: 'No usable DSH on the remote host' },
  },
  [ErrorCode.REMOTE_DSH_START_FAILED]: {
    retryable: true,
    title: { zh: '远端 DSH 启动失败', en: 'The remote DSH failed to start' },
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
  [ErrorCode.OFFLINE]: {
    retryable: true,
    title: { zh: '远端缺少运行环境且离线包不可用', en: 'Remote runtime is missing and no offline package is available' },
  },
  [ErrorCode.INVALID_INPUT]: {
    retryable: false,
    title: { zh: '填写的信息有误', en: 'Some fields are invalid' },
  },
  [ErrorCode.INTERNAL]: {
    retryable: true,
    title: { zh: '插件内部错误', en: 'Internal plugin error' },
  },
}

export class RemoteGoError extends Error {
  /**
   * @param {string} code
   * @param {{ zh: string, en: string }} detail
   * @param {{ nextSteps?: I18nList, technical?: string, retryable?: boolean }} [options]
   */
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

/** @param {string} code @param {I18nText} detail @param {ConstructorParameters<typeof RemoteGoError>[2]} [options] */
function make(code, detail, options) {
  return new RemoteGoError(code, detail, options)
}

export const errors = {
  network: (detail = { zh: '网络不可达，可能被防火墙拦截或地址写错。', en: 'The network is unreachable — check the address, port and firewall.' }, options) =>
    make(ErrorCode.NETWORK, detail, {
      nextSteps: [
        { zh: '检查地址、端口与网络连通性', en: 'Check the address, port and network reachability' },
        { zh: '如果有跳板机，先确认跳板机可达', en: 'If a jump host is configured, verify it first' },
      ],
      ...options,
    }),
  auth: (detail = { zh: '远端拒绝了这次 SSH 认证。', en: 'The remote host rejected this SSH authentication.' }, options) =>
    make(ErrorCode.AUTH, detail, {
      nextSteps: [
        { zh: '检查用户名与密钥 / SSH Agent', en: 'Check the user name and key / SSH agent' },
        { zh: '确认密钥文件路径与权限（0600）', en: 'Confirm the key file path and its 0600 permissions' },
      ],
      ...options,
    }),
  hostKeyChanged: (pinned, actual) =>
    make(
      ErrorCode.HOST_KEY_CHANGED,
      {
        zh: `主机指纹和已记录的不一致：记录 ${pinned}，实际 ${actual}。`,
        en: `The host key no longer matches the pinned value: pinned ${pinned}, actual ${actual}.`,
      },
      {
        nextSteps: [
          { zh: '确认服务器是否重装或更换了证书；确认后再更新指纹', en: 'Confirm the server was not reinstalled or tampered with before updating the pin' },
        ],
        retryable: false,
        technical: `pinned=${pinned} actual=${actual}`,
      },
    ),
  hostKeyUnknown: (fingerprint) =>
    make(
      ErrorCode.HOST_KEY_UNKNOWN,
      { zh: `首次连接该服务器（指纹 ${fingerprint}），需要你确认。`, en: `First connection to this host (fingerprint ${fingerprint}); confirmation required.` },
      {
        nextSteps: [{ zh: '核对指纹后选择「接受并记住」或取消', en: 'Verify the fingerprint, then accept and remember it or cancel' }],
      },
    ),
  remoteDshMissing: (detail) =>
    make(
      ErrorCode.REMOTE_DSH_MISSING,
      detail ?? { zh: '远端没有找到可用的 DSH，本机也无法自动准备运行环境。', en: 'No usable DSH was found and the runtime could not be prepared automatically.' },
      {
        nextSteps: [
          { zh: '确认远端可以访问网络，或配置离线包', en: 'Check remote network access, or configure an offline package' },
          { zh: '也可以在远端手动安装 DSH 后重试', en: 'You can also install DSH manually on the remote host and retry' },
        ],
      },
    ),
  remoteDshStartFailed: (tail) =>
    make(
      ErrorCode.REMOTE_DSH_START_FAILED,
      { zh: '远端 DSH 进程没有成功打印 Web 地址，可能启动即失败。', en: 'The remote DSH process did not print its Web URL; startup likely failed.' },
      {
        nextSteps: [
          { zh: '查看诊断里的远端日志尾部', en: 'Inspect the remote log tail in diagnostics' },
          { zh: '确认远端磁盘空间与端口可用', en: 'Check remote disk space and usable ports' },
          { zh: '重试一次，若仍失败可手动在远端验证 `dsh --profile web --no-open`', en: 'Retry, or verify `dsh --profile web --no-open` manually on the remote host' },
        ],
        technical: tail,
      },
    ),
  remoteUiUnreachable: (detail) =>
    make(
      ErrorCode.REMOTE_UI_UNREACHABLE,
      detail ?? { zh: '隧道的本地回环端口无法完成远端界面的鉴权握手。', en: 'The loopback tunnel could not complete the remote UI authentication handshake.' },
      {
        nextSteps: [
          { zh: '点「重连」重试一次', en: 'Retry with Reconnect' },
          { zh: '查看诊断中的隧道与界面可达性检查', en: 'Check tunnel and UI reachability in diagnostics' },
        ],
      },
    ),
  versionMismatch: (local, remote) =>
    make(
      ErrorCode.VERSION_MISMATCH,
      {
        zh: `本机 DSH 是 ${local}，远端是 ${remote}；界面可能不一致，默认不静默混用。`,
        en: `This machine runs DSH ${local} while the remote runs ${remote}; the UI may differ and mixing silently is not allowed.`,
      },
      {
        nextSteps: [
          { zh: '选择「准备同版本运行时」后重试（推荐）', en: 'Prepare a matching runtime and retry (recommended)' },
          { zh: '明确选择「沿用远端版本」继续', en: 'Explicitly continue with the remote version' },
        ],
      },
    ),
  unsupportedOs: (os) =>
    make(
      ErrorCode.UNSUPPORTED_OS,
      { zh: `V1 仅支持 Linux 远端，检测到 ${os}。`, en: `V1 supports Linux remotes only; detected ${os}.` },
      { nextSteps: [{ zh: '换一台 Linux 服务器，或等待后续版本', en: 'Use a Linux server, or wait for a later release' }], retryable: false },
    ),
  offline: (detail) =>
    make(
      ErrorCode.OFFLINE,
      detail ?? { zh: '远端缺少运行环境，且离线包不可用。', en: 'The remote runtime is missing and no offline package is available.' },
      {
        nextSteps: [
          { zh: '让远端可以访问 nodejs.org 与 npm registry', en: 'Allow the remote host to reach nodejs.org and the npm registry' },
          { zh: '或配置「离线包」后重试', en: 'Or configure an offline package and retry' },
        ],
      },
    ),
  invalidInput: (field, detail) =>
    make(
      ErrorCode.INVALID_INPUT,
      detail ?? { zh: `字段「${field}」不合法。`, en: `The field "${field}" is invalid.` },
      { nextSteps: [{ zh: '修正后重试', en: 'Fix it and retry' }], retryable: false },
    ),
  internal: (cause) =>
    make(
      ErrorCode.INTERNAL,
      { zh: '插件内部出现异常，可重试或查看诊断。', en: 'The plugin hit an internal error; retry or check diagnostics.' },
      { technical: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? '') },
    ),
}

/**
 * @param {unknown} error
 * @returns {{ code: string, title: I18nText, detail: I18nText, nextSteps: I18nList, retryable: boolean, technical?: string }}
 */
export function toErrorView(error) {
  if (error instanceof RemoteGoError) {
    const table = CODE_TABLE[error.code] ?? { retryable: true, title: { zh: '未知错误', en: 'Unknown error' } }
    /** @type {any} */
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
  const internal = errors.internal(error)
  return toErrorView(internal)
}

/** @param {unknown} error */
export function isRemoteGoError(error) {
  return error instanceof RemoteGoError
}

// client/src/errors.ts - LOCAL_ERRORS and the ErrorView builders every surface renders; after util.ts, before api-client.ts.
//#region 5. local error views

const LOCAL_ERRORS = {
  network: {
    code: 'network',
    retryable: true,
    title: { zh: '本地插件服务不可用', en: 'The local plugin service is unavailable' },
    detail: {
      zh: '本地插件服务不可用，请检查插件是否启用。',
      en: 'The local plugin service is unavailable. Check that the plugin is enabled.',
    },
    nextSteps: [
      { zh: '确认 DSH 已加载 dsh-remote-go 插件', en: 'Make sure DSH has loaded the dsh-remote-go plugin' },
      { zh: '刷新页面后重试', en: 'Refresh the page and retry' },
      { zh: '如果问题持续，查看 DSH 日志中的插件错误', en: 'If it persists, check the DSH logs for plugin errors' },
    ],
  },
  internal: {
    code: 'internal',
    retryable: true,
    title: { zh: '操作失败', en: 'The action failed' },
    detail: { zh: '插件内部错误，请重试。', en: 'An internal plugin error occurred. Try again.' },
    nextSteps: [
      { zh: '重试本次操作', en: 'Retry this action' },
      { zh: '打开诊断查看检查结果', en: 'Open diagnostics to inspect the checks' },
      { zh: '如果问题持续，刷新页面', en: 'If it persists, refresh the page' },
    ],
  },
  'blocked-url': {
    code: 'blocked-url',
    retryable: false,
    title: { zh: '已阻止打开远端界面', en: 'Blocked opening the remote UI' },
    detail: {
      zh: '远端地址不是本地回环地址，出于安全考虑已阻止。',
      en: 'The remote address is not a loopback address, so it was blocked for safety.',
    },
    nextSteps: [
      { zh: '重新连接以刷新本地回环地址', en: 'Reconnect to refresh the loopback address' },
      { zh: '运行诊断检查隧道状态', en: 'Run diagnostics to check the tunnel' },
    ],
  },
  /**
   * DSH's admission fence answered without a JSON envelope (401: no browser session, 403:
   * Host/Origin refused). Neither is a plugin failure, and retrying the same request cannot
   * help, so they are their own views instead of the old "internal error".
   */
  'session-expired': {
    code: 'session-expired',
    retryable: false,
    title: { zh: '会话已失效', en: 'The session has expired' },
    detail: {
      zh: '本机 DSH 的浏览器会话已失效，请刷新页面后重试。',
      en: 'This browser session for the local DSH is no longer valid. Refresh the page and try again.',
    },
    nextSteps: [
      { zh: '刷新页面以重新建立会话', en: 'Refresh the page to establish a new session' },
      {
        zh: '如果仍被拒绝，确认 DSH Web 的登录状态',
        en: 'If it is still refused, check the DSH Web sign-in state',
      },
    ],
  },
  forbidden: {
    code: 'forbidden',
    retryable: false,
    title: { zh: '被安全策略拒绝', en: 'Refused by the security policy' },
    detail: {
      zh: 'DSH 的 Host/Origin 准入拒绝了这次请求；请用本机地址打开 DSH Web，不要经反向代理或外部域名访问。',
      en: 'The Host/Origin admission refused this request. Open DSH Web on this machine, not through a reverse proxy or an external host name.',
    },
    nextSteps: [
      {
        zh: '使用 http://127.0.0.1:<端口> 打开本机 DSH Web',
        en: 'Open the local DSH Web via http://127.0.0.1:<port>',
      },
      { zh: '刷新页面后重试', en: 'Refresh the page and try again' },
    ],
  },
}

/** One `{zh,en}` pair exactly as the locale service resolves it. */
interface LocalizedText {
  zh: string
  en: string
}

/** The view every failure surface renders (`ErrorView` in docs/api.md §0). */
interface LocalErrorView {
  code: string
  retryable: boolean
  title: LocalizedText
  detail: LocalizedText
  nextSteps: LocalizedText[]
  /** The Host's own message, kept out of the localized copy (`error-view.test.js` pins it). */
  technical?: string
}

function localErrorView(code, technical?: string) {
  const base = LOCAL_ERRORS[code] || LOCAL_ERRORS.internal
  const view: LocalErrorView = {
    code: base.code,
    retryable: base.retryable,
    title: base.title,
    detail: base.detail,
    nextSteps: base.nextSteps,
  }
  if (technical) view.technical = technical
  return view
}

function toErrorView(error) {
  if (error && typeof error === 'object') {
    if (error.view && typeof error.view === 'object') return error.view
    if (error.title && error.detail) return error
  }
  const technical = error && typeof error.message === 'string' ? error.message : String(error)
  return localErrorView('internal', technical)
}

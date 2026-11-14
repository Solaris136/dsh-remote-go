/*
 * dsh-remote-go · Client half — a single-file browser plugin with no build step: one host
 * switcher row plus every floating window in the shell's overlay layer (the sections below are
 * marked with //#region). It renders the Host's state (docs/api.md is the frozen contract; the
 * Host half in src/ is the only source of truth) and sends user intents back. The row is the
 * plugin's only entry — no settings page, no sidebar panel, no main panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-go',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    /** Element whose only prop is its class: h(tag, { className }, ...children) without the noise. */
    const box = (tag, className, ...children) => h(tag, { className }, ...children)
    /** A dialog's action strip: one right-aligned row of buttons. */
    const footerRow = (...actions) => h('div', { className: 'drg-row drg-row-end' }, ...actions)
    const { useCallback, useEffect, useRef, useState } = React

    //#region 1. constants

    const NS = 'dsh-remote-go'
    const PANEL_ID = 'dsh-remote-go'
    const API_BASE = '/dsh-remote-go/api'
    const EVENT_PATH = '/dsh-remote-go/api/events'
    const POLL_INTERVAL_MS = 3000
    const DESKTOP_BRIDGE_VERSION = 1
    const OVERLAY_ROOT_ID = 'dsh-remote-go-overlay'
    const CAPTION_FALLBACK_HEIGHT = 40
    const CAPTION_MARKER = 'data-windows-titlebar'
    const CAPTION_LIVE_CLASS = 'drg-caption-live'
    const CAPTION_GRIP_LEFT = 84
    /** Only loopback URLs may ever be handed to the guest (docs/api.md 安全约束). */
    const LOOPBACK_PREFIX = 'http://127.0.0.1:'
    /** Ordered connect phases (contract ConnectPhase). */
    const PHASES = ['ssh', 'probe', 'bootstrap', 'start', 'tunnel', 'verifying', 'ready']
    /** Known diagnostic check ids, in the contract's fixed order. */
    const DIAGNOSE_IDS = [
      'ssh-reachable',
      'auth',
      'host-key',
      'tunnel',
      'remote-service',
      'remote-ui',
      'remote-node',
      'remote-version',
      'model-credentials',
      'desktop-guard',
    ]
    const TONE_VARS = {
      idle: 'var(--dsw-alias-state-idle-primary)',
      info: 'var(--dsw-alias-state-business-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      limited: 'var(--dsw-static-violet-400)',
    }
    /** One entry per HostStatus, so the label, the strip and the primary action cannot disagree. */
    const STATUS = {
      unconfigured: { tone: 'idle', action: 'cardConnect', connect: true },
      connecting: { tone: 'info', action: 'connecting', wait: true, window: true },
      'fingerprint-pending': { tone: 'warn', action: 'confirmFingerprint', window: true },
      'conflict-pending': { tone: 'warn', action: 'statusConflictPending', wait: true, strip: 'status' },
      connected: { tone: 'success', action: 'cardOpen' },
      disconnected: { tone: 'warn', action: 'cardConnect', connect: true, retry: true },
      error: { tone: 'error', action: 'cardConnect', connect: true, retry: true, window: true, strip: 'alert' },
      limited: { tone: 'limited', action: 'cardConnect', retry: true, strip: 'alert' },
    }
    /** That status' entry plus its dictionary keys; every status names them `status<Name>`. */
    function statusOf(status) {
      const id = STATUS[status] === undefined ? 'unconfigured' : status
      const name = id.replace(/(?:^|-)([a-z])/g, (_all, letter) => letter.toUpperCase())
      return { ...STATUS[id], label: 'status' + name, hint: 'statusHint' + name }
    }

    //#region 2. i18n dictionaries

    /**
     * Every visible string, zh and en side by side. `status*` / `statusHint*` are read through
     * statusOf() in the constants region, which builds them from the HostStatus id.
     */
    const STRINGS = {
      panelSubtitle: [
        '管理远程主机，并把整个窗口交给其中一台的远端 DSH。',
        'Manage remote hosts and hand the whole window to one of their DSH instances.',
      ],
      addHost: ['添加主机', 'Add host'],
      addFirstHost: ['添加第一台服务器', 'Add your first server'],
      emptyTitle: ['还没有远程主机', 'No remote hosts yet'],
      emptyBody: [
        '还没有远程主机。添加一台，然后打开它的远端 DSH 界面。',
        'No remote hosts yet. Add one, then open its remote DSH interface.',
      ],
      refresh: ['刷新状态', 'Refresh status'],
      settings: ['设置', 'Settings'],
      close: ['关闭', 'Close'],
      cancel: ['取消', 'Cancel'],
      save: ['保存', 'Save'],
      back: ['返回', 'Back'],
      retry: ['重试', 'Retry'],
      diagnose: ['诊断', 'Diagnose'],
      connect: ['连接', 'Connect'],
      connecting: ['连接中…', 'Connecting…'],
      loading: ['加载中…', 'Loading…'],
      copied: ['已复制', 'Copied'],
      next: ['下一步', 'Next'],
      hostsTitle: ['远程主机', 'Remote hosts'],
      summary: ['已连接 {connected} / 共 {total}', '{connected} connected / {total} total'],
      lastOpened: ['上次打开', 'Last opened'],
      neverOpened: ['尚未打开', 'Never opened'],
      remoteVersion: ['远端 DSH', 'Remote DSH'],
      versionPending: ['连接后显示', 'Shown after connecting'],
      addHostTitle: ['添加服务器', 'Add server'],
      editHostTitle: ['编辑服务器', 'Edit server'],
      deleteTitle: ['删除这台服务器？', 'Delete this server?'],
      deleteBody: [
        '将删除「{name}」的连接配置，并断开当前连接。远端任务不受影响，之后可以重新添加。',
        'This removes the connection settings for "{name}" and disconnects it. Remote tasks keep running; you can add it again later.',
      ],
      deleteConfirm: ['删除', 'Delete'],
      deleteBusy: ['正在删除…', 'Deleting…'],
      statusUnconfigured: ['未配置', 'Not configured'],
      statusConnecting: ['连接中', 'Connecting'],
      statusFingerprintPending: ['指纹待确认', 'Fingerprint pending'],
      statusConflictPending: ['远端冲突待确认', 'Remote conflict'],
      statusConnected: ['已连接', 'Connected'],
      statusDisconnected: ['断线', 'Disconnected'],
      statusError: ['错误', 'Error'],
      statusLimited: ['受限', 'Limited'],
      statusHintUnconfigured: ['尚未连接过', 'Never connected'],
      statusHintConnecting: ['正在建立连接', 'Establishing the connection'],
      statusHintFingerprintPending: ['需要确认主机指纹', 'Confirm the host fingerprint'],
      statusHintConflictPending: [
        '远端已有手工启动的 DSH，需要你选择如何处理',
        'A manually started DSH is already running; choose how to proceed',
      ],
      statusHintConnected: ['远端界面可用', 'The remote UI is available'],
      statusHintDisconnected: ['连接断开，可重连', 'Connection lost — reconnect available'],
      statusHintError: ['连接失败', 'Connection failed'],
      statusHintLimited: ['能连上，但远端无法提供界面', 'Reachable, but the remote UI is unavailable'],
      confirmFingerprint: ['确认指纹', 'Confirm fingerprint'],
      cardOpen: ['打开', 'Open'],
      cardConnect: ['连接', 'Connect'],
      cardDisconnect: ['断开', 'Disconnect'],
      cardReconnect: ['重连', 'Reconnect'],
      cardDiagnose: ['诊断', 'Diagnose'],
      cardEdit: ['编辑', 'Edit'],
      cardDelete: ['删除', 'Delete'],
      errorReason: ['原因：{detail}', 'Reason: {detail}'],
      loopbackNote: [
        '远端界面只经 SSH 隧道映射为 127.0.0.1 后嵌入；不会直接使用该地址，也不会暴露到公网。',
        'The remote UI is embedded only through an SSH tunnel mapped to 127.0.0.1; this address is never used directly and is never exposed publicly.',
      ],
      viewportConnecting: ['正在连接「{name}」…', 'Connecting to "{name}"…'],
      viewportOverlayLoadFailed: [
        '远端界面加载失败。点侧边栏主机条里的「本地」离开远端，再点该主机重新接管。',
        'The remote UI failed to load. Pick “Local” in the sidebar switcher and open the host again.',
      ],
      desktopRequired: [
        '当前环境没有可用的桌面端窗口，远端界面只能在 DeepSeek Harness 桌面端打开。',
        'This window has no desktop guest seat; the remote UI only opens in the DSH desktop app.',
      ],
      connectLogTitle: ['连接日志', 'Connect log'],
      connectLogHint: ['关窗不中断连接', 'Closing keeps it running'],
      connectLogCount: ['{count} 行', '{count} lines'],
      connectLogEmpty: ['等待日志输出…', 'Waiting for log output…'],
      switcherLocal: ['本地', 'Local'],
      switcherAddHost: ['添加主机', 'Add host'],
      switcherManage: ['管理界面', 'Manage hosts'],
      switcherExit: ['断开', 'Disconnect'],
      'progress.ssh-connecting': ['正在连接 SSH…', 'Connecting over SSH…'],
      'progress.host-key-confirm': ['等待确认主机指纹…', 'Waiting for you to confirm the host key…'],
      'progress.auth-checking': ['正在认证…', 'Authenticating…'],
      'progress.probing': ['正在探测远端环境…', 'Probing the remote environment…'],
      'progress.remote-dsh-running': [
        '远端已有手工启动的 DSH，等待你的选择…',
        'A manually started DSH is running; waiting for your choice…',
      ],
      'progress.bootstrapping': ['正在准备远端运行时…', 'Preparing the remote runtime…'],
      'progress.installing-node': [
        '正在自动准备远端 Node（{version}）…',
        'Preparing a managed Node on the remote ({version})…',
      ],
      'progress.downloading-node': [
        '正在下载 Node {version}（已下载 {mb} MB）…',
        'Downloading Node {version} ({mb} MB so far)…',
      ],
      'progress.bootstrap-first-run': [
        '首次运行：正在下载 @deepseek-ai/dsh@{version}…',
        'First run: fetching @deepseek-ai/dsh@{version}…',
      ],
      'progress.bootstrap-fetching': ['正在下载 DSH 依赖包…', 'Fetching DSH packages…'],
      'progress.bootstrap-installed': ['依赖已安装，正在启动…', 'Packages installed; starting…'],
      'progress.bootstrap-progress': ['自举进度：{detail}', 'Bootstrap: {detail}'],
      'progress.starting-remote': ['正在启动远端 DSH…', 'Starting the remote DSH…'],
      'progress.tunneling': ['正在建立本地回环隧道…', 'Opening the loopback tunnel…'],
      'progress.verifying': ['正在验证远端界面…', 'Verifying the remote UI…'],
      'progress.ready': ['就绪', 'Ready'],
      'progress.reconnecting': ['断线重连中（第 {attempt}/{max} 次）…', 'Reconnecting ({attempt}/{max})…'],
      'progress.default': ['正在连接…', 'Connecting…'],
      'phase.ssh': ['SSH', 'SSH'],
      'phase.probe': ['探测', 'Probe'],
      'phase.bootstrap': ['准备运行时', 'Preparing runtime'],
      'phase.start': ['启动', 'Start'],
      'phase.tunnel': ['隧道', 'Tunnel'],
      'phase.verifying': ['校验界面', 'Verify UI'],
      'phase.ready': ['就绪', 'Ready'],
      fingerprintTitle: ['主机指纹待确认', 'Confirm the host fingerprint'],
      fingerprintBody: [
        '首次连接需要确认这台服务器的 SSH 主机指纹。确认后会记住；指纹变化时会再次提示。',
        "Confirm this server's SSH host key on first use. It is remembered after acceptance, and you are asked again if it changes.",
      ],
      fingerprintChanged: ['主机指纹已变化', 'The host key has changed'],
      fingerprintChangedBody: [
        '这台服务器的主机指纹与上次记录不一致，可能重装过系统，也可能存在中间人风险。确认无误后再继续。',
        'The host key differs from the recorded one. The server may have been reinstalled — or this could be a man-in-the-middle. Continue only if you are sure.',
      ],
      fingerprintKeyType: ['密钥类型', 'Key type'],
      fingerprintSha: ['SHA256 指纹', 'SHA256 fingerprint'],
      fingerprintPinned: ['已记录指纹', 'Recorded fingerprint'],
      fingerprintAccept: ['接受并记住', 'Accept and remember'],
      fingerprintAcceptOnce: ['仅本次接受', 'Accept once'],
      fingerprintReject: ['取消', 'Cancel'],
      passwordPromptTitle: ['输入 SSH 密码', 'Enter the SSH password'],
      passwordPromptBody: [
        '「{name}」使用密码认证。密码只用于本次连接；勾选后存进 DSH 的凭据存储（不写进主机配置）。',
        '"{name}" uses password authentication. The password is used only for this connection and is never saved.',
      ],
      passwordPromptRemember: ['安全保存这个密码（DSH 凭据存储）', 'Remember this password (DSH credential store)'],
      passwordPromptNoStorage: [
        '当前环境没有可用的凭据存储，密码只用于本次连接。',
        'No credential store is available here, so the password is used for this connection only.',
      ],
      passwordPromptLabel: ['密码', 'Password'],
      passwordPromptSubmit: ['连接', 'Connect'],
      passwordPromptRequired: ['请输入密码', 'Enter the password'],
      conflictTitle: ['远端已有手工启动的 DSH', 'A DSH is already running on the remote host'],
      conflictBody: [
        '「{name}」的远端检测到不是本插件启动的 DSH 进程（共 {count} 个）。它们与插件共用 ~/.dsh，同时运行可能争用同一会话或凭据文件。请选择如何处理：',
        'The remote for "{name}" has {count} DSH process(es) this plugin did not start. They share ~/.dsh with the plugin, so running both may contend over the same session or credential files. Choose how to proceed:',
      ],
      conflictHint: [
        '「停止」会向这些进程发送 SIGTERM / SIGKILL；「并存」会另起一个受管实例并保留它们。',
        '"Stop" sends SIGTERM / SIGKILL to those processes; "Keep alongside" starts a managed instance and leaves them running.',
      ],
      conflictStop: ['停止它并启动受管实例', 'Stop it and start the managed instance'],
      conflictAlongside: ['保留它，另起一个', 'Keep it and start alongside'],
      conflictCancel: ['取消连接', 'Cancel connection'],
      conflictBusy: ['正在提交选择…', 'Submitting…'],
      'wizard.name': ['显示名', 'Display name'],
      'wizard.namePlaceholder': ['例如：腾讯云测试机', 'e.g. Tencent test server'],
      'wizard.address': ['SSH 地址或别名', 'SSH address or alias'],
      'wizard.addressPlaceholder': ['例如：ubuntu@192.0.2.10 或 my-server', 'e.g. ubuntu@192.0.2.10 or my-server'],
      'wizard.addressHint': ['支持 ~/.ssh/config 中配置的别名。', 'Aliases from ~/.ssh/config are supported.'],
      'wizard.port': ['端口', 'Port'],
      'wizard.username': ['用户名', 'User'],
      'wizard.usernamePlaceholder': ['例如：ubuntu', 'e.g. ubuntu'],
      'wizard.auth': ['认证方式', 'Authentication'],
      'wizard.authKey': ['密钥文件', 'Key file'],
      'wizard.authPassword': ['密码（仅本次，不保存）', 'Password (this connection only)'],
      'wizard.keyPath': ['密钥文件路径', 'Key file path'],
      'wizard.keyPathPlaceholder': ['例如：~/.ssh/id_ed25519', 'e.g. ~/.ssh/id_ed25519'],
      'wizard.keyPathPick': ['选择文件…', 'Choose file…'],
      'wizard.password': ['密码', 'Password'],
      'wizard.passwordPlaceholder': ['仅用于本次连接，不会保存', 'Used for this connection only; never saved'],
      'wizard.authHint': [
        '使用私钥文件认证；也可以改用密码（仅本次连接）。',
        'Authenticates with a private-key file; a password works too, for this connection only.',
      ],
      'wizard.jumpHost': ['跳板机（可选）', 'Jump host (optional)'],
      'wizard.jumpHostPlaceholder': ['例如：另一台已添加主机的地址', 'e.g. another saved host address'],
      'wizard.keepAlive': ['远端存活策略', 'Remote keep-alive'],
      'wizard.keepAliveKeep': ['保持运行（推荐）', 'Keep running (recommended)'],
      'wizard.keepAliveStop': ['退出即停', 'Stop on exit'],
      'wizard.keepAliveIdle': ['空闲停止', 'Stop when idle'],
      'wizard.idleMinutes': ['空闲分钟数', 'Idle minutes'],
      'wizard.autoReconnect': ['断线后自动重连', 'Reconnect automatically'],
      'wizard.actionHint': [
        '保存只记下配置；连接会保存并立即连上去，首次连接需要确认主机指纹。',
        'Save only records the entry; Connect saves it and connects right away — the host key is confirmed on first use.',
      ],
      'wizard.saved': ['已保存', 'Saved'],
      'wizard.savingHost': ['正在保存…', 'Saving…'],
      'wizard.aliases': ['从 SSH 配置选择', 'Pick from SSH config'],
      'wizard.aliasesLoading': ['正在读取 ~/.ssh/config…', 'Reading ~/.ssh/config…'],
      'wizard.aliasesEmpty': ['没有发现可用的 SSH 别名', 'No SSH aliases found'],
      'wizard.knownHosts': ['已知主机 {count} 条', '{count} known hosts'],
      'wizard.validationName': ['请填写显示名', 'Enter a display name'],
      'wizard.validationAddress': ['请填写 SSH 地址或别名', 'Enter an SSH address or alias'],
      'wizard.validationAddressUrl': [
        '请填写 SSH 地址或别名，不要填写网页地址',
        'Enter an SSH address or alias, not a web URL',
      ],
      'wizard.validationPort': ['端口应为 1-65535', 'The port must be 1–65535'],
      'wizard.validationUsername': ['请填写用户名', 'Enter a user name'],
      'wizard.validationKeyPath': ['请填写密钥文件路径', 'Enter the key file path'],
      'wizard.validationPassword': ['请输入密码，或改用密钥文件', 'Enter the password, or switch to a key file'],
      'diag.title': ['连接诊断', 'Connection diagnostics'],
      'diag.running': ['正在执行检查…', 'Running checks…'],
      'diag.summaryOk': ['全部通过', 'All checks passed'],
      'diag.summaryWarning': ['有需要留意的问题', 'Some checks need attention'],
      'diag.summaryError': ['存在失败项', 'Some checks failed'],
      'diag.checkPass': ['通过', 'Pass'],
      'diag.checkFail': ['失败', 'Fail'],
      'diag.checkUnknown': ['未知', 'Unknown'],
      'diag.empty': ['还没有诊断结果。', 'No diagnostics yet.'],
      'diag.rerun': ['重新检查', 'Run again'],
      'diag.copy': ['复制诊断信息', 'Copy diagnostics'],
      'diag.copyDone': ['诊断信息已复制。', 'Diagnostics copied.'],
      'diag.redacted': ['诊断信息已脱敏，不包含访问令牌。', 'Diagnostics are redacted and contain no access tokens.'],
      'diag.generatedAt': ['生成时间', 'Generated'],
      'diag.host': ['主机', 'Host'],
      'diag.failed': ['诊断执行失败', 'Diagnostics failed'],
      'diag.close': ['关闭', 'Close'],
      'settings.title': ['设置', 'Settings'],
      'settings.ssh': ['SSH 默认值', 'SSH defaults'],
      'settings.defaultPort': ['默认端口', 'Default port'],
      'settings.defaultAuth': ['默认认证方式', 'Default authentication'],
      'settings.defaultAuthKey': ['密钥文件', 'Key file'],
      'settings.defaultAuthPassword': ['密码（仅本次）', 'Password (this connection only)'],
      'settings.defaultKeyPath': ['默认密钥文件', 'Default key file'],
      'settings.defaultKeyPathHint': [
        '新增主机时预填这个路径；仍可在向导里改。',
        'Pre-filled for a new host; the wizard can still override it.',
      ],
      'settings.keyPathPick': ['选择文件…', 'Choose file…'],
      'keyFile.title': ['选择 SSH 私钥文件', 'Choose an SSH private key'],
      'keyFile.hint': [
        '只列出用户主目录内的文件；点击目录进入，点击文件选中。',
        'Only files under your home directory are listed. Click a folder to enter it, a file to select it.',
      ],
      'keyFile.parent': ['上一级', 'Up'],
      'keyFile.loading': ['正在读取目录…', 'Reading the directory…'],
      'keyFile.empty': ['这个目录里没有可选项', 'Nothing selectable in this directory'],
      'settings.connectTimeout': ['连接超时（秒）', 'Connect timeout (seconds)'],
      'settings.security': ['安全', 'Security'],
      'settings.hostKeyPolicy': ['主机指纹策略', 'Host key policy'],
      'settings.hostKeyPolicyFirstUse': ['首次连接时询问', 'Ask on first use'],
      'settings.hostKeyPolicyStrict': ['严格校验（指纹变化即失败）', 'Strict (fail when the key changes)'],
      'settings.saveTokens': ['允许保存访问令牌', 'Allow saving access tokens'],
      'settings.saveTokensHint': [
        '默认关闭。开启后访问令牌会以 0600 权限保存在远端 DSH_HOME 下，仍存在被同机其他进程读取的风险。',
        'Off by default. When enabled, tokens are saved under the remote DSH_HOME with 0600 permissions, which still risks access by other processes on that machine.',
      ],
      'settings.saveTokensRisk': [
        '风险提示：令牌落盘后更难撤销，请只在受控服务器上开启。',
        'Risk: a persisted token is harder to revoke. Enable only on controlled servers.',
      ],
      'settings.reconnect': ['自动重连', 'Auto reconnect'],
      'settings.reconnectEnabled': ['断线后自动重连', 'Reconnect after a drop'],
      'settings.maxAttempts': ['最大重试次数', 'Max attempts'],
      'settings.baseDelay': ['重试间隔（毫秒）', 'Retry delay (ms)'],
      'settings.other': ['其他', 'Other'],
      'settings.language': ['语言', 'Language'],
      'settings.languageAuto': ['跟随 DSH', 'Follow DSH'],
      'settings.languageZh': ['中文', '中文'],
      'settings.languageEn': ['English', 'English'],
      'settings.logLevel': ['日志级别', 'Log level'],
      'settings.bootstrap': ['远端运行时', 'Remote runtime'],
      'settings.profile': ['DSH profile', 'DSH profile'],
      'settings.profileHint': [
        '默认 web；profile 配置在 ~/.dsh/profiles/<profile>',
        'Defaults to web; profile config lives in ~/.dsh/profiles/<profile>',
      ],
      'settings.bootstrapHint': [
        '用 npx 固定本机 DSH 版本启动；远端缺 Node 或版本过低时，插件自动装一份到 ~/.dsh/remote-go/node',
        'Launched with npx pinned to the local DSH version; when the remote Node is missing or too old, the plugin installs one under ~/.dsh/remote-go/node',
      ],
      'settings.saveSettings': ['保存设置', 'Save settings'],
      'settings.saved': ['设置已保存。', 'Settings saved.'],
      'error.actionFailed': ['操作失败', 'Action failed'],
    }
    const zh = Object.fromEntries(Object.entries(STRINGS).map(([key, pair]) => [key, pair[0]]))
    const en = Object.fromEntries(Object.entries(STRINGS).map(([key, pair]) => [key, pair[1]]))

    //#region 3. i18n helpers

    function interpolate(template, params) {
      if (params === undefined || params === null) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined || params[key] === null ? match : String(params[key]),
      )
    }

    function makeFallbackT(locale) {
      const dict = locale === 'en' ? en : zh
      return (key, params) => {
        const text = dict[key] !== undefined ? dict[key] : en[key] !== undefined ? en[key] : key
        return interpolate(text, params)
      }
    }

    function localeOf(props) {
      if (props && typeof props.getLocaleId === 'function') {
        try {
          const id = props.getLocaleId()
          if (id === 'en' || id === 'zh') return id
        } catch (_error) {
          // fall through to the default
        }
      }
      if (props && (props.localeId === 'en' || props.localeId === 'zh')) return props.localeId
      // The overlay and the wizard hand the resolved id down as `locale`; without this a
      // window opened from them resolved host-provided text as Chinese in an English UI.
      if (props && (props.locale === 'en' || props.locale === 'zh')) return props.locale
      return 'zh'
    }

    function translatorOf(props) {
      if (props && typeof props.t === 'function') return props.t
      return makeFallbackT(localeOf(props))
    }

    function resolveText(text, locale) {
      if (text === undefined || text === null) return ''
      if (typeof text === 'string') return text
      if (typeof text !== 'object') return String(text)
      const primary = locale === 'en' ? text.en : text.zh
      if (typeof primary === 'string') return primary
      if (typeof text.zh === 'string') return text.zh
      if (typeof text.en === 'string') return text.en
      return ''
    }

    function resolveTextList(list, locale) {
      if (!Array.isArray(list)) return []
      return list.map((item) => resolveText(item, locale)).filter((item) => item.length > 0)
    }

    //#region 4. misc utilities

    function isLoopbackAddress(address) {
      const value = String(address === undefined || address === null ? '' : address)
        .trim()
        .toLowerCase()
      if (value === '') return false
      if (value === 'localhost' || value === '::1' || value === '[::1]') return true
      if (value.startsWith('localhost:')) return true
      if (value.startsWith('127.')) return true
      return false
    }

    function looksLikeWebAddress(address) {
      const value = address.trim()
      return /^https?:\/\//i.test(value) || value.includes('://') || /[?&]token=/i.test(value)
    }

    function isValidLoopbackUrl(url) {
      return typeof url === 'string' && url.startsWith(LOOPBACK_PREFIX)
    }

    function formatTime(iso, locale) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      try {
        return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date)
      } catch (_error) {
        return date.toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    function displayAddress(host) {
      if (!host) return ''
      if (typeof host.addressMasked === 'string' && host.addressMasked.length > 0) return host.addressMasked
      if (typeof host.address === 'string' && host.address.length > 0) return host.address
      return ''
    }

    function unrefTimer(timer) {
      if (timer && typeof timer.unref === 'function') timer.unref()
    }

    function readBootVersion() {
      const boot = typeof window === 'undefined' ? null : window.__DSH_BOOT__
      const release = boot && typeof boot === 'object' ? boot.release : null
      return release && typeof release.version === 'string' && release.version !== '' ? release.version : undefined
    }

    async function copyText(text) {
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (_error) {
        // fall through to the legacy path
      }
      try {
        if (typeof document === 'undefined' || !document.body) return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        document.body.removeChild(area)
        return ok === true
      } catch (_error) {
        return false
      }
    }

    function progressText(t, progress) {
      if (!progress || typeof progress.code !== 'string' || progress.code.length === 0) {
        return t('progress.default')
      }
      const params = progress.params && typeof progress.params === 'object' ? progress.params : {}
      const key = 'progress.' + progress.code
      const text = t(key, params)
      // A missing key is returned verbatim by the locale service; fall back.
      return text === key ? t('progress.default') : text
    }

    /** A one-slot store: `emit` wakes every listener, `subscribe` returns its release. */
    function createStore() {
      const listeners = new Set()
      return {
        emit() {
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (_error) {
              // a stale listener must not break the update
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function createPanelRequestStore() {
      let pending = null
      const store = createStore()
      return {
        request(hostId) {
          if (typeof hostId === 'string' && hostId.length > 0) {
            pending = { kind: 'open', hostId }
            store.emit()
          }
        },
        requestIntent(intent) {
          if (!intent || typeof intent !== 'object') return
          const kinds = ['open', 'disconnect', 'manage', 'local']
          if (!kinds.includes(intent.kind)) return
          if ((intent.kind === 'open' || intent.kind === 'disconnect') && typeof intent.hostId !== 'string') return
          pending =
            intent.kind === 'open' || intent.kind === 'disconnect'
              ? { kind: intent.kind, hostId: intent.hostId }
              : { kind: intent.kind }
          store.emit()
        },
        take() {
          const intent = pending
          pending = null
          return intent
        },
        subscribe: store.subscribe,
      }
    }

    /** The wizard floats in the overlay seat, so it opens from any page without dragging a page along. */
    function createWizardStore() {
      let draft = null
      const store = createStore()
      return {
        open(next) {
          if (!next || typeof next !== 'object') return
          draft = { mode: next.mode === 'edit' ? 'edit' : 'add', host: next.host || null }
          store.emit()
        },
        close() {
          if (draft === null) return
          draft = null
          store.emit()
        },
        current() {
          return draft
        },
        subscribe: store.subscribe,
      }
    }

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
    }

    function localErrorView(code, technical) {
      const base = LOCAL_ERRORS[code] || LOCAL_ERRORS.internal
      const view = {
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

    //#region 6. HTTP + SSE API client

    function getFetch() {
      if (typeof fetch === 'function') return fetch
      if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window)
      return null
    }

    function apiError(view, cause) {
      const text =
        resolveText(view && view.detail, 'zh') ||
        resolveText(view && view.title, 'zh') ||
        'dsh-remote-go request failed'
      const error = new Error(text)
      error.name = 'ApiError'
      error.view = view
      if (cause !== undefined) error.cause = cause
      return error
    }

    /** One JSON request: the marker header and same-origin credentials are not optional (docs/api.md). */
    async function apiRequest(path, options) {
      const opts = options || {}
      const fetcher = getFetch()
      if (!fetcher) throw apiError(localErrorView('network'))
      const method = typeof opts.method === 'string' ? opts.method.toUpperCase() : 'GET'
      const headers = { accept: 'application/json', 'x-dsh-remote-go': '1' }
      const init = { method, headers, credentials: 'same-origin' }
      if (opts.signal !== undefined) init.signal = opts.signal
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json; charset=utf-8'
        init.body = JSON.stringify(opts.body)
      }
      let response
      try {
        response = await fetcher(API_BASE + path, init)
      } catch (cause) {
        throw apiError(localErrorView('network'), cause)
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (_error) {
        payload = null
      }
      if (payload && payload.ok === false) throw apiError(payload.error)
      if (!response || !response.ok) {
        throw apiError(localErrorView('internal', 'HTTP ' + String(response && response.status)))
      }
      if (!payload || payload.ok !== true) throw apiError(localErrorView('internal', 'malformed response'))
      return payload
    }

    const api = {
      async getState() {
        const payload = await apiRequest('/state')
        return payload.state
      },
      async reportLocalVersion(version) {
        if (typeof version !== 'string' || version.length === 0) return
        try {
          await apiRequest('/local-version', { method: 'POST', body: { version } })
        } catch (_error) {
          // Tolerated by contract: this only backfills the Host's probe.
        }
      },
      async connect(hostId, options) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/connect', {
          method: 'POST',
          body: options || {},
        })
      },
      async confirmConflict(hostId, action) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/conflict', {
          method: 'POST',
          body: { action },
        })
      },
      async disconnect(hostId, stopRemote) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/disconnect', {
          method: 'POST',
          body: { stopRemote: stopRemote === true },
        })
      },
      async reconnect(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/reconnect', { method: 'POST', body: {} })
      },
      async openHost(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/open')
        if (!isValidLoopbackUrl(payload.url)) throw apiError(localErrorView('blocked-url'))
        return payload.url
      },
      async acceptFingerprint(hostId, accept, remember, sha256) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/fingerprint', {
          method: 'POST',
          body: { accept: accept === true, remember: remember === true, sha256: sha256 || '' },
        })
      },
      async saveHost(host) {
        const payload = await apiRequest('/hosts', { method: 'POST', body: { host } })
        return payload.host
      },
      async deleteHost(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId), { method: 'DELETE' })
      },
      async diagnose(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/diagnose', {
          method: 'POST',
          body: {},
        })
        return payload.report
      },
      async saveSettings(patch) {
        const payload = await apiRequest('/settings', { method: 'POST', body: { patch } })
        return payload.settings
      },
      async activate(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/activate', { method: 'POST', body: {} })
      },
      async clearActive() {
        return apiRequest('/active', { method: 'POST', body: { id: null } })
      },
      async getAliases() {
        const payload = await apiRequest('/ssh/aliases')
        return {
          aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
          knownHosts: payload.knownHosts && typeof payload.knownHosts === 'object' ? payload.knownHosts : null,
        }
      },
      async listKeyFiles(dir) {
        const query = dir ? '?path=' + encodeURIComponent(dir) : ''
        const payload = await apiRequest('/keyfile/list' + query)
        return {
          path: typeof payload.path === 'string' ? payload.path : '',
          parent: typeof payload.parent === 'string' ? payload.parent : null,
          entries: Array.isArray(payload.entries) ? payload.entries : [],
          truncated: payload.truncated === true,
          defaultKeyPath: typeof payload.defaultKeyPath === 'string' ? payload.defaultKeyPath : '',
          defaultDir: typeof payload.defaultDir === 'string' ? payload.defaultDir : '',
        }
      },
    }

    function subscribeState(handlers) {
      const onState = typeof handlers.onState === 'function' ? handlers.onState : () => {}
      const onStatus = typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {}
      const onError = typeof handlers.onError === 'function' ? handlers.onError : () => {}
      let disposed = false
      let source = null
      let timer = null
      let polling = false

      const deliver = (state) => {
        if (disposed || !state || typeof state !== 'object') return
        onState(state)
      }
      const fetchOnce = () => {
        if (disposed) return
        api.getState().then(deliver, (error) => {
          if (!disposed) onError(error)
        })
      }
      const stopStream = () => {
        if (source !== null) {
          try {
            source.close()
          } catch (_error) {
            // ignore close failures
          }
          source = null
        }
      }
      const startPolling = () => {
        if (disposed || polling) return
        polling = true
        stopStream()
        onStatus('polling')
        if (typeof setInterval === 'function') {
          timer = setInterval(fetchOnce, POLL_INTERVAL_MS)
          unrefTimer(timer)
        }
        fetchOnce()
      }
      const startStream = () => {
        if (disposed) return
        if (typeof EventSource !== 'function') {
          startPolling()
          return
        }
        try {
          source = new EventSource(EVENT_PATH)
        } catch (_error) {
          startPolling()
          return
        }
        onStatus('live')
        source.addEventListener('state', (event) => {
          try {
            const state = JSON.parse(event.data)
            deliver(state)
          } catch (_error) {
            // a malformed frame must not kill the stream
          }
        })
        source.addEventListener('ping', () => {})
        source.addEventListener('error', () => {
          if (disposed) return
          startPolling()
        })
      }

      // Initial read in parallel with opening the stream, so the panel can paint immediately even when SSE is slow.
      fetchOnce()
      startStream()

      return () => {
        disposed = true
        stopStream()
        if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
        timer = null
      }
    }

    //#region 7. icons and small UI primitives

    function RemoteIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      const active = props && props.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 4, width: 12, height: 9.5, rx: 2 }),
        h('path', { d: 'M5.75 17.5h5' }),
        h('path', { d: 'M8.25 13.5v4' }),
        h('path', { d: 'M17.25 8.5h4.25v5h-4.25z' }),
        h('path', { d: 'M16 11h-2.25' }),
      )
    }

    function strokeIcon(paths, viewBox) {
      return function Icon(props) {
        const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: viewBox || '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block' },
          },
          paths.map((d, index) => h('path', { key: String(index), d })),
        )
      }
    }

    const IconPlus = strokeIcon(['M12 5v14', 'M5 12h14'])
    const IconRefresh = strokeIcon(['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'])
    const IconGear = strokeIcon([
      'M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z',
      'M19.4 13.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V20a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H4a2 2 0 1 1 0-4h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H10A1.6 1.6 0 0 0 11 4.09V4a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V10a1.6 1.6 0 0 0 1.47.97H20a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.47.97Z',
    ])
    const IconEdit = strokeIcon(['M4 20h4.5L20 8.5a2.12 2.12 0 0 0-3-3L5.5 17V20Z', 'M14.5 7l2.5 2.5'])
    const IconTrash = strokeIcon(['M4 7h16', 'M9 7V5h6v2', 'M6.5 7l1 13h9l1-13', 'M10 11v5', 'M14 11v5'])
    const IconPulse = strokeIcon(['M3 12h4l2.5-6 4 12 2.5-6H21'])
    const IconClose = strokeIcon(['M6 6l12 12', 'M18 6L6 18'])
    const IconCheck = strokeIcon(['M5 12.5l4.5 4.5L19 7'])
    const IconAlert = strokeIcon(['M12 3.5 21 19H3L12 3.5Z', 'M12 9.5v4.5', 'M12 17h.01'])

    function StatusDot(props) {
      const status = props && typeof props.status === 'string' ? props.status : 'unconfigured'
      const tone = statusOf(status).tone
      const label = props && typeof props.title === 'string' ? props.title : undefined
      return h('span', {
        className: 'drg-dot',
        style: { background: TONE_VARS[tone] },
        title: label,
        'aria-hidden': label === undefined ? 'true' : undefined,
        'data-tone': tone,
      })
    }

    function Badge(props) {
      const tone = props && typeof props.tone === 'string' ? props.tone : 'idle'
      return h(
        'span',
        {
          className: 'drg-badge',
          'data-tone': tone,
          title: props && props.title,
        },
        props && props.children,
      )
    }

    function Button(props) {
      const variant = props.variant || 'secondary'
      const className = ['drg-btn', 'drg-btn-' + variant].join(' ')
      const onClick = props.onClick
      return h(
        'button',
        {
          type: 'button',
          className,
          onClick: typeof onClick === 'function' ? onClick : undefined,
          disabled: props.disabled === true || props.busy === true,
          title: props.title,
          'data-testid': props.testId,
          'data-busy': props.busy === true ? 'true' : undefined,
        },
        props.busy === true ? h(Spinner, { size: 14 }) : null,
        box('span', 'drg-btn-label', props.children),
      )
    }

    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'drg-iconbtn',
          onClick: typeof props.onClick === 'function' ? props.onClick : undefined,
          disabled: props.disabled === true,
          title: props.label,
          'aria-label': props.label,
          'data-testid': props.testId,
        },
        props.icon,
      )
    }

    function Spinner(props) {
      return h('span', {
        className: 'drg-spinner',
        style: {
          width: props && props.size ? props.size + 'px' : '16px',
          height: props && props.size ? props.size + 'px' : '16px',
        },
        'aria-hidden': 'true',
      })
    }

    function Field(props) {
      return h(
        'label',
        {
          className: 'drg-field' + (props.wide === true ? ' drg-field-wide' : ''),
        },
        props.label ? box('span', 'drg-field-label', props.label) : null,
        props.children,
        props.hint ? box('span', 'drg-field-hint', props.hint) : null,
        props.error ? h('span', { className: 'drg-field-error', role: 'alert' }, props.error) : null,
      )
    }

    function TextInput(props) {
      return h('input', {
        className: 'drg-input',
        type: props.type || 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder,
        list: props.list,
        disabled: props.disabled === true,
        autoComplete: props.autoComplete || 'off',
        spellCheck: false,
        'data-testid': props.testId,
        onChange: typeof props.onChange === 'function' ? (event) => props.onChange(event.target.value) : undefined,
        onKeyDown: typeof props.onKeyDown === 'function' ? props.onKeyDown : undefined,
        'aria-label': props.ariaLabel,
      })
    }

    function Select(props) {
      const options = Array.isArray(props.options) ? props.options : []
      return h(
        'select',
        {
          className: 'drg-select',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          disabled: props.disabled === true,
          'aria-label': props.ariaLabel,
          'data-testid': props.testId,
          onChange: typeof props.onChange === 'function' ? (event) => props.onChange(event.target.value) : undefined,
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    /** One form field from a spec; `after` runs alongside the patch (touched/dirty flags). */
    function formRow(t, draft, patch, spec) {
      const label = t(spec.label)
      const onChange = (next) => {
        patch({ [spec.key]: next })
        if (spec.after) spec.after(next)
      }
      return h(
        Field,
        { label, hint: spec.hint ? t(spec.hint) : undefined },
        spec.options
          ? h(Select, {
              value: draft[spec.key],
              ariaLabel: label,
              testId: spec.testId,
              options: spec.options.map(([value, key]) => ({ value, label: t(key) })),
              onChange,
            })
          : h(TextInput, {
              type: spec.kind,
              value: draft[spec.key],
              placeholder: spec.placeholder ? t(spec.placeholder) : undefined,
              ariaLabel: label,
              testId: spec.testId,
              onChange,
            }),
      )
    }

    function CheckRow(props) {
      return box(
        'label',
        'drg-check',
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          'data-testid': props.testId,
          onChange: typeof props.onChange === 'function' ? (event) => props.onChange(event.target.checked) : undefined,
        }),
        h('span', null, props.label),
      )
    }

    function Notice(props) {
      const tone = props.tone || 'info'
      return h(
        'div',
        { className: 'drg-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
        h(
          'span',
          { className: 'drg-notice-icon', 'aria-hidden': 'true' },
          tone === 'success' ? h(IconCheck) : h(IconAlert),
        ),
        box(
          'div',
          'drg-notice-body',
          props.title ? box('div', 'drg-notice-title', props.title) : null,
          props.children !== undefined && props.children !== null
            ? box('div', 'drg-notice-text', props.children)
            : null,
        ),
      )
    }

    function Modal(props) {
      const onClose = props.onClose
      // A dialog whose title is drawn by its own body (the host-management window) still
      // needs the close affordance, but not an empty header strip above the page title.
      const bare = !props.title && !props.subtitle
      useEffect(() => {
        if (typeof onClose !== 'function' || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])
      return box(
        'div',
        'drg-modal-layer',
        h('div', {
          className: 'drg-modal-backdrop',
          onClick: typeof onClose === 'function' ? onClose : undefined,
          'aria-hidden': 'true',
        }),
        h(
          'div',
          {
            className: 'drg-modal' + (props.wide === true ? ' drg-modal-wide' : ''),
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.title || undefined,
            'data-testid': props.testId,
            'data-bare': bare ? 'true' : undefined,
          },
          box(
            'div',
            'drg-modal-head',
            box(
              'div',
              'drg-modal-titles',
              props.title ? box('h2', 'drg-modal-title', props.title) : null,
              props.subtitle ? box('p', 'drg-modal-subtitle', props.subtitle) : null,
            ),
            typeof onClose === 'function'
              ? h(IconButton, { icon: h(IconClose), label: props.closeLabel || 'Close', onClick: onClose })
              : null,
          ),
          box('div', 'drg-modal-body', props.children),
          props.footer ? box('div', 'drg-modal-foot', props.footer) : null,
        ),
      )
    }

    function ConfirmDialog(props) {
      return h(
        Modal,
        {
          title: props.title,
          onClose: props.onCancel,
          closeLabel: props.cancelLabel,
          footer: footerRow(
            h(
              Button,
              { variant: 'secondary', onClick: props.onCancel, disabled: props.busy === true },
              props.cancelLabel,
            ),
            h(Button, { variant: 'danger', onClick: props.onConfirm, busy: props.busy === true }, props.confirmLabel),
          ),
        },
        box('p', 'drg-paragraph', props.body),
      )
    }

    //#region 8. host list view

    function LoadingBlock(props) {
      const t = translatorOf(props)
      return box('div', 'drg-loading', h(Spinner, { size: 20 }), h('span', null, props.label || t('loading')))
    }

    function EmptyHosts(props) {
      const t = translatorOf(props)
      return h(
        'div',
        { className: 'drg-empty', 'data-testid': 'host-list-empty' },
        h('div', { className: 'drg-empty-icon', 'aria-hidden': 'true' }, h(RemoteIcon, { size: 40 })),
        box('h3', 'drg-empty-title', t('emptyTitle')),
        box('p', 'drg-empty-body', t('emptyBody')),
        h(
          Button,
          {
            variant: 'primary',
            testId: 'host-add-empty',
            onClick: props.onAdd === undefined ? undefined : () => props.onAdd(),
          },
          t('addFirstHost'),
        ),
      )
    }

    function HostCard(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const host = props.host || {}
      const busy = props.busy === true
      const meta = statusOf(host.status)
      const statusLabel = t(meta.label)
      const remoteVersion =
        host.remote && typeof host.remote.version === 'string' && host.remote.version.length > 0
          ? host.remote.version
          : t('versionPending')
      const lastOpened = host.lastOpenedAt ? formatTime(host.lastOpenedAt, locale) : t('neverOpened')
      const reason = host.error ? resolveText(host.error.detail, locale) || resolveText(host.error.title, locale) : ''
      const primaryDisabled = busy || meta.wait === true

      return h(
        'li',
        { className: 'drg-host-card', 'data-status': host.status, 'data-testid': 'host-card', 'data-host-id': host.id },
        meta.strip
          ? h(
              'div',
              { className: 'drg-card-strip', role: meta.strip },
              h(IconAlert, { size: 14 }),
              box(
                'span',
                'drg-card-strip-text',
                meta.strip === 'alert' ? t('errorReason', { detail: reason || t(meta.hint) }) : t(meta.hint),
              ),
              meta.strip === 'alert'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'drg-linkbtn',
                      onClick: typeof props.onDiagnose === 'function' ? () => props.onDiagnose(host) : undefined,
                    },
                    t('cardDiagnose'),
                  )
                : null,
            )
          : null,
        box(
          'div',
          'drg-card-head',
          h(StatusDot, { status: host.status, title: statusLabel }),
          h('h3', { className: 'drg-card-name', title: host.name }, host.name || host.id),
          h(Badge, { tone: meta.tone, title: t(meta.hint) }, statusLabel),
        ),
        h('div', { className: 'drg-card-address', title: displayAddress(host) }, displayAddress(host) || '—'),
        box(
          'dl',
          'drg-card-meta',
          h('div', null, h('dt', null, t('remoteVersion')), h('dd', null, remoteVersion)),
          h('div', null, h('dt', null, t('lastOpened')), h('dd', null, lastOpened)),
        ),
        box(
          'div',
          'drg-card-actions',
          h(
            Button,
            {
              variant: host.status === 'connected' ? 'primary' : 'secondary',
              testId: 'host-open',
              onClick: () => {
                if (typeof props.onOpen === 'function') props.onOpen(host)
              },
              disabled: primaryDisabled,
              busy: busy && host.status !== 'connected' && host.status !== 'connecting',
            },
            t(meta.action),
          ),
          host.status === 'connected'
            ? h(
                Button,
                {
                  variant: 'ghost',
                  testId: 'host-disconnect',
                  onClick: () => props.onDisconnect && props.onDisconnect(host),
                  disabled: busy,
                },
                t('cardDisconnect'),
              )
            : null,
          meta.retry === true
            ? h(
                Button,
                {
                  variant: 'ghost',
                  testId: 'host-reconnect',
                  onClick: () => props.onReconnect && props.onReconnect(host),
                  disabled: busy,
                },
                t('cardReconnect'),
              )
            : null,
          box(
            'div',
            'drg-card-actions-end',
            h(IconButton, {
              icon: h(IconPulse),
              label: t('cardDiagnose'),
              testId: 'host-diagnose',
              onClick: () => props.onDiagnose && props.onDiagnose(host),
              disabled: busy,
            }),
            h(IconButton, {
              icon: h(IconEdit),
              label: t('cardEdit'),
              testId: 'host-edit',
              onClick: () => props.onEdit && props.onEdit(host),
              disabled: busy,
            }),
            h(IconButton, {
              icon: h(IconTrash),
              label: t('cardDelete'),
              testId: 'host-delete',
              onClick: () => props.onDelete && props.onDelete(host),
              disabled: busy,
            }),
          ),
        ),
      )
    }

    function HostListView(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const state = props.state || null
      const loading = props.loading === true
      const error = props.error || null
      const hosts = state && Array.isArray(state.hosts) ? state.hosts : []
      const connected = hosts.filter((host) => host && host.status === 'connected').length
      const total = hosts.length
      const busyHostId = props.busyHostId || null

      let content
      if (state === null && error !== null) {
        content = h(ErrorCard, {
          t,
          locale,
          error: toErrorView(error),
          onRetry: props.onRefresh ? () => props.onRefresh() : undefined,
        })
      } else if (state === null) {
        content = h(LoadingBlock, { t, label: t('loading') })
      } else if (hosts.length === 0) {
        content = h(EmptyHosts, { t, onAdd: props.onAdd })
      } else {
        content = box(
          'div',
          'drg-host-body',
          box(
            'div',
            'drg-summary',
            h(StatusDot, { status: connected > 0 ? 'connected' : 'idle' }),
            h('span', null, t('summary', { connected, total })),
          ),
          h(
            'ul',
            { className: 'drg-host-list', 'data-testid': 'host-list' },
            hosts.map((host) =>
              h(HostCard, {
                key: host.id,
                t,
                locale,
                host,
                busy: busyHostId === host.id,
                onOpen: props.onOpenHost,
                onDisconnect: props.onDisconnectHost,
                onReconnect: props.onReconnectHost,
                onEdit: props.onEditHost,
                onDelete: props.onDeleteHost,
                onDiagnose: props.onDiagnoseHost,
              }),
            ),
          ),
        )
      }

      return box(
        'div',
        'drg-page drg-host-page',
        box(
          'header',
          'drg-page-head',
          box(
            'div',
            'drg-page-heading',
            box('h1', 'drg-page-title', t('hostsTitle')),
            box('p', 'drg-page-subtitle', t('panelSubtitle')),
          ),
          box(
            'div',
            'drg-page-actions',
            h(
              Button,
              {
                variant: 'primary',
                testId: 'host-add',
                onClick: props.onAdd === undefined ? undefined : () => props.onAdd(),
              },
              h(IconPlus, { size: 14 }),
              h('span', null, t('addHost')),
            ),
            h(
              Button,
              {
                variant: 'ghost',
                testId: 'host-refresh',
                onClick: props.onRefresh,
                busy: loading,
              },
              h(IconRefresh, { size: 14 }),
              h('span', null, t('refresh')),
            ),
            h(IconButton, {
              icon: h(IconGear),
              label: t('settings'),
              testId: 'host-settings',
              onClick: props.onOpenSettings,
            }),
          ),
        ),
        content,
      )
    }

    //#region 9. takeover surface and carrier helpers

    function ConnectProgress(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const current = host.phase ? PHASES.indexOf(host.phase) : -1
      const name = host.name || host.id || ''
      return box(
        'div',
        'drg-progress',
        box(
          'div',
          'drg-progress-head',
          h(Spinner, { size: 22 }),
          box('h2', 'drg-progress-title', t('viewportConnecting', { name })),
        ),
        h(
          'p',
          { className: 'drg-progress-line', 'data-progress': host.progress ? host.progress.code : undefined },
          progressText(t, host.progress),
        ),
        box(
          'ol',
          'drg-phases',
          PHASES.map((phase, index) => {
            const state = current < 0 ? 'pending' : index < current ? 'done' : index === current ? 'current' : 'pending'
            return h(
              'li',
              { key: phase, className: 'drg-phase', 'data-state': state },
              h(
                'span',
                { className: 'drg-phase-mark', 'aria-hidden': 'true' },
                state === 'done' ? h(IconCheck, { size: 12 }) : null,
              ),
              h('span', null, t('phase.' + phase)),
            )
          }),
        ),
      )
    }

    function FingerprintCard(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const host = props.host || {}
      const fingerprint = host.fingerprint && typeof host.fingerprint === 'object' ? host.fingerprint : null
      const changed = fingerprint !== null && fingerprint.status === 'changed'
      const sha256 = fingerprint && typeof fingerprint.sha256 === 'string' ? fingerprint.sha256 : ''
      const keyType = fingerprint && typeof fingerprint.keyType === 'string' ? fingerprint.keyType : ''
      const pinned = fingerprint && typeof fingerprint.pinned === 'string' ? fingerprint.pinned : ''
      const busy = props.busy === true
      return h(
        'div',
        {
          className: 'drg-fingerprint',
          role: 'group',
          'aria-label': t('fingerprintTitle'),
          'data-testid': 'fingerprint-card',
        },
        h(
          'div',
          { className: 'drg-fingerprint-icon', 'data-tone': changed ? 'error' : 'warn', 'aria-hidden': 'true' },
          h(IconAlert, { size: 22 }),
        ),
        box('h2', 'drg-fingerprint-title', changed ? t('fingerprintChanged') : t('fingerprintTitle')),
        box('p', 'drg-fingerprint-body', changed ? t('fingerprintChangedBody') : t('fingerprintBody')),
        box(
          'dl',
          'drg-kv',
          keyType
            ? h('div', null, h('dt', null, t('fingerprintKeyType')), h('dd', null, h('code', null, keyType)))
            : null,
          sha256
            ? h('div', null, h('dt', null, t('fingerprintSha')), h('dd', null, box('code', 'drg-break', sha256)))
            : null,
          pinned && changed
            ? h('div', null, h('dt', null, t('fingerprintPinned')), h('dd', null, box('code', 'drg-break', pinned)))
            : null,
        ),
        props.error
          ? h(
              Notice,
              { tone: 'error' },
              resolveText(toErrorView(props.error).detail, locale) || t('error.actionFailed'),
            )
          : null,
        box(
          'div',
          'drg-row drg-row-wrap',
          h(
            Button,
            {
              variant: 'primary',
              testId: 'fingerprint-accept',
              busy,
              onClick: () => props.onAccept && props.onAccept(true),
            },
            t('fingerprintAccept'),
          ),
          h(
            Button,
            {
              variant: 'secondary',
              testId: 'fingerprint-accept-once',
              disabled: busy,
              onClick: () => props.onAccept && props.onAccept(false),
            },
            t('fingerprintAcceptOnce'),
          ),
          h(
            Button,
            { variant: 'ghost', testId: 'fingerprint-reject', disabled: busy, onClick: props.onReject },
            t('fingerprintReject'),
          ),
        ),
      )
    }

    function ErrorCard(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const view = toErrorView(props.error)
      const title = resolveText(view.title, locale) || t('error.actionFailed')
      const detail = resolveText(view.detail, locale)
      const steps = resolveTextList(view.nextSteps, locale)
      return h(
        'div',
        { className: 'drg-error-card', role: 'alert', 'data-testid': 'error-card' },
        h('div', { className: 'drg-error-icon', 'aria-hidden': 'true' }, h(IconAlert, { size: 24 })),
        box('h2', 'drg-error-title', title),
        detail ? box('p', 'drg-error-detail', detail) : null,
        steps.length > 0
          ? box(
              'div',
              'drg-error-steps',
              box('div', 'drg-section-label', t('next')),
              h(
                'ul',
                null,
                steps.map((step, index) => h('li', { key: String(index) }, step)),
              ),
            )
          : null,
        box(
          'div',
          'drg-row drg-row-wrap',
          view.retryable !== false && typeof props.onRetry === 'function'
            ? h(Button, { variant: 'primary', testId: 'error-retry', onClick: props.onRetry }, t('retry'))
            : null,
          typeof props.onDiagnose === 'function'
            ? h(Button, { variant: 'secondary', testId: 'error-diagnose', onClick: props.onDiagnose }, t('diagnose'))
            : null,
          typeof props.onBack === 'function'
            ? h(Button, { variant: 'ghost', testId: 'error-back', onClick: props.onBack }, t('back'))
            : null,
        ),
      )
    }

    function logClock(iso) {
      const when = typeof iso === 'string' && iso !== '' ? new Date(iso) : null
      if (when === null || Number.isNaN(when.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return pad(when.getHours()) + ':' + pad(when.getMinutes()) + ':' + pad(when.getSeconds())
    }

    function ConnectLog(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const entries = Array.isArray(host.logs) ? host.logs : []
      const bodyRef = useRef(null)
      const follow = useRef(true)
      const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0
      useEffect(() => {
        const body = bodyRef.current
        if (!body || !follow.current) return
        body.scrollTop = body.scrollHeight
      }, [lastSeq, entries.length])
      const onScroll = () => {
        const body = bodyRef.current
        if (!body) return
        // 2px slack: fractional scroll heights never land exactly on the bottom.
        follow.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 2
      }
      return h(
        'section',
        { className: 'drg-connect-log', 'data-testid': 'connect-log' },
        box(
          'div',
          'drg-connect-log-head',
          box('span', 'drg-connect-log-title', t('connectLogTitle')),
          // "Closing keeps it running" is only true while a connection is still in flight.
          host.status === 'error' ? null : box('span', 'drg-connect-log-hint', t('connectLogHint')),
          box('span', 'drg-connect-log-count', t('connectLogCount', { count: entries.length })),
        ),
        h(
          'div',
          {
            className: 'drg-connect-log-body',
            ref: bodyRef,
            role: 'log',
            tabIndex: 0,
            onScroll,
            'aria-label': t('connectLogTitle'),
          },
          entries.length === 0
            ? h('p', { className: 'drg-connect-log-empty', 'data-testid': 'connect-log-empty' }, t('connectLogEmpty'))
            : entries.map((entry) =>
                h(
                  'div',
                  {
                    key: String(entry.seq),
                    className: 'drg-connect-log-line',
                    'data-level': entry.level || 'info',
                    'data-testid': 'connect-log-line',
                  },
                  h('span', { className: 'drg-connect-log-time', 'aria-hidden': 'true' }, logClock(entry.at)),
                  box('span', 'drg-connect-log-text', String(entry.message ?? '')),
                ),
              ),
        ),
      )
    }

    function ConnectWindow(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const host = props.host || {}
      const status = host.status
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'drg-manage-live', 'data-testid': 'manage-live' },
          status === 'fingerprint-pending'
            ? h(FingerprintCard, {
                t,
                locale,
                host,
                busy: props.fingerprintBusy === true,
                onAccept: (remember) => props.onAcceptFingerprint(remember === true),
                onReject: props.onRejectFingerprint,
              })
            : status === 'error'
              ? h(ErrorCard, {
                  t,
                  locale,
                  error: host.error,
                  onRetry: props.onRetry,
                  onDiagnose: props.onDiagnose,
                  onBack: props.onBack,
                })
              : h(ConnectProgress, { t, host }),
        ),
        h(ConnectLog, { t, host }),
      )
    }

    //#region 9b. host switcher row + full-window remote carrier (DSH desktop only)

    const SWITCHER_TICK_MS = 1500

    /** What both copies of the row show. The row is plain DOM: it must outlive React re-renders. */
    const switcher = {
      current: 'local',
      hosts: [],
      labels: { local: 'Local', addHost: 'Add host', manage: 'Manage hosts', exit: 'Exit remote' },
      dispatch: null,
      labelsOf: null,
      installed: false,
    }

    function switcherPayload() {
      const hosts = []
      for (const host of switcher.hosts) {
        if (!host || typeof host.id !== 'string') continue
        hosts.push({
          id: host.id,
          name: host.name || '',
          address: host.address || '',
          status: host.status || 'idle',
        })
      }
      // A host deleted elsewhere must not leave the row naming a target that is gone.
      const known = switcher.current === 'local' || hosts.some((host) => host.id === switcher.current)
      const labels = typeof switcher.labelsOf === 'function' ? switcher.labelsOf() : switcher.labels
      return {
        current: known ? switcher.current : 'local',
        hosts,
        labels: {
          local: labels.local,
          addHost: labels.addHost,
          manage: labels.manage,
          exit: labels.exit,
        },
      }
    }

    function updateSwitcher(patch) {
      if (patch && typeof patch === 'object') {
        if (Array.isArray(patch.hosts)) {
          switcher.hosts = patch.hosts.filter((host) => host && typeof host.id === 'string')
        }
        if (typeof patch.current === 'string' && patch.current.length > 0) switcher.current = patch.current
        if (patch.labels && typeof patch.labels === 'object') {
          switcher.labels = { ...switcher.labels, ...patch.labels }
        }
      }
      const payload = switcherPayload()
      pushLocalHostRow(payload)
      pushGuestHostRow(payload)
      return payload
    }

    function localWindow() {
      return typeof window === 'undefined' || !window.document ? null : window
    }

    function pushLocalHostRow(payload) {
      const win = localWindow()
      if (win === null) return false
      // The local row talks to this module directly instead of being polled.
      win.__drgBridgeSink = dispatchSwitcherIntent
      let status = 'absent'
      if (win.__drgHostRow && typeof win.__drgHostRow.update === 'function') {
        try {
          status = win.__drgHostRow.update(payload)
        } catch (_error) {
          status = 'error'
        }
      }
      if (status === 'absent' || status === 'error') {
        try {
          win.__drgHostRow = null
          status = mountHostRow(win)
          if (status === 'installed') win.__drgHostRow.update(payload)
        } catch (_error) {
          status = 'error'
        }
      }
      switcher.installed = status === 'installed'
      return switcher.installed
    }

    function pushGuestHostRow(payload) {
      const entry = shownCarrier()
      if (entry === null || entry.rowInstalled !== true || entry.view === null) return
      try {
        entry.view.executeJavaScript(
          'window.__drgHostRow && window.__drgHostRow.update(' + JSON.stringify(payload) + ')',
        )
      } catch (_error) {
        // the guest may still be navigating
      }
    }

    function dispatchSwitcherIntent(intent) {
      if (!intent || typeof intent !== 'object') return
      if (typeof switcher.dispatch === 'function') switcher.dispatch(intent)
    }

    /**
     * The switcher row, stringified into the remote guest (`HOST_ROW_SCRIPT`): it may only touch
     * `win` and its own locals — any closure over this module breaks the guest copy. Intents leave
     * through `win.__drgBridgeSink` (local page) or `win.__drgBridgeQueue` (guest, drained by the
     * carrier); both copies therefore need identical intents and identical tokens.
     */
    function mountHostRow(win) {
      try {
        var doc = win.document
        if (!doc || !doc.head) return 'no-document'
        var existing = win.__drgHostRow
        if (existing && typeof existing.update === 'function') return existing.update(null)

        // A guest has no callback channel, so it leaves intents in a queue the carrier
        // drains: a single slot would drop the first of two quick clicks.
        var emit =
          typeof win.__drgBridgeSink === 'function'
            ? win.__drgBridgeSink
            : function (intent) {
                var queue = win.__drgBridgeQueue
                if (!queue || typeof queue.push !== 'function') queue = []
                queue.push(intent)
                win.__drgBridgeQueue = queue
              }

        var make = function (tag, className) {
          var node = doc.createElement(tag)
          if (className) node.className = className
          return node
        }
        var style = win.__drgHostRowStyle || null
        if (style === null) {
          style = make('style')
          style.id = 'drg-host-row-style'
          win.__drgHostRowStyle = style
        }
        style.textContent = [
          // The row is drawn inside the host page, so it reads that page's --dsw-* aliases and
          // follows light/dark, a registered theme, or a token override layer unchanged. The
          // menu surface uses the same pair as the host's own menus (specific-menu + blur).
          '#drg-host-row{position:relative;z-index:2147483000;display:flex;align-items:center;gap:8px;margin:4px 8px 6px;padding:5px 8px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);font:500 12.5px/1.35 var(--dsw-font-family);cursor:pointer;user-select:none;transition:background-color 140ms ease,color 140ms ease}',
          '#drg-host-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '#drg-host-row.drg-open{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
          '#drg-host-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
          '#drg-host-row .drg-hr-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:currentColor;color:var(--dsw-alias-state-idle-primary)}',
          '#drg-host-row .drg-hr-dot[data-state="local"],#drg-host-row .drg-hr-dot[data-state="connected"]{color:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent),0 0 7px 0 color-mix(in srgb,currentColor 45%,transparent)}',
          '#drg-host-row .drg-hr-dot[data-state="connecting"]{color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}',
          '#drg-host-row .drg-hr-dot[data-state="fingerprint-pending"],#drg-host-row .drg-hr-dot[data-state="conflict-pending"]{color:var(--dsw-alias-state-warn-primary)}',
          '#drg-host-row .drg-hr-dot[data-state="error"],#drg-host-row .drg-hr-dot[data-state="limited"]{color:var(--dsw-alias-state-error-primary)}',
          '#drg-host-row .drg-hr-glyph{display:flex;align-items:center;justify-content:center;width:8px;flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font:500 12px/1 var(--dsw-font-family)}',
          '#drg-host-row .drg-hr-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
          '#drg-host-row .drg-hr-chev{display:flex;flex:0 0 auto;color:var(--dsw-alias-label-tertiary);transition:transform 160ms ease}',
          '#drg-host-row.drg-open .drg-hr-chev{transform:rotate(180deg)}',
          // The row is a button, so the menu is a child of a pointer surface: the surface
          // itself (padding, separators, the slack around a short row) must not inherit the
          // hand, or the blank parts of the menu promise a click they do not have.
          '#drg-host-row .drg-hr-menu{display:none;position:fixed;z-index:2147483000;min-width:220px;max-height:min(60vh,420px);overflow:auto;padding:5px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);font-size:13px;cursor:default}',
          '#drg-host-row.drg-open .drg-hr-menu{display:block;animation:drg-hr-in 120ms ease-out}',
          '@keyframes drg-hr-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
          '#drg-host-row .drg-hr-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;overflow:hidden;transition:background-color 120ms ease,color 120ms ease}',
          '#drg-host-row .drg-hr-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '#drg-host-row .drg-hr-item[data-active="1"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}',
          '#drg-host-row .drg-hr-sep{height:.5px;margin:5px 6px;background:var(--dsw-alias-border-l1)}',
          // The name takes the slack, so the address and the exit control stay flush right.
          '#drg-host-row .drg-hr-item-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
          '#drg-host-row .drg-hr-addr{flex:0 0 auto;max-width:120px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
          // Text, not an icon, and only while the row is hovered: an accidental exit is a
          // worse outcome than a hidden control.
          '#drg-host-row .drg-hr-act{flex:0 0 auto;margin-left:2px;padding:2px 6px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity 120ms ease,background-color 120ms ease,color 120ms ease}',
          '#drg-host-row .drg-hr-item:hover .drg-hr-act,#drg-host-row .drg-hr-act:focus-visible{opacity:1;pointer-events:auto}',
          '#drg-host-row .drg-hr-act:hover,#drg-host-row .drg-hr-act:focus-visible{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}',
          '@media (prefers-reduced-motion:reduce){#drg-host-row,#drg-host-row *{transition:none!important;animation:none!important}}',
        ].join('')
        if (style.parentNode !== doc.head) doc.head.appendChild(style)

        var row = make('div')
        row.id = 'drg-host-row'
        row.setAttribute('role', 'button')
        row.setAttribute('aria-haspopup', 'menu')
        row.setAttribute('aria-expanded', 'false')
        var dotNode = make('span', 'drg-hr-dot')
        dotNode.setAttribute('data-state', 'local')
        row.appendChild(dotNode)
        var nameNode = make('span', 'drg-hr-name')
        row.appendChild(nameNode)
        var chevNode = make('span', 'drg-hr-chev')
        // Built node by node (never innerHTML), so no host name or address needs escaping.
        var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.setAttribute('width', '12')
        svg.setAttribute('height', '12')
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '1.7')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
        svg.setAttribute('aria-hidden', 'true')
        var chevPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
        chevPath.setAttribute('d', 'M4.2 6.4 8 10.2l3.8-3.8')
        svg.appendChild(chevPath)
        chevNode.appendChild(svg)
        row.appendChild(chevNode)
        var menuNode = make('span', 'drg-hr-menu')
        menuNode.setAttribute('role', 'menu')
        row.appendChild(menuNode)

        var state = {
          current: 'local',
          hosts: [],
          labels: { local: 'Local', addHost: 'Add host', manage: 'Manage hosts', exit: 'Exit remote' },
        }

        var dotFor = function (status) {
          var node = make('span', 'drg-hr-dot')
          node.setAttribute('data-state', status || 'idle')
          return node
        }
        var itemFor = function (label, options) {
          var opts = options || {}
          var node = make('span', 'drg-hr-item')
          node.setAttribute('role', 'menuitem')
          if (opts.target) node.setAttribute('data-target', opts.target)
          if (opts.action) node.setAttribute('data-action', opts.action)
          if (opts.active === true) node.setAttribute('data-active', '1')
          // An action gets a glyph where a target would carry its connection dot.
          if (opts.action) {
            var glyphNode = make('span', 'drg-hr-glyph')
            glyphNode.textContent = opts.glyph || '+'
            node.appendChild(glyphNode)
          } else {
            node.appendChild(dotFor(opts.state))
          }
          var textNode = make('span', 'drg-hr-item-name')
          textNode.textContent = label
          node.appendChild(textNode)
          if (opts.trailing) {
            var trailingNode = make('span', 'drg-hr-addr')
            trailingNode.textContent = opts.trailing
            node.appendChild(trailingNode)
          }
          // A live host carries its own exit control, on the same line, right-aligned and revealed on hover: switching
          // to a host and leaving it are different actions, and the menu had no way to leave one.
          if (opts.exit) {
            var exitLabel = state.labels.exit || 'Disconnect'
            var exitNode = make('button', 'drg-hr-act')
            exitNode.setAttribute('type', 'button')
            exitNode.setAttribute('data-action', 'disconnect')
            exitNode.setAttribute('data-host-id', opts.exit)
            exitNode.setAttribute('title', exitLabel + ' ' + label)
            exitNode.setAttribute('aria-label', exitLabel + ' ' + label)
            exitNode.textContent = exitLabel
            node.appendChild(exitNode)
          }
          return node
        }
        var clear = function (node) {
          while (node.firstChild) node.removeChild(node.firstChild)
        }
        var render = function () {
          var active = null
          for (var index = 0; index < state.hosts.length; index += 1) {
            if (state.hosts[index] && state.hosts[index].id === state.current) {
              active = state.hosts[index]
              break
            }
          }
          var isLocal = state.current === 'local'
          nameNode.textContent = isLocal
            ? state.labels.local
            : active
              ? active.name || active.address || active.id
              : state.labels.local
          dotNode.setAttribute('data-state', isLocal ? 'local' : active ? active.status || 'idle' : 'idle')
          clear(menuNode)
          menuNode.appendChild(itemFor(state.labels.local, { target: 'local', state: 'local', active: isLocal }))
          for (var cursor = 0; cursor < state.hosts.length; cursor += 1) {
            var host = state.hosts[cursor]
            if (!host || typeof host.id !== 'string') continue
            var label = host.name || host.address || host.id
            var address = host.address && host.address !== label ? host.address : ''
            menuNode.appendChild(
              itemFor(label, {
                target: host.id,
                state: host.status || 'idle',
                active: host.id === state.current,
                trailing: address,
                exit: host.status === 'connected' ? host.id : '',
              }),
            )
          }
          menuNode.appendChild(make('span', 'drg-hr-sep'))
          menuNode.appendChild(itemFor(state.labels.addHost, { action: 'add', glyph: '+' }))
          menuNode.appendChild(itemFor(state.labels.manage, { action: 'manage', glyph: '\u2261' }))
        }
        /**
         * Find the sidebar column and the row the switcher belongs under: the drag-handle
         * brand row when the shell exposes one, otherwise the tall left column itself.
         */
        var findSlot = function () {
          var handles = doc.querySelectorAll('[data-window-drag]')
          var best = null
          for (var index = 0; index < handles.length; index += 1) {
            var box = handles[index].getBoundingClientRect()
            if (box.width <= 0 && box.height <= 0) continue
            // The sidebar brand is inset by its padding and near the top; the conversation
            // header and the tab strip are wide, so the width bound leaves only the brand.
            if (box.width > 520) continue
            if (box.top > win.innerHeight * 0.4) continue
            if (!handles[index].parentNode) continue
            var columnBox = handles[index].parentNode.getBoundingClientRect()
            if (columnBox.left > 24) continue
            if (columnBox.width < 180) continue
            // macOS puts a drag strip *above* the brand row, and both qualify: the lower one
            // is the row the switcher belongs under.
            if (best === null || box.top > best.top) {
              best = { column: handles[index].parentNode, anchor: handles[index], top: box.top }
            }
          }
          if (best !== null) return { column: best.column, anchor: best.anchor }
          var columns = doc.querySelectorAll('div,aside,nav,section')
          var found = null
          for (var probe = 0; probe < columns.length; probe += 1) {
            var rect = columns[probe].getBoundingClientRect()
            if (rect.left > 2) continue
            if (rect.width < 180 || rect.width > 480) continue
            if (rect.height < win.innerHeight * 0.6) continue
            found = columns[probe]
          }
          if (found === null) return null
          return { column: found, anchor: found.children.length > 0 ? found.children[0] : null }
        }
        var place = function () {
          var slot = findSlot()
          if (slot === null) {
            // The collapsed rail is ~56px wide and no longer a candidate column: hide the
            // row instead of leaving it squeezed into it.
            var parent = row.parentNode
            var parentBox = parent && parent.getBoundingClientRect ? parent.getBoundingClientRect() : null
            if (parentBox !== null && parentBox.width < 180) {
              row.style.display = 'none'
              return 'collapsed'
            }
            return 'no-anchor'
          }
          // The collapsed rail is 56px wide: the row belongs to the expanded column only.
          if (slot.column.getBoundingClientRect().width < 180) {
            row.style.display = 'none'
            return 'collapsed'
          }
          row.style.display = ''
          if (slot.anchor === null) {
            if (row.parentNode !== slot.column) slot.column.appendChild(row)
            return 'installed'
          }
          if (slot.anchor.nextSibling !== row) slot.column.insertBefore(row, slot.anchor.nextSibling)
          return 'installed'
        }
        var closeMenu = function () {
          row.classList.remove('drg-open')
          row.setAttribute('aria-expanded', 'false')
        }
        row.addEventListener('click', function (event) {
          var target = event.target
          // A host's own exit control acts on that host without switching to it.
          if (target && target.classList && target.classList.contains('drg-hr-act')) {
            var exitHost = target.getAttribute('data-host-id')
            closeMenu()
            if (exitHost) emit({ action: 'disconnect', hostId: exitHost })
            return
          }
          while (target && target !== row && !(target.classList && target.classList.contains('drg-hr-item'))) {
            target = target.parentNode
          }
          if (target && target !== row && target.classList && target.classList.contains('drg-hr-item')) {
            var targetId = target.getAttribute('data-target')
            var action = target.getAttribute('data-action')
            closeMenu()
            if (action) emit({ action: action })
            else if (targetId) emit({ target: targetId })
            return
          }
          if (row.classList.contains('drg-open')) {
            closeMenu()
            return
          }
          // The sidebar clips its children: anchor the fixed menu to the row so it can
          // escape that overflow and sit over the page like a native menu.
          var rect = row.getBoundingClientRect()
          menuNode.style.top = rect.bottom + 4 + 'px'
          menuNode.style.left = rect.left + 'px'
          menuNode.style.width = rect.width + 'px'
          row.classList.add('drg-open')
          row.setAttribute('aria-expanded', 'true')
        })
        var outsideClick = function (event) {
          if (row.contains && row.contains(event.target)) return
          closeMenu()
        }
        doc.addEventListener('click', outsideClick)
        var update = function (payload) {
          if (payload && typeof payload === 'object') {
            if (Object.prototype.toString.call(payload.hosts) === '[object Array]') state.hosts = payload.hosts
            if (typeof payload.current === 'string' && payload.current.length > 0) state.current = payload.current
            if (payload.labels && typeof payload.labels === 'object') {
              state.labels = {
                local: String(payload.labels.local || state.labels.local),
                addHost: String(payload.labels.addHost || state.labels.addHost),
                manage: String(payload.labels.manage || state.labels.manage),
                exit: String(payload.labels.exit || state.labels.exit),
              }
            }
          }
          var status = place()
          if (status !== 'installed') return status
          render()
          return status
        }
        win.__drgHostRow = {
          update: update,
          destroy: function () {
            closeMenu()
            if (typeof doc.removeEventListener === 'function') doc.removeEventListener('click', outsideClick)
            if (row.parentNode) row.parentNode.removeChild(row)
            if (style.parentNode) style.parentNode.removeChild(style)
            win.__drgHostRow = null
            win.__drgHostRowStyle = null
          },
        }
        // A sidebar that is not mounted yet (or is collapsed) still gets its handle: the
        // caller's next push places the row the moment the column exists.
        return update(null)
      } catch (_error) {
        return 'error'
      }
    }

    const HOST_ROW_SCRIPT = '(' + mountHostRow.toString() + ')(window)'

    /**
     * The live guests, most recently shown first. A guest is hidden, never reloaded — that is what
     * makes switching instant — and is dropped only when its host goes away.
     */
    const carrierPool = {
      entries: [],
      current: null,
      wanted: null,
      poll: null,
    }

    /** Show/hide operations run one at a time: two overlapping opens must not build two guests. */
    let carrierQueue = Promise.resolve()

    let captionStateWatcher = null

    function whenCarrierIdle(task) {
      const run = carrierQueue.then(task, task)
      carrierQueue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    function carrierOf(hostId) {
      if (typeof hostId !== 'string' || hostId === '') return null
      return carrierPool.entries.find((entry) => entry.hostId === hostId) || null
    }

    function shownCarrier() {
      return carrierPool.current === null ? null : carrierOf(carrierPool.current)
    }

    function carrierWarm(hostId) {
      return carrierOf(hostId) !== null
    }

    function desktopBrowserBridge() {
      if (typeof window === 'undefined') return null
      const carrier = window.dshDesktop
      if (!carrier || carrier.protocolVersion !== DESKTOP_BRIDGE_VERSION) return null
      const browser = carrier.browser
      if (!browser || typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return null
      return browser
    }

    const CARRIER_CSS = `
      .drg-carrier-view{position:absolute;left:0;right:0;top:0;bottom:0;border:0;background:var(--dsw-alias-bg-base);pointer-events:auto}
      .drg-carrier-error{position:absolute;left:0;right:0;top:0;bottom:0;z-index:2;display:none;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);font:13px var(--dsw-font-family)}
    `

    async function installHostRow(entry) {
      const view = entry === null ? null : entry.view
      if (view === null || typeof view.executeJavaScript !== 'function') return false
      let status = 'error'
      try {
        status = await view.executeJavaScript(HOST_ROW_SCRIPT)
      } catch (_error) {
        status = 'error'
      }
      // 'collapsed' and 'no-anchor' still mean the handle exists: the next state push
      // places the row as soon as the remote sidebar is wide enough to hold it.
      const live = typeof status === 'string' && status !== 'error' && status !== 'no-document'
      entry.rowInstalled = live
      if (live && carrierPool.current === entry.hostId) pushGuestHostRow(switcherPayload())
      return live
    }

    function startHostRowPoll(entry) {
      stopHostRowPoll()
      const view = entry === null ? null : entry.view
      if (view === null || typeof view.executeJavaScript !== 'function') return
      carrierPool.poll = entry
      // One drain at a time: an overlapping read of the same intent must not dispatch twice.
      let draining = false
      entry.timer = setInterval(() => {
        if (carrierPool.poll !== entry || carrierPool.current !== entry.hostId) return
        if (draining) return
        let pending = null
        try {
          pending = view.executeJavaScript('window.__drgBridgeQueue || []')
        } catch (_error) {
          return
        }
        if (pending === null || typeof pending.then !== 'function') return
        draining = true
        pending
          .then((value) => {
            if (!value || !Array.isArray(value) || value.length === 0 || carrierPool.poll !== entry) return
            try {
              view.executeJavaScript('window.__drgBridgeQueue = []')
            } catch (_error) {
              // ignore a guest that navigated away mid-poll
            }
            for (const intent of value) dispatchSwitcherIntent(intent)
          })
          .catch(() => {})
          .then(() => {
            draining = false
          })
      }, 400)
      unrefTimer(entry.timer)
    }

    function stopHostRowPoll() {
      const entry = carrierPool.poll
      carrierPool.poll = null
      if (entry !== null && entry !== undefined && entry.timer !== null && entry.timer !== undefined) {
        if (typeof clearInterval === 'function') clearInterval(entry.timer)
        entry.timer = null
      }
    }

    /**
     * The caption band this page reserves, or null. A guest page has no preload, so the remote UI
     * would otherwise lay out as the Web build inside a window that is not one.
     */
    function desktopCaption() {
      if (typeof document === 'undefined' || !document.documentElement) return null
      const root = document.documentElement
      if (!root.hasAttribute(CAPTION_MARKER)) return null
      let height = CAPTION_FALLBACK_HEIGHT
      if (typeof getComputedStyle === 'function') {
        try {
          const raw = getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height')
          const parsed = Number.parseFloat(String(raw))
          if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 200) height = parsed
        } catch (_error) {
          // keep the fallback height
        }
      }
      return { height }
    }

    async function applyGuestCaption(entry) {
      const caption = entry === null || entry === undefined ? null : entry.caption
      if (caption === null || caption === undefined) return false
      const view = entry.view
      if (view === null || view === undefined || typeof view.executeJavaScript !== 'function') return false
      // Fullscreen drops the insets derived from the caption band (the window controls are
      // hidden), so the guest has to mirror the flag as well as the band.
      let fullscreen = false
      try {
        fullscreen = document.documentElement.hasAttribute('data-fullscreen')
      } catch (_error) {
        fullscreen = false
      }
      const source =
        '(function(){var root=document.documentElement;if(!root)return "no-document";' +
        'root.setAttribute("' +
        CAPTION_MARKER +
        '","");' +
        'root.style.setProperty("--dsh-windows-titlebar-height","' +
        caption.height +
        'px");' +
        'root.toggleAttribute("data-fullscreen",' +
        (fullscreen === true ? 'true' : 'false') +
        ');' +
        'return "ok"})()'
      let status = ''
      try {
        status = await view.executeJavaScript(source)
      } catch (_error) {
        status = ''
      }
      return status === 'ok'
    }

    function watchCaptionState() {
      if (captionStateWatcher !== null || typeof MutationObserver !== 'function') return
      if (typeof document === 'undefined' || !document.documentElement) return
      captionStateWatcher = new MutationObserver(() => {
        const entry = shownCarrier()
        if (entry === null || entry.captionApplied !== true) return
        applyGuestCaption(entry)
      })
      captionStateWatcher.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-fullscreen'],
      })
    }

    /** Exactly one band, never two: the guest reserves it when the marker landed, else it is pushed below. */
    function syncCarrierCaption(entry, applied) {
      const caption = entry === null || entry === undefined ? null : entry.caption
      if (caption === null || caption === undefined) return
      entry.captionApplied = applied === true
      entry.root.style.top = entry.captionApplied ? '0px' : caption.height + 'px'
      if (entry.grip !== null && entry.grip !== undefined) {
        entry.grip.style.display = entry.captionApplied ? '' : 'none'
      }
      if (carrierPool.current === entry.hostId) setCaptionLive(entry.captionApplied)
    }

    function setCaptionLive(live) {
      if (typeof document === 'undefined' || !document.documentElement) return
      if (live === true) document.documentElement.classList.add(CAPTION_LIVE_CLASS)
      else document.documentElement.classList.remove(CAPTION_LIVE_CLASS)
    }

    async function createCarrier(hostId, url, message) {
      const bridge = desktopBrowserBridge()
      if (bridge === null) return null
      let reservation = null
      try {
        reservation = await bridge.acquire('dsh-remote-go:' + (hostId || 'host'))
      } catch (_error) {
        return null
      }
      if (
        !reservation ||
        typeof reservation.lease !== 'string' ||
        typeof reservation.partition !== 'string' ||
        reservation.lease === ''
      ) {
        return null
      }

      const caption = desktopCaption()
      if (caption !== null) watchCaptionState()
      const root = document.createElement('div')
      // One root per warm host, so the ids stay unique (the host shows which window it is).
      root.id = OVERLAY_ROOT_ID + '-' + (hostId || 'host')
      root.setAttribute('data-testid', 'remote-overlay')
      root.setAttribute('data-host-id', hostId)
      // A guest that is taught the desktop layout reserves the caption band itself, so the carrier covers the whole
      // window and both pages lay out on one grid. Without a band to mirror (the Web build, or a macOS window) the
      // guest starts below the window's own band: clicks in it belong to the OS, not to this page.
      const top = caption === null ? CAPTION_FALLBACK_HEIGHT + 'px' : '0px'
      root.style.cssText = [
        'position:fixed;left:0;right:0;bottom:0;top:' + top + ';z-index:2147483000',
        'overflow:hidden;background:var(--dsw-alias-bg-base)',
      ].join(';')

      const style = document.createElement('style')
      style.textContent = CARRIER_CSS

      // A failed main-frame load leaves a blank window; say so instead of showing
      // nothing. Sub-resource failures stay silent (see did-fail-load below).
      const errorLayer = document.createElement('div')
      errorLayer.className = 'drg-carrier-error'
      errorLayer.setAttribute('data-testid', 'remote-overlay-error')
      errorLayer.textContent = typeof message === 'string' ? message : ''

      // A guest that covers the caption band takes the window drag away with it (Electron ignores app regions inside a
      // guest). This strip hands the empty part of the band back to the window; the guest's own fixed caption controls
      // sit left of it, and the shell's caption menus paint above the whole carrier.
      let grip = null
      if (caption !== null) {
        grip = document.createElement('div')
        grip.className = 'drg-carrier-grip'
        grip.setAttribute('data-testid', 'remote-overlay-grip')
        grip.style.cssText =
          'position:absolute;left:' +
          CAPTION_GRIP_LEFT +
          'px;right:0;top:0;height:' +
          caption.height +
          'px;z-index:1;-webkit-app-region:drag'
      }

      const view = document.createElement('webview')
      view.className = 'drg-carrier-view'
      view.setAttribute('name', String(reservation.lease))
      view.setAttribute('partition', String(reservation.partition))
      view.setAttribute('allowpopups', '')
      view.setAttribute('src', 'about:blank#' + String(reservation.lease))

      // Built before any listener is attached: the handlers below read it, and a guest that fired an event while the
      // element was being appended would otherwise read a binding that is still in its temporal dead zone.
      const entry = {
        hostId,
        lease: String(reservation.lease),
        root,
        view,
        grip,
        caption,
        /** Set once the guest page carries the desktop marker (never in a band-less window). */
        captionApplied: false,
        url,
        rowInstalled: false,
        failed: false,
        timer: null,
      }

      // `dom-ready` fires once per committed navigation, so navigating from it
      // unconditionally would reload the remote page forever (visible as flicker).
      let navigated = false
      view.addEventListener('dom-ready', () => {
        if (entry.view !== view || navigated) return
        navigated = true
        view.loadURL(entry.url).catch(() => {})
      })
      // Every committed navigation starts from a fresh document, which drops the injected
      // caption marker: re-apply it before the page can paint the Web grid.
      view.addEventListener('dom-ready', () => {
        if (entry.view !== view) return
        applyGuestCaption(entry).then((applied) => {
          if (entry.view !== view) return
          syncCarrierCaption(entry, applied)
        })
      })
      view.addEventListener('did-stop-loading', () => {
        if (entry.view !== view) return
        errorLayer.style.display = 'none'
        entry.failed = false
        // Re-install after *every* load stop: the remote page reloading wipes the injected DOM, and a one-shot install
        // would leave the window without any control. Both scripts are idempotent inside the page, and the caption has
        // to land before the row measures the sidebar it is placed into.
        applyGuestCaption(entry)
          .then((applied) => {
            if (entry.view !== view) return false
            syncCarrierCaption(entry, applied)
            return installHostRow(entry)
          })
          .then((live) => {
            if (entry.view !== view || !live) return
            if (carrierPool.current === entry.hostId) startHostRowPoll(entry)
          })
      })
      view.addEventListener('did-fail-load', (event) => {
        if (entry.view !== view) return
        // A main-frame failure leaves a blank window, so say so; sub-resource
        // failures (errorCode -3, aborted) are normal and must stay silent.
        const isMainFrame = !event || event.isMainFrame !== false
        const aborted = event && (event.errorCode === -3 || event.errorCode === undefined)
        if (!isMainFrame || aborted) return
        entry.failed = true
        errorLayer.style.display = 'flex'
        // The page cannot paint its own frame, so it must not own the caption band either:
        // hand the band back to the local page (its menus stay reachable while the failure
        // line is up) and the next successful load takes it again.
        syncCarrierCaption(entry, false)
      })

      root.append(style, view, errorLayer)
      if (grip !== null) root.append(grip)
      document.body.appendChild(root)

      return entry
    }

    /**
     * Show one host's window, warming it on first visit. Creation is async (the bridge hands out a
     * lease), so `carrierPool.wanted` makes the last request win: a superseded creation is dropped.
     */
    async function showOverlay(options) {
      const hostId = typeof options.hostId === 'string' ? options.hostId : ''
      carrierPool.wanted = hostId
      return whenCarrierIdle(() => showOverlayNow(hostId, options))
    }

    async function showOverlayNow(hostId, options) {
      const url = typeof options.url === 'string' ? options.url : ''
      let entry = carrierOf(hostId)
      const reused = entry !== null
      if (entry === null) {
        if (!isValidLoopbackUrl(url)) return { ok: false, reason: 'bad-url' }
        entry = await createCarrier(hostId, url, options.message)
        if (entry === null) return { ok: false, reason: 'acquire-failed' }
        // The user moved on (another host, or back to local) while this one was being
        // built: drop it instead of stealing the window.
        if (carrierPool.wanted !== hostId) {
          await disposeCarrier(entry)
          return { ok: false, reason: 'superseded' }
        }
      } else if (url !== '' && entry.url !== url && isValidLoopbackUrl(url)) {
        // A reconnect hands out a new one-shot URL: the warm page is stale, reload it.
        entry.url = url
        try {
          await entry.view.loadURL(url)
        } catch (_error) {
          // the guest reports navigation failures through did-fail-load
        }
      }
      // A window whose page failed to load is not worth showing as-is: retry it once.
      if (reused && entry.failed === true) {
        entry.failed = false
        try {
          entry.view.reload()
        } catch (_error) {
          // the guest may already be gone
        }
      }
      for (const other of carrierPool.entries) {
        if (other === entry) continue
        other.root.style.display = 'none'
      }
      carrierPool.entries = [entry, ...carrierPool.entries.filter((item) => item !== entry)]
      carrierPool.current = hostId
      entry.root.style.display = ''
      // The band belongs to this guest now: keep the shell's caption menus above it, but
      // only when the guest actually reserved the band (otherwise the local band is intact).
      setCaptionLive(entry.captionApplied === true)
      updateSwitcher({ current: hostId })
      if (entry.rowInstalled === true) {
        pushGuestHostRow(switcherPayload())
        startHostRowPoll(entry)
      }
      return { ok: true, reused }
    }

    function hideOverlays() {
      carrierPool.wanted = null
      if (carrierPool.current === null) return
      stopHostRowPoll()
      for (const entry of carrierPool.entries) entry.root.style.display = 'none'
      carrierPool.current = null
      // The local band is back: its menus belong to the page again, not above a guest.
      setCaptionLive(false)
    }

    /** Tear one guest down: row, DOM, renderer, lease. Safe for one that never entered the pool. */
    async function disposeCarrier(entry) {
      if (entry === null || entry === undefined) return
      if (carrierPool.poll === entry) stopHostRowPoll()
      carrierPool.entries = carrierPool.entries.filter((item) => item !== entry)
      // The guest that filled the window is going away, so the local page is next: the row has to follow here as well.
      // The React state that asked for the teardown is not enough - a disconnect arrives through a subscription created
      // at mount, whose closure holds the target from that render, so it cannot clear it.
      const wasShown = carrierPool.current === entry.hostId
      if (wasShown) {
        carrierPool.current = null
        setCaptionLive(false)
      }
      if (entry.view !== null && entry.rowInstalled === true) {
        try {
          entry.view.executeJavaScript('window.__drgHostRow && window.__drgHostRow.destroy()')
        } catch (_error) {
          // the guest may already be gone
        }
      }
      if (entry.root.parentNode !== null) entry.root.parentNode.removeChild(entry.root)
      if (wasShown) updateSwitcher({ current: 'local' })
      const bridge = desktopBrowserBridge()
      if (bridge !== null && entry.lease !== null) {
        try {
          await bridge.release(entry.lease)
        } catch (_error) {
          // a lease the shell already dropped is a no-op
        }
      }
    }

    async function closeCarrier(hostId) {
      const entry = carrierOf(hostId)
      if (entry === null) return
      await disposeCarrier(entry)
    }

    async function closeOverlay() {
      stopHostRowPoll()
      const hosts = carrierPool.entries.map((entry) => entry.hostId)
      carrierPool.current = null
      setCaptionLive(false)
      if (captionStateWatcher !== null) {
        captionStateWatcher.disconnect()
        captionStateWatcher = null
      }
      for (const hostId of hosts) await closeCarrier(hostId)
    }

    //#region 9c. key-file picker

    function KeyFilePicker(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const [listing, setListing] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)

      const load = useCallback((dir) => {
        let cancelled = false
        setLoading(true)
        setError(null)
        api.listKeyFiles(dir).then(
          (payload) => {
            if (cancelled) return
            setListing(payload)
            setLoading(false)
          },
          (failure) => {
            if (cancelled) return
            setError(toErrorView(failure))
            setLoading(false)
          },
        )
        return () => {
          cancelled = true
        }
      }, [])

      useEffect(() => load(props.initialDir || ''), [props.initialDir])

      const entries = listing && Array.isArray(listing.entries) ? listing.entries : []
      // Directories first, then files; both rows are one button with a kind.
      const sorted = [
        ...entries.filter((entry) => entry && entry.isDirectory),
        ...entries.filter((entry) => entry && !entry.isDirectory),
      ]

      let body
      if (loading) {
        body = box('p', 'drg-field-hint', t('keyFile.loading'))
      } else if (error) {
        body = h(ErrorCard, {
          t,
          locale,
          error,
          onRetry: () => load(listing ? listing.path : props.initialDir || ''),
        })
      } else if (entries.length === 0) {
        body = box('p', 'drg-field-hint', t('keyFile.empty'))
      } else {
        body = h(
          'div',
          { className: 'drg-keyfile-list', 'data-testid': 'keyfile-list' },
          sorted.map((entry) =>
            h(
              'button',
              {
                key: entry.path,
                type: 'button',
                className: 'drg-keyfile-row',
                'data-kind': entry.isDirectory ? 'directory' : 'file',
                title: entry.isDirectory ? undefined : entry.path,
                onClick: () => (entry.isDirectory ? load(entry.path) : props.onPick(entry.path)),
              },
              box('span', 'drg-keyfile-name', entry.isDirectory ? entry.name + '/' : entry.name),
            ),
          ),
        )
      }

      return h(
        Modal,
        {
          title: t('keyFile.title'),
          onClose: props.onClose,
          closeLabel: t('cancel'),
          testId: 'keyfile-picker',
          footer: h(
            Button,
            {
              variant: 'ghost',
              onClick: () => (listing && listing.parent ? load(listing.parent) : undefined),
              disabled: !listing || !listing.parent,
              testId: 'keyfile-parent',
            },
            t('keyFile.parent'),
          ),
        },
        box('p', 'drg-field-hint', t('keyFile.hint')),
        listing ? box('p', 'drg-keyfile-path', listing.path) : null,
        body,
      )
    }

    //#region 10. connect wizard

    function toInt(value, fallback) {
      const number =
        typeof value === 'number' ? value : Number(String(value === undefined || value === null ? '' : value).trim())
      return Number.isFinite(number) && Number.isInteger(number) ? number : fallback
    }

    function parseMaskedAddress(masked) {
      const text = String(masked || '')
      const result = { username: '', port: null }
      const at = text.lastIndexOf('@')
      if (at >= 0) result.username = text.slice(0, at)
      const tail = at >= 0 ? text.slice(at + 1) : text
      const match = tail.match(/:(\d+)\s*$/)
      if (match) result.port = Number(match[1])
      return result
    }

    function buildHostInput(draft, hostId, includeAuth) {
      const host = {
        name: String(draft.name || '').trim(),
        address: String(draft.address || '').trim(),
        port: toInt(draft.port, 22),
        username: String(draft.username || '').trim(),
        keepAlive: draft.keepAlive === 'stop' || draft.keepAlive === 'idle' ? draft.keepAlive : 'keep',
        idleMinutes: toInt(draft.idleMinutes, 15),
        autoReconnect: draft.autoReconnect !== false,
        hostKeyPolicy: draft.hostKeyPolicy === 'strict' ? 'strict' : 'first-use',
      }
      // Contract: an explicit empty string clears the jump host; an omitted field keeps the existing value on update.
      // Send it only when the HostView exposed it (edit) or when adding a host.
      const jumpHost = String(draft.jumpHost || '').trim()
      if (!hostId || draft.jumpHostKnown !== false) host.jumpHost = jumpHost
      if (hostId) host.id = hostId
      if (includeAuth) {
        // Key files and one-time passwords are the only accepted methods; anything
        // else (a stale draft carrying the retired "agent" choice) falls back to a key.
        if (draft.authType === 'password') {
          host.auth = { type: 'password' }
        } else {
          host.auth = { type: 'key', keyPath: String(draft.keyPath || '').trim() }
        }
      }
      return host
    }

    function validateHostDraft(draft) {
      if (!String(draft.name || '').trim()) return 'wizard.validationName'
      const address = String(draft.address || '').trim()
      if (!address) return 'wizard.validationAddress'
      if (looksLikeWebAddress(address)) return 'wizard.validationAddressUrl'
      const port = toInt(draft.port, NaN)
      if (!Number.isFinite(port) || port < 1 || port > 65535) return 'wizard.validationPort'
      if (draft.authType === 'key' && !String(draft.keyPath || '').trim()) return 'wizard.validationKeyPath'
      return null
    }

    function initialDraft(mode, host, settings) {
      const defaults = settings && typeof settings === 'object' ? settings : {}
      const auto = defaults.autoReconnect && typeof defaults.autoReconnect === 'object' ? defaults.autoReconnect : {}
      if (mode === 'edit' && host) {
        // Fill what the HostView exposes; username/port are parsed from the
        // masked address so saving an edit does not clobber them with defaults.
        const parsed = parseMaskedAddress(host.addressMasked)
        return {
          name: host.name || '',
          address: host.address || '',
          port: parsed.port === null ? defaults.defaultPort || 22 : parsed.port,
          username: parsed.username,
          jumpHost: typeof host.jumpHost === 'string' ? host.jumpHost : '',
          jumpHostKnown: typeof host.jumpHost === 'string',
          authType: typeof host.authType === 'string' ? host.authType : defaults.defaultAuth || 'key',
          // Empty means keep the stored path on the Host side.
          keyPath: '',
          keepAlive: host.keepAlive || 'keep',
          idleMinutes: host.idleMinutes || 15,
          autoReconnect: host.autoReconnect !== false,
          hostKeyPolicy: host.hostKeyPolicy || defaults.hostKeyPolicy || 'first-use',
        }
      }
      return {
        name: '',
        address: '',
        port: defaults.defaultPort || 22,
        username: '',
        jumpHost: '',
        jumpHostKnown: true,
        authType: defaults.defaultAuth || 'key',
        keyPath: defaults.defaultKeyPath || '~/.ssh/id_ed25519',
        keepAlive: 'keep',
        idleMinutes: 15,
        autoReconnect: auto.enabled !== false,
        hostKeyPolicy: defaults.hostKeyPolicy || 'first-use',
      }
    }

    function WizardDialog(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const mode = props.mode === 'edit' ? 'edit' : 'add'
      const initialHost = props.initialHost || null
      const [draft, setDraft] = useState(() =>
        initialDraft(mode, initialHost, props.state && props.state.settings ? props.state.settings : null),
      )
      const [password, setPassword] = useState('')
      const [authDirty, setAuthDirty] = useState(mode === 'add')
      const [nameTouched, setNameTouched] = useState(mode === 'edit')
      const hostId = initialHost && typeof initialHost.id === 'string' ? initialHost.id : ''
      const [saving, setSaving] = useState(null)
      const [formError, setFormError] = useState(null)
      const [aliases, setAliases] = useState([])
      const [knownHosts, setKnownHosts] = useState(null)
      const [aliasesLoading, setAliasesLoading] = useState(false)
      // Key-file picker overlay (browsing lives in the Host; this is only dialog state).
      const [keyPicker, setKeyPicker] = useState(false)

      const onRefresh = typeof props.onRefresh === 'function' ? props.onRefresh : () => {}

      // Load SSH config aliases once, for the address datalist.
      useEffect(() => {
        let cancelled = false
        setAliasesLoading(true)
        api.getAliases().then(
          (result) => {
            if (cancelled) return
            setAliases(Array.isArray(result.aliases) ? result.aliases : [])
            setKnownHosts(result.knownHosts || null)
            setAliasesLoading(false)
          },
          () => {
            if (!cancelled) setAliasesLoading(false)
          },
        )
        return () => {
          cancelled = true
        }
      }, [])

      const patchDraft = (patch) => setDraft((current) => ({ ...current, ...patch }))
      const row = (spec) => formRow(t, draft, patchDraft, spec)

      const onAddressChange = (value) => {
        patchDraft({ address: value })
        if (!nameTouched && mode === 'add') patchDraft({ name: value.trim() })
        const match = aliases.find((alias) => alias && alias.alias === value.trim())
        if (match) {
          patchDraft({
            address: match.alias,
            username: match.user || draft.username,
            port: match.port || draft.port,
          })
          if (!nameTouched && mode === 'add') patchDraft({ name: match.alias })
        }
      }
      const pickAlias = (alias) => {
        if (!alias) return
        patchDraft({
          address: alias.alias || alias.host || '',
          username: alias.user || draft.username,
          port: alias.port || draft.port,
        })
        if (!nameTouched && mode === 'add') patchDraft({ name: alias.alias || alias.host || '' })
      }

      const submit = async (intent) => {
        const invalid = validateHostDraft(draft)
        if (invalid !== null) {
          setFormError(invalid)
          return
        }
        if (draft.authType === 'password' && String(password).trim() === '') {
          setFormError('wizard.validationPassword')
          return
        }
        setFormError(null)
        setSaving(intent)
        try {
          const includeAuth = mode === 'add' || authDirty
          const saved = await api.saveHost(buildHostInput(draft, hostId || undefined, includeAuth))
          const id = saved && typeof saved.id === 'string' ? saved.id : hostId
          onRefresh()
          if (intent === 'connect' && id) {
            // The password typed here belongs to this one connection; the overlay starts it
            // with that value, so the user is not asked for it a second time.
            const oneTime = draft.authType === 'password' && String(password).trim() !== '' ? password : null
            if (typeof props.onConnect === 'function') props.onConnect(saved && saved.id ? saved : { id }, oneTime)
            return
          }
          if (typeof props.onSaved === 'function') props.onSaved(saved)
          props.onClose()
        } catch (error) {
          setSaving(null)
          setFormError(toErrorView(error))
        }
      }

      const handleCancel = () => {
        props.onClose()
      }

      const saveButton = h(
        Button,
        {
          variant: mode === 'add' ? 'secondary' : 'primary',
          testId: 'wizard-save',
          busy: saving === 'save',
          disabled: saving === 'connect',
          onClick: () => submit('save'),
        },
        saving === 'save' ? t('wizard.savingHost') : t('save'),
      )
      // Connecting from the dialog is an add-mode action: saving an edit only changes the
      // entry, and the host list is where a connection is (re)started.
      const connectButton =
        mode === 'add'
          ? h(
              Button,
              {
                variant: 'primary',
                testId: 'wizard-connect',
                busy: saving === 'connect',
                disabled: saving === 'save',
                onClick: () => submit('connect'),
              },
              saving === 'connect' ? t('wizard.savingHost') : t('connect'),
            )
          : null
      const footer = box('div', 'drg-row drg-row-end', saveButton, connectButton)
      const addressOptions = aliases.filter((alias) => alias && typeof alias.alias === 'string')
      const body = box(
        'div',
        'drg-wizard-form',
        formError
          ? h(
              Notice,
              { tone: 'error' },
              typeof formError === 'string' ? t(formError) : resolveText(toErrorView(formError).detail, locale),
            )
          : null,
        box(
          'div',
          'drg-form-grid',
          row({
            key: 'name',
            label: 'wizard.name',
            placeholder: 'wizard.namePlaceholder',
            testId: 'wizard-name',
            after: () => setNameTouched(true),
          }),
          h(Field, { label: t('wizard.address'), hint: t('wizard.addressHint') }, [
            h(TextInput, {
              key: 'address',
              value: draft.address,
              placeholder: t('wizard.addressPlaceholder'),
              ariaLabel: t('wizard.address'),
              list: 'drg-ssh-alias-list',
              testId: 'wizard-address',
              onChange: onAddressChange,
            }),
            h(
              'datalist',
              { key: 'aliases', id: 'drg-ssh-alias-list' },
              addressOptions.map((alias) => h('option', { key: alias.alias, value: alias.alias }, alias.host || '')),
            ),
          ]),
        ),
        addressOptions.length > 0
          ? box(
              'div',
              'drg-alias-row',
              box('span', 'drg-alias-label', t('wizard.aliases')),
              addressOptions.map((alias) =>
                h(
                  'button',
                  {
                    key: alias.alias,
                    type: 'button',
                    className: 'drg-chip',
                    title: [alias.user, alias.host, alias.port].filter(Boolean).join(' '),
                    onClick: () => pickAlias(alias),
                  },
                  alias.alias,
                ),
              ),
              knownHosts && knownHosts.entries
                ? box('span', 'drg-alias-known', t('wizard.knownHosts', { count: knownHosts.entries }))
                : null,
            )
          : aliasesLoading
            ? box('p', 'drg-field-hint', t('wizard.aliasesLoading'))
            : box('p', 'drg-field-hint', t('wizard.aliasesEmpty')),
        box(
          'div',
          'drg-form-grid drg-form-grid-3',
          row({ key: 'port', kind: 'number', label: 'wizard.port', testId: 'wizard-port' }),
          row({
            key: 'username',
            label: 'wizard.username',
            placeholder: 'wizard.usernamePlaceholder',
            testId: 'wizard-username',
          }),
          row({
            key: 'jumpHost',
            label: 'wizard.jumpHost',
            placeholder: 'wizard.jumpHostPlaceholder',
            testId: 'wizard-jump-host',
          }),
        ),
        row({
          key: 'authType',
          label: 'wizard.auth',
          hint: 'wizard.authHint',
          testId: 'wizard-auth',
          after: () => setAuthDirty(true),
          options: [
            ['key', 'wizard.authKey'],
            ['password', 'wizard.authPassword'],
          ],
        }),
        draft.authType === 'key'
          ? h(
              Field,
              { label: t('wizard.keyPath') },
              box(
                'div',
                'drg-field-inline',
                h(TextInput, {
                  value: draft.keyPath,
                  placeholder: t('wizard.keyPathPlaceholder'),
                  ariaLabel: t('wizard.keyPath'),
                  testId: 'wizard-key-path',
                  onChange: (value) => {
                    setAuthDirty(true)
                    patchDraft({ keyPath: value })
                  },
                }),
                h(
                  Button,
                  {
                    variant: 'secondary',
                    testId: 'wizard-key-path-pick',
                    onClick: () => setKeyPicker(true),
                  },
                  t('wizard.keyPathPick'),
                ),
              ),
            )
          : null,
        draft.authType === 'password'
          ? h(
              Field,
              { label: t('wizard.password'), hint: t('wizard.passwordPlaceholder') },
              h(TextInput, {
                type: 'password',
                value: password,
                placeholder: t('wizard.passwordPlaceholder'),
                ariaLabel: t('wizard.password'),
                testId: 'wizard-password',
                onChange: (value) => {
                  setAuthDirty(true)
                  setPassword(value)
                },
              }),
            )
          : null,
        box(
          'div',
          'drg-form-grid drg-form-grid-3',
          row({
            key: 'keepAlive',
            label: 'wizard.keepAlive',
            testId: 'wizard-keep-alive',
            options: [
              ['keep', 'wizard.keepAliveKeep'],
              ['stop', 'wizard.keepAliveStop'],
              ['idle', 'wizard.keepAliveIdle'],
            ],
          }),
          draft.keepAlive === 'idle'
            ? row({ key: 'idleMinutes', kind: 'number', label: 'wizard.idleMinutes', testId: 'wizard-idle-minutes' })
            : null,
          h(
            Field,
            { label: t('settings.hostKeyPolicy') },
            h(Select, {
              value: draft.hostKeyPolicy,
              ariaLabel: t('settings.hostKeyPolicy'),
              testId: 'wizard-host-key-policy',
              options: [
                { value: 'first-use', label: t('settings.hostKeyPolicyFirstUse') },
                { value: 'strict', label: t('settings.hostKeyPolicyStrict') },
              ],
              onChange: (value) => patchDraft({ hostKeyPolicy: value }),
            }),
          ),
        ),
        h(CheckRow, {
          checked: draft.autoReconnect !== false,
          label: t('wizard.autoReconnect'),
          testId: 'wizard-auto-reconnect',
          onChange: (checked) => patchDraft({ autoReconnect: checked }),
        }),
        box('p', 'drg-field-hint', t('wizard.actionHint')),
        !isLoopbackAddress(draft.address) ? box('p', 'drg-field-hint', t('loopbackNote')) : null,
      )

      return h(
        React.Fragment,
        null,
        h(
          Modal,
          {
            title: mode === 'edit' ? t('editHostTitle') : t('addHostTitle'),
            onClose: handleCancel,
            closeLabel: t('close'),
            wide: true,
            testId: 'host-wizard',
            footer,
          },
          h('div', { className: 'drg-wizard-body', 'data-testid': 'wizard-form' }, body),
        ),
        keyPicker
          ? h(KeyFilePicker, {
              t,
              locale,
              initialDir: '',
              onPick: (pickedPath) => {
                setKeyPicker(false)
                setAuthDirty(true)
                patchDraft({ keyPath: pickedPath })
              },
              onClose: () => setKeyPicker(false),
            })
          : null,
      )
    }

    //#region 11. diagnostics drawer

    /** Sort diagnostic checks into the contract's fixed order, unknown ids last. */
    function sortDiagnoseChecks(checks) {
      const list = Array.isArray(checks) ? checks.slice() : []
      const rank = (check) => {
        const index = DIAGNOSE_IDS.indexOf(check && check.id)
        return index < 0 ? DIAGNOSE_IDS.length : index
      }
      return list.sort((a, b) => rank(a) - rank(b))
    }

    function checkStatusLabel(t, status) {
      if (status === 'pass') return t('diag.checkPass')
      if (status === 'fail') return t('diag.checkFail')
      return t('diag.checkUnknown')
    }

    /**
     * Plain-text diagnostic report for the clipboard. Redacted by contract;
     * never includes a token or remote URL.
     */
    function formatDiagnoseText(report, host, t, locale) {
      const lines = ['dsh-remote-go · ' + t('diag.title')]
      const target = host || {}
      const address = displayAddress(target)
      lines.push(t('diag.host') + ': ' + (target.name || target.id || '') + (address ? ' (' + address + ')' : ''))
      if (report && typeof report.summary === 'string') lines.push('summary: ' + report.summary)
      if (report && typeof report.generatedAt === 'string')
        lines.push(t('diag.generatedAt') + ': ' + report.generatedAt)
      lines.push('')
      const checks = sortDiagnoseChecks(report && report.checks)
      for (const check of checks) {
        const title = resolveText(check.title, locale) || String(check.id || '')
        const detail = resolveText(check.detail, locale)
        lines.push(
          '[' + String(check.status || 'unknown').toUpperCase() + '] ' + title + (detail ? ' — ' + detail : ''),
        )
      }
      lines.push('')
      lines.push(t('diag.redacted'))
      return lines.join('\n')
    }

    function DiagnoseDrawer(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const host = props.host || null
      const status = props.status || 'loading'
      const report = props.report || null
      const [copied, setCopied] = useState(false)

      useEffect(() => {
        if (typeof props.onClose !== 'function' || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [props.onClose])

      const handleCopy = async () => {
        const text = report
          ? formatDiagnoseText(report, host, t, locale)
          : [t('diag.failed'), resolveText(toErrorView(props.error).detail, locale)].join('\n')
        const ok = await copyText(text)
        setCopied(ok === true)
      }

      const summaryTone =
        report && report.summary === 'error' ? 'error' : report && report.summary === 'warning' ? 'warn' : 'success'
      const summaryText =
        report && report.summary === 'error'
          ? t('diag.summaryError')
          : report && report.summary === 'warning'
            ? t('diag.summaryWarning')
            : t('diag.summaryOk')

      let content
      if (status === 'loading') {
        content = box('div', 'drg-loading', h(Spinner, { size: 20 }), h('span', null, t('diag.running')))
      } else if (status === 'error') {
        content = h(ErrorCard, {
          t,
          locale,
          error: props.error,
          onRetry: props.onRun,
        })
      } else if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
        content = box('p', 'drg-paragraph', t('diag.empty'))
      } else {
        content = box(
          'div',
          'drg-diag',
          box(
            'div',
            'drg-diag-head',
            h(Badge, { tone: summaryTone }, summaryText),
            report.generatedAt
              ? box('span', 'drg-diag-time', t('diag.generatedAt') + ' ' + formatTime(report.generatedAt, locale))
              : null,
          ),
          box(
            'ul',
            'drg-diag-list',
            sortDiagnoseChecks(report.checks).map((check, index) =>
              h(
                'li',
                { key: String(check.id || index), className: 'drg-diag-check', 'data-status': check.status },
                h(
                  'span',
                  { className: 'drg-diag-status', 'data-status': check.status },
                  checkStatusLabel(t, check.status),
                ),
                box(
                  'div',
                  'drg-diag-check-body',
                  box('div', 'drg-diag-check-title', resolveText(check.title, locale) || String(check.id || '')),
                  resolveText(check.detail, locale)
                    ? box('div', 'drg-diag-check-detail', resolveText(check.detail, locale))
                    : null,
                ),
              ),
            ),
          ),
          box('p', 'drg-field-hint', t('diag.redacted')),
          copied ? h(Notice, { tone: 'success' }, t('diag.copyDone')) : null,
        )
      }

      return box(
        'div',
        'drg-drawer-layer',
        h('div', { className: 'drg-drawer-backdrop', onClick: props.onClose, 'aria-hidden': 'true' }),
        h(
          'aside',
          {
            className: 'drg-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('diag.title'),
            'data-testid': 'diagnostics',
          },
          box(
            'div',
            'drg-drawer-head',
            h(
              'div',
              null,
              box('h2', 'drg-drawer-title', t('diag.title')),
              host
                ? box(
                    'p',
                    'drg-drawer-subtitle',
                    (host.name || host.id) + (displayAddress(host) ? ' · ' + displayAddress(host) : ''),
                  )
                : null,
            ),
            h(IconButton, { icon: h(IconClose), label: t('diag.close'), onClick: props.onClose }),
          ),
          box('div', 'drg-drawer-body', content),
          box(
            'div',
            'drg-drawer-foot',
            h(
              Button,
              { variant: 'secondary', testId: 'diagnose-rerun', busy: status === 'loading', onClick: props.onRun },
              t('diag.rerun'),
            ),
            h(
              Button,
              { variant: 'primary', testId: 'diagnose-copy', onClick: handleCopy },
              copied ? t('copied') : t('diag.copy'),
            ),
          ),
        ),
      )
    }

    //#region 12. settings modal

    function settingsPatchFromDraft(draft) {
      return {
        defaultPort: toInt(draft.defaultPort, 22),
        defaultAuth: draft.defaultAuth === 'password' ? 'password' : 'key',
        defaultKeyPath: String(draft.defaultKeyPath || '').trim(),
        connectTimeoutSec: Math.max(1, toInt(draft.connectTimeoutSec, 30)),
        autoReconnect: {
          enabled: draft.autoReconnectEnabled === true,
          maxAttempts: Math.max(0, toInt(draft.maxAttempts, 3)),
          baseDelayMs: Math.max(0, toInt(draft.baseDelayMs, 1000)),
        },
        hostKeyPolicy: draft.hostKeyPolicy === 'strict' ? 'strict' : 'first-use',
        saveTokens: draft.saveTokens === true,
        language: draft.language === 'zh' || draft.language === 'en' ? draft.language : 'auto',
        logLevel: ['error', 'warn', 'info', 'debug'].indexOf(draft.logLevel) >= 0 ? draft.logLevel : 'info',
        bootstrap: {
          profile: String(draft.profile || 'web').trim() || 'web',
        },
      }
    }

    function settingsDraft(settings) {
      const view = settings && typeof settings === 'object' ? settings : {}
      const auto = view.autoReconnect && typeof view.autoReconnect === 'object' ? view.autoReconnect : {}
      const bootstrap = view.bootstrap && typeof view.bootstrap === 'object' ? view.bootstrap : {}
      return {
        defaultPort: view.defaultPort === undefined ? 22 : view.defaultPort,
        defaultAuth: view.defaultAuth === 'password' ? 'password' : 'key',
        defaultKeyPath: view.defaultKeyPath || '~/.ssh/id_ed25519',
        connectTimeoutSec: view.connectTimeoutSec === undefined ? 30 : view.connectTimeoutSec,
        autoReconnectEnabled: auto.enabled !== false,
        maxAttempts: auto.maxAttempts === undefined ? 3 : auto.maxAttempts,
        baseDelayMs: auto.baseDelayMs === undefined ? 1000 : auto.baseDelayMs,
        hostKeyPolicy: view.hostKeyPolicy || 'first-use',
        saveTokens: view.saveTokens === true,
        language: view.language || 'auto',
        logLevel: view.logLevel || 'info',
        profile: bootstrap.profile || 'web',
      }
    }

    /** Settings modal (contract SettingsView). */
    function SettingsModal(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const [draft, setDraft] = useState(() => settingsDraft(props.settings))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      // Key-file picker overlay for the default key path.
      const [keyPicker, setKeyPicker] = useState(false)
      const patch = (patchValue) => setDraft((current) => ({ ...current, ...patchValue }))
      const set = (field) => (value) => patch({ [field]: value })

      const fieldRow = (spec) => formRow(t, draft, patch, spec)

      const handleSave = async () => {
        setSaving(true)
        setError(null)
        try {
          if (typeof props.onSave === 'function') await props.onSave(settingsPatchFromDraft(draft))
          setSaving(false)
          if (typeof props.onClose === 'function') props.onClose()
        } catch (saveError) {
          setSaving(false)
          setError(toErrorView(saveError))
        }
      }

      const footer = footerRow(
        h(Button, { variant: 'ghost', onClick: props.onClose }, t('cancel')),
        h(
          Button,
          { variant: 'primary', testId: 'settings-save', busy: saving, onClick: handleSave },
          t('settings.saveSettings'),
        ),
      )

      return h(
        React.Fragment,
        null,
        h(
          Modal,
          {
            title: t('settings.title'),
            onClose: props.onClose,
            closeLabel: t('close'),
            wide: true,
            testId: 'settings',
            footer,
          },
          box(
            'div',
            'drg-settings',
            box(
              'section',
              'drg-settings-section',
              box('h3', 'drg-section-title', t('settings.ssh')),
              box(
                'div',
                'drg-form-grid drg-form-grid-3',
                [
                  { kind: 'number', key: 'defaultPort', label: 'settings.defaultPort' },
                  {
                    kind: 'select',
                    key: 'defaultAuth',
                    label: 'settings.defaultAuth',
                    options: [
                      ['key', 'settings.defaultAuthKey'],
                      ['password', 'settings.defaultAuthPassword'],
                    ],
                  },
                  { kind: 'number', key: 'connectTimeoutSec', label: 'settings.connectTimeout' },
                ].map(fieldRow),
                h(
                  Field,
                  { label: t('settings.defaultKeyPath'), hint: t('settings.defaultKeyPathHint'), wide: true },
                  box(
                    'div',
                    'drg-field-inline',
                    h(TextInput, {
                      value: draft.defaultKeyPath,
                      placeholder: t('wizard.keyPathPlaceholder'),
                      ariaLabel: t('settings.defaultKeyPath'),
                      testId: 'settings-default-key-path',
                      onChange: set('defaultKeyPath'),
                    }),
                    h(
                      Button,
                      {
                        variant: 'secondary',
                        testId: 'settings-default-key-path-pick',
                        onClick: () => setKeyPicker(true),
                      },
                      t('settings.keyPathPick'),
                    ),
                  ),
                ),
              ),
            ),
            box(
              'section',
              'drg-settings-section',
              box('h3', 'drg-section-title', t('settings.security')),
              h(
                Field,
                { label: t('settings.hostKeyPolicy') },
                h(Select, {
                  value: draft.hostKeyPolicy,
                  ariaLabel: t('settings.hostKeyPolicy'),
                  options: [
                    { value: 'first-use', label: t('settings.hostKeyPolicyFirstUse') },
                    { value: 'strict', label: t('settings.hostKeyPolicyStrict') },
                  ],
                  onChange: set('hostKeyPolicy'),
                }),
              ),
              h(CheckRow, {
                checked: draft.saveTokens === true,
                label: t('settings.saveTokens'),
                onChange: set('saveTokens'),
              }),
              box('p', 'drg-field-hint', t('settings.saveTokensHint')),
              draft.saveTokens === true ? h(Notice, { tone: 'warn', title: t('settings.saveTokensRisk') }) : null,
              h('div', { className: 'drg-divider' }),
              box('h3', 'drg-section-title', t('settings.reconnect')),
              h(CheckRow, {
                checked: draft.autoReconnectEnabled === true,
                label: t('settings.reconnectEnabled'),
                onChange: set('autoReconnectEnabled'),
              }),
              box(
                'div',
                'drg-form-grid',
                [
                  { kind: 'number', key: 'maxAttempts', label: 'settings.maxAttempts' },
                  { kind: 'number', key: 'baseDelayMs', label: 'settings.baseDelay' },
                ].map(fieldRow),
              ),
            ),
            box(
              'section',
              'drg-settings-section',
              box('h3', 'drg-section-title', t('settings.bootstrap')),
              box('p', 'drg-field-hint', t('settings.bootstrapHint')),
              box(
                'div',
                'drg-form-grid',
                [{ kind: 'text', key: 'profile', label: 'settings.profile', hint: 'settings.profileHint' }].map(
                  fieldRow,
                ),
              ),
            ),
            box(
              'section',
              'drg-settings-section',
              box('h3', 'drg-section-title', t('settings.other')),
              box(
                'div',
                'drg-form-grid drg-form-grid-3',
                [
                  {
                    kind: 'select',
                    key: 'language',
                    label: 'settings.language',
                    options: [
                      ['auto', 'settings.languageAuto'],
                      ['zh', 'settings.languageZh'],
                      ['en', 'settings.languageEn'],
                    ],
                  },
                  {
                    kind: 'select',
                    key: 'logLevel',
                    label: 'settings.logLevel',
                    options: ['error', 'warn', 'info', 'debug'].map((level) => [level, level]),
                  },
                ].map(fieldRow),
              ),
            ),
            error ? h(Notice, { tone: 'error' }, resolveText(error.detail, locale)) : null,
          ),
        ),
        keyPicker
          ? h(KeyFilePicker, {
              t,
              locale,
              initialDir: '',
              onPick: (pickedPath) => {
                setKeyPicker(false)
                patch({ defaultKeyPath: pickedPath })
              },
              onClose: () => setKeyPicker(false),
            })
          : null,
      )
    }

    //#region 13. one-time password prompt

    function PasswordPrompt(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const [password, setPassword] = useState('')
      const [remember, setRemember] = useState(false)
      const [localError, setLocalError] = useState('')
      const canRemember = props.storageAvailable === true
      const submit = () => {
        if (String(password).trim() === '') {
          setLocalError(t('passwordPromptRequired'))
          return
        }
        setLocalError('')
        if (typeof props.onSubmit === 'function') props.onSubmit({ password, remember: canRemember && remember })
      }
      return h(
        Modal,
        {
          title: t('passwordPromptTitle'),
          onClose: props.onCancel,
          closeLabel: t('cancel'),
          testId: 'password-prompt',
          footer: footerRow(
            h(Button, { variant: 'ghost', onClick: props.onCancel }, t('cancel')),
            h(
              Button,
              { variant: 'primary', testId: 'password-submit', busy: props.busy === true, onClick: submit },
              t('passwordPromptSubmit'),
            ),
          ),
        },
        box('p', 'drg-paragraph', t('passwordPromptBody', { name: host.name || host.id || '' })),
        h(
          Field,
          {
            label: t('passwordPromptLabel'),
            error: localError || (typeof props.error === 'string' ? props.error : ''),
          },
          h(TextInput, {
            type: 'password',
            value: password,
            placeholder: t('wizard.passwordPlaceholder'),
            autoComplete: 'off',
            testId: 'password-input',
            ariaLabel: t('passwordPromptLabel'),
            onChange: (value) => {
              setPassword(value)
              if (localError !== '') setLocalError('')
            },
            onKeyDown: (event) => {
              if (event && event.key === 'Enter') submit()
            },
          }),
        ),
        canRemember
          ? h(
              'label',
              { className: 'drg-check', 'data-testid': 'password-remember' },
              h('input', {
                type: 'checkbox',
                checked: remember,
                onChange: (event) => setRemember(event.target.checked === true),
              }),
              h('span', null, t('passwordPromptRemember')),
            )
          : box('p', 'drg-field-hint', t('passwordPromptNoStorage')),
      )
    }

    /** The remote already runs a DSH this plugin did not start: the choices are explicit, the pipeline waits. */
    function RemoteConflictPrompt(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const conflict = host.conflict && typeof host.conflict === 'object' ? host.conflict : {}
      const processes = Array.isArray(conflict.processes) ? conflict.processes : []
      const busy = props.busy === true
      const resolve = (action) => {
        if (busy) return
        if (typeof props.onResolve === 'function') props.onResolve(host, action)
      }
      return h(
        Modal,
        {
          title: t('conflictTitle'),
          onClose: () => resolve('cancel'),
          closeLabel: t('cancel'),
          testId: 'remote-conflict-prompt',
          wide: true,
          footer: footerRow(
            h(
              Button,
              { variant: 'ghost', onClick: () => resolve('cancel'), disabled: busy, testId: 'conflict-cancel' },
              t('conflictCancel'),
            ),
            h(
              Button,
              { variant: 'danger', onClick: () => resolve('stop'), busy, testId: 'conflict-stop' },
              t('conflictStop'),
            ),
            h(
              Button,
              { variant: 'primary', onClick: () => resolve('alongside'), busy, testId: 'conflict-alongside' },
              t('conflictAlongside'),
            ),
          ),
        },
        box('p', 'drg-paragraph', t('conflictBody', { name: host.name || host.id || '', count: processes.length })),
        box(
          'ul',
          'drg-conflict-processes',
          processes.map((process) =>
            h(
              'li',
              { key: String(process.pid) },
              h('code', null, `pid ${process.pid}`),
              ' ',
              h('span', null, process.command || ''),
            ),
          ),
        ),
        box('p', 'drg-field-hint', t('conflictHint')),
        props.error ? h(Notice, { tone: 'error' }, props.error) : null,
        busy ? box('p', 'drg-field-hint', t('conflictBusy')) : null,
      )
    }

    //#region 14. toast

    function Toast(props) {
      if (!props || !props.toast) return null
      return h(
        'div',
        { className: 'drg-toast', 'data-tone': props.toast.tone || 'info', role: 'status' },
        props.toast.text,
      )
    }

    //#region 15. overlay host (floating windows + remote window)

    function useRemoteState(initialState) {
      const hasInitial = initialState !== undefined && initialState !== null
      const [state, setState] = useState(hasInitial ? initialState : null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(!hasInitial)
      const [mode, setMode] = useState('idle')
      const alive = useRef(true)
      const refresh = useCallback(() => {
        setLoading(true)
        return api.getState().then(
          (next) => {
            if (!alive.current) return
            setState(next)
            setError(null)
            setLoading(false)
          },
          (readError) => {
            if (!alive.current) return
            setError(toErrorView(readError))
            setLoading(false)
          },
        )
      }, [])
      useEffect(() => {
        alive.current = true
        const dispose = subscribeState({
          onState: (next) => {
            if (!alive.current) return
            setState(next)
            setError(null)
            setLoading(false)
          },
          onStatus: (nextMode) => {
            if (alive.current) setMode(nextMode)
          },
          onError: (readError) => {
            if (!alive.current) return
            setError(toErrorView(readError))
            setLoading(false)
          },
        })
        return () => {
          alive.current = false
          dispose()
        }
      }, [])
      const patch = useCallback((updater) => {
        setState((current) => (current === null ? current : updater(current)))
      }, [])
      return { state, error, loading, mode, refresh, patch }
    }

    function ManageWindow(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      if (props.open !== true) return null
      const host = props.host || null
      const connecting = props.view === 'connect' && host !== null && statusOf(host.status).window === true
      return h(
        'div',
        { className: 'drg-manage-window', 'data-testid': 'manage-window' },
        h(
          Modal,
          { wide: true, onClose: props.onClose, closeLabel: t('cancel') },
          connecting
            ? h(ConnectWindow, {
                t,
                locale,
                host,
                fingerprintBusy: props.fingerprintBusy === true,
                onAcceptFingerprint: (remember) => props.onAcceptFingerprint(host, remember),
                onRejectFingerprint: () => props.onRejectFingerprint(host),
                onRetry: () => props.onRetry(host),
                onDiagnose: () => props.onDiagnose(host),
                // Leaving a failure means going back to the list, inside the same window.
                onBack: typeof props.onShowList === 'function' ? props.onShowList : props.onClose,
              })
            : h(HostListView, {
                t,
                locale,
                state: props.state,
                loading: props.loading,
                error: props.error,
                busyHostId: props.busyHostId,
                onAdd: props.onAdd,
                onRefresh: props.onRefresh,
                onOpenSettings: props.onOpenSettings,
                onOpenHost: props.onOpenHost,
                onDisconnectHost: props.onDisconnectHost,
                onReconnectHost: props.onReconnectHost,
                onEditHost: props.onEditHost,
                onDeleteHost: props.onDeleteHost,
                onDiagnoseHost: props.onDiagnoseHost,
              }),
        ),
      )
    }

    /**
     * The overlay host: everything that is not the sidebar row. It sits above the remote window,
     * so opening or closing a dialog never changes what is behind it.
     */
    function PluginOverlay(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      // One `/state` feed for the whole plugin (docs/api.md): the row, the windows and the
      // remote window all read from it.
      const remote = useRemoteState(props.initialState)
      const state = remote.state
      const [target, setTarget] = useState(() => {
        const initial = props.initialState
        return initial && typeof initial.activeHostId === 'string' ? initial.activeHostId : null
      })
      const [manageOpen, setManageOpen] = useState(false)
      /** Which body the floating window shows. Separate from the host status: 管理界面 always brings the list back. */
      const [manageView, setManageView] = useState('list')
      // The loopback URL the guest loads (GET /hosts/:id/open); it carries the
      // one-shot launch token, so it is fetched on demand and never persisted.
      const [remoteUrl, setRemoteUrl] = useState(null)
      const [busyHostId, setBusyHostId] = useState(null)
      const [diagnose, setDiagnose] = useState(null)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [pendingDelete, setPendingDelete] = useState(null)
      const [deleting, setDeleting] = useState(false)
      const [passwordPrompt, setPasswordPrompt] = useState(null)
      const [conflictBusy, setConflictBusy] = useState(false)
      const [fingerprintBusy, setFingerprintBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [wizard, setWizard] = useState(() => {
        const store = props.wizardStore
        return store && typeof store.current === 'function' ? store.current() : null
      })
      const toastTimer = useRef(null)

      const notify = (text, tone) => {
        setToast({ text, tone: tone || 'info' })
        if (toastTimer.current !== null && typeof clearTimeout === 'function') clearTimeout(toastTimer.current)
        if (typeof setTimeout === 'function') toastTimer.current = setTimeout(() => setToast(null), 4200)
      }
      useEffect(
        () => () => {
          if (toastTimer.current !== null && typeof clearTimeout === 'function') clearTimeout(toastTimer.current)
        },
        [],
      )
      const errorMessage = (error) => {
        const viewOfError = toErrorView(error)
        const title = resolveText(viewOfError.title, locale)
        const detail = resolveText(viewOfError.detail, locale)
        return detail ? title + ' ' + detail : title
      }

      /**
       * One Host-API call with the window's choreography: the host goes busy, success refreshes
       * the state, a failure reaches the toast, and the flag clears either way.
       */
      const runAction = (host, work, done) => {
        if (!host || !host.id) return
        setBusyHostId(host.id)
        work()
          .then(
            (result) => {
              if (done) done(result)
              remote.refresh()
            },
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setBusyHostId(null))
      }

      const hosts = state && Array.isArray(state.hosts) ? state.hosts : []
      const conflictHost = hosts.find((host) => host && host.status === 'conflict-pending' && host.conflict) || null
      const activeHost = target ? hosts.find((host) => host && host.id === target) || null : null
      const activeStatus = activeHost ? activeHost.status : null
      const hostsRef = useRef(hosts)
      hostsRef.current = hosts
      // A host we asked for that still has to connect: the list stays up until it is ready.
      const pendingSwitch = useRef(null)
      const pendingIntent = useRef(null)
      // Host we already told the user cannot be shown here (no desktop window seat).
      const noWindowNotified = useRef(null)

      // A host removed elsewhere closes its window instead of leaving a blank frame.
      useEffect(() => {
        if (target === null || state === null) return
        if (!hosts.some((host) => host && host.id === target)) setTarget(null)
      }, [state, target])

      // The launch URL is bound to the host it was issued for: a URL for another host is
      // worth nothing (it is one-shot and host-specific), so it can never reach a window.
      useEffect(() => {
        if (activeStatus === 'connecting') setRemoteUrl(null)
      }, [activeStatus])

      // Fetch `GET /hosts/:id/open` only for a host that is up and not already warm: the
      // guest needs the launch-token URL once, and a warm window is shown without it.
      useEffect(() => {
        if (target === null || carrierWarm(target)) return undefined
        if (remoteUrl !== null && remoteUrl.hostId === target) return undefined
        if (activeStatus !== 'connected') return undefined
        let cancelled = false
        api.openHost(target).then(
          (url) => {
            if (!cancelled) setRemoteUrl({ hostId: target, url })
          },
          (error) => {
            if (cancelled) return
            notify(errorMessage(error), 'error')
          },
        )
        return () => {
          cancelled = true
        }
      }, [target, activeStatus, remoteUrl])

      // Where the window is. Guests stay warm: a warm one is shown again without any load,
      // which is what makes switching between remotes (and coming back from local) instant.
      useEffect(() => {
        if (target === null) {
          hideOverlays()
          return
        }
        if (activeStatus !== 'connected') {
          hideOverlays()
          return
        }
        if (carrierWarm(target)) {
          showOverlay({ hostId: target, message: t('viewportOverlayLoadFailed') })
          return
        }
        // The launch URL for *this* host is still being fetched: keep the current guest up
        // so switching does not flash the local UI behind it.
        if (remoteUrl === null || remoteUrl.hostId !== target) return
        const shown = showOverlay({ hostId: target, url: remoteUrl.url, message: t('viewportOverlayLoadFailed') })
        if (shown && typeof shown.then === 'function') {
          shown.then(
            (outcome) => {
              if (!outcome || outcome.ok !== false || outcome.reason !== 'acquire-failed') return
              if (noWindowNotified.current === target) return
              noWindowNotified.current = target
              notify(t('desktopRequired'), 'error')
            },
            () => {},
          )
        }
      }, [target, activeStatus, remoteUrl])

      // When the host we asked for comes up, the window switches and the connect window gets
      // out of the way; a failure left it up (with its error and the log) until it is closed.
      useEffect(() => {
        if (target === null || activeStatus !== 'connected' || pendingSwitch.current !== target) return
        pendingSwitch.current = null
        setManageView('list')
        setManageOpen(false)
      }, [target, activeStatus])

      // The row shows where the window is and which hosts are up; both live in `state`.
      useEffect(() => {
        updateSwitcher({ hosts })
      }, [state])
      useEffect(() => {
        updateSwitcher({ current: target === null ? 'local' : target })
      }, [target])

      // A host that is gone (or was closed) must not keep a hidden renderer alive.
      useEffect(() => {
        if (state === null) return
        for (const entry of carrierPool.entries.slice()) {
          const host = hosts.find((item) => item && item.id === entry.hostId) || null
          if (host !== null && (host.status === 'connected' || host.status === 'connecting')) continue
          closeCarrier(entry.hostId).catch(() => {})
        }
      }, [state])

      // While the plugin is loaded its windows stay warm; the plugin's own disposal (in `apply`) tears them down.
      useEffect(() => {
        return () => {
          hideOverlays()
        }
      }, [])

      // A failed connect drops the prompt too; the toast carries the reason.
      const performConnect = (host, password) =>
        runAction(
          host,
          () => api.connect(host.id, typeof password === 'string' ? { password } : {}),
          () => setPasswordPrompt(null),
        )

      /**
       * Start a connection, asking for the one-time password first when the
       * host uses password auth (contract: password never persisted).
       */
      const openHost = (host, options) => {
        if (!host) return
        const opts = options || {}
        const password = typeof opts.password === 'string' && opts.password !== '' ? opts.password : null
        const needsConnect = statusOf(host.status).connect === true
        const ready = host.status === 'connected'
        if (needsConnect && host.authType === 'password' && password === null) {
          pendingSwitch.current = host.id
          setManageView('connect')
          setManageOpen(true)
          setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
          return
        }
        pendingSwitch.current = ready ? null : host.id
        setManageView('connect')
        setManageOpen(!ready)
        setTarget(host.id)
        api.activate(host.id).catch(() => {})
        if (needsConnect) performConnect(host, password)
      }

      // The switcher and the Settings page name one target: open a host, leave one, show
      // host management, or hand the window back to the local page.
      const applyIntent = (intent) => {
        if (!intent || typeof intent !== 'object') return
        if (intent.kind === 'manage') {
          pendingIntent.current = null
          // The explicit entry always shows the list, even while a connection is running: the
          // connect window is what a host pick opens, not what 管理界面 means.
          setManageView('list')
          setManageOpen(true)
          remote.refresh()
          return
        }
        if (intent.kind === 'local') {
          pendingIntent.current = null
          setManageOpen(false)
          setTarget(null)
          // The Host side remembers which host fills the window; nothing does while local
          // content is up, so clear it instead of leaving a stale "current".
          api.clearActive().catch(() => {})
          return
        }
        const host = hostsRef.current.find((item) => item && item.id === intent.hostId) || null
        if (intent.kind === 'disconnect') {
          pendingIntent.current = null
          // Disconnecting hands the window back once the Host confirms (see `disconnectHost`): doing it here would show
          // the local page even if the disconnect then failed.
          if (host !== null) disconnectHost(host)
          return
        }
        if (host === null) {
          pendingIntent.current = intent
          return
        }
        pendingIntent.current = null
        openHost(host)
      }
      useEffect(() => {
        const store = props.panelStore
        if (!store || typeof store.take !== 'function' || typeof store.subscribe !== 'function') return undefined
        const consume = () => applyIntent(store.take())
        consume()
        return store.subscribe(consume)
      }, [props.panelStore])
      useEffect(() => {
        if (pendingIntent.current === null) return
        applyIntent(pendingIntent.current)
      }, [state])

      // The wizard is driven by its own store so it can be opened from anywhere.
      useEffect(() => {
        const store = props.wizardStore
        if (!store || typeof store.subscribe !== 'function') return undefined
        const sync = () => setWizard(typeof store.current === 'function' ? store.current() : null)
        sync()
        return store.subscribe(sync)
      }, [props.wizardStore])
      const closeWizard = () => {
        const store = props.wizardStore
        if (store && typeof store.close === 'function') store.close()
      }

      const submitPassword = (submitted) => {
        const pending = passwordPrompt
        if (!pending || !pending.host) return
        const value = submitted && typeof submitted.password === 'string' ? submitted.password : ''
        const remember = submitted && submitted.remember === true
        if (value.trim() === '') {
          setPasswordPrompt({ ...pending, error: t('passwordPromptRequired') })
          return
        }
        const host = pending.host
        const intent = pending.intent
        if (intent === 'open') {
          setManageView('connect')
          setManageOpen(true)
          setTarget(host.id)
        }
        if (intent === 'reconnect') setRemoteUrl(null)
        setPasswordPrompt({ ...pending, busy: true, error: null })
        setBusyHostId(host.id)
        const connect =
          intent === 'reconnect'
            ? api
                .disconnect(host.id, false)
                .catch(() => {})
                .then(() => api.connect(host.id, { password: value, rememberPassword: remember }))
            : api.connect(host.id, { password: value, rememberPassword: remember })
        connect
          .then(
            () => {
              setPasswordPrompt(null)
              remote.refresh()
            },
            (error) => {
              const message = errorMessage(error)
              setPasswordPrompt((current) => (current ? { ...current, busy: false, error: message } : current))
              notify(message, 'error')
            },
          )
          .finally(() => setBusyHostId(null))
      }
      const cancelPassword = () => {
        // The row moved to that host when it was picked; the switch was cancelled, so put
        // it back where the window actually is.
        pendingSwitch.current = null
        updateSwitcher({ current: target === null ? 'local' : target })
        setPasswordPrompt(null)
      }

      // The remote UI goes away with the connection: give its renderer back now, and hand the
      // window back if that is where it is pointing. The update is functional on purpose: this
      // callback runs from the long-lived intent subscription, whose closure still holds the
      // target it was created with, so a captured value would miss the host the window is on.
      const disconnectHost = (host) =>
        runAction(
          host,
          () => api.disconnect(host.id, false),
          () => {
            setTarget((current) => (current === host.id ? null : current))
            closeCarrier(host.id).catch(() => {})
          },
        )

      const reconnectHost = (host) => {
        if (!host) return
        if (host.authType === 'password') {
          setPasswordPrompt({ host, intent: 'reconnect', error: null, busy: false })
          return
        }
        setRemoteUrl(null)
        closeCarrier(host.id).catch(() => {})
        runAction(host, () => api.reconnect(host.id))
      }

      const resolveConflict = (host, action) => {
        if (!host || !host.id) return
        setConflictBusy(true)
        api
          .confirmConflict(host.id, action)
          .then(
            () => remote.refresh(),
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setConflictBusy(false))
      }

      const runDiagnose = (host) => {
        if (!host || !host.id) return
        setDiagnose({ host, status: 'loading', report: null, error: null })
        api.diagnose(host.id).then(
          (report) =>
            setDiagnose((current) =>
              current && current.host && current.host.id === host.id ? { ...current, status: 'done', report } : current,
            ),
          (error) =>
            setDiagnose((current) =>
              current && current.host && current.host.id === host.id
                ? { ...current, status: 'error', error: toErrorView(error) }
                : current,
            ),
        )
      }
      const rerunDiagnose = () => {
        if (diagnose && diagnose.host) runDiagnose(diagnose.host)
      }

      const confirmDeleteHost = () => {
        if (!pendingDelete) return
        setDeleting(true)
        const deletedId = pendingDelete.id
        api
          .deleteHost(deletedId)
          .then(
            () => {
              setPendingDelete(null)
              closeCarrier(deletedId).catch(() => {})
              if (target === deletedId) setTarget(null)
              remote.refresh()
            },
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setDeleting(false))
      }

      const saveSettings = async (patch) => {
        const saved = await api.saveSettings(patch)
        remote.patch((current) => ({ ...current, settings: saved }))
        notify(t('settings.saved'), 'success')
      }

      const answerFingerprint = (host, accept, remember) => {
        if (!host || !host.id) return
        const sha256 = host.fingerprint && typeof host.fingerprint.sha256 === 'string' ? host.fingerprint.sha256 : ''
        setFingerprintBusy(true)
        api.acceptFingerprint(host.id, accept === true, remember === true, sha256).then(
          () => {
            setFingerprintBusy(false)
            remote.refresh()
          },
          (error) => {
            setFingerprintBusy(false)
            notify(errorMessage(error), 'error')
          },
        )
      }

      const openWizard = (draft) => {
        if (props.wizardStore) props.wizardStore.open(draft)
      }

      return h(
        'div',
        { className: 'drg-root drg-overlay', 'data-testid': 'dsh-remote-go-overlay-host' },
        h(StyleSheet),
        h(ManageWindow, {
          open: manageOpen,
          view: manageView,
          t,
          locale,
          host: activeHost,
          state,
          loading: remote.loading,
          error: remote.error,
          busyHostId,
          fingerprintBusy,
          onClose: () => setManageOpen(false),
          onShowList: () => setManageView('list'),
          onAdd: () => openWizard({ mode: 'add', host: null }),
          onRefresh: remote.refresh,
          onOpenSettings: () => setSettingsOpen(true),
          onOpenHost: openHost,
          onDisconnectHost: disconnectHost,
          onReconnectHost: reconnectHost,
          onEditHost: (host) => openWizard({ mode: 'edit', host }),
          onDeleteHost: (host) => setPendingDelete(host),
          onDiagnoseHost: runDiagnose,
          onAcceptFingerprint: (host, remember) => answerFingerprint(host, true, remember === true),
          onRejectFingerprint: (host) => answerFingerprint(host, false, false),
          onRetry: (host) => reconnectHost(host),
          onDiagnose: (host) => runDiagnose(host),
        }),
        wizard
          ? h(WizardDialog, {
              key: (wizard.mode || 'add') + ':' + (wizard.host ? wizard.host.id : 'new'),
              t,
              locale,
              mode: wizard.mode,
              initialHost: wizard.host,
              state,
              onClose: closeWizard,
              onRefresh: remote.refresh,
              onSaved: () => notify(t('wizard.saved'), 'success'),
              // Connect from the dialog: it saved the entry, so hand the connection over here.
              // The window is the connect window from the first frame on — progress, host key
              // and log — and the remote takes over as soon as it is up.
              onConnect: (host, password) => {
                closeWizard()
                openHost(host, password === null ? {} : { password })
              },
            })
          : null,
        diagnose
          ? h(DiagnoseDrawer, {
              t,
              locale,
              host: diagnose.host,
              status: diagnose.status,
              report: diagnose.report,
              error: diagnose.error,
              onClose: () => setDiagnose(null),
              onRun: rerunDiagnose,
            })
          : null,
        settingsOpen && state
          ? h(SettingsModal, {
              t,
              locale,
              settings: state.settings,
              onClose: () => setSettingsOpen(false),
              onSave: saveSettings,
            })
          : null,
        pendingDelete
          ? h(ConfirmDialog, {
              title: t('deleteTitle'),
              body: t('deleteBody', { name: pendingDelete.name || pendingDelete.id }),
              confirmLabel: deleting ? t('deleteBusy') : t('deleteConfirm'),
              cancelLabel: t('cancel'),
              busy: deleting,
              onConfirm: confirmDeleteHost,
              onCancel: () => setPendingDelete(null),
            })
          : null,
        conflictHost
          ? h(RemoteConflictPrompt, {
              key: conflictHost.id,
              t,
              host: conflictHost,
              busy: conflictBusy,
              onResolve: resolveConflict,
            })
          : null,
        passwordPrompt
          ? h(PasswordPrompt, {
              key: passwordPrompt.host && passwordPrompt.host.id ? passwordPrompt.host.id : 'password',
              t,
              locale,
              host: passwordPrompt.host,
              busy: passwordPrompt.busy === true,
              error: passwordPrompt.error,
              storageAvailable: passwordPrompt.host ? passwordPrompt.host.passwordStorageAvailable === true : false,
              onSubmit: submitPassword,
              onCancel: cancelPassword,
            })
          : null,
        h(Toast, { toast }),
      )
    }

    //#region 16. styles

    const CSS = `
    /*
     * No local token layer: every colour, surface, radius and shadow is the host's own --dsw-*
     * alias, so a theme change restyles the whole surface on the next paint.
     */
    .drg-root {
      color-scheme: inherit; display: flex; flex-direction: column; height: 100%; min-height: 0;
      color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-family: var(--dsw-font-family);
      font-size: 13px; line-height: 1.5; box-sizing: border-box; -webkit-font-smoothing: antialiased;
    }
    .drg-root *, .drg-root *::before, .drg-root *::after { box-sizing: border-box; }
    .drg-root ::selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
    .drg-root h1, .drg-root h2, .drg-root h3, .drg-root p, .drg-root ul, .drg-root ol, .drg-root dl, .drg-root dd, .drg-root dt { margin: 0; }
    .drg-root ul, .drg-root ol { padding: 0; list-style: none; }
    .drg-root code { font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 12px; }
    .drg-root button { font: inherit; color: inherit; }
    /* The ring colour is read inside the rule, not hoisted onto .drg-root: the host marks
       pointer modality by setting --dsw-focus-ring-color on the focused element itself, and a
       value computed on an ancestor would keep painting a ring for mouse users. */
    .drg-root :focus-visible {
      outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
      outline-offset: 1px;
    }
    .drg-root ::-webkit-scrollbar { width: 10px; height: 10px; }
    .drg-root ::-webkit-scrollbar-thumb {
      border: 2px solid transparent; background-clip: content-box; background-color: var(--dsw-alias-scrollbar-bg-l2);
      border-radius: 999px;
    }
    .drg-root ::-webkit-scrollbar-thumb:hover { background-color: var(--dsw-alias-scrollbar-hover-l2); }
    .drg-root ::-webkit-scrollbar-corner { background: transparent; }
    /* A seat in the shell overlay layer: it only carries the dialog (which is fixed); it
       must not paint or take size, or it would cover the app behind it. */
    .drg-root.drg-overlay { display: block; height: auto; background: transparent; }
    .drg-break { word-break: break-all; }

    /* ---- page --------------------------------------------------------------- */
    .drg-page {
      display: flex; flex-direction: column; gap: 20px; flex: 1; min-height: 0; overflow: auto; padding: 22px 24px 24px;
    }
    .drg-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .drg-page-heading { min-width: 0; }
    .drg-page-title { font-size: 20px; font-weight: 500; line-height: 28px; letter-spacing: -0.01em; }
    .drg-page-subtitle { margin-top: 2px; max-width: 68ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
    .drg-page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    /* ---- layout helpers ----------------------------------------------------- */
    .drg-row { display: flex; align-items: center; gap: 8px; }
    .drg-row-wrap { flex-wrap: wrap; }
    .drg-row-end { justify-content: flex-end; }
    .drg-paragraph, .drg-fingerprint-body, .drg-error-detail { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
    .drg-section-label { margin-bottom: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }

    /* ---- buttons ------------------------------------------------------------ */
    .drg-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
      border: 0.5px solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: inherit;
      font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .drg-btn:disabled { cursor: default; opacity: 0.5; }
    .drg-btn[data-busy="true"] { cursor: progress; }
    .drg-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; }
    /* Two classes plus the label span: the app ships its own element-level button colour rule, so a
       single-class declaration loses the cascade and the label renders in the same colour as the
       fill (invisible text on the primary button). */
    .drg-btn.drg-btn-primary,
    .drg-btn.drg-btn-primary .drg-btn-label { color: var(--dsw-alias-label-primary-foreground); }
    .drg-btn-primary:hover:not(:disabled), .drg-btn-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
    .drg-btn-secondary { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
    .drg-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l4); }
    .drg-btn-ghost { color: var(--dsw-alias-label-secondary); }
    .drg-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .drg-btn-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l3)); color: var(--dsw-alias-state-error-primary); }
    .drg-btn-danger:hover:not(:disabled) {
      background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent));
      border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, transparent);
    }
    .drg-btn-label { display: inline-flex; align-items: center; gap: 6px; }
    .drg-iconbtn {
      display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none;
      padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent;
      color: var(--dsw-alias-label-secondary); cursor: pointer;
    }
    .drg-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .drg-iconbtn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
    .drg-iconbtn:disabled { opacity: 0.5; cursor: default; }
    .drg-linkbtn {
      padding: 0 2px; border: none; border-radius: var(--dsw-radius-xs); background: none; color: var(--dsw-alias-link);
      font-size: 12.5px; cursor: pointer;
    }
    .drg-linkbtn:hover { text-decoration: underline; text-underline-offset: 2px; }

    /* ---- status ------------------------------------------------------------- */
    .drg-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; }
    .drg-dot[data-tone="success"] { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent); }
    .drg-badge {
      display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px;
      border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: transparent;
      color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-weight: 500; line-height: 18px;
      white-space: nowrap;
    }
    .drg-badge[data-tone="success"] { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); border-color: transparent; }
    .drg-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
    .drg-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border-color: transparent; }
    .drg-badge[data-tone="info"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); border-color: transparent; }
    .drg-badge[data-tone="limited"] { color: var(--dsw-static-violet-400); background: color-mix(in srgb, var(--dsw-static-violet-400) 12%, transparent); border-color: transparent; }

    /* ---- loading / empty ---------------------------------------------------- */
    .drg-spinner {
      display: inline-block; flex: none; border-radius: 50%;
      border: 2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color: currentColor;
      animation: drg-spin 0.8s linear infinite;
    }
    @keyframes drg-spin { to { transform: rotate(360deg); } }
    .drg-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 16px; color: var(--dsw-alias-label-secondary); }
    .drg-empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 56px 24px; text-align: center;
      border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
    }
    .drg-empty-icon {
      display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 2px; border-radius: 50%;
      border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-tertiary);
    }
    .drg-empty-title { font-size: 16px; font-weight: 500; }
    .drg-empty-body { max-width: 46ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }

    /* ---- host list ---------------------------------------------------------- */
    .drg-host-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .drg-summary { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    .drg-host-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
    .drg-host-card {
      display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px;
      border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
      background: var(--dsw-alias-bg-layer-1); transition: border-color 160ms ease, background-color 160ms ease;
    }
    .drg-host-card:hover { border-color: var(--dsw-alias-border-l4); }
    .drg-host-card[data-status="connected"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, var(--dsw-alias-border-l1)); }
    .drg-card-strip {
      display: flex; align-items: center; gap: 6px; margin: -16px -16px 0; padding: 6px 14px;
      border-radius: var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0; background: var(--dsw-alias-state-warn-tertiary);
      color: var(--dsw-alias-state-warn-label); font-size: 12px;
    }
    .drg-host-card[data-status="error"] .drg-card-strip,
    .drg-host-card[data-status="limited"] .drg-card-strip {
      background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
      color: var(--dsw-alias-state-error-primary);
    }
    .drg-card-strip-text, .drg-conflict-processes span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drg-card-strip .drg-linkbtn { margin-left: auto; flex: none; color: inherit; }
    .drg-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .drg-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 500; line-height: 22px; }
    .drg-card-address { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 12px; }
    .drg-card-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; }
    .drg-card-meta > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .drg-card-meta dt { color: var(--dsw-alias-label-caption); font-size: 11px; }
    .drg-card-meta dd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
    .drg-card-actions {
      display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 2px; padding-top: 12px;
      border-top: 0.5px solid var(--dsw-alias-border-l1);
    }
    .drg-card-actions-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }

    /* ---- notices ------------------------------------------------------------ */
    .drg-notice {
      display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
      border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-notice-icon { flex: none; margin-top: 1px; color: var(--dsw-alias-label-tertiary); }
    .drg-notice-body { flex: 1; min-width: 0; }
    .drg-notice-title { font-weight: 500; }
    .drg-notice-text { color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 19px; }
    .drg-notice[data-tone="warn"] { background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
    .drg-notice[data-tone="warn"] .drg-notice-icon { color: var(--dsw-alias-state-warn-primary); }
    .drg-notice[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); border-color: transparent; }
    .drg-notice[data-tone="error"] .drg-notice-icon { color: var(--dsw-alias-state-error-primary); }
    .drg-notice[data-tone="success"] { background: var(--dsw-alias-state-success-tertiary); border-color: transparent; }
    .drg-notice[data-tone="success"] .drg-notice-icon { color: var(--dsw-alias-state-success-primary); }

    /* ---- connect state ------------------------------------------------------ */
    .drg-progress { display: flex; flex-direction: column; gap: 14px; width: min(600px, 100%); margin: auto; padding: 12px 4px 20px; }
    .drg-progress-head { display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-state-business-primary); }
    .drg-progress-title { color: var(--dsw-alias-label-primary); font-size: 16px; font-weight: 500; }
    .drg-progress-line { color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .drg-phases { display: flex; gap: 6px; flex-wrap: wrap; }
    .drg-phase {
      display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
      border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-tertiary);
      font-size: 11.5px;
    }
    .drg-phase[data-state="current"] {
      color: var(--dsw-alias-label-primary);
      border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, transparent);
      background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
    }
    .drg-phase[data-state="done"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent); }
    .drg-phase-mark { display: inline-flex; width: 12px; height: 12px; align-items: center; justify-content: center; }

    .drg-fingerprint {
      display: flex; flex-direction: column; gap: 12px; width: min(640px, 100%); margin: auto; padding: 20px;
      border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, var(--dsw-alias-border-l2));
      border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-state-warn-tertiary);
    }
    .drg-fingerprint-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-label); }
    .drg-fingerprint-icon[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
    .drg-fingerprint-title, .drg-error-title { font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }

    .drg-kv { display: flex; flex-direction: column; gap: 0; padding: 4px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
    .drg-kv > div { display: flex; align-items: baseline; gap: 14px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-kv > div:last-child, .drg-keyfile-row:last-child { border-bottom: 0; }
    .drg-kv dt { flex: none; min-width: 108px; color: var(--dsw-alias-label-caption); font-size: 12px; }
    .drg-kv dd { min-width: 0; margin: 0; color: var(--dsw-alias-label-primary); word-break: break-word; }

    .drg-error-card {
      display: flex; flex-direction: column; align-items: flex-start; gap: 12px; width: min(640px, 100%); margin: auto;
      padding: 20px;
      border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));
      border-radius: var(--dsw-radius-lg);
      background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
    }
    .drg-error-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
    .drg-error-steps { width: 100%; }
    .drg-error-steps ul { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .drg-error-steps li::before { content: "· "; color: var(--dsw-alias-label-caption); }

    /* ---- dialogs ------------------------------------------------------------ */
    .drg-modal-layer { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .drg-modal-backdrop, .drg-drawer-backdrop {
      position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur);
      animation: drg-fade-in 140ms ease-out;
    }
    .drg-modal {
      position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(600px, 100%);
      max-height: min(86vh, 900px); padding-bottom: 24px; border: 0; border-radius: var(--dsw-radius-panel);
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      box-shadow: var(--dsw-elevation-prominent); overflow: hidden;
      animation: drg-dialog-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .drg-modal-wide { width: min(880px, 100%); }
    .drg-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 0 24px; }
    .drg-modal-titles { min-width: 0; }
    .drg-modal-title, .drg-drawer-title { font-size: 16px; font-weight: 500; line-height: 24px; }
    .drg-modal-subtitle { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 18px; }
    .drg-modal-body { padding: 0 24px; overflow: auto; min-height: 0; }
    .drg-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 24px; }
    /* Management window: the host list draws its own page header, so the shell header is
       reduced to the floating close button instead of leaving an empty strip on top. */
    .drg-modal[data-bare="true"] { gap: 0; padding-bottom: 0; }
    .drg-modal[data-bare="true"] .drg-modal-head { position: absolute; top: 14px; right: 14px; z-index: 3; width: auto; padding: 0; }
    .drg-modal[data-bare="true"] .drg-modal-body { display: flex; flex-direction: column; min-height: 0; padding: 0; }
    .drg-manage-window { display: flex; flex-direction: column; min-height: 0; }
    .drg-manage-window .drg-modal { height: min(86vh, 900px); }
    /* The window is a fixed height, so its body has to take what the chrome leaves: the host
       list scrolls in it, and the connect window's log grows to the bottom edge. */
    .drg-manage-window .drg-modal-body { flex: 1; }
    .drg-manage-window .drg-page { padding-right: 60px; }
    .drg-manage-live { padding: 18px 60px 14px 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
    .drg-manage-live .drg-progress, .drg-manage-live .drg-fingerprint { margin: 0; padding: 0; width: 100%; }
    .drg-manage-live .drg-fingerprint { border-color: transparent; background: transparent; padding: 0; }
    /* The connect log takes the rest of the window: a connection prints its progress in the
       block above and every line the Host wrote underneath, exactly as it was written. */
    .drg-manage-window .drg-connect-log { flex: 1; min-height: 0; }

    /* ---- connect log -------------------------------------------------------- */
    .drg-connect-log { display: flex; flex-direction: column; gap: 6px; min-height: 0; padding: 14px 24px 18px; }
    .drg-connect-log-head { display: flex; align-items: baseline; gap: 8px; padding-right: 46px; }
    .drg-connect-log-title { color: var(--dsw-alias-label-secondary); font-size: 12.5px; font-weight: 500; }
    .drg-connect-log-hint { color: var(--dsw-alias-label-caption); font-size: 11.5px; }
    .drg-connect-log-count {
      margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; font-variant-numeric: tabular-nums;
    }
    .drg-connect-log-body {
      flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-markdown-code-font-family); font-size: 11.5px;
      line-height: 1.7; overflow-wrap: anywhere;
    }
    .drg-connect-log-body:focus-visible, .drg-keyfile-row:focus-visible { outline-offset: -2px; }
    .drg-connect-log-line { display: flex; align-items: baseline; gap: 10px; }
    .drg-connect-log-time { flex: none; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
    .drg-connect-log-text { min-width: 0; white-space: pre-wrap; }
    .drg-connect-log-line[data-level="debug"] .drg-connect-log-text { color: var(--dsw-alias-label-secondary); }
    .drg-connect-log-line[data-level="warn"] .drg-connect-log-text { color: var(--dsw-alias-state-warn-primary); }
    .drg-connect-log-line[data-level="error"] .drg-connect-log-text { color: var(--dsw-alias-state-error-primary); }
    .drg-connect-log-empty { color: var(--dsw-alias-label-caption); font-family: var(--dsw-font-family); }

    @keyframes drg-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes drg-dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }

    /* ---- drawer ------------------------------------------------------------- */
    .drg-drawer-layer { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; }
    .drg-drawer {
      position: relative; z-index: 1; display: flex; flex-direction: column; width: min(520px, 100%); height: 100%;
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      box-shadow: var(--dsw-elevation-panel); animation: drg-drawer-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes drg-drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
    .drg-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 22px 14px 14px 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-drawer-subtitle { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
    .drg-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px; }
    .drg-drawer-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-diag { display: flex; flex-direction: column; gap: 12px; }
    .drg-diag-head { display: flex; align-items: center; gap: 10px; }
    .drg-diag-time { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .drg-diag-list { display: flex; flex-direction: column; gap: 6px; }
    .drg-diag-check {
      display: flex; gap: 10px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
    }
    .drg-diag-status {
      flex: none; align-self: flex-start; min-width: 46px; height: 20px; padding: 0 6px; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); font-size: 10.5px;
      font-weight: 600; line-height: 20px; text-align: center; text-transform: uppercase;
    }
    .drg-diag-status[data-status="pass"] { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); }
    .drg-diag-status[data-status="fail"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
    .drg-diag-check-body { min-width: 0; }
    .drg-diag-check-title { font-size: 12.5px; font-weight: 500; }
    .drg-diag-check-detail { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }

    /* ---- forms -------------------------------------------------------------- */
    .drg-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; min-width: 0; }
    .drg-field-wide { grid-column: 1 / -1; }
    .drg-field-label { color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; }
    .drg-field-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
    .drg-field-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
    .drg-field-inline { display: flex; align-items: center; gap: 8px; }
    .drg-field-inline > :first-child { flex: 1; min-width: 0; }
    .drg-input, .drg-select {
      width: 100%; height: 36px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3);
      color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; outline: none;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .drg-input:hover:not(:disabled), .drg-select:hover:not(:disabled) { border-color: var(--dsw-alias-label-caption); }
    .drg-input:focus, .drg-select:focus {
      border-color: var(--dsw-alias-state-business-primary);
      box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
    }
    .drg-input:disabled, .drg-select:disabled { opacity: 0.6; cursor: not-allowed; background: var(--dsw-alias-bg-layer-2); }
    .drg-input::placeholder { color: var(--dsw-alias-label-tertiary); }
    /* The SSH-address input carries a <datalist> so aliases autocomplete while typing.
       Chromium then paints a native picker arrow that does not match the host's field
       chrome and duplicates the alias chips below, so the indicator is hidden. */
    .drg-input::-webkit-calendar-picker-indicator { display: none; opacity: 0; }
    .drg-check { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
    .drg-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
    .drg-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); align-items: start; gap: 0 16px; }
    .drg-form-grid-3 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .drg-divider { height: 0.5px; margin: 14px 0; background: var(--dsw-alias-border-l1); }

    /* ---- wizard ------------------------------------------------------------- */
    .drg-wizard-body { min-width: 0; }
    .drg-wizard-form { display: flex; flex-direction: column; gap: 10px; }
    .drg-alias-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .drg-alias-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    .drg-alias-known { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11px; }
    .drg-chip {
      padding: 3px 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px; background: transparent;
      color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer;
    }
    .drg-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

    /* ---- key-file picker ---------------------------------------------------- */
    .drg-keyfile-path { margin: 2px 0 8px; color: var(--dsw-alias-label-caption); font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 11.5px; word-break: break-all; }
    .drg-keyfile-list { max-height: 320px; overflow-y: auto; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
    .drg-keyfile-row {
      display: flex; align-items: center; width: 100%; gap: 8px; padding: 8px 12px; border: 0;
      border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: transparent;
      color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
    }
    .drg-keyfile-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .drg-keyfile-row[data-kind='directory'] .drg-keyfile-name { font-weight: 500; }
    .drg-keyfile-row[data-kind='directory'] .drg-keyfile-name::before { content: "▸ "; color: var(--dsw-alias-label-caption); }
    .drg-keyfile-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- settings ----------------------------------------------------------- */
    .drg-settings { display: flex; flex-direction: column; gap: 20px; }
    .drg-settings-section {
      display: flex; flex-direction: column; gap: 8px; padding: 16px 18px;
      border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-settings-section .drg-field { margin-bottom: 8px; }
    .drg-settings-section .drg-form-grid { gap: 0 16px; }
    .drg-section-title { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
    .drg-settings-section > .drg-field-hint:first-of-type { margin-top: -4px; }

    /* ---- conflict ----------------------------------------------------------- */
    .drg-conflict-processes { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
    .drg-conflict-processes li { display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
    .drg-conflict-processes code { padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }

    /* ---- toast -------------------------------------------------------------- */
    .drg-toast {
      position: fixed; left: 50%; bottom: 24px; z-index: 80; max-width: min(560px, calc(100vw - 32px));
      padding: 10px 16px; transform: translateX(-50%); border: none; border-left: 3px solid transparent;
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label);
      font-size: 12.5px; box-shadow: var(--dsw-elevation-prominent);
      animation: drg-toast-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    /* The tone is carried by the accent edge, not by filling the toast with a state colour:
       the host's toast pair stays legible while the edge names the outcome. */
    .drg-toast[data-tone="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
    .drg-toast[data-tone="success"] { border-left-color: var(--dsw-alias-state-success-primary); }
    @keyframes drg-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translateX(-50%); } }

    /* ---- responsive / accessibility ---------------------------------------- */
    @media (prefers-reduced-motion: reduce) {
      .drg-root *, .drg-root *::before, .drg-root *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
      .drg-spinner { animation-duration: 2.4s; animation-iteration-count: infinite !important; }
    }
    @media (prefers-contrast: more) {
      .drg-host-card, .drg-settings-section, .drg-diag-check, .drg-kv { border-width: 1px; border-color: var(--dsw-alias-border-l4); }
    }
    @media (forced-colors: active) {
      .drg-dot { forced-color-adjust: none; }
      .drg-btn, .drg-input, .drg-select, .drg-host-card, .drg-modal, .drg-drawer, .drg-chip { border-color: ButtonText; }
      .drg-btn-primary { color: ButtonText; }
    }
    @media (max-width: 760px) {
      .drg-host-list { grid-template-columns: 1fr; }
      .drg-modal-layer { padding: 16px; }
      .drg-form-grid, .drg-form-grid-3 { grid-template-columns: 1fr; }
      .drg-card-meta { gap: 4px 12px; }
    }
    @media (max-width: 520px) {
      .drg-modal-layer { align-items: flex-end; padding: 0; }
      .drg-modal { width: 100%; max-height: 92vh; border-radius: var(--dsw-radius-panel) var(--dsw-radius-panel) 0 0; }
      .drg-drawer { width: 100%; }
      .drg-page { padding: 18px 16px 24px; }
      .drg-page-actions { width: 100%; justify-content: flex-end; }
    }
    /* The shell's overlay seat may have to float above a remote guest window. */
    [data-shell-overlay] { z-index: 2147483001; }
    /* While a guest fills the window it also paints the caption band, which the desktop
       window's own caption row sits on: the shell's caption menus (Windows) are the only
       local chrome left in that band, so they have to paint above the guest to stay usable.
       The class is only present while a guest owns the band. */
    html.drg-caption-live body > [data-windows-menu] { z-index: 2147483002; }
`

    function StyleSheet() {
      return h('style', { 'data-dsh-remote-go': 'styles', dangerouslySetInnerHTML: { __html: CSS } })
    }

    //#region 17. plugin registration

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-go: dictionaries')
      const t = ctx.locale.bind(NS)

      // Backfill the Host's local-version probe when the page exposes it, and
      // start the authoritative `/state` read in parallel (docs/api.md).
      ctx.effect(() => {
        const version = readBootVersion()
        if (version) api.reportLocalVersion(version)
        api.getState().catch(() => {
          // The panel surfaces read failures in its own error view.
        })
        return () => {}
      }, 'dsh-remote-go: startup probe')

      const getLocaleId = () => {
        try {
          const locale = ctx.locale
          const snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
          if (snapshot && typeof snapshot.active === 'string') return snapshot.active
          const current = typeof locale.getLocale === 'function' ? locale.getLocale() : null
          if (current && typeof current.active === 'string') return current.active
        } catch (_error) {
          // fall back to the default dictionary
        }
        return 'zh'
      }

      const panelStore = createPanelRequestStore()
      const wizardStore = createWizardStore()
      const openWizard = (draft) => {
        wizardStore.open(draft)
      }
      const sharedInject = () => ({ panelStore, wizardStore, openWizard, getLocaleId })

      // Everything the plugin draws lives in the shell's overlay layer: the floating management window, the wizard and
      // the prompts. It sits above a remote window, so opening or closing them leaves the remote exactly as it was.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: PANEL_ID,
            order: 40,
            locale: NS,
            inject: sharedInject,
          },
          PluginOverlay,
        ),
      )

      // The window's one control is the switcher row drawn into the sidebar of whichever page owns the window: this one
      // (local) or the remote guest's. It lists local plus every host, so picking one is all it takes to move the
      // window. It is the plugin's only entry: there is no settings page, no sidebar panel and no main panel;
      // management and the wizard are floating windows in the overlay layer.
      ctx.effect(() => {
        switcher.labelsOf = () => ({
          local: t('switcherLocal'),
          addHost: t('switcherAddHost'),
          manage: t('switcherManage'),
          exit: t('switcherExit'),
        })
        updateSwitcher()
        const timer = setInterval(() => updateSwitcher(), SWITCHER_TICK_MS)
        // The ticker is a safety net for a shell that re-rendered the sidebar away; it
        // must never keep a non-browser test process alive.
        unrefTimer(timer)
        return () => {
          if (typeof clearInterval === 'function') clearInterval(timer)
          switcher.dispatch = null
          switcher.labelsOf = null
          const win = localWindow()
          if (win !== null && win.__drgHostRow && typeof win.__drgHostRow.destroy === 'function') {
            win.__drgHostRow.destroy()
          }
          // Plugin disposal: every warm remote window and its lease goes with it.
          closeOverlay().catch(() => {})
          switcher.installed = false
        }
      }, 'dsh-remote-go: host switcher row')

      /** Hand the window back: the SSH link and the warm guest stay up, so coming back is instant. */
      function returnToLocal() {
        switcher.current = 'local'
        updateSwitcher({ current: 'local' })
        // Hidden, not closed: the remote window is already warm for the next visit.
        hideOverlays()
        panelStore.requestIntent({ kind: 'local' })
      }

      switcher.dispatch = (intent) => {
        if (intent.action === 'add') {
          // The wizard floats over whatever is on screen — including a remote window.
          openWizard({ mode: 'add', host: null })
          return
        }
        if (intent.action === 'manage') {
          // Host management floats the same way: the window behind it does not change.
          panelStore.requestIntent({ kind: 'manage' })
          return
        }
        if (intent.action === 'disconnect' && typeof intent.hostId === 'string') {
          // The row's exit control: drop that host's link (and its warm window) without switching to it.
          panelStore.requestIntent({ kind: 'disconnect', hostId: intent.hostId })
          return
        }
        if (typeof intent.target !== 'string') return
        if (intent.target === 'local') {
          returnToLocal()
          return
        }
        // Say where the window is going at once; the overlay host does the rest.
        switcher.current = intent.target
        updateSwitcher({ current: intent.target })
        panelStore.requestIntent({ kind: 'open', hostId: intent.target })
        api.activate(intent.target).catch(() => {})
      }
    }

    const components = {
      RemoteIcon,
      PluginOverlay,
      HostListView,
      HostCard,
      EmptyHosts,
      ManageWindow,
      ConnectWindow,
      ConnectLog,
      ConnectProgress,
      ErrorCard,
      FingerprintCard,
      PasswordPrompt,
      RemoteConflictPrompt,
      KeyFilePicker,
      WizardDialog,
      DiagnoseDrawer,
      SettingsModal,
      StatusDot,
      Modal,
      Button,
      Notice,
      Toast,
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      components,
      /**
       * The Host-API client, exposed so unit tests can exercise the real security
       */
      api,
      carrier: {
        open: showOverlay,
        close: closeOverlay,
        closeOne: closeCarrier,
        hide: hideOverlays,
        warm: carrierWarm,
        shown: () => carrierPool.current,
        update: updateSwitcher,
        script: () => HOST_ROW_SCRIPT,
      },
    }
  },
})

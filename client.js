/*
 * dsh-remote-go · Client half — a single-file browser plugin with no build step: one host
 * switcher row plus every floating window in the shell's overlay layer (the sections below are
 * marked with //#region). It renders the Host's state (docs/api.md is the frozen contract; the
 * Host half in src/ is the only source of truth) and sends user intents back. The row is the
 * plugin's host entry — no settings page, no sidebar panel, no main panel.
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
    /**
     * A dropped SSE stream is rebuilt with exponential backoff instead of leaving the panel in
     * polling forever (docs/api.md `/events`). The first retry is immediate enough to ride out a
     * page reload, and the cap keeps a permanently refused stream from hammering the Host.
     */
    const STREAM_RETRY_BASE_MS = 500
    const STREAM_RETRY_MAX_MS = 15000
    /** One state fetch in a retry chain must not hold the stream down forever. */
    const STREAM_RETRY_MAX_ATTEMPTS = 8
    function streamRetryDelay(attempt) {
      const safe = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)))
      return Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** safe)
    }
    const DESKTOP_BRIDGE_VERSION = 1
    const OVERLAY_ROOT_ID = 'dsh-remote-go-overlay'
    const CAPTION_FALLBACK_HEIGHT = 40
    const CAPTION_MARKER = 'data-windows-titlebar'
    const CAPTION_LIVE_CLASS = 'drg-caption-live'
    /**
     * Fallback for the caption band's control strip, used only when the guest cannot report DSH's
     * own value: the sidebar toggle sits at 12px, a collapsed rail pins the new-session control at
     * 48px (both are DSH's, see SidebarRoot.module.css), 28px wide, plus 8px of air. The window drag
     * strip starts here.
     */
    const CAPTION_CONTROLS_END = 84
    const CAPTION_GRIP_LEFT = CAPTION_CONTROLS_END
    /**
     * Where DSH mounts the Windows caption menubar (应用 / 编辑): a fixed host that reads
     * `--dsh-windows-menu-start`, which the sidebar's own collapse rule raises to the value above.
     * The guest resolves that variable for this page (its document carries the same rule), so these
     * two numbers are only the fallback for a guest that cannot answer.
     */
    const CAPTION_MENU_VAR = '--dsh-windows-menu-start'
    const CAPTION_MENU_START = 48
    const CAPTION_MENU_START_COLLAPSED = CAPTION_CONTROLS_END
    /** A caption band is tens of pixels tall; an inset past this is not a number worth copying. */
    const CAPTION_MENU_MAX = 200
    /** A guest reports its rail state through the same queue its row clicks use (mountSidebarMirror). */
    const CAPTION_SIDEBAR_INTENT = 'caption-sidebar'
    /** Only loopback URLs may ever be handed to the desktop guest (docs/api.md 安全约束). */
    const LOOPBACK_PREFIX = 'http://127.0.0.1:'
    /**
     * Same-origin seat of the remote UI used by the browser carrier. It is a path, not an origin:
     * the local DSH proxies it to the connected host's tunnel (docs/api.md `GET /hosts/:id/open`).
     */
    const REMOTE_VIEW_PREFIX = '/dsh-remote-go/remote/'
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
      cardRestart: ['重启远端 DSH', 'Restart remote DSH'],
      cardRestarting: ['正在重启远端 DSH…', 'Restarting the remote DSH…'],
      remoteRestartBusy: [
        '远端链路正在重建隧道，请稍后再试。',
        'The remote link is rebuilding its tunnel; try again shortly.',
      ],
      cardStopRemote: ['关闭远端 DSH', 'Stop remote DSH'],
      cardStopping: ['正在关闭远端 DSH…', 'Stopping the remote DSH…'],
      stopRemoteTitle: ['关闭远端 DSH？', 'Stop the remote DSH?'],
      stopRemoteBody: [
        '会停止远端 DSH 进程（本连接管理的那个），然后断开本机连接：隧道关闭、SSH 会话释放，此主机变为「断线」，连接配置与凭据保留，之后可以点「重连」重新启动一个新的远端实例。',
        'This stops the remote DSH process managed by this connection, then releases the link: the tunnel closes, the SSH session is released and the host becomes disconnected. Its settings and credentials are kept, and Reconnect starts a fresh remote instance later.',
      ],
      stopRemoteConfirm: ['关闭远端 DSH', 'Stop remote DSH'],
      stopRemoteBusy: ['正在关闭…', 'Stopping…'],
      cardDiagnose: ['诊断', 'Diagnose'],
      cardEdit: ['编辑', 'Edit'],
      cardDelete: ['删除', 'Delete'],
      errorReason: ['原因：{detail}', 'Reason: {detail}'],
      loopbackNote: [
        '远端界面只经 SSH 隧道映射为 127.0.0.1，再由本地同源代理承载；不会直接使用该地址，也不会暴露到公网。',
        'The remote UI is only reached through an SSH tunnel mapped to 127.0.0.1, then carried by the local same-origin proxy; the address itself is never used directly or exposed publicly.',
      ],
      viewportConnecting: ['正在连接「{name}」…', 'Connecting to "{name}"…'],
      viewportOverlayLoadFailed: [
        '远端界面加载失败。点侧边栏主机条里的「本地」离开远端，再点该主机重新接管。',
        'The remote UI failed to load. Pick “Local” in the sidebar switcher and open the host again.',
      ],
      carrierUnavailable: [
        '当前窗口没有可用的远端承载方式，无法打开远端界面。',
        'This window has no seat for the remote UI, so it cannot be opened here.',
      ],
      externalLinkBlocked: [
        '无法打开这个链接：只支持 http 或 https 外链。',
        'Cannot open that link: only http or https links are allowed.',
      ],
      clipboardWriteFailed: [
        '复制失败：远端界面没能写入剪贴板。',
        'Copy failed: the remote view could not write the clipboard.',
      ],
      remoteNoticePrefix: ['远端界面：', 'Remote view: '],
      connectLogTitle: ['连接日志', 'Connect log'],
      connectLogHint: ['关窗不中断连接', 'Closing keeps it running'],
      connectLogCount: ['{count} 行', '{count} lines'],
      connectLogEmpty: ['等待日志输出…', 'Waiting for log output…'],
      'connectLogPhase.ssh': ['SSH', 'SSH'],
      'connectLogPhase.probe': ['探测', 'Probe'],
      'connectLogPhase.bootstrap': ['准备运行时', 'Runtime'],
      'connectLogPhase.start': ['启动远端', 'Start'],
      'connectLogPhase.tunnel': ['隧道', 'Tunnel'],
      'connectLogPhase.verifying': ['校验界面', 'Verify'],
      'connectLogPhase.ready': ['就绪', 'Ready'],
      switcherLocal: ['本地', 'Local'],
      switcherAddHost: ['添加主机', 'Add host'],
      switcherManage: ['管理界面', 'Manage hosts'],
      switcherExit: ['断开', 'Disconnect'],
      downloadStarted: ['已开始下载「{name}」', 'Download started: "{name}"'],
      downloadPreparing: ['正在下载「{name}」…', 'Downloading "{name}"…'],
      downloadSaved: ['已保存「{name}」', 'Saved "{name}"'],
      downloadSavedTo: ['已保存到 {path}', 'Saved to {path}'],
      downloadCancelled: ['已取消下载', 'Download cancelled'],
      downloadCancel: ['取消下载', 'Cancel download'],
      downloadClose: ['关闭', 'Close'],
      downloadDrag: ['拖动下载进度', 'Drag download progress'],
      downloadFailed: ['下载失败', 'Download failed'],
      downloadFolderDesktopOnly: [
        '文件夹下载需要在桌面端选择保存文件夹。',
        'Folder downloads need the desktop app to choose a destination folder.',
      ],
      downloadFolderChoose: ['请选择保存文件夹…', 'Choose a destination folder…'],
      downloadFiles: ['{done} / {total} 个文件', '{done} / {total} files'],
      downloadProgress: ['下载进度：{name}', 'Download progress: {name}'],
      downloadInProgress: ['正在下载', 'Downloading'],
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
      'progress.restarting-remote': [
        '远端 DSH 正在重启，正在重新挂载界面…',
        'The remote DSH is restarting; re-attaching the remote UI…',
      ],
      'progress.stopping-remote': [
        '正在关闭远端 DSH（停止本连接管理的远端进程）…',
        'Stopping the remote DSH process managed by this connection…',
      ],
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
      'wizard.keyPathPlaceholder': ['例如：~/.ssh/id_rsa', 'e.g. ~/.ssh/id_rsa'],
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
      'wizard.advanced': ['高级选项', 'Advanced options'],
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
      'settings.validationPort': ['端口应为 1-65535', 'The port must be 1–65535'],
      'settings.validationTimeout': ['连接超时应为 5-300 秒', 'The connect timeout must be 5–300 seconds'],
      'settings.validationAttempts': ['最大重试次数应为 0-20', 'Max attempts must be 0–20'],
      'settings.validationBaseDelay': ['重试间隔应为 100-30000 毫秒', 'The retry delay must be 100–30000 ms'],
      'settings.validationProfile': [
        'profile 只能包含字母、数字与 . _ -，且不能是 desktop',
        'A profile may only contain letters, digits and . _ -, and cannot be desktop',
      ],
      'wizard.validationIdleMinutes': ['空闲分钟数应为 1-1440', 'Idle minutes must be 1–1440'],
      'wizard.passwordSavedHint': [
        '已保存的密码不会被读取；连接时会再询问。',
        'The saved password is never read; you will be asked again when connecting.',
      ],
      liveStreamLostTitle: ['实时连接已断开，正在轮询', 'Live updates lost; polling instead'],
      liveStreamLostBody: [
        '状态更新已退回轮询（每 {seconds} 秒一次）。可以手动重新建立实时连接。',
        'State updates fell back to polling every {seconds}s. You can reconnect the live stream.',
      ],
      liveReconnect: ['重新连接', 'Reconnect'],
      liveReconnecting: ['正在重新连接…', 'Reconnecting…'],
      liveStreamRestored: ['实时连接已恢复。', 'Live updates restored.'],
      hostWarnings: ['提示', 'Notice'],
      versionDifferent: [
        '远端 DSH {remote} 与本机 {local} 不一致',
        'The remote DSH {remote} differs from this machine ({local})',
      ],
      versionUnknown: ['无法确认远端 DSH 版本', 'The remote DSH version could not be confirmed'],
      managingConnectingHosts: [
        '正在连接的主机显示在连接窗口里，不在此清单中。',
        'Hosts that are connecting appear in the connection window, not in this list.',
      ],
      deleteConnectingWarning: [
        '这台主机正在连接；删除会立即中断连接。',
        'This host is connecting; deleting it interrupts the connection immediately.',
      ],
      deleteStillConfirm: ['仍要删除（会中断连接）', 'Delete anyway (interrupts the connection)'],
      carrierBackToLocal: ['返回本地', 'Back to local'],
      carrierNotDsh: [
        '远端页面不是 DSH 界面（可能是代理错误或版本不兼容）。',
        'The remote page is not a DSH UI (proxy error or incompatible version).',
      ],
      'settings.defaultPortHint': ['新增主机时预填的端口', 'Prefilled as the port for new hosts'],
      'settings.connectTimeoutHint': ['SSH 连接与远端就绪的整体超时', 'Overall timeout for SSH and remote readiness'],
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

    /**
     * A browser carrier URL is a path on this page's own origin, so it must be exactly the view
     * prefix plus one host id plus a slash (the one-shot token rides in the query string).
     * Anything absolute, encoded or traversing is refused before it can reach an iframe.
     */
    function isValidViewPath(value) {
      if (typeof value !== 'string' || !value.startsWith(REMOTE_VIEW_PREFIX)) return false
      if (value.includes('://') || value.includes('\\')) return false
      // The browser would collapse these before sending; refusing them keeps the check honest.
      if (/(^|\/)\.{1,2}(\/|$)/.test(value) || /%2e/i.test(value)) return false
      const rest = value.slice(REMOTE_VIEW_PREFIX.length)
      const match = /^([A-Za-z0-9_-]{1,64})\//.exec(rest)
      return match !== null
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

    /** A guest call that never answers must not wedge the intent drain (it would stop forever). */
    function withTimeout(promise, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
          resolve(value)
        }
        let timer = null
        if (typeof setTimeout === 'function') {
          timer = setTimeout(() => finish(null), timeoutMs)
          unrefTimer(timer)
        }
        Promise.resolve(promise).then(finish, () => finish(null))
      })
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

    /**
     * Command queue from the injected guest page (or the switcher row) to the
     * overlay: currently "download this remote file" plus the capability bridge's
     * toast requests. Consumed in order.
     */
    function createToolRequestStore() {
      let pending = []
      const store = createStore()
      return {
        requestDownload(request) {
          if (!request || typeof request !== 'object') return
          if (typeof request.hostId !== 'string' || request.hostId === '') return
          if (typeof request.path !== 'string' || request.path === '') return
          pending.push({
            kind: 'download',
            hostId: request.hostId,
            path: request.path,
            name: typeof request.name === 'string' ? request.name : '',
          })
          store.emit()
        },
        /** A visible line for the shell's toast: the bridge's only channel for "this failed". */
        requestNotice(request) {
          if (!request || typeof request !== 'object') return
          if (typeof request.text !== 'string') return
          const text = request.text.trim().slice(0, 200)
          if (text === '') return
          const tone =
            request.tone === 'error' || request.tone === 'success' || request.tone === 'warn' ? request.tone : 'info'
          pending.push({ kind: 'notice', text, tone })
          store.emit()
        },
        take() {
          return pending.length > 0 ? pending.shift() : null
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
        // DSH admission answers without this plugin's JSON envelope. A 401 means the browser
        // session is gone and a 403 means Host/Origin was refused: neither is "internal", and
        // repeating the same request cannot fix either one.
        if (response && response.status === 401) throw apiError(localErrorView('session-expired', 'HTTP 401'))
        if (response && response.status === 403) throw apiError(localErrorView('forbidden', 'HTTP 403'))
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
      /**
       * Restart the managed remote web on the same SSH session. The Host accepts and
       * reports progress through `/state` (progress code `restarting-remote`); the old
       * launch URL and its tunnel are gone once it finishes.
       */
      async restart(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/restart', { method: 'POST', body: {} })
      },
      /**
       * Stop the remote DSH this connection manages and release the link. The Host refuses
       * with 409 `stop-unavailable` when the host is not stoppable or the bound pid cannot be
       * proven to be this connection's own; `/state` carries `stopping-remote` while it works.
       */
      async stopRemote(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/stop-remote', { method: 'POST', body: {} })
      },
      async openHost(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/open')
        // The desktop carrier takes the loopback origin; the browser carrier takes the same-origin
        // view path. Both are checked here, so neither backend can be handed anything else.
        if (!isValidLoopbackUrl(payload.url)) throw apiError(localErrorView('blocked-url'))
        const webUrl = typeof payload.webUrl === 'string' ? payload.webUrl : ''
        // A Host from before the web carrier has no webUrl; that must not block the desktop path.
        if (webUrl !== '' && !isValidViewPath(webUrl)) throw apiError(localErrorView('blocked-url'))
        return { url: payload.url, webUrl }
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
      /**
       * Start a Host-side download job for a remote file or folder.
       * The Host streams the content straight into the selected local directory.
       * @param {string} hostId - connected host.
       * @param {string} remotePath - absolute file or folder path.
       * @param {string} destination - local folder chosen by the user.
       * @returns {Promise<object>} the initial job view.
       */
      async startDownload(hostId, remotePath, destination) {
        const payload = await apiRequest('/downloads', {
          method: 'POST',
          body: { hostId, path: remotePath, destination },
        })
        if (!payload.job || typeof payload.job !== 'object') {
          throw apiError(localErrorView('internal', 'malformed download job'))
        }
        return payload.job
      },
      /** Read one job's current status (fallback for a missed SSE frame). */
      async downloadStatus(jobId) {
        const payload = await apiRequest('/downloads/' + encodeURIComponent(jobId) + '/status')
        if (!payload.job || typeof payload.job !== 'object') {
          throw apiError(localErrorView('internal', 'malformed download status'))
        }
        return payload.job
      },
      /** Cancel a preparing/ready job; a missing job is treated as already gone. */
      async cancelDownload(jobId) {
        try {
          await apiRequest('/downloads/' + encodeURIComponent(jobId), { method: 'DELETE' })
          return true
        } catch (_error) {
          return false
        }
      },
    }

    /**
     * The one `/state` feed for the whole plugin: SSE when it is available, a three-second poll
     * while the stream is down, and an exponential-backoff rebuild of the stream in the
     * background. A reconnected stream stops the poll and reports `live` again. Handlers:
     * `onState(frame)`, `onStatus('live' | 'polling')`, `onError(error)`, `onDownload(job)`.
     * The returned disposer also carries `reconnect()`, which the fallback banner uses.
     */
    function subscribeState(handlers) {
      const onState = typeof handlers.onState === 'function' ? handlers.onState : () => {}
      const onStatus = typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {}
      const onError = typeof handlers.onError === 'function' ? handlers.onError : () => {}
      const onDownload = typeof handlers.onDownload === 'function' ? handlers.onDownload : () => {}
      let disposed = false
      let source = null
      let timer = null
      let retryTimer = null
      let retryAttempt = 0
      let polling = false
      let mode = 'idle'
      /** Every callback that settles a state frame, so a late frame can still land. */
      const setMode = (next) => {
        if (mode === next) return
        mode = next
        if (!disposed) onStatus(next)
      }

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
      const stopPolling = () => {
        polling = false
        if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
        timer = null
      }
      const startPolling = () => {
        if (disposed) return
        if (!polling) {
          polling = true
          if (typeof setInterval === 'function') {
            timer = setInterval(fetchOnce, POLL_INTERVAL_MS)
            unrefTimer(timer)
          }
          fetchOnce()
        }
        setMode('polling')
      }
      const clearRetry = () => {
        if (retryTimer !== null && typeof clearTimeout === 'function') clearTimeout(retryTimer)
        retryTimer = null
      }
      const scheduleStreamRetry = () => {
        if (disposed || retryTimer !== null) return
        if (retryAttempt >= STREAM_RETRY_MAX_ATTEMPTS) {
          // The automatic chain stops here; polling continues and the banner offers a manual
          // reconnect, which resets the counter. This is the cap the UI promises.
          setMode('polling')
          return
        }
        if (typeof setTimeout !== 'function') return
        const attempt = retryAttempt
        retryAttempt += 1
        setMode('reconnecting')
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (!disposed) startStream()
        }, streamRetryDelay(attempt))
        unrefTimer(retryTimer)
      }
      const onStreamOpen = () => {
        if (disposed) return
        // The stream is alive again: polling and the retry chain stop, and the backoff resets so
        // the next drop starts from the base delay.
        retryAttempt = 0
        clearRetry()
        stopPolling()
        setMode('live')
      }
      const startStream = () => {
        if (disposed) return
        if (typeof EventSource !== 'function') {
          startPolling()
          scheduleStreamRetry()
          return
        }
        stopStream()
        try {
          source = new EventSource(EVENT_PATH)
        } catch (_error) {
          startPolling()
          scheduleStreamRetry()
          return
        }
        const stream = source
        source.onopen = () => {
          if (source === stream) onStreamOpen()
        }
        source.addEventListener('state', (event) => {
          if (source !== stream) return
          try {
            const state = JSON.parse(event.data)
            // The first frame proves the stream works even when `open` never fired.
            onStreamOpen()
            deliver(state)
          } catch (_error) {
            // a malformed frame must not kill the stream
          }
        })
        source.addEventListener('download', (event) => {
          if (source !== stream) return
          try {
            const job = JSON.parse(event.data)
            if (job && typeof job === 'object') onDownload(job)
          } catch (_error) {
            // a malformed frame must not kill the stream
          }
        })
        source.addEventListener('ping', () => {
          if (source === stream) onStreamOpen()
        })
        source.addEventListener('error', () => {
          if (disposed || source !== stream) return
          // Never leave the panel without data: poll from now on and rebuild the stream with
          // backoff. A successful frame (`onStreamOpen`) turns polling off again.
          startPolling()
          stopStream()
          scheduleStreamRetry()
        })
        // Do not claim `live` here: until `open` (or the first frame/ping) arrives the banner
        // must stay up. A manual or automatic reconnect used to clear it before the stream
        // actually worked (review blocker 2).
      }
      const reconnect = () => {
        if (disposed) return
        retryAttempt = 0
        clearRetry()
        // A manual retry is a fresh attempt even when a scheduled one is in flight.
        if (retryTimer !== null && typeof clearTimeout === 'function') clearTimeout(retryTimer)
        retryTimer = null
        startStream()
        if (mode !== 'live') {
          startPolling()
          // `startPolling` sets `polling`; the retry attempt is the state that keeps the banner
          // saying "reconnecting" until the stream actually opens.
          setMode('reconnecting')
        }
      }

      // Initial read in parallel with opening the stream, so the panel can paint immediately even when SSE is slow.
      fetchOnce()
      startStream()

      const dispose = () => {
        disposed = true
        stopStream()
        stopPolling()
        clearRetry()
      }
      dispose.reconnect = reconnect
      return dispose
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

    /** Human-readable byte count for the download progress card. */
    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let amount = bytes
      let unit = 0
      while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024
        unit += 1
      }
      const digits = unit === 0 ? 0 : amount >= 10 ? 0 : 1
      return amount.toFixed(digits) + ' ' + units[unit]
    }

    /**
     * Draggable stack for the transient download cards. The stack stays anchored to
     * the bottom-right by CSS and is moved with a transform, so dragging never changes
     * layout or the guest behind it. Clamping keeps at least a corner on screen.
     */
    function DownloadCenter(props) {
      const jobs = Array.isArray(props.jobs) ? props.jobs : []
      const [offset, setOffset] = useState({ x: 0, y: 0 })
      const stackRef = useRef(null)
      const dragRef = useRef(null)

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const target = event.target
        if (target && typeof target.closest === 'function' && target.closest('button')) return
        if (!stackRef.current || !event.currentTarget) return
        const rect = stackRef.current.getBoundingClientRect()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          x: offset.x,
          y: offset.y,
          rect,
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (_captureError) {
          // pointer capture is an enhancement; dragging still works inside the head
        }
        event.preventDefault()
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        const x = drag.x + (event.clientX - drag.startX)
        const y = drag.y + (event.clientY - drag.startY)
        const minX = drag.x + (8 - drag.rect.left)
        const maxX = drag.x + (window.innerWidth - 8 - drag.rect.right)
        const minY = drag.y + (8 - drag.rect.top)
        const maxY = drag.y + (window.innerHeight - 8 - drag.rect.bottom)
        setOffset({
          x: Math.min(Math.max(x, Math.min(minX, maxX)), Math.max(minX, maxX)),
          y: Math.min(Math.max(y, Math.min(minY, maxY)), Math.max(minY, maxY)),
        })
        event.preventDefault()
      }

      const onPointerEnd = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        try {
          if (event.currentTarget && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        } catch (_releaseError) {
          // already released
        }
      }

      return h(
        'div',
        {
          ref: stackRef,
          className: 'drg-downloads',
          'data-testid': 'dsh-remote-go-downloads',
          style: { transform: 'translate(' + offset.x + 'px, ' + offset.y + 'px)' },
        },
        jobs.map((job) =>
          h(DownloadProgress, {
            key: job.id,
            job,
            t: props.t,
            locale: props.locale,
            onCancel: props.onCancel,
            onDismiss: props.onDismiss,
            onDragStart: onPointerDown,
            onDragMove: onPointerMove,
            onDragEnd: onPointerEnd,
          }),
        ),
      )
    }

    /**
     * Bottom-right download card. It is transient (one per active job), shows a real
     * determinate bar once the Host has an inventory, and stays indeterminate while a
     * folder is still being enumerated. The header is the drag handle.
     */
    function DownloadProgress(props) {
      const t = translatorOf(props)
      const job = props.job
      if (!job) return null
      const total = Number(job.totalBytes) || 0
      const done = Math.min(Number(job.doneBytes) || 0, total || Number.MAX_SAFE_INTEGER)
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
      const preparing = job.phase === 'preparing'
      const failed = job.phase === 'error'
      const donePhase = job.phase === 'done'
      const name = job.name || job.path || 'download'
      const title = failed
        ? t('downloadFailed')
        : preparing
          ? t('downloadPreparing', { name })
          : t('downloadSaved', { name })
      const detail = failed && job.error ? resolveText(job.error.detail, localeOf(props)) : ''
      const meta = []
      if (total > 0) meta.push(formatBytes(done) + ' / ' + formatBytes(total))
      if (Number(job.totalFiles) > 0) {
        meta.push(t('downloadFiles', { done: Number(job.doneFiles) || 0, total: Number(job.totalFiles) || 0 }))
      }
      const cancellable = (preparing || job.phase === 'ready') && typeof props.onCancel === 'function'
      const dismissible = (failed || donePhase) && typeof props.onDismiss === 'function'
      const progressText =
        total > 0
          ? percent + '%' + (meta.length > 0 ? ' · ' + meta.join(' · ') : '')
          : preparing
            ? t('downloadInProgress')
            : title
      return h(
        'div',
        {
          className: 'drg-download' + (failed ? ' drg-download-error' : ''),
          'data-testid': 'dsh-remote-go-download',
          'data-phase': job.phase,
        },
        h(
          'div',
          {
            className: 'drg-download-head',
            title: t('downloadDrag'),
            onPointerDown: props.onDragStart,
            onPointerMove: props.onDragMove,
            onPointerUp: props.onDragEnd,
            onPointerCancel: props.onDragEnd,
          },
          h(
            'span',
            { className: 'drg-download-grip', 'aria-hidden': 'true' },
            h(
              'svg',
              { width: 10, height: 14, viewBox: '0 0 10 14', fill: 'currentColor', focusable: 'false' },
              [2, 7, 12].map((cy) => [2, 8].map((cx) => h('circle', { key: cx + '-' + cy, cx, cy, r: 1.1 }))),
            ),
          ),
          // The visible title is the drag handle's label; the live region below announces it
          // once, and buttons stay outside the status so a screen reader is not told to press
          // Cancel as part of the status (audit S3).
          h('span', { className: 'drg-download-title', title, 'aria-hidden': 'true' }, title),
          cancellable
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'drg-download-action',
                  onClick: () => props.onCancel(job),
                },
                t('downloadCancel'),
              )
            : null,
          dismissible
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'drg-download-action',
                  onClick: () => props.onDismiss(job),
                },
                t('downloadClose'),
              )
            : null,
        ),
        h(
          'div',
          {
            className: 'drg-download-status drg-sr-only',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
          },
          title + (detail ? ' · ' + detail : ''),
        ),
        h(
          'div',
          {
            className: 'drg-download-track',
            'data-indeterminate': percent === 0 && preparing ? 'true' : undefined,
            role: 'progressbar',
            'aria-label': t('downloadProgress', { name }),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': total > 0 ? percent : undefined,
            'aria-valuetext': progressText,
          },
          h('span', {
            className: 'drg-download-fill',
            style: { width: (total > 0 ? percent : preparing ? 35 : 100) + '%' },
          }),
        ),
        h(
          'div',
          { className: 'drg-download-meta', 'aria-hidden': 'true' },
          h('span', null, meta.filter(Boolean).join(' · ')),
          total > 0 ? h('span', null, percent + '%') : null,
        ),
        detail ? h('p', { className: 'drg-download-detail', 'aria-hidden': 'true' }, detail) : null,
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

    //#region 7a. dialog stack (Escape, focus trap, scroll lock)

    const DIALOG_FOCUSABLE =
      'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

    /**
     * One stack for every dialog this plugin draws. Before this, each `Modal` installed its own
     * document `keydown` listener with `useEffect(..., [onClose])`; because `onClose` is a new
     * function on every render, every re-render removed and re-added the listener — and a single
     * Escape that started on the top dialog was handled by the *lower* one before React got to
     * re-register. The window management dialog closed under the wizard, exactly as the audit
     * reproduces (S1-1). Now: one listener on the document, the top layer alone receives Escape,
     * `dismissible:false` swallows it, and the listener never changes during a key event.
     *
     * The same stack owns the rest of the dialog contract (S2-4): initial focus, Tab cycling,
     * focus restoration on unmount, `overflow:hidden` on `<body>`, `aria-modal` on the top dialog
     * only, and `inert` on every lower layer.
     */
    function createDialogStack() {
      const layers = []
      let doc = null
      let installed = false
      let savedOverflow = null
      let initialFocus = null

      const top = () => layers[layers.length - 1] || null
      const focusOf = (root) => {
        if (!root || typeof root.querySelectorAll !== 'function') return []
        let list = []
        try {
          list = Array.prototype.slice.call(root.querySelectorAll(DIALOG_FOCUSABLE))
        } catch (_error) {
          return []
        }
        return list.filter((node) => {
          if (!node || node.disabled === true) return false
          if (typeof node.hasAttribute === 'function' && node.hasAttribute('aria-hidden')) return false
          return typeof node.focus === 'function'
        })
      }
      const firstFocusable = (root) => {
        const list = focusOf(root)
        if (list.length === 0) return null
        // A form dialog opens on its first field rather than on its close button.
        return list.find((node) => /^(INPUT|SELECT|TEXTAREA)$/.test(String(node.tagName || ''))) || list[0]
      }
      const focusNode = (node) => {
        try {
          node.focus()
        } catch (_error) {
          // a detached node cannot take focus
        }
      }
      const setAttr = (node, name, value) => {
        if (!node || typeof node.setAttribute !== 'function') return
        if (value === null) {
          if (typeof node.removeAttribute === 'function') node.removeAttribute(name)
          return
        }
        node.setAttribute(name, value)
      }
      const sync = () => {
        const active = top()
        for (const layer of layers) {
          const isTop = layer === active
          setAttr(layer.dialog, 'aria-modal', isTop ? 'true' : null)
          if (isTop) {
            if (layer.layer && typeof layer.layer.removeAttribute === 'function') layer.layer.removeAttribute('inert')
          } else {
            setAttr(layer.layer, 'inert', '')
          }
        }
      }
      const trapTab = (layer, event) => {
        const list = focusOf(layer.dialog)
        if (list.length === 0) {
          event.preventDefault()
          focusNode(layer.dialog)
          return
        }
        const active = doc ? doc.activeElement : null
        const index = list.indexOf(active)
        if (index === -1) {
          event.preventDefault()
          focusNode(event.shiftKey ? list[list.length - 1] : list[0])
          return
        }
        if (event.shiftKey && index === 0) {
          event.preventDefault()
          focusNode(list[list.length - 1])
        } else if (!event.shiftKey && index === list.length - 1) {
          event.preventDefault()
          focusNode(list[0])
        }
      }
      const onKeyDown = (event) => {
        const layer = top()
        if (layer === null || !event) return
        if (event.key === 'Escape') {
          // A dialog always owns Escape: even when it may not close, the key must not fall
          // through to the dialog underneath it.
          event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          if (layer.dismissible() === false) return
          layer.close()
          return
        }
        if (event.key === 'Tab') trapTab(layer, event)
      }
      const install = (target) => {
        if (installed || !target) return
        doc = target
        doc.addEventListener('keydown', onKeyDown, true)
        installed = true
      }
      const uninstall = () => {
        if (!installed || !doc) return
        doc.removeEventListener('keydown', onKeyDown, true)
        installed = false
        doc = null
      }
      const lockScroll = () => {
        if (!doc || !doc.body || !doc.body.style) return
        savedOverflow = doc.body.style.overflow
        doc.body.style.overflow = 'hidden'
      }
      const unlockScroll = () => {
        if (!doc || !doc.body || !doc.body.style) return
        doc.body.style.overflow = savedOverflow === null ? '' : savedOverflow
        savedOverflow = null
      }
      const focusInitial = (layer) => {
        const node = firstFocusable(layer.dialog)
        if (node !== null) {
          focusNode(node)
          return
        }
        setAttr(layer.dialog, 'tabindex', '-1')
        focusNode(layer.dialog)
      }
      const remove = (layer) => {
        const index = layers.indexOf(layer)
        if (index < 0) return
        layers.splice(index, 1)
        sync()
        if (layers.length === 0) {
          unlockScroll()
          uninstall()
        }
        // Hand focus back to whatever opened this dialog; a removed trigger (the dialog was
        // opened by a command channel, for example) falls back to the new top dialog.
        const restore = layer.returnFocus || (layers.length === 0 ? initialFocus : null)
        if (restore && restore !== layer.dialog) {
          const stillThere = restore.isConnected !== false
          if (stillThere) focusNode(restore)
        }
        if (layers.length > 0) {
          const active = doc && doc.activeElement
          if (!active || !top().dialog.contains(active)) focusInitial(top())
        } else {
          initialFocus = null
        }
      }

      return {
        push(layer) {
          if (!layer || !layer.dialog) return () => {}
          const elementDocument = layer.dialog.ownerDocument || (typeof document === 'undefined' ? null : document)
          if (elementDocument === null) return () => {}
          install(elementDocument)
          if (layers.length === 0) {
            initialFocus = doc && doc.activeElement ? doc.activeElement : null
            lockScroll()
          } else {
            layer.returnFocus = doc && doc.activeElement ? doc.activeElement : null
          }
          layers.push(layer)
          sync()
          focusInitial(layer)
          return () => remove(layer)
        },
        remove,
        top,
        size: () => layers.length,
        /** @internal test seam */
        keydown: onKeyDown,
      }
    }

    let sharedDialogStack = null
    function dialogStack() {
      if (sharedDialogStack === null) sharedDialogStack = createDialogStack()
      return sharedDialogStack
    }

    /**
     * Register one rendered dialog with the shared stack. `onClose` is read through a ref, so a
     * render that creates a new callback does not re-register (the S1-1 trigger).
     */
    function useDialogLayer(options) {
      const closeRef = useRef(options.onClose)
      closeRef.current = options.onClose
      const dismissibleRef = useRef(options.dismissible !== false)
      dismissibleRef.current = options.dismissible !== false
      useEffect(() => {
        const layer = options.layerRef && options.layerRef.current
        const dialog = options.dialogRef && options.dialogRef.current
        if (!layer || !dialog) return undefined
        return dialogStack().push({
          layer,
          dialog,
          dismissible: () => dismissibleRef.current,
          close: () => {
            const close = closeRef.current
            if (typeof close === 'function') close()
          },
        })
      }, [])
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
        props.error ? h('span', { className: 'drg-field-error', role: 'alert', id: props.errorId }, props.error) : null,
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
        'aria-invalid': props.invalid === true ? 'true' : undefined,
        'aria-describedby': props.describedBy,
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
          'aria-invalid': props.invalid === true ? 'true' : undefined,
          'aria-describedby': props.describedBy,
          'data-testid': props.testId,
          onChange: typeof props.onChange === 'function' ? (event) => props.onChange(event.target.value) : undefined,
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    /** One form field from a spec; `after` runs alongside the patch (touched/dirty flags). */
    function formRow(t, draft, patch, spec) {
      const label = t(spec.label)
      const error = spec.error ? t(spec.error) : undefined
      const errorId = error && spec.testId ? spec.testId + '-error' : undefined
      const onChange = (next) => {
        patch({ [spec.key]: next })
        if (spec.after) spec.after(next)
      }
      return h(
        Field,
        { label, hint: spec.hint ? t(spec.hint) : undefined, error, errorId },
        spec.options
          ? h(Select, {
              value: draft[spec.key],
              ariaLabel: label,
              testId: spec.testId,
              invalid: Boolean(error),
              describedBy: errorId,
              options: spec.options.map(([value, key]) => ({ value, label: t(key) })),
              onChange,
            })
          : h(TextInput, {
              type: spec.kind,
              value: draft[spec.key],
              placeholder: spec.placeholder ? t(spec.placeholder) : undefined,
              ariaLabel: label,
              testId: spec.testId,
              invalid: Boolean(error),
              describedBy: errorId,
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
        {
          className: 'drg-notice',
          'data-tone': tone,
          role: tone === 'error' ? 'alert' : 'status',
          'data-testid': props.testId,
        },
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

    let modalSequence = 0
    function Modal(props) {
      const onClose = props.onClose
      const layerRef = useRef(null)
      const dialogRef = useRef(null)
      const titleIdRef = useRef(null)
      if (titleIdRef.current === null) {
        modalSequence += 1
        titleIdRef.current = 'drg-dialog-title-' + modalSequence
      }
      // `dismissible:false` while the dialog's own request is in flight: Escape and the backdrop
      // are ignored so a busy connect/delete cannot be left running behind a closed UI (S2-5).
      const dismissible = typeof onClose === 'function' && props.dismissible !== false
      useDialogLayer({ layerRef, dialogRef, onClose, dismissible })
      // A dialog whose title is drawn by its own body (the host-management window) still
      // needs the close affordance, but not an empty header strip above the page title.
      const bare = !props.title && !props.subtitle
      return h(
        'div',
        { className: 'drg-modal-layer', ref: layerRef },
        h('div', {
          className: 'drg-modal-backdrop',
          onClick: dismissible ? onClose : undefined,
          'aria-hidden': 'true',
          'data-dismissible': dismissible ? undefined : 'false',
        }),
        h(
          'div',
          {
            className: 'drg-modal' + (props.wide === true ? ' drg-modal-wide' : ''),
            role: 'dialog',
            'aria-labelledby': props.title ? titleIdRef.current : undefined,
            'aria-label': !props.title && props.ariaLabel ? props.ariaLabel : undefined,
            'aria-busy': props.busy === true ? 'true' : undefined,
            tabIndex: -1,
            ref: dialogRef,
            'data-testid': props.testId,
            'data-bare': bare ? 'true' : undefined,
          },
          box(
            'div',
            'drg-modal-head',
            box(
              'div',
              'drg-modal-titles',
              props.title ? h('h2', { className: 'drg-modal-title', id: titleIdRef.current }, props.title) : null,
              props.subtitle ? box('p', 'drg-modal-subtitle', props.subtitle) : null,
            ),
            typeof onClose === 'function'
              ? h(IconButton, {
                  icon: h(IconClose),
                  label: props.closeLabel || 'Close',
                  // The header × is part of the same dismissal contract as Escape and the
                  // backdrop: while the dialog's request is in flight it is disabled too
                  // (review blocker 3).
                  disabled: !dismissible,
                  onClick: dismissible ? onClose : undefined,
                })
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
          testId: props.testId,
          busy: props.busy === true,
          dismissible: props.busy !== true,
          footer: footerRow(
            h(
              Button,
              {
                variant: 'secondary',
                testId: props.cancelTestId,
                onClick: props.onCancel,
                disabled: props.busy === true,
              },
              props.cancelLabel,
            ),
            h(
              Button,
              { variant: 'danger', testId: props.confirmTestId, onClick: props.onConfirm, busy: props.busy === true },
              props.confirmLabel,
            ),
          ),
        },
        box('p', 'drg-paragraph', props.body),
      )
    }

    /**
     * The confirmation for the destructive "Stop remote DSH" action: it names the process
     * that will be stopped and what survives (the host, its settings and credentials).
     */
    function StopRemoteDialog(props) {
      const t = translatorOf(props)
      return h(ConfirmDialog, {
        title: t('stopRemoteTitle'),
        body: t('stopRemoteBody'),
        confirmLabel: props.busy === true ? t('stopRemoteBusy') : t('stopRemoteConfirm'),
        cancelLabel: t('cancel'),
        busy: props.busy === true,
        testId: 'stop-remote-dialog',
        confirmTestId: 'stop-remote-confirm',
        cancelTestId: 'stop-remote-cancel',
        onConfirm: props.onConfirm,
        onCancel: props.onCancel,
      })
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
      // A restart of the managed remote web is visible on the card itself: the host is
      // `connecting` (not `disconnected`) while it runs, so no "connection lost" shows up.
      const restarting =
        host.status === 'connecting' && host.progress !== null && host.progress.code === 'restarting-remote'
      // The explicit stop is the same kind of one-shot link action, under its own progress code.
      const stopping =
        host.status === 'connecting' && host.progress !== null && host.progress.code === 'stopping-remote'
      // `remote-unreachable` keeps the SSH session on purpose, so a restart is the other way
      // back besides reconnecting (docs/design.md §5.6).
      const recoverable = host.status === 'error' && host.error !== null && host.error.code === 'remote-unreachable'
      const restartAvailable = host.status === 'connected' || restarting || recoverable
      const stopAvailable = host.status === 'connected' || restarting || stopping || recoverable

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
        host.status === 'connecting' && host.progress
          ? h(
              'p',
              { className: 'drg-card-progress', 'data-progress': host.progress.code },
              progressText(t, host.progress),
            )
          : null,
        box(
          'dl',
          'drg-card-meta',
          h('div', null, h('dt', null, t('remoteVersion')), h('dd', null, remoteVersion)),
          h('div', null, h('dt', null, t('lastOpened')), h('dd', null, lastOpened)),
        ),
        // Both fields were already in the contract but never painted: a Host that warns about a
        // shared ~/.dsh or reports a version difference now says so on its card (audit S3).
        host.warning
          ? h(
              'div',
              { 'data-testid': 'host-warning' },
              h(Notice, { tone: 'warn', title: t('hostWarnings') }, resolveText(host.warning, locale)),
            )
          : null,
        host.versionParity && host.versionParity.status === 'different'
          ? h(
              'div',
              { 'data-testid': 'host-version-parity' },
              h(
                Notice,
                { tone: 'warn' },
                resolveText(host.versionParity.message, locale) ||
                  t('versionDifferent', {
                    remote: host.versionParity.remote || '?',
                    local: host.versionParity.local || host.targetVersion || '?',
                  }),
              ),
            )
          : null,
        host.versionParity && host.versionParity.status === 'unknown'
          ? h('p', { className: 'drg-field-hint', 'data-testid': 'host-version-unknown' }, t('versionUnknown'))
          : null,
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
          restartAvailable
            ? h(
                Button,
                {
                  variant: 'ghost',
                  testId: 'host-restart',
                  onClick: () => props.onRestart && props.onRestart(host),
                  disabled: busy || restarting || stopping,
                },
                restarting ? t('cardRestarting') : t('cardRestart'),
              )
            : null,
          stopAvailable
            ? h(
                Button,
                {
                  variant: 'ghost',
                  testId: 'host-stop-remote',
                  onClick: () => props.onStopRemote && props.onStopRemote(host),
                  disabled: busy || restarting || stopping,
                },
                stopping ? t('cardStopping') : t('cardStopRemote'),
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
              // Editing while a link is being built would race the connection's own settings.
              disabled: busy || host.status === 'connecting',
            }),
            h(IconButton, {
              icon: h(IconTrash),
              label: t('cardDelete'),
              testId: 'host-delete',
              onClick: () => props.onDelete && props.onDelete(host),
              disabled: busy || host.status === 'connecting',
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
      // A connecting host owns the connection window (docs/design.md §4.1), so it is not a card
      // here. Restart/stop progress is the exception: that host is not building a new link but
      // finishing a one-shot action, and its card is where the action lives (§5.5/§5.7).
      const isOneShotLinkAction = (host) =>
        host &&
        host.status === 'connecting' &&
        host.progress !== null &&
        (host.progress.code === 'restarting-remote' || host.progress.code === 'stopping-remote')
      const connectingHosts = hosts.filter((host) => host && host.status === 'connecting' && !isOneShotLinkAction(host))
      const visibleHosts = hosts.filter((host) => host && (host.status !== 'connecting' || isOneShotLinkAction(host)))
      const connected = hosts.filter((host) => host && host.status === 'connected').length
      const total = hosts.length
      const busyHostId = props.busyHostId || null
      // Stopping a remote DSH is destructive, so the card action only opens a confirmation;
      // the dialog owns the busy state until the Host answers.
      const [pendingStop, setPendingStop] = useState(null)
      const [stopBusy, setStopBusy] = useState(false)

      const requestStop = (host) => {
        if (host) setPendingStop(host)
      }
      const confirmStop = () => {
        if (pendingStop === null || stopBusy) return
        const host = pendingStop
        setStopBusy(true)
        const work = typeof props.onStopRemote === 'function' ? props.onStopRemote(host) : null
        Promise.resolve(work).then(
          () => {
            setStopBusy(false)
            setPendingStop(null)
          },
          () => {
            setStopBusy(false)
            setPendingStop(null)
          },
        )
      }

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
          connectingHosts.length > 0
            ? h(Notice, { tone: 'info', testId: 'connecting-hosts-note' }, t('managingConnectingHosts'))
            : null,
          visibleHosts.length > 0
            ? h(
                'ul',
                { className: 'drg-host-list', 'data-testid': 'host-list' },
                visibleHosts.map((host) =>
                  h(HostCard, {
                    key: host.id,
                    t,
                    locale,
                    host,
                    busy: busyHostId === host.id,
                    onOpen: props.onOpenHost,
                    onDisconnect: props.onDisconnectHost,
                    onReconnect: props.onReconnectHost,
                    onRestart: props.onRestartHost,
                    onStopRemote: requestStop,
                    onEdit: props.onEditHost,
                    onDelete: props.onDeleteHost,
                    onDiagnose: props.onDiagnoseHost,
                  }),
                ),
              )
            : null,
          pendingStop !== null
            ? h(StopRemoteDialog, {
                key: 'stop-remote:' + pendingStop.id,
                t,
                busy: stopBusy,
                onConfirm: confirmStop,
                onCancel: () => {
                  if (stopBusy) return
                  setPendingStop(null)
                },
              })
            : null,
        )
      }

      // The stream died and the panel is polling: say so instead of silently showing stale
      // numbers, and offer the one action that can restore live updates (audit S2-1). The banner
      // also stays up while a reconnect attempt is in flight (`reconnecting`): only an actual
      // `open`/first frame clears it.
      const liveDegraded = props.mode === 'polling' || props.mode === 'reconnecting'
      const liveBanner = liveDegraded
        ? box(
            'div',
            'drg-live-banner',
            h(
              Notice,
              { tone: 'warn', title: t('liveStreamLostTitle') },
              props.mode === 'reconnecting'
                ? t('liveReconnecting')
                : t('liveStreamLostBody', { seconds: Math.round(POLL_INTERVAL_MS / 1000) }),
            ),
            h(
              Button,
              {
                variant: 'secondary',
                testId: 'live-reconnect',
                onClick: props.onRetryLive,
                disabled: typeof props.onRetryLive !== 'function',
              },
              t('liveReconnect'),
            ),
          )
        : null

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
        liveBanner,
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

    /** The connect phases that own a log line; an unknown id prints as itself. */
    const CONNECT_LOG_PHASES = new Set(['ssh', 'probe', 'bootstrap', 'start', 'tunnel', 'verifying', 'ready'])

    /** A line's text: the Host's bilingual line when present, otherwise the raw message. */
    function connectLogText(entry, locale) {
      const localized = resolveText(entry.text, locale)
      return localized !== '' ? localized : String(entry.message ?? '')
    }

    function connectLogPhaseLabel(t, phase) {
      return CONNECT_LOG_PHASES.has(phase) ? t('connectLogPhase.' + phase) : String(phase)
    }

    function ConnectLog(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
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
            : entries.map((entry) => {
                const phase = typeof entry.phase === 'string' ? entry.phase : ''
                return h(
                  'div',
                  {
                    key: String(entry.seq),
                    className: 'drg-connect-log-line',
                    'data-level': entry.level || 'info',
                    'data-phase': phase === '' ? undefined : phase,
                    'data-boundary': entry.boundary === true ? 'true' : undefined,
                    'data-testid': 'connect-log-line',
                  },
                  h('span', { className: 'drg-connect-log-time', 'aria-hidden': 'true' }, logClock(entry.at)),
                  // The phase each line was written in: scrolling back shows where it stopped.
                  phase === '' ? null : box('span', 'drg-connect-log-phase', connectLogPhaseLabel(t, phase)),
                  box('span', 'drg-connect-log-text', connectLogText(entry, locale)),
                )
              }),
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
        host.warning ? h(Notice, { tone: 'warn', title: t('hostWarnings') }, resolveText(host.warning, locale)) : null,
        host.versionParity && host.versionParity.status === 'different'
          ? h(
              Notice,
              { tone: 'warn' },
              resolveText(host.versionParity.message, locale) ||
                t('versionDifferent', {
                  remote: host.versionParity.remote || '?',
                  local: host.versionParity.local || host.targetVersion || '?',
                }),
            )
          : null,
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

    //#region 9b. host switcher row + remote carrier backends

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
      pushGuestHostRow()
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
          // A half-installed row must be dismantled before a second mount: the old code only
          // dropped the reference, leaving its DOM/listeners behind (audit "reinstall not
          // idempotent").
          if (win.__drgHostRow && typeof win.__drgHostRow.destroy === 'function') win.__drgHostRow.destroy()
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

    /**
     * The row payload for a carrier's own page. A guest must not render other hosts' rows at
     * all: its exit control is bound to its own host, and a forged intent for another host is
     * refused by `sanitizeGuestIntent` (audit review). So the projection is `local + own host`;
     * cross-host switching from a remote page goes through Local first.
     */
    function guestSwitcherPayload(hostId) {
      const payload = switcherPayload()
      return {
        ...payload,
        current: payload.current === hostId ? hostId : 'local',
        hosts: payload.hosts.filter((host) => host.id === hostId),
      }
    }

    function pushGuestHostRow() {
      const entry = shownCarrier()
      if (entry === null || entry.rowInstalled !== true) return
      try {
        entry.backend.pushRow(entry, guestSwitcherPayload(entry.hostId))
      } catch (_error) {
        // the framed page or guest may still be navigating
      }
    }

    function dispatchSwitcherIntent(intent) {
      if (!intent || typeof intent !== 'object') return undefined
      if (typeof switcher.dispatch === 'function') return switcher.dispatch(intent)
      return undefined
    }

    // The capability bridge's local half: link validation and the one new-window call site.
    /**
     * The only URL shape this page will hand to a browser tab or to the OS: an absolute http(s)
     * address with a host and no credentials. `javascript:`, `data:`, `file:` and `blob:` are the
     * obvious ways a framed page could escalate, and they all end here.
     */
    function externalUrlOf(value) {
      if (typeof value !== 'string' || value === '' || value.length > 8192) return null
      let url
      try {
        url = new URL(value)
      } catch (_error) {
        return null
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (url.hostname === '') return null
      if (url.username !== '' || url.password !== '') return null
      return url.href
    }

    /**
     * Open one user-picked link in this page. The framed page cannot do it: a subdocument's
     * `window.open` needs `allow-popups`, a gesture of its own and a place to show the tab, so the
     * request travels here and this document performs it.
     *
     * `noopener,noreferrer` is not negotiable — the opened site must not reach this page's
     * `window.opener`, and the Referer must not carry this page's URL (it holds the local launch
     * token). Those features also make a *successful* open return `null`, so the return value says
     * nothing about whether the browser's popup blocker refused the tab; the click that started it
     * is a real gesture, which is what the blocker actually checks.
     */
    function openExternalUrl(value) {
      const url = externalUrlOf(value)
      if (url === null) return 'blocked'
      const win = localWindow()
      if (win === null || typeof win.open !== 'function') return 'unavailable'
      try {
        win.open(url, '_blank', 'noopener,noreferrer')
      } catch (_error) {
        return 'unavailable'
      }
      return 'opened'
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
        row.setAttribute('tabindex', '0')
        row.setAttribute('aria-haspopup', 'menu')
        row.setAttribute('aria-expanded', 'false')
        row.setAttribute('aria-controls', 'drg-host-row-menu')
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
        menuNode.id = 'drg-host-row-menu'
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
          // Roving focus: the menu itself is one Tab stop, arrows move between its items.
          node.setAttribute('tabindex', '-1')
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
            // The first matching column is the sidebar; a later full-height section is not a
            // better answer, and the old loop took the last one it saw.
            break
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
        var menuItems = function () {
          return Array.prototype.slice.call(menuNode.querySelectorAll('.drg-hr-item'))
        }
        var focusItem = function (index) {
          var items = menuItems()
          if (items.length === 0) return
          var at = Math.max(0, Math.min(items.length - 1, index))
          var node = items[at]
          if (node && typeof node.focus === 'function') node.focus()
        }
        var openMenu = function (focusFirst) {
          // The sidebar clips its children: anchor the fixed menu to the row so it can
          // escape that overflow and sit over the page like a native menu.
          var rect = row.getBoundingClientRect()
          menuNode.style.top = rect.bottom + 4 + 'px'
          menuNode.style.left = rect.left + 'px'
          menuNode.style.width = rect.width + 'px'
          row.classList.add('drg-open')
          row.setAttribute('aria-expanded', 'true')
          if (focusFirst === true) focusItem(0)
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
          openMenu(false)
        })
        // Keyboard parity (audit "host row unreachable by keyboard"): the row is a real button,
        // Enter/Space opens it, arrows walk the menu, Escape closes and returns focus to the row.
        row.addEventListener('keydown', function (event) {
          var key = event.key
          var focusTarget = event.target
          // A real button inside the row keeps its native Enter/Space activation.
          if (focusTarget && focusTarget.classList && focusTarget.classList.contains('drg-hr-act')) return
          var items = menuItems()
          var active = doc.activeElement
          var index = items.indexOf(active)
          var opened = row.classList.contains('drg-open')
          if (key === 'Enter' || key === ' ') {
            event.preventDefault()
            if (index >= 0) {
              // The items are spans: activate the focused one exactly like a click.
              var node = items[index]
              if (typeof node.click === 'function') node.click()
              return
            }
            if (opened) closeMenu()
            else openMenu(true)
            return
          }
          if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (!opened) {
              event.preventDefault()
              openMenu(true)
              if (key === 'ArrowUp') focusItem(menuItems().length - 1)
              return
            }
            if (items.length === 0) return
            event.preventDefault()
            if (index < 0) {
              focusItem(key === 'ArrowDown' ? 0 : items.length - 1)
              return
            }
            var step = key === 'ArrowDown' ? 1 : -1
            focusItem((index + step + items.length) % items.length)
            return
          }
          if (key === 'Home' || key === 'End') {
            if (!opened) return
            event.preventDefault()
            focusItem(key === 'Home' ? 0 : items.length - 1)
            return
          }
          if (key === 'Escape' && opened) {
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
            if (typeof row.focus === 'function') row.focus()
          }
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
     * The remote DSH page's file menu already offers "Download", but a desktop
     * guest session explicitly cancels Chromium downloads. This injected script
     * keeps the page's own menu and, when its download item is chosen, turns the
     * file row's absolute path into an intent the local half can fetch over SFTP.
     * It only touches `win` and its locals (the script is stringified into the guest).
     */
    function mountGuestTools(win) {
      try {
        var doc = win.document
        if (!doc || !doc.documentElement) return 'no-document'
        if (win.__drgGuestTools === true) return 'already'
        // The installed flag is set only once every listener is in place: setting it first made
        // a partial install permanent, because the retry then answered "already" (audit).
        var emit =
          typeof win.__drgBridgeSink === 'function'
            ? win.__drgBridgeSink
            : function (intent) {
                var queue = win.__drgBridgeQueue
                if (!queue || typeof queue.push !== 'function') queue = []
                queue.push(intent)
                win.__drgBridgeQueue = queue
              }
        var lastFile = null
        // The icon is the stable hook; the labels are a fallback for a future icon
        // rename (the eight languages shipped by the file-action plugin).
        var DOWNLOAD_LABELS = [
          '下载',
          'Download',
          'ダウンロード',
          '다운로드',
          'Скачать',
          'Descargar',
          'Télécharger',
          'Herunterladen',
          'Baixar',
        ]
        var clear = function () {
          lastFile = null
        }
        var restoreMenus = function () {
          var hidden = doc.querySelectorAll('[data-drg-guest-hidden]')
          for (var index = 0; index < hidden.length; index += 1) {
            hidden[index].style.display = ''
            hidden[index].removeAttribute('data-drg-guest-hidden')
          }
          var stale = doc.querySelectorAll('[data-drg-dir-download-wrap]')
          for (var staleIndex = 0; staleIndex < stale.length; staleIndex += 1) {
            if (stale[staleIndex].parentNode) stale[staleIndex].parentNode.removeChild(stale[staleIndex])
          }
        }
        var hideMenus = function () {
          // The page's menu closes from its own select handler, which the capture below
          // suppressed. Hide the menu surface (and its backing) instead of replaying a
          // synthetic click: a hidden node cannot eat the next gesture, and the next
          // context menu restores it before the page opens it again.
          try {
            var menus = doc.querySelectorAll('[role="menu"][data-context-menu]')
            for (var menuIndex = 0; menuIndex < menus.length; menuIndex += 1) {
              menus[menuIndex].setAttribute('data-drg-guest-hidden', '1')
              menus[menuIndex].style.display = 'none'
            }
            var backings = doc.querySelectorAll('[data-menu-backing]')
            for (var backingIndex = 0; backingIndex < backings.length; backingIndex += 1) {
              backings[backingIndex].setAttribute('data-drg-guest-hidden', '1')
              backings[backingIndex].style.display = 'none'
            }
          } catch (_error) {
            /* the menu also closes on the next pointer gesture */
          }
        }
        var directoryTimer = null
        /**
         * A directory has no native download item, so append one to the context menu.
         * React owns the menu but the appended wrapper uses the cloned item's classes;
         * the wrapper is removed again on the next context menu.
         */
        var addDirectoryItem = function () {
          if (!lastFile || lastFile.kind !== 'directory') return true
          var menu = doc.querySelector('[role="menu"][data-context-menu]')
          if (!menu) return false
          if (menu.querySelector('[data-drg-dir-download]')) return true
          var template = menu.querySelector('button[role="menuitem"]')
          if (!template) return false
          var wrapper = template.parentElement
          var clone = (wrapper && wrapper !== menu ? wrapper : template).cloneNode(true)
          var item = clone.tagName === 'BUTTON' ? clone : clone.querySelector('[role="menuitem"]')
          if (!item) return false
          item.removeAttribute('id')
          item.disabled = false
          item.removeAttribute('aria-disabled')
          item.setAttribute('data-drg-dir-download', '1')
          var lang = String(
            doc.documentElement.getAttribute('lang') || (win.navigator && win.navigator.language) || '',
          ).toLowerCase()
          var label = lang.indexOf('zh') === 0 ? '下载到本地' : 'Download to this computer'
          var leaf = null
          var spans = item.querySelectorAll('span')
          for (var spanIndex = spans.length - 1; spanIndex >= 0; spanIndex -= 1) {
            if (!spans[spanIndex].querySelector('svg') && spans[spanIndex].children.length === 0) {
              leaf = spans[spanIndex]
              break
            }
          }
          if (leaf) leaf.textContent = label
          else item.setAttribute('aria-label', label)
          var oldIcon = item.querySelector('svg')
          if (oldIcon && oldIcon.parentNode) {
            var ns = 'http://www.w3.org/2000/svg'
            var icon = doc.createElementNS(ns, 'svg')
            icon.setAttribute('width', '16')
            icon.setAttribute('height', '16')
            icon.setAttribute('viewBox', '0 0 24 24')
            icon.setAttribute('fill', 'none')
            icon.setAttribute('stroke', 'currentColor')
            icon.setAttribute('stroke-width', '1.7')
            icon.setAttribute('stroke-linecap', 'round')
            icon.setAttribute('stroke-linejoin', 'round')
            icon.setAttribute('aria-hidden', 'true')
            var iconPath = doc.createElementNS(ns, 'path')
            iconPath.setAttribute('d', 'M12 3v12m0 0 4-4m-4 4-4-4M4 19h16')
            icon.appendChild(iconPath)
            oldIcon.parentNode.replaceChild(icon, oldIcon)
          }
          clone.setAttribute('data-drg-dir-download-wrap', '1')
          var addedFor = lastFile
          clone.addEventListener(
            'click',
            function (event) {
              if (!addedFor || addedFor.kind !== 'directory') return
              event.preventDefault()
              event.stopPropagation()
              if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
              clear()
              emit({ action: 'download-file', kind: 'directory', path: addedFor.path, name: addedFor.name || '' })
              hideMenus()
            },
            true,
          )
          if (wrapper && wrapper !== menu && wrapper.parentElement) {
            wrapper.parentElement.insertBefore(clone, wrapper.nextSibling)
          } else {
            menu.appendChild(clone)
          }
          return true
        }
        var queueDirectoryItem = function () {
          if (directoryTimer !== null) return
          var tries = 0
          var attempt = function () {
            directoryTimer = null
            if (!lastFile || lastFile.kind !== 'directory') return
            if (addDirectoryItem()) return
            tries += 1
            if (tries < 20) {
              directoryTimer =
                typeof win.setTimeout === 'function' ? win.setTimeout(attempt, 40) : setTimeout(attempt, 40)
            }
          }
          attempt()
        }
        var remember = function (target) {
          restoreMenus()
          lastFile = null
          if (!target || typeof target.closest !== 'function') return
          var row = target.closest('li[data-files-entry][data-files-path]')
          if (!row) return
          var kind = row.getAttribute('data-files-entry')
          if (kind !== 'file' && kind !== 'directory') return
          var path = row.getAttribute('data-files-path') || ''
          if (path.charAt(0) !== '/') return
          var name = row.getAttribute('data-files-name') || ''
          if (!name) {
            var label = row.querySelector ? row.querySelector('button') : null
            name = label && label.textContent ? String(label.textContent).trim() : path.split('/').pop() || ''
          }
          lastFile = { kind: kind, path: path, name: name }
          if (kind === 'directory') queueDirectoryItem()
        }
        var interceptDownload = function (item, event) {
          if (!item || !lastFile || lastFile.kind !== 'file') return
          if (item.hasAttribute('data-drg-dir-download')) return
          if (item.disabled === true || item.getAttribute('aria-disabled') === 'true') return
          var icon = item.querySelector
            ? item.querySelector('svg[data-icon="dsw-icon-download-outline-regular"]')
            : null
          var label = String(item.textContent || '').trim()
          if (!icon && DOWNLOAD_LABELS.indexOf(label) < 0) return
          var file = lastFile
          clear()
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          emit({ action: 'download-file', kind: 'file', path: file.path, name: file.name || '' })
          hideMenus()
        }
        doc.addEventListener(
          'contextmenu',
          function (event) {
            remember(event.target)
          },
          true,
        )
        doc.addEventListener(
          'keydown',
          function (event) {
            if (event.key === 'ContextMenu' || (event.shiftKey === true && event.key === 'F10')) {
              remember(event.target)
              return
            }
            if (event.key === 'Escape') {
              clear()
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              var keyboardTarget = event.target
              var keyboardItem =
                keyboardTarget && typeof keyboardTarget.closest === 'function'
                  ? keyboardTarget.closest('[role="menuitem"]')
                  : null
              if (keyboardItem) interceptDownload(keyboardItem, event)
            }
          },
          true,
        )
        // Capture phase: the page's React menu would otherwise read the file itself
        // and hand a Blob to a download Chromium refuses for a guest session.
        doc.addEventListener(
          'click',
          function (event) {
            var target = event.target
            if (!target || typeof target.closest !== 'function') return
            interceptDownload(target.closest('[role="menuitem"]'), event)
          },
          true,
        )
        doc.addEventListener(
          'click',
          function () {
            // Runs after the interception listener above: any click ends the file
            // gesture (the download branch already cleared it before emitting).
            clear()
          },
          true,
        )
        win.__drgGuestTools = true
        return 'installed'
      } catch (_error) {
        return 'error'
      }
    }

    const GUEST_TOOLS_SCRIPT = '(' + mountGuestTools.toString() + ')(window)'
    /**
     * The guest half of the capability bridge. A same-origin subdocument keeps this origin's DOM
     * access but not the browser capabilities a top-level document owns: clipboard writes are
     * refused (`Document is not focused` / `Write permission denied`) and a popup has no handler,
     * so a copy button and a link silently do nothing. This script turns those three requests into
     * intents on the channel the switcher row already uses — `__drgBridgeSink` when the carrier can
     * call back directly, the `__drgBridgeQueue` the desktop carrier drains otherwise — and answers
     * the clipboard one through `__drgCapabilityReply`, so the page can show ✓ or fail visibly.
     * It only touches `win` and its own locals (the script is stringified into the guest).
     */
    function mountCapabilityBridge(win) {
      try {
        var doc = win.document
        if (!doc || !doc.documentElement) return 'no-document'
        if (win.__drgCapabilityBridge === true) return 'already'
        var PromiseCtor = typeof win.Promise === 'function' ? win.Promise : Promise
        var emit =
          typeof win.__drgBridgeSink === 'function'
            ? win.__drgBridgeSink
            : function (intent) {
                var queue = win.__drgBridgeQueue
                if (!queue || typeof queue.push !== 'function') queue = []
                queue.push(intent)
                win.__drgBridgeQueue = queue
                return null
              }
        var UrlCtor = typeof win.URL === 'function' ? win.URL : URL
        // A URL that may leave the frame: absolute http(s), a host, no credentials. Anything else
        // (javascript:, data:, blob:, a relative path) stays inside the framed page.
        var externalUrl = function (value) {
          if (typeof value !== 'string' || value === '' || value.length > 8192) return null
          var url = null
          try {
            url = new UrlCtor(value)
          } catch (_error) {
            return null
          }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
          if (!url.hostname) return null
          if (url.username !== '' || url.password !== '') return null
          return url.href
        }
        var originOf = function () {
          try {
            return win.location && win.location.origin ? win.location.origin : null
          } catch (_error) {
            return null
          }
        }

        // --- clipboard: the top half performs the write, this half reports the answer ----------
        var pending = {}
        var sequence = 0
        var settle = function (id, result) {
          var entry = pending[id]
          if (!entry) return false
          delete pending[id]
          if (entry.timer !== null && typeof win.clearTimeout === 'function') win.clearTimeout(entry.timer)
          if (result && result.ok === true) entry.resolve(true)
          else entry.reject(new Error((result && typeof result.reason === 'string' && result.reason) || 'bridge'))
          return true
        }
        // The desktop carrier cannot reach into the guest, so it answers through this slot.
        win.__drgCapabilityReply = function (payload) {
          if (!payload || typeof payload !== 'object') return false
          return settle(String(payload.id === undefined || payload.id === null ? '' : payload.id), payload)
        }
        var ask = function (intent, timeoutMs) {
          return new PromiseCtor(function (resolve, reject) {
            sequence += 1
            var id = 'drg' + String(sequence)
            intent.id = id
            pending[id] = { resolve: resolve, reject: reject, timer: null }
            if (typeof win.setTimeout === 'function') {
              pending[id].timer = win.setTimeout(function () {
                settle(id, { ok: false, reason: 'timeout' })
              }, timeoutMs)
            }
            var answer = null
            try {
              answer = emit(intent)
            } catch (_error) {
              answer = null
            }
            // The browser carrier calls this module directly and answers with the write's promise.
            if (answer && typeof answer.then === 'function') {
              answer.then(
                function (result) {
                  settle(id, result)
                },
                function () {
                  settle(id, { ok: false })
                },
              )
            }
          })
        }
        // The frame is the document the user just clicked in, so the legacy path can still land
        // the text when the top half reports a refusal.
        var legacyCopy = function (text) {
          try {
            if (!doc.body || typeof doc.execCommand !== 'function') return false
            var area = doc.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.top = '-1000px'
            area.style.opacity = '0'
            doc.body.appendChild(area)
            area.select()
            var ok = doc.execCommand('copy')
            doc.body.removeChild(area)
            return ok === true
          } catch (_error) {
            return false
          }
        }
        var clipboard = null
        try {
          clipboard = win.navigator && win.navigator.clipboard ? win.navigator.clipboard : null
        } catch (_error) {
          clipboard = null
        }
        if (clipboard !== null && typeof clipboard.writeText === 'function') {
          var bridgeWriteText = function (text) {
            var value = text === undefined || text === null ? '' : String(text)
            return ask({ action: 'clipboard-write', text: value }, 4000).then(
              function () {
                return undefined
              },
              function () {
                if (legacyCopy(value)) return undefined
                try {
                  emit({ action: 'notify', tone: 'error', code: 'clipboard-failed' })
                } catch (_error) {
                  /* the local half may be gone */
                }
                throw new Error('clipboard-write-failed')
              },
            )
          }
          try {
            Object.defineProperty(clipboard, 'writeText', {
              configurable: true,
              writable: true,
              value: bridgeWriteText,
            })
          } catch (_error) {
            try {
              clipboard.writeText = bridgeWriteText
            } catch (_error2) {
              /* a browser that freezes the Clipboard object keeps its own writeText */
            }
          }
        }

        // --- links: capture a real external click before the page's own handler swallows it ------
        var onLinkClick = function (event) {
          if (!event || event.defaultPrevented === true) return
          // A modified or non-primary click is the user asking for the browser's own behaviour
          // (new background tab, new window, middle-click paste): leave it to the page and the
          // browser, exactly like the chat view's own `openExternalLink` handler does. Otherwise
          // the bridge would silently take those gestures over.
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          var target = event.target
          if (!target || typeof target.closest !== 'function') return
          // The file menu's download entry is this plugin's own control, never a navigation.
          if (target.closest('[data-drg-dir-download]')) return
          var anchor = target.closest('a[href]')
          if (!anchor || typeof anchor.getAttribute !== 'function') return
          // A `download` anchor keeps its native behaviour: a blob: URL is already refused below.
          if (typeof anchor.hasAttribute === 'function' && anchor.hasAttribute('download')) return
          var raw = anchor.getAttribute('href')
          if (typeof raw !== 'string' || raw === '') return
          var resolved = null
          try {
            resolved = new UrlCtor(raw, doc.baseURI || originOf() + '/')
          } catch (_error) {
            return
          }
          var url = externalUrl(resolved.href)
          if (url === null) return
          // A same-origin link is part of the framed application (the DSH router): leave it alone,
          // a new tab would open the remote UI without its host row.
          var origin = originOf()
          if (origin !== null && resolved.origin === origin) return
          event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          try {
            emit({ action: 'open-external', url: url })
          } catch (_error) {
            /* the local half may be gone */
          }
        }
        doc.addEventListener('click', onLinkClick, true)

        // --- window.open: a resolved web URL belongs to the top-level document --------------------
        var nativeOpen = typeof win.open === 'function' ? win.open : null
        try {
          win.open = function (url, name, features) {
            var raw = typeof url === 'string' ? url : url === undefined || url === null ? '' : String(url)
            var target = externalUrl(raw)
            if (target === null) {
              // `about:blank` is the account login's popup skeleton: it has no URL to hand over,
              // so it keeps the native call (the frame now declares `allow-popups` for it).
              if (nativeOpen === null) return null
              try {
                return nativeOpen.call(win, url, name, features)
              } catch (_error) {
                return null
              }
            }
            try {
              emit({ action: 'open-external', url: target })
            } catch (_error) {
              /* the local half may be gone */
            }
            return null
          }
        } catch (_error) {
          /* a browser that freezes `window.open` keeps the native one */
        }
        // Only claim the bridge once every shim above is in place: a half-installed page must be
        // retried by the next load stop instead of reporting `already` forever.
        win.__drgCapabilityBridge = true
        return 'installed'
      } catch (_error) {
        return 'error'
      }
    }

    const CAPABILITY_BRIDGE_SCRIPT = '(' + mountCapabilityBridge.toString() + ')(window)'

    /**
     * A same-origin frame shares this origin's `localStorage`, so the remote UI and this page would
     * keep their preferences in one place and overwrite each other. Give the frame a private key
     * space: `localStorage` becomes a Storage-shaped view whose keys carry a `drg:<hostId>:`
     * prefix. Writes from the frame can no longer touch a local preference, and its own values
     * survive a local edit because they live under different keys.
     *
     * Boundaries (documented in docs/design.md): values the page read before this injection came
     * from the shared store; `sessionStorage`, cookies and IndexedDB are untouched; a `storage`
     * event from another same-origin document is dropped while it is not this host's key, but only
     * for listeners registered after this script — a listener the page installed at boot already
     * ran.
     */
    function mountGuestStorage(win, hostId) {
      try {
        if (typeof hostId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) return 'bad-id'
        if (!win || typeof win !== 'object') return 'no-window'
        if (win.__drgStoragePartition === hostId) return 'already'
        var raw = null
        try {
          raw = win.localStorage
        } catch (_error) {
          return 'no-storage'
        }
        if (!raw || typeof raw.getItem !== 'function' || typeof raw.setItem !== 'function') return 'no-storage'
        var prefix = 'drg:' + hostId + ':'
        var prefixed = function (key) {
          return prefix + String(key)
        }
        var ownKeys = function () {
          var keys = []
          try {
            for (var index = 0; index < raw.length; index += 1) {
              var key = raw.key(index)
              if (typeof key === 'string' && key.indexOf(prefix) === 0) keys.push(key.slice(prefix.length))
            }
          } catch (_error) {
            return []
          }
          return keys
        }
        var view = {
          get length() {
            return ownKeys().length
          },
          key: function (index) {
            var keys = ownKeys()
            var at = Number(index)
            return at >= 0 && at < keys.length && Math.floor(at) === at ? keys[at] : null
          },
          getItem: function (key) {
            return raw.getItem(prefixed(key))
          },
          setItem: function (key, value) {
            raw.setItem(prefixed(key), String(value))
          },
          removeItem: function (key) {
            raw.removeItem(prefixed(key))
          },
          clear: function () {
            var keys = ownKeys()
            for (var index = 0; index < keys.length; index += 1) raw.removeItem(prefixed(keys[index]))
          },
        }
        try {
          Object.defineProperty(win, 'localStorage', {
            // Non-configurable: the page must not be able to `delete window.localStorage` and
            // fall back to the shared origin store (documented data-hygiene limit, audit S3).
            configurable: false,
            enumerable: true,
            get: function () {
              return view
            },
          })
        } catch (_error) {
          return 'blocked'
        }
        win.__drgStoragePartition = hostId
        // Another document on this origin writing a preference raises `storage` here; the remote
        // UI must not follow the local page. Only keys outside this host's namespace are dropped.
        if (typeof win.addEventListener === 'function') {
          try {
            win.addEventListener(
              'storage',
              function (event) {
                var key = event && typeof event.key === 'string' ? event.key : null
                if (key === null || key.indexOf(prefix) === 0) return
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
              },
              true,
            )
          } catch (_error) {
            /* a window without events still gets the partitioned store */
          }
        }
        return 'installed'
      } catch (_error) {
        return 'error'
      }
    }

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

    /**
     * Where this page can put a remote window: the desktop shell's Chromium guest when its bridge
     * is present, otherwise a same-origin frame (the browser build's carrier). Both paths keep the
     * same pool, switching and teardown behaviour — only how a page is embedded differs.
     */
    function carrierSurface() {
      if (desktopBrowserBridge() !== null) return 'desktop'
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
      // A page loaded from file:// (an Electron build without the guest bridge) cannot host the
      // same-origin view seat: there is no local HTTP origin to proxy through.
      const location = typeof window === 'undefined' ? null : window.location
      if (location && typeof location.protocol === 'string' && !/^https?:$/.test(location.protocol)) return null
      return 'web'
    }

    /** Each surface accepts a different kind of seat: a loopback origin, or a path on this origin. */
    function acceptsCarrierUrl(surface, value) {
      return surface === 'desktop' ? isValidLoopbackUrl(value) : surface === 'web' ? isValidViewPath(value) : false
    }

    const CARRIER_CSS = `
      .drg-carrier-view{position:absolute;left:0;right:0;top:0;bottom:0;border:0;background:var(--dsw-alias-bg-base);pointer-events:auto}
      .drg-carrier-error{position:absolute;left:0;right:0;top:0;bottom:0;z-index:2;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);font:13px var(--dsw-font-family)}
      .drg-carrier-error-text{max-width:52ch;line-height:1.6}
      .drg-carrier-error button{height:32px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
      .drg-carrier-error button:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .drg-carrier-error button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
    `

    /** A switched-to carrier waits this long for its guest document before showing anyway. */
    const CARRIER_READY_TIMEOUT_MS = 1200
    const CARRIER_PAINT_TIMEOUT_MS = 320
    /** A framed page that never fires `load` still needs a visible failure and a way out. */
    const CARRIER_LOAD_TIMEOUT_MS = 25000

    /**
     * The one-shot timer behind a carrier's load failure. A cold remote on a slow SSH tunnel can
     * take well over ten seconds for the whole document, so the timeout is deliberately generous;
     * the timer only fires when no committed document arrived and is cancelled by the first real
     * `load`. Exposed for the fake-clock test (`__test.createLoadGuard`).
     */
    function createLoadGuard(timeoutMs, onTimeout) {
      let timer = null
      let disposed = false
      const cancel = () => {
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
        timer = null
      }
      return {
        arm() {
          if (disposed) return
          cancel()
          if (typeof setTimeout !== 'function') return
          timer = setTimeout(() => {
            timer = null
            if (!disposed && typeof onTimeout === 'function') onTimeout()
          }, timeoutMs)
          unrefTimer(timer)
        },
        cancel,
        dispose() {
          disposed = true
          cancel()
        },
      }
    }
    /** Installing the injected row can fail while the sidebar is still mounting: retry soon. */
    const CARRIER_INSTALL_RETRY_MS = 1500
    const CARRIER_INSTALL_MAX_ATTEMPTS = 8

    /** Set by `apply` (the panel store lives there); a carrier's error layer asks for the local page. */
    let requestLocalPage = null

    function createCarrierErrorLayer(message, options) {
      const opts = options || {}
      const layer = document.createElement('div')
      layer.className = 'drg-carrier-error'
      layer.setAttribute('data-testid', 'remote-overlay-error')
      // A failure that fills the window is an alert: it appears without user action and the only
      // useful move out of it is a button that must be reachable.
      layer.setAttribute('role', 'alert')
      const text = document.createElement('p')
      text.className = 'drg-carrier-error-text'
      text.textContent = typeof message === 'string' ? message : ''
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-testid', 'remote-overlay-back-local')
      button.textContent = typeof opts.localLabel === 'string' && opts.localLabel !== '' ? opts.localLabel : 'Local'
      button.addEventListener('click', () => {
        hideOverlays()
        if (typeof requestLocalPage === 'function') requestLocalPage()
      })
      layer.append(text, button)
      layer.style.display = 'none'
      layer.__drgText = text
      return layer
    }

    function showCarrierError(layer, message) {
      if (!layer) return
      if (layer.__drgText && typeof message === 'string' && message !== '') layer.__drgText.textContent = message
      layer.style.display = 'flex'
    }

    function hideCarrierError(layer) {
      if (!layer) return
      layer.style.display = 'none'
    }
    /**
     * Resolves once the guest has painted frames of its own: a hidden `<webview>`'s guest does not
     * paint, so this is what tells a reveal that there is something to show instead of the empty
     * carrier. Two frames: one to produce content, one to hand it to the embedder.
     */
    const GUEST_PAINT_SCRIPT =
      '(function(){return new Promise(function(resolve){' +
      'if(typeof requestAnimationFrame!=="function"){resolve("no-raf");return}' +
      'requestAnimationFrame(function(){requestAnimationFrame(function(){resolve("ok")})})' +
      '})})()'

    async function installHostRow(entry) {
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return false
      let status
      try {
        status = await view.executeJavaScript(HOST_ROW_SCRIPT)
      } catch (_error) {
        status = 'error'
      }
      // 'collapsed' and 'no-anchor' still mean the handle exists: the next state push
      // places the row as soon as the remote sidebar is wide enough to hold it.
      const live = typeof status === 'string' && status !== 'error' && status !== 'no-document'
      entry.rowInstalled = live
      if (live && carrierPool.current === entry.hostId) pushGuestHostRow()
      return live
    }

    /**
     * Install the guest-side download bridge after every load stop. It shares the
     * row's intent queue, so its install is independent of where the row landed.
     */
    async function installGuestTools(entry) {
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return false
      try {
        const status = await view.executeJavaScript(GUEST_TOOLS_SCRIPT)
        return typeof status === 'string' && status !== 'error' && status !== 'no-document'
      } catch (_error) {
        return false
      }
    }

    /** The capability bridge's guest copy: same channel as the download bridge, one per load stop. */
    async function installCapabilityBridge(entry) {
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return false
      try {
        const status = await view.executeJavaScript(CAPABILITY_BRIDGE_SCRIPT)
        return typeof status === 'string' && status !== 'error' && status !== 'no-document'
      } catch (_error) {
        return false
      }
    }

    /** Hand one bridge answer back to the guest; the desktop carrier has no direct callback. */
    function replyToGuest(entry, id, result) {
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return
      const payload = JSON.stringify({ id: String(id), ok: Boolean(result && result.ok === true) })
      try {
        const answer = view.executeJavaScript(
          'window.__drgCapabilityReply && window.__drgCapabilityReply(' + payload + ')',
        )
        if (answer && typeof answer.catch === 'function') answer.catch(() => {})
      } catch (_error) {
        // the guest may have navigated away before the write finished
      }
    }

    function startHostRowPoll(entry) {
      stopHostRowPoll()
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return
      carrierPool.poll = entry
      // One drain at a time: an overlapping read of the same intent must not dispatch twice.
      let draining = false
      entry.timer = setInterval(() => {
        if (carrierPool.poll !== entry || carrierPool.current !== entry.hostId) return
        if (draining) return
        let pending = null
        try {
          pending = view.executeJavaScript(TAKE_INTENTS_SCRIPT)
        } catch (_error) {
          return
        }
        if (pending === null || typeof pending.then !== 'function') return
        draining = true
        // A guest that stops answering must not keep `draining` true forever: the drain would
        // never run again and the row/capability bridge would go dead silently.
        withTimeout(pending, 5000)
          .then((value) => {
            if (!value || !Array.isArray(value) || value.length === 0 || carrierPool.poll !== entry) return
            for (const intent of value) {
              // A rail report is news about the band, not a click: it moves this page's caption
              // menubar and must never reach the intent dispatch.
              if (isCaptionSidebarIntent(intent)) {
                applyGuestSidebar(
                  entry,
                  intent.collapsed === true,
                  typeof intent.start === 'string' ? intent.start : '',
                )
                continue
              }
              // File intents belong to the host whose guest queued them, and every guest intent
              // goes through the same whitelist/hostId override as the browser frame.
              const safe = sanitizeGuestIntent(intent, entry.hostId)
              const answer = safe === null ? undefined : dispatchSwitcherIntent(safe)
              // A capability intent carries the id its guest is waiting on; answer it even when
              // the dispatch refused it (`ok:false`) so the page can fail instead of hanging.
              if (intent && typeof intent.id === 'string' && intent.id !== '') {
                if (answer && typeof answer.then === 'function') {
                  answer.then(
                    (result) => replyToGuest(entry, intent.id, result),
                    () => replyToGuest(entry, intent.id, { ok: false }),
                  )
                } else {
                  replyToGuest(entry, intent.id, { ok: answer === true })
                }
              }
            }
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

    /**
     * The caption menubar's inset for a band whose sidebar is collapsed or expanded. The guest
     * hands over the value DSH's own rule resolves to there (`84px` collapsed, nothing expanded),
     * so a DSH that changes the number keeps working; the constants above are only the fallback for
     * a guest that cannot answer.
     */
    function captionMenuStart(collapsed, start = '') {
      const raw = typeof start === 'string' ? start.trim() : ''
      // `getComputedStyle` normally resolves the custom property to px; a unitless value is read
      // as px as well, because the old px-only regex dropped a perfectly good number (audit).
      if (/^\d+(?:\.\d+)?(?:px)?$/.test(raw) && Number.parseFloat(raw) <= CAPTION_MENU_MAX)
        return raw.replace(/px$/, '') + 'px'
      return (collapsed === true ? CAPTION_MENU_START_COLLAPSED : CAPTION_MENU_START) + 'px'
    }

    /**
     * Publish where the caption menubar starts. The band normally belongs to the local page, whose
     * own `html[data-windows-titlebar]:has([data-sidebar-collapsed])` rule (and the preload's 48px
     * default behind it) decides the inset, so this only writes while a guest owns the band — inline,
     * which wins over that stylesheet without touching it — and removes the override again when the
     * local page takes the band back, leaving DSH's own rule in charge.
     */
    function setCaptionMenuStart(collapsed, start = '') {
      const target = typeof document === 'undefined' ? null : document.documentElement
      if (target === null || target === undefined || !target.style) return false
      if (typeof target.style.setProperty !== 'function') return false
      if (collapsed === null || collapsed === undefined) {
        if (typeof target.style.removeProperty === 'function') target.style.removeProperty(CAPTION_MENU_VAR)
        return true
      }
      target.style.setProperty(CAPTION_MENU_VAR, captionMenuStart(collapsed, start))
      return true
    }

    /**
     * The band's controls belong to the band's owner (issue #63): the collapsed rail puts the
     * new-session control in the band at 48px, which is exactly where the local page's caption
     * menubar starts until the local sidebar collapses as well. A guest that reserves the band
     * therefore decides that inset, the same way the local sidebar's rule does when it owns it.
     * `collapsed === null` means "this document has not told us yet": the state is forgotten rather
     * than carried over from the page that navigated away.
     */
    function applyGuestSidebar(entry, collapsed, start = '') {
      if (entry === null || entry === undefined) return
      entry.sidebarCollapsed = collapsed === true ? true : collapsed === false ? false : null
      entry.sidebarStart = typeof start === 'string' ? start : ''
      if (carrierPool.current !== entry.hostId || entry.captionApplied !== true) return
      setCaptionMenuStart(entry.sidebarCollapsed === true, entry.sidebarStart)
    }

    /** True when an intent is the guest's rail report rather than a click on the switcher row. */
    function isCaptionSidebarIntent(intent) {
      return intent !== null && typeof intent === 'object' && intent.action === CAPTION_SIDEBAR_INTENT
    }

    /**
     * Guest half: report the remote sidebar's rail state and the caption menubar inset DSH's own
     * rule resolves for it. Both change long after the document loaded, and `executeJavaScript` is
     * the desktop guest's only channel back, so the watcher leaves one intent in the bridge queue
     * the row and the file bridge already use. Returns the same record at install time, which the
     * host adopts before waiting for the next drain.
     */
    function mountSidebarMirror(win) {
      try {
        var doc = win.document
        if (!doc || !doc.documentElement) return 'no-document'
        if (win.__drgSidebarMirror === true) return 'already'
        win.__drgSidebarMirror = true
        // The frame DSH collapses carries the mark its own caption rule keys on. Presence is the
        // signal (a rail is collapsed or it is not); only an explicit "false" says otherwise.
        var read = function () {
          var frame = doc.querySelector('[data-sidebar-collapsed]')
          return frame !== null && frame.getAttribute('data-sidebar-collapsed') !== 'false'
        }
        // The guest carries the desktop marker, so DSH's sidebar rule resolves the menubar inset
        // here too: hand the authoritative value over instead of repeating its number.
        var readStart = function () {
          try {
            if (typeof win.getComputedStyle !== 'function') return ''
            var computed = win.getComputedStyle(doc.documentElement)
            if (!computed || typeof computed.getPropertyValue !== 'function') return ''
            var value = computed.getPropertyValue('--dsh-windows-menu-start')
            return typeof value === 'string' ? value.trim() : ''
          } catch (_error) {
            return ''
          }
        }
        var current = function () {
          return { collapsed: read(), start: readStart() }
        }
        var last = null
        var report = function () {
          var state = current()
          if (last !== null && state.collapsed === last.collapsed && state.start === last.start) return
          last = state
          // Read the queue fresh: the host replaces the array after every drain. The action name
          // has to match CAPTION_SIDEBAR_INTENT (a stringified guest cannot close over it).
          var queue = win.__drgBridgeQueue
          if (!queue || typeof queue.push !== 'function') queue = []
          queue.push({ action: 'caption-sidebar', collapsed: state.collapsed, start: state.start })
          win.__drgBridgeQueue = queue
        }
        if (typeof win.MutationObserver === 'function') {
          new win.MutationObserver(report).observe(doc.documentElement, {
            attributes: true,
            attributeFilter: ['data-sidebar-collapsed'],
            subtree: true,
          })
        }
        report()
        return current()
      } catch (_error) {
        return 'error'
      }
    }

    const SIDEBAR_MIRROR_SCRIPT = '(' + mountSidebarMirror.toString() + ')(window)'

    /**
     * One round trip that hands this guest's queued intents over and clears them together. Reading
     * (the old `window.__drgBridgeQueue || []`) and clearing in two calls left a window for an
     * intent queued in between to be wiped — and a wiped rail report never comes back, because the
     * guest already recorded that state as reported.
     */
    const TAKE_INTENTS_SCRIPT = '(function(){var q=window.__drgBridgeQueue||[];window.__drgBridgeQueue=[];return q})()'

    /**
     * Install the rail watcher in the shown guest and adopt what it reports right away; the row's
     * intent poll only carries the changes that follow.
     */
    async function installSidebarMirror(entry) {
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return false
      let state = null
      try {
        state = await view.executeJavaScript(SIDEBAR_MIRROR_SCRIPT)
      } catch (_error) {
        state = null
      }
      if (state === null || typeof state !== 'object' || Array.isArray(state)) return false
      if (typeof state.collapsed !== 'boolean') return false
      applyGuestSidebar(entry, state.collapsed, typeof state.start === 'string' ? state.start : '')
      return true
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
      if (carrierPool.current === entry.hostId) ownCaptionBand(entry, entry.captionApplied === true)
    }

    function setCaptionLive(live) {
      if (typeof document === 'undefined' || !document.documentElement) return
      if (live === true) document.documentElement.classList.add(CAPTION_LIVE_CLASS)
      else document.documentElement.classList.remove(CAPTION_LIVE_CLASS)
    }

    /**
     * The band changed hands. A guest that reserves it gets the marks this page needs while it is
     * in front — the shell's caption menus above the guest, and the menubar inset from the guest's
     * own rail — and the local page takes both back when no guest owns the band.
     */
    function ownCaptionBand(entry, owned) {
      const mine = owned === true && entry !== null && entry !== undefined
      setCaptionLive(mine)
      // A guest that has not reported its rail yet keeps the band's own default (the shell's 48px),
      // never a value remembered from the document it replaced.
      setCaptionMenuStart(mine ? entry.sidebarCollapsed === true : null, mine ? entry.sidebarStart : '')
    }

    async function createDesktopCarrier(hostId, url, message, options) {
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
      // nothing, and keep a way back to the local page (audit "failed layer has no exit").
      const errorLayer = createCarrierErrorLayer(message, { localLabel: options.localLabel })

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
        kind: 'desktop',
        backend: DESKTOP_CARRIER,
        hostId,
        lease: String(reservation.lease),
        root,
        view,
        grip,
        caption,
        /** Set once the guest page carries the desktop marker (never in a band-less window). */
        captionApplied: false,
        /** The guest's rail state as it last reported it; null until the mirror says. */
        sidebarCollapsed: null,
        /** The menubar inset the guest's own DSH rule resolved to; empty when it could not say. */
        sidebarStart: '',
        url,
        rowInstalled: false,
        failed: false,
        timer: null,
        /** True once the guest committed a document (or failed): a reveal can stop waiting. */
        ready: false,
        readyWaiters: [],
        /** Bumped per reveal, so a reveal that lost the window cannot paint over the next one. */
        revealToken: 0,
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
        // The document that just went away says nothing about this one's rail: forget its state
        // instead of writing it onto this page's band once more (the mirror reports again below).
        applyGuestSidebar(entry, null)
        applyGuestCaption(entry).then((applied) => {
          if (entry.view !== view) return
          syncCarrierCaption(entry, applied)
        })
      })
      view.addEventListener('did-stop-loading', () => {
        if (entry.view !== view) return
        errorLayer && hideCarrierError(errorLayer)
        entry.failed = false
        // The document is there: a switch waiting for it may show the guest from here on.
        markCarrierReady(entry)
        // Re-install after *every* load stop: the remote page reloading wipes the injected DOM, and a one-shot install
        // would leave the window without any control. Both scripts are idempotent inside the page, and the caption has
        // to land before the row measures the sidebar it is placed into.
        applyGuestCaption(entry)
          .then(async (applied) => {
            if (entry.view !== view) return false
            syncCarrierCaption(entry, applied)
            // A guest that reserved the band also owns the caption menubar's inset: learn its rail
            // state before the row measures the sidebar it is placed into.
            await installSidebarMirror(entry)
            if (entry.view !== view) return false
            return installHostRow(entry)
          })
          .then(async (live) => {
            if (entry.view !== view) return
            // The download bridge is independent of the row's target: install it even
            // when the sidebar is collapsed and the row had nowhere to land yet.
            const tools = await installGuestTools(entry)
            if (entry.view !== view) return
            // Same channel, its own install: a collapsed sidebar must not cost the guest its
            // links and clipboard any more than it costs it the file bridge.
            const capabilities = await installCapabilityBridge(entry)
            if (entry.view !== view) return
            // Each committed document is a fresh install attempt; a collapsed / not-yet-mounted
            // sidebar retries with backoff instead of leaving the guest without its row.
            entry.installAttempts = 0
            if (!live || !tools || !capabilities) scheduleCarrierInstall(entry)
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
        showCarrierError(errorLayer)
        // The failure line is the page now: show it rather than wait for a frame that never comes.
        markCarrierReady(entry)
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

    // --- web backend: same-origin frame, used whenever the desktop guest bridge is absent -------

    /**
     * The browser build has no guest seat, so the remote page is framed on this origin and the
     * local proxy forwards it to the host's tunnel. Same origin is what lets the row and the file
     * bridge be injected below; it is also why the frame must never navigate off the view prefix.
     */
    function createWebCarrier(hostId, url, message, options) {
      const root = document.createElement('div')
      root.id = OVERLAY_ROOT_ID + '-' + (hostId || 'host')
      root.setAttribute('data-testid', 'remote-overlay')
      root.setAttribute('data-host-id', hostId)
      root.style.cssText = [
        'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483000',
        'overflow:hidden;background:var(--dsw-alias-bg-base)',
      ].join(';')
      const style = document.createElement('style')
      style.textContent = CARRIER_CSS
      // A frame that never loads would otherwise be a blank window; say why instead, and keep a
      // button that hands the window back to the local page.
      const errorLayer = createCarrierErrorLayer(message, { localLabel: options.localLabel })
      const frame = document.createElement('iframe')
      frame.className = 'drg-carrier-view drg-carrier-frame'
      frame.setAttribute('data-testid', 'remote-frame')
      frame.setAttribute('title', 'Remote DSH')
      // No sandbox: it would sever the same-origin access this backend depends on. The URL is
      // re-checked against the view prefix before it is assigned (see acceptsCarrierUrl).
      // `allow` can only narrow what the browser grants a subdocument, so it is not the fix for a
      // capability the frame cannot hold (see the capability bridge): it names the ones the remote
      // page may legitimately use — clipboard, the voice input's microphone, fullscreen, and the
      // account login's `about:blank` popup. No `allow-popups-to-escape-sandbox`: the frame is not
      // sandboxed, so a popup already escapes into this origin.
      frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone; fullscreen; popups')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      const entry = {
        kind: 'web',
        backend: WEB_CARRIER,
        hostId,
        root,
        frame,
        url,
        errorLayer,
        rowInstalled: false,
        ready: false,
        readyWaiters: [],
        revealToken: 0,
        timer: null,
        installAttempts: 0,
        installTimer: null,
        /** Arms the "the document never committed" timer for this navigation. */
        loadGuard: null,
        /** What the frame shows when the loaded document is not the DSH UI. */
        notDshMessage: typeof message === 'string' ? message : '',
      }
      frame.addEventListener('load', () => onWebFrameLoad(entry))
      root.append(style, frame, errorLayer)
      document.body.appendChild(root)
      entry.loadGuard = createLoadGuard(CARRIER_LOAD_TIMEOUT_MS, () => {
        if (!carrierPool.entries.includes(entry)) return
        if (entry.ready === true) return
        showCarrierError(entry.errorLayer)
        markCarrierReady(entry)
      })
      // Assign after the listener and the element are in place, so the first load is observed.
      frame.src = url
      entry.loadGuard.arm()
      return entry
    }

    function webWindow(entry) {
      try {
        const win = entry.frame && entry.frame.contentWindow
        if (!win) return null
        // Reading a cross-origin frame's document throws; this carrier only accepts same-origin.
        void win.document
        return win
      } catch (_error) {
        return null
      }
    }

    function onWebFrameLoad(entry) {
      if (entry === null || entry.kind !== 'web') return
      const win = webWindow(entry)
      // The initial about:blank of a freshly appended iframe can dispatch `load` before the
      // assigned URL commits. It is not the remote document, so it must not be mistaken for a
      // non-DSH page; the load timeout owns the case where the real URL never arrives.
      try {
        if (win && win.location && win.location.href === 'about:blank') return
      } catch (_error) {
        // a cross-origin document is handled below (the frame is reset to its view path)
      }
      if (entry.loadGuard) entry.loadGuard.cancel()
      if (win === null) {
        // The framed page left this origin (an external link, an OAuth hop): a cross-origin
        // frame would hide the host switcher and trap the window there, so bring it back.
        try {
          entry.frame.src = entry.url
        } catch (_error) {
          // a detached frame reports through the next load
        }
        return
      }
      // The proxy can answer 200 with an error page (or the Host can hand out a wrong path):
      // detect that this document is not the DSH UI and give the user the way out instead of a
      // frame with no switcher (audit "failure layer always display:none").
      let isDsh = false
      try {
        const doc = win.document
        isDsh = Boolean(doc && (doc.querySelector('#root') || doc.querySelector('[data-dsh-root]')))
      } catch (_error) {
        isDsh = false
      }
      if (!isDsh) {
        showCarrierError(entry.errorLayer, entry.notDshMessage || '')
        markCarrierReady(entry)
        return
      }
      hideCarrierError(entry.errorLayer)
      markCarrierReady(entry)
      const installed = installWebCarrier(entry, win)
      if (!installed) scheduleCarrierInstall(entry)
      if (carrierPool.current === entry.hostId) pushGuestHostRow()
    }

    /**
     * A row that failed to install because the sidebar was still mounting must not stay missing
     * for the life of the window (audit "install failure never retried"). Retry with a growing
     * delay, capped, and stop once the carrier is gone or the row is live.
     */
    function stopCarrierInstall(entry) {
      if (entry === null || entry === undefined) return
      if (entry.installTimer !== null && entry.installTimer !== undefined) {
        if (typeof clearTimeout === 'function') clearTimeout(entry.installTimer)
        entry.installTimer = null
      }
    }
    function scheduleCarrierInstall(entry) {
      if (entry === null || entry === undefined || entry.installTimer) return
      if (!carrierPool.entries.includes(entry)) return
      if ((entry.installAttempts || 0) >= CARRIER_INSTALL_MAX_ATTEMPTS) return
      const delay = CARRIER_INSTALL_RETRY_MS * Math.min(8, 2 ** (entry.installAttempts || 0))
      entry.installAttempts = (entry.installAttempts || 0) + 1
      entry.installTimer = setTimeout(async () => {
        entry.installTimer = null
        if (!carrierPool.entries.includes(entry)) return
        let installed = false
        try {
          if (entry.kind === 'web') {
            const win = webWindow(entry)
            installed = win ? installWebCarrier(entry, win) : false
          } else {
            // A desktop guest gets the same retry for all three injections: the row, the file
            // bridge and the capability bridge are independent and each can fail while the
            // sidebar is still mounting.
            installed = await installHostRow(entry)
            await installGuestTools(entry)
            await installCapabilityBridge(entry)
          }
        } catch (_error) {
          installed = false
        }
        if (installed) {
          entry.installAttempts = 0
          if (carrierPool.current === entry.hostId) {
            pushGuestHostRow()
            if (typeof entry.backend.poll === 'function') entry.backend.poll(entry)
          }
          return
        }
        scheduleCarrierInstall(entry)
      }, delay)
      unrefTimer(entry.installTimer)
    }

    /**
     * Inject the host row and the file bridge into the framed page. Both are ordinary functions
     * taking its window, so nothing is evaluated as a string (a CSP without 'unsafe-eval' cannot
     * break them) and the intent sink is a direct call back into this module.
     */
    /** Guest actions that can never target another host. */
    const GUEST_ACTIONS = new Set([
      'download-file',
      'open-external',
      'clipboard-write',
      'notify',
      'add',
      'manage',
      'disconnect',
    ])

    /**
     * The trust boundary for everything a framed/guest page can ask the local half to do. The
     * document inside the carrier is the user's own remote DSH, but its intents used to be handed
     * to `switcher.dispatch` unchanged: a page could switch the whole window to any host id or
     * disconnect any host (audit "intent trust"). Now:
     *   - only the known actions pass (unknown actions are dropped);
     *   - a download or a disconnect is forced to this carrier's host, so a crafted `hostId` in
     *     the intent cannot reach a different one;
     *   - a host switch is only accepted for `local` or this carrier's own host; switching to a
     *     third host from a remote page goes through Local first (docs/design.md §4.8/§7).
     */
    function sanitizeGuestIntent(intent, hostId) {
      if (!intent || typeof intent !== 'object') return null
      const action = typeof intent.action === 'string' ? intent.action : ''
      if (action !== '' && GUEST_ACTIONS.has(action)) {
        if (action === 'download-file') {
          const kind = intent.kind === 'directory' ? 'directory' : 'file'
          const path = typeof intent.path === 'string' ? intent.path : ''
          if (path === '' || path.charAt(0) !== '/') return null
          return {
            action,
            hostId,
            kind,
            path,
            name: typeof intent.name === 'string' ? intent.name : '',
          }
        }
        if (action === 'disconnect') {
          // The row a guest sees only contains Local and its own host, so the only legitimate
          // exit is its own. A forged id for another host is refused instead of being rewritten
          // into "disconnect myself" (review blocker 1).
          return intent.hostId === hostId ? { action, hostId } : null
        }
        if (action === 'clipboard-write') {
          return {
            action,
            id: typeof intent.id === 'string' ? intent.id : undefined,
            text: typeof intent.text === 'string' ? intent.text : '',
          }
        }
        if (action === 'open-external') return { action, url: intent.url }
        if (action === 'notify') return { action, code: intent.code, tone: intent.tone, text: intent.text }
        return { action }
      }
      const target = typeof intent.target === 'string' ? intent.target : ''
      if (target === 'local' || (hostId !== '' && target === hostId)) return { target }
      return null
    }

    /** The sink handed to a framed page: sanitize, then dispatch (and report a refusal). */
    function guestIntentSink(entry) {
      return (intent) => {
        const safe = sanitizeGuestIntent(intent, entry.hostId)
        if (safe === null) return { ok: false, reason: 'blocked-intent' }
        return dispatchSwitcherIntent(safe)
      }
    }

    function installWebCarrier(entry, existingWindow) {
      const win = existingWindow ?? webWindow(entry)
      if (!win) {
        entry.rowInstalled = false
        return false
      }
      try {
        // The page calls this function directly, so the host id is bound here rather than read
        // from the intent (a guest-supplied hostId must never win).
        win.__drgBridgeSink = guestIntentSink(entry)
      } catch (_error) {
        return false
      }
      // `mountHostRow` reports one of its own status strings; a throw means the row is unusable.
      let row
      try {
        row = mountHostRow(win)
      } catch (_error) {
        row = 'error'
      }
      const live = typeof row === 'string' && row !== 'error' && row !== 'no-document'
      entry.rowInstalled = live
      if (live) pushWebCarrierRow(entry, guestSwitcherPayload(entry.hostId))
      try {
        mountGuestTools(win)
      } catch (_error) {
        // the download bridge is optional; the remote window itself still works
      }
      // Links, clipboard writes and notices cross the same channel; each install is independent,
      // so a page that refuses one of them still gets the others.
      try {
        mountCapabilityBridge(win)
      } catch (_error) {
        // the capability bridge is best effort: the framed page keeps its own behaviour
      }
      try {
        // The frame shares this origin's store; give it the host's own key space.
        mountGuestStorage(win, entry.hostId)
      } catch (_error) {
        // an unpartitioned frame is the old behaviour, not a broken window
      }
      return live
    }

    function pushWebCarrierRow(entry, payload) {
      try {
        const win = entry.frame && entry.frame.contentWindow
        if (win && win.__drgHostRow && typeof win.__drgHostRow.update === 'function') {
          win.__drgHostRow.update(payload)
        }
      } catch (_error) {
        // the frame may still be navigating
      }
    }

    /** Desktop guest backend: the shell hands out a Chromium guest lease per host. */
    const DESKTOP_CARRIER = {
      kind: 'desktop',
      create: (hostId, url, message, options) => createDesktopCarrier(hostId, url, message, options),
      load: async (entry, url) => {
        entry.url = url
        try {
          await entry.view.loadURL(url)
        } catch (_error) {
          // the guest reports navigation failures through did-fail-load
        }
      },
      pushRow: (entry, payload) => {
        try {
          const answer = entry.view.executeJavaScript(
            'window.__drgHostRow && window.__drgHostRow.update(' + JSON.stringify(payload) + ')',
          )
          if (answer && typeof answer.catch === 'function') answer.catch(() => {})
        } catch (_error) {
          // the guest may still be navigating
        }
      },
      waitReady: async (entry) => {
        if (entry.ready !== true) await waitForCarrierReady(entry, CARRIER_READY_TIMEOUT_MS)
        await waitForGuestPaint(entry, CARRIER_PAINT_TIMEOUT_MS)
      },
      dispose: (entry) => disposeDesktopCarrier(entry),
      poll: (entry) => startHostRowPoll(entry),
    }

    /** Web frame backend: a same-origin iframe, warmed and hidden exactly like the guest. */
    const WEB_CARRIER = {
      kind: 'web',
      create: (hostId, url, message, options) => createWebCarrier(hostId, url, message, options),
      load: (entry, url) => {
        entry.url = url
        entry.rowInstalled = false
        entry.ready = false
        entry.installAttempts = 0
        stopCarrierInstall(entry)
        try {
          entry.frame.src = url
          if (entry.loadGuard) entry.loadGuard.arm()
        } catch (_error) {
          // a frame that refuses a navigation reports it through the load event
        }
      },
      pushRow: (entry, payload) => pushWebCarrierRow(entry, payload),
      waitReady: async () => true,
      dispose: (entry) => disposeWebCarrier(entry),
      poll: null,
    }

    /** Build the carrier that fits this window: guest when the shell offers one, frame otherwise. */
    function createCarrier(hostId, url, message, options) {
      const surface = carrierSurface()
      if (surface === null) return null
      return surface === 'desktop'
        ? createDesktopCarrier(hostId, url, message, options)
        : createWebCarrier(hostId, url, message, options)
    }

    function disposeWebCarrier(entry) {
      stopCarrierInstall(entry)
      if (entry.loadGuard) entry.loadGuard.dispose()
      try {
        entry.frame.src = 'about:blank'
      } catch (_error) {
        // the frame may already be detached
      }
      if (entry.root.parentNode !== null) entry.root.parentNode.removeChild(entry.root)
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

    /** One frame of this page, so the compositor has committed what was just changed here. */
    function nextLocalFrame() {
      return new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => finish(true))
        // An occluded window (or a windowless test) schedules no frames: never wait for one.
        if (typeof setTimeout === 'function') unrefTimer(setTimeout(() => finish(false), 60))
      })
    }

    /** Resolve once the guest has painted frames of its own; false when it never answers. */
    function waitForGuestPaint(entry, timeoutMs) {
      const view = entry && entry.view
      if (!view || typeof view.executeJavaScript !== 'function') return Promise.resolve(false)
      let timer = null
      const painted = Promise.resolve()
        .then(() => view.executeJavaScript(GUEST_PAINT_SCRIPT))
        .then(
          (value) => value === 'ok' || value === 'no-raf',
          () => false,
        )
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        unrefTimer(timer)
      })
      return Promise.race([painted, expired]).then((paintedNow) => {
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
        return paintedNow
      })
    }

    /** The guest committed a document (or failed to): a reveal no longer has to wait for it. */
    function markCarrierReady(entry) {
      if (entry === null || entry === undefined) return
      entry.ready = true
      const waiters = Array.isArray(entry.readyWaiters) ? entry.readyWaiters : []
      entry.readyWaiters = []
      for (const resolve of waiters) resolve(true)
    }

    function waitForCarrierReady(entry, timeoutMs) {
      if (entry.ready === true) return Promise.resolve(true)
      return new Promise((resolve) => {
        entry.readyWaiters.push(resolve)
        const timer = setTimeout(() => resolve(false), timeoutMs)
        unrefTimer(timer)
      })
    }

    /**
     * Make a carrier visible without painting its empty frame first. The desktop guest has no
     * surface while hidden, so revealing it as-is paints the carrier's own background; the browser
     * frame keeps its last frame, so it only needs the same one-frame opacity handoff. The carrier
     * goes up transparent, waits for its content (guest paint, or the frame's own compositor), and
     * only then becomes opaque. A reveal that lost its turn leaves the carrier hidden.
     */
    async function revealCarrier(entry) {
      const token = (entry.revealToken ?? 0) + 1
      entry.revealToken = token
      entry.root.style.display = ''
      entry.root.style.opacity = '0'
      // Still transparent: the local page underneath stays the one receiving clicks.
      entry.root.style.pointerEvents = 'none'
      await nextLocalFrame()
      await entry.backend.waitReady(entry)
      await nextLocalFrame()
      if (entry.revealToken !== token || carrierPool.current !== entry.hostId) return
      entry.root.style.pointerEvents = ''
      entry.root.style.opacity = ''
    }

    async function showOverlayNow(hostId, options) {
      const url = typeof options.url === 'string' ? options.url : ''
      let entry = carrierOf(hostId)
      const reused = entry !== null
      const surface = entry === null ? carrierSurface() : entry.kind
      // The revision of the attach this call actually navigated to. Only a real navigation
      // (a new carrier, or a reload of an existing one) may claim the new revision.
      let navigatedRev = null
      if (entry === null) {
        if (surface === null) return { ok: false, reason: 'acquire-failed' }
        if (!acceptsCarrierUrl(surface, url)) return { ok: false, reason: 'bad-url' }
        entry = await createCarrier(hostId, url, options.message, options)
        if (entry === null) return { ok: false, reason: 'acquire-failed' }
        navigatedRev = options.viewRev
        // The user moved on (another host, or back to local) while this one was being
        // built: drop it instead of stealing the window.
        if (carrierPool.wanted !== hostId) {
          await disposeCarrier(entry)
          return { ok: false, reason: 'superseded' }
        }
      } else if (
        url !== '' &&
        (entry.url !== url || (Number.isInteger(options.viewRev) && entry.viewRev !== options.viewRev)) &&
        acceptsCarrierUrl(entry.kind, url)
      ) {
        // A reconnect or a remote restart hands out a new one-shot URL and a new attach
        // revision: the warm page is stale, reload it.
        await entry.backend.load(entry, url)
        navigatedRev = options.viewRev
      }
      // The localized "not a DSH document" line is owned by the caller; a reload reuses the
      // entry but may carry a fresh translation.
      if (typeof options.message === 'string' && options.message !== '') entry.notDshMessage = options.message
      // Every caller (including the reuse branch) must respect the last request: the carrier
      // build is async, and a stale call used to take the window back from the host the user
      // actually chose (audit "wanted race").
      if (carrierPool.wanted !== hostId) return { ok: false, reason: 'superseded' }
      // Remember which attach this carrier was navigated for: the next attach invalidates it.
      if (navigatedRev !== null && Number.isInteger(navigatedRev)) entry.viewRev = navigatedRev
      // A desktop guest whose page failed is not worth showing as-is: retry it once.
      if (reused && entry.kind === 'desktop' && entry.failed === true) {
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
      const alreadyShown = carrierPool.current === hostId && entry.root.style.display !== 'none'
      carrierPool.current = hostId
      if (alreadyShown) {
        entry.root.style.pointerEvents = ''
        entry.root.style.opacity = ''
      } else {
        // Rendered over the next frames, once the carrier has something to show.
        revealCarrier(entry).catch(() => {})
      }
      // The band belongs to this guest now: keep the shell's caption menus above it, but
      // only when the guest actually reserved the band (otherwise the local band is intact).
      ownCaptionBand(entry, entry.captionApplied === true)
      updateSwitcher({ current: hostId })
      if (entry.rowInstalled === true) {
        pushGuestHostRow()
        if (typeof entry.backend.poll === 'function') entry.backend.poll(entry)
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
      ownCaptionBand(null, false)
    }

    /** Set by the overlay host: a disposed carrier invalidates the launch URL kept for it. */
    let onCarrierDisposed = null

    /** Tear one carrier down. Safe for one that never entered the pool. */
    async function disposeCarrier(entry) {
      if (entry === null || entry === undefined) return
      stopCarrierInstall(entry)
      if (carrierPool.poll === entry) stopHostRowPoll()
      carrierPool.entries = carrierPool.entries.filter((item) => item !== entry)
      // The window that filled the page is going away, so the local page is next: the row has to follow here as well.
      // The React state that asked for the teardown is not enough - a disconnect arrives through a subscription created
      // at mount, whose closure holds the target from that render, so it cannot clear it.
      const wasShown = carrierPool.current === entry.hostId
      if (wasShown) {
        carrierPool.current = null
        ownCaptionBand(null, false)
      }
      await entry.backend.dispose(entry)
      // The launch URL for this host is one-shot and its tunnel is gone: keep no copy of it.
      if (typeof onCarrierDisposed === 'function') onCarrierDisposed(entry.hostId)
      if (wasShown) updateSwitcher({ current: 'local' })
    }

    /** Hand one desktop guest back to the shell: injected row, DOM, then the lease itself. */
    async function disposeDesktopCarrier(entry) {
      if (entry.view !== null && entry.rowInstalled === true) {
        try {
          const destroyed = entry.view.executeJavaScript('window.__drgHostRow && window.__drgHostRow.destroy()')
          if (destroyed && typeof destroyed.catch === 'function') destroyed.catch(() => {})
        } catch (_error) {
          // the guest may already be gone
        }
      }
      if (entry.root.parentNode !== null) entry.root.parentNode.removeChild(entry.root)
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
      ownCaptionBand(null, false)
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

    /**
     * The ranges the Host actually enforces (`src/settings.js` clamps to them). The Client now
     * checks the same numbers before it saves, so a value is either accepted unchanged on both
     * sides or rejected with a field error — never silently rewritten by the Host. `__test.limits`
     * keeps this table pinned to the Host's behaviour in `test/unit/client.test.js`.
     */
    const HOST_LIMITS = {
      defaultPort: { min: 1, max: 65535 },
      connectTimeoutSec: { min: 5, max: 300 },
      idleMinutes: { min: 1, max: 1440 },
      maxAttempts: { min: 0, max: 20 },
      baseDelayMs: { min: 100, max: 30000 },
    }
    /** A profile name DSH can boot: one safe path segment, and never `desktop`. */
    const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
    function isValidProfileName(value) {
      const text = typeof value === 'string' ? value.trim() : ''
      return text !== '' && PROFILE_PATTERN.test(text) && text.toLowerCase() !== 'desktop'
    }
    function inRange(value, limit) {
      const number = toInt(value, NaN)
      return Number.isInteger(number) && number >= limit.min && number <= limit.max
    }

    function toInt(value, fallback) {
      const number =
        typeof value === 'number' ? value : Number(String(value === undefined || value === null ? '' : value).trim())
      return Number.isFinite(number) && Number.isInteger(number) ? number : fallback
    }

    /**
     * Legacy Hosts only expose `addressMasked`; this reads a port out of it. Bracketed IPv6
     * (`user@[fe80::1]:2222`) carries one; a bare IPv6 (`user@fe80::1`) never does, so its last
     * colon-separated group is not a port. New Hosts expose `port`/`username`, and the editor reads
     * those directly (see `initialDraft`).
     */
    function parseMaskedAddress(masked) {
      const text = String(masked || '')
      const result = { username: '', port: null }
      const at = text.lastIndexOf('@')
      if (at >= 0) result.username = text.slice(0, at)
      const tail = at >= 0 ? text.slice(at + 1) : text
      const bracketed = tail.match(/^\[([^\]]+)\](?::(\d+))?$/)
      if (bracketed) {
        result.port = bracketed[2] ? Number(bracketed[2]) : null
        return result
      }
      // An unbracketed address with more than one colon is IPv6: nothing after the last colon is
      // a port (`fe80::1` used to yield port 1 here).
      if ((tail.match(/:/g) || []).length > 1) return result
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

    /** One validation failure names the field so the form can mark and focus it, not only toast it. */
    function fieldError(field, code) {
      return { field, code }
    }

    function validateHostDraft(draft, options = {}) {
      if (!String(draft.name || '').trim()) return fieldError('name', 'wizard.validationName')
      const address = String(draft.address || '').trim()
      if (!address) return fieldError('address', 'wizard.validationAddress')
      if (looksLikeWebAddress(address)) return fieldError('address', 'wizard.validationAddressUrl')
      if (!inRange(draft.port, HOST_LIMITS.defaultPort)) return fieldError('port', 'wizard.validationPort')
      if (draft.keepAlive === 'idle' && !inRange(draft.idleMinutes, HOST_LIMITS.idleMinutes)) {
        return fieldError('idleMinutes', 'wizard.validationIdleMinutes')
      }
      // An edit that leaves authentication untouched keeps the stored key, so an
      // empty field is only an error when this save actually sends auth.
      const requireKeyPath = options.requireKeyPath !== false
      if (draft.authType === 'key' && requireKeyPath && !String(draft.keyPath || '').trim()) {
        return fieldError('keyPath', 'wizard.validationKeyPath')
      }
      if (
        draft.authType === 'password' &&
        options.requirePassword === true &&
        String(draft.password || '').trim() === ''
      ) {
        return fieldError('password', 'wizard.validationPassword')
      }
      return null
    }

    /** The settings modal validates against the same table the Host clamps with. */
    function validateSettingsDraft(draft) {
      if (!inRange(draft.defaultPort, HOST_LIMITS.defaultPort)) {
        return fieldError('defaultPort', 'settings.validationPort')
      }
      if (!inRange(draft.connectTimeoutSec, HOST_LIMITS.connectTimeoutSec)) {
        return fieldError('connectTimeoutSec', 'settings.validationTimeout')
      }
      if (!inRange(draft.maxAttempts, HOST_LIMITS.maxAttempts)) {
        return fieldError('maxAttempts', 'settings.validationAttempts')
      }
      if (!inRange(draft.baseDelayMs, HOST_LIMITS.baseDelayMs)) {
        return fieldError('baseDelayMs', 'settings.validationBaseDelay')
      }
      if (!isValidProfileName(draft.profile)) return fieldError('profile', 'settings.validationProfile')
      return null
    }

    function initialDraft(mode, host, settings) {
      const defaults = settings && typeof settings === 'object' ? settings : {}
      const auto = defaults.autoReconnect && typeof defaults.autoReconnect === 'object' ? defaults.autoReconnect : {}
      if (mode === 'edit' && host) {
        // Read the plain fields the Host exposes; the masked address is presentation only and
        // parsing it back used to invent a port (`user@fe80::1` -> 1) or overwrite the default
        // port with 22. The parse stays as the fallback for a Host from before v2.10.
        const parsed = parseMaskedAddress(host.addressMasked)
        const exposedPort = typeof host.port === 'number' && Number.isInteger(host.port) ? host.port : null
        const exposedUser = typeof host.username === 'string' ? host.username : null
        return {
          name: host.name || '',
          address: host.address || '',
          port: exposedPort === null ? (parsed.port === null ? defaults.defaultPort || 22 : parsed.port) : exposedPort,
          username: exposedUser === null ? parsed.username : exposedUser,
          jumpHost: typeof host.jumpHost === 'string' ? host.jumpHost : '',
          jumpHostKnown: typeof host.jumpHost === 'string',
          authType: typeof host.authType === 'string' ? host.authType : defaults.defaultAuth || 'key',
          // The Host exposes the configured path (not a secret) so an edit does not
          // start with an empty field; touching nothing still keeps the stored key.
          keyPath: typeof host.authKeyPath === 'string' ? host.authKeyPath : '',
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
        keyPath: defaults.defaultKeyPath || '~/.ssh/id_rsa',
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
      /** Field-level messages keyed by draft field, cleared as soon as that field changes. */
      const [fieldErrors, setFieldErrors] = useState({})
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

      const patchDraft = (patch) => {
        setDraft((current) => ({ ...current, ...patch }))
        // Correcting a field clears its own error (and the summary) instead of leaving a stale
        // message until the next save (audit S2-3).
        setFieldErrors((current) => {
          const next = { ...current }
          let changed = false
          for (const key of Object.keys(patch)) {
            if (next[key] !== undefined) {
              delete next[key]
              changed = true
            }
          }
          return changed ? next : current
        })
        if (formError !== null) setFormError(null)
      }
      const row = (spec) => formRow(t, draft, patchDraft, { ...spec, error: fieldErrors[spec.key] })
      const focusField = (field) => {
        if (typeof document === 'undefined' || !document.querySelector) return
        const testId = {
          name: 'wizard-name',
          address: 'wizard-address',
          port: 'wizard-port',
          username: 'wizard-username',
          idleMinutes: 'wizard-idle-minutes',
          keyPath: 'wizard-key-path',
          password: 'wizard-password',
        }[field]
        if (!testId) return
        const node = document.querySelector('[data-testid="' + testId + '"]')
        if (node && typeof node.focus === 'function') node.focus()
      }

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
        // An edit that does not touch authentication keeps the stored credential, so it does
        // not need (and must not demand) a password: the connection asks for it later
        // (audit S2-2). A password typed into the wizard stays a one-time value.
        const requiresPassword = draft.authType === 'password' && (mode === 'add' || authDirty)
        const invalid = validateHostDraft(
          { ...draft, password },
          { requireKeyPath: mode === 'add' || authDirty, requirePassword: requiresPassword },
        )
        if (invalid !== null) {
          setFieldErrors({ [invalid.field]: invalid.code })
          setFormError(invalid.code)
          focusField(invalid.field)
          return
        }
        setFieldErrors({})
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
          const view = toErrorView(error)
          // A Host validation error names a field when it can; keep it next to that field too.
          if (view && typeof view.field === 'string') setFieldErrors({ [view.field]: view.code })
          setFormError(view)
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
          h(
            Field,
            {
              label: t('wizard.address'),
              hint: t('wizard.addressHint'),
              error: fieldErrors.address ? t(fieldErrors.address) : undefined,
              errorId: fieldErrors.address ? 'wizard-address-error' : undefined,
            },
            [
              h(TextInput, {
                key: 'address',
                value: draft.address,
                placeholder: t('wizard.addressPlaceholder'),
                ariaLabel: t('wizard.address'),
                list: 'drg-ssh-alias-list',
                testId: 'wizard-address',
                invalid: Boolean(fieldErrors.address),
                describedBy: fieldErrors.address ? 'wizard-address-error' : undefined,
                onChange: onAddressChange,
              }),
              h(
                'datalist',
                { key: 'aliases', id: 'drg-ssh-alias-list' },
                addressOptions.map((alias) => h('option', { key: alias.alias, value: alias.alias }, alias.host || '')),
              ),
            ],
          ),
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
              {
                label: t('wizard.keyPath'),
                error: fieldErrors.keyPath ? t(fieldErrors.keyPath) : undefined,
                errorId: fieldErrors.keyPath ? 'wizard-key-path-error' : undefined,
              },
              box(
                'div',
                'drg-field-inline',
                h(TextInput, {
                  value: draft.keyPath,
                  placeholder: t('wizard.keyPathPlaceholder'),
                  ariaLabel: t('wizard.keyPath'),
                  testId: 'wizard-key-path',
                  invalid: Boolean(fieldErrors.keyPath),
                  describedBy: fieldErrors.keyPath ? 'wizard-key-path-error' : undefined,
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
              {
                label: t('wizard.password'),
                // An edit that leaves auth alone does not need the password: the Host asks for it
                // when the connection actually starts (audit S2-2).
                hint: mode === 'edit' && !authDirty ? t('wizard.passwordSavedHint') : t('wizard.passwordPlaceholder'),
                error: fieldErrors.password ? t(fieldErrors.password) : undefined,
                errorId: fieldErrors.password ? 'wizard-password-error' : undefined,
              },
              h(TextInput, {
                type: 'password',
                value: password,
                placeholder: t('wizard.passwordPlaceholder'),
                ariaLabel: t('wizard.password'),
                testId: 'wizard-password',
                invalid: Boolean(fieldErrors.password),
                describedBy: fieldErrors.password ? 'wizard-password-error' : undefined,
                onChange: (value) => {
                  setAuthDirty(true)
                  // Clear the field error like every other input: the password has no draft
                  // field, so `patchDraft` was not called and the error stuck (review feedback).
                  setFieldErrors((current) => {
                    if (current.password === undefined) return current
                    const next = { ...current }
                    delete next.password
                    return next
                  })
                  if (formError !== null) setFormError(null)
                  setPassword(value)
                },
              }),
            )
          : null,
        h(CheckRow, {
          checked: draft.autoReconnect !== false,
          label: t('wizard.autoReconnect'),
          testId: 'wizard-auto-reconnect',
          onChange: (checked) => patchDraft({ autoReconnect: checked }),
        }),
        h(
          'details',
          { className: 'drg-advanced', 'data-testid': 'wizard-advanced' },
          h('summary', null, t('wizard.advanced')),
          box(
            'div',
            'drg-advanced-body',
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
                ? row({
                    key: 'idleMinutes',
                    kind: 'number',
                    label: 'wizard.idleMinutes',
                    testId: 'wizard-idle-minutes',
                  })
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
          ),
        ),
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
            busy: saving !== null,
            dismissible: saving === null,
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
     * never includes a token or remote URL. `report` is required: the only caller
     * branches on it and calls this with a real report.
     */
    function formatDiagnoseText(report, host, t, locale) {
      const lines = ['dsh-remote-go · ' + t('diag.title')]
      const target = host || {}
      const address = displayAddress(target)
      lines.push(t('diag.host') + ': ' + (target.name || target.id || '') + (address ? ' (' + address + ')' : ''))
      if (typeof report.summary === 'string') lines.push('summary: ' + report.summary)
      if (typeof report.generatedAt === 'string') lines.push(t('diag.generatedAt') + ': ' + report.generatedAt)
      lines.push('')
      const checks = sortDiagnoseChecks(report.checks)
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
      const layerRef = useRef(null)
      const dialogRef = useRef(null)
      const titleIdRef = useRef('drg-drawer-title')
      // The drawer is a dialog like the modals: one Escape handler for the whole stack, so a
      // drawer under a wizard cannot close first (audit S1-1).
      useDialogLayer({ layerRef, dialogRef, onClose: props.onClose, dismissible: true })

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

      return h(
        'div',
        { className: 'drg-drawer-layer', ref: layerRef },
        h('div', { className: 'drg-drawer-backdrop', onClick: props.onClose, 'aria-hidden': 'true' }),
        h(
          'aside',
          {
            className: 'drg-drawer',
            role: 'dialog',
            'aria-labelledby': titleIdRef.current,
            tabIndex: -1,
            ref: dialogRef,
            'data-testid': 'diagnostics',
          },
          box(
            'div',
            'drg-drawer-head',
            h(
              'div',
              null,
              box('h2', { className: 'drg-drawer-title', id: titleIdRef.current }, t('diag.title')),
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
      const clamp = (value, limit, fallback) => {
        const number = toInt(value, fallback)
        return Math.min(limit.max, Math.max(limit.min, number))
      }
      return {
        defaultPort: clamp(draft.defaultPort, HOST_LIMITS.defaultPort, 22),
        defaultAuth: draft.defaultAuth === 'password' ? 'password' : 'key',
        defaultKeyPath: String(draft.defaultKeyPath || '').trim(),
        connectTimeoutSec: clamp(draft.connectTimeoutSec, HOST_LIMITS.connectTimeoutSec, 30),
        autoReconnect: {
          enabled: draft.autoReconnectEnabled === true,
          maxAttempts: clamp(draft.maxAttempts, HOST_LIMITS.maxAttempts, 3),
          baseDelayMs: clamp(draft.baseDelayMs, HOST_LIMITS.baseDelayMs, 1000),
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
        defaultKeyPath: view.defaultKeyPath || '~/.ssh/id_rsa',
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
      const [fieldErrors, setFieldErrors] = useState({})
      // Key-file picker overlay for the default key path.
      const [keyPicker, setKeyPicker] = useState(false)
      const patch = (patchValue) => {
        setDraft((current) => ({ ...current, ...patchValue }))
        setFieldErrors((current) => {
          const next = { ...current }
          let changed = false
          for (const key of Object.keys(patchValue)) {
            if (next[key] !== undefined) {
              delete next[key]
              changed = true
            }
          }
          return changed ? next : current
        })
      }
      const set = (field) => (value) => patch({ [field]: value })

      const fieldRow = (spec) => {
        const row = formRow(t, draft, patch, { ...spec, error: fieldErrors[spec.key] })
        // The settings body is built from `.map(fieldRow)`: every element needs a stable key or
        // React reports a missing-key warning on every render.
        return React.cloneElement(row, { key: spec.key })
      }
      const focusField = (field) => {
        if (typeof document === 'undefined' || !document.querySelector) return
        const node = document.querySelector('[data-testid="settings-' + field + '"]')
        if (node && typeof node.focus === 'function') node.focus()
      }

      const handleSave = async () => {
        const invalid = validateSettingsDraft(draft)
        if (invalid !== null) {
          setFieldErrors({ [invalid.field]: invalid.code })
          setError(null)
          focusField(invalid.field)
          return
        }
        setFieldErrors({})
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
        // Same dismissal contract as Escape / the backdrop / the header ×: a save in flight
        // cannot be cancelled by the footer button either.
        h(
          Button,
          { variant: 'ghost', testId: 'settings-cancel', disabled: saving, onClick: props.onClose },
          t('cancel'),
        ),
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
            busy: saving,
            dismissible: !saving,
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
                  {
                    kind: 'number',
                    key: 'defaultPort',
                    label: 'settings.defaultPort',
                    hint: 'settings.defaultPortHint',
                    testId: 'settings-defaultPort',
                  },
                  {
                    kind: 'select',
                    key: 'defaultAuth',
                    label: 'settings.defaultAuth',
                    options: [
                      ['key', 'settings.defaultAuthKey'],
                      ['password', 'settings.defaultAuthPassword'],
                    ],
                  },
                  {
                    kind: 'number',
                    key: 'connectTimeoutSec',
                    label: 'settings.connectTimeout',
                    hint: 'settings.connectTimeoutHint',
                    testId: 'settings-connectTimeoutSec',
                  },
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
                  { kind: 'number', key: 'maxAttempts', label: 'settings.maxAttempts', testId: 'settings-maxAttempts' },
                  { kind: 'number', key: 'baseDelayMs', label: 'settings.baseDelay', testId: 'settings-baseDelayMs' },
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
                [
                  {
                    kind: 'text',
                    key: 'profile',
                    label: 'settings.profile',
                    hint: 'settings.profileHint',
                    testId: 'settings-profile',
                  },
                ].map(fieldRow),
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
      // A failure reported by the previous connect attempt is cleared as soon as the user
      // edits the password, like every other field error.
      const [serverErrorCleared, setServerErrorCleared] = useState(false)
      const canRemember = props.storageAvailable === true
      const submit = () => {
        // Enter can fire faster than React disables the field: the guard lives in the handler
        // itself, so one prompt can never start two `POST /connect` requests (audit S2-2).
        if (props.busy === true) return
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
          busy: props.busy === true,
          // While the connect request is in flight the dialog must not disappear under it:
          // the answer arrives into this prompt (audit S2-2/S2-5).
          dismissible: props.busy !== true,
          footer: footerRow(
            h(Button, { variant: 'ghost', onClick: props.onCancel, disabled: props.busy === true }, t('cancel')),
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
            error: localError || (serverErrorCleared ? '' : typeof props.error === 'string' ? props.error : ''),
            errorId: 'password-prompt-error',
          },
          h(TextInput, {
            type: 'password',
            value: password,
            placeholder: t('wizard.passwordPlaceholder'),
            autoComplete: 'off',
            testId: 'password-input',
            ariaLabel: t('passwordPromptLabel'),
            disabled: props.busy === true,
            invalid: localError !== '' || (!serverErrorCleared && typeof props.error === 'string'),
            describedBy: 'password-prompt-error',
            onChange: (value) => {
              setPassword(value)
              setServerErrorCleared(true)
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
          busy,
          dismissible: !busy,
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
      const toasts = props && Array.isArray(props.toasts) ? props.toasts : props && props.toast ? [props.toast] : []
      if (toasts.length === 0) return null
      return h(
        'div',
        {
          className: 'drg-toasts',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'false',
          'data-testid': 'toast-region',
        },
        toasts.map((toast, index) =>
          h(
            'div',
            {
              key: toast && toast.id !== undefined ? String(toast.id) : String(index),
              className: 'drg-toast',
              'data-tone': (toast && toast.tone) || 'info',
            },
            toast && toast.text,
          ),
        ),
      )
    }

    //#region 15. overlay host (floating windows + remote window)

    /**
     * Accept a state frame only when it is not older than what is already on screen. The Host
     * stamps every snapshot with a monotonic `rev` (docs/api.md); SSE frames and slow `GET /state`
     * responses can arrive out of order, and a stale one used to paint the UI backwards (a
     * connected host flipping to `connecting`, or `disconnected` after a newer frame). A Host
     * from before `rev` sends no number and keeps the old last-writer-wins behaviour.
     */
    function stateRevision(state) {
      return state && typeof state.rev === 'number' && Number.isFinite(state.rev) ? state.rev : null
    }
    /**
     * The Host's publish generation. `rev` restarts at 0 with every Host process / plugin
     * reload, so a Client holding the old high-water mark would reject every new frame forever.
     * A frame from another generation is accepted regardless of its revision.
     */
    function stateInstance(state) {
      return state && typeof state.instance === 'string' && state.instance !== '' ? state.instance : null
    }
    function isNewerState(next, currentRev, currentInstance) {
      const instance = stateInstance(next)
      if (instance !== null && currentInstance !== null && instance !== currentInstance) return true
      const rev = stateRevision(next)
      if (rev === null) return true
      return !(typeof currentRev === 'number' && rev <= currentRev)
    }

    function useRemoteState(initialState, onDownload) {
      const hasInitial = initialState !== undefined && initialState !== null
      const [state, setState] = useState(hasInitial ? initialState : null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(!hasInitial)
      const [mode, setMode] = useState('idle')
      const alive = useRef(true)
      const revRef = useRef(stateRevision(initialState))
      const instanceRef = useRef(stateInstance(initialState))
      const streamRef = useRef(null)
      const applyState = (next) => {
        if (!isNewerState(next, revRef.current, instanceRef.current)) return false
        instanceRef.current = stateInstance(next) ?? instanceRef.current
        revRef.current = stateRevision(next) ?? revRef.current
        setState(next)
        return true
      }
      const downloadHandler = useRef(typeof onDownload === 'function' ? onDownload : () => {})
      downloadHandler.current = typeof onDownload === 'function' ? onDownload : () => {}
      const refresh = useCallback(() => {
        setLoading(true)
        // The revision (and publish generation) this refresh was requested at: a response that
        // is not newer than it is stale even when it is the last one to resolve.
        const requestedAt = revRef.current
        const requestedInstance = instanceRef.current
        return api.getState().then(
          (next) => {
            if (!alive.current) return
            if (!isNewerState(next, requestedAt, requestedInstance)) {
              setLoading(false)
              return
            }
            applyState(next)
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
            if (!applyState(next)) return
            // A frame that is newer than the screen is also newer than any pending refresh: a
            // refresh that resolves after it will be dropped by `isNewerState`.
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
          onDownload: (job) => {
            if (alive.current) downloadHandler.current(job)
          },
        })
        streamRef.current = dispose
        return () => {
          alive.current = false
          streamRef.current = null
          dispose()
        }
      }, [])
      const patch = useCallback((updater) => {
        setState((current) => (current === null ? current : updater(current)))
      }, [])
      const reconnectStream = useCallback(() => {
        const dispose = streamRef.current
        if (dispose && typeof dispose.reconnect === 'function') dispose.reconnect()
      }, [])
      return { state, error, loading, mode, refresh, patch, reconnectStream }
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
          { wide: true, onClose: props.onClose, closeLabel: t('cancel'), ariaLabel: t('hostsTitle') },
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
                mode: props.mode,
                onRetryLive: props.onRetryLive,
                onAdd: props.onAdd,
                onRefresh: props.onRefresh,
                onOpenSettings: props.onOpenSettings,
                onOpenHost: props.onOpenHost,
                onDisconnectHost: props.onDisconnectHost,
                onReconnectHost: props.onReconnectHost,
                onRestartHost: props.onRestartHost,
                onStopRemote: props.onStopRemoteHost,
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
      // remote window all read from it. Download jobs arrive on the same SSE stream.
      const [downloadJobs, setDownloadJobs] = useState({})
      const downloadJobsRef = useRef({})
      const downloadPolls = useRef(new Map())
      const downloadRemoval = useRef(new Map())
      const downloadHandlerRef = useRef(() => {})
      const remote = useRemoteState(props.initialState, (job) => downloadHandlerRef.current(job))
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
      // Deleting a host whose link is being built needs a second, explicit confirmation.
      const [deleteArmed, setDeleteArmed] = useState(false)
      const [passwordPrompt, setPasswordPrompt] = useState(null)
      // Synchronous guard: two Enter events in the same tick both see `pending.busy === false`
      // because React has not re-rendered yet, so the ref is what makes the submit idempotent.
      const passwordBusy = useRef(false)
      const [conflictBusy, setConflictBusy] = useState(false)
      const [fingerprintBusy, setFingerprintBusy] = useState(false)
      // A queue, not one slot: a second message used to replace the first before it could be
      // read (audit S3). Newest last, at most three, each with its own dismissal timer.
      const [toasts, setToasts] = useState([])
      const toastSeq = useRef(0)
      const toastTimers = useRef(new Map())
      const [wizard, setWizard] = useState(() => {
        const store = props.wizardStore
        return store && typeof store.current === 'function' ? store.current() : null
      })

      const dismissToast = (id) => {
        const timer = toastTimers.current.get(id)
        if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer)
        toastTimers.current.delete(id)
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }
      const notify = (text, tone) => {
        toastSeq.current += 1
        const id = toastSeq.current
        setToasts((current) => [...current, { id, text, tone: tone || 'info' }].slice(-3))
        if (typeof setTimeout === 'function') {
          const timer = setTimeout(() => dismissToast(id), 4200)
          unrefTimer(timer)
          toastTimers.current.set(id, timer)
        }
      }
      useEffect(
        () => () => {
          for (const timer of toastTimers.current.values()) {
            if (typeof clearTimeout === 'function') clearTimeout(timer)
          }
          toastTimers.current.clear()
        },
        [],
      )
      const errorMessage = (error) => {
        const viewOfError = toErrorView(error)
        const title = resolveText(viewOfError.title, locale)
        const detail = resolveText(viewOfError.detail, locale)
        return detail ? title + ' ' + detail : title
      }

      /** Merge one Host job frame into the local card map, never letting a slow frame regress it. */
      const updateDownloadView = (job) => {
        if (!job || typeof job.id !== 'string') return null
        const current = downloadJobsRef.current[job.id] || null
        const merged = { ...(current || {}), ...job }
        const rank = { preparing: 0, ready: 1, saving: 2, done: 3, error: 3 }
        if (current && (rank[job.phase] ?? 0) < (rank[current.phase] ?? 0)) {
          merged.phase = current.phase
        }
        merged.doneBytes = Math.max(Number(current?.doneBytes) || 0, Number(job.doneBytes) || 0)
        merged.totalBytes = Math.max(Number(current?.totalBytes) || 0, Number(job.totalBytes) || 0)
        const next = { ...downloadJobsRef.current, [job.id]: merged }
        downloadJobsRef.current = next
        setDownloadJobs(next)
        return merged
      }

      const clearDownloadPoll = (id) => {
        const timer = downloadPolls.current.get(id)
        if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer)
        downloadPolls.current.delete(id)
      }

      const removeDownloadView = (id, delay) => {
        clearDownloadPoll(id)
        const previous = downloadRemoval.current.get(id)
        if (previous !== undefined && typeof clearTimeout === 'function') clearTimeout(previous)
        downloadRemoval.current.delete(id)
        const drop = () => {
          if (!downloadJobsRef.current[id]) return
          const next = { ...downloadJobsRef.current }
          delete next[id]
          downloadJobsRef.current = next
          setDownloadJobs(next)
        }
        if (delay && typeof setTimeout === 'function') {
          const timer = setTimeout(drop, delay)
          timer.unref?.()
          downloadRemoval.current.set(id, timer)
        } else {
          drop()
        }
      }

      /** Poll as a fallback for EventSource gaps; SSE normally stops this before it runs. */
      const startDownloadPoll = (id) => {
        if (downloadPolls.current.has(id) || typeof setInterval !== 'function') return
        const timer = setInterval(() => {
          const current = downloadJobsRef.current[id]
          if (!current || current.phase === 'saving' || current.phase === 'done') {
            clearDownloadPoll(id)
            return
          }
          api.downloadStatus(id).then(
            (job) => {
              handleDownloadJob(job)
              if (job.phase === 'ready' || job.phase === 'error') clearDownloadPoll(id)
            },
            (error) => {
              clearDownloadPoll(id)
              const current = downloadJobsRef.current[id]
              if (current && (current.phase === 'preparing' || current.phase === 'ready')) {
                updateDownloadView({ id, phase: 'error', error: toErrorView(error) })
                notify(errorMessage(error), 'error')
                removeDownloadView(id, 5000)
              }
            },
          )
        }, 700)
        timer.unref?.()
        downloadPolls.current.set(id, timer)
      }

      /** A completed job is already written to the chosen local path by the Host. */
      const finishSavedDownload = (job) => {
        if (!job || typeof job.id !== 'string') return
        const destination = job.destination || job.path || ''
        notify(t('downloadSavedTo', { path: destination }), 'success')
        updateDownloadView({ id: job.id, phase: 'done' })
        removeDownloadView(job.id, 1400)
        // The bytes never leave the Host, so release the job slot immediately.
        void api.cancelDownload(job.id).catch(() => {})
      }

      /** Route one job frame: show progress, then report the local path on ready. */
      const handleDownloadJob = (job) => {
        if (!job || typeof job.id !== 'string') return
        const previous = downloadJobsRef.current[job.id]
        const merged = updateDownloadView(job)
        if (!merged) return
        if (merged.phase === 'ready') {
          finishSavedDownload(merged)
          return
        }
        if (merged.phase === 'error') {
          clearDownloadPoll(job.id)
          if (!previous || previous.phase !== 'error') {
            const view = merged.error && typeof merged.error === 'object' ? merged.error : null
            const detail = view ? resolveText(view.detail, locale) : ''
            const title = view ? resolveText(view.title, locale) : ''
            notify(detail ? (title ? title + ' ' : '') + detail : title || t('downloadFailed'), 'error')
          }
          removeDownloadView(job.id, 5000)
        }
      }
      downloadHandlerRef.current = handleDownloadJob

      /** Start one Host job; every job streams into the directory picked by the user. */
      const startHostDownload = (request, destination) => {
        const fallbackName = request.name || request.path.split('/').pop() || 'download'
        notify(t('downloadStarted', { name: fallbackName }), 'info')
        api.startDownload(request.hostId, request.path, destination).then(
          (job) => {
            const merged = updateDownloadView(job)
            if (!merged) return
            if (merged.phase === 'ready') {
              finishSavedDownload(merged)
            } else if (merged.phase === 'preparing') {
              startDownloadPoll(job.id)
            }
          },
          (error) => notify(errorMessage(error), 'error'),
        )
      }

      /** Ask DSH's own directory picker for the local destination folder. */
      const pickFolderDestination = async () => {
        const workspacePick = typeof props.pickDirectory === 'function' ? props.pickDirectory : null
        if (workspacePick) {
          try {
            const picked = await workspacePick()
            if (picked === null) return null
            if (typeof picked === 'string' && picked !== '') return picked
          } catch (error) {
            notify(errorMessage(error), 'error')
            return null
          }
        }
        const picker = typeof window === 'undefined' ? null : window.__DSH_DIRECTORY_PICKER__
        if (!picker || typeof picker.pick !== 'function') {
          notify(t('downloadFolderDesktopOnly'), 'warn')
          return null
        }
        try {
          const picked = await picker.pick()
          return typeof picked === 'string' && picked !== '' ? picked : null
        } catch (error) {
          notify(errorMessage(error), 'error')
          return null
        }
      }

      /** A remote file/folder intent from the guest bridge becomes a Host job. */
      const downloadFromHost = (request) => {
        if (!request || typeof request.hostId !== 'string' || typeof request.path !== 'string') return
        notify(t('downloadFolderChoose'), 'info')
        pickFolderDestination().then((destination) => {
          if (destination) startHostDownload(request, destination)
        })
      }

      const cancelDownloadJob = (job) => {
        if (!job || typeof job.id !== 'string') return
        api.cancelDownload(job.id).then((cancelled) => {
          if (!cancelled) return
          notify(t('downloadCancelled'), 'info')
          removeDownloadView(job.id)
        })
      }

      useEffect(
        () => () => {
          for (const timer of downloadPolls.current.values()) {
            if (typeof clearInterval === 'function') clearInterval(timer)
          }
          for (const timer of downloadRemoval.current.values()) {
            if (typeof clearTimeout === 'function') clearTimeout(timer)
          }
          downloadPolls.current.clear()
          downloadRemoval.current.clear()
        },
        [],
      )

      /**
       * One Host-API call with the window's choreography: the host goes busy, success refreshes
       * the state, a failure reaches the toast, and the flag clears either way.
       */
      const runAction = (host, work, done) => {
        if (!host || !host.id) return undefined
        setBusyHostId(host.id)
        return work()
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
      /**
       * Which attach the remote window belongs to. `remote.viewRev` changes on every successful
       * connect / restart / re-attach, so a warm carrier built for an older tunnel is stale even
       * though its host is connected again.
       */
      const activeViewRev =
        activeHost && activeHost.remote && Number.isInteger(activeHost.remote.viewRev)
          ? activeHost.remote.viewRev
          : null
      /** True when the warm carrier was navigated for the given attach. */
      const carrierHoldsView = (hostId, viewRev) => {
        const entry = carrierOf(hostId)
        if (entry === null) return false
        const entryRev = Number.isInteger(entry.viewRev) ? entry.viewRev : null
        return entryRev === viewRev
      }
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

      // Fetch `GET /hosts/:id/open` only for a host that is up and not already warm for this
      // attach: the carrier needs the launch-token URL once, and a warm window is shown without it.
      // A cached URL from an older `viewRev` is stale even for the same host (its token and
      // tunnel are gone), so it is refetched rather than replayed.
      useEffect(() => {
        if (target === null || carrierHoldsView(target, activeViewRev)) return undefined
        if (remoteUrl !== null && remoteUrl.hostId === target && remoteUrl.viewRev === activeViewRev) return undefined
        if (activeStatus !== 'connected') return undefined
        let cancelled = false
        api.openHost(target).then(
          (opened) => {
            if (!cancelled)
              setRemoteUrl({ hostId: target, url: opened.url, webUrl: opened.webUrl, viewRev: activeViewRev })
          },
          (error) => {
            if (cancelled) return
            notify(errorMessage(error), 'error')
          },
        )
        return () => {
          cancelled = true
        }
      }, [target, activeStatus, remoteUrl, activeViewRev])

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
        if (carrierHoldsView(target, activeViewRev)) {
          showOverlay({
            hostId: target,
            message: t('viewportOverlayLoadFailed'),
            localLabel: t('carrierBackToLocal'),
            viewRev: activeViewRev,
          })
          return
        }
        // The launch URL for *this* host is still being fetched: keep the current carrier up
        // so switching does not flash the local UI behind it.
        if (remoteUrl === null || remoteUrl.hostId !== target) return
        // Never replay a launch URL issued for an older attach (its token and tunnel are gone).
        if (activeViewRev !== null && remoteUrl.viewRev !== activeViewRev) return
        const surface = carrierSurface()
        const carrierUrl = surface === 'desktop' ? remoteUrl.url : remoteUrl.webUrl
        if (surface === 'web' && (typeof carrierUrl !== 'string' || carrierUrl === '')) {
          if (noWindowNotified.current !== target) {
            noWindowNotified.current = target
            notify(t('carrierUnavailable'), 'error')
          }
          return
        }
        // `showOverlay` is async, so the acquire outcome only arrives through its promise; a
        // failed acquire still has to reach the toast even though nothing awaits it here.
        showOverlay({
          hostId: target,
          url: carrierUrl,
          message: t('viewportOverlayLoadFailed'),
          localLabel: t('carrierBackToLocal'),
          viewRev: remoteUrl.viewRev,
        }).then(
          (outcome) => {
            if (!outcome || outcome.ok !== false || outcome.reason !== 'acquire-failed') return
            if (noWindowNotified.current === target) return
            noWindowNotified.current = target
            notify(t('carrierUnavailable'), 'error')
          },
          () => {},
        )
      }, [target, activeStatus, remoteUrl, activeViewRev])

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
        onCarrierDisposed = (hostId) => {
          setRemoteUrl((current) => (current !== null && current.hostId === hostId ? null : current))
        }
        return () => {
          onCarrierDisposed = null
          hideOverlays()
        }
      }, [])

      // While the state stream is down, download cards must keep moving from a status poll:
      // SSE `download` frames are exactly what stops arriving in fallback mode (audit S2-1).
      useEffect(() => {
        if (remote.mode !== 'polling' && remote.mode !== 'reconnecting') return
        for (const id of Object.keys(downloadJobsRef.current)) {
          const job = downloadJobsRef.current[id]
          if (!job || job.phase === 'saving' || job.phase === 'done' || job.phase === 'error') continue
          startDownloadPoll(id)
        }
      }, [remote.mode])

      // The management window's footer banner is not visible while a remote carrier fills the
      // window. Surface the same degradation through the shell's toast so it is visible on the
      // local page and over a guest, and announce the recovery (review feedback).
      const lastStreamMode = useRef('idle')
      useEffect(() => {
        const degraded = remote.mode === 'polling' || remote.mode === 'reconnecting'
        const wasDegraded = lastStreamMode.current === 'polling' || lastStreamMode.current === 'reconnecting'
        if (degraded && !wasDegraded) notify(t('liveStreamLostTitle'), 'warn')
        else if (remote.mode === 'live' && wasDegraded) notify(t('liveStreamRestored'), 'success')
        lastStreamMode.current = remote.mode
      }, [remote.mode])

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
          if (host.passwordSaved === true) {
            // A remembered password is never read by the Client: try the connect without one,
            // and only ask when the Host says that password no longer works (audit S2-2).
            pendingSwitch.current = host.id
            setManageView('connect')
            setManageOpen(true)
            setTarget(host.id)
            api.activate(host.id).catch(() => {})
            setBusyHostId(host.id)
            api.connect(host.id, {}).then(
              () => {
                setBusyHostId(null)
                remote.refresh()
              },
              (error) => {
                setBusyHostId(null)
                const view = toErrorView(error)
                if (view && view.code === 'auth') {
                  setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
                  return
                }
                notify(errorMessage(error), 'error')
              },
            )
            return
          }
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
      // Guest file intents arrive through the same command channel as the wizard's
      // requests; drain in order, with a small cap so a malformed producer cannot spin.
      useEffect(() => {
        const store = props.toolStore
        if (!store || typeof store.subscribe !== 'function') return undefined
        const consume = () => {
          for (let index = 0; index < 8; index += 1) {
            const request = typeof store.take === 'function' ? store.take() : null
            if (!request) return
            if (request.kind === 'download') downloadFromHost(request)
            // The capability bridge has no toast of its own: a refused copy is reported here,
            // where the shell already owns one.
            else if (request.kind === 'notice') notify(request.text, request.tone)
          }
        }
        consume()
        return store.subscribe(consume)
      }, [props.toolStore])
      const closeWizard = () => {
        const store = props.wizardStore
        if (store && typeof store.close === 'function') store.close()
      }

      const submitPassword = (submitted) => {
        const pending = passwordPrompt
        // The prompt's own handler guards Enter, but the doubling in the audit came from two
        // events in the same tick; the store-level guard is the last line (S2-2).
        if (!pending || !pending.host || pending.busy === true || passwordBusy.current === true) return
        const value = submitted && typeof submitted.password === 'string' ? submitted.password : ''
        const remember = submitted && submitted.remember === true
        if (value.trim() === '') {
          setPasswordPrompt({ ...pending, error: t('passwordPromptRequired') })
          return
        }
        passwordBusy.current = true
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
          .finally(() => {
            passwordBusy.current = false
            setBusyHostId(null)
          })
      }
      const cancelPassword = () => {
        // The row moved to that host when it was picked; the switch was cancelled, so put
        // it back where the window actually is.
        passwordBusy.current = false
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

      /**
       * Restart the managed remote web. The Host stops the pid it launched on the same SSH
       * session and re-runs `[start]`; the state stream shows `restarting-remote` and the
       * carrier navigates to the new launch URL once the host is connected again.
       */
      const restartHost = (host) => {
        if (!host) return
        return runAction(
          host,
          () => api.restart(host.id),
          (result) => {
            // A repair or another one-shot action owns the link: say so instead of doing nothing.
            if (result && result.accepted === false && result.reason === 'busy') {
              notify(t('remoteRestartBusy'), 'info')
            }
          },
        )
      }

      /**
       * Stop the remote DSH this connection manages (the "Stop remote DSH" card action). The
       * Host stops only the process it launched or took over, then releases the tunnel and the
       * SSH session; the host lands on `disconnected` with its settings kept. The remote UI
       * goes away with the link, so its carrier is released here as well.
       */
      const stopRemoteHost = (host) => {
        if (!host) return undefined
        return runAction(
          host,
          () => api.stopRemote(host.id),
          () => {
            setTarget((current) => (current === host.id ? null : current))
            closeCarrier(host.id).catch(() => {})
          },
        )
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
        if (!pendingDelete || deleting) return
        // A connecting host has a live link-work action behind it: one more click is what makes
        // the user read the warning instead of losing that connection to a single Enter (S3).
        if (pendingDelete.status === 'connecting' && deleteArmed !== true) {
          setDeleteArmed(true)
          return
        }
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
        Object.keys(downloadJobs).length > 0
          ? h(DownloadCenter, {
              jobs: Object.values(downloadJobs),
              t,
              locale,
              onCancel: cancelDownloadJob,
              onDismiss: (job) => removeDownloadView(job.id),
            })
          : null,
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
          mode: remote.mode,
          onRetryLive: remote.reconnectStream,
          fingerprintBusy,
          onClose: () => setManageOpen(false),
          onShowList: () => setManageView('list'),
          onAdd: () => openWizard({ mode: 'add', host: null }),
          onRefresh: remote.refresh,
          onOpenSettings: () => setSettingsOpen(true),
          onOpenHost: openHost,
          onDisconnectHost: disconnectHost,
          onReconnectHost: reconnectHost,
          onRestartHost: restartHost,
          onStopRemoteHost: stopRemoteHost,
          onEditHost: (host) => openWizard({ mode: 'edit', host }),
          onDeleteHost: (host) => {
            setDeleteArmed(false)
            setPendingDelete(host)
          },
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
              testId: 'delete-dialog',
              body:
                t('deleteBody', { name: pendingDelete.name || pendingDelete.id }) +
                (pendingDelete.status === 'connecting' ? ' ' + t('deleteConnectingWarning') : ''),
              confirmLabel: deleting
                ? t('deleteBusy')
                : pendingDelete.status === 'connecting' && deleteArmed !== true
                  ? t('deleteStillConfirm')
                  : t('deleteConfirm'),
              cancelLabel: t('cancel'),
              busy: deleting,
              onConfirm: confirmDeleteHost,
              onCancel: () => {
                if (deleting) return
                setDeleteArmed(false)
                setPendingDelete(null)
              },
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
        h(Toast, { toasts }),
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
    .drg-downloads {
      position: fixed; right: 16px; bottom: 16px; z-index: 56; display: flex; flex-direction: column;
      gap: 8px; width: 320px; max-width: calc(100vw - 32px); pointer-events: none;
      will-change: transform;
    }
    .drg-download {
      pointer-events: auto; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
      box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary);
    }
    .drg-download-error { border-color: var(--dsw-alias-state-error-primary); }
    .drg-download-error .drg-download-fill { background: var(--dsw-alias-state-error-primary); }
    .drg-download-head {
      display: flex; align-items: center; gap: 6px; min-width: 0;
      cursor: grab; user-select: none; touch-action: none;
    }
    .drg-download-head:active { cursor: grabbing; }
    .drg-download-grip { display: inline-flex; flex: none; color: var(--dsw-alias-label-tertiary); }
    .drg-download-title {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; line-height: 1.45;
    }
    .drg-download-action {
      flex: none; height: 22px; padding: 0 7px; border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: var(--dsw-radius-sm); background: transparent;
      color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer;
    }
    .drg-download-action:hover {
      background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
    }
    .drg-download-track {
      height: 4px; margin-top: 8px; overflow: hidden; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-download-fill {
      display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary);
      transition: width 160ms ease;
    }
    .drg-download-track[data-indeterminate] .drg-download-fill {
      animation: drg-download-pulse 1.2s ease-in-out infinite;
    }
    @keyframes drg-download-pulse {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    .drg-download-meta {
      display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; font-size: 11px;
      color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
    }
    .drg-download-detail {
      margin: 6px 0 0; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-state-error-primary);
    }
    .drg-linkbtn {
      padding: 0 2px; border: none; border-radius: var(--dsw-radius-xs); background: none; color: var(--dsw-alias-link);
      font-size: 12.5px; cursor: pointer;
    }
    .drg-linkbtn:hover { text-decoration: underline; text-underline-offset: 2px; }
    /* Available to assistive technology only: a live region and its visible twin must not
       announce the same update twice. */
    .drg-sr-only {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
    }

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
    .drg-card-progress { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
    .drg-card-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; }
    .drg-card-meta > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .drg-card-meta dt { color: var(--dsw-alias-label-secondary); font-size: 11px; }
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
    /* The phase a line was written in, so a long log can be read step by step. */
    .drg-connect-log-phase {
      flex: none; align-self: baseline; height: 18px; padding: 0 6px; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
      font-family: var(--dsw-font-family); font-size: 10.5px; line-height: 18px;
    }
    .drg-connect-log-text { min-width: 0; white-space: pre-wrap; }
    /* Each connection's first line: the boundary that says which attempt this log belongs to. */
    .drg-connect-log-line[data-boundary="true"] .drg-connect-log-text {
      color: var(--dsw-alias-label-secondary); font-weight: 500;
    }
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
      color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    /* The field keeps the app's focus ring for keyboard users; only a pointer focus drops the
       outline, because the border/shadow below already marks the field. Removed the old blanket
       outline:none, which also removed the ring for Tab users (audit S2-4). */
    .drg-input:focus:not(:focus-visible), .drg-select:focus:not(:focus-visible) { outline: none; }
    .drg-input:focus-visible, .drg-select:focus-visible { outline-offset: 1px; }
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
    .drg-advanced { margin: 8px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); padding-top: 8px; }
    .drg-advanced > summary { margin-bottom: 4px; font-size: 13px; cursor: pointer; }
    .drg-advanced-body { display: grid; gap: 4px; }
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
    .drg-toast[data-tone="warn"] { border-left-color: var(--dsw-alias-state-warn-primary); }
    .drg-toast[data-tone="info"] { border-left-color: var(--dsw-alias-state-business-primary); }
    /* Toasts stack instead of replacing each other: a warning and a later error can both matter. */
    .drg-toasts {
      position: fixed; left: 50%; bottom: 24px; z-index: 80; display: flex; flex-direction: column;
      align-items: center; gap: 8px; max-width: min(560px, calc(100vw - 32px));
      transform: translateX(-50%); pointer-events: none;
    }
    .drg-toasts .drg-toast { position: static; transform: none; max-width: 100%; animation: drg-toast-rise 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes drg-toast-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
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
      // A carrier's failure layer hands the window back to the local page through this hook.
      requestLocalPage = () => panelStore.requestIntent({ kind: 'local' })
      const wizardStore = createWizardStore()
      const toolStore = createToolRequestStore()
      const openWizard = (draft) => {
        wizardStore.open(draft)
      }
      const sharedInject = () => ({
        panelStore,
        wizardStore,
        toolStore,
        openWizard,
        getLocaleId,
        pickDirectory: async () => {
          try {
            const workspaceUi = ctx.get('uiWorkspace')
            if (workspaceUi && typeof workspaceUi.pickDirectory === 'function') {
              const picked = await workspaceUi.pickDirectory()
              return typeof picked === 'string' && picked !== '' ? picked : null
            }
          } catch (_error) {
            // fall back to the desktop preload picker below
          }
          return undefined
        },
      })

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

      // The window's one host control is the switcher row drawn into the sidebar of whichever page owns the
      // window: this one (local) or the remote guest's. It lists local plus every host, so picking one is all it
      // takes to move the window. It is the plugin's host entry: there is no settings page, no sidebar panel and
      // no main panel; management and the wizard are floating windows in the overlay layer.
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
        if (intent.action === 'download-file') {
          // The guest's own file menu only produced a path; the local half owns the
          // SFTP read and the save, so no remote bytes ever cross the guest bridge.
          toolStore.requestDownload({
            hostId: intent.hostId,
            kind: intent.kind,
            path: intent.path,
            name: intent.name,
          })
          return
        }
        // --- capability bridge: this document is the one that may hold these capabilities -----
        if (intent.action === 'open-external') {
          const outcome = openExternalUrl(intent.url)
          // A URL the bridge refuses is the only failure it can prove: `noopener,noreferrer`
          // makes a successful open return null as well, so a popup-blocker refusal is invisible
          // here and must not be guessed at.
          if (outcome === 'blocked') {
            toolStore.requestNotice({ tone: 'error', text: t('externalLinkBlocked') })
          }
          return
        }
        if (intent.action === 'clipboard-write') {
          // The write itself happens in this document: the framed page cannot hold the clipboard
          // permission. The promise is the receipt the guest's `writeText` resolves on.
          const text = typeof intent.text === 'string' ? intent.text : ''
          return copyText(text).then(
            (ok) => ({ ok: ok === true }),
            () => ({ ok: false }),
          )
        }
        if (intent.action === 'notify') {
          // The bridge's only "say something" verb. Known codes map to this page's own strings;
          // free text stays the framed page's message, so it is tagged with its origin — a remote
          // notice must never read like local chrome (the trust model is in docs/design.md §4.8).
          const code = typeof intent.code === 'string' ? intent.code : ''
          let message = ''
          if (code === 'clipboard-failed') message = t('clipboardWriteFailed')
          else if (typeof intent.text === 'string' && intent.text !== '') {
            message = t('remoteNoticePrefix') + intent.text
          }
          if (message !== '') {
            toolStore.requestNotice({ tone: intent.tone === 'error' ? 'error' : 'info', text: message })
          }
          return
        }
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
      StopRemoteDialog,
      KeyFilePicker,
      WizardDialog,
      DiagnoseDrawer,
      SettingsModal,
      DownloadCenter,
      DownloadProgress,
      StatusDot,
      Modal,
      Button,
      Notice,
      Toast,
    }

    /**
     * Pure pieces the unit tests drive directly. This is a test seam, not part of the plugin
     * contract: the exported components and `carrier`/`api` stay the only supported surface.
     */
    const __test = {
      createDialogStack,
      subscribeState,
      stateRevision,
      stateInstance,
      isNewerState,
      streamRetryDelay,
      initialDraft,
      buildHostInput,
      validateHostDraft,
      validateSettingsDraft,
      settingsPatchFromDraft,
      settingsDraft,
      parseMaskedAddress,
      limits: HOST_LIMITS,
      sanitizeGuestIntent,
      createCarrierErrorLayer,
      createLoadGuard,
      loadTimeoutMs: CARRIER_LOAD_TIMEOUT_MS,
      captionMenuStart,
      withTimeout,
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      components,
      __test,
      /**
       * The Host-API client, exposed so unit tests can exercise the real security
       */
      api,
      /** Download intents from the guest bridge, exposed for unit tests. */
      toolRequests: {
        create: createToolRequestStore,
      },
      carrier: {
        open: showOverlay,
        close: closeOverlay,
        closeOne: closeCarrier,
        hide: hideOverlays,
        warm: carrierWarm,
        shown: () => carrierPool.current,
        surface: () => carrierSurface(),
        update: updateSwitcher,
        script: () => HOST_ROW_SCRIPT,
        guestTools: () => GUEST_TOOLS_SCRIPT,
        /** The capability bridge's guest script (desktop carrier) and installer (browser frame). */
        capabilities: () => CAPABILITY_BRIDGE_SCRIPT,
        bridge: (win) => mountCapabilityBridge(win),
        /** Install the per-host `localStorage` partition into one framed page. */
        partition: (win, hostId) => mountGuestStorage(win, hostId),
        /** Guest-side rail watcher, the atomic intent take, and the inset it maps to (issue #63). */
        sidebarMirror: () => SIDEBAR_MIRROR_SCRIPT,
        intentsScript: () => TAKE_INTENTS_SCRIPT,
        captionMenuStart: (collapsed, start) => captionMenuStart(collapsed, start),
      },
    }
  },
})

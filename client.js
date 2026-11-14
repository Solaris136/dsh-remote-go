/*
 * dsh-remote-go · Client half
 *
 * A single-file browser plugin (no build step) that contributes one host
 * switcher row at the top of the sidebar and floating windows. The row lists
 * the local page plus every SSH host and hands the whole window to the remote
 * DSH Web UI — reached through a local loopback tunnel — as a live browser
 * guest. Management, the add/edit wizard and every prompt float in the shell's
 * overlay layer, so they open over whichever page (local or remote) is showing
 * and leave it untouched. The row is the plugin's only entry: it registers no
 * settings page, no sidebar panel and no main panel.
 *
 * Contract: docs/api.md (frozen). The Host half lives in src/ and is the only
 * source of truth; this file renders that state and sends user intents back.
 *
 * Sections:
 *   1. constants
 *   2. i18n dictionaries
 *   3. i18n helpers
 *   4. misc utilities (security / formatting / storage)
 *   5. local error views
 *   6. HTTP + SSE API client
 *   7. icons and small UI primitives
 *   8. host list view
 *   9. full-window remote carrier (DSH desktop guest)
 *   9b. host switcher row + full-window remote carrier
 *   9c. key-file picker
 *  10. connect wizard
 *  11. diagnostics drawer
 *  12. settings modal
 *  13. one-time password prompt
 *  14. toast
 *  15. overlay host (floating windows + remote window)
 *  16. styles
 *  17. plugin registration (apply)
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-go',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    //#region 1. constants

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-remote-go'
    /** The plugin's id: namespace for its overlay seat and locale dictionary. */
    const PANEL_ID = 'dsh-remote-go'
    /** Base path of the Host HTTP API (same origin as the page). */
    const API_BASE = '/dsh-remote-go/api'
    /** SSE endpoint carrying `state` events; see docs/api.md. */
    const EVENT_PATH = '/dsh-remote-go/api/events'
    /** Fallback polling cadence when SSE is unavailable (docs/api.md). */
    const POLL_INTERVAL_MS = 3000
    /** Desktop browser-guest bridge (`window.dshDesktop`) protocol this build speaks. */
    const DESKTOP_BRIDGE_VERSION = 1
    /** DOM id prefix of the full-window remote carriers (one per warm host). */
    const OVERLAY_ROOT_ID = 'dsh-remote-go-overlay'
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
      'remote-version',
      'model-credentials',
      'desktop-guard',
    ]
    /** Status dot colours: the host theme's state aliases, nothing of our own. */
    const TONE_VARS = {
      idle: 'var(--dsw-alias-state-idle-primary)',
      info: 'var(--dsw-alias-state-business-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      limited: 'var(--dsw-static-violet-400)',
    }
    const STATUS_TONE = {
      unconfigured: 'idle',
      connecting: 'info',
      'fingerprint-pending': 'warn',
      'conflict-pending': 'warn',
      connected: 'success',
      disconnected: 'warn',
      error: 'error',
      limited: 'limited',
    }

    //#endregion

    //#region 2. i18n dictionaries

    /**
     * Simplified-Chinese dictionary. Every visible string in this file goes
     * through a key in `zh`/`en`; the unit test asserts both sides match.
     */
    const zh = {
      // -- navigation / common -------------------------------------------------
      panelSubtitle: '管理远程主机，并把整个窗口交给其中一台的远端 DSH。',
      addHost: '添加主机',
      addFirstHost: '添加第一台服务器',
      emptyTitle: '还没有远程主机',
      emptyBody: '还没有远程主机。添加一台，然后打开它的远端 DSH 界面。',
      refresh: '刷新状态',
      settings: '设置',
      close: '关闭',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      delete: '删除',
      deleting: '正在删除…',
      edit: '编辑',
      back: '返回',
      retry: '重试',
      diagnose: '诊断',
      reconnect: '重连',
      open: '打开',
      connect: '连接',
      disconnect: '断开',
      connecting: '连接中…',
      loading: '加载中…',
      unknown: '未知',
      optional: '可选',
      copy: '复制',
      copied: '已复制',
      next: '下一步',
      done: '完成',
      dismiss: '知道了',
      actions: '操作',
      host: '主机',
      status: '状态',
      name: '名称',

      // -- host list -----------------------------------------------------------
      hostsTitle: '远程主机',
      summary: '已连接 {connected} / 共 {total}',
      lastOpened: '上次打开',
      neverOpened: '尚未打开',
      remoteVersion: '远端 DSH',
      versionPending: '连接后显示',
      addHostTitle: '添加服务器',
      editHostTitle: '编辑服务器',
      deleteTitle: '删除这台服务器？',
      deleteBody: '将删除「{name}」的连接配置，并断开当前连接。远端任务不受影响，之后可以重新添加。',
      deleteConfirm: '删除',
      deleteBusy: '正在删除…',
      statusUnconfigured: '未配置',
      statusConnecting: '连接中',
      statusFingerprintPending: '指纹待确认',
      statusConflictPending: '远端冲突待确认',
      statusConnected: '已连接',
      statusDisconnected: '断线',
      statusError: '错误',
      statusLimited: '受限',
      statusHintUnconfigured: '尚未连接过',
      statusHintConnecting: '正在建立连接',
      statusHintFingerprintPending: '需要确认主机指纹',
      statusHintConflictPending: '远端已有手工启动的 DSH，需要你选择如何处理',
      statusHintConnected: '远端界面可用',
      statusHintDisconnected: '连接断开，可重连',
      statusHintError: '连接失败',
      statusHintLimited: '能连上，但远端无法提供界面',
      confirmFingerprint: '确认指纹',
      cardOpen: '打开',
      cardConnect: '连接',
      cardDisconnect: '断开',
      cardReconnect: '重连',
      cardDiagnose: '诊断',
      cardEdit: '编辑',
      cardDelete: '删除',
      errorReason: '原因：{detail}',
      loopbackNote: '远端界面只经 SSH 隧道映射为 127.0.0.1 后嵌入；不会直接使用该地址，也不会暴露到公网。',

      // -- viewport ------------------------------------------------------------
      viewportConnecting: '正在连接「{name}」…',
      viewportOverlayLoadFailed: '远端界面加载失败。点侧边栏主机条里的「本地」离开远端，再点该主机重新接管。',
      desktopRequired: '当前环境没有可用的桌面端窗口，远端界面只能在 DeepSeek Harness 桌面端打开。',
      // -- host switcher row (drawn in the local sidebar and the remote one) ----
      switcherLocal: '本地',
      switcherAddHost: '添加主机',
      switcherManage: '管理界面',
      switcherExit: '断开',

      // -- connect progress (docs/api.md 进度 code) -------------------------------------
      'progress.ssh-connecting': '正在连接 SSH…',
      'progress.host-key-confirm': '等待确认主机指纹…',
      'progress.auth-checking': '正在认证…',
      'progress.probing': '正在探测远端环境…',
      'progress.remote-dsh-running': '远端已有手工启动的 DSH，等待你的选择…',
      'progress.bootstrapping': '正在准备远端运行时…',
      'progress.installing-node': '正在自动准备远端 Node（{version}）…',
      'progress.downloading-node': '正在下载 Node {version}（已下载 {mb} MB）…',
      'progress.bootstrap-first-run': '首次运行：正在下载 @deepseek-ai/dsh@{version}…',
      'progress.bootstrap-fetching': '正在下载 DSH 依赖包…',
      'progress.bootstrap-installed': '依赖已安装，正在启动…',
      'progress.bootstrap-progress': '自举进度：{detail}',
      'progress.starting-remote': '正在启动远端 DSH…',
      'progress.tunneling': '正在建立本地回环隧道…',
      'progress.verifying': '正在验证远端界面…',
      'progress.ready': '就绪',
      'progress.reconnecting': '断线重连中（第 {attempt}/{max} 次）…',
      'progress.default': '正在连接…',
      'phase.ssh': 'SSH',
      'phase.probe': '探测',
      'phase.bootstrap': '准备运行时',
      'phase.start': '启动',
      'phase.tunnel': '隧道',
      'phase.verifying': '校验界面',
      'phase.ready': '就绪',

      // -- fingerprint ---------------------------------------------------------
      fingerprintTitle: '主机指纹待确认',
      fingerprintBody: '首次连接需要确认这台服务器的 SSH 主机指纹。确认后会记住；指纹变化时会再次提示。',
      fingerprintChanged: '主机指纹已变化',
      fingerprintChangedBody:
        '这台服务器的主机指纹与上次记录不一致，可能重装过系统，也可能存在中间人风险。确认无误后再继续。',
      fingerprintKeyType: '密钥类型',
      fingerprintSha: 'SHA256 指纹',
      fingerprintPinned: '已记录指纹',
      fingerprintAccept: '接受并记住',
      fingerprintAcceptOnce: '仅本次接受',
      fingerprintReject: '取消',
      passwordPromptTitle: '输入 SSH 密码',
      passwordPromptBody: '「{name}」使用密码认证。密码只用于本次连接；勾选后存进 DSH 的凭据存储（不写进主机配置）。',
      passwordPromptRemember: '安全保存这个密码（DSH 凭据存储）',
      passwordPromptNoStorage: '当前环境没有可用的凭据存储，密码只用于本次连接。',
      passwordPromptLabel: '密码',
      passwordPromptSubmit: '连接',
      passwordPromptRequired: '请输入密码',
      conflictTitle: '远端已有手工启动的 DSH',
      conflictBody:
        '「{name}」的远端检测到不是本插件启动的 DSH 进程（共 {count} 个）。它们与插件共用 ~/.dsh，同时运行可能争用同一会话或凭据文件。请选择如何处理：',
      conflictHint: '「停止」会向这些进程发送 SIGTERM / SIGKILL；「并存」会另起一个受管实例并保留它们。',
      conflictStop: '停止它并启动受管实例',
      conflictAlongside: '保留它，另起一个',
      conflictCancel: '取消连接',
      conflictBusy: '正在提交选择…',

      // -- wizard --------------------------------------------------------------
      'wizard.step1': 'SSH 信息',
      'wizard.step2': '连接测试',
      'wizard.step3': '完成',
      'wizard.name': '显示名',
      'wizard.namePlaceholder': '例如：腾讯云测试机',
      'wizard.address': 'SSH 地址或别名',
      'wizard.addressPlaceholder': '例如：ubuntu@192.0.2.10 或 my-server',
      'wizard.addressHint': '支持 ~/.ssh/config 中配置的别名。',
      'wizard.port': '端口',
      'wizard.username': '用户名',
      'wizard.usernamePlaceholder': '例如：ubuntu',
      'wizard.auth': '认证方式',
      'wizard.authKey': '密钥文件',
      'wizard.authPassword': '密码（仅本次，不保存）',
      'wizard.keyPath': '密钥文件路径',
      'wizard.keyPathPlaceholder': '例如：~/.ssh/id_ed25519',
      'wizard.keyPathPick': '选择文件…',
      'wizard.password': '密码',
      'wizard.passwordPlaceholder': '仅用于本次连接，不会保存',
      'wizard.authHint': '使用私钥文件认证；也可以改用密码（仅本次连接）。',
      'wizard.jumpHost': '跳板机（可选）',
      'wizard.jumpHostPlaceholder': '例如：另一台已添加主机的地址',
      'wizard.keepAlive': '远端存活策略',
      'wizard.keepAliveKeep': '保持运行（推荐）',
      'wizard.keepAliveStop': '退出即停',
      'wizard.keepAliveIdle': '空闲停止',
      'wizard.idleMinutes': '空闲分钟数',
      'wizard.autoReconnect': '断线后自动重连',
      'wizard.testHint': '保存后会立即测试连接；首次连接需要确认主机指纹。',
      'wizard.saveAndTest': '保存并测试',
      'wizard.savingHost': '正在保存…',
      'wizard.aliases': '从 SSH 配置选择',
      'wizard.aliasesLoading': '正在读取 ~/.ssh/config…',
      'wizard.aliasesEmpty': '没有发现可用的 SSH 别名',
      'wizard.knownHosts': '已知主机 {count} 条',
      'wizard.testTitle': '连接测试',
      'wizard.testRetry': '重新测试',
      'wizard.testing': '正在测试连接…',
      'wizard.testDone': '连接成功，远端界面可用。',
      'wizard.finishTitle': '远程主机已就绪',
      'wizard.finishBody': '远端 DSH 界面已可以通过本地视窗打开。',
      'wizard.versionLocal': '本机 DSH',
      'wizard.versionRemote': '远端 DSH',
      'wizard.versionMatch': '版本一致',
      'wizard.versionMismatch': '版本不一致，远端界面可能与本机不同',
      'wizard.bootstrapLevel': '启动方式',
      'wizard.uiReady': '远端界面',
      'wizard.uiReadyYes': '就绪',
      'wizard.uiReadyNo': '未就绪',
      'wizard.openRemote': '打开远程界面',
      'wizard.finishLater': '稍后再说',
      'wizard.errorTitle': '连接测试未通过',
      'wizard.copyDiag': '复制诊断信息',
      'wizard.validationName': '请填写显示名',
      'wizard.validationAddress': '请填写 SSH 地址或别名',
      'wizard.validationAddressUrl': '请填写 SSH 地址或别名，不要填写网页地址',
      'wizard.validationPort': '端口应为 1-65535',
      'wizard.validationUsername': '请填写用户名',
      'wizard.validationKeyPath': '请填写密钥文件路径',
      'wizard.validationPassword': '请输入密码，或改用密钥文件',

      // -- diagnostics ---------------------------------------------------------
      'diag.title': '连接诊断',
      'diag.running': '正在执行检查…',
      'diag.summaryOk': '全部通过',
      'diag.summaryWarning': '有需要留意的问题',
      'diag.summaryError': '存在失败项',
      'diag.checkPass': '通过',
      'diag.checkFail': '失败',
      'diag.checkUnknown': '未知',
      'diag.empty': '还没有诊断结果。',
      'diag.rerun': '重新检查',
      'diag.copy': '复制诊断信息',
      'diag.copyDone': '诊断信息已复制。',
      'diag.redacted': '诊断信息已脱敏，不包含访问令牌。',
      'diag.generatedAt': '生成时间',
      'diag.host': '主机',
      'diag.failed': '诊断执行失败',
      'diag.close': '关闭',

      // -- settings ------------------------------------------------------------
      'settings.title': '设置',
      'settings.ssh': 'SSH 默认值',
      'settings.defaultPort': '默认端口',
      'settings.defaultAuth': '默认认证方式',
      'settings.defaultAuthKey': '密钥文件',
      'settings.defaultAuthPassword': '密码（仅本次）',
      'settings.defaultKeyPath': '默认密钥文件',
      'settings.defaultKeyPathHint': '新增主机时预填这个路径；仍可在向导里改。',
      'settings.keyPathPick': '选择文件…',
      'keyFile.title': '选择 SSH 私钥文件',
      'keyFile.hint': '只列出用户主目录内的文件；点击目录进入，点击文件选中。',
      'keyFile.parent': '上一级',
      'keyFile.loading': '正在读取目录…',
      'keyFile.empty': '这个目录里没有可选项',
      'keyFile.error': '读取目录失败',
      'keyFile.retry': '重试',
      'keyFile.pick': '选中此文件',
      'settings.connectTimeout': '连接超时（秒）',
      'settings.security': '安全',
      'settings.hostKeyPolicy': '主机指纹策略',
      'settings.hostKeyPolicyFirstUse': '首次连接时询问',
      'settings.hostKeyPolicyStrict': '严格校验（指纹变化即失败）',
      'settings.saveTokens': '允许保存访问令牌',
      'settings.saveTokensHint':
        '默认关闭。开启后访问令牌会以 0600 权限保存在远端 DSH_HOME 下，仍存在被同机其他进程读取的风险。',
      'settings.saveTokensRisk': '风险提示：令牌落盘后更难撤销，请只在受控服务器上开启。',
      'settings.reconnect': '自动重连',
      'settings.reconnectEnabled': '断线后自动重连',
      'settings.maxAttempts': '最大重试次数',
      'settings.baseDelay': '重试间隔（毫秒）',
      'settings.other': '其他',
      'settings.language': '语言',
      'settings.languageAuto': '跟随 DSH',
      'settings.languageZh': '中文',
      'settings.languageEn': 'English',
      'settings.logLevel': '日志级别',
      'settings.bootstrap': '远端运行时',
      'settings.profile': 'DSH profile',
      'settings.profileHint': '默认 web；profile 配置在 ~/.dsh/profiles/<profile>',
      'settings.bootstrapHint':
        '用 npx 固定本机 DSH 版本启动；远端缺 Node 或版本过低时，插件自动装一份到 ~/.dsh/remote-go/node',
      'settings.saveSettings': '保存设置',
      'settings.saved': '设置已保存。',
      'settings.saveFailed': '保存设置失败',

      // -- local errors --------------------------------------------------------
      'error.actionFailed': '操作失败',
    }

    /** English dictionary — complete parallel of `zh`. */
    const en = {
      panelSubtitle: 'Manage remote hosts and hand the whole window to one of their DSH instances.',
      addHost: 'Add host',
      addFirstHost: 'Add your first server',
      emptyTitle: 'No remote hosts yet',
      emptyBody: 'No remote hosts yet. Add one, then open its remote DSH interface.',
      refresh: 'Refresh status',
      settings: 'Settings',
      close: 'Close',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      delete: 'Delete',
      deleting: 'Deleting…',
      edit: 'Edit',
      back: 'Back',
      retry: 'Retry',
      diagnose: 'Diagnose',
      reconnect: 'Reconnect',
      open: 'Open',
      connect: 'Connect',
      disconnect: 'Disconnect',
      connecting: 'Connecting…',
      loading: 'Loading…',
      unknown: 'Unknown',
      optional: 'optional',
      copy: 'Copy',
      copied: 'Copied',
      next: 'Next',
      done: 'Done',
      dismiss: 'Got it',
      actions: 'Actions',
      host: 'Host',
      status: 'Status',
      name: 'Name',

      hostsTitle: 'Remote hosts',
      summary: '{connected} connected / {total} total',
      lastOpened: 'Last opened',
      neverOpened: 'Never opened',
      remoteVersion: 'Remote DSH',
      versionPending: 'Shown after connecting',
      addHostTitle: 'Add server',
      editHostTitle: 'Edit server',
      deleteTitle: 'Delete this server?',
      deleteBody:
        'This removes the connection settings for "{name}" and disconnects it. Remote tasks keep running; you can add it again later.',
      deleteConfirm: 'Delete',
      deleteBusy: 'Deleting…',
      statusUnconfigured: 'Not configured',
      statusConnecting: 'Connecting',
      statusFingerprintPending: 'Fingerprint pending',
      statusConflictPending: 'Remote conflict',
      statusConnected: 'Connected',
      statusDisconnected: 'Disconnected',
      statusError: 'Error',
      statusLimited: 'Limited',
      statusHintUnconfigured: 'Never connected',
      statusHintConnecting: 'Establishing the connection',
      statusHintFingerprintPending: 'Confirm the host fingerprint',
      statusHintConflictPending: 'A manually started DSH is already running; choose how to proceed',
      statusHintConnected: 'The remote UI is available',
      statusHintDisconnected: 'Connection lost — reconnect available',
      statusHintError: 'Connection failed',
      statusHintLimited: 'Reachable, but the remote UI is unavailable',
      confirmFingerprint: 'Confirm fingerprint',
      cardOpen: 'Open',
      cardConnect: 'Connect',
      cardDisconnect: 'Disconnect',
      cardReconnect: 'Reconnect',
      cardDiagnose: 'Diagnose',
      cardEdit: 'Edit',
      cardDelete: 'Delete',
      errorReason: 'Reason: {detail}',
      loopbackNote:
        'The remote UI is embedded only through an SSH tunnel mapped to 127.0.0.1; this address is never used directly and is never exposed publicly.',

      viewportConnecting: 'Connecting to "{name}"…',
      viewportOverlayLoadFailed:
        'The remote UI failed to load. Pick “Local” in the sidebar switcher and open the host again.',
      desktopRequired: 'This window has no desktop guest seat; the remote UI only opens in the DSH desktop app.',
      // -- host switcher row (drawn in the local sidebar and the remote one) ----
      switcherLocal: 'Local',
      switcherAddHost: 'Add host',
      switcherManage: 'Manage hosts',
      switcherExit: 'Disconnect',

      'progress.ssh-connecting': 'Connecting over SSH…',
      'progress.host-key-confirm': 'Waiting for you to confirm the host key…',
      'progress.auth-checking': 'Authenticating…',
      'progress.probing': 'Probing the remote environment…',
      'progress.remote-dsh-running': 'A manually started DSH is running; waiting for your choice…',
      'progress.bootstrapping': 'Preparing the remote runtime…',
      'progress.installing-node': 'Preparing a managed Node on the remote ({version})…',
      'progress.downloading-node': 'Downloading Node {version} ({mb} MB so far)…',
      'progress.bootstrap-first-run': 'First run: fetching @deepseek-ai/dsh@{version}…',
      'progress.bootstrap-fetching': 'Fetching DSH packages…',
      'progress.bootstrap-installed': 'Packages installed; starting…',
      'progress.bootstrap-progress': 'Bootstrap: {detail}',
      'progress.starting-remote': 'Starting the remote DSH…',
      'progress.tunneling': 'Opening the loopback tunnel…',
      'progress.verifying': 'Verifying the remote UI…',
      'progress.ready': 'Ready',
      'progress.reconnecting': 'Reconnecting ({attempt}/{max})…',
      'progress.default': 'Connecting…',
      'phase.ssh': 'SSH',
      'phase.probe': 'Probe',
      'phase.bootstrap': 'Preparing runtime',
      'phase.start': 'Start',
      'phase.tunnel': 'Tunnel',
      'phase.verifying': 'Verify UI',
      'phase.ready': 'Ready',

      fingerprintTitle: 'Confirm the host fingerprint',
      fingerprintBody:
        "Confirm this server's SSH host key on first use. It is remembered after acceptance, and you are asked again if it changes.",
      fingerprintChanged: 'The host key has changed',
      fingerprintChangedBody:
        'The host key differs from the recorded one. The server may have been reinstalled — or this could be a man-in-the-middle. Continue only if you are sure.',
      fingerprintKeyType: 'Key type',
      fingerprintSha: 'SHA256 fingerprint',
      fingerprintPinned: 'Recorded fingerprint',
      fingerprintAccept: 'Accept and remember',
      fingerprintAcceptOnce: 'Accept once',
      fingerprintReject: 'Cancel',
      passwordPromptTitle: 'Enter the SSH password',
      passwordPromptBody:
        '"{name}" uses password authentication. The password is used only for this connection and is never saved.',
      passwordPromptRemember: 'Remember this password (DSH credential store)',
      passwordPromptNoStorage:
        'No credential store is available here, so the password is used for this connection only.',
      passwordPromptLabel: 'Password',
      passwordPromptSubmit: 'Connect',
      passwordPromptRequired: 'Enter the password',
      conflictTitle: 'A DSH is already running on the remote host',
      conflictBody:
        'The remote for "{name}" has {count} DSH process(es) this plugin did not start. They share ~/.dsh with the plugin, so running both may contend over the same session or credential files. Choose how to proceed:',
      conflictHint:
        '"Stop" sends SIGTERM / SIGKILL to those processes; "Keep alongside" starts a managed instance and leaves them running.',
      conflictStop: 'Stop it and start the managed instance',
      conflictAlongside: 'Keep it and start alongside',
      conflictCancel: 'Cancel connection',
      conflictBusy: 'Submitting…',

      'wizard.step1': 'SSH details',
      'wizard.step2': 'Connection test',
      'wizard.step3': 'Finish',
      'wizard.name': 'Display name',
      'wizard.namePlaceholder': 'e.g. Tencent test server',
      'wizard.address': 'SSH address or alias',
      'wizard.addressPlaceholder': 'e.g. ubuntu@192.0.2.10 or my-server',
      'wizard.addressHint': 'Aliases from ~/.ssh/config are supported.',
      'wizard.port': 'Port',
      'wizard.username': 'User',
      'wizard.usernamePlaceholder': 'e.g. ubuntu',
      'wizard.auth': 'Authentication',
      'wizard.authKey': 'Key file',
      'wizard.authPassword': 'Password (this connection only)',
      'wizard.keyPath': 'Key file path',
      'wizard.keyPathPlaceholder': 'e.g. ~/.ssh/id_ed25519',
      'wizard.keyPathPick': 'Choose file…',
      'wizard.password': 'Password',
      'wizard.passwordPlaceholder': 'Used for this connection only; never saved',
      'wizard.authHint': 'Authenticates with a private-key file; a password works too, for this connection only.',
      'wizard.jumpHost': 'Jump host (optional)',
      'wizard.jumpHostPlaceholder': 'e.g. another saved host address',
      'wizard.keepAlive': 'Remote keep-alive',
      'wizard.keepAliveKeep': 'Keep running (recommended)',
      'wizard.keepAliveStop': 'Stop on exit',
      'wizard.keepAliveIdle': 'Stop when idle',
      'wizard.idleMinutes': 'Idle minutes',
      'wizard.autoReconnect': 'Reconnect automatically',
      'wizard.testHint': 'The connection is tested right after saving; confirm the host key on first use.',
      'wizard.saveAndTest': 'Save and test',
      'wizard.savingHost': 'Saving…',
      'wizard.aliases': 'Pick from SSH config',
      'wizard.aliasesLoading': 'Reading ~/.ssh/config…',
      'wizard.aliasesEmpty': 'No SSH aliases found',
      'wizard.knownHosts': '{count} known hosts',
      'wizard.testTitle': 'Connection test',
      'wizard.testRetry': 'Test again',
      'wizard.testing': 'Testing the connection…',
      'wizard.testDone': 'Connected; the remote UI is available.',
      'wizard.finishTitle': 'Remote host is ready',
      'wizard.finishBody': 'The remote DSH interface can now open in this local window.',
      'wizard.versionLocal': 'Local DSH',
      'wizard.versionRemote': 'Remote DSH',
      'wizard.versionMatch': 'Versions match',
      'wizard.versionMismatch': 'Versions differ; the remote UI may look different',
      'wizard.bootstrapLevel': 'Launch mode',
      'wizard.uiReady': 'Remote UI',
      'wizard.uiReadyYes': 'Ready',
      'wizard.uiReadyNo': 'Not ready',
      'wizard.openRemote': 'Open remote UI',
      'wizard.finishLater': 'Later',
      'wizard.errorTitle': 'The connection test failed',
      'wizard.copyDiag': 'Copy diagnostics',
      'wizard.validationName': 'Enter a display name',
      'wizard.validationAddress': 'Enter an SSH address or alias',
      'wizard.validationAddressUrl': 'Enter an SSH address or alias, not a web URL',
      'wizard.validationPort': 'The port must be 1–65535',
      'wizard.validationUsername': 'Enter a user name',
      'wizard.validationKeyPath': 'Enter the key file path',
      'wizard.validationPassword': 'Enter the password, or switch to a key file',

      'diag.title': 'Connection diagnostics',
      'diag.running': 'Running checks…',
      'diag.summaryOk': 'All checks passed',
      'diag.summaryWarning': 'Some checks need attention',
      'diag.summaryError': 'Some checks failed',
      'diag.checkPass': 'Pass',
      'diag.checkFail': 'Fail',
      'diag.checkUnknown': 'Unknown',
      'diag.empty': 'No diagnostics yet.',
      'diag.rerun': 'Run again',
      'diag.copy': 'Copy diagnostics',
      'diag.copyDone': 'Diagnostics copied.',
      'diag.redacted': 'Diagnostics are redacted and contain no access tokens.',
      'diag.generatedAt': 'Generated',
      'diag.host': 'Host',
      'diag.failed': 'Diagnostics failed',
      'diag.close': 'Close',

      'settings.title': 'Settings',
      'settings.ssh': 'SSH defaults',
      'settings.defaultPort': 'Default port',
      'settings.defaultAuth': 'Default authentication',
      'settings.defaultAuthKey': 'Key file',
      'settings.defaultAuthPassword': 'Password (this connection only)',
      'settings.defaultKeyPath': 'Default key file',
      'settings.defaultKeyPathHint': 'Pre-filled for a new host; the wizard can still override it.',
      'settings.keyPathPick': 'Choose file…',
      'keyFile.title': 'Choose an SSH private key',
      'keyFile.hint':
        'Only files under your home directory are listed. Click a folder to enter it, a file to select it.',
      'keyFile.parent': 'Up',
      'keyFile.loading': 'Reading the directory…',
      'keyFile.empty': 'Nothing selectable in this directory',
      'keyFile.error': 'The directory could not be read',
      'keyFile.retry': 'Retry',
      'keyFile.pick': 'Use this file',
      'settings.connectTimeout': 'Connect timeout (seconds)',
      'settings.security': 'Security',
      'settings.hostKeyPolicy': 'Host key policy',
      'settings.hostKeyPolicyFirstUse': 'Ask on first use',
      'settings.hostKeyPolicyStrict': 'Strict (fail when the key changes)',
      'settings.saveTokens': 'Allow saving access tokens',
      'settings.saveTokensHint':
        'Off by default. When enabled, tokens are saved under the remote DSH_HOME with 0600 permissions, which still risks access by other processes on that machine.',
      'settings.saveTokensRisk': 'Risk: a persisted token is harder to revoke. Enable only on controlled servers.',
      'settings.reconnect': 'Auto reconnect',
      'settings.reconnectEnabled': 'Reconnect after a drop',
      'settings.maxAttempts': 'Max attempts',
      'settings.baseDelay': 'Retry delay (ms)',
      'settings.other': 'Other',
      'settings.language': 'Language',
      'settings.languageAuto': 'Follow DSH',
      'settings.languageZh': '中文',
      'settings.languageEn': 'English',
      'settings.logLevel': 'Log level',
      'settings.bootstrap': 'Remote runtime',
      'settings.profile': 'DSH profile',
      'settings.profileHint': 'Defaults to web; profile config lives in ~/.dsh/profiles/<profile>',
      'settings.bootstrapHint':
        'Launched with npx pinned to the local DSH version; when the remote Node is missing or too old, the plugin installs one under ~/.dsh/remote-go/node',
      'settings.saveSettings': 'Save settings',
      'settings.saved': 'Settings saved.',
      'settings.saveFailed': 'Failed to save settings',

      'error.actionFailed': 'Action failed',
    }

    //#endregion

    //#region 3. i18n helpers

    /**
     * Replace `{name}` placeholders with values from `params`.
     * @param {string} template - template text from a dictionary entry.
     * @param {Record<string, unknown>|undefined} params - interpolation values.
     * @returns {string} interpolated text.
     */
    function interpolate(template, params) {
      if (params === undefined || params === null) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined || params[key] === null ? match : String(params[key]),
      )
    }

    /**
     * Build a translate function over the local dictionaries. Only used when the
     * @param {string} locale - `'zh'` or `'en'`.
     * @returns {(key: string, params?: object) => string} translate function.
     */
    function makeFallbackT(locale) {
      const dict = locale === 'en' ? en : zh
      return (key, params) => {
        const text = dict[key] !== undefined ? dict[key] : en[key] !== undefined ? en[key] : key
        return interpolate(text, params)
      }
    }

    /**
     * Resolve the active locale id from the injected props.
     * @param {object} props - component props.
     * @returns {string} `'zh'` or `'en'`.
     */
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
      return 'zh'
    }

    /**
     * Resolve the translate function from props, falling back to the local dict.
     * @param {object} props - component props.
     * @returns {(key: string, params?: object) => string} translate function.
     */
    function translatorOf(props) {
      if (props && typeof props.t === 'function') return props.t
      return makeFallbackT(localeOf(props))
    }

    /**
     * Resolve a host-provided bilingual text (`{zh, en}`) for the active locale.
     * @param {unknown} text - I18nText, string, or nothing.
     * @param {string} locale - `'zh'` or `'en'`.
     * @returns {string} display text.
     */
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

    /**
     * Resolve a list of bilingual texts.
     * @param {unknown} list - array of I18nText.
     * @param {string} locale - active locale.
     * @returns {string[]} display texts, empty strings removed.
     */
    function resolveTextList(list, locale) {
      if (!Array.isArray(list)) return []
      return list.map((item) => resolveText(item, locale)).filter((item) => item.length > 0)
    }

    //#endregion

    //#region 4. misc utilities

    /**
     * True when the address is a loopback literal (`127.0.0.0/8`, `localhost`, `::1`).
     * @param {unknown} address - SSH address or alias.
     * @returns {boolean} whether the address names the local machine.
     */
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

    /**
     * True when the address looks like a web URL rather than an SSH target.
     * @param {string} address - candidate address text (already trimmed).
     * @returns {boolean} whether a scheme or path was supplied by mistake.
     */
    function looksLikeWebAddress(address) {
      const value = address.trim()
      return /^https?:\/\//i.test(value) || value.includes('://') || /[?&]token=/i.test(value)
    }

    /**
     * Validate a URL returned by `GET /hosts/:id/open` before it may become an
     * @param {unknown} url - candidate URL.
     * @returns {boolean} whether the URL is a loopback http URL.
     */
    function isValidLoopbackUrl(url) {
      return typeof url === 'string' && url.startsWith(LOOPBACK_PREFIX)
    }

    /**
     * Format an ISO timestamp for display.
     * @param {string|null|undefined} iso - ISO timestamp.
     * @param {string} locale - active locale.
     * @returns {string} localized short date/time, or an empty string.
     */
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

    /**
     * The masked address shown on cards: `user@host:port` when the Host
     * @param {object} host - HostView.
     * @returns {string} display address.
     */
    function displayAddress(host) {
      if (!host) return ''
      if (typeof host.addressMasked === 'string' && host.addressMasked.length > 0) return host.addressMasked
      if (typeof host.address === 'string' && host.address.length > 0) return host.address
      return ''
    }

    /**
     * Detach a timer from the process lifetime where the platform allows it. In the
     * browser `setInterval` returns a number and this is a no-op; under Node (unit tests
     * and tooling) it keeps a background refresh from holding the process open.
     * @param {unknown} timer - handle returned by setInterval/setTimeout.
     * @returns {void}
     */
    function unrefTimer(timer) {
      if (timer === null || typeof timer !== 'object') return
      if (typeof timer.unref !== 'function') return
      timer.unref()
    }

    /**
     * Read the local DSH release version from the page boot payload.
     * @returns {string|undefined} release version, when available.
     */
    function readBootVersion() {
      try {
        if (typeof window === 'undefined') return undefined
        const boot = window.__DSH_BOOT__
        if (!boot || typeof boot !== 'object') return undefined
        const release = boot.release
        if (!release || typeof release !== 'object') return undefined
        return typeof release.version === 'string' && release.version.length > 0 ? release.version : undefined
      } catch (_error) {
        return undefined
      }
    }

    /**
     * Copy text with the Clipboard API, falling back to a hidden textarea plus
     * @param {string} text - text to copy.
     * @returns {Promise<boolean>} whether the copy succeeded.
     */
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

    /**
     * Bilingual name of a connect phase.
     * @param {(key: string, params?: object) => string} t - translate function.
     * @param {string|null|undefined} phase - ConnectPhase.
     * @returns {string} phase label.
     */
    function phaseLabel(t, phase) {
      if (!phase) return ''
      return t('phase.' + phase)
    }

    /**
     * Localized progress line for a host (docs/api.md 进度 code).
     * @param {(key: string, params?: object) => string} t - translate function.
     * @param {object|null} progress - host.progress.
     * @returns {string} progress text.
     */
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

    /**
     * Index of the current connect phase, for the progress checklist.
     * @param {string|null|undefined} phase - ConnectPhase.
     * @returns {number} 0..PHASES.length-1, or -1 when unknown.
     */
    function phaseIndex(phase) {
      return phase ? PHASES.indexOf(phase) : -1
    }

    /** Explicit status → dictionary-key map (status ids contain dashes). */
    const STATUS_KEYS = {
      unconfigured: { label: 'statusUnconfigured', hint: 'statusHintUnconfigured' },
      connecting: { label: 'statusConnecting', hint: 'statusHintConnecting' },
      'fingerprint-pending': { label: 'statusFingerprintPending', hint: 'statusHintFingerprintPending' },
      'conflict-pending': { label: 'statusConflictPending', hint: 'statusHintConflictPending' },
      connected: { label: 'statusConnected', hint: 'statusHintConnected' },
      disconnected: { label: 'statusDisconnected', hint: 'statusHintDisconnected' },
      error: { label: 'statusError', hint: 'statusHintError' },
      limited: { label: 'statusLimited', hint: 'statusHintLimited' },
    }

    /**
     * Status presentation: dictionary key and tone.
     * @param {string} status - HostStatus.
     * @returns {{labelKey: string, hintKey: string, tone: string}} presentation.
     */
    function statusMeta(status) {
      const keys = STATUS_KEYS[status] || STATUS_KEYS.unconfigured
      return {
        labelKey: keys.label,
        hintKey: keys.hint,
        tone: STATUS_TONE[status] || 'idle',
      }
    }

    /**
     * Value at a dotted path, or a fallback.
     * @param {object|undefined} source - object to read.
     * @param {string} path - dotted path.
     * @param {unknown} fallback - value when the path is missing.
     * @returns {unknown} resolved value.
     */
    function pathValue(source, path, fallback) {
      let current = source
      for (const part of String(path).split('.')) {
        if (current === null || current === undefined || typeof current !== 'object') return fallback
        current = current[part]
      }
      return current === undefined ? fallback : current
    }

    /**
     * Pick the hosts that are currently connected.
     * @param {object[]} hosts - HostView list.
     * @returns {number} connected count.
     */
    function connectedCount(hosts) {
      if (!Array.isArray(hosts)) return 0
      let count = 0
      for (const host of hosts) if (host && host.status === 'connected') count += 1
      return count
    }

    /**
     * One-shot request channel into the panel: the switcher row (and the settings page)
     * ask the panel for one target — open a host, or start the add-host wizard — and then
     * switch the layout to it. The panel consumes the request on mount or on subscribe,
     * and an "open" waits for `/state` so it knows the host's status and auth type.
     * @returns {{request: Function, requestIntent: Function, take: Function, subscribe: Function}} store handle.
     */
    function createPanelRequestStore() {
      let pending = null
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (_error) {
            // a stale listener must not break the request
          }
        }
      }
      return {
        /**
         * Ask for one host by id (settings page shorthand).
         * @param {string} hostId - host to open.
         * @returns {void}
         */
        request(hostId) {
          if (typeof hostId === 'string' && hostId.length > 0) {
            pending = { kind: 'open', hostId }
            emit()
          }
        },
        /**
         * Ask for a target directly.
         * @param {{kind: string, hostId?: string}} intent - `open` one host, `disconnect` one host, `manage` the list, or `local`.
         * @returns {void}
         */
        requestIntent(intent) {
          if (!intent || typeof intent !== 'object') return
          const kinds = ['open', 'disconnect', 'manage', 'local']
          if (!kinds.includes(intent.kind)) return
          if ((intent.kind === 'open' || intent.kind === 'disconnect') && typeof intent.hostId !== 'string') return
          pending =
            intent.kind === 'open' || intent.kind === 'disconnect'
              ? { kind: intent.kind, hostId: intent.hostId }
              : { kind: intent.kind }
          emit()
        },
        take() {
          const intent = pending
          pending = null
          return intent
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * The add/edit host wizard lives in the shell's overlay seat, not in the panel: opening
     * it must work from any page (local content, host management, or over a remote window)
     * and must not drag the management page along with it.
     * @returns {{open: Function, close: Function, current: Function, subscribe: Function}} store handle.
     */
    function createWizardStore() {
      let draft = null
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (_error) {
            // a stale listener must not break the wizard
          }
        }
      }
      return {
        /**
         * Open the wizard on one draft.
         * @param {{mode?: string, host?: object|null}} next - add or edit this host.
         * @returns {void}
         */
        open(next) {
          if (!next || typeof next !== 'object') return
          draft = { mode: next.mode === 'edit' ? 'edit' : 'add', host: next.host || null }
          emit()
        },
        /** @returns {void} */
        close() {
          if (draft === null) return
          draft = null
          emit()
        },
        /** @returns {{mode: string, host: object|null}|null} the open draft. */
        current() {
          return draft
        },
        /** @returns {() => void} unsubscribe. */
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    //#endregion

    //#region 5. local error views

    /**
     * Local fallback ErrorViews (docs/api.md ErrorView). Host responses carry
     * their own ErrorView; these describe client-side and transport failures.
     */
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
      'invalid-input': {
        code: 'invalid-input',
        retryable: false,
        title: { zh: '输入不合法', en: 'Invalid input' },
        detail: { zh: '请检查填写的参数后重试。', en: 'Check the values you entered and try again.' },
        nextSteps: [{ zh: '返回表单修正后重试', en: 'Go back to the form, fix it, and retry' }],
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

    /**
     * Build a local ErrorView with optional technical detail.
     * @param {string} code - key into LOCAL_ERRORS.
     * @param {string|undefined} technical - optional technical detail.
     * @returns {object} ErrorView.
     */
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

    /**
     * Normalize anything thrown by the API layer into an ErrorView.
     * @param {unknown} error - caught value.
     * @returns {object} ErrorView.
     */
    function toErrorView(error) {
      if (error && typeof error === 'object') {
        if (error.view && typeof error.view === 'object') return error.view
        if (error.title && error.detail) return error
      }
      const technical = error && typeof error.message === 'string' ? error.message : String(error)
      return localErrorView('internal', technical)
    }

    //#endregion

    //#region 6. HTTP + SSE API client

    /** @returns {Function|null} fetch implementation or null when unavailable. */
    function getFetch() {
      try {
        if (typeof fetch === 'function') return fetch
        if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window)
      } catch (_error) {
        return null
      }
      return null
    }

    /**
     * Wrap an ErrorView in an Error so callers can `catch`/`throw` it.
     * @param {object} view - ErrorView.
     * @param {unknown} [cause] - underlying cause.
     * @returns {Error} error carrying `.view`.
     */
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

    /**
     * One JSON request against the Host API. All requests carry the plugin
     * marker header and same-origin credentials (docs/api.md 安全约束).
     * @param {string} path - path below `/dsh-remote-go/api`.
     * @param {{method?: string, body?: object, signal?: AbortSignal}} [options] - request options.
     * @returns {Promise<object>} `{ok:true, ...}` payload.
     */
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

    /** Host API surface used by the UI. */
    const api = {
      /** @returns {Promise<object>} StateView (docs/api.md `GET /state`). */
      async getState() {
        const payload = await apiRequest('/state')
        return payload.state
      },
      /**
       * Tell the Host the version the page booted with (tolerant, optional).
       * @param {string|undefined} version - local DSH release version.
       * @returns {Promise<void>} resolves even when the call fails.
       */
      async reportLocalVersion(version) {
        if (typeof version !== 'string' || version.length === 0) return
        try {
          await apiRequest('/local-version', { method: 'POST', body: { version } })
        } catch (_error) {
          // Tolerated by contract: this only backfills the Host's probe.
        }
      },
      /** @param {string} hostId - host id. @returns {Promise<object>} connect acknowledgement. */
      async connect(hostId, options) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/connect', {
          method: 'POST',
          body: options || {},
        })
      },
      /** Answer the "manual DSH already running" prompt: stop | alongside | cancel. */
      async confirmConflict(hostId, action) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/conflict', {
          method: 'POST',
          body: { action },
        })
      },
      /** @param {string} hostId - host id. @returns {Promise<object>} acknowledgement. */
      async disconnect(hostId, stopRemote) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/disconnect', {
          method: 'POST',
          body: { stopRemote: stopRemote === true },
        })
      },
      /** @param {string} hostId - host id. @returns {Promise<object>} acknowledgement. */
      async reconnect(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/reconnect', { method: 'POST', body: {} })
      },
      /**
       * Fetch the one-time loopback URL for the guest (docs/api.md `GET /hosts/:id/open`).
       * @param {string} hostId - host id.
       * @returns {Promise<string>} validated loopback URL.
       */
      async openHost(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/open')
        if (!isValidLoopbackUrl(payload.url)) throw apiError(localErrorView('blocked-url'))
        return payload.url
      },
      /** @param {string} hostId - host id. @returns {Promise<object>} acknowledgement. */
      async acceptFingerprint(hostId, accept, remember, sha256) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/fingerprint', {
          method: 'POST',
          body: { accept: accept === true, remember: remember === true, sha256: sha256 || '' },
        })
      },
      /** @param {object} host - HostInput. @returns {Promise<object>} saved HostView. */
      async saveHost(host) {
        const payload = await apiRequest('/hosts', { method: 'POST', body: { host } })
        return payload.host
      },
      /** @param {string} hostId - host id. @returns {Promise<object>} acknowledgement. */
      async deleteHost(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId), { method: 'DELETE' })
      },
      /** @param {string} hostId - host id. @returns {Promise<object>} diagnose report. */
      async diagnose(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/diagnose', {
          method: 'POST',
          body: {},
        })
        return payload.report
      },
      /** @param {object} patch - partial SettingsView. @returns {Promise<object>} full SettingsView. */
      async saveSettings(patch) {
        const payload = await apiRequest('/settings', { method: 'POST', body: { patch } })
        return payload.settings
      },
      /**
       * Point the Host's active host at `hostId` so a reload reopens the same
       * @param {string} hostId - host id.
       * @returns {Promise<object>} acknowledgement.
       */
      async activate(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/activate', { method: 'POST', body: {} })
      },
      /**
       * Tell the Host that no host fills the window any more (docs/api.md `POST /active`).
       * @returns {Promise<object>} acknowledgement.
       */
      async clearActive() {
        return apiRequest('/active', { method: 'POST', body: { id: null } })
      },
      /** @returns {Promise<{aliases: object[], knownHosts: object}>} SSH alias scan (docs/api.md). */
      async getAliases() {
        const payload = await apiRequest('/ssh/aliases')
        return {
          aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
          knownHosts: payload.knownHosts && typeof payload.knownHosts === 'object' ? payload.knownHosts : null,
        }
      },
      /**
       * Browse the user's home for a private-key file (docs/api.md `GET /keyfile/list`).
       * @param {string} [dir] absolute directory to list; empty means the default one.
       * @returns {Promise<{path: string, parent: string | null, entries: Array<{name: string, path: string, isDirectory: boolean}>, truncated: boolean, defaultKeyPath: string, defaultDir: string}>}
       */
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

    /**
     * Subscribe to live state: SSE first, 3s polling once the stream fails
     * (docs/api.md). Always resolves the current state once up front.
     * @param {{onState: (state: object) => void, onStatus?: (mode: string) => void, onError?: (error: unknown) => void}} handlers - callbacks.
     * @returns {() => void} dispose function.
     */
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

      // Initial read in parallel with opening the stream, so the panel can paint
      // immediately even when SSE is slow.
      fetchOnce()
      startStream()

      return () => {
        disposed = true
        stopStream()
        if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
        timer = null
      }
    }

    //#endregion

    //#region 7. icons and small UI primitives

    /**
     * Sidebar/main-entry glyph: a local display with a tunnel arrow leaving it.
     * Original artwork, drawn in `currentColor` only.
     * @param {{size?: number, active?: boolean}} props - sidebar share (size, active).
     * @returns {object} svg element.
     */
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

    /** Generic stroke icon factory: paths only, currentColor. */
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

    /**
     * Status dot. Color comes from theme tokens with stable fallbacks.
     * @param {{status?: string, title?: string}} props - host status.
     * @returns {object} span element.
     */
    function StatusDot(props) {
      const status = props && typeof props.status === 'string' ? props.status : 'unconfigured'
      const tone = STATUS_TONE[status] || 'idle'
      const label = props && typeof props.title === 'string' ? props.title : undefined
      return h('span', {
        className: 'drg-dot',
        style: { background: TONE_VARS[tone] },
        title: label,
        'aria-hidden': label === undefined ? 'true' : undefined,
        'data-tone': tone,
      })
    }

    /**
     * Small text badge.
     * @param {{children?: unknown, tone?: string, title?: string}} props - badge props.
     * @returns {object} span element.
     */
    function Badge(props) {
      const tone = props && typeof props.tone === 'string' ? props.tone : 'idle'
      return h(
        'span',
        {
          className: 'drg-badge',
          'data-tone': tone,
          title: props && props.title,
          'data-testid': props && props.testId,
        },
        props && props.children,
      )
    }

    /**
     * Button. Variants: primary | secondary | ghost | danger.
     * @param {object} props - button props.
     * @returns {object} button element.
     */
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
          'aria-label': props.ariaLabel,
          'data-testid': props.testId,
          'data-busy': props.busy === true ? 'true' : undefined,
        },
        props.busy === true ? h(Spinner, { size: 14 }) : null,
        h('span', { className: 'drg-btn-label' }, props.children),
      )
    }

    /**
     * Icon-only button with an accessible label.
     * @param {object} props - icon button props.
     * @returns {object} button element.
     */
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

    /**
     * Spinner.
     * @param {{size?: number}} props - size in px.
     * @returns {object} span element.
     */
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

    /**
     * Labeled form field wrapper.
     * @param {{label?: string, hint?: string, error?: string, htmlFor?: string, children?: unknown}} props - field props.
     * @returns {object} div element.
     */
    function Field(props) {
      return h(
        'label',
        {
          className: 'drg-field' + (props.wide === true ? ' drg-field-wide' : ''),
          htmlFor: props.htmlFor,
        },
        props.label ? h('span', { className: 'drg-field-label' }, props.label) : null,
        props.children,
        props.hint ? h('span', { className: 'drg-field-hint' }, props.hint) : null,
        props.error ? h('span', { className: 'drg-field-error', role: 'alert' }, props.error) : null,
      )
    }

    /**
     * Text/number/password input styled for the theme.
     * @param {object} props - input props.
     * @returns {object} input element.
     */
    function TextInput(props) {
      return h('input', {
        className: 'drg-input',
        type: props.type || 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder,
        list: props.list,
        disabled: props.disabled === true,
        readOnly: props.readOnly === true,
        autoComplete: props.autoComplete || 'off',
        spellCheck: false,
        'data-testid': props.testId,
        onChange: typeof props.onChange === 'function' ? (event) => props.onChange(event.target.value) : undefined,
        onKeyDown: typeof props.onKeyDown === 'function' ? props.onKeyDown : undefined,
        'aria-label': props.ariaLabel,
      })
    }

    /**
     * Select control.
     * @param {{value?: string, options?: Array<{value: string, label: string}>, onChange?: (value: string) => void, disabled?: boolean, ariaLabel?: string}} props - select props.
     * @returns {object} select element.
     */
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

    /**
     * Checkbox row.
     * @param {{checked?: boolean, label?: string, onChange?: (checked: boolean) => void, disabled?: boolean}} props - checkbox props.
     * @returns {object} label element.
     */
    function CheckRow(props) {
      return h(
        'label',
        { className: 'drg-check' },
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

    /**
     * Notice banner. Tones: info | warn | error | success.
     * @param {{tone?: string, title?: string, children?: unknown, onDismiss?: () => void, dismissLabel?: string}} props - notice props.
     * @returns {object} div element.
     */
    function Notice(props) {
      const tone = props.tone || 'info'
      return h(
        'div',
        { className: 'drg-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
        h(
          'span',
          { className: 'drg-notice-icon', 'aria-hidden': 'true' },
          tone === 'error' ? h(IconAlert) : tone === 'success' ? h(IconCheck) : h(IconAlert),
        ),
        h(
          'div',
          { className: 'drg-notice-body' },
          props.title ? h('div', { className: 'drg-notice-title' }, props.title) : null,
          props.children !== undefined && props.children !== null
            ? h('div', { className: 'drg-notice-text' }, props.children)
            : null,
        ),
        typeof props.onDismiss === 'function'
          ? h(
              'button',
              { type: 'button', className: 'drg-notice-dismiss', onClick: props.onDismiss },
              props.dismissLabel || '×',
            )
          : null,
      )
    }

    /**
     * Modal shell: backdrop + centered card. Closes on backdrop click and Esc.
     * @param {{title?: string, subtitle?: string, onClose?: () => void, footer?: unknown, children?: unknown, wide?: boolean, closeLabel?: string}} props - modal props.
     * @returns {object} div element.
     */
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
      return h(
        'div',
        { className: 'drg-modal-layer' },
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
          h(
            'div',
            { className: 'drg-modal-head' },
            h(
              'div',
              { className: 'drg-modal-titles' },
              props.title ? h('h2', { className: 'drg-modal-title' }, props.title) : null,
              props.subtitle ? h('p', { className: 'drg-modal-subtitle' }, props.subtitle) : null,
            ),
            typeof onClose === 'function'
              ? h(IconButton, { icon: h(IconClose), label: props.closeLabel || 'Close', onClick: onClose })
              : null,
          ),
          h('div', { className: 'drg-modal-body' }, props.children),
          props.footer ? h('div', { className: 'drg-modal-foot' }, props.footer) : null,
        ),
      )
    }

    /**
     * Confirmation dialog for destructive actions.
     * @param {{title: string, body: unknown, confirmLabel: string, cancelLabel: string, busy?: boolean, onConfirm: () => void, onCancel: () => void}} props - dialog props.
     * @returns {object} modal element.
     */
    function ConfirmDialog(props) {
      return h(
        Modal,
        {
          title: props.title,
          onClose: props.onCancel,
          closeLabel: props.cancelLabel,
          footer: h(
            'div',
            { className: 'drg-row drg-row-end' },
            h(
              Button,
              { variant: 'secondary', onClick: props.onCancel, disabled: props.busy === true },
              props.cancelLabel,
            ),
            h(Button, { variant: 'danger', onClick: props.onConfirm, busy: props.busy === true }, props.confirmLabel),
          ),
        },
        h('p', { className: 'drg-paragraph' }, props.body),
      )
    }

    //#endregion

    //#region 8. host list view

    /**
     * Loading placeholder used before the first `/state` response arrives.
     * @param {{t: Function}} props - translate props.
     * @returns {object} div element.
     */
    function LoadingBlock(props) {
      const t = translatorOf(props)
      return h(
        'div',
        { className: 'drg-loading' },
        h(Spinner, { size: 20 }),
        h('span', null, props.label || t('loading')),
      )
    }

    /**
     * Empty-state block shown when no hosts are configured.
     * @param {{t: Function, onAdd: () => void}} props - callbacks.
     * @returns {object} div element.
     */
    function EmptyHosts(props) {
      const t = translatorOf(props)
      return h(
        'div',
        { className: 'drg-empty', 'data-testid': 'host-list-empty' },
        h('div', { className: 'drg-empty-icon', 'aria-hidden': 'true' }, h(RemoteIcon, { size: 40 })),
        h('h3', { className: 'drg-empty-title' }, t('emptyTitle')),
        h('p', { className: 'drg-empty-body' }, t('emptyBody')),
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

    /**
     * One host card: status, address, remote version, last opened, and actions.
     * @param {object} props - host and callbacks.
     * @returns {object} li element.
     */
    function HostCard(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const host = props.host || {}
      const busy = props.busy === true
      const meta = statusMeta(host.status || 'unconfigured')
      const statusLabel = t(meta.labelKey)
      const remoteVersion =
        host.remote && typeof host.remote.version === 'string' && host.remote.version.length > 0
          ? host.remote.version
          : t('versionPending')
      const lastOpened = host.lastOpenedAt ? formatTime(host.lastOpenedAt, locale) : t('neverOpened')
      const failing = host.status === 'error' || host.status === 'limited'
      const reason = host.error ? resolveText(host.error.detail, locale) || resolveText(host.error.title, locale) : ''
      const primaryLabel =
        host.status === 'connected'
          ? t('cardOpen')
          : host.status === 'fingerprint-pending'
            ? t('confirmFingerprint')
            : host.status === 'conflict-pending'
              ? t('statusConflictPending')
              : host.status === 'connecting'
                ? t('connecting')
                : t('cardConnect')
      const primaryTestId = 'host-open'
      const primaryDisabled = busy || host.status === 'connecting' || host.status === 'conflict-pending'

      return h(
        'li',
        { className: 'drg-host-card', 'data-status': host.status, 'data-testid': 'host-card', 'data-host-id': host.id },
        host.status === 'conflict-pending'
          ? h(
              'div',
              { className: 'drg-card-strip', role: 'status' },
              h(IconAlert, { size: 14 }),
              h('span', { className: 'drg-card-strip-text' }, t('statusHintConflictPending')),
            )
          : failing
            ? h(
                'div',
                { className: 'drg-card-strip', role: 'alert' },
                h(IconAlert, { size: 14 }),
                h(
                  'span',
                  { className: 'drg-card-strip-text' },
                  t('errorReason', { detail: reason || t(meta.hintKey) }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'drg-linkbtn',
                    onClick: typeof props.onDiagnose === 'function' ? () => props.onDiagnose(host) : undefined,
                  },
                  t('cardDiagnose'),
                ),
              )
            : null,
        h(
          'div',
          { className: 'drg-card-head' },
          h(StatusDot, { status: host.status, title: statusLabel }),
          h('h3', { className: 'drg-card-name', title: host.name }, host.name || host.id),
          h(Badge, { tone: meta.tone, title: t(meta.hintKey) }, statusLabel),
        ),
        h('div', { className: 'drg-card-address', title: displayAddress(host) }, displayAddress(host) || '—'),
        h(
          'dl',
          { className: 'drg-card-meta' },
          h('div', null, h('dt', null, t('remoteVersion')), h('dd', null, remoteVersion)),
          h('div', null, h('dt', null, t('lastOpened')), h('dd', null, lastOpened)),
        ),
        h(
          'div',
          { className: 'drg-card-actions' },
          h(
            Button,
            {
              variant: host.status === 'connected' ? 'primary' : 'secondary',
              testId: primaryTestId,
              onClick: () => {
                if (typeof props.onOpen === 'function') props.onOpen(host)
              },
              disabled: primaryDisabled,
              busy: busy && host.status !== 'connected' && host.status !== 'connecting',
            },
            primaryLabel,
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
          host.status === 'disconnected' || host.status === 'error' || host.status === 'limited'
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
          h(
            'div',
            { className: 'drg-card-actions-end' },
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

    /**
     * Host list for the floating management window (docs/design.md（主机清单）). Pure
     * presentation: all actions rise through callbacks.
     * @param {object} props - state, errors, and callbacks.
     * @returns {object} div element.
     */
    function HostListView(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const state = props.state || null
      const loading = props.loading === true
      const error = props.error || null
      const hosts = state && Array.isArray(state.hosts) ? state.hosts : []
      const connected = connectedCount(hosts)
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
        content = h(
          'div',
          { className: 'drg-host-body' },
          h(
            'div',
            { className: 'drg-summary' },
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
                onConnect: props.onConnectHost,
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

      return h(
        'div',
        { className: 'drg-page drg-host-page' },
        h(
          'header',
          { className: 'drg-page-head' },
          h(
            'div',
            { className: 'drg-page-heading' },
            h('h1', { className: 'drg-page-title' }, t('hostsTitle')),
            h('p', { className: 'drg-page-subtitle' }, t('panelSubtitle')),
          ),
          h(
            'div',
            { className: 'drg-page-actions' },
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

    //#endregion

    //#region 9. takeover surface and carrier helpers

    /**
     * Staged connect progress: current progress line plus the phase checklist
     * (docs/api.md 的 ConnectPhase / 进度 code).
     * @param {{t: Function, host: object}} props - host being connected.
     * @returns {object} div element.
     */
    function ConnectProgress(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const current = phaseIndex(host.phase)
      const name = host.name || host.id || ''
      return h(
        'div',
        { className: 'drg-progress' },
        h(
          'div',
          { className: 'drg-progress-head' },
          h(Spinner, { size: 22 }),
          h('h2', { className: 'drg-progress-title' }, t('viewportConnecting', { name })),
        ),
        h(
          'p',
          { className: 'drg-progress-line', 'data-progress': host.progress ? host.progress.code : undefined },
          progressText(t, host.progress),
        ),
        h(
          'ol',
          { className: 'drg-phases' },
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
              h('span', null, phaseLabel(t, phase)),
            )
          }),
        ),
      )
    }

    /**
     * Host-key confirmation card. Used by both the wizard's test step and the
     * @param {object} props - host, busy flag, error, callbacks.
     * @returns {object} div element.
     */
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
        h('h2', { className: 'drg-fingerprint-title' }, changed ? t('fingerprintChanged') : t('fingerprintTitle')),
        h('p', { className: 'drg-fingerprint-body' }, changed ? t('fingerprintChangedBody') : t('fingerprintBody')),
        h(
          'dl',
          { className: 'drg-kv' },
          keyType
            ? h('div', null, h('dt', null, t('fingerprintKeyType')), h('dd', null, h('code', null, keyType)))
            : null,
          sha256
            ? h(
                'div',
                null,
                h('dt', null, t('fingerprintSha')),
                h('dd', null, h('code', { className: 'drg-break' }, sha256)),
              )
            : null,
          pinned && changed
            ? h(
                'div',
                null,
                h('dt', null, t('fingerprintPinned')),
                h('dd', null, h('code', { className: 'drg-break' }, pinned)),
              )
            : null,
        ),
        props.error
          ? h(
              Notice,
              { tone: 'error' },
              resolveText(toErrorView(props.error).detail, locale) || t('error.actionFailed'),
            )
          : null,
        h(
          'div',
          { className: 'drg-row drg-row-wrap' },
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

    /**
     * Error card: localized title/detail/next steps + retry/diagnose/back.
     * @param {object} props - ErrorView plus callbacks.
     * @returns {object} div element.
     */
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
        h('h2', { className: 'drg-error-title' }, title),
        detail ? h('p', { className: 'drg-error-detail' }, detail) : null,
        steps.length > 0
          ? h(
              'div',
              { className: 'drg-error-steps' },
              h('div', { className: 'drg-section-label' }, t('next')),
              h(
                'ul',
                null,
                steps.map((step, index) => h('li', { key: String(index) }, step)),
              ),
            )
          : null,
        h(
          'div',
          { className: 'drg-row drg-row-wrap' },
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

    //#region 9b. host switcher row + full-window remote carrier (DSH desktop only)

    /** How often the row re-places itself and refreshes its payload (ms). */
    const SWITCHER_TICK_MS = 1500

    /**
     * What both copies of the row show. `/state` feeds the host list and the panel says
     * which target the window is on; the row itself is plain DOM, so it never re-renders
     * through React and keeps working while the local UI is behind a remote guest.
     */
    const switcher = {
      /** `'local'` or a host id: where the window is right now. */
      current: 'local',
      /** HostView list from `/state`, trimmed to what the row needs. */
      hosts: [],
      /** Localized row text, refreshed on every push. */
      labels: { local: 'Local', addHost: 'Add host', manage: 'Manage hosts', exit: 'Exit remote' },
      /** Set by `apply`: turns a row intent into a plugin action. */
      dispatch: null,
      /** Set by `apply`: current localized labels, so a language switch lands on the next push. */
      labelsOf: null,
      /** Whether the local copy of the row is currently on screen. */
      installed: false,
    }

    /**
     * @returns {{current: string, hosts: object[], labels: object}} the payload both copies of the row render from.
     */
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

    /**
     * Push the switcher state into every live copy of the row: the local page's sidebar
     * and, while a remote owns the window, the row injected into the guest.
     * @param {{current?: string, hosts?: object[], labels?: object}} [patch] - merged into the state first.
     * @returns {object} the payload that was pushed.
     */
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

    /** @returns {Window|null} this page's window, or null when the module runs outside a document. */
    function localWindow() {
      if (typeof window === 'undefined' || window === null) return null
      if (typeof window.document === 'undefined' || window.document === null) return null
      return window
    }

    /**
     * Draw (or refresh) the row in the local page's own sidebar. It is plain DOM beside
     * React's children, so the shell may drop it on a re-render; this re-places it and
     * refreshes the payload, and is cheap enough to call on every state push.
     * @param {object} payload - state to render.
     * @returns {boolean} whether the row is on screen.
     */
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

    /**
     * Push the same payload into the shown remote guest's copy of the row.
     * @param {object} payload - state to render.
     * @returns {void}
     */
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

    /**
     * Turn the row's intent into the plugin's action. The local row calls this straight
     * from the click handler; the guest reaches it through the carrier's poll.
     * @param {{target?: string, action?: string, hostId?: string}} intent - sidebar entry, an action, or one host's exit.
     * @returns {void}
     */
    function dispatchSwitcherIntent(intent) {
      if (!intent || typeof intent !== 'object') return
      if (typeof switcher.dispatch === 'function') switcher.dispatch(intent)
    }

    /**
     * The host switcher, as one self-contained function.
     *
     * It runs directly in the local page and is stringified into the remote guest
     * (`HOST_ROW_SCRIPT`), so both windows get the same markup, the same theme tokens and
     * the same intents. It may therefore only touch `win` and its own locals - no closure
     * over this module.
     *
     * Intents leave through `win.__drgBridgeSink` when the page sets one (the local page
     * hands them straight to the plugin) and through `win.__drgBridgeQueue` otherwise (the
     * guest, drained by the carrier).
     *
     * The sidebar row shows the current target only - no session title line; the menu
     * lists "local" first, then one entry per host (a connected host carries a glowing
     * green dot), then "add host" at the bottom.
     * @param {Window} win - page to draw the row into.
     * @returns {string} 'installed' once the row is placed, otherwise why it is not.
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
          '#drg-host-row .drg-hr-menu{display:none;position:fixed;z-index:2147483000;min-width:220px;max-height:min(60vh,420px);overflow:auto;padding:5px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);font-size:13px}',
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
          // A live host carries its own exit control, on the same line, right-aligned and
          // revealed on hover: switching to a host and leaving it are different actions,
          // and the menu had no way to leave one.
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

    /** The same row, as the script the carrier evaluates inside the remote guest. */
    const HOST_ROW_SCRIPT = '(' + mountHostRow.toString() + ')(window)'

    /**
     * The live guests, most recently shown first, plus which one fills the window.
     *
     * Keeping a guest warm is what makes switching instant: the remote page is never
     * reloaded when you go away and come back, it is only hidden and shown. There is no
     * count limit — every host you have opened keeps its window — so a guest is dropped
     * only when its host disconnects or is deleted, or when the plugin is disposed.
     */
    const carrierPool = {
      /** @type {object[]} live guests, most recent first. */
      entries: [],
      /** Host id filling the window right now, or null when the local page is up. */
      current: null,
      /**
       * Host id the window should end up on. A window is created asynchronously (the
       * bridge hands out a lease), so this is what makes the *last* request win: a
       * creation that finishes after the user picked something else is dropped.
       */
      wanted: null,
      /** The one intent poll, owned by the shown guest. */
      poll: null,
    }

    /**
     * Show/hide operations run one at a time, in order: two overlapping opens must never
     * build two guests for the same host, and the later pick must land last.
     * @type {Promise<unknown>}
     */
    let carrierQueue = Promise.resolve()

    /**
     * Serialize one carrier operation behind the previous one.
     * @param {Function} task - async work to run when the queue is free.
     * @returns {Promise<unknown>} that task's result.
     */
    function whenCarrierIdle(task) {
      const run = carrierQueue.then(task, task)
      carrierQueue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    /**
     * @param {string} hostId - host to look up.
     * @returns {object|null} that host's warm guest, if any.
     */
    function carrierOf(hostId) {
      if (typeof hostId !== 'string' || hostId === '') return null
      return carrierPool.entries.find((entry) => entry.hostId === hostId) || null
    }

    /** @returns {object|null} the guest filling the window, if any. */
    function shownCarrier() {
      return carrierPool.current === null ? null : carrierOf(carrierPool.current)
    }

    /** @returns {boolean} whether this host already has a warm window (switching is instant). */
    function carrierWarm(hostId) {
      return carrierOf(hostId) !== null
    }

    /** @returns {object|null} the desktop browser bridge, or null outside the desktop app. */
    function desktopBrowserBridge() {
      if (typeof window === 'undefined') return null
      const carrier = window.dshDesktop
      if (!carrier || carrier.protocolVersion !== DESKTOP_BRIDGE_VERSION) return null
      const browser = carrier.browser
      if (!browser || typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return null
      return browser
    }

    /**
     * The carrier's own CSS. There is no local chrome left to style: the host switcher is
     * drawn inside whichever page owns the window.
     */
    const CARRIER_CSS = `
      .drg-carrier-view{position:absolute;left:0;right:0;top:0;bottom:0;border:0;background:var(--dsw-alias-bg-base);pointer-events:auto}
      .drg-carrier-error{position:absolute;left:0;right:0;top:0;bottom:0;z-index:2;display:none;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);font:13px var(--dsw-font-family)}
    `

    /**
     * Install the switcher row inside one guest.
     * @param {object} entry - warm guest to inject into.
     * @returns {Promise<boolean>} whether that guest's copy of the row is live.
     */
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

    /**
     * Poll the shown guest's row for a click, then hand the intent to the plugin. A plain
     * poll is the only channel a cross-origin guest offers without a preload script.
     * @param {object} entry - warm guest to poll.
     * @returns {void}
     */
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

    /** @returns {void} */
    function stopHostRowPoll() {
      const entry = carrierPool.poll
      carrierPool.poll = null
      if (entry !== null && entry !== undefined && entry.timer !== null && entry.timer !== undefined) {
        if (typeof clearInterval === 'function') clearInterval(entry.timer)
        entry.timer = null
      }
    }

    /**
     * Build one guest: a fresh partition, the switcher row, and the failure line.
     * @param {string} hostId - host this window belongs to.
     * @param {string} url - loopback launch URL (already validated by the caller).
     * @param {string} message - load-failure line.
     * @returns {Promise<object|null>} the warm guest, or null when it cannot be acquired.
     */
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

      const root = document.createElement('div')
      // One root per warm host, so the ids stay unique (the host shows which window it is).
      root.id = OVERLAY_ROOT_ID + '-' + (hostId || 'host')
      root.setAttribute('data-testid', 'remote-overlay')
      root.setAttribute('data-host-id', hostId)
      // The desktop window is frameless with a 40px titlebar overlay (Windows caption
      // buttons / macOS traffic lights), so the carrier starts below it: clicks in
      // that band belong to the OS, not to this page.
      root.style.cssText = [
        'position:fixed;left:0;right:0;bottom:0;top:40px;z-index:2147483000',
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

      const view = document.createElement('webview')
      view.className = 'drg-carrier-view'
      view.setAttribute('name', String(reservation.lease))
      view.setAttribute('partition', String(reservation.partition))
      view.setAttribute('allowpopups', '')
      view.setAttribute('src', 'about:blank#' + String(reservation.lease))

      // Built before any listener is attached: the handlers below read it, and a guest
      // that fired an event while the element was being appended would otherwise read a
      // binding that is still in its temporal dead zone.
      const entry = {
        hostId,
        lease: String(reservation.lease),
        root,
        view,
        url,
        rowInstalled: false,
        /** Set when a main-frame load failed, so the next show retries instead of reusing it. */
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
      view.addEventListener('did-stop-loading', () => {
        if (entry.view !== view) return
        errorLayer.style.display = 'none'
        entry.failed = false
        // Re-install after *every* load stop: the remote page reloading wipes the
        // injected DOM, and a one-shot install would leave the window without any
        // control. The script is idempotent inside the page.
        installHostRow(entry).then((live) => {
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
      })

      root.append(style, view, errorLayer)
      document.body.appendChild(root)

      return entry
    }

    /**
     * Show one host's window, warming it first when this is its first visit. Everything
     * else is hidden, never torn down: that is what makes coming back instant.
     *
     * Operations are queued, and a window is created asynchronously (the bridge hands out
     * a lease), so two things can happen in between: the user picks another host, or the
     * window has to go back to the local page. `carrierPool.wanted` remembers the last
     * request; a creation that is no longer wanted is dropped instead of shown.
     * @param {{hostId?: string, url?: string, message?: string}} options - target host and an optional fresh launch URL.
     * @returns {Promise<{ ok: boolean, reason?: string, reused?: boolean }>}
     */
    async function showOverlay(options) {
      const hostId = typeof options.hostId === 'string' ? options.hostId : ''
      carrierPool.wanted = hostId
      return whenCarrierIdle(() => showOverlayNow(hostId, options))
    }

    /**
     * @param {string} hostId - host to show.
     * @param {{url?: string, message?: string}} options - launch URL / failure line.
     * @returns {Promise<{ ok: boolean, reason?: string, reused?: boolean }>}
     */
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
      updateSwitcher({ current: hostId })
      if (entry.rowInstalled === true) {
        pushGuestHostRow(switcherPayload())
        startHostRowPoll(entry)
      }
      return { ok: true, reused }
    }

    /**
     * Hide every guest and hand the window back to the local page, keeping all of them
     * warm: leaving a remote is not the same as closing it.
     * @returns {void}
     */
    function hideOverlays() {
      carrierPool.wanted = null
      if (carrierPool.current === null) return
      stopHostRowPoll()
      for (const entry of carrierPool.entries) entry.root.style.display = 'none'
      carrierPool.current = null
    }

    /**
     * Tear one guest down: its row, its DOM, its renderer and its lease. Safe for a guest
     * that never made it into the pool (a superseded creation).
     * @param {object} entry - guest to drop.
     * @returns {Promise<void>}
     */
    async function disposeCarrier(entry) {
      if (entry === null || entry === undefined) return
      if (carrierPool.poll === entry) stopHostRowPoll()
      carrierPool.entries = carrierPool.entries.filter((item) => item !== entry)
      // The guest that filled the window is going away, so the local page is next: the row
      // has to follow here as well. The React state that asked for the teardown is not
      // enough - a disconnect arrives through a subscription created at mount, whose
      // closure holds the target from that render, so it cannot clear it.
      const wasShown = carrierPool.current === entry.hostId
      if (wasShown) carrierPool.current = null
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

    /**
     * Drop one host's warm window: its host disconnected or was deleted, or the plugin is
     * going away. There is no count-based eviction.
     * @param {string} hostId - host whose window goes away.
     * @returns {Promise<void>}
     */
    async function closeCarrier(hostId) {
      const entry = carrierOf(hostId)
      if (entry === null) return
      await disposeCarrier(entry)
    }

    /**
     * Drop every warm window (plugin disposal, or a host that is no longer usable).
     * @returns {Promise<void>}
     */
    async function closeOverlay() {
      stopHostRowPoll()
      const hosts = carrierPool.entries.map((entry) => entry.hostId)
      carrierPool.current = null
      for (const hostId of hosts) await closeCarrier(hostId)
    }

    //#endregion

    //#region 9c. key-file picker

    /**
     * Browse the user's home and pick a private-key file.
     * @param {object} props - t, locale, initialDir, onPick(path), onClose().
     * @returns {object} modal element.
     */
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
      const directories = entries.filter((entry) => entry && entry.isDirectory)
      const files = entries.filter((entry) => entry && !entry.isDirectory)

      let body
      if (loading) {
        body = h('p', { className: 'drg-field-hint' }, t('keyFile.loading'))
      } else if (error) {
        body = h(ErrorCard, {
          t,
          locale,
          error,
          onRetry: () => load(listing ? listing.path : props.initialDir || ''),
        })
      } else if (entries.length === 0) {
        body = h('p', { className: 'drg-field-hint' }, t('keyFile.empty'))
      } else {
        body = h(
          'div',
          { className: 'drg-keyfile-list', 'data-testid': 'keyfile-list' },
          directories.map((entry) =>
            h(
              'button',
              {
                key: entry.path,
                type: 'button',
                className: 'drg-keyfile-row',
                'data-kind': 'directory',
                onClick: () => load(entry.path),
              },
              h('span', { className: 'drg-keyfile-name' }, entry.name + '/'),
            ),
          ),
          files.map((entry) =>
            h(
              'button',
              {
                key: entry.path,
                type: 'button',
                className: 'drg-keyfile-row',
                'data-kind': 'file',
                title: entry.path,
                onClick: () => props.onPick(entry.path),
              },
              h('span', { className: 'drg-keyfile-name' }, entry.name),
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
        h('p', { className: 'drg-field-hint' }, t('keyFile.hint')),
        listing ? h('p', { className: 'drg-keyfile-path' }, listing.path) : null,
        body,
      )
    }

    //#endregion

    //#region 10. connect wizard

    /** Parse a positive integer, falling back when the input is not numeric. */
    function toInt(value, fallback) {
      const number =
        typeof value === 'number' ? value : Number(String(value === undefined || value === null ? '' : value).trim())
      return Number.isFinite(number) && Number.isInteger(number) ? number : fallback
    }

    /** Parse `user@host:port` (the masked form the Host exposes) for edit prefill. */
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

    /** Build the `POST /hosts` body from the wizard draft (docs/api.md). */
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
      // Contract: an explicit empty string clears the jump host; an omitted
      // field keeps the existing value on update. Send it only when the
      // HostView exposed it (edit) or when adding a host.
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

    /**
     * Validate the SSH form. Returns a dictionary key, or null when valid.
     * @param {object} draft - form draft.
     * @returns {string|null} validation failure key.
     */
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

    /** Create the initial wizard draft from an existing host and settings defaults. */
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

    /**
     * Three-step connect wizard (docs/design.md（接入向导）): SSH details → connection test
     * @param {object} props - mode, host, live state, callbacks.
     * @returns {object} modal element.
     */
    function WizardDialog(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const mode = props.mode === 'edit' ? 'edit' : 'add'
      const initialHost = props.initialHost || null
      const [step, setStep] = useState(1)
      const [draft, setDraft] = useState(() =>
        initialDraft(mode, initialHost, pathValue(props.state, 'settings', null)),
      )
      const [password, setPassword] = useState('')
      const [authDirty, setAuthDirty] = useState(mode === 'add')
      const [nameTouched, setNameTouched] = useState(mode === 'edit')
      const [hostId, setHostId] = useState(initialHost ? initialHost.id : '')
      const [saving, setSaving] = useState(false)
      const [formError, setFormError] = useState(null)
      const [testError, setTestError] = useState(null)
      const [fingerprintBusy, setFingerprintBusy] = useState(false)
      const [aliases, setAliases] = useState([])
      const [knownHosts, setKnownHosts] = useState(null)
      const [aliasesLoading, setAliasesLoading] = useState(false)
      const [copied, setCopied] = useState(false)
      // Key-file picker overlay (browsing lives in the Host; this is only dialog state).
      const [keyPicker, setKeyPicker] = useState(false)

      const hosts = props.state && Array.isArray(props.state.hosts) ? props.state.hosts : []
      const host = hostId ? hosts.find((item) => item && item.id === hostId) || null : null
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

      // A successful connect advances to the finish step.
      useEffect(() => {
        if (step === 2 && host && host.status === 'connected') setStep(3)
      }, [step, host ? host.status : null])

      const patchDraft = (patch) => setDraft((current) => ({ ...current, ...patch }))

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

      const startConnect = async (id) => {
        try {
          await api.connect(id, password ? { password } : {})
        } catch (error) {
          setTestError(toErrorView(error))
        }
      }

      const handleSave = async () => {
        const invalid = validateHostDraft(draft)
        if (invalid !== null) {
          setFormError(invalid)
          setStep(1)
          return
        }
        if (draft.authType === 'password' && String(password).trim() === '') {
          setFormError('wizard.validationPassword')
          setStep(1)
          return
        }
        setFormError(null)
        setSaving(true)
        try {
          const includeAuth = mode === 'add' || authDirty
          const saved = await api.saveHost(buildHostInput(draft, hostId || undefined, includeAuth))
          const id = saved && saved.id ? saved.id : hostId
          setHostId(id)
          onRefresh()
          setSaving(false)
          setStep(2)
          await startConnect(id)
        } catch (error) {
          setSaving(false)
          setFormError(toErrorView(error))
        }
      }

      const handleRetryTest = async () => {
        if (!hostId) return
        setTestError(null)
        await startConnect(hostId)
      }

      const handleAcceptFingerprint = async (remember) => {
        if (!host || !hostId) return
        const sha256 = host.fingerprint && typeof host.fingerprint.sha256 === 'string' ? host.fingerprint.sha256 : ''
        setFingerprintBusy(true)
        setTestError(null)
        try {
          await api.acceptFingerprint(hostId, true, remember === true, sha256)
          await onRefresh()
        } catch (error) {
          setTestError(toErrorView(error))
        } finally {
          setFingerprintBusy(false)
        }
      }

      const handleCancel = () => {
        if (hostId && mode === 'add' && step === 2) {
          api.disconnect(hostId, false).catch(() => {})
        }
        props.onClose()
      }

      const handleOpenRemote = () => {
        if (hostId && typeof props.onOpenRemote === 'function') props.onOpenRemote(hostId)
      }

      const handleCopyDiagnostics = async () => {
        if (!hostId) return
        let text = ''
        try {
          const report = await api.diagnose(hostId)
          text = formatDiagnoseText(report, host || { id: hostId, name: draft.name }, t, locale)
        } catch (error) {
          const view = toErrorView(error)
          text = [t('diag.failed'), resolveText(view.title, locale), resolveText(view.detail, locale)]
            .filter(Boolean)
            .join('\n')
        }
        const ok = await copyText(text)
        setCopied(ok === true)
      }

      const footer =
        step === 1
          ? h(
              'div',
              { className: 'drg-row drg-row-end' },
              h(Button, { variant: 'ghost', testId: 'wizard-cancel', onClick: handleCancel }, t('cancel')),
              h(
                Button,
                { variant: 'primary', testId: 'wizard-next', busy: saving, onClick: handleSave },
                saving ? t('wizard.savingHost') : t('wizard.saveAndTest'),
              ),
            )
          : step === 2
            ? h(
                'div',
                { className: 'drg-row drg-row-spread' },
                h(Button, { variant: 'ghost', testId: 'wizard-cancel', onClick: handleCancel }, t('cancel')),
                h(
                  'div',
                  { className: 'drg-row' },
                  h(
                    Button,
                    { variant: 'secondary', testId: 'wizard-retry', busy: fingerprintBusy, onClick: handleRetryTest },
                    t('wizard.testRetry'),
                  ),
                  hostId
                    ? h(
                        Button,
                        {
                          variant: 'secondary',
                          onClick: () => props.onDiagnose && props.onDiagnose(host || { id: hostId, name: draft.name }),
                        },
                        t('diagnose'),
                      )
                    : null,
                ),
              )
            : h(
                'div',
                { className: 'drg-row drg-row-spread' },
                h(Button, { variant: 'ghost', testId: 'wizard-later', onClick: handleCancel }, t('wizard.finishLater')),
                h(
                  'div',
                  { className: 'drg-row' },
                  h(
                    Button,
                    { variant: 'secondary', onClick: handleCopyDiagnostics },
                    copied ? t('copied') : t('wizard.copyDiag'),
                  ),
                  h(
                    Button,
                    { variant: 'primary', testId: 'wizard-open', onClick: handleOpenRemote },
                    t('wizard.openRemote'),
                  ),
                ),
              )

      const stepBadge = (index, label) =>
        h(
          'li',
          {
            className: 'drg-wizard-step',
            'data-state': index < step ? 'done' : index === step ? 'current' : 'pending',
          },
          h('span', { className: 'drg-wizard-step-index' }, String(index)),
          h('span', null, label),
        )

      let body
      if (step === 1) {
        const addressOptions = aliases.filter((alias) => alias && typeof alias.alias === 'string')
        body = h(
          'div',
          { className: 'drg-wizard-form' },
          formError
            ? h(
                Notice,
                { tone: 'error' },
                typeof formError === 'string' ? t(formError) : resolveText(toErrorView(formError).detail, locale),
              )
            : null,
          h(
            'div',
            { className: 'drg-form-grid' },
            h(
              Field,
              { label: t('wizard.name') },
              h(TextInput, {
                value: draft.name,
                placeholder: t('wizard.namePlaceholder'),
                ariaLabel: t('wizard.name'),
                testId: 'wizard-name',
                onChange: (value) => {
                  setNameTouched(true)
                  patchDraft({ name: value })
                },
              }),
            ),
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
            ? h(
                'div',
                { className: 'drg-alias-row' },
                h('span', { className: 'drg-alias-label' }, t('wizard.aliases')),
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
                  ? h('span', { className: 'drg-alias-known' }, t('wizard.knownHosts', { count: knownHosts.entries }))
                  : null,
              )
            : aliasesLoading
              ? h('p', { className: 'drg-field-hint' }, t('wizard.aliasesLoading'))
              : h('p', { className: 'drg-field-hint' }, t('wizard.aliasesEmpty')),
          h(
            'div',
            { className: 'drg-form-grid drg-form-grid-3' },
            h(
              Field,
              { label: t('wizard.port') },
              h(TextInput, {
                type: 'number',
                value: draft.port,
                ariaLabel: t('wizard.port'),
                testId: 'wizard-port',
                onChange: (value) => patchDraft({ port: value }),
              }),
            ),
            h(
              Field,
              { label: t('wizard.username') },
              h(TextInput, {
                value: draft.username,
                placeholder: t('wizard.usernamePlaceholder'),
                ariaLabel: t('wizard.username'),
                testId: 'wizard-username',
                onChange: (value) => patchDraft({ username: value }),
              }),
            ),
            h(
              Field,
              { label: t('wizard.jumpHost') },
              h(TextInput, {
                value: draft.jumpHost,
                placeholder: t('wizard.jumpHostPlaceholder'),
                ariaLabel: t('wizard.jumpHost'),
                testId: 'wizard-jump-host',
                onChange: (value) => patchDraft({ jumpHost: value }),
              }),
            ),
          ),
          h(
            Field,
            { label: t('wizard.auth'), hint: t('wizard.authHint') },
            h(Select, {
              value: draft.authType,
              ariaLabel: t('wizard.auth'),
              testId: 'wizard-auth',
              options: [
                { value: 'key', label: t('wizard.authKey') },
                { value: 'password', label: t('wizard.authPassword') },
              ],
              onChange: (value) => {
                setAuthDirty(true)
                patchDraft({ authType: value })
              },
            }),
          ),
          draft.authType === 'key'
            ? h(
                Field,
                { label: t('wizard.keyPath') },
                h(
                  'div',
                  { className: 'drg-field-inline' },
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
          h(
            'div',
            { className: 'drg-form-grid drg-form-grid-3' },
            h(
              Field,
              { label: t('wizard.keepAlive') },
              h(Select, {
                value: draft.keepAlive,
                ariaLabel: t('wizard.keepAlive'),
                testId: 'wizard-keep-alive',
                options: [
                  { value: 'keep', label: t('wizard.keepAliveKeep') },
                  { value: 'stop', label: t('wizard.keepAliveStop') },
                  { value: 'idle', label: t('wizard.keepAliveIdle') },
                ],
                onChange: (value) => patchDraft({ keepAlive: value }),
              }),
            ),
            draft.keepAlive === 'idle'
              ? h(
                  Field,
                  { label: t('wizard.idleMinutes') },
                  h(TextInput, {
                    type: 'number',
                    value: draft.idleMinutes,
                    ariaLabel: t('wizard.idleMinutes'),
                    testId: 'wizard-idle-minutes',
                    onChange: (value) => patchDraft({ idleMinutes: value }),
                  }),
                )
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
          h('p', { className: 'drg-field-hint' }, t('wizard.testHint')),
          !isLoopbackAddress(draft.address) ? h('p', { className: 'drg-field-hint' }, t('loopbackNote')) : null,
        )
      } else if (step === 2) {
        body = h(
          'div',
          { className: 'drg-wizard-test' },
          testError ? h(Notice, { tone: 'error' }, resolveText(toErrorView(testError).detail, locale)) : null,
          host === null
            ? h(LoadingBlock, { t, label: saving ? t('wizard.savingHost') : t('wizard.testing') })
            : host.status === 'fingerprint-pending'
              ? h(FingerprintCard, {
                  t,
                  locale,
                  host,
                  busy: fingerprintBusy,
                  error: testError,
                  onAccept: handleAcceptFingerprint,
                  onReject: handleCancel,
                })
              : host.status === 'error' || host.status === 'limited'
                ? h(ErrorCard, {
                    t,
                    locale,
                    error: host.error || localErrorView('internal'),
                    onRetry: handleRetryTest,
                    onDiagnose: () => props.onDiagnose && props.onDiagnose(host),
                    onBack: handleCancel,
                  })
                : h('div', null, h(ConnectProgress, { t, host })),
        )
      } else {
        const remote = host && host.remote ? host.remote : {}
        const localVersion = props.state && typeof props.state.hostVersion === 'string' ? props.state.hostVersion : ''
        const remoteVersion = typeof remote.version === 'string' ? remote.version : ''
        const versionsMatch = localVersion.length > 0 && remoteVersion.length > 0 && localVersion === remoteVersion
        body = h(
          'div',
          { className: 'drg-wizard-done' },
          h('div', { className: 'drg-done-icon', 'aria-hidden': 'true' }, h(IconCheck, { size: 28 })),
          h('h2', { className: 'drg-done-title' }, t('wizard.finishTitle')),
          h('p', { className: 'drg-done-body' }, t('wizard.finishBody')),
          h(
            'dl',
            { className: 'drg-kv' },
            h('div', null, h('dt', null, t('wizard.versionLocal')), h('dd', null, localVersion || t('unknown'))),
            h('div', null, h('dt', null, t('wizard.versionRemote')), h('dd', null, remoteVersion || t('unknown'))),
            h(
              'div',
              null,
              h('dt', null, t('wizard.versionMatch')),
              h(
                'dd',
                null,
                h(
                  Badge,
                  { tone: versionsMatch ? 'success' : 'warn' },
                  versionsMatch ? t('wizard.versionMatch') : t('wizard.versionMismatch'),
                ),
              ),
            ),
            h(
              'div',
              null,
              h('dt', null, t('wizard.bootstrapLevel')),
              h('dd', null, remote.bootstrapLevel || t('unknown')),
            ),
            h(
              'div',
              null,
              h('dt', null, t('wizard.uiReady')),
              h('dd', null, remote.uiReady === true ? t('wizard.uiReadyYes') : t('wizard.uiReadyNo')),
            ),
          ),
          copied ? h(Notice, { tone: 'success' }, t('diag.copyDone')) : null,
        )
      }

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
          h(
            'ol',
            { className: 'drg-wizard-steps' },
            stepBadge(1, t('wizard.step1')),
            stepBadge(2, t('wizard.step2')),
            stepBadge(3, t('wizard.step3')),
          ),
          h(
            'div',
            { className: 'drg-wizard-body', 'data-testid': 'wizard-step-' + step, 'data-step': String(step) },
            body,
          ),
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

    //#endregion

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

    /** Localized label for a diagnostic check status. */
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

    /**
     * Diagnostics drawer (docs/design.md（诊断）): a redacted checklist with re-run and
     * @param {object} props - host, status, report, callbacks.
     * @returns {object|null} drawer elements.
     */
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
        content = h('div', { className: 'drg-loading' }, h(Spinner, { size: 20 }), h('span', null, t('diag.running')))
      } else if (status === 'error') {
        content = h(ErrorCard, {
          t,
          locale,
          error: props.error,
          onRetry: props.onRun,
        })
      } else if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
        content = h('p', { className: 'drg-paragraph' }, t('diag.empty'))
      } else {
        content = h(
          'div',
          { className: 'drg-diag' },
          h(
            'div',
            { className: 'drg-diag-head' },
            h(Badge, { tone: summaryTone }, summaryText),
            report.generatedAt
              ? h(
                  'span',
                  { className: 'drg-diag-time' },
                  t('diag.generatedAt') + ' ' + formatTime(report.generatedAt, locale),
                )
              : null,
          ),
          h(
            'ul',
            { className: 'drg-diag-list' },
            sortDiagnoseChecks(report.checks).map((check, index) =>
              h(
                'li',
                { key: String(check.id || index), className: 'drg-diag-check', 'data-status': check.status },
                h(
                  'span',
                  { className: 'drg-diag-status', 'data-status': check.status },
                  checkStatusLabel(t, check.status),
                ),
                h(
                  'div',
                  { className: 'drg-diag-check-body' },
                  h(
                    'div',
                    { className: 'drg-diag-check-title' },
                    resolveText(check.title, locale) || String(check.id || ''),
                  ),
                  resolveText(check.detail, locale)
                    ? h('div', { className: 'drg-diag-check-detail' }, resolveText(check.detail, locale))
                    : null,
                ),
              ),
            ),
          ),
          h('p', { className: 'drg-field-hint' }, t('diag.redacted')),
          copied ? h(Notice, { tone: 'success' }, t('diag.copyDone')) : null,
        )
      }

      return h(
        'div',
        { className: 'drg-drawer-layer' },
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
          h(
            'div',
            { className: 'drg-drawer-head' },
            h(
              'div',
              null,
              h('h2', { className: 'drg-drawer-title' }, t('diag.title')),
              host
                ? h(
                    'p',
                    { className: 'drg-drawer-subtitle' },
                    (host.name || host.id) + (displayAddress(host) ? ' · ' + displayAddress(host) : ''),
                  )
                : null,
            ),
            h(IconButton, { icon: h(IconClose), label: t('diag.close'), onClick: props.onClose }),
          ),
          h('div', { className: 'drg-drawer-body' }, content),
          h(
            'div',
            { className: 'drg-drawer-foot' },
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

    //#endregion

    //#region 12. settings modal

    /** Build the partial SettingsView sent by `POST /settings` (docs/api.md). */
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

    /** Create the editable settings draft from a SettingsView. */
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

    /**
     * Settings modal (docs/design.md（设置） / contract SettingsView).
     * @param {object} props - settings, onSave(patch), onClose.
     * @returns {object} modal element.
     */
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

      const footer = h(
        'div',
        { className: 'drg-row drg-row-end' },
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
          h(
            'div',
            { className: 'drg-settings' },
            h(
              'section',
              { className: 'drg-settings-section' },
              h('h3', { className: 'drg-section-title' }, t('settings.ssh')),
              h(
                'div',
                { className: 'drg-form-grid drg-form-grid-3' },
                h(
                  Field,
                  { label: t('settings.defaultPort') },
                  h(TextInput, {
                    type: 'number',
                    value: draft.defaultPort,
                    ariaLabel: t('settings.defaultPort'),
                    onChange: set('defaultPort'),
                  }),
                ),
                h(
                  Field,
                  { label: t('settings.defaultAuth') },
                  h(Select, {
                    value: draft.defaultAuth,
                    ariaLabel: t('settings.defaultAuth'),
                    options: [
                      { value: 'key', label: t('settings.defaultAuthKey') },
                      { value: 'password', label: t('settings.defaultAuthPassword') },
                    ],
                    onChange: set('defaultAuth'),
                  }),
                ),
                h(
                  Field,
                  { label: t('settings.connectTimeout') },
                  h(TextInput, {
                    type: 'number',
                    value: draft.connectTimeoutSec,
                    ariaLabel: t('settings.connectTimeout'),
                    onChange: set('connectTimeoutSec'),
                  }),
                ),
                h(
                  Field,
                  { label: t('settings.defaultKeyPath'), hint: t('settings.defaultKeyPathHint'), wide: true },
                  h(
                    'div',
                    { className: 'drg-field-inline' },
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
            h(
              'section',
              { className: 'drg-settings-section' },
              h('h3', { className: 'drg-section-title' }, t('settings.security')),
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
              h('p', { className: 'drg-field-hint' }, t('settings.saveTokensHint')),
              draft.saveTokens === true ? h(Notice, { tone: 'warn', title: t('settings.saveTokensRisk') }) : null,
              h('div', { className: 'drg-divider' }),
              h('h3', { className: 'drg-section-title' }, t('settings.reconnect')),
              h(CheckRow, {
                checked: draft.autoReconnectEnabled === true,
                label: t('settings.reconnectEnabled'),
                onChange: set('autoReconnectEnabled'),
              }),
              h(
                'div',
                { className: 'drg-form-grid' },
                h(
                  Field,
                  { label: t('settings.maxAttempts') },
                  h(TextInput, {
                    type: 'number',
                    value: draft.maxAttempts,
                    ariaLabel: t('settings.maxAttempts'),
                    onChange: set('maxAttempts'),
                  }),
                ),
                h(
                  Field,
                  { label: t('settings.baseDelay') },
                  h(TextInput, {
                    type: 'number',
                    value: draft.baseDelayMs,
                    ariaLabel: t('settings.baseDelay'),
                    onChange: set('baseDelayMs'),
                  }),
                ),
              ),
            ),
            h(
              'section',
              { className: 'drg-settings-section' },
              h('h3', { className: 'drg-section-title' }, t('settings.bootstrap')),
              h('p', { className: 'drg-field-hint' }, t('settings.bootstrapHint')),
              h(
                'div',
                { className: 'drg-form-grid' },
                h(
                  Field,
                  { label: t('settings.profile'), hint: t('settings.profileHint') },
                  h(TextInput, {
                    value: draft.profile,
                    ariaLabel: t('settings.profile'),
                    onChange: set('profile'),
                  }),
                ),
              ),
            ),
            h(
              'section',
              { className: 'drg-settings-section' },
              h('h3', { className: 'drg-section-title' }, t('settings.other')),
              h(
                'div',
                { className: 'drg-form-grid drg-form-grid-3' },
                h(
                  Field,
                  { label: t('settings.language') },
                  h(Select, {
                    value: draft.language,
                    ariaLabel: t('settings.language'),
                    options: [
                      { value: 'auto', label: t('settings.languageAuto') },
                      { value: 'zh', label: t('settings.languageZh') },
                      { value: 'en', label: t('settings.languageEn') },
                    ],
                    onChange: set('language'),
                  }),
                ),
                h(
                  Field,
                  { label: t('settings.logLevel') },
                  h(Select, {
                    value: draft.logLevel,
                    ariaLabel: t('settings.logLevel'),
                    options: ['error', 'warn', 'info', 'debug'].map((level) => ({ value: level, label: level })),
                    onChange: set('logLevel'),
                  }),
                ),
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

    //#endregion

    //#region 13. one-time password prompt

    /**
     * SSH password prompt for hosts whose `authType` is `password`. The value stays
     * @param {object} props - host, busy flag, error, submit({password, remember})/cancel callbacks.
     * @returns {object} modal element.
     */
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
          footer: h(
            'div',
            { className: 'drg-row drg-row-end' },
            h(Button, { variant: 'ghost', onClick: props.onCancel }, t('cancel')),
            h(
              Button,
              { variant: 'primary', testId: 'password-submit', busy: props.busy === true, onClick: submit },
              t('passwordPromptSubmit'),
            ),
          ),
        },
        h('p', { className: 'drg-paragraph' }, t('passwordPromptBody', { name: host.name || host.id || '' })),
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
          : h('p', { className: 'drg-field-hint' }, t('passwordPromptNoStorage')),
      )
    }

    /**
     * Prompt shown when the remote already runs a DSH this plugin did not start.
     * The user must choose explicitly; the pipeline is paused meanwhile.
     * @param {{ t: Function, host: object, busy?: boolean, error?: string, onResolve: (host: object, action: string) => void }} props
     */
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
          footer: h(
            'div',
            { className: 'drg-row drg-row-end' },
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
        h(
          'p',
          { className: 'drg-paragraph' },
          t('conflictBody', { name: host.name || host.id || '', count: processes.length }),
        ),
        h(
          'ul',
          { className: 'drg-conflict-processes' },
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
        h('p', { className: 'drg-field-hint' }, t('conflictHint')),
        props.error ? h(Notice, { tone: 'error' }, props.error) : null,
        busy ? h('p', { className: 'drg-field-hint' }, t('conflictBusy')) : null,
      )
    }

    //#endregion

    //#region 14. toast

    /**
     * Lightweight toast for action results.
     * @param {{toast: {text: string, tone?: string}|null}} props - toast payload.
     * @returns {object|null} toast element.
     */
    function Toast(props) {
      if (!props || !props.toast) return null
      return h(
        'div',
        { className: 'drg-toast', 'data-tone': props.toast.tone || 'info', role: 'status' },
        props.toast.text,
      )
    }

    //#endregion

    //#region 15. overlay host (floating windows + remote window)

    /**
     * Owns the plugin's live state: one initial `/state` read, then SSE with a
     * 3s polling fallback (docs/api.md). Disposal closes the stream and timers.
     * An optional `initialState` is a test/preview seam; production callers omit it.
     * @param {object|undefined} [initialState] - state used for the first render.
     * @returns {{state: object|null, error: object|null, loading: boolean, mode: string, refresh: Function, patch: Function}} remote state handle.
     */
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

    /**
     * The plugin's overlay host, mounted once in the shell's overlay layer.
     *
     * It owns everything that is not the sidebar row: the host state, the remote window, the
     * floating host-management window, the add/edit wizard, and every prompt. Because it
     * sits above the remote window, opening or closing one of those never changes what is
     * behind it — a remote stays exactly as it was.
     * @param {object} props - slot props (`t`) plus the injected stores.
     * @returns {object} overlay element.
     */
    function PluginOverlay(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      // One `/state` feed for the whole plugin (docs/api.md): the row, the windows and the
      // remote window all read from it.
      const remote = useRemoteState(props.initialState)
      const state = remote.state
      /** Host filling the window, or null when the local page is in front. */
      const [target, setTarget] = useState(() => {
        const initial = props.initialState
        return initial && typeof initial.activeHostId === 'string' ? initial.activeHostId : null
      })
      const [manageOpen, setManageOpen] = useState(false)
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

      // When the host we asked for comes up, the window switches and the list gets out of
      // the way; a failure leaves the list up so its error is readable.
      useEffect(() => {
        if (target === null || activeStatus !== 'connected' || pendingSwitch.current !== target) return
        pendingSwitch.current = null
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

      // While the plugin is loaded its windows stay warm; the plugin's own disposal (in
      // `apply`) tears them down.
      useEffect(() => {
        return () => {
          hideOverlays()
        }
      }, [])

      /** Connect with an optional one-time password (memory only). */
      const performConnect = (host, password) => {
        if (!host || !host.id) return
        setBusyHostId(host.id)
        api
          .connect(host.id, typeof password === 'string' ? { password } : {})
          .then(
            () => {
              setPasswordPrompt(null)
              remote.refresh()
            },
            (error) => {
              const message = errorMessage(error)
              setPasswordPrompt(null)
              notify(message, 'error')
            },
          )
          .finally(() => setBusyHostId(null))
      }

      /**
       * Start a connection, asking for the one-time password first when the
       * host uses password auth (contract: password never persisted).
       */
      const connectHost = (host, options) => {
        if (!host || !host.id) return
        const opts = options || {}
        if (host.authType === 'password' && typeof opts.password !== 'string') {
          setPasswordPrompt({ host, intent: 'connect', error: null, busy: false })
          return
        }
        performConnect(host, opts.password)
      }

      /**
       * Hand the window to one host: the management window steps aside for a host that is
       * up, and stays up while one that is not (connecting, waiting for a fingerprint, in
       * conflict) gets there, so its progress or prompt is visible.
       * @param {object} host - HostView to open.
       * @returns {void}
       */
      const openHost = (host) => {
        if (!host) return
        const needsConnect = host.status === 'unconfigured' || host.status === 'disconnected' || host.status === 'error'
        const ready = host.status === 'connected'
        if (needsConnect && host.authType === 'password') {
          pendingSwitch.current = host.id
          setManageOpen(true)
          setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
          return
        }
        pendingSwitch.current = ready ? null : host.id
        setManageOpen(!ready)
        setTarget(host.id)
        api.activate(host.id).catch(() => {})
        if (needsConnect) performConnect(host)
      }
      const openHostById = (hostId) => {
        const host = hostsRef.current.find((item) => item && item.id === hostId) || null
        if (host === null) {
          // The host may be newer than the last `/state` frame (just added by the wizard):
          // aim at it and let the takeover effect pick it up when the state arrives.
          setTarget(hostId)
          return true
        }
        openHost(host)
        return true
      }

      // The switcher and the Settings page name one target: open a host, leave one, show
      // host management, or hand the window back to the local page.
      const applyIntent = (intent) => {
        if (!intent || typeof intent !== 'object') return
        if (intent.kind === 'manage') {
          pendingIntent.current = null
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
          // Disconnecting hands the window back once the Host confirms (see
          // `disconnectHost`): doing it here would show the local page even if the
          // disconnect then failed.
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

      /** Submit the one-time password for the pending open/connect/reconnect. */
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

      const disconnectHost = (host) => {
        if (!host) return
        setBusyHostId(host.id)
        api
          .disconnect(host.id, false)
          .then(
            () => {
              // The remote UI goes away with the connection: give its renderer back now,
              // and hand the window back if that is where it is pointing. The update is
              // functional on purpose: this callback runs from the long-lived intent
              // subscription, whose closure still holds the target it was created with,
              // so a captured value would miss the host the window is really on.
              setTarget((current) => (current === host.id ? null : current))
              closeCarrier(host.id).catch(() => {})
              remote.refresh()
            },
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setBusyHostId(null))
      }

      const reconnectHost = (host) => {
        if (!host) return
        if (host.authType === 'password') {
          setPasswordPrompt({ host, intent: 'reconnect', error: null, busy: false })
          return
        }
        setRemoteUrl(null)
        closeCarrier(host.id).catch(() => {})
        setBusyHostId(host.id)
        api
          .reconnect(host.id)
          .then(
            () => remote.refresh(),
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setBusyHostId(null))
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

      /**
       * Confirm or refuse the host key the window is waiting on. The wizard asks the same
       * question in its second step; this is the same call, reached from the floating list
       * so a host opened straight from the switcher can get past that step too.
       * @param {object} host - HostView waiting for its fingerprint.
       * @param {boolean} accept - true to pin it, false to refuse it (which drops the link).
       * @param {boolean} [remember] - pin permanently (accept only).
       * @returns {void}
       */
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

      /** Open the add/edit wizard; it floats over whatever is on screen. */
      const openWizard = (draft) => {
        if (typeof props.openWizard === 'function') {
          props.openWizard(draft)
          return
        }
        const store = props.wizardStore
        if (store && typeof store.open === 'function') store.open(draft)
      }

      /** A host that is connecting or waiting for its host key stays on screen here. */
      const liveStatus = activeStatus === 'connecting' || activeStatus === 'fingerprint-pending'

      return h(
        'div',
        { className: 'drg-root drg-overlay', 'data-testid': 'dsh-remote-go-overlay-host' },
        h(StyleSheet),
        manageOpen
          ? h(
              'div',
              { className: 'drg-manage-window', 'data-testid': 'manage-window' },
              h(
                Modal,
                { wide: true, onClose: () => setManageOpen(false), closeLabel: t('cancel') },
                manageOpen && activeHost && liveStatus
                  ? h(
                      'div',
                      { className: 'drg-manage-live', 'data-testid': 'manage-live' },
                      activeStatus === 'fingerprint-pending'
                        ? h(FingerprintCard, {
                            t,
                            locale,
                            host: activeHost,
                            busy: fingerprintBusy,
                            onAccept: (remember) => answerFingerprint(activeHost, true, remember === true),
                            onReject: () => answerFingerprint(activeHost, false, false),
                          })
                        : h(ConnectProgress, { t, host: activeHost }),
                    )
                  : null,
                h(HostListView, {
                  t,
                  locale,
                  state,
                  loading: remote.loading,
                  error: remote.error,
                  busyHostId,
                  onAdd: () => openWizard({ mode: 'add', host: null }),
                  onRefresh: remote.refresh,
                  onOpenSettings: () => setSettingsOpen(true),
                  onOpenHost: openHost,
                  onConnectHost: connectHost,
                  onDisconnectHost: disconnectHost,
                  onReconnectHost: reconnectHost,
                  onEditHost: (host) => openWizard({ mode: 'edit', host }),
                  onDeleteHost: (host) => setPendingDelete(host),
                  onDiagnoseHost: runDiagnose,
                }),
              ),
            )
          : null,
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
              onOpenRemote: (hostId) => {
                closeWizard()
                openHostById(hostId)
              },
              onDiagnose: runDiagnose,
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

    /**
     * Panel styles. No local palette and no local token layer: every colour, surface,
     * radius and shadow is the host's own --dsw-* alias, and a theme change restyles
     * the whole surface on the next paint.
     */
    const CSS = `
    /*
     * Panel styles.
     *
     * Theme contract: nothing here owns a colour, a surface or a geometry constant.
     * Every value comes straight from the host's --dsw-* tokens (the same aliases the
     * host's own Dialog and Menu components read), so a theme plugin — built-in
     * light/dark, a registered theme, or ctx.theme.overrideTokens() — restyles every
     * surface on the next paint. There is deliberately no local token layer: the
     * plugin adds no palette of its own, and a token DSH renames fails the tests
     * instead of silently falling back to a look-alike.
     *
     * Surface choices mirror the host:
     *   dialog  = --dsw-alias-bg-layer-2, --dsw-radius-panel, --dsw-elevation-prominent
     *   menu    = --dsw-specific-menu + --dsw-menu-backdrop-filter, --dsw-elevation-panel
     *   scrim   = --dsw-alias-bg-mask-1 + --dsw-mask-blur
     *   field   = --dsw-alias-bg-layer-3 + .5px --dsw-alias-border-l4
     */
    .drg-root {
      color-scheme: inherit;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      color: var(--dsw-alias-label-primary);
      background: var(--dsw-alias-bg-base);
      font-family: var(--dsw-font-family);
      font-size: 13px;
      line-height: 1.5;
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
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
      border: 2px solid transparent;
      background-clip: content-box;
      background-color: var(--dsw-alias-scrollbar-bg-l2);
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
      display: flex;
      flex-direction: column;
      gap: 20px;
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 22px 24px 24px;
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
    .drg-row-spread { justify-content: space-between; width: 100%; gap: 12px; }
    .drg-paragraph { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
    .drg-section-label { margin-bottom: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }

    /* ---- buttons ------------------------------------------------------------ */
    .drg-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      border: 0.5px solid transparent;
      border-radius: var(--dsw-radius-md);
      background: transparent;
      color: inherit;
      font-size: 13px;
      font-weight: 500;
      line-height: 20px;
      white-space: nowrap;
      cursor: pointer;
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
    .drg-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
    .drg-btn-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex: none;
      padding: 0;
      border: none;
      border-radius: var(--dsw-radius-sm);
      background: transparent;
      color: var(--dsw-alias-label-secondary);
      cursor: pointer;
    }
    .drg-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .drg-iconbtn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
    .drg-iconbtn:disabled { opacity: 0.5; cursor: default; }
    .drg-linkbtn {
      padding: 0 2px;
      border: none;
      border-radius: var(--dsw-radius-xs);
      background: none;
      color: var(--dsw-alias-link);
      font-size: 12.5px;
      cursor: pointer;
    }
    .drg-linkbtn:hover { text-decoration: underline; text-underline-offset: 2px; }

    /* ---- status ------------------------------------------------------------- */
    .drg-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; }
    .drg-dot[data-tone="success"],
    .drg-dot[data-tone="local"] { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent); }
    .drg-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 20px;
      padding: 0 8px;
      border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: 999px;
      background: transparent;
      color: var(--dsw-alias-label-secondary);
      font-size: 11.5px;
      font-weight: 500;
      line-height: 18px;
      white-space: nowrap;
    }
    .drg-badge[data-tone="success"] { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); border-color: transparent; }
    .drg-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
    .drg-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border-color: transparent; }
    .drg-badge[data-tone="info"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); border-color: transparent; }
    .drg-badge[data-tone="limited"] { color: var(--dsw-static-violet-400); background: color-mix(in srgb, var(--dsw-static-violet-400) 12%, transparent); border-color: transparent; }

    /* ---- loading / empty ---------------------------------------------------- */
    .drg-spinner {
      display: inline-block;
      flex: none;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
      border-top-color: currentColor;
      animation: drg-spin 0.8s linear infinite;
    }
    @keyframes drg-spin { to { transform: rotate(360deg); } }
    .drg-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 16px; color: var(--dsw-alias-label-secondary); }
    .drg-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 56px 24px;
      text-align: center;
      border: 1px dashed var(--dsw-alias-border-l2);
      border-radius: var(--dsw-radius-lg);
    }
    .drg-empty-icon {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      margin-bottom: 2px;
      border-radius: 50%;
      border: 0.5px solid var(--dsw-alias-border-l1);
      background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-tertiary);
    }
    .drg-empty-title { font-size: 16px; font-weight: 500; }
    .drg-empty-body { max-width: 46ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }

    /* ---- host list ---------------------------------------------------------- */
    .drg-host-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .drg-summary { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    .drg-host-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
    .drg-host-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
      padding: 16px;
      border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-lg);
      background: var(--dsw-alias-bg-layer-1);
      transition: border-color 160ms ease, background-color 160ms ease;
    }
    .drg-host-card:hover { border-color: var(--dsw-alias-border-l4); }
    .drg-host-card[data-status="connected"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, var(--dsw-alias-border-l1)); }
    .drg-card-strip {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: -16px -16px 0;
      padding: 6px 14px;
      border-radius: var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;
      background: var(--dsw-alias-state-warn-tertiary);
      color: var(--dsw-alias-state-warn-label);
      font-size: 12px;
    }
    .drg-host-card[data-status="error"] .drg-card-strip,
    .drg-host-card[data-status="limited"] .drg-card-strip {
      background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
      color: var(--dsw-alias-state-error-primary);
    }
    .drg-card-strip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drg-card-strip .drg-linkbtn { margin-left: auto; flex: none; color: inherit; }
    .drg-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .drg-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 500; line-height: 22px; }
    .drg-card-address { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 12px; }
    .drg-card-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; }
    .drg-card-meta > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .drg-card-meta dt { color: var(--dsw-alias-label-caption); font-size: 11px; }
    .drg-card-meta dd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
    .drg-card-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 2px;
      padding-top: 12px;
      border-top: 0.5px solid var(--dsw-alias-border-l1);
    }
    .drg-card-actions-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }

    /* ---- notices ------------------------------------------------------------ */
    .drg-notice {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-notice-icon { flex: none; margin-top: 1px; color: var(--dsw-alias-label-tertiary); }
    .drg-notice-body { flex: 1; min-width: 0; }
    .drg-notice-title { font-weight: 500; }
    .drg-notice-text { color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 19px; }
    .drg-notice-dismiss {
      flex: none;
      padding: 0 4px;
      border: none;
      border-radius: var(--dsw-radius-xs);
      background: transparent;
      color: var(--dsw-alias-label-tertiary);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }
    .drg-notice-dismiss:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
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
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border: 0.5px solid var(--dsw-alias-border-l2);
      border-radius: 999px;
      color: var(--dsw-alias-label-tertiary);
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
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: min(640px, 100%);
      margin: auto;
      padding: 20px;
      border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, var(--dsw-alias-border-l2));
      border-radius: var(--dsw-radius-lg);
      background: var(--dsw-alias-state-warn-tertiary);
    }
    .drg-fingerprint-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-label); }
    .drg-fingerprint-icon[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
    .drg-fingerprint-title { font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }
    .drg-fingerprint-body { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }

    .drg-kv { display: flex; flex-direction: column; gap: 0; padding: 4px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
    .drg-kv > div { display: flex; align-items: baseline; gap: 14px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-kv > div:last-child { border-bottom: 0; }
    .drg-kv dt { flex: none; min-width: 108px; color: var(--dsw-alias-label-caption); font-size: 12px; }
    .drg-kv dd { min-width: 0; margin: 0; color: var(--dsw-alias-label-primary); word-break: break-word; }

    .drg-error-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      width: min(640px, 100%);
      margin: auto;
      padding: 20px;
      border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));
      border-radius: var(--dsw-radius-lg);
      background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
    }
    .drg-error-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
    .drg-error-title { font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }
    .drg-error-detail { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
    .drg-error-steps { width: 100%; }
    .drg-error-steps ul { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .drg-error-steps li::before { content: "· "; color: var(--dsw-alias-label-caption); }

    /* ---- dialogs ------------------------------------------------------------ */
    .drg-modal-layer { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .drg-modal-backdrop {
      position: absolute;
      inset: 0;
      background: var(--dsw-alias-bg-mask-1);
      backdrop-filter: var(--dsw-mask-blur);
      animation: drg-fade-in 140ms ease-out;
    }
    .drg-modal {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      gap: 20px;
      width: min(600px, 100%);
      max-height: min(86vh, 900px);
      padding-bottom: 24px;
      border: 0;
      border-radius: var(--dsw-radius-panel);
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-primary);
      box-shadow: var(--dsw-elevation-prominent);
      overflow: hidden;
      animation: drg-dialog-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .drg-modal-wide { width: min(880px, 100%); }
    .drg-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 0 24px; }
    .drg-modal-titles { min-width: 0; }
    .drg-modal-title { font-size: 16px; font-weight: 500; line-height: 24px; }
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
    .drg-manage-window .drg-page { padding-right: 60px; }
    .drg-manage-live { padding: 18px 24px 14px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
    .drg-manage-live .drg-progress, .drg-manage-live .drg-fingerprint { margin: 0; padding: 0; width: 100%; }
    .drg-manage-live .drg-fingerprint { border-color: transparent; background: transparent; padding: 0; }

    @keyframes drg-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes drg-dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }

    /* ---- drawer ------------------------------------------------------------- */
    .drg-drawer-layer { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; }
    .drg-drawer-backdrop {
      position: absolute;
      inset: 0;
      background: var(--dsw-alias-bg-mask-1);
      backdrop-filter: var(--dsw-mask-blur);
      animation: drg-fade-in 140ms ease-out;
    }
    .drg-drawer {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      width: min(520px, 100%);
      height: 100%;
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-primary);
      box-shadow: var(--dsw-elevation-panel);
      animation: drg-drawer-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes drg-drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
    .drg-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 22px 14px 14px 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-drawer-title { font-size: 16px; font-weight: 500; line-height: 24px; }
    .drg-drawer-subtitle { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
    .drg-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px; }
    .drg-drawer-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
    .drg-diag { display: flex; flex-direction: column; gap: 12px; }
    .drg-diag-head { display: flex; align-items: center; gap: 10px; }
    .drg-diag-time { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .drg-diag-list { display: flex; flex-direction: column; gap: 6px; }
    .drg-diag-check {
      display: flex;
      gap: 10px;
      padding: 10px 12px;
      border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-1);
    }
    .drg-diag-status {
      flex: none;
      align-self: flex-start;
      min-width: 46px;
      height: 20px;
      padding: 0 6px;
      border-radius: 999px;
      background: var(--dsw-alias-bg-layer-3);
      color: var(--dsw-alias-label-secondary);
      font-size: 10.5px;
      font-weight: 600;
      line-height: 20px;
      text-align: center;
      text-transform: uppercase;
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
      width: 100%;
      height: 36px;
      padding: 0 12px;
      border: 0.5px solid var(--dsw-alias-border-l4);
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-3);
      color: var(--dsw-alias-label-primary);
      font: inherit;
      font-size: 13px;
      outline: none;
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
    /* ol.… outranks the .drg-root ol margin reset, so the steps keep their separation
       from the form below. */
    ol.drg-wizard-steps { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 18px; }
    .drg-wizard-step {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px 4px 5px;
      border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-tertiary);
      font-size: 12px;
      white-space: nowrap;
    }
    .drg-wizard-step[data-state="current"] {
      color: var(--dsw-alias-label-primary);
      border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);
      background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
    }
    .drg-wizard-step[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
    .drg-wizard-step-index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 0.5px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-layer-3);
      color: var(--dsw-alias-label-tertiary);
      font-size: 10.5px;
      font-weight: 600;
    }
    .drg-wizard-step[data-state="current"] .drg-wizard-step-index { border-color: transparent; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); }
    .drg-wizard-step[data-state="done"] .drg-wizard-step-index { border-color: transparent; background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
    .drg-wizard-body { min-width: 0; }
    .drg-wizard-form, .drg-wizard-test, .drg-wizard-done { display: flex; flex-direction: column; gap: 10px; }
    .drg-alias-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .drg-alias-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    .drg-alias-known { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11px; }
    .drg-chip {
      padding: 3px 10px;
      border: 0.5px solid var(--dsw-alias-border-l3);
      border-radius: 999px;
      background: transparent;
      color: var(--dsw-alias-label-secondary);
      font-size: 12px;
      cursor: pointer;
    }
    .drg-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .drg-done-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
    .drg-done-title { font-size: 17px; font-weight: 500; letter-spacing: -0.01em; }
    .drg-done-body { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }

    /* ---- key-file picker ---------------------------------------------------- */
    .drg-keyfile-path { margin: 2px 0 8px; color: var(--dsw-alias-label-caption); font-family: var(--ds-font-family-code, var(--dsw-font-markdown-code-font-family, monospace)); font-size: 11.5px; word-break: break-all; }
    .drg-keyfile-list { max-height: 320px; overflow-y: auto; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
    .drg-keyfile-row {
      display: flex;
      align-items: center;
      width: 100%;
      gap: 8px;
      padding: 8px 12px;
      border: 0;
      border-bottom: 0.5px solid var(--dsw-alias-border-l1);
      background: transparent;
      color: var(--dsw-alias-label-primary);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .drg-keyfile-row:last-child { border-bottom: 0; }
    .drg-keyfile-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .drg-keyfile-row:focus-visible { outline-offset: -2px; }
    .drg-keyfile-row[data-kind='directory'] .drg-keyfile-name { font-weight: 500; }
    .drg-keyfile-row[data-kind='directory'] .drg-keyfile-name::before { content: "▸ "; color: var(--dsw-alias-label-caption); }
    .drg-keyfile-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- settings ----------------------------------------------------------- */
    .drg-settings { display: flex; flex-direction: column; gap: 20px; }
    .drg-settings-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 16px 18px;
      border: 0.5px solid var(--dsw-alias-border-l1);
      border-radius: var(--dsw-radius-lg);
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
    .drg-conflict-processes span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- toast -------------------------------------------------------------- */
    .drg-toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      z-index: 80;
      max-width: min(560px, calc(100vw - 32px));
      padding: 10px 16px;
      transform: translateX(-50%);
      border: none;
      border-left: 3px solid transparent;
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-toast-bg);
      color: var(--dsw-alias-toast-label);
      font-size: 12.5px;
      box-shadow: var(--dsw-elevation-prominent);
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
`

    /** Injects the panel styles once per mounted panel (removed on unmount). */
    function StyleSheet() {
      return h('style', { 'data-dsh-remote-go': 'styles', dangerouslySetInnerHTML: { __html: CSS } })
    }

    //#endregion

    //#region 17. plugin registration

    /**
     * Register the dictionaries, the overlay host (floating windows + remote window),
     * and the sidebar switcher row. The switcher row is the plugin's only entry: no
     * settings page and no sidebar or main panel are registered.
     * @param {object} ctx - browser plugin context.
     * @returns {void}
     */
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

      /** Command channel into the overlay host: open one host, show management, go local. */
      const panelStore = createPanelRequestStore()
      /** The add/edit wizard's own channel, so it can open from anywhere. */
      const wizardStore = createWizardStore()
      /**
       * Open the host wizard. It floats in the shell's overlay layer, above a remote window,
       * so nothing behind it changes.
       * @param {{mode?: string, host?: object|null}} draft - what the dialog edits.
       * @returns {void}
       */
      const openWizard = (draft) => {
        wizardStore.open(draft)
      }
      const sharedInject = () => ({ panelStore, wizardStore, openWizard, getLocaleId })

      // Everything the plugin draws lives in the shell's overlay layer: the floating
      // management window, the wizard and the prompts. It sits above a remote window, so
      // opening or closing them leaves the remote exactly as it was.
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

      // The window's one control is the switcher row drawn into the sidebar of whichever
      // page owns the window: this one (local) or the remote guest's. It lists local plus
      // every host, so picking one is all it takes to move the window. It is the plugin's
      // only entry: there is no settings page, no sidebar panel and no main panel;
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

      /**
       * Hand the window back to the local UI. The SSH link, the tunnel and the remote task
       * stay up, so returning to that host later is instant; the row's "local" entry is the
       * only way back, which is why it is always the first menu item.
       * @returns {void}
       */
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
          // The row's exit control: drop that host's link (and its warm window) without
          // switching to it.
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

    /** Components exported for tests and host-side tooling. */
    const components = {
      RemoteIcon,
      PluginOverlay,
      HostListView,
      HostCard,
      EmptyHosts,
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
      /**
       * The takeover carrier's seams, exposed for unit tests: the warm-window pool, the
       * injected row, the local/guest pushes and the intent dispatcher.
       */
      carrier: {
        open: showOverlay,
        close: closeOverlay,
        closeOne: closeCarrier,
        hide: hideOverlays,
        warm: carrierWarm,
        shown: () => carrierPool.current,
        update: updateSwitcher,
        dispatch: (intent) => dispatchSwitcherIntent(intent),
        row: mountHostRow,
        script: () => HOST_ROW_SCRIPT,
      },
    }

    //#endregion
  },
})

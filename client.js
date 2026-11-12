/*
 * dsh-remote-go · Client half
 *
 * A single-file browser plugin (no build step) that contributes the
 * Settings → "Remote hosts" section and a global main panel. The panel lists
 * SSH hosts, runs the connect wizard, and embeds the remote DSH Web UI —
 * reached through a local loopback tunnel — in a sandboxed iframe. A left rail
 * in the panel groups local and per-host workspaces.
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
 *   9. remote viewport (toolbar + iframe)
 *  10. connect wizard
 *  11. diagnostics drawer
 *  12. settings modal
 *  13. panel container (state, SSE, routing, modals)
 *  14. styles
 *  15. plugin registration (apply)
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
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'dsh-remote-go'
    /** Base path of the Host HTTP API (same origin as the page). */
    const API_BASE = '/dsh-remote-go/api'
    /** SSE endpoint carrying `state` events; see contract §1. */
    const EVENT_PATH = '/dsh-remote-go/api/events'
    /** Fallback polling cadence when SSE is unavailable (contract §1). */
    const POLL_INTERVAL_MS = 3000
    /** LocalStorage flags (never store tokens or iframe URLs). */
    const ENTER_HINT_KEY = 'dsh-remote-go.hint.remote-enter'
    const CLOSE_HINT_KEY = 'dsh-remote-go.hint.remote-close'
    /** The workspace rail's collapsed state (UI preference only). */
    const RAIL_COLLAPSED_KEY = 'dsh-remote-go.rail.collapsed'
    /** iframe sandbox: enough for the remote DSH UI, nothing more. */
    const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
    /** Desktop browser-guest bridge (`window.dshDesktop`) protocol this build speaks. */
    const DESKTOP_BRIDGE_VERSION = 1
    /** DOM id of the full-window remote carrier, so a reload can drop a stale one. */
    const OVERLAY_ROOT_ID = 'dsh-remote-go-overlay'
    /** Only loopback URLs may ever become an iframe src (contract §3.5). */
    const LOOPBACK_PREFIX = 'http://127.0.0.1:'
    /** Ordered connect phases (contract ConnectPhase). */
    const PHASES = ['ssh', 'probe', 'bootstrap', 'start', 'tunnel', 'ready']
    /** Statuses that keep the viewport open with the iframe mounted. */
    const VIEWPORT_STATUSES = ['connected', 'disconnected']
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
    /** Status dot colors: theme tokens first, stable fallbacks second. */
    const TONE_VARS = {
      idle: 'var(--dsw-alias-state-idle-primary, #9aa0a6)',
      info: 'var(--dsw-alias-state-business-primary, #3b82f6)',
      success: 'var(--dsw-alias-state-success-primary, #22a06b)',
      warn: 'var(--dsw-alias-state-warn-primary, #d9a400)',
      error: 'var(--dsw-alias-state-error-primary, #d64545)',
      limited: '#8a63d2',
    }
    const STATUS_TONE = {
      unconfigured: 'idle',
      connecting: 'info',
      'fingerprint-pending': 'warn',
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
      settingsNav: '远程主机',
      settingsIntro: '管理通过 SSH 连接的远程主机；连接后可以在这里打开远端 DSH 界面。',
      settingsEmptyTitle: '还没有远程主机',
      settingsEmptyBody: '还没有远程主机。添加一台，然后在这里打开它的 DSH。',
      settingsAddHost: '添加远程主机',
      settingsHostOpen: '打开远程界面',
      settingsPluginSettings: '插件设置',
      panelSubtitle: '管理远程主机，并在本地整页打开远端 DSH。',
      addHost: '添加主机',
      addFirstHost: '添加第一台服务器',
      emptyTitle: '还没有远程主机',
      emptyBody: '还没有远程主机。添加一台，然后打开它的远端 DSH 界面。',
      refresh: '刷新状态',
      refreshing: '刷新中…',
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
      reconnectNow: '立即重连',
      refreshView: '刷新界面',
      open: '打开',
      connect: '连接',
      disconnect: '断开',
      connecting: '连接中…',
      loading: '加载中…',
      unknown: '未知',
      optional: '可选',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择文本。',
      next: '下一步',
      previous: '上一步',
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
      remoteAddr: '远端地址',
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
      statusConnected: '已连接',
      statusDisconnected: '断线',
      statusError: '错误',
      statusLimited: '受限',
      statusHintUnconfigured: '尚未连接过',
      statusHintConnecting: '正在建立连接',
      statusHintFingerprintPending: '需要确认主机指纹',
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
      statusUnknownHostTitle: '读取不到这台主机的状态',
      statusUnknownHostBody: '主机可能已被删除，或状态尚未同步。',

      // -- workspace rail ------------------------------------------------------
      workspaceRailTitle: '工作区',
      workspaceRailToggleCollapse: '收起工作区栏',
      workspaceRailToggleExpand: '展开工作区栏',
      workspaceRailRefresh: '刷新工作区',
      workspaceLocalGroup: '本地工作区',
      workspaceRemoteGroup: '远端工作区',
      workspaceRailHint: '本地工作区仍可在左侧边栏切换',
      workspaceRailEmpty: '还没有远程主机。添加一台后，这里会显示它的工作区。',
      workspaceLocalEmpty: '没有本地工作区',
      workspaceRemoteEmpty: '没有远端工作区',
      workspaceRailDisconnected: '未连接',
      workspaceRailRemoteError: '无法读取远端工作区',
      workspaceRailLocalError: '无法读取本地工作区',
      workspaceRailLoading: '正在读取…',
      workspaceRailSessions: '{count} 个会话',
      workspaceDefault: '默认',
      workspaceLocalOrigin: '本地',
      workspaceRemoteOrigin: '远端',
      // Mirrored (replayed) remote sessions are read-only until L3 adds input.
      mirrorReadOnlyBadge: '只读镜像',
      mirrorReadOnlyTitle: '{level} 只读镜像：{reason}',
      mirrorReadOnlyReasonDefault: '远端历史以只读方式回放，本地暂不支持输入',

      // -- viewport ------------------------------------------------------------
      viewportConnecting: '正在连接「{name}」…',
      viewportOpening: '正在连接「{name}」，准备远端界面…',
      viewportLoadingFrame: '正在加载远端界面…',
      viewportConnected: '远端界面已就绪',
      viewportDisconnected: '连接断开，远端任务可能仍在运行',
      viewportDisconnectedBody: '自动重连由本机负责；恢复后远端任务不会中断。你也可以手动重连。',
      viewportBack: '返回主机清单',
      viewportSwitch: '切换主机',
      viewportExternal: '在新窗口打开',
      viewportOverlayTitle: '接管整个窗口',
      viewportOverlayBody:
        '远端 DSH 在本地窗口里用真正的 Chromium guest 渲染（不是 iframe，也不是另开的浏览器）。顶部保留一条窄控制条：刷新、退出；其余画面就是远端那台机器。',
      viewportOverlayOpen: '接管窗口',
      viewportOverlayClose: '退出远端窗口',
      viewportOverlayUnsupported:
        '当前环境不支持接管窗口：只在 DSH 桌面端可用，浏览器里请改用「面板内嵌」或「本机独立窗口」。',
      viewportOverlayFailed: '接管窗口失败，请重试，或改用「面板内嵌」。',
      viewportOverlayHint: '接管期间下载会被桌面端禁用、权限请求会被拒绝；点顶部控制条的「退出」即可回到本地界面。',
      viewportOverlayBarLabel: '远端：{name}',
      viewportOverlayRefresh: '刷新',
      viewportOverlayExit: '退出',
      viewportOverlayLoading: '正在载入远端界面…',
      viewportOverlayLoadFailed: '远端界面加载失败',
      viewportAddressShow: '显示地址',
      viewportAddressHide: '隐藏地址',
      viewportFrameBlocked: '远端地址不是本地回环地址，已阻止内嵌。',
      viewportFrameBlockedBody: '请使用「在新窗口打开」，或重新连接 / 诊断以刷新本地回环地址。',
      viewportUnconfigured: '这台服务器还没有连接',
      viewportUnconfiguredBody: '连接后即可在这里整页使用远端 DSH。',
      enterNoticeTitle: '你正在操作远端服务器',
      enterNoticeBody: '视窗里显示的是远端 DSH 的界面，所有操作都在远端执行。关闭本机视窗不会结束远端任务。',
      closeNoticeTitle: '远端任务会继续运行',
      closeNoticeBody: '已返回主机清单。远端 DSH 与正在运行的任务不会停止，下次打开会直接回到该主机。',
      toolbarStatus: '状态：{status}',
      remoteVersionShort: '远端 {version}',

      // -- connect progress (contract §2) -------------------------------------
      'progress.ssh-connecting': '正在连接 SSH…',
      'progress.host-key-checking': '正在校验主机指纹…',
      'progress.host-key-confirm': '等待确认主机指纹…',
      'progress.auth-checking': '正在认证…',
      'progress.probing': '正在探测远端环境…',
      'progress.bootstrapping': '正在准备远端运行时…',
      'progress.bootstrap-progress': '自举进度：{detail}',
      'progress.starting-remote': '正在启动远端 DSH…',
      'progress.starting-remote-wait': '等待远端 DSH 就绪（{seconds} 秒）…',
      'progress.tunneling': '正在建立本地回环隧道…',
      'progress.verifying': '正在验证远端界面…',
      'progress.ready': '就绪',
      'progress.reconnecting': '断线重连中（第 {attempt}/{max} 次）…',
      'progress.default': '正在连接…',
      'phase.ssh': 'SSH',
      'phase.probe': '探测',
      'phase.bootstrap': '自举',
      'phase.start': '启动',
      'phase.tunnel': '隧道',
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
      fingerprintAccepting: '正在提交…',
      passwordPromptTitle: '输入 SSH 密码',
      passwordPromptBody: '「{name}」使用密码认证。密码只用于本次连接，不会保存。',
      passwordPromptLabel: '密码',
      passwordPromptSubmit: '连接',
      passwordPromptRequired: '请输入密码',

      // -- wizard --------------------------------------------------------------
      'wizard.stepLabel': '第 {current} 步，共 {total} 步',
      'wizard.step1': '1 · SSH 信息',
      'wizard.step2': '2 · 连接测试',
      'wizard.step3': '3 · 完成',
      'wizard.name': '显示名',
      'wizard.namePlaceholder': '例如：腾讯云测试机',
      'wizard.address': 'SSH 地址或别名',
      'wizard.addressPlaceholder': '例如：ubuntu@192.0.2.10 或 my-server',
      'wizard.addressHint': '支持 ~/.ssh/config 中配置的别名。',
      'wizard.port': '端口',
      'wizard.username': '用户名',
      'wizard.usernamePlaceholder': '例如：ubuntu',
      'wizard.auth': '认证方式',
      'wizard.authAgent': '使用 SSH Agent',
      'wizard.authKey': '指定密钥文件',
      'wizard.authPassword': '密码（仅本次，不保存）',
      'wizard.keyPath': '密钥文件路径',
      'wizard.keyPathPlaceholder': '例如：~/.ssh/id_ed25519',
      'wizard.password': '密码',
      'wizard.passwordPlaceholder': '仅用于本次连接，不会保存',
      'wizard.authHint': '建议优先使用 SSH Agent 或密钥文件；密码只用于本次连接。',
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
      'wizard.bootstrapLevel': '自举等级',
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
      'wizard.validationPassword': '请输入密码，或改用 SSH Agent / 密钥文件',

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
      'settings.window': '窗口',
      'settings.windowMode': '呈现形态',
      'settings.windowModePanel': '面板内嵌（iframe）',
      'settings.windowModeOverlay': '接管整个窗口（推荐，仅桌面端）',
      'settings.windowModeHint':
        '面板内嵌：在插件面板里用 iframe 显示远端界面。接管整个窗口：远端 DSH 以真正的 Chromium guest 铺满整个窗口（仅在 DSH 桌面端可用，下载与权限受桌面端限制）。本机独立窗口：远端界面在单独的本地浏览器窗口渲染。',
      'settings.closeBehavior': '关闭视窗行为',
      'settings.closeBehaviorValue': '保留远端会话（V1 固定）',
      'settings.closeBehaviorHint': '关闭本地视窗不会结束远端任务。',
      'settings.ssh': 'SSH 默认值',
      'settings.defaultPort': '默认端口',
      'settings.defaultAuth': '默认认证方式',
      'settings.defaultAuthAgent': 'SSH Agent',
      'settings.defaultAuthKey': '密钥文件',
      'settings.defaultAuthPassword': '密码（仅本次）',
      'settings.connectTimeout': '连接超时（秒）',
      'settings.security': '安全',
      'settings.hostKeyPolicy': '主机指纹策略',
      'settings.hostKeyPolicyFirstUse': '首次连接时询问',
      'settings.hostKeyPolicyStrict': '严格校验（指纹变化即失败）',
      'settings.saveTokens': '允许保存访问令牌',
      'settings.saveTokensHint':
        '默认关闭。开启后访问令牌会以 0600 权限保存在远端 DSH_HOME 下，仍存在被同机其他进程读取的风险。',
      'settings.saveTokensRisk': '风险提示：令牌落盘后更难撤销，请只在受控服务器上开启。',
      'settings.mirror': '镜像会话',
      'settings.mirrorToSidebar': '把远端镜像会话显示在本地侧边栏',
      'settings.mirrorToSidebarHint':
        '默认开启。每台远端主机在本地侧边栏注册一个「Remote: 主机名」工作区；关闭后会移除已注册的分组，重新开启并在下次同步（连接或刷新镜像）时恢复。',
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
      'settings.bootstrap': '自举',
      'settings.targetVersion': '目标版本',
      'settings.targetVersionHint': 'local = 跟随本机 DSH 版本',
      'settings.mode': '自举方式',
      'settings.modeAuto': '自动（推荐）',
      'settings.modeReuse': '仅复用已安装',
      'settings.modeNpx': '使用 npx',
      'settings.modeIsolated': '隔离目录安装',
      'settings.remoteDir': '远端隔离目录',
      'settings.nodeVersion': 'Node 版本',
      'settings.saveSettings': '保存设置',
      'settings.saved': '设置已保存。',
      'settings.saveFailed': '保存设置失败',

      // -- local errors --------------------------------------------------------
      'error.readState': '读取状态失败',
      'error.actionFailed': '操作失败',
      'error.detailSuffix': '（{detail}）',
    }

    /** English dictionary — complete parallel of `zh`. */
    const en = {
      settingsNav: 'Remote hosts',
      settingsIntro: 'Manage hosts connected over SSH; once connected, open their DSH interface here.',
      settingsEmptyTitle: 'No remote hosts yet',
      settingsEmptyBody: 'No remote hosts yet. Add one, then open its DSH here.',
      settingsAddHost: 'Add remote host',
      settingsHostOpen: 'Open remote UI',
      settingsPluginSettings: 'Plugin settings',
      panelSubtitle: 'Manage remote hosts and open their DSH full-page locally.',
      addHost: 'Add host',
      addFirstHost: 'Add your first server',
      emptyTitle: 'No remote hosts yet',
      emptyBody: 'No remote hosts yet. Add one, then open its remote DSH interface.',
      refresh: 'Refresh status',
      refreshing: 'Refreshing…',
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
      reconnectNow: 'Reconnect now',
      refreshView: 'Refresh view',
      open: 'Open',
      connect: 'Connect',
      disconnect: 'Disconnect',
      connecting: 'Connecting…',
      loading: 'Loading…',
      unknown: 'Unknown',
      optional: 'optional',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the text manually.',
      next: 'Next',
      previous: 'Back',
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
      remoteAddr: 'Remote address',
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
      statusConnected: 'Connected',
      statusDisconnected: 'Disconnected',
      statusError: 'Error',
      statusLimited: 'Limited',
      statusHintUnconfigured: 'Never connected',
      statusHintConnecting: 'Establishing the connection',
      statusHintFingerprintPending: 'Confirm the host fingerprint',
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
      statusUnknownHostTitle: 'Cannot read this host',
      statusUnknownHostBody: 'It may have been deleted, or its state has not synced yet.',

      workspaceRailTitle: 'Workspaces',
      workspaceRailToggleCollapse: 'Collapse the workspaces bar',
      workspaceRailToggleExpand: 'Expand the workspaces bar',
      workspaceRailRefresh: 'Refresh workspaces',
      workspaceLocalGroup: 'Local workspaces',
      workspaceRemoteGroup: 'Remote workspaces',
      workspaceRailHint: 'Local workspaces can still be switched from the left sidebar',
      workspaceRailEmpty: 'No remote hosts yet. Add one and its workspaces will show here.',
      workspaceLocalEmpty: 'No local workspaces',
      workspaceRemoteEmpty: 'No remote workspaces',
      workspaceRailDisconnected: 'Not connected',
      workspaceRailRemoteError: 'Cannot read remote workspaces',
      workspaceRailLocalError: 'Cannot read local workspaces',
      workspaceRailLoading: 'Loading…',
      workspaceRailSessions: '{count} sessions',
      workspaceDefault: 'Default',
      workspaceLocalOrigin: 'Local',
      workspaceRemoteOrigin: 'Remote',
      // Mirrored (replayed) remote sessions are read-only until L3 adds input.
      mirrorReadOnlyBadge: 'Read-only mirror',
      mirrorReadOnlyTitle: 'Read-only {level} mirror: {reason}',
      mirrorReadOnlyReasonDefault: 'Remote history is replayed read-only; local input is not supported yet',

      viewportConnecting: 'Connecting to "{name}"…',
      viewportOpening: 'Connecting to "{name}" and preparing the remote UI…',
      viewportLoadingFrame: 'Loading the remote UI…',
      viewportConnected: 'Remote UI ready',
      viewportDisconnected: 'Connection lost — remote tasks may still be running',
      viewportDisconnectedBody:
        'Automatic reconnect is handled locally; running remote tasks are not interrupted. You can also reconnect manually.',
      viewportBack: 'Back to hosts',
      viewportSwitch: 'Switch host',
      viewportExternal: 'Open in new window',
      viewportOverlayTitle: 'Take over the whole window',
      viewportOverlayBody:
        'The remote DSH renders in this window through a real Chromium guest — no iframe, no second browser window. A thin control strip on top carries refresh and exit; everything below it is the remote machine.',
      viewportOverlayOpen: 'Take over the window',
      viewportOverlayClose: 'Leave the remote window',
      viewportOverlayUnsupported:
        'Taking over the window needs the DSH desktop app; in a browser use the embedded panel or a local window instead.',
      viewportOverlayFailed: 'Could not take over the window. Retry, or switch to the embedded panel.',
      viewportOverlayHint:
        'While the window is taken over, downloads are disabled by the desktop app and permission requests are denied. Use "Exit" in the top strip to return.',
      viewportOverlayBarLabel: 'Remote: {name}',
      viewportOverlayRefresh: 'Refresh',
      viewportOverlayExit: 'Exit',
      viewportOverlayLoading: 'Loading the remote UI…',
      viewportOverlayLoadFailed: 'The remote UI failed to load',
      viewportAddressShow: 'Show address',
      viewportAddressHide: 'Hide address',
      viewportFrameBlocked: 'The remote address is not a loopback address; embedding was blocked.',
      viewportFrameBlockedBody: 'Use "Open in new window", or reconnect / diagnose to refresh the loopback address.',
      viewportUnconfigured: 'This server is not connected yet',
      viewportUnconfiguredBody: 'Connect to use the remote DSH on this page.',
      enterNoticeTitle: 'You are operating a remote server',
      enterNoticeBody:
        'This window shows the remote DSH interface; everything runs remotely. Closing this window does not stop remote tasks.',
      closeNoticeTitle: 'Remote tasks keep running',
      closeNoticeBody:
        'Back to the host list. The remote DSH and its running tasks keep running; reopen to return to this host.',
      toolbarStatus: 'Status: {status}',
      remoteVersionShort: 'Remote {version}',

      'progress.ssh-connecting': 'Connecting over SSH…',
      'progress.host-key-checking': 'Verifying the host key…',
      'progress.host-key-confirm': 'Waiting for you to confirm the host key…',
      'progress.auth-checking': 'Authenticating…',
      'progress.probing': 'Probing the remote environment…',
      'progress.bootstrapping': 'Preparing the remote runtime…',
      'progress.bootstrap-progress': 'Bootstrap: {detail}',
      'progress.starting-remote': 'Starting the remote DSH…',
      'progress.starting-remote-wait': 'Waiting for the remote DSH ({seconds}s)…',
      'progress.tunneling': 'Opening the loopback tunnel…',
      'progress.verifying': 'Verifying the remote UI…',
      'progress.ready': 'Ready',
      'progress.reconnecting': 'Reconnecting ({attempt}/{max})…',
      'progress.default': 'Connecting…',
      'phase.ssh': 'SSH',
      'phase.probe': 'Probe',
      'phase.bootstrap': 'Bootstrap',
      'phase.start': 'Start',
      'phase.tunnel': 'Tunnel',
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
      fingerprintAccepting: 'Submitting…',
      passwordPromptTitle: 'Enter the SSH password',
      passwordPromptBody:
        '"{name}" uses password authentication. The password is used only for this connection and is never saved.',
      passwordPromptLabel: 'Password',
      passwordPromptSubmit: 'Connect',
      passwordPromptRequired: 'Enter the password',

      'wizard.stepLabel': 'Step {current} of {total}',
      'wizard.step1': '1 · SSH details',
      'wizard.step2': '2 · Connection test',
      'wizard.step3': '3 · Finish',
      'wizard.name': 'Display name',
      'wizard.namePlaceholder': 'e.g. Tencent test server',
      'wizard.address': 'SSH address or alias',
      'wizard.addressPlaceholder': 'e.g. ubuntu@192.0.2.10 or my-server',
      'wizard.addressHint': 'Aliases from ~/.ssh/config are supported.',
      'wizard.port': 'Port',
      'wizard.username': 'User',
      'wizard.usernamePlaceholder': 'e.g. ubuntu',
      'wizard.auth': 'Authentication',
      'wizard.authAgent': 'SSH agent',
      'wizard.authKey': 'Key file',
      'wizard.authPassword': 'Password (this connection only)',
      'wizard.keyPath': 'Key file path',
      'wizard.keyPathPlaceholder': 'e.g. ~/.ssh/id_ed25519',
      'wizard.password': 'Password',
      'wizard.passwordPlaceholder': 'Used for this connection only; never saved',
      'wizard.authHint': 'Prefer the SSH agent or a key file; a password is used for this connection only.',
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
      'wizard.bootstrapLevel': 'Bootstrap level',
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
      'wizard.validationPassword': 'Enter the password, or use the SSH agent / a key file',

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
      'settings.window': 'Window',
      'settings.windowMode': 'Presentation',
      'settings.windowModePanel': 'Embedded panel (iframe)',
      'settings.windowModeOverlay': 'Take over the window (recommended, desktop only)',
      'settings.windowModeHint':
        'Embedded: the remote UI is shown inside this panel with an iframe. Take over: the remote DSH fills the whole window through a real Chromium guest (DSH desktop only; downloads and permissions are limited by the shell). Local window: the remote UI renders in a separate local browser window.',
      'settings.closeBehavior': 'Closing behavior',
      'settings.closeBehaviorValue': 'Keep the remote session (fixed in V1)',
      'settings.closeBehaviorHint': 'Closing the local view never stops remote tasks.',
      'settings.ssh': 'SSH defaults',
      'settings.defaultPort': 'Default port',
      'settings.defaultAuth': 'Default authentication',
      'settings.defaultAuthAgent': 'SSH agent',
      'settings.defaultAuthKey': 'Key file',
      'settings.defaultAuthPassword': 'Password (this connection only)',
      'settings.connectTimeout': 'Connect timeout (seconds)',
      'settings.security': 'Security',
      'settings.hostKeyPolicy': 'Host key policy',
      'settings.hostKeyPolicyFirstUse': 'Ask on first use',
      'settings.hostKeyPolicyStrict': 'Strict (fail when the key changes)',
      'settings.saveTokens': 'Allow saving access tokens',
      'settings.saveTokensHint':
        'Off by default. When enabled, tokens are saved under the remote DSH_HOME with 0600 permissions, which still risks access by other processes on that machine.',
      'settings.saveTokensRisk': 'Risk: a persisted token is harder to revoke. Enable only on controlled servers.',
      'settings.mirror': 'Mirrored sessions',
      'settings.mirrorToSidebar': 'Show mirrored remote sessions in the local sidebar',
      'settings.mirrorToSidebarHint':
        'On by default. Each remote host registers one "Remote: <host>" workspace in the local sidebar; turning it off removes the registered groups, and turning it back on restores them on the next sync (connect or mirror refresh).',
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
      'settings.bootstrap': 'Bootstrap',
      'settings.targetVersion': 'Target version',
      'settings.targetVersionHint': 'local = follow the local DSH version',
      'settings.mode': 'Bootstrap mode',
      'settings.modeAuto': 'Auto (recommended)',
      'settings.modeReuse': 'Reuse only',
      'settings.modeNpx': 'Use npx',
      'settings.modeIsolated': 'Install into an isolated directory',
      'settings.remoteDir': 'Remote isolated directory',
      'settings.nodeVersion': 'Node version',
      'settings.saveSettings': 'Save settings',
      'settings.saved': 'Settings saved.',
      'settings.saveFailed': 'Failed to save settings',

      'error.readState': 'Failed to read state',
      'error.actionFailed': 'Action failed',
      'error.detailSuffix': ' ({detail})',
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
     * slot framework did not seat a `t` prop (e.g. a unit-test render).
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
     * Plain strings pass through unchanged (contract §0 I18nText).
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
     * Everything else — including SSH aliases — is non-loopback by definition.
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
     * iframe src. The Host guarantees loopback, and the client re-checks it
     * (contract §3.5); anything else is refused rather than embedded.
     * @param {unknown} url - candidate URL.
     * @returns {boolean} whether the URL is a loopback http URL.
     */
    function isValidIframeUrl(url) {
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
     * supplied it, otherwise the raw address (contract HostView.addressMasked).
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
     * Read the browser's localStorage without assuming it is available.
     * @returns {Storage|null} storage handle or null.
     */
    function localStore() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        return window.localStorage
      } catch (_error) {
        return null
      }
    }

    /** @param {string} key - flag key. @returns {boolean} whether the flag is set. */
    function readFlag(key) {
      try {
        const store = localStore()
        return store !== null && store.getItem(key) === '1'
      } catch (_error) {
        return false
      }
    }

    /** @param {string} key - flag key. */
    function writeFlag(key) {
      try {
        const store = localStore()
        if (store !== null) store.setItem(key, '1')
      } catch (_error) {
        // a full/blocked storage must never break the panel
      }
    }

    /**
     * Copy text with the Clipboard API, falling back to a hidden textarea plus
     * `execCommand('copy')` for insecure contexts.
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
     * Localized progress line for a host (contract §2 progress codes).
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
     * One-shot request channel between the settings section and the main panel:
     * the settings page asks the panel to open a host, then switches the layout
     * to it. The panel consumes the request on mount or on subscribe.
     * @returns {{request: Function, take: Function, subscribe: Function}} store handle.
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
        request(hostId) {
          if (typeof hostId === 'string' && hostId.length > 0) {
            pending = hostId
            emit()
          }
        },
        take() {
          const hostId = pending
          pending = null
          return hostId
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /** @returns {boolean} whether the workspace rail was left collapsed. */
    function readRailCollapsed() {
      try {
        const store = localStore()
        return store !== null && store.getItem(RAIL_COLLAPSED_KEY) === '1'
      } catch (_error) {
        return false
      }
    }

    /** @param {boolean} collapsed - collapse state to remember. */
    function writeRailCollapsed(collapsed) {
      try {
        const store = localStore()
        if (store !== null) store.setItem(RAIL_COLLAPSED_KEY, collapsed === true ? '1' : '0')
      } catch (_error) {
        // storage is an optional preference; never break the rail
      }
    }

    //#endregion

    //#region 5. local error views

    /**
     * Local fallback ErrorViews (contract §0 ErrorView). Host responses carry
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
      'blocked-iframe': {
        code: 'blocked-iframe',
        retryable: false,
        title: { zh: '已阻止内嵌远端界面', en: 'Blocked embedding the remote UI' },
        detail: {
          zh: '远端地址不是本地回环地址，出于安全考虑已阻止内嵌。',
          en: 'The remote address is not a loopback address, so embedding was blocked for safety.',
        },
        nextSteps: [
          { zh: '使用「在新窗口打开」', en: 'Use "Open in new window"' },
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
     * marker header and same-origin credentials (contract §3.4).
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
      /** @returns {Promise<object>} StateView (contract §1 GET /state). */
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
       * Fetch the one-time loopback URL for the iframe (contract §1 GET /open).
       * The URL stays in memory only — never logged, never stored.
       * @param {string} hostId - host id.
       * @returns {Promise<string>} validated loopback URL.
       */
      async openHost(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/open')
        if (!isValidIframeUrl(payload.url)) throw apiError(localErrorView('blocked-iframe'))
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
      /** @returns {Promise<object>} local workspace registry (contract §1 GET /local/workspaces). */
      async getLocalWorkspaces() {
        const payload = await apiRequest('/local/workspaces')
        return {
          workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
          defaultWorkspaceId: typeof payload.defaultWorkspaceId === 'string' ? payload.defaultWorkspaceId : null,
          initialized: payload.initialized !== false,
          source: typeof payload.source === 'string' ? payload.source : null,
        }
      },
      /**
       * Workspace list of one remote host (contract §1 GET /hosts/:id/workspaces).
       * Reports `connected:false` instead of failing when the tunnel is down.
       * @param {string} hostId - host id.
       * @returns {Promise<object>} workspace payload.
       */
      async getHostWorkspaces(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/workspaces')
        return {
          connected: payload.connected === true,
          hostId: typeof payload.hostId === 'string' ? payload.hostId : hostId,
          hostName: typeof payload.hostName === 'string' ? payload.hostName : '',
          workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
          defaultWorkspaceId: typeof payload.defaultWorkspaceId === 'string' ? payload.defaultWorkspaceId : null,
          initialized: payload.initialized !== false,
        }
      },
      /**
       * Mirrored sessions of one remote host (contract §1 GET /hosts/:id/mirrors).
       * The rail only needs `readOnly` to mark replayed sessions; a failure is
       * tolerated by the caller, which then shows no badge instead of a guess.
       * @param {string} hostId - host id.
       * @returns {Promise<{mirrors: object[]}>} mirror payload.
       */
      async getHostMirrors(hostId) {
        const payload = await apiRequest('/hosts/' + encodeURIComponent(hostId) + '/mirrors')
        return { mirrors: Array.isArray(payload.mirrors) ? payload.mirrors : [] }
      },
      /**
       * Point the Host's active host at `hostId` so a reload reopens the same
       * remote panel (POST /hosts/:id/activate).
       * @param {string} hostId - host id.
       * @returns {Promise<object>} acknowledgement.
       */
      async activate(hostId) {
        return apiRequest('/hosts/' + encodeURIComponent(hostId) + '/activate', { method: 'POST', body: {} })
      },
      /** @returns {Promise<{aliases: object[], knownHosts: object}>} SSH alias scan (contract §1). */
      async getAliases() {
        const payload = await apiRequest('/ssh/aliases')
        return {
          aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
          knownHosts: payload.knownHosts && typeof payload.knownHosts === 'object' ? payload.knownHosts : null,
        }
      },
    }

    /**
     * Subscribe to live state: SSE first, 3s polling once the stream fails
     * (contract §1). Always resolves the current state once up front.
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
    const IconBack = strokeIcon(['M15 5l-7 7 7 7'])
    const IconExternal = strokeIcon([
      'M14 4h6v6',
      'M20 4l-9 9',
      'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    ])
    const IconClose = strokeIcon(['M6 6l12 12', 'M18 6L6 18'])
    const IconCheck = strokeIcon(['M5 12.5l4.5 4.5L19 7'])
    const IconAlert = strokeIcon(['M12 3.5 21 19H3L12 3.5Z', 'M12 9.5v4.5', 'M12 17h.01'])
    const IconWifi = strokeIcon([
      'M3.5 9.5a13 13 0 0 1 17 0',
      'M6.5 13a8.5 8.5 0 0 1 11 0',
      'M9.5 16.5a4 4 0 0 1 5 0',
      'M12 20h.01',
    ])
    const IconFolder = strokeIcon([
      'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V7Z',
    ])
    const IconChevronLeft = strokeIcon(['M14.5 6.5 8.5 12l6 5.5'])
    const IconChevronRight = strokeIcon(['M9.5 6.5l6 5.5-6 5.5'])

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
        { className: 'drg-field', htmlFor: props.htmlFor },
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
      const settingsMode = props.variant === 'settings'
      return h(
        'div',
        { className: 'drg-empty', 'data-testid': settingsMode ? 'settings-host-list-empty' : 'host-list-empty' },
        h('div', { className: 'drg-empty-icon', 'aria-hidden': 'true' }, h(RemoteIcon, { size: 40 })),
        h('h3', { className: 'drg-empty-title' }, settingsMode ? t('settingsEmptyTitle') : t('emptyTitle')),
        h('p', { className: 'drg-empty-body' }, settingsMode ? t('settingsEmptyBody') : t('emptyBody')),
        h(
          Button,
          {
            variant: 'primary',
            testId: settingsMode ? 'settings-host-add-empty' : 'host-add-empty',
            onClick: props.onAdd === undefined ? undefined : () => props.onAdd(),
          },
          settingsMode ? t('settingsAddHost') : t('addFirstHost'),
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
      const settingsMode = props.variant === 'settings'
      const primaryLabel = settingsMode
        ? t('settingsHostOpen')
        : host.status === 'connected'
          ? t('cardOpen')
          : host.status === 'fingerprint-pending'
            ? t('confirmFingerprint')
            : host.status === 'connecting'
              ? t('connecting')
              : t('cardConnect')
      const primaryTestId = settingsMode ? 'settings-host-open' : 'host-open'
      const primaryDisabled = settingsMode ? busy || host.status !== 'connected' : busy || host.status === 'connecting'

      return h(
        'li',
        { className: 'drg-host-card', 'data-status': host.status, 'data-testid': 'host-card', 'data-host-id': host.id },
        failing
          ? h(
              'div',
              { className: 'drg-card-strip', role: 'alert' },
              h(IconAlert, { size: 14 }),
              h('span', { className: 'drg-card-strip-text' }, t('errorReason', { detail: reason || t(meta.hintKey) })),
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
              busy: settingsMode ? false : busy && host.status !== 'connected' && host.status !== 'connecting',
            },
            primaryLabel,
          ),
          settingsMode && host.status !== 'connected'
            ? h(
                Button,
                {
                  variant: 'secondary',
                  testId: 'settings-host-connect',
                  onClick: () => props.onConnect && props.onConnect(host),
                  disabled: busy || host.status === 'connecting',
                },
                host.status === 'connecting' ? t('connecting') : t('cardConnect'),
              )
            : null,
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
          !settingsMode && (host.status === 'disconnected' || host.status === 'error' || host.status === 'limited')
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
     * Main-panel host list (design §4.1). Pure presentation: all actions rise
     * through callbacks, all data comes from `/state`.
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
      const settingsMode = props.variant === 'settings'

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
        content = h(EmptyHosts, { t, variant: props.variant, onAdd: props.onAdd })
      } else {
        content = h(
          'div',
          { className: 'drg-host-body' },
          h(
            'div',
            { className: 'drg-summary' },
            h(StatusDot, { status: 'connected' }),
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
                variant: props.variant,
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
            h('h1', { className: 'drg-page-title' }, settingsMode ? t('settingsNav') : t('hostsTitle')),
            h('p', { className: 'drg-page-subtitle' }, settingsMode ? t('settingsIntro') : t('panelSubtitle')),
          ),
          h(
            'div',
            { className: 'drg-page-actions' },
            h(
              Button,
              {
                variant: 'primary',
                testId: settingsMode ? 'settings-host-add' : 'host-add',
                onClick: props.onAdd === undefined ? undefined : () => props.onAdd(),
              },
              h(IconPlus, { size: 14 }),
              h('span', null, settingsMode ? t('settingsAddHost') : t('addHost')),
            ),
            h(
              Button,
              {
                variant: 'ghost',
                testId: settingsMode ? 'settings-host-refresh' : 'host-refresh',
                onClick: props.onRefresh,
                busy: loading,
              },
              h(IconRefresh, { size: 14 }),
              h('span', null, t('refresh')),
            ),
            h(IconButton, {
              icon: h(IconGear),
              label: settingsMode ? t('settingsPluginSettings') : t('settings'),
              testId: settingsMode ? 'settings-settings-open' : 'host-settings',
              onClick: props.onOpenSettings,
            }),
          ),
        ),
        props.closeNotice === true
          ? h(
              Notice,
              {
                tone: 'info',
                title: t('closeNoticeTitle'),
                onDismiss: props.onDismissCloseNotice,
                dismissLabel: t('dismiss'),
              },
              t('closeNoticeBody'),
            )
          : null,
        content,
      )
    }

    //#endregion

    //#region 9. remote viewport (toolbar + iframe)

    /**
     * Staged connect progress: current progress line plus the phase checklist
     * (contract ConnectPhase / §2 progress codes).
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
     * viewport when an existing host reconnects to an unknown/changed key.
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
     * Never renders an empty viewport (design §8.2).
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

    /**
     * Viewport toolbar (design §4.3): host + status, optional address, and the
     * reconnect / refresh / switch / external / back actions.
     * @param {object} props - host, hosts, visibility flags, callbacks.
     * @returns {object} div element.
     */
    function ViewportToolbar(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const hosts = Array.isArray(props.hosts) ? props.hosts : []
      const meta = statusMeta(host.status || 'unconfigured')
      const addressVisible = props.addressVisible !== false
      const others = hosts.filter((item) => item && item.id !== host.id)
      return h(
        'div',
        { className: 'drg-toolbar', 'data-testid': 'viewport-toolbar' },
        h(
          'div',
          { className: 'drg-toolbar-left' },
          h(IconButton, {
            icon: h(IconBack),
            label: t('viewportBack'),
            testId: 'viewport-back',
            onClick: props.onBack,
          }),
          h(StatusDot, { status: host.status, title: t(meta.labelKey) }),
          h('span', { className: 'drg-toolbar-host', title: host.name }, host.name || host.id),
          h('span', { className: 'drg-toolbar-status', 'data-status': host.status }, t(meta.labelKey)),
        ),
        h(
          'div',
          { className: 'drg-toolbar-center' },
          h(
            'span',
            { className: 'drg-toolbar-address', title: addressVisible ? displayAddress(host) : undefined },
            addressVisible ? displayAddress(host) : '••••••',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'drg-linkbtn',
              onClick: props.onToggleAddress,
              title: addressVisible ? t('viewportAddressHide') : t('viewportAddressShow'),
            },
            addressVisible ? t('viewportAddressHide') : t('viewportAddressShow'),
          ),
        ),
        h(
          'div',
          { className: 'drg-toolbar-right' },
          others.length > 0
            ? h(Select, {
                value: host.id,
                options: hosts.map((item) => ({ value: item.id, label: item.name || item.id })),
                onChange: props.onSwitchHost,
                ariaLabel: t('viewportSwitch'),
              })
            : null,
          h(
            Button,
            {
              variant: 'ghost',
              testId: 'viewport-reconnect',
              onClick: props.onReconnect,
              disabled: host.status === 'connecting',
            },
            t('reconnect'),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              testId: 'viewport-refresh',
              onClick: props.onRefreshFrame,
              disabled: host.status !== 'connected',
            },
            t('refreshView'),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              testId: 'viewport-external',
              onClick: props.onOpenExternal,
              disabled: host.status !== 'connected',
            },
            h(IconExternal, { size: 14 }),
            h('span', null, t('viewportExternal')),
          ),
          h(IconButton, {
            icon: h(IconPulse),
            label: t('diagnose'),
            testId: 'viewport-diagnose',
            onClick: props.onDiagnose,
          }),
        ),
      )
    }

    /**
     * Card shown while the window takeover is not active. In the desktop app
     * the carrier is created imperatively (see `openOverlay`); this card is the
     * launcher and the explanation of what the mode does.
     * @param {object} props - t, status, callbacks.
     * @returns {object} div element.
     */
    function OverlayViewerCard(props) {
      const t = translatorOf(props)
      const status = typeof props.status === 'string' ? props.status : 'idle'
      const unsupported = status === 'unsupported'
      const failed = status === 'failed' || status === 'acquire-failed' || status === 'bad-url'
      return h(
        'div',
        { className: 'drg-overlay-card', 'data-testid': 'overlay-viewer', 'data-state': status },
        h('div', { className: 'drg-overlay-card-icon', 'aria-hidden': 'true' }, h(IconExternal, { size: 28 })),
        h('h2', null, t('viewportOverlayTitle')),
        h('p', null, t('viewportOverlayBody')),
        h('p', { className: 'drg-overlay-card-status' }, t('viewportOverlayHint')),
        unsupported ? h(Notice, { tone: 'warn' }, t('viewportOverlayUnsupported')) : null,
        failed ? h(Notice, { tone: 'warn' }, t('viewportOverlayFailed')) : null,
        h(
          'div',
          { className: 'drg-row drg-row-wrap' },
          h(
            Button,
            {
              variant: 'primary',
              testId: 'overlay-open',
              disabled: unsupported,
              onClick: props.onOpen,
            },
            t('viewportOverlayOpen'),
          ),
          h(
            Button,
            { variant: 'secondary', testId: 'overlay-close', disabled: !props.open, onClick: props.onClose },
            t('viewportOverlayClose'),
          ),
        ),
      )
    }

    //#region 9b. full-window remote carrier (DSH desktop only)

    /**
     * The DSH desktop shell exposes a browser-guest bridge on the page:
     * `window.dshDesktop` (protocol v1) -> `browser.acquire(workspace)` reserves a
     * Chromium guest in a per-workspace partition, and a `<webview>` whose src is
     * "about:blank#<lease>" attaches it. The guest is a real browser context (own
     * cookies, real downloads pipeline), not an iframe, and it can be sized to
     * cover the whole application page — that is what makes the desktop window
     * show the remote host instead of this UI.
     *
     * The carrier element lives on `document.body` outside the React tree so it
     * survives panel switches; the control strip at the top of the carrier is the
     * only way back, because keyboard focus belongs to the guest while it is up.
     */
    const overlayCarrier = { hostId: null, lease: null, root: null, view: null, url: null, onExit: null }

    /** @returns {object | null} the desktop browser bridge, or null outside the desktop app. */
    function desktopBrowserBridge() {
      if (typeof window === 'undefined') return null
      const carrier = window.dshDesktop
      if (!carrier || carrier.protocolVersion !== DESKTOP_BRIDGE_VERSION) return null
      const browser = carrier.browser
      if (!browser || typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return null
      return browser
    }

    /** @param {string} label @param {Function} onClick @param {string} extra @returns {object} */
    function overlayButton(label, onClick, extra) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.style.cssText =
        'border:1px solid #34343c;background:#232329;color:#e6e6e8;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer' +
        (extra || '')
      button.addEventListener('click', onClick)
      return button
    }

    /**
     * Take over the whole window with a live remote-DSH guest.
     * @param {{ hostId: string, name: string, url: string, t: Function, onExit?: Function }} options
     * @returns {Promise<{ ok: boolean, reason?: string, reused?: boolean }>}
     */
    async function openOverlay(options) {
      const bridge = desktopBrowserBridge()
      if (bridge === null) return { ok: false, reason: 'unsupported' }
      const hostId = typeof options.hostId === 'string' ? options.hostId : ''
      const url = typeof options.url === 'string' ? options.url : ''
      if (!isValidIframeUrl(url)) return { ok: false, reason: 'bad-url' }
      const t = typeof options.t === 'function' ? options.t : (key) => key
      if (overlayCarrier.root !== null) {
        if (overlayCarrier.hostId === hostId) {
          const changed = overlayCarrier.url !== url
          overlayCarrier.url = url
          overlayCarrier.onExit = typeof options.onExit === 'function' ? options.onExit : overlayCarrier.onExit
          if (changed && overlayCarrier.view !== null) {
            try {
              await overlayCarrier.view.loadURL(url)
            } catch (_error) {
              // the guest reports navigation failures through did-fail-load
            }
          }
          return { ok: true, reused: true }
        }
        await closeOverlay()
      }
      let reservation = null
      try {
        reservation = await bridge.acquire('dsh-remote-go:' + (hostId || 'host'))
      } catch (_error) {
        return { ok: false, reason: 'acquire-failed' }
      }
      if (
        !reservation ||
        typeof reservation.lease !== 'string' ||
        typeof reservation.partition !== 'string' ||
        reservation.lease === ''
      ) {
        return { ok: false, reason: 'acquire-failed' }
      }

      const root = document.createElement('div')
      root.id = OVERLAY_ROOT_ID
      root.setAttribute('data-testid', 'remote-overlay')
      // The desktop window is frameless with a 40px titlebar overlay (Windows
      // caption buttons / macOS traffic lights), so the carrier starts below it:
      // clicks in that band belong to the OS, not to this page.
      root.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;top:40px;z-index:2147483000;display:flex;flex-direction:column;background:#0b0b0d;color:#e6e6e8;font:13px system-ui,-apple-system,Segoe UI,sans-serif'

      const strip = document.createElement('div')
      strip.style.cssText =
        'display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;flex:none;background:#18181b;border-bottom:1px solid #2a2a2f'
      const label = document.createElement('div')
      label.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;flex:1'
      const dot = document.createElement('span')
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#22a06b;flex:none'
      const name = document.createElement('span')
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      name.textContent = t('viewportOverlayBarLabel', { name: options.name || hostId })
      label.append(dot, name)
      const status = document.createElement('span')
      status.style.cssText = 'color:#8a8a92;font-size:12px;white-space:nowrap'
      status.textContent = t('viewportOverlayLoading')
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;align-items:center;gap:6px;flex:none'

      // Reload in place: the guest already holds the session cookie, so a rerun of
      // the one-time token URL is both pointless and risky (the token is spent).
      const refresh = overlayButton(t('viewportOverlayRefresh'), () => {
        if (overlayCarrier.view === null) return
        status.textContent = t('viewportOverlayLoading')
        try {
          overlayCarrier.view.reload()
        } catch (_error) {
          // a guest that went away reports through did-fail-load
        }
      })
      const exit = overlayButton(
        t('viewportOverlayExit'),
        () => {
          closeOverlay().catch(() => {})
        },
        ';background:#2b2b33',
      )
      actions.append(refresh, exit)
      strip.append(label, status, actions)

      const view = document.createElement('webview')
      view.setAttribute('name', String(reservation.lease))
      view.setAttribute('partition', String(reservation.partition))
      view.setAttribute('allowpopups', '')
      view.setAttribute('src', 'about:blank#' + String(reservation.lease))
      view.style.cssText = 'flex:1;min-height:0;width:100%;border:0;background:#000'
      // `dom-ready` fires once per committed navigation, so navigating from it
      // unconditionally would reload the remote page forever (visible as flicker).
      // The carrier's own refresh button re-navigates explicitly.
      let navigated = false
      view.addEventListener('dom-ready', () => {
        if (overlayCarrier.view !== view || navigated) return
        navigated = true
        view.loadURL(overlayCarrier.url).catch(() => {})
      })
      view.addEventListener('did-stop-loading', () => {
        if (overlayCarrier.view === view) status.textContent = ''
      })
      view.addEventListener('did-fail-load', () => {
        if (overlayCarrier.view === view) status.textContent = t('viewportOverlayLoadFailed')
      })

      root.append(strip, view)
      document.body.appendChild(root)
      overlayCarrier.hostId = hostId
      overlayCarrier.lease = String(reservation.lease)
      overlayCarrier.root = root
      overlayCarrier.view = view
      overlayCarrier.url = url
      overlayCarrier.onExit = typeof options.onExit === 'function' ? options.onExit : null
      return { ok: true, reused: false }
    }

    /** Reload the live carrier in place; a no-op while it is closed. */
    function reloadOverlay() {
      const view = overlayCarrier.view
      if (view === null) return false
      try {
        view.reload()
        return true
      } catch (_error) {
        return false
      }
    }

    /** Remove the carrier, release its lease, and notify the panel. */
    async function closeOverlay() {
      const root = overlayCarrier.root
      const lease = overlayCarrier.lease
      const onExit = overlayCarrier.onExit
      overlayCarrier.root = null
      overlayCarrier.view = null
      overlayCarrier.lease = null
      overlayCarrier.url = null
      overlayCarrier.hostId = null
      overlayCarrier.onExit = null
      if (root !== null && root.parentNode !== null) root.parentNode.removeChild(root)
      const bridge = desktopBrowserBridge()
      if (bridge !== null && lease !== null) {
        try {
          await bridge.release(lease)
        } catch (_error) {
          // a lease the shell already dropped is a no-op
        }
      }
      if (typeof onExit === 'function') onExit()
    }

    //#endregion

    /**
     * The remote viewport: toolbar on top, then the iframe once the Host has
     * confirmed the connection. The iframe URL is validated loopback-only
     * before it is ever assigned (contract §3.5).
     * @param {object} props - host, iframe state, callbacks.
     * @returns {object} div element.
     */
    function RemoteViewport(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const host = props.host || null
      const status = host ? host.status : 'unconfigured'
      const iframeUrl =
        typeof props.iframeUrl === 'string' && isValidIframeUrl(props.iframeUrl) ? props.iframeUrl : null
      const invalidIframe = typeof props.iframeUrl === 'string' && props.iframeUrl.length > 0 && iframeUrl === null
      const iframeError = props.iframeError || null
      const iframeLoading = props.iframeLoading === true
      const viewerMode = props.viewerMode === 'overlay' ? 'overlay' : 'panel'

      let body
      if (host === null) {
        body = h(ErrorCard, {
          t,
          locale,
          error: localErrorView('internal'),
          onRetry: props.onRefresh,
          onBack: props.onBack,
        })
      } else if (status === 'connecting') {
        body = h(ConnectProgress, { t, host })
      } else if (status === 'fingerprint-pending') {
        body = h(FingerprintCard, {
          t,
          locale,
          host,
          busy: props.fingerprintBusy === true,
          error: props.fingerprintError,
          onAccept: props.onAcceptFingerprint,
          onReject: props.onBack,
        })
      } else if (status === 'error' || status === 'limited') {
        body = h(ErrorCard, {
          t,
          locale,
          error: host.error || localErrorView('internal'),
          onRetry: () => props.onReconnect && props.onReconnect(host),
          onDiagnose: () => props.onDiagnose && props.onDiagnose(host),
          onBack: props.onBack,
        })
      } else if (status === 'unconfigured') {
        body = h(
          'div',
          { className: 'drg-connect-prompt' },
          h('div', { className: 'drg-connect-prompt-icon', 'aria-hidden': 'true' }, h(IconWifi, { size: 28 })),
          h('h2', null, t('viewportUnconfigured')),
          h('p', null, t('viewportUnconfiguredBody')),
          h(Button, { variant: 'primary', onClick: () => props.onConnect && props.onConnect(host) }, t('cardConnect')),
        )
      } else if (invalidIframe || iframeError) {
        body = h(ErrorCard, {
          t,
          locale,
          error: iframeError || localErrorView('blocked-iframe'),
          onRetry: props.onRetryIframe,
          onDiagnose: () => props.onDiagnose && props.onDiagnose(host),
          onBack: props.onBack,
        })
      } else if (viewerMode === 'overlay') {
        body = h(OverlayViewerCard, {
          t,
          status: props.overlayStatus,
          open: props.overlayOpen === true,
          onOpen: props.onOpenOverlay,
          onClose: props.onCloseOverlay,
        })
      } else if (iframeUrl !== null) {
        body = h(
          'div',
          { className: 'drg-frame-wrap' },
          iframeLoading
            ? h(
                'div',
                { className: 'drg-frame-loading' },
                h(Spinner, { size: 20 }),
                h('span', null, t('viewportLoadingFrame')),
              )
            : null,
          h('iframe', {
            key: props.iframeKey || 0,
            className: 'drg-frame',
            'data-testid': 'remote-iframe',
            src: iframeUrl,
            sandbox: IFRAME_SANDBOX,
            title: host.name || host.id,
            referrerPolicy: 'no-referrer',
            onLoad: props.onFrameLoad,
            onError: props.onFrameError,
          }),
        )
      } else {
        body = h(
          'div',
          { className: 'drg-loading drg-loading-viewport' },
          h(Spinner, { size: 20 }),
          h('span', null, t('viewportOpening', { name: host.name || host.id })),
        )
      }

      return h(
        'div',
        { className: 'drg-viewport', 'data-status': status },
        h(ViewportToolbar, {
          t,
          host: host || {},
          hosts: props.hosts,
          addressVisible: props.addressVisible,
          onBack: props.onBack,
          onReconnect: () => props.onReconnect && props.onReconnect(host),
          onRefreshFrame: props.onRefreshFrame,
          onSwitchHost: props.onSwitchHost,
          onToggleAddress: props.onToggleAddress,
          onOpenExternal: props.onOpenExternal,
          onDiagnose: () => props.onDiagnose && props.onDiagnose(host),
        }),
        props.enterNotice === true
          ? h(
              'div',
              { className: 'drg-viewport-notice' },
              h(
                Notice,
                {
                  tone: 'info',
                  title: t('enterNoticeTitle'),
                  onDismiss: props.onDismissEnterNotice,
                  dismissLabel: t('dismiss'),
                },
                t('enterNoticeBody'),
              ),
            )
          : null,
        status === 'disconnected'
          ? h(
              'div',
              { className: 'drg-viewport-notice' },
              h(
                Notice,
                { tone: 'warn', title: t('viewportDisconnected') },
                t('viewportDisconnectedBody'),
                ' ',
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'drg-linkbtn',
                    onClick: () => props.onReconnect && props.onReconnect(host),
                  },
                  t('reconnectNow'),
                ),
              ),
            )
          : null,
        h('div', { className: 'drg-viewport-body' }, body),
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

    /** Build the `POST /hosts` body from the wizard draft (contract §1). */
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
        if (draft.authType === 'key') {
          host.auth = { type: 'key', keyPath: String(draft.keyPath || '').trim() }
        } else if (draft.authType === 'password') {
          host.auth = { type: 'password' }
        } else {
          host.auth = { type: 'agent' }
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
          authType: typeof host.authType === 'string' ? host.authType : defaults.defaultAuth || 'agent',
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
        authType: defaults.defaultAuth || 'agent',
        keyPath: '',
        keepAlive: 'keep',
        idleMinutes: 15,
        autoReconnect: auto.enabled !== false,
        hostKeyPolicy: defaults.hostKeyPolicy || 'first-use',
      }
    }

    /**
     * Three-step connect wizard (design §4.2): SSH details → connection test
     * (including host-key confirmation) → finish / open the remote entry.
     * @param {object} props - mode, host, live state, callbacks.
     * @returns {object} modal element.
     */
    function WizardDialog(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const mode = props.mode === 'edit' ? 'edit' : 'add'
      const initialHost = props.initialHost || null
      const total = 3
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
                { value: 'agent', label: t('wizard.authAgent') },
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
        Modal,
        {
          title: mode === 'edit' ? t('editHostTitle') : t('addHostTitle'),
          subtitle: t('wizard.stepLabel', { current: step, total }),
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
     * never includes a token or iframe URL.
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
     * Diagnostics drawer (design §4.4): a redacted checklist with re-run and
     * copy actions.
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

    /** Build the partial SettingsView sent by `POST /settings` (contract §1). */
    function settingsPatchFromDraft(draft) {
      return {
        defaultPort: toInt(draft.defaultPort, 22),
        defaultAuth: draft.defaultAuth === 'key' || draft.defaultAuth === 'password' ? draft.defaultAuth : 'agent',
        connectTimeoutSec: Math.max(1, toInt(draft.connectTimeoutSec, 30)),
        autoReconnect: {
          enabled: draft.autoReconnectEnabled === true,
          maxAttempts: Math.max(0, toInt(draft.maxAttempts, 3)),
          baseDelayMs: Math.max(0, toInt(draft.baseDelayMs, 1000)),
        },
        hostKeyPolicy: draft.hostKeyPolicy === 'strict' ? 'strict' : 'first-use',
        saveTokens: draft.saveTokens === true,
        mirrorToSidebar: draft.mirrorToSidebar === true,
        windowMode: normalizeWindowMode(draft.windowMode),
        language: draft.language === 'zh' || draft.language === 'en' ? draft.language : 'auto',
        logLevel: ['error', 'warn', 'info', 'debug'].indexOf(draft.logLevel) >= 0 ? draft.logLevel : 'info',
        bootstrap: {
          targetVersion: String(draft.targetVersion || 'local').trim() || 'local',
          mode: ['auto', 'reuse', 'npx', 'isolated'].indexOf(draft.bootstrapMode) >= 0 ? draft.bootstrapMode : 'auto',
          remoteDir: String(draft.remoteDir || '').trim(),
          nodeVersion: String(draft.nodeVersion || '').trim(),
        },
      }
    }

    /** @param {unknown} value @returns {'panel' | 'overlay'} */
    function normalizeWindowMode(value) {
      return value === 'overlay' ? 'overlay' : 'panel'
    }

    /** Create the editable settings draft from a SettingsView. */
    function settingsDraft(settings) {
      const view = settings && typeof settings === 'object' ? settings : {}
      const auto = view.autoReconnect && typeof view.autoReconnect === 'object' ? view.autoReconnect : {}
      const bootstrap = view.bootstrap && typeof view.bootstrap === 'object' ? view.bootstrap : {}
      return {
        windowMode: normalizeWindowMode(view.windowMode),
        defaultPort: view.defaultPort === undefined ? 22 : view.defaultPort,
        defaultAuth: view.defaultAuth || 'agent',
        connectTimeoutSec: view.connectTimeoutSec === undefined ? 30 : view.connectTimeoutSec,
        autoReconnectEnabled: auto.enabled !== false,
        maxAttempts: auto.maxAttempts === undefined ? 3 : auto.maxAttempts,
        baseDelayMs: auto.baseDelayMs === undefined ? 1000 : auto.baseDelayMs,
        hostKeyPolicy: view.hostKeyPolicy || 'first-use',
        saveTokens: view.saveTokens === true,
        // Default on: only an explicit `false` opts a user out.
        mirrorToSidebar: view.mirrorToSidebar !== false,
        language: view.language || 'auto',
        logLevel: view.logLevel || 'info',
        targetVersion: bootstrap.targetVersion || 'local',
        bootstrapMode: bootstrap.mode || 'auto',
        remoteDir: bootstrap.remoteDir || '',
        nodeVersion: bootstrap.nodeVersion || '',
      }
    }

    /**
     * Settings modal (design §4.5 / contract SettingsView).
     * @param {object} props - settings, onSave(patch), onClose.
     * @returns {object} modal element.
     */
    function SettingsModal(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const [draft, setDraft] = useState(() => settingsDraft(props.settings))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
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
            h('h3', { className: 'drg-section-title' }, t('settings.window')),
            h(
              Field,
              { label: t('settings.windowMode'), hint: t('settings.windowModeHint') },
              h(Select, {
                value: draft.windowMode,
                ariaLabel: t('settings.windowMode'),
                options: [
                  { value: 'overlay', label: t('settings.windowModeOverlay') },
                  { value: 'panel', label: t('settings.windowModePanel') },
                ],
                onChange: set('windowMode'),
              }),
            ),
            h(
              Field,
              { label: t('settings.closeBehavior'), hint: t('settings.closeBehaviorHint') },
              h(TextInput, {
                value: t('settings.closeBehaviorValue'),
                readOnly: true,
                ariaLabel: t('settings.closeBehavior'),
              }),
            ),
          ),
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
                    { value: 'agent', label: t('settings.defaultAuthAgent') },
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
            h('h3', { className: 'drg-section-title' }, t('settings.mirror')),
            h(CheckRow, {
              checked: draft.mirrorToSidebar === true,
              label: t('settings.mirrorToSidebar'),
              onChange: set('mirrorToSidebar'),
            }),
            h('p', { className: 'drg-field-hint' }, t('settings.mirrorToSidebarHint')),
          ),
          h(
            'section',
            { className: 'drg-settings-section' },
            h('h3', { className: 'drg-section-title' }, t('settings.bootstrap')),
            h(
              'div',
              { className: 'drg-form-grid drg-form-grid-3' },
              h(
                Field,
                { label: t('settings.targetVersion'), hint: t('settings.targetVersionHint') },
                h(TextInput, {
                  value: draft.targetVersion,
                  ariaLabel: t('settings.targetVersion'),
                  onChange: set('targetVersion'),
                }),
              ),
              h(
                Field,
                { label: t('settings.mode') },
                h(Select, {
                  value: draft.bootstrapMode,
                  ariaLabel: t('settings.mode'),
                  options: [
                    { value: 'auto', label: t('settings.modeAuto') },
                    { value: 'reuse', label: t('settings.modeReuse') },
                    { value: 'npx', label: t('settings.modeNpx') },
                    { value: 'isolated', label: t('settings.modeIsolated') },
                  ],
                  onChange: set('bootstrapMode'),
                }),
              ),
              h(
                Field,
                { label: t('settings.nodeVersion') },
                h(TextInput, {
                  value: draft.nodeVersion,
                  ariaLabel: t('settings.nodeVersion'),
                  onChange: set('nodeVersion'),
                }),
              ),
            ),
            h(
              Field,
              { label: t('settings.remoteDir') },
              h(TextInput, {
                value: draft.remoteDir,
                ariaLabel: t('settings.remoteDir'),
                onChange: set('remoteDir'),
              }),
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
      )
    }

    //#endregion

    //#region 13. one-time password prompt

    /**
     * One-time SSH password prompt for hosts whose `authType` is `password`.
     * The value lives in component state only and is never persisted or put in
     * a URL; cancelling sends no request.
     * @param {object} props - host, busy flag, error, submit/cancel callbacks.
     * @returns {object} modal element.
     */
    function PasswordPrompt(props) {
      const t = translatorOf(props)
      const host = props.host || {}
      const [password, setPassword] = useState('')
      const [localError, setLocalError] = useState('')
      const submit = () => {
        if (String(password).trim() === '') {
          setLocalError(t('passwordPromptRequired'))
          return
        }
        setLocalError('')
        if (typeof props.onSubmit === 'function') props.onSubmit(password)
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

    //#region 15. panel container

    /**
     * Owns the panel's live state: one initial `/state` read, then SSE with a
     * 3s polling fallback (contract §1). Disposal closes the stream and timers.
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
     * The main panel: routes between the host list and the remote viewport,
     * owns the wizard / diagnostics / settings layers, and performs every Host
     * mutation. Host status itself always comes from `/state`.
     * @param {object} props - slot props (`t`) plus injected `openPanel`/`getLocaleId`.
     * @returns {object} panel root element.
     */
    function MainPanel(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const remote = useRemoteState()
      const state = remote.state
      const [view, setView] = useState('hosts')
      const [activeHostId, setActiveHostId] = useState(null)
      const [iframeUrl, setIframeUrl] = useState(null)
      const [iframeKey, setIframeKey] = useState(0)
      const [iframeLoading, setIframeLoading] = useState(false)
      const [iframeError, setIframeError] = useState(null)
      const [addressVisible, setAddressVisible] = useState(true)
      const [busyHostId, setBusyHostId] = useState(null)
      const [wizard, setWizard] = useState(null)
      const [diagnose, setDiagnose] = useState(null)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [pendingDelete, setPendingDelete] = useState(null)
      const [deleting, setDeleting] = useState(false)
      const [passwordPrompt, setPasswordPrompt] = useState(null)
      const [fingerprintBusy, setFingerprintBusy] = useState(false)
      const [fingerprintError, setFingerprintError] = useState(null)
      const [showEnterNotice, setShowEnterNotice] = useState(false)
      const [showCloseNotice, setShowCloseNotice] = useState(false)
      const [toast, setToast] = useState(null)
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
      const activeHost = activeHostId ? hosts.find((host) => host && host.id === activeHostId) || null : null
      const activeStatus = activeHost ? activeHost.status : null
      // `windowMode: 'overlay'` hands the whole window to a live remote-DSH guest
      // (DSH desktop only); 'panel' keeps the iframe inside this panel.
      const settingsView = state && state.settings && typeof state.settings === 'object' ? state.settings : {}
      const viewerMode = normalizeWindowMode(settingsView.windowMode)
      // Mirror of the imperative full-window carrier (it lives outside React).
      const [overlayStatus, setOverlayStatus] = useState('closed')
      // The user pressed "exit": stay on the local UI, keep the connection, and do
      // not take the window back until they ask for it again.
      const overlayDismissed = useRef(false)
      const viewerModeRef = useRef(viewerMode)
      viewerModeRef.current = viewerMode

      // Restore the Host's active host once, on the first state read.
      const bootstrapped = useRef(false)
      useEffect(() => {
        if (!state || bootstrapped.current) return
        bootstrapped.current = true
        const id = state.activeHostId
        if (
          typeof id === 'string' &&
          Array.isArray(state.hosts) &&
          state.hosts.some((host) => host && host.id === id && VIEWPORT_STATUSES.indexOf(host.status) >= 0)
        ) {
          setActiveHostId(id)
          setView('viewport')
          return
        }
        // Takeover mode goes straight to the remote: with exactly one host there is
        // nothing to choose, so opening the panel is the same as opening the far side.
        const sole = Array.isArray(state.hosts) && state.hosts.length === 1 ? state.hosts[0] : null
        if (sole && viewerMode === 'overlay') {
          setActiveHostId(sole.id)
          setView('viewport')
          if (sole.status === 'connected' || sole.status === 'disconnected') {
            api.activate(sole.id).catch(() => {})
          } else if (sole.status !== 'connecting' && sole.status !== 'fingerprint-pending') {
            performConnect(sole)
          }
        }
      }, [state])

      // A host removed elsewhere closes the viewport instead of showing a blank page.
      useEffect(() => {
        if (view !== 'viewport' || !state || !activeHostId) return
        if (!Array.isArray(state.hosts) || !state.hosts.some((host) => host && host.id === activeHostId)) {
          setActiveHostId(null)
          setView('hosts')
        }
      }, [view, state, activeHostId])

      // Forget the one-time iframe URL when the host changes or re-connects.
      useEffect(() => {
        setIframeUrl(null)
        setIframeError(null)
        setIframeKey(0)
        setIframeLoading(false)
      }, [activeHostId])
      useEffect(() => {
        if (activeStatus === 'connecting') {
          setIframeUrl(null)
          setIframeError(null)
          setIframeKey(0)
        }
      }, [activeStatus])

      // Fetch `GET /hosts/:id/open` only for a connected host, and only once.
      useEffect(() => {
        if (view !== 'viewport' || activeHostId === null || activeStatus !== 'connected' || iframeUrl !== null)
          return undefined
        let cancelled = false
        setIframeLoading(true)
        setIframeError(null)
        api.openHost(activeHostId).then(
          (url) => {
            if (cancelled) return
            setIframeUrl(url)
            setIframeLoading(false)
          },
          (error) => {
            if (cancelled) return
            setIframeError(toErrorView(error))
            setIframeLoading(false)
          },
        )
        return () => {
          cancelled = true
        }
      }, [view, activeHostId, activeStatus, iframeUrl])

      // One-time "you are operating a remote server" hint per browser.
      useEffect(() => {
        if (view !== 'viewport') return
        if (readFlag(ENTER_HINT_KEY)) return
        setShowEnterNotice(true)
      }, [view])

      // The settings page asks the panel to open one host, then switches to it.
      useEffect(() => {
        const store = props.panelStore
        if (!store || typeof store.take !== 'function' || typeof store.subscribe !== 'function') return undefined
        const consume = () => {
          const requested = store.take()
          if (typeof requested !== 'string' || requested.length === 0) return
          setActiveHostId(requested)
          setView('viewport')
          openPanel()
          remote.refresh()
        }
        consume()
        return store.subscribe(consume)
      }, [props.panelStore])

      const openPanel = () => {
        if (typeof props.openPanel === 'function') {
          try {
            props.openPanel()
          } catch (_error) {
            // selecting the already-active panel is a no-op
          }
        }
      }

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

      const openHost = (host) => {
        if (!host) return
        const needsConnect = host.status === 'unconfigured' || host.status === 'disconnected' || host.status === 'error'
        if (needsConnect && host.authType === 'password') {
          setPasswordPrompt({ host, intent: 'open', error: null, busy: false })
          return
        }
        setActiveHostId(host.id)
        setView('viewport')
        openPanel()
        api.activate(host.id).catch(() => {})
        if (needsConnect) performConnect(host)
      }

      /** Submit the one-time password for the pending open/connect/reconnect. */
      const submitPassword = (password) => {
        const pending = passwordPrompt
        if (!pending || !pending.host) return
        const value = typeof password === 'string' ? password : ''
        if (value.trim() === '') {
          setPasswordPrompt({ ...pending, error: t('passwordPromptRequired') })
          return
        }
        const host = pending.host
        const intent = pending.intent
        if (intent === 'open') {
          setActiveHostId(host.id)
          setView('viewport')
          openPanel()
        }
        if (intent === 'reconnect') {
          setIframeUrl(null)
          setIframeError(null)
          setIframeLoading(true)
        }
        setPasswordPrompt({ ...pending, busy: true, error: null })
        setBusyHostId(host.id)
        const connect =
          intent === 'reconnect'
            ? api
                .disconnect(host.id, false)
                .catch(() => {})
                .then(() => api.connect(host.id, { password: value }))
            : api.connect(host.id, { password: value })
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
      const cancelPassword = () => setPasswordPrompt(null)

      const disconnectHost = (host) => {
        if (!host) return
        setBusyHostId(host.id)
        api
          .disconnect(host.id, false)
          .then(
            () => remote.refresh(),
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
        setIframeUrl(null)
        setIframeError(null)
        setIframeLoading(true)
        setBusyHostId(host.id)
        api
          .reconnect(host.id)
          .then(
            () => remote.refresh(),
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setBusyHostId(null))
      }

      const backToHosts = () => {
        setView('hosts')
        if (!readFlag(CLOSE_HINT_KEY)) {
          setShowCloseNotice(true)
          writeFlag(CLOSE_HINT_KEY)
        }
      }
      const dismissCloseNotice = () => {
        writeFlag(CLOSE_HINT_KEY)
        setShowCloseNotice(false)
      }
      const dismissEnterNotice = () => {
        writeFlag(ENTER_HINT_KEY)
        setShowEnterNotice(false)
      }

      const switchHost = (hostId) => {
        setActiveHostId(hostId)
        setView('viewport')
      }
      const toggleAddress = () => setAddressVisible((visible) => !visible)
      /** Start the carrier, or — when it is already up — reload it in place. */
      const takeOverOverlay = () => {
        if (iframeUrl === null) return
        if (overlayDismissed.current === false && reloadOverlay()) {
          setOverlayStatus('open')
          return
        }
        overlayDismissed.current = false
        setOverlayStatus('opening')
        openOverlay({
          hostId: activeHostId || '',
          name: activeHost ? activeHost.name || '' : '',
          url: iframeUrl,
          t,
          onExit: () => setOverlayStatus('closed'),
        }).then((result) => {
          setOverlayStatus(result.ok ? 'open' : result.reason || 'failed')
        })
      }
      const releaseOverlay = () => {
        // Leaving the carrier is a view change, not a disconnect: the SSH link,
        // the tunnel and the remote DSH all stay up.
        overlayDismissed.current = true
        setOverlayStatus('closing')
        closeOverlay().catch(() => {})
        setOverlayStatus('closed')
        setView('viewport')
      }
      const refreshFrame = () => {
        if (viewerMode === 'overlay') {
          if (!reloadOverlay()) takeOverOverlay()
          return
        }
        setIframeKey((key) => key + 1)
        setIframeLoading(true)
      }
      const retryIframe = () => {
        setIframeError(null)
        setIframeUrl(null)
      }
      const openExternal = () => {
        const openWith = (url) => {
          if (!isValidIframeUrl(url)) {
            notify(t('viewportFrameBlocked'), 'error')
            return
          }
          if (typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(url, '_blank', 'noopener,noreferrer')
          }
        }
        if (iframeUrl !== null) {
          openWith(iframeUrl)
          return
        }
        if (!activeHost) return
        api.openHost(activeHost.id).then(openWith, (error) => notify(errorMessage(error), 'error'))
      }

      // Full-window takeover: create the carrier once a loopback URL exists, and
      // drop it on a host switch or when the panel goes away. The carrier itself
      // survives panel switches (it lives on document.body), which is the point
      // of the mode: the window belongs to the remote host until the user exits.
      useEffect(() => {
        if (viewerMode !== 'overlay' || overlayDismissed.current) return
        if (view !== 'viewport' || activeStatus !== 'connected' || iframeUrl === null) return
        let cancelled = false
        openOverlay({
          hostId: activeHostId || '',
          name: activeHost ? activeHost.name || '' : '',
          url: iframeUrl,
          t,
          onExit: () => setOverlayStatus('closed'),
        }).then((result) => {
          if (!cancelled) setOverlayStatus(result.ok ? 'open' : result.reason || 'failed')
        })
        return () => {
          cancelled = true
        }
      }, [viewerMode, view, activeStatus, iframeUrl, activeHostId])

      useEffect(() => {
        return () => {
          if (viewerModeRef.current === 'overlay') closeOverlay().catch(() => {})
          overlayDismissed.current = false
        }
      }, [activeHostId])

      const acceptFingerprint = (remember) => {
        if (!activeHost) return
        const sha256 =
          activeHost.fingerprint && typeof activeHost.fingerprint.sha256 === 'string'
            ? activeHost.fingerprint.sha256
            : ''
        setFingerprintBusy(true)
        setFingerprintError(null)
        api
          .acceptFingerprint(activeHost.id, true, remember === true, sha256)
          .then(
            () => remote.refresh(),
            (error) => setFingerprintError(toErrorView(error)),
          )
          .finally(() => setFingerprintBusy(false))
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
        api
          .deleteHost(pendingDelete.id)
          .then(
            () => {
              setPendingDelete(null)
              if (activeHostId === pendingDelete.id) {
                setActiveHostId(null)
                setView('hosts')
              }
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

      const openRemoteFromWizard = (hostId) => {
        setWizard(null)
        setActiveHostId(hostId)
        setView('viewport')
        openPanel()
        api.activate(hostId).catch(() => {})
        remote.refresh()
      }
      const closeWizard = () => {
        setWizard(null)
        remote.refresh()
      }

      const content =
        view === 'viewport'
          ? h(RemoteViewport, {
              t,
              locale,
              host: activeHost,
              hosts,
              iframeUrl,
              iframeKey,
              iframeLoading,
              iframeError,
              viewerMode,
              overlayStatus,
              overlayOpen: overlayStatus === 'open',
              addressVisible,
              enterNotice: showEnterNotice,
              fingerprintBusy,
              fingerprintError,
              onBack: backToHosts,
              onReconnect: reconnectHost,
              onRefreshFrame: refreshFrame,
              onRetryIframe: retryIframe,
              onSwitchHost: switchHost,
              onToggleAddress: toggleAddress,
              onOpenExternal: openExternal,
              onOpenOverlay: takeOverOverlay,
              onCloseOverlay: releaseOverlay,
              onDiagnose: runDiagnose,
              onAcceptFingerprint: acceptFingerprint,
              onConnect: (host) => {
                if (host) connectHost(host)
              },
              onRefresh: remote.refresh,
              onFrameLoad: () => setIframeLoading(false),
              onFrameError: () => setIframeLoading(false),
              onDismissEnterNotice: dismissEnterNotice,
            })
          : h(HostListView, {
              t,
              locale,
              state,
              loading: remote.loading,
              error: remote.error,
              busyHostId,
              closeNotice: showCloseNotice,
              onDismissCloseNotice: dismissCloseNotice,
              onAdd: () => setWizard({ mode: 'add', host: null }),
              onRefresh: remote.refresh,
              onOpenSettings: () => setSettingsOpen(true),
              onOpenHost: openHost,
              onConnectHost: connectHost,
              onDisconnectHost: disconnectHost,
              onReconnectHost: reconnectHost,
              onEditHost: (host) => setWizard({ mode: 'edit', host }),
              onDeleteHost: (host) => setPendingDelete(host),
              onDiagnoseHost: runDiagnose,
            })

      return h(
        'div',
        { className: 'drg-root', 'data-testid': 'dsh-remote-go-panel' },
        h(StyleSheet),
        h(
          'div',
          { className: 'drg-panel-layout' },
          h(WorkspaceRail, {
            t,
            locale,
            localeId: locale,
            hosts,
            activeHostId,
            onOpenHost: openHost,
            onConnectHost: connectHost,
            onDiagnoseHost: runDiagnose,
            onOpenLocalWorkspace: (workspaceId) => {
              if (typeof props.openLocalWorkspace === 'function') {
                try {
                  props.openLocalWorkspace(workspaceId)
                } catch (_error) {
                  // switching local workspaces is optional; the panel still closes
                }
              }
            },
          }),
          h('div', { className: 'drg-panel-main' }, content),
        ),
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
              onOpenRemote: openRemoteFromWizard,
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
        passwordPrompt
          ? h(PasswordPrompt, {
              key: passwordPrompt.host && passwordPrompt.host.id ? passwordPrompt.host.id : 'password',
              t,
              locale,
              host: passwordPrompt.host,
              busy: passwordPrompt.busy === true,
              error: passwordPrompt.error,
              onSubmit: submitPassword,
              onCancel: cancelPassword,
            })
          : null,
        h(Toast, { toast }),
      )
    }

    //#region 16. workspace rail and settings section

    /** Local workspace payload used before the first `/local/workspaces` read. */
    const EMPTY_LOCAL_WORKSPACES = {
      status: 'loading',
      workspaces: [],
      defaultWorkspaceId: null,
      error: null,
    }

    /**
     * Mirror-list polling policy.
     *
     * Replay settles asynchronously *after* the panel mounts, and the slot props
     * carry no mirror/sync progress signal (`HostView` has host status only), so
     * the list is polled **until it settles** rather than a fixed number of times:
     * a fixed attempt budget silently missed the badge whenever replay outran it.
     *
     * - `settled()` says when to stop: a read-only mirror exists, or descriptors
     *   exist and none is planned at L2 (nothing left to replay). An empty list is
     *   not settled — the descriptors may not have been written yet.
     * - The deadline bounds the whole loop, so a host that never replays stops
     *   polling (and simply shows no badge) instead of spinning forever.
     */
    const MIRROR_POLL_INTERVAL_MS = 1000
    const MIRROR_POLL_DEADLINE_MS = 45_000

    /**
     * @param {readonly any[] | null | undefined} mirrors - `/hosts/:id/mirrors` rows.
     * @returns {boolean} whether polling can stop.
     */
    function mirrorsSettled(mirrors) {
      if (!Array.isArray(mirrors) || mirrors.length === 0) return false
      if (mirrors.some((mirror) => mirror && mirror.readOnly === true)) return true
      // Nothing planned at L2: replay is not in flight for this host.
      return !mirrors.some((mirror) => mirror && mirror.level === 'L2')
    }

    /**
     * Workspace data for the rail: the local DSH registry plus one workspace
     * list per configured host. Refreshes on mount, whenever host ids/statuses
     * change (SSE `/state` pushes), and on demand from the refresh button.
     * @param {object[]} hosts - HostView list.
     * @param {{local?: object, remotes?: object}|undefined} initialData - test/preview seam.
     * @returns {{local: object, remotes: object, refresh: Function}} workspace data handle.
     */
    function useWorkspaceData(hosts, initialData) {
      const [local, setLocal] = useState(() =>
        initialData && initialData.local ? initialData.local : { ...EMPTY_LOCAL_WORKSPACES },
      )
      const [remotes, setRemotes] = useState(() => (initialData && initialData.remotes ? initialData.remotes : {}))
      const generation = useRef(0)
      const alive = useRef(true)
      const hostsRef = useRef(hosts)
      hostsRef.current = hosts

      useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )

      const refresh = useCallback(() => {
        const token = ++generation.current
        const list = Array.isArray(hostsRef.current) ? hostsRef.current : []
        setLocal((current) => ({ ...current, status: 'loading', error: null }))
        api.getLocalWorkspaces().then(
          (payload) => {
            if (!alive.current || token !== generation.current) return
            setLocal({
              status: 'ready',
              workspaces: payload.workspaces,
              defaultWorkspaceId: payload.defaultWorkspaceId,
              error: null,
            })
          },
          (error) => {
            if (!alive.current || token !== generation.current) return
            setLocal((current) => ({ ...current, status: 'error', error: toErrorView(error) }))
          },
        )
        const nextRemotes = {}
        for (const host of list) {
          if (!host || !host.id) continue
          nextRemotes[host.id] = {
            status: host.status === 'connected' ? 'loading' : 'disconnected',
            connected: host.status === 'connected',
            workspaces: [],
            mirrors: [],
            error: null,
            hostName: host.name || host.id,
          }
        }
        setRemotes(nextRemotes)
        for (const host of list) {
          if (!host || !host.id || host.status !== 'connected') continue
          api.getHostWorkspaces(host.id).then(
            (payload) => {
              if (!alive.current || token !== generation.current) return
              setRemotes((current) => ({
                ...current,
                [host.id]: {
                  ...(current[host.id] || {}),
                  status: 'ready',
                  connected: payload.connected,
                  workspaces: payload.workspaces,
                  error: null,
                  hostName: payload.hostName || host.name || host.id,
                },
              }))
            },
            (error) => {
              if (!alive.current || token !== generation.current) return
              setRemotes((current) => ({
                ...current,
                [host.id]: {
                  ...(current[host.id] || {}),
                  status: 'error',
                  connected: true,
                  workspaces: [],
                  error: toErrorView(error),
                  hostName: host.name || host.id,
                },
              }))
            },
          )
          // Read-only markers come from the mirror list the Host already exposes.
          // Poll until the list settles (see `mirrorsSettled`) with a hard deadline:
          // a fixed attempt budget missed the badge whenever replay was slower than
          // it, and polling forever would leak requests on a host that never
          // replays. A failed read clears the list, so no stale badge survives.
          const loadMirrors = () => {
            const startedAt = Date.now()
            const step = () => {
              api.getHostMirrors(host.id).then(
                (payload) => {
                  if (!alive.current || token !== generation.current) return
                  setRemotes((current) => ({
                    ...current,
                    [host.id]: { ...(current[host.id] || {}), mirrors: payload.mirrors },
                  }))
                  if (mirrorsSettled(payload.mirrors)) return
                  if (Date.now() - startedAt >= MIRROR_POLL_DEADLINE_MS) return
                  setTimeout(() => {
                    if (!alive.current || token !== generation.current) return
                    step()
                  }, MIRROR_POLL_INTERVAL_MS)
                },
                () => {
                  // Never keep a stale list: an unreadable mirror list shows no badge.
                  if (!alive.current || token !== generation.current) return
                  setRemotes((current) => ({
                    ...current,
                    [host.id]: { ...(current[host.id] || {}), mirrors: [] },
                  }))
                },
              )
            }
            step()
          }
          loadMirrors()
        }
      }, [])

      const signature = (Array.isArray(hosts) ? hosts : [])
        .map((host) => (host && host.id ? host.id : '') + ':' + (host && host.status ? host.status : ''))
        .join('|')
      useEffect(() => {
        refresh()
      }, [signature, refresh])

      return { local, remotes, refresh }
    }

    /**
     * Left rail of the remote panel: local workspaces on top, then one group
     * per configured host. The rail is the panel's own surface; the app's
     * `sidebar.workspaces` slot stays untouched (contract §1 note).
     * @param {object} props - hosts, activeHostId, callbacks, test seams.
     * @returns {object} aside element.
     */
    function WorkspaceRail(props) {
      const t = translatorOf(props)
      const hosts = Array.isArray(props.hosts) ? props.hosts : []
      const [collapsed, setCollapsed] = useState(() =>
        props.initialCollapsed === undefined ? readRailCollapsed() : props.initialCollapsed === true,
      )
      const data = useWorkspaceData(hosts, props.initialWorkspaceData)
      const toggle = () => {
        const next = !collapsed
        setCollapsed(next)
        writeRailCollapsed(next)
      }
      const refresh = () => data.refresh()
      const workspaceTitle = (workspace) =>
        typeof workspace.title === 'string' && workspace.title.length > 0
          ? workspace.title
          : typeof workspace.path === 'string' && workspace.path.length > 0
            ? workspace.path
            : String(workspace.id || '')
      const sessionsLabel = (workspace) =>
        t('workspaceRailSessions', { count: typeof workspace.sessionCount === 'number' ? workspace.sessionCount : 0 })
      /** Read-only mirrors of one remote workspace (empty for local rows). */
      const readOnlyMirrors = (workspace, kind, host) => {
        if (kind !== 'remote' || !host) return []
        const info = data.remotes[host.id]
        const mirrors = Array.isArray(info && info.mirrors) ? info.mirrors : []
        return mirrors.filter((mirror) => mirror && mirror.readOnly === true && mirror.workspaceId === workspace.id)
      }
      /**
       * Visible read-only marker (design §10 P1): the rail row covering a
       * replayed remote session says so, with the level and reason in its tooltip.
       * Returns `null` when no mirror of the row is read-only, so a host whose
       * history is unavailable never gets a misleading badge.
       */
      const readOnlyBadge = (workspace, kind, host) => {
        const mirrors = readOnlyMirrors(workspace, kind, host)
        if (mirrors.length === 0) return null
        const first = mirrors[0]
        const level = typeof first.level === 'string' ? first.level : ''
        // `locale` is derived here rather than read from `props` directly: the rail's own
        // `locale` binding was dropped as an unused local (it only served this badge), so
        // resolving it at the point of use keeps the badge working without reintroducing a
        // binding that only one call site needs.
        const reason = resolveText(first.reason && first.reason.message, localeOf(props))
        return h(
          Badge,
          {
            tone: 'idle',
            testId: 'mirror-readonly-badge',
            title: t('mirrorReadOnlyTitle', { level, reason: reason || t('mirrorReadOnlyReasonDefault') }),
          },
          t('mirrorReadOnlyBadge'),
        )
      }
      const workspaceRow = (workspace, kind, host) =>
        h(
          'button',
          {
            key: (host ? host.id + ':' : '') + String(workspace.id || workspaceTitle(workspace)),
            type: 'button',
            className: 'drg-rail-item',
            'data-testid': kind === 'local' ? 'workspace-local-item' : 'workspace-remote-item',
            'data-workspace-id': workspace.id,
            'data-host-id': host ? host.id : undefined,
            title: workspace.path || workspaceTitle(workspace),
            onClick: () => {
              if (kind === 'local') {
                if (typeof props.onOpenLocalWorkspace === 'function') props.onOpenLocalWorkspace(workspace.id)
              } else if (typeof props.onOpenHost === 'function') {
                props.onOpenHost(host)
              }
            },
          },
          h('span', { className: 'drg-rail-item-icon', 'aria-hidden': 'true' }, h(IconFolder, { size: 14 })),
          h('span', { className: 'drg-rail-item-title' }, workspaceTitle(workspace)),
          workspace.isDefault === true ? h(Badge, { tone: 'idle' }, t('workspaceDefault')) : null,
          readOnlyBadge(workspace, kind, host),
          h('span', { className: 'drg-rail-item-meta' }, sessionsLabel(workspace)),
        )

      const retryButton = h('button', { type: 'button', className: 'drg-linkbtn', onClick: refresh }, t('retry'))

      let localGroup
      if (data.local.status === 'loading') {
        localGroup = h(
          'div',
          { className: 'drg-rail-muted' },
          h(Spinner, { size: 12 }),
          h('span', null, t('workspaceRailLoading')),
        )
      } else if (data.local.status === 'error') {
        localGroup = h(
          'div',
          { className: 'drg-rail-error', 'data-testid': 'workspace-rail-error' },
          h('span', null, t('workspaceRailLocalError')),
          retryButton,
        )
      } else if (data.local.workspaces.length === 0) {
        localGroup = h('div', { className: 'drg-rail-muted' }, t('workspaceLocalEmpty'))
      } else {
        localGroup = h(
          'div',
          { className: 'drg-rail-items' },
          data.local.workspaces.map((workspace) => workspaceRow(workspace, 'local', null)),
        )
      }

      const renderRemoteGroup = (host) => {
        const info = data.remotes[host.id] || {
          status: host.status === 'connected' ? 'loading' : 'disconnected',
          workspaces: [],
          error: null,
        }
        let body
        if (host.status !== 'connected') {
          body = h(
            'div',
            { className: 'drg-rail-muted drg-rail-row' },
            h('span', null, host.status === 'connecting' ? t('progress.default') : t('workspaceRailDisconnected')),
            host.status === 'connecting'
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'drg-linkbtn',
                    'data-testid': 'workspace-remote-connect',
                    onClick: () => {
                      if (typeof props.onConnectHost === 'function') props.onConnectHost(host)
                    },
                  },
                  t('cardConnect'),
                ),
          )
        } else if (info.status === 'loading') {
          body = h(
            'div',
            { className: 'drg-rail-muted' },
            h(Spinner, { size: 12 }),
            h('span', null, t('workspaceRailLoading')),
          )
        } else if (info.status === 'error') {
          body = h(
            'div',
            { className: 'drg-rail-error', 'data-testid': 'workspace-rail-error' },
            h('span', null, t('workspaceRailRemoteError')),
            h(
              'button',
              {
                type: 'button',
                className: 'drg-linkbtn',
                onClick: () => {
                  if (typeof props.onDiagnoseHost === 'function') props.onDiagnoseHost(host)
                },
              },
              t('diagnose'),
            ),
          )
        } else if (Array.isArray(info.workspaces) && info.workspaces.length === 0) {
          body = h('div', { className: 'drg-rail-muted' }, t('workspaceRemoteEmpty'))
        } else {
          body = h(
            'div',
            { className: 'drg-rail-items' },
            info.workspaces.map((workspace) => workspaceRow(workspace, 'remote', host)),
          )
        }
        return h(
          'div',
          {
            key: host.id,
            className: 'drg-rail-group',
            'data-testid': 'workspace-remote-group',
            'data-host-id': host.id,
            'data-status': host.status,
          },
          h(
            'div',
            { className: 'drg-rail-group-head' },
            h(StatusDot, { status: host.status, title: t(statusMeta(host.status || 'unconfigured').labelKey) }),
            h('span', { className: 'drg-rail-group-title', title: host.name }, host.name || host.id),
            h('span', { className: 'drg-rail-group-icon', 'aria-hidden': 'true' }, h(RemoteIcon, { size: 12 })),
          ),
          body,
        )
      }

      return h(
        'aside',
        {
          className: 'drg-rail',
          'data-collapsed': collapsed ? 'true' : 'false',
          'data-testid': 'workspace-rail',
          'aria-label': t('workspaceRailTitle'),
        },
        h(
          'div',
          { className: 'drg-rail-head' },
          collapsed ? null : h('span', { className: 'drg-rail-title' }, t('workspaceRailTitle')),
          h(IconButton, {
            icon: collapsed ? h(IconChevronRight) : h(IconChevronLeft),
            label: collapsed ? t('workspaceRailToggleExpand') : t('workspaceRailToggleCollapse'),
            testId: 'workspace-rail-toggle',
            onClick: toggle,
          }),
          collapsed
            ? null
            : h(IconButton, {
                icon: h(IconRefresh),
                label: t('workspaceRailRefresh'),
                testId: 'workspace-rail-refresh',
                onClick: refresh,
              }),
        ),
        collapsed
          ? null
          : h(
              'div',
              { className: 'drg-rail-body' },
              h(
                'div',
                { className: 'drg-rail-group', 'data-testid': 'workspace-local-group' },
                h(
                  'div',
                  { className: 'drg-rail-group-head' },
                  h('span', { className: 'drg-rail-group-icon', 'aria-hidden': 'true' }, h(IconFolder, { size: 12 })),
                  h('span', { className: 'drg-rail-group-title' }, t('workspaceLocalGroup')),
                  h('span', { className: 'drg-rail-group-count' }, String(data.local.workspaces.length)),
                ),
                localGroup,
              ),
              hosts.length === 0
                ? h(
                    'div',
                    { className: 'drg-rail-empty', 'data-testid': 'workspace-rail-empty' },
                    h(RemoteIcon, { size: 20 }),
                    h('p', null, t('workspaceRailEmpty')),
                  )
                : hosts.map(renderRemoteGroup),
              h('p', { className: 'drg-rail-hint' }, t('workspaceRailHint')),
            ),
      )
    }

    /**
     * The Settings → "Remote hosts" section: full host management (list, add,
     * connect/disconnect, edit, delete, diagnostics, open remote UI) plus the
     * plugin settings modal. Data comes from the same `/state` stream.
     * @param {object} props - injected openPanel/panelStore/getLocaleId, slot `t`.
     * @returns {object} section element.
     */
    function SettingsSection(props) {
      const t = translatorOf(props)
      const locale = localeOf(props)
      const remote = useRemoteState(props.initialState)
      const state = remote.state
      const [wizard, setWizard] = useState(null)
      const [diagnose, setDiagnose] = useState(null)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [pendingDelete, setPendingDelete] = useState(null)
      const [deleting, setDeleting] = useState(false)
      const [busyHostId, setBusyHostId] = useState(null)
      const [passwordPrompt, setPasswordPrompt] = useState(null)
      const [toast, setToast] = useState(null)
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
        const view = toErrorView(error)
        const title = resolveText(view.title, locale)
        const detail = resolveText(view.detail, locale)
        return detail ? title + ' ' + detail : title
      }

      const openPanel = () => {
        if (typeof props.openPanel === 'function') {
          try {
            props.openPanel()
          } catch (_error) {
            // selecting the already-active panel is a no-op
          }
        }
      }
      const requestPanelHost = (hostId) => {
        api.activate(hostId).catch(() => {})
        if (props.panelStore && typeof props.panelStore.request === 'function') props.panelStore.request(hostId)
        openPanel()
        // The settings.section slot hands us the shell's `close` callback; close the
        // settings dialog so the remote panel is not left behind it.
        if (typeof props.close === 'function') {
          try {
            props.close()
          } catch (_error) {
            /* already closed */
          }
        }
        remote.refresh()
      }

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
              setPasswordPrompt(null)
              notify(errorMessage(error), 'error')
            },
          )
          .finally(() => setBusyHostId(null))
      }
      const connectHost = (host, options) => {
        if (!host || !host.id) return
        const opts = options || {}
        if (host.authType === 'password' && typeof opts.password !== 'string') {
          setPasswordPrompt({ host, intent: 'connect', error: null, busy: false })
          return
        }
        performConnect(host, opts.password)
      }
      const submitPassword = (password) => {
        const pending = passwordPrompt
        if (!pending || !pending.host) return
        const value = typeof password === 'string' ? password : ''
        if (value.trim() === '') {
          setPasswordPrompt({ ...pending, error: t('passwordPromptRequired') })
          return
        }
        const host = pending.host
        setPasswordPrompt({ ...pending, busy: true, error: null })
        setBusyHostId(host.id)
        const connect =
          pending.intent === 'reconnect'
            ? api
                .disconnect(host.id, false)
                .catch(() => {})
                .then(() => api.connect(host.id, { password: value }))
            : api.connect(host.id, { password: value })
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
      const cancelPassword = () => setPasswordPrompt(null)

      const disconnectHost = (host) => {
        if (!host) return
        setBusyHostId(host.id)
        api
          .disconnect(host.id, false)
          .then(
            () => remote.refresh(),
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
        setBusyHostId(host.id)
        api
          .reconnect(host.id)
          .then(
            () => remote.refresh(),
            (error) => notify(errorMessage(error), 'error'),
          )
          .finally(() => setBusyHostId(null))
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
        api
          .deleteHost(pendingDelete.id)
          .then(
            () => {
              setPendingDelete(null)
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
      const openRemoteFromWizard = (hostId) => {
        setWizard(null)
        requestPanelHost(hostId)
      }
      const closeWizard = () => {
        setWizard(null)
        remote.refresh()
      }
      const openRemoteHost = (host) => {
        if (!host) return
        if (host.status !== 'connected') {
          connectHost(host)
          return
        }
        requestPanelHost(host.id)
      }

      return h(
        'div',
        { className: 'drg-root drg-settings-remote', 'data-testid': 'settings-remote-section' },
        h(StyleSheet),
        h(HostListView, {
          t,
          locale,
          variant: 'settings',
          state,
          loading: remote.loading,
          error: remote.error,
          busyHostId,
          onAdd: () => setWizard({ mode: 'add', host: null }),
          onRefresh: remote.refresh,
          onOpenSettings: () => setSettingsOpen(true),
          onOpenHost: openRemoteHost,
          onConnectHost: connectHost,
          onDisconnectHost: disconnectHost,
          onReconnectHost: reconnectHost,
          onEditHost: (host) => setWizard({ mode: 'edit', host }),
          onDeleteHost: (host) => setPendingDelete(host),
          onDiagnoseHost: runDiagnose,
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
              onOpenRemote: openRemoteFromWizard,
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
        passwordPrompt
          ? h(PasswordPrompt, {
              key: passwordPrompt.host && passwordPrompt.host.id ? passwordPrompt.host.id : 'password',
              t,
              locale,
              host: passwordPrompt.host,
              busy: passwordPrompt.busy === true,
              error: passwordPrompt.error,
              onSubmit: submitPassword,
              onCancel: cancelPassword,
            })
          : null,
        h(Toast, { toast }),
      )
    }

    //#endregion

    //#region 17. styles

    /**
     * Panel styles. Everything inherits from the DSH theme: labels use
     * `currentColor`, surfaces/borders use `var(--dsw-alias-*, fallback)`.
     * System colors (`Canvas`, `CanvasText`) keep the fallback neutral in
     * either theme when a token is absent.
     */
    const CSS = `
.drg-root {
  --drg-gap: 12px;
  --drg-radius: var(--dsw-radius-lg, 10px);
  --drg-radius-sm: var(--dsw-radius-md, 8px);
  --drg-surface: var(--dsw-alias-bg-layer-1, Canvas);
  --drg-surface-2: var(--dsw-alias-bg-layer-2, color-mix(in srgb, CanvasText 5%, Canvas));
  --drg-border: var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 18%, transparent));
  --drg-border-soft: var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 12%, transparent));
  --drg-label: var(--dsw-alias-label-primary, CanvasText);
  --drg-label-2: var(--dsw-alias-label-secondary, color-mix(in srgb, CanvasText 72%, transparent));
  --drg-label-3: var(--dsw-alias-label-tertiary, color-mix(in srgb, CanvasText 55%, transparent));
  --drg-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, CanvasText 8%, transparent));
  --drg-active: var(--dsw-alias-interactive-bg-active, color-mix(in srgb, CanvasText 12%, transparent));
  --drg-primary: var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #2f6fed));
  --drg-on-primary: var(--dsw-alias-label-primary-inverted, #fff);
  --drg-danger: var(--dsw-alias-state-error-primary, #d64545);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--drg-label);
  background: var(--dsw-alias-bg-base, transparent);
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  box-sizing: border-box;
}
.drg-root *, .drg-root *::before, .drg-root *::after { box-sizing: border-box; }
.drg-root h1, .drg-root h2, .drg-root h3, .drg-root p, .drg-root ul, .drg-root ol, .drg-root dl, .drg-root dd, .drg-root dt { margin: 0; }
.drg-root ul, .drg-root ol { padding: 0; list-style: none; }
.drg-root code { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.drg-root button { font: inherit; color: inherit; }
.drg-break { word-break: break-all; }

.drg-page { display: flex; flex-direction: column; gap: var(--drg-gap); padding: 20px 24px; min-height: 0; overflow: auto; flex: 1; }
.drg-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.drg-page-heading { min-width: 0; }
.drg-page-title { font-size: 20px; font-weight: 600; letter-spacing: 0.01em; }
.drg-page-subtitle { color: var(--drg-label-2); font-size: 13px; margin-top: 2px; }
.drg-page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.drg-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
.drg-row-wrap { flex-wrap: wrap; }
.drg-row-end { justify-content: flex-end; }
.drg-row-spread { justify-content: space-between; width: 100%; }
.drg-paragraph { color: var(--drg-label-2); }

.drg-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: var(--drg-radius-sm); border: 1px solid transparent; cursor: pointer; background: transparent; color: inherit; transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease; white-space: nowrap; }
.drg-btn:disabled { cursor: default; opacity: 0.55; }
.drg-btn-primary { background: var(--drg-primary); border-color: transparent; font-weight: 500; }
/* Two classes plus the label span: the app ships its own element-level button colour rule, so a
   single-class declaration loses the cascade and the label renders in the same colour as the
   fill (invisible text on the primary button). */
.drg-btn.drg-btn-primary,
.drg-btn.drg-btn-primary .drg-btn-label { color: var(--drg-on-primary); }
.drg-btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
.drg-btn-secondary { border-color: var(--drg-border); background: var(--drg-surface); }
.drg-btn-secondary:hover:not(:disabled) { background: var(--drg-hover); }
.drg-btn-ghost { color: var(--drg-label-2); border-color: transparent; }
.drg-btn-ghost:hover:not(:disabled) { background: var(--drg-hover); color: var(--drg-label); }
.drg-btn-danger { color: var(--drg-danger); border-color: var(--drg-border); background: transparent; }
.drg-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, #d64545 14%, transparent)); }
.drg-btn[data-busy="true"] { cursor: progress; }
.drg-btn-label { display: inline-flex; align-items: center; gap: 6px; }
.drg-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: none; border-radius: var(--drg-radius-sm); background: transparent; color: var(--drg-label-2); cursor: pointer; }
.drg-iconbtn:hover:not(:disabled) { background: var(--drg-hover); color: var(--drg-label); }
.drg-iconbtn:disabled { opacity: 0.5; cursor: default; }
.drg-linkbtn { border: none; background: none; padding: 0 2px; color: var(--dsw-alias-link, var(--drg-primary)); cursor: pointer; font-size: 13px; }
.drg-linkbtn:hover { text-decoration: underline; }

.drg-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 8%, transparent); }
.drg-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--drg-label-2); background: var(--drg-surface-2); border: 1px solid var(--drg-border-soft); }
.drg-badge[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #22a06b); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22a06b) 35%, transparent); }
.drg-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #a97400)); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9a400) 35%, transparent); }
.drg-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d64545); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 35%, transparent); }
.drg-badge[data-tone="limited"] { color: #8a63d2; border-color: color-mix(in srgb, #8a63d2 35%, transparent); }
.drg-badge[data-tone="info"] { color: var(--dsw-alias-state-business-primary, #3b82f6); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 35%, transparent); }

.drg-spinner { display: inline-block; flex: none; border-radius: 50%; border: 2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color: currentColor; animation: drg-spin 0.8s linear infinite; }
@keyframes drg-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .drg-spinner { animation-duration: 2.4s; } }

.drg-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 40px 16px; color: var(--drg-label-2); }
.drg-loading-viewport { flex: 1; }

.drg-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 64px 24px; text-align: center; border: 1px dashed var(--drg-border); border-radius: var(--drg-radius); }
.drg-empty-icon { color: var(--drg-label-3); }
.drg-empty-title { font-size: 17px; font-weight: 600; }
.drg-empty-body { color: var(--drg-label-2); max-width: 440px; }

.drg-summary { display: flex; align-items: center; gap: 8px; color: var(--drg-label-2); font-size: 13px; }
.drg-summary-note { margin-left: auto; font-size: 11px; color: var(--drg-label-3); font-family: var(--ds-font-family-code, monospace); }
.drg-host-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.drg-host-card { display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--drg-border); border-radius: var(--drg-radius); background: var(--drg-surface); min-width: 0; }
.drg-card-strip { display: flex; align-items: center; gap: 6px; margin: -14px -14px 0; padding: 6px 12px; color: var(--dsw-alias-state-error-primary, #d64545); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 10%, transparent); border-radius: var(--drg-radius) var(--drg-radius) 0 0; font-size: 12px; }
.drg-card-strip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drg-card-strip .drg-linkbtn { margin-left: auto; color: inherit; flex: none; }
.drg-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.drg-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; }
.drg-card-address { font-family: var(--ds-font-family-code, monospace); font-size: 12px; color: var(--drg-label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drg-card-meta { display: flex; gap: 24px; font-size: 12px; }
.drg-card-meta dt { color: var(--drg-label-3); }
.drg-card-meta dd { color: var(--drg-label-2); }
.drg-card-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.drg-card-actions-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }

.drg-notice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--drg-border); border-radius: var(--drg-radius-sm); background: var(--drg-surface-2); }
.drg-notice-icon { flex: none; margin-top: 1px; color: var(--drg-label-2); }
.drg-notice-body { flex: 1; min-width: 0; }
.drg-notice-title { font-weight: 600; }
.drg-notice-text { color: var(--drg-label-2); font-size: 13px; }
.drg-notice-dismiss { flex: none; border: none; background: transparent; color: var(--drg-label-3); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; }
.drg-notice[data-tone="warn"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9a400) 45%, var(--drg-border)); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9a400) 9%, var(--drg-surface)); }
.drg-notice[data-tone="warn"] .drg-notice-icon { color: var(--dsw-alias-state-warn-primary, #d9a400); }
.drg-notice[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 45%, var(--drg-border)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 8%, var(--drg-surface)); }
.drg-notice[data-tone="error"] .drg-notice-icon { color: var(--dsw-alias-state-error-primary, #d64545); }
.drg-notice[data-tone="success"] .drg-notice-icon { color: var(--dsw-alias-state-success-primary, #22a06b); }

.drg-toolbar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--drg-border); background: var(--drg-surface); flex-wrap: wrap; }
.drg-toolbar-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.drg-toolbar-host { font-weight: 600; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drg-toolbar-status { color: var(--drg-label-2); font-size: 12px; }
.drg-toolbar-status[data-status="error"] { color: var(--dsw-alias-state-error-primary, #d64545); }
.drg-toolbar-status[data-status="disconnected"], .drg-toolbar-status[data-status="fingerprint-pending"] { color: var(--dsw-alias-state-warn-primary, #a97400); }
.drg-toolbar-status[data-status="connected"] { color: var(--dsw-alias-state-success-primary, #22a06b); }
.drg-toolbar-center { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; }
.drg-toolbar-address { font-family: var(--ds-font-family-code, monospace); font-size: 12px; color: var(--drg-label-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drg-toolbar-right { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.drg-toolbar-right .drg-select { max-width: 150px; }

.drg-viewport { display: flex; flex-direction: column; height: 100%; min-height: 0; flex: 1; }
.drg-viewport-notice { padding: 8px 12px 0; }
.drg-viewport-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.drg-frame-wrap { position: relative; flex: 1; min-height: 0; border: 1px solid var(--drg-border); border-radius: var(--drg-radius-sm); overflow: hidden; }
.drg-frame { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
.drg-frame-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--drg-label-2); background: var(--drg-surface); z-index: 1; }
.drg-connect-prompt { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; max-width: 420px; padding: 32px 16px; color: var(--drg-label-2); }
.drg-connect-prompt h2 { font-size: 16px; color: var(--drg-label); }
.drg-connect-prompt-icon { color: var(--drg-label-3); }
.drg-overlay-card { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; max-width: 460px; padding: 32px 16px; color: var(--drg-label-2); }
.drg-overlay-card h2 { font-size: 16px; color: var(--drg-label); }
.drg-overlay-card-icon { color: var(--drg-label-3); }
.drg-overlay-card-status { font-size: 12px; color: var(--drg-label-3); }

.drg-progress { margin: auto; width: min(560px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 24px 8px; }
.drg-progress-head { display: flex; align-items: center; gap: 10px; }
.drg-progress-title { font-size: 16px; font-weight: 600; }
.drg-progress-line { color: var(--drg-label-2); }
.drg-phases { display: flex; gap: 4px; flex-wrap: wrap; }
.drg-phase { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--drg-border-soft); color: var(--drg-label-3); font-size: 12px; }
.drg-phase[data-state="current"] { color: var(--drg-label); border-color: var(--drg-border); background: var(--drg-surface-2); }
.drg-phase[data-state="done"] { color: var(--dsw-alias-state-success-primary, #22a06b); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22a06b) 30%, transparent); }
.drg-phase-mark { display: inline-flex; width: 12px; height: 12px; align-items: center; justify-content: center; }

.drg-fingerprint { margin: auto; width: min(620px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 24px 8px; }
.drg-fingerprint-icon { color: var(--dsw-alias-state-warn-primary, #d9a400); }
.drg-fingerprint-icon[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d64545); }
.drg-fingerprint-title { font-size: 17px; font-weight: 600; }
.drg-fingerprint-body { color: var(--drg-label-2); }
.drg-kv { display: flex; flex-direction: column; gap: 6px; background: var(--drg-surface); border: 1px solid var(--drg-border); border-radius: var(--drg-radius-sm); padding: 10px 12px; }
.drg-kv > div { display: flex; gap: 12px; align-items: baseline; }
.drg-kv dt { flex: none; min-width: 96px; color: var(--drg-label-3); font-size: 12px; }
.drg-kv dd { color: var(--drg-label); word-break: break-word; }

.drg-error-card { margin: auto; width: min(620px, 100%); display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 28px 20px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 40%, var(--drg-border)); border-radius: var(--drg-radius); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 5%, var(--drg-surface)); }
.drg-error-icon { color: var(--dsw-alias-state-error-primary, #d64545); }
.drg-error-title { font-size: 17px; font-weight: 600; }
.drg-error-detail { color: var(--drg-label-2); }
.drg-error-steps { width: 100%; }
.drg-section-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--drg-label-3); margin-bottom: 4px; }
.drg-error-steps ul { display: flex; flex-direction: column; gap: 4px; color: var(--drg-label-2); }
.drg-error-steps li::before { content: "· "; color: var(--drg-label-3); }

.drg-modal-layer { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; }
.drg-modal-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.42); }
.drg-modal { position: relative; z-index: 1; display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(86vh, 900px); border-radius: var(--dsw-radius-xl, 12px); border: 1px solid var(--dsw-alias-border-l3, var(--drg-border)); background: var(--dsw-alias-bg-layer-2, Canvas); color: var(--drg-label); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28); overflow: hidden; }
.drg-modal-wide { width: min(760px, 100%); }
.drg-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 10px; border-bottom: 1px solid var(--drg-border-soft); }
.drg-modal-title { font-size: 17px; font-weight: 600; }
.drg-modal-subtitle { color: var(--drg-label-2); font-size: 13px; }
.drg-modal-body { padding: 16px 18px; overflow: auto; min-height: 0; }
.drg-modal-foot { display: flex; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--drg-border-soft); background: var(--drg-surface); }

.drg-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; min-width: 0; }
.drg-field-label { font-size: 13px; font-weight: 500; color: var(--drg-label); }
.drg-field-hint { font-size: 12px; color: var(--drg-label-3); }
.drg-field-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d64545); }
.drg-input, .drg-select { width: 100%; padding: 7px 10px; border-radius: var(--drg-radius-sm); border: 1px solid var(--drg-border); background: var(--drg-surface); color: var(--drg-label); font: inherit; font-size: 13px; outline: none; }
.drg-input:focus, .drg-select:focus { border-color: var(--dsw-alias-state-business-primary, #3b82f6); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 22%, transparent); }
.drg-input::placeholder { color: var(--drg-label-3); }
.drg-check { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
.drg-check input { accent-color: var(--drg-primary); }
.drg-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 14px; }
.drg-form-grid-3 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }

.drg-wizard-steps { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
.drg-wizard-step { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; color: var(--drg-label-3); border: 1px solid var(--drg-border-soft); }
.drg-wizard-step[data-state="current"] { color: var(--drg-label); border-color: var(--drg-border); background: var(--drg-surface-2); }
.drg-wizard-step[data-state="done"] { color: var(--dsw-alias-state-success-primary, #22a06b); }
.drg-wizard-step-index { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: var(--drg-surface-2); font-size: 10px; }
.drg-wizard-form, .drg-wizard-test, .drg-wizard-done { display: flex; flex-direction: column; gap: 10px; }
.drg-alias-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.drg-alias-label { font-size: 12px; color: var(--drg-label-3); }
.drg-alias-known { font-size: 11px; color: var(--drg-label-3); margin-left: auto; }
.drg-chip { border: 1px solid var(--drg-border); background: var(--drg-surface); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; color: var(--drg-label-2); }
.drg-chip:hover { background: var(--drg-hover); color: var(--drg-label); }
.drg-done-icon { color: var(--dsw-alias-state-success-primary, #22a06b); }
.drg-done-title { font-size: 17px; font-weight: 600; }
.drg-done-body { color: var(--drg-label-2); }

.drg-drawer-layer { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; }
.drg-drawer-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.32); }
.drg-drawer { position: relative; z-index: 1; display: flex; flex-direction: column; width: min(480px, 100%); height: 100%; background: var(--dsw-alias-bg-layer-2, Canvas); border-left: 1px solid var(--dsw-alias-border-l3, var(--drg-border)); box-shadow: -18px 0 50px rgba(0, 0, 0, 0.24); }
.drg-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 16px 10px; border-bottom: 1px solid var(--drg-border-soft); }
.drg-drawer-title { font-size: 16px; font-weight: 600; }
.drg-drawer-subtitle { color: var(--drg-label-2); font-size: 12px; overflow-wrap: anywhere; }
.drg-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; }
.drg-drawer-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--drg-border-soft); background: var(--drg-surface); }
.drg-diag { display: flex; flex-direction: column; gap: 12px; }
.drg-diag-head { display: flex; align-items: center; gap: 10px; }
.drg-diag-time { color: var(--drg-label-3); font-size: 12px; margin-left: auto; }
.drg-diag-list { display: flex; flex-direction: column; gap: 8px; }
.drg-diag-check { display: flex; gap: 10px; padding: 9px 10px; border: 1px solid var(--drg-border-soft); border-radius: var(--drg-radius-sm); background: var(--drg-surface); }
.drg-diag-status { flex: none; width: 44px; font-size: 11px; text-align: center; padding: 1px 0; border-radius: 4px; height: 20px; line-height: 18px; background: var(--drg-surface-2); color: var(--drg-label-2); }
.drg-diag-status[data-status="pass"] { color: var(--dsw-alias-state-success-primary, #22a06b); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22a06b) 12%, transparent); }
.drg-diag-status[data-status="fail"] { color: var(--dsw-alias-state-error-primary, #d64545); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 12%, transparent); }
.drg-diag-check-body { min-width: 0; }
.drg-diag-check-title { font-weight: 500; font-size: 13px; }
.drg-diag-check-detail { color: var(--drg-label-2); font-size: 12px; }

.drg-settings { display: flex; flex-direction: column; gap: 18px; }
.drg-settings-section { display: flex; flex-direction: column; gap: 6px; }
.drg-section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--drg-label-3); }
.drg-divider { height: 1px; background: var(--drg-border-soft); margin: 8px 0; }

/* main-panel layout + workspace rail */
.drg-panel-layout { display: flex; flex: 1; min-height: 0; min-width: 0; }
.drg-panel-main { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.drg-rail { display: flex; flex-direction: column; flex: none; width: 220px; min-height: 0; border-right: 1px solid var(--drg-border); background: var(--drg-surface); transition: width 120ms ease; }
.drg-rail[data-collapsed="true"] { width: 44px; }
.drg-rail-head { display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 12px; border-bottom: 1px solid var(--drg-border-soft); min-height: 42px; }
.drg-rail[data-collapsed="true"] .drg-rail-head { padding: 6px; justify-content: center; }
.drg-rail-title { flex: 1; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--drg-label-3); overflow: hidden; white-space: nowrap; }
.drg-rail-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 8px 12px; display: flex; flex-direction: column; gap: 10px; }
.drg-rail-group { display: flex; flex-direction: column; gap: 2px; }
.drg-rail-group-head { display: flex; align-items: center; gap: 5px; padding: 4px 6px; color: var(--drg-label-3); font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; }
.drg-rail-group-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drg-rail-group-icon { flex: none; display: inline-flex; }
.drg-rail-group-count { flex: none; font-size: 10px; padding: 0 5px; border-radius: 999px; background: var(--drg-surface-2); color: var(--drg-label-3); }
.drg-rail-items { display: flex; flex-direction: column; gap: 1px; }
.drg-rail-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; border: none; border-radius: var(--drg-radius-sm); background: transparent; color: var(--drg-label-2); text-align: left; cursor: pointer; font-size: 13px; }
.drg-rail-item:hover { background: var(--drg-hover); color: var(--drg-label); }
.drg-rail-item-icon { flex: none; display: inline-flex; color: var(--drg-label-3); }
.drg-rail-item-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drg-rail-item-meta { flex: none; font-size: 10px; color: var(--drg-label-3); }
.drg-rail-item .drg-badge { flex: none; font-size: 10px; padding: 0 5px; line-height: 16px; }
.drg-rail-muted { display: flex; align-items: center; gap: 6px; padding: 4px 8px; color: var(--drg-label-3); font-size: 12px; }
.drg-rail-row { justify-content: space-between; }
.drg-rail-error { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 6px 8px; color: var(--dsw-alias-state-error-primary, #d64545); font-size: 12px; }
.drg-rail-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 8px; text-align: center; color: var(--drg-label-3); border: 1px dashed var(--drg-border); border-radius: var(--drg-radius-sm); }
.drg-rail-empty p { font-size: 12px; line-height: 1.5; }
.drg-rail-hint { padding: 4px 6px 0; color: var(--drg-label-3); font-size: 11px; line-height: 1.5; }
.drg-settings-remote { display: flex; flex-direction: column; height: auto; min-height: 0; background: transparent; }
.drg-settings-remote .drg-page { padding: 0; overflow: visible; }
@media (max-width: 900px) { .drg-rail { width: 190px; } }

.drg-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 80; max-width: min(560px, calc(100vw - 32px)); padding: 9px 16px; border-radius: var(--drg-radius-sm); background: var(--dsw-alias-toast-bg, CanvasText); color: var(--dsw-alias-toast-label, Canvas); font-size: 13px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28); }
.drg-toast[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d64545); color: #fff; }
.drg-toast[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #22a06b); color: #fff; }
`

    /** Injects the panel styles once per mounted panel (removed on unmount). */
    function StyleSheet() {
      return h('style', { 'data-dsh-remote-go': 'styles', dangerouslySetInnerHTML: { __html: CSS } })
    }

    //#endregion

    //#region 18. plugin registration

    /**
     * Register dictionaries, the remote main panel, and the Settings →
     * "Remote hosts" section. There is intentionally no sidebar entry: host
     * management lives in Settings, and the remote UI opens in the main panel.
     * @param {object} ctx - browser plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-go: dictionaries')
      const t = ctx.locale.bind(NS)

      // Backfill the Host's local-version probe when the page exposes it, and
      // start the authoritative `/state` read in parallel (contract §1/§6).
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

      /** Host/panel request channel shared by the settings section and the panel. */
      const panelStore = createPanelRequestStore()
      const openPanel = () => ctx.layout.selectPanel(PANEL_ID)
      /**
       * Leave the remote panel for the local conversation and switch the local
       * workspace. The uiWorkspace service is declared in `inject`; the lookup
       * stays guarded so a missing implementation never throws.
       * @param {string} workspaceId - local workspace id.
       */
      const openLocalWorkspace = (workspaceId) => {
        try {
          ctx.layout.selectPanel(null)
        } catch (_error) {
          // leaving the panel is best-effort; switching still proceeds
        }
        try {
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
          if (workspace && typeof workspace.openWorkspace === 'function' && typeof workspaceId === 'string') {
            const result = workspace.openWorkspace(workspaceId)
            if (result && typeof result.catch === 'function') result.catch(() => {})
          }
        } catch (_error) {
          // the local conversation is already visible; a missing service is fine
        }
      }
      const sharedInject = () => ({ openPanel, panelStore, openLocalWorkspace, getLocaleId })

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: sharedInject,
          },
          MainPanel,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: PANEL_ID,
            order: 45,
            label: () => t('settingsNav'),
            locale: NS,
            inject: sharedInject,
          },
          SettingsSection,
        ),
      )
    }

    /** Components exported for tests and host-side tooling. */
    const components = {
      RemoteIcon,
      MainPanel,
      WorkspaceRail,
      SettingsSection,
      HostListView,
      HostCard,
      EmptyHosts,
      RemoteViewport,
      ViewportToolbar,
      ConnectProgress,
      ErrorCard,
      FingerprintCard,
      PasswordPrompt,
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
      inject: ['slots', 'layout', 'locale', 'uiWorkspace'],
      apply,
      components,
      /**
       * The Host-API client, exposed so unit tests can exercise the real security
       * guards on the real code path (`openHost`) instead of matching source text.
       * Not part of the plugin contract: the loader only consumes
       * `inject`/`apply`/`components`.
       */
      api,
      /**
       * Mirror-list polling policy, exposed like `api` so unit tests can assert the
       * settlement rules and the deadline/interval bounds directly. Inert at
       * runtime: the loader consumes only `inject`/`apply`/`components`.
       */
      mirrorPolling: {
        settled: mirrorsSettled,
        intervalMs: MIRROR_POLL_INTERVAL_MS,
        deadlineMs: MIRROR_POLL_DEADLINE_MS,
      },
    }

    //#endregion
  },
})

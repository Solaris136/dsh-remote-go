/**
 * Client-half unit tests for dsh-remote-go.
 *
 * Loads `client.js` inside a `node:vm` sandbox with a fake
 * `window.__ModuleLoader__.load`, injects the real React from the workspace,
 * then exercises registration (`apply`) and server-renders the key components
 * with `react-dom/server`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const React = requireFromHere('react')
const { renderToStaticMarkup } = requireFromHere('react-dom/server')

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT_PATH = path.join(REPO_ROOT, 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

const PANEL_ID = 'dsh-remote-go'

/**
 * Execute client.js in a VM with a fake module loader and materialize the
 * registered factory with the real React. Returns the factory's plugin object.
 */
function loadClientPlugin() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  sandbox.window = {
    __ModuleLoader__: {
      load(declaration) {
        sandbox.__declaration = declaration
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

  const declaration = sandbox.__declaration
  assert.ok(declaration, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(declaration.id, 'dsh-remote-go')
  assert.equal(typeof declaration.factory, 'function')
  const plugin = declaration.factory((specifier) => {
    assert.equal(specifier, 'react', 'client.js may only require react')
    return React
  })
  assert.ok(plugin && typeof plugin === 'object', 'factory must return the plugin object')
  return plugin
}

/** Minimal dictionary interpolation, mirroring the locale service. */
function interpolate(template, params) {
  if (!params) return String(template)
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    params[key] === undefined || params[key] === null ? match : String(params[key]),
  )
}

/** Build a translate function over a flat dictionary. */
function translateFrom(dict) {
  return (key, params) => {
    const text = dict[key] === undefined ? key : dict[key]
    return interpolate(text, params)
  }
}

/**
 * Run `apply` against a recording mock context.
 * @returns {{ctx: object, calls: object, t: Function, dicts: object, disposers: Function[]}}
 */
function runApply(plugin) {
  const calls = {
    effects: [],
    injects: [],
    registers: [],
    selectPanel: [],
    registerNamespace: null,
    bindNamespace: null,
    openWorkspace: [],
  }
  const disposers = []
  let dicts = null
  let t = (key) => key
  const uiWorkspace = {
    openWorkspace(workspaceId) {
      calls.openWorkspace.push(workspaceId)
    },
  }

  const ctx = {
    effect(callback, label) {
      calls.effects.push(label)
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get(name) {
      return name === 'uiWorkspace' ? uiWorkspace : null
    },
    locale: {
      register(ns, dictionaries) {
        calls.registerNamespace = ns
        dicts = dictionaries
        t = translateFrom(dictionaries.zh || {})
        return () => {}
      },
      bind(ns) {
        calls.bindNamespace = ns
        return t
      },
      getSnapshot() {
        return { active: 'zh', revision: 1 }
      },
    },
    slots: {
      inject(key, callback) {
        calls.injects.push(key)
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
      register(options, component) {
        calls.registers.push({ options, component })
        return () => {}
      },
    },
    layout: {
      selectPanel(panelId) {
        calls.selectPanel.push(panelId)
      },
    },
  }

  plugin.apply(ctx)
  return { ctx, calls, t, dicts, disposers }
}

const plugin = loadClientPlugin()
const zhDict = (() => {
  const { calls } = runApply(plugin)
  return calls.registerNamespace ? runApply(plugin).dicts.zh : {}
})()
const t = translateFrom(zhDict)
const enT = translateFrom(runApply(plugin).dicts.en)

/** Render a component to static markup with a stable `t`. */
function render(element) {
  return renderToStaticMarkup(element)
}

/** Minimal HostView factory for render tests. */
function hostView(overrides) {
  return {
    id: 'h_test',
    name: '测试机',
    address: 'ubuntu@10.0.0.5',
    addressMasked: 'ubuntu@10.0.0.5:22',
    status: 'connected',
    phase: null,
    progress: null,
    error: null,
    fingerprint: null,
    remote: {
      version: '0.2.2-rc.1',
      uiReady: true,
      localPort: 54321,
      pid: 1234,
      dshHome: '/home/ubuntu/.dsh',
      bootstrapLevel: 'T0',
      nodeVersion: '22.14.0',
      startedAt: '2026-11-10T15:00:00.000Z',
    },
    keepAlive: 'keep',
    idleMinutes: 15,
    autoReconnect: true,
    authType: 'agent',
    lastOpenedAt: '2026-11-10T15:00:00.000Z',
    createdAt: '2026-11-10T14:00:00.000Z',
    updatedAt: '2026-11-10T14:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. module format
// ---------------------------------------------------------------------------

test('client.js registers one lazy factory through window.__ModuleLoader__', () => {
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(/)
  assert.match(SOURCE, /id:\s*'dsh-remote-go'/)
  // Only React may be required (no Node APIs, no other packages).
  const specifiers = [...SOURCE.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1].trim())
  for (const specifier of specifiers) {
    assert.equal(specifier, "'react'", 'unexpected require: ' + specifier)
  }
})

test('factory injects slots, layout, locale and uiWorkspace', () => {
  const injects = Array.from(plugin.inject)
  assert.deepEqual(injects, ['slots', 'layout', 'locale', 'uiWorkspace'])
})

test('components export is a non-empty map of renderable functions', () => {
  assert.ok(plugin.components && typeof plugin.components === 'object')
  const names = Object.keys(plugin.components)
  assert.ok(names.length >= 10, 'expected the panel component set, got ' + names.length)
  for (const name of names) {
    assert.equal(typeof plugin.components[name], 'function', name + ' must be a component function')
  }
  assert.equal(typeof plugin.components.MainPanel, 'function')
  assert.equal(typeof plugin.components.HostListView, 'function')
  assert.equal(typeof plugin.components.RemoteViewport, 'function')
  assert.equal(typeof plugin.components.WizardDialog, 'function')
  assert.equal(typeof plugin.components.DiagnoseDrawer, 'function')
  assert.equal(typeof plugin.components.SettingsModal, 'function')
  assert.equal(typeof plugin.components.PasswordPrompt, 'function')
  assert.equal(typeof plugin.components.SettingsSection, 'function')
  assert.equal(typeof plugin.components.WorkspaceRail, 'function')
  assert.equal(typeof plugin.components.RemoteIcon, 'function')
})

// ---------------------------------------------------------------------------
// 2. apply() registration behaviour
// ---------------------------------------------------------------------------

test('apply registers zh/en dictionaries and binds the namespace', () => {
  const { calls, dicts, disposers } = runApply(plugin)
  assert.equal(calls.registerNamespace, PANEL_ID)
  assert.ok(calls.effects.length >= 1, 'locale registration must be owned by ctx.effect')
  assert.ok(dicts && dicts.zh && dicts.en, 'both dictionaries must be registered')
  assert.equal(calls.bindNamespace, PANEL_ID)
  assert.ok(disposers.length >= 1, 'apply must return disposers through ctx.effect/ctx.slots.inject')
  for (const dispose of disposers) assert.doesNotThrow(() => dispose())
})

test('dictionaries are bilingual and balanced', () => {
  const { dicts } = runApply(plugin)
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'en must define exactly the same keys as zh')
  assert.ok(zhKeys.length > 100, 'expected the full dictionary, got ' + zhKeys.length + ' keys')
  for (const key of zhKeys) {
    assert.equal(typeof dicts.zh[key], 'string', 'zh.' + key + ' must be a string')
    assert.equal(typeof dicts.en[key], 'string', 'en.' + key + ' must be a string')
    assert.ok(dicts.zh[key].length > 0, 'zh.' + key + ' must not be empty')
    assert.ok(dicts.en[key].length > 0, 'en.' + key + ' must not be empty')
  }
})

test('apply registers the main panel and the settings section, never a sidebar entry', () => {
  const { calls } = runApply(plugin)
  assert.deepEqual(calls.injects, ['main', 'settings.section'])
  assert.equal(calls.registers.length, 2)
  assert.ok(!calls.injects.includes('sidebar.panellist'), 'the sidebar entry must be gone')

  const main = calls.registers.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main slot entry must be registered')
  assert.equal(main.options.key, PANEL_ID)
  assert.equal(main.options.locale, PANEL_ID)
  assert.equal(main.component, plugin.components.MainPanel)

  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section, 'settings.section entry must be registered')
  assert.equal(section.options.id, PANEL_ID)
  assert.equal(section.options.order, 45)
  assert.equal(section.options.locale, PANEL_ID)
  assert.equal(section.component, plugin.components.SettingsSection)
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), '远程主机')
})

test('shared inject face opens the panel, the local workspace and the panel request store', () => {
  const { calls } = runApply(plugin)
  const main = calls.registers.find((entry) => entry.options.name === 'main')
  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  assert.equal(typeof main.options.inject, 'function')
  assert.equal(typeof section.options.inject, 'function')
  const face = main.options.inject()
  assert.equal(typeof face.openPanel, 'function')
  assert.equal(typeof face.getLocaleId, 'function')
  assert.equal(typeof face.openLocalWorkspace, 'function')
  assert.ok(face.panelStore && typeof face.panelStore.request === 'function')
  assert.equal(face.getLocaleId(), 'zh')

  face.openPanel()
  assert.deepEqual(calls.selectPanel, [PANEL_ID])

  face.openLocalWorkspace('ws_local')
  assert.deepEqual(calls.selectPanel, [PANEL_ID, null])
  assert.deepEqual(calls.openWorkspace, ['ws_local'])

  face.panelStore.request('h_test')
  assert.equal(face.panelStore.take(), 'h_test')
  assert.equal(face.panelStore.take(), null)
})

// ---------------------------------------------------------------------------
// 3. security invariants
// ---------------------------------------------------------------------------

test('client code never logs and never persists iframe URLs / tokens', () => {
  assert.doesNotMatch(SOURCE, /console\.(log|debug|info|warn|error)\s*\(/)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*token/i)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*url/i)
  // Every fetch call is centralised in the one API helper that adds the header.
  assert.match(SOURCE, /'x-dsh-remote-go':\s*'1'/)
  assert.match(SOURCE, /credentials:\s*'same-origin'/)
  assert.match(SOURCE, /const LOOPBACK_PREFIX = 'http:\/\/127\.0\.0\.1:'/)
  assert.match(SOURCE, /url\.startsWith\(LOOPBACK_PREFIX\)/)
})

test('iframe URL guard blocks non-loopback addresses', () => {
  const blocked = render(
    React.createElement(plugin.components.RemoteViewport, {
      t,
      host: hostView(),
      hosts: [hostView()],
      iframeUrl: 'https://evil.example.com/?token=secret',
      iframeKey: 0,
      iframeLoading: false,
      iframeError: null,
      addressVisible: true,
      enterNotice: false,
    }),
  )
  assert.doesNotMatch(blocked, /evil\.example\.com/)
  assert.match(blocked, /已阻止内嵌远端界面/)
})

// ---------------------------------------------------------------------------
// 4. key component renders (react-dom/server)
// ---------------------------------------------------------------------------

test('empty host list renders the empty state and the first-server action', () => {
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [],
    settings: {},
    activeHostId: null,
    firstRun: true,
  }
  const html = render(
    React.createElement(plugin.components.HostListView, {
      t,
      state,
      loading: false,
      error: null,
      onAdd: () => {},
      onRefresh: () => {},
    }),
  )
  assert.match(html, /远程主机/)
  assert.match(html, /还没有远程主机/)
  assert.match(html, /添加第一台服务器/)
  assert.match(html, /drg-empty/)
  assert.doesNotMatch(html, /drg-host-card/)
})

test('host list renders a connected host card with remote version and actions', () => {
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [hostView()],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const html = render(
    React.createElement(plugin.components.HostListView, {
      t,
      state,
      loading: false,
      error: null,
      onAdd: () => {},
      onRefresh: () => {},
      onOpenHost: () => {},
      onDisconnectHost: () => {},
      onEditHost: () => {},
      onDeleteHost: () => {},
      onDiagnoseHost: () => {},
    }),
  )
  assert.match(html, /测试机/)
  assert.match(html, /ubuntu@10\.0\.0\.5:22/)
  assert.match(html, /0\.2\.2-rc\.1/)
  assert.match(html, /已连接/)
  assert.match(html, /共 1/)
  assert.match(html, /断开/)
  assert.match(html, /诊断/)
})

test('viewport shows the one-time "operating a remote server" notice when flagged', () => {
  const host = hostView()
  const html = render(
    React.createElement(plugin.components.RemoteViewport, {
      t,
      host,
      hosts: [host],
      iframeUrl: 'http://127.0.0.1:54321/',
      iframeKey: 0,
      iframeLoading: false,
      iframeError: null,
      addressVisible: true,
      enterNotice: true,
      onBack: () => {},
      onReconnect: () => {},
      onRefreshFrame: () => {},
      onSwitchHost: () => {},
      onToggleAddress: () => {},
      onOpenExternal: () => {},
      onDiagnose: () => {},
      onDismissEnterNotice: () => {},
    }),
  )
  assert.match(html, /你正在操作远端服务器/)
  assert.match(html, /关闭本机视窗不会结束远端任务/)
  assert.match(html, /知道了/)
})

test('host list shows the one-time "remote tasks keep running" notice when flagged', () => {
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const html = render(
    React.createElement(plugin.components.HostListView, {
      t,
      state,
      loading: false,
      error: null,
      closeNotice: true,
      onDismissCloseNotice: () => {},
      onAdd: () => {},
    }),
  )
  assert.match(html, /远端任务会继续运行/)
  assert.match(html, /下次打开会直接回到该主机/)
})

test('connecting host renders staged progress text', () => {
  const host = hostView({
    status: 'connecting',
    phase: 'ssh',
    progress: { code: 'ssh-connecting' },
    remote: { ...hostView().remote, version: null, uiReady: false },
  })
  const html = render(React.createElement(plugin.components.ConnectProgress, { t, host }))
  assert.match(html, /正在连接「测试机」/)
  assert.match(html, /正在连接 SSH…/)
  assert.match(html, /SSH/)
  assert.match(html, /隧道/)
})

test('progress code map covers every contract code', () => {
  const { dicts } = runApply(plugin)
  const codes = [
    'ssh-connecting',
    'host-key-checking',
    'host-key-confirm',
    'auth-checking',
    'probing',
    'bootstrapping',
    'bootstrap-progress',
    'starting-remote',
    'starting-remote-wait',
    'tunneling',
    'verifying',
    'ready',
    'reconnecting',
  ]
  for (const code of codes) {
    assert.ok(dicts.zh['progress.' + code], 'missing zh progress.' + code)
    assert.ok(dicts.en['progress.' + code], 'missing en progress.' + code)
  }
})

test('error card renders localized title, detail, next steps and retry', () => {
  const error = {
    code: 'auth',
    title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
    detail: { zh: '请检查用户名与密钥/Agent。', en: 'Check the user name and key/agent.' },
    nextSteps: [{ zh: '确认密钥已加载到 SSH Agent', en: 'Make sure the key is loaded in the SSH agent' }],
    retryable: true,
  }
  const html = render(
    React.createElement(plugin.components.ErrorCard, {
      t,
      error,
      onRetry: () => {},
      onDiagnose: () => {},
      onBack: () => {},
    }),
  )
  assert.match(html, /SSH 认证没有通过/)
  assert.match(html, /请检查用户名与密钥\/Agent/)
  assert.match(html, /确认密钥已加载到 SSH Agent/)
  assert.match(html, /重试/)
  assert.match(html, /诊断/)
  assert.match(html, /返回/)
})

test('error card resolves English text when the locale is en', () => {
  const error = {
    code: 'network',
    title: { zh: '连不上这台服务器', en: 'Cannot reach this server' },
    detail: { zh: '检查地址/端口/网络。', en: 'Check the address, port and network.' },
    nextSteps: [{ zh: '先测跳板机', en: 'Test the jump host first' }],
    retryable: true,
  }
  const html = render(
    React.createElement(plugin.components.ErrorCard, { t: enT, localeId: 'en', error, onRetry: () => {} }),
  )
  assert.match(html, /Cannot reach this server/)
  assert.match(html, /Check the address, port and network/)
  assert.match(html, /Test the jump host first/)
})

test('viewport toolbar renders host, status, address and the tool actions', () => {
  const host = hostView()
  const html = render(
    React.createElement(plugin.components.RemoteViewport, {
      t,
      host,
      hosts: [host, hostView({ id: 'h_second', name: '第二台' })],
      iframeUrl: 'http://127.0.0.1:54321/?token=one-time',
      iframeKey: 0,
      iframeLoading: false,
      iframeError: null,
      addressVisible: true,
      enterNotice: false,
      onBack: () => {},
      onReconnect: () => {},
      onRefreshFrame: () => {},
      onSwitchHost: () => {},
      onToggleAddress: () => {},
      onOpenExternal: () => {},
      onDiagnose: () => {},
    }),
  )
  assert.match(html, /测试机/)
  assert.match(html, /已连接/)
  assert.match(html, /ubuntu@10\.0\.0\.5:22/)
  assert.match(html, /重连/)
  assert.match(html, /刷新界面/)
  assert.match(html, /在新窗口打开/)
  assert.match(html, /返回主机清单/)
  assert.match(html, /切换主机|<select/)
  // The validated loopback URL becomes the iframe src.
  assert.match(html, /src="http:\/\/127\.0\.0\.1:54321\/\?token=one-time"/)
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"/)
})

test('disconnected viewport shows the yellow banner and reconnect action', () => {
  const host = hostView({ status: 'disconnected' })
  const html = render(
    React.createElement(plugin.components.RemoteViewport, {
      t,
      host,
      hosts: [host],
      iframeUrl: 'http://127.0.0.1:54321/',
      iframeKey: 0,
      iframeLoading: false,
      iframeError: null,
      addressVisible: true,
      enterNotice: false,
      onBack: () => {},
      onReconnect: () => {},
      onRefreshFrame: () => {},
      onSwitchHost: () => {},
      onToggleAddress: () => {},
      onOpenExternal: () => {},
      onDiagnose: () => {},
    }),
  )
  assert.match(html, /连接断开，远端任务可能仍在运行/)
  assert.match(html, /立即重连/)
})

test('viewport with an errored host renders the error card, never a blank frame', () => {
  const host = hostView({
    status: 'error',
    error: {
      code: 'network',
      title: { zh: '连不上这台服务器', en: 'Cannot reach this server' },
      detail: { zh: '检查地址/端口/网络。', en: 'Check the address, port and network.' },
      nextSteps: [{ zh: '确认服务器在线', en: 'Make sure the server is online' }],
      retryable: true,
    },
  })
  const html = render(
    React.createElement(plugin.components.RemoteViewport, {
      t,
      host,
      hosts: [host],
      iframeUrl: null,
      iframeKey: 0,
      iframeLoading: false,
      iframeError: null,
      addressVisible: false,
      enterNotice: false,
      onBack: () => {},
      onReconnect: () => {},
      onRefreshFrame: () => {},
      onSwitchHost: () => {},
      onToggleAddress: () => {},
      onOpenExternal: () => {},
      onDiagnose: () => {},
    }),
  )
  assert.match(html, /连不上这台服务器/)
  assert.match(html, /确认服务器在线/)
  assert.doesNotMatch(html, /<iframe/)
  assert.match(html, /••••••/)
})

test('fingerprint card shows SHA256 and accept / remember actions', () => {
  const host = hostView({
    status: 'fingerprint-pending',
    fingerprint: { sha256: 'SHA256:abcdefghijklmnop', keyType: 'ssh-ed25519', status: 'pending', pinned: null },
  })
  const html = render(
    React.createElement(plugin.components.FingerprintCard, { t, host, onAccept: () => {}, onReject: () => {} }),
  )
  assert.match(html, /主机指纹待确认/)
  assert.match(html, /SHA256 指纹/)
  assert.match(html, /SHA256:abcdefghijklmnop/)
  assert.match(html, /接受并记住/)
  assert.match(html, /仅本次接受/)
})

test('wizard step 1 renders the SSH form', () => {
  const state = {
    hostVersion: '0.2.2-rc.1',
    hosts: [],
    settings: { defaultPort: 22, defaultAuth: 'agent', hostKeyPolicy: 'first-use', autoReconnect: { enabled: true } },
    activeHostId: null,
    firstRun: true,
  }
  const html = render(
    React.createElement(plugin.components.WizardDialog, {
      t,
      mode: 'add',
      initialHost: null,
      state,
      onClose: () => {},
    }),
  )
  assert.match(html, /添加服务器/)
  assert.match(html, /显示名/)
  assert.match(html, /SSH 地址或别名/)
  assert.match(html, /保存并测试/)
  assert.match(html, /使用 SSH Agent/)
  assert.match(html, /远端存活策略/)
  // The address field is wired to the SSH alias datalist loaded from /ssh/aliases.
  assert.match(html, /list="drg-ssh-alias-list"/)
  assert.match(html, /<datalist[^>]*id="drg-ssh-alias-list"/)
})

test('diagnostics drawer renders the checklist with statuses', () => {
  const report = {
    summary: 'warning',
    checks: [
      {
        id: 'ssh-reachable',
        title: { zh: 'SSH 可达性', en: 'SSH reachability' },
        status: 'pass',
        detail: { zh: 'SSH 端口可连接', en: 'SSH port is reachable' },
      },
      {
        id: 'auth',
        title: { zh: '认证方式', en: 'Authentication' },
        status: 'fail',
        detail: { zh: '认证失败', en: 'Authentication failed' },
      },
      {
        id: 'tunnel',
        title: { zh: '隧道状态', en: 'Tunnel' },
        status: 'unknown',
        detail: { zh: '尚未检查', en: 'Not checked yet' },
      },
    ],
    redacted: true,
    generatedAt: '2026-11-10T15:00:00.000Z',
  }
  const html = render(
    React.createElement(plugin.components.DiagnoseDrawer, {
      t,
      host: hostView(),
      status: 'done',
      report,
      onClose: () => {},
      onRun: () => {},
    }),
  )
  assert.match(html, /连接诊断/)
  assert.match(html, /SSH 可达性/)
  assert.match(html, /认证方式/)
  assert.match(html, /通过/)
  assert.match(html, /失败/)
  assert.match(html, /未知/)
  assert.match(html, /重新检查/)
  assert.match(html, /复制诊断信息/)
  assert.match(html, /已脱敏/)
})

test('settings modal renders contract fields and the save action', () => {
  const settings = {
    defaultPort: 22,
    defaultAuth: 'agent',
    connectTimeoutSec: 30,
    autoReconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 1000 },
    hostKeyPolicy: 'first-use',
    saveTokens: false,
    windowMode: 'panel',
    language: 'auto',
    logLevel: 'info',
    bootstrap: { targetVersion: 'local', mode: 'auto', remoteDir: '~/.dsh/remote-go', nodeVersion: '22.14.0' },
  }
  const html = render(
    React.createElement(plugin.components.SettingsModal, {
      t,
      settings,
      onClose: () => {},
      onSave: async () => {},
    }),
  )
  assert.match(html, /设置/)
  assert.match(html, /呈现形态/)
  assert.match(html, /主机指纹策略/)
  assert.match(html, /允许保存访问令牌/)
  assert.match(html, /风险提示|0600/)
  assert.match(html, /自举/)
  assert.match(html, /保存设置/)
})

test('main panel renders its loading state inside the DSH theme root and the workspace rail', () => {
  const html = render(
    React.createElement(plugin.components.MainPanel, {
      t,
      getLocaleId: () => 'zh',
      openPanel: () => {},
    }),
  )
  assert.match(html, /class="drg-root"/)
  assert.match(html, /data-testid="dsh-remote-go-panel"/)
  assert.match(html, /远程主机/)
  assert.match(html, /加载中/)
  assert.match(html, /data-testid="workspace-rail"/)
  assert.match(html, /data-testid="workspace-rail-toggle"/)
  assert.match(html, /data-dsh-remote-go="styles"/)
  assert.match(html, /--dsw-alias-label-primary/)
})

test('settings section renders the remote-hosts page and its empty state', () => {
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [],
    settings: {},
    activeHostId: null,
    firstRun: true,
  }
  const html = render(
    React.createElement(plugin.components.SettingsSection, {
      t,
      initialState: state,
      openPanel: () => {},
      panelStore: { request: () => {} },
      getLocaleId: () => 'zh',
    }),
  )
  assert.match(html, /data-testid="settings-remote-section"/)
  assert.match(html, /远程主机/)
  assert.match(html, /管理通过 SSH 连接的远程主机/)
  assert.match(html, /data-testid="settings-host-add"/)
  assert.match(html, /data-testid="settings-settings-open"/)
  assert.match(html, /还没有远程主机。添加一台，然后在这里打开它的 DSH。/)
})

test('settings section offers open/connect actions per host', () => {
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [
      hostView({ id: 'h_connected', name: '已连接主机' }),
      hostView({ id: 'h_offline', name: '未连接主机', status: 'disconnected' }),
    ],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const html = render(
    React.createElement(plugin.components.SettingsSection, {
      t,
      initialState: state,
      openPanel: () => {},
      panelStore: { request: () => {} },
      getLocaleId: () => 'zh',
    }),
  )
  assert.match(html, /data-testid="settings-host-open"/)
  assert.match(html, /打开远程界面/)
  assert.match(html, /data-testid="settings-host-connect"/)
  assert.match(html, /data-host-id="h_connected"/)
  assert.match(html, /data-host-id="h_offline"/)
})

test('workspace rail renders local and per-host workspace groups', () => {
  const hosts = [
    hostView({ id: 'h_one', name: '主机一', status: 'connected' }),
    hostView({ id: 'h_two', name: '主机二', status: 'disconnected' }),
  ]
  const initialWorkspaceData = {
    local: {
      status: 'ready',
      workspaces: [
        { id: 'ws_local_1', title: 'proj', path: 'C:\\Work\\proj', sessionCount: 3, isDefault: true, origin: 'local' },
      ],
      defaultWorkspaceId: 'ws_local_1',
      error: null,
    },
    remotes: {
      h_one: {
        status: 'ready',
        connected: true,
        hostName: '主机一',
        error: null,
        workspaces: [
          {
            id: 'r_ws_1',
            title: 'remote-proj',
            path: '/home/ubuntu/proj',
            sessionCount: 2,
            origin: 'remote',
            hostId: 'h_one',
          },
        ],
      },
      h_two: { status: 'disconnected', connected: false, hostName: '主机二', workspaces: [], error: null },
    },
  }
  const html = render(React.createElement(plugin.components.WorkspaceRail, { t, hosts, initialWorkspaceData }))
  assert.match(html, /data-testid="workspace-rail"/)
  assert.match(html, /data-testid="workspace-local-group"/)
  assert.match(html, /data-testid="workspace-local-item"/)
  assert.match(html, /data-workspace-id="ws_local_1"/)
  assert.match(html, /proj/)
  assert.match(html, /3 个会话/)
  assert.match(html, /默认/)
  assert.match(html, /data-testid="workspace-remote-group"/)
  assert.match(html, /data-host-id="h_one"/)
  assert.match(html, /data-testid="workspace-remote-item"/)
  assert.match(html, /data-workspace-id="r_ws_1"/)
  assert.match(html, /未连接/)
  assert.match(html, /data-testid="workspace-rail-toggle"/)
  assert.match(html, /data-testid="workspace-rail-refresh"/)
  assert.match(html, /本地工作区仍可在左侧边栏切换/)
})

test('workspace rail renders empty, error and collapsed states', () => {
  const empty = render(
    React.createElement(plugin.components.WorkspaceRail, {
      t,
      hosts: [],
      initialWorkspaceData: {
        local: { status: 'ready', workspaces: [], defaultWorkspaceId: null, error: null },
        remotes: {},
      },
    }),
  )
  assert.match(empty, /data-testid="workspace-rail-empty"/)
  assert.match(empty, /还没有远程主机。添加一台后，这里会显示它的工作区。/)

  const failed = render(
    React.createElement(plugin.components.WorkspaceRail, {
      t,
      hosts: [hostView({ id: 'h_err', name: '故障主机', status: 'connected' })],
      initialWorkspaceData: {
        local: { status: 'error', workspaces: [], defaultWorkspaceId: null, error: { code: 'network' } },
        remotes: {
          h_err: { status: 'error', connected: true, hostName: '故障主机', workspaces: [], error: { code: 'network' } },
        },
      },
    }),
  )
  assert.match(failed, /data-testid="workspace-rail-error"/)
  assert.match(failed, /无法读取远端工作区|无法读取本地工作区/)

  const collapsed = render(
    React.createElement(plugin.components.WorkspaceRail, { t, hosts: [], initialCollapsed: true }),
  )
  assert.match(collapsed, /data-collapsed="true"/)
  assert.match(collapsed, /data-testid="workspace-rail-toggle"/)
  assert.doesNotMatch(collapsed, /data-testid="workspace-local-group"/)
})

/** All `data-testid` values contained in one rendered markup string. */
function testIdsOf(html) {
  return [...html.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1])
}

test('every automation data-testid required by acceptance is rendered', () => {
  const host = hostView({ authType: 'password' })
  const baseState = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [host],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const emptyState = { ...baseState, hosts: [] }
  const markup = {
    panel: render(
      React.createElement(plugin.components.MainPanel, { t, getLocaleId: () => 'zh', openPanel: () => {} }),
    ),
    settingsSection: render(
      React.createElement(plugin.components.SettingsSection, {
        t,
        initialState: baseState,
        openPanel: () => {},
        panelStore: { request: () => {} },
        getLocaleId: () => 'zh',
      }),
    ),
    workspaceRail: render(
      React.createElement(plugin.components.WorkspaceRail, {
        t,
        hosts: [
          hostView({ id: 'h_ws', name: '工作区主机', status: 'connected' }),
          hostView({ id: 'h_ws_off', name: '离线主机', status: 'disconnected' }),
        ],
        initialWorkspaceData: {
          local: {
            status: 'ready',
            workspaces: [{ id: 'ws_local', title: 'local-proj', sessionCount: 1, isDefault: true }],
            defaultWorkspaceId: 'ws_local',
            error: null,
          },
          remotes: {
            h_ws: {
              status: 'ready',
              connected: true,
              hostName: '工作区主机',
              error: null,
              workspaces: [{ id: 'ws_remote', title: 'remote-proj', sessionCount: 2 }],
            },
            h_ws_off: { status: 'disconnected', connected: false, hostName: '离线主机', workspaces: [], error: null },
          },
        },
      }),
    ),
    workspaceRailError: render(
      React.createElement(plugin.components.WorkspaceRail, {
        t,
        hosts: [hostView({ id: 'h_err', name: '故障主机' })],
        initialWorkspaceData: {
          local: { status: 'error', workspaces: [], defaultWorkspaceId: null, error: { code: 'network' } },
          remotes: {
            h_err: {
              status: 'error',
              connected: true,
              hostName: '故障主机',
              workspaces: [],
              error: { code: 'network' },
            },
          },
        },
      }),
    ),
    workspaceRailEmpty: render(
      React.createElement(plugin.components.WorkspaceRail, {
        t,
        hosts: [],
        initialWorkspaceData: {
          local: { status: 'ready', workspaces: [], defaultWorkspaceId: null, error: null },
          remotes: {},
        },
      }),
    ),
    empty: render(
      React.createElement(plugin.components.HostListView, {
        t,
        state: emptyState,
        loading: false,
        error: null,
        onAdd: () => {},
        onRefresh: () => {},
      }),
    ),
    list: render(
      React.createElement(plugin.components.HostListView, {
        t,
        state: baseState,
        loading: false,
        error: null,
        onAdd: () => {},
        onRefresh: () => {},
        onOpenHost: () => {},
        onDisconnectHost: () => {},
        onReconnectHost: () => {},
        onEditHost: () => {},
        onDeleteHost: () => {},
        onDiagnoseHost: () => {},
      }),
    ),
    viewport: render(
      React.createElement(plugin.components.RemoteViewport, {
        t,
        host: hostView(),
        hosts: [hostView()],
        iframeUrl: 'http://127.0.0.1:54321/',
        iframeKey: 0,
        iframeLoading: false,
        iframeError: null,
        addressVisible: true,
        enterNotice: false,
        onBack: () => {},
        onReconnect: () => {},
        onRefreshFrame: () => {},
        onSwitchHost: () => {},
        onToggleAddress: () => {},
        onOpenExternal: () => {},
        onDiagnose: () => {},
      }),
    ),
    wizard: render(
      React.createElement(plugin.components.WizardDialog, {
        t,
        mode: 'add',
        initialHost: null,
        state: emptyState,
        onClose: () => {},
      }),
    ),
    wizardPassword: render(
      React.createElement(plugin.components.WizardDialog, {
        t,
        mode: 'add',
        initialHost: null,
        state: { ...emptyState, settings: { defaultAuth: 'password' } },
        onClose: () => {},
      }),
    ),
    diagnostics: render(
      React.createElement(plugin.components.DiagnoseDrawer, {
        t,
        host,
        status: 'done',
        report: {
          summary: 'ok',
          checks: [
            {
              id: 'ssh-reachable',
              title: { zh: 'SSH 可达性', en: 'SSH reachability' },
              status: 'pass',
              detail: { zh: '可连接', en: 'Reachable' },
            },
          ],
        },
        onClose: () => {},
        onRun: () => {},
      }),
    ),
    settings: render(
      React.createElement(plugin.components.SettingsModal, {
        t,
        settings: {},
        onClose: () => {},
        onSave: async () => {},
      }),
    ),
    error: render(
      React.createElement(plugin.components.ErrorCard, {
        t,
        error: {
          code: 'auth',
          title: { zh: '认证失败', en: 'Authentication failed' },
          detail: { zh: '检查密钥', en: 'Check the key' },
          nextSteps: [],
          retryable: true,
        },
        onRetry: () => {},
      }),
    ),
    password: render(
      React.createElement(plugin.components.PasswordPrompt, {
        t,
        host,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    ),
    fingerprint: render(
      React.createElement(plugin.components.FingerprintCard, {
        t,
        host: hostView({
          status: 'fingerprint-pending',
          fingerprint: { sha256: 'SHA256:test', keyType: 'ssh-ed25519', status: 'pending', pinned: null },
        }),
        onAccept: () => {},
        onReject: () => {},
      }),
    ),
  }
  const required = [
    'dsh-remote-go-panel',
    'host-list',
    'host-list-empty',
    'host-add',
    'host-card',
    'host-open',
    'host-diagnose',
    'host-edit',
    'host-delete',
    'remote-iframe',
    'viewport-toolbar',
    'viewport-reconnect',
    'viewport-back',
    'host-wizard',
    'wizard-step-1',
    'wizard-next',
    'wizard-name',
    'wizard-address',
    'wizard-auth',
    'wizard-cancel',
    'wizard-password',
    'diagnostics',
    'diagnose-rerun',
    'diagnose-copy',
    'settings',
    'settings-save',
    'settings-remote-section',
    'settings-host-add',
    'settings-host-open',
    'settings-settings-open',
    'workspace-rail',
    'workspace-rail-toggle',
    'workspace-rail-refresh',
    'workspace-local-group',
    'workspace-local-item',
    'workspace-remote-group',
    'workspace-remote-item',
    'workspace-rail-empty',
    'workspace-rail-error',
    'error-card',
    'error-retry',
    'fingerprint-card',
    'fingerprint-accept',
    'password-prompt',
  ]
  const ids = new Set(Object.values(markup).flatMap(testIdsOf))
  for (const id of required) assert.ok(ids.has(id), 'missing data-testid="' + id + '"')
  assert.match(markup.list, /data-host-id="h_test"/)
  assert.match(markup.workspaceRail, /data-workspace-id="ws_local"/)
  assert.match(markup.workspaceRail, /data-workspace-id="ws_remote"/)
  assert.match(markup.password, /type="password"/)
  assert.match(markup.password, /只用于本次连接，不会保存/)
  assert.doesNotMatch(JSON.stringify(markup), /dsh-remote-go-sidebar/)
})

test('remote icon is original, currentColor SVG that respects size', () => {
  const html = render(React.createElement(plugin.components.RemoteIcon, { size: 18, active: true }))
  assert.match(html, /<svg[^>]*width="18"[^>]*height="18"/)
  assert.match(html, /stroke="currentColor"/)
  assert.doesNotMatch(html, /fill="#/)
})

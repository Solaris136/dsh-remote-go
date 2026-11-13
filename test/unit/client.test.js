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
 *
 * `options.fetch` is installed as the sandbox's global `fetch`, which the client
 * resolves per request through `getFetch()`; that is what lets a unit test drive
 * the real API layer (`api.openHost`) instead of matching source text.
 * @param {{ fetch?: (input: any, init?: any) => Promise<any> }} [options]
 */
function loadClientPlugin(options = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: options.fetch,
  }
  sandbox.window = {
    fetch: options.fetch,
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

/**
 * Every `data-testid="…"` value in static markup.
 * @param {string} markup
 * @returns {string[]}
 */
function testIdsOf(markup) {
  /** @type {string[]} */
  const ids = []
  const marker = 'data-testid="'
  let from = 0
  for (;;) {
    const start = markup.indexOf(marker, from)
    if (start === -1) break
    const valueStart = start + marker.length
    const end = markup.indexOf('"', valueStart)
    if (end === -1) break
    ids.push(markup.slice(valueStart, end))
    from = end + 1
  }
  return ids
}

/**
 * Every `src="…"` attribute value in static markup.
 *
 * Structural extraction (no pattern matching on the URL itself): the assertions
 * then parse each value and compare protocol/host/port, so a lookalike host cannot
 * satisfy them the way a substring test could.
 * @param {string} markup
 * @returns {string[]}
 */
function srcAttributes(markup) {
  const marker = 'src="'
  /** @type {string[]} */
  const values = []
  let from = 0
  for (;;) {
    const start = markup.indexOf(marker, from)
    if (start === -1) break
    const valueStart = start + marker.length
    const end = markup.indexOf('"', valueStart)
    if (end === -1) break
    // Attribute serialization escapes `&`; a URL comparison needs the literal.
    values.push(markup.slice(valueStart, end).split('&amp;').join('&'))
    from = end + 1
  }
  return values
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
  assert.equal(typeof plugin.components.WizardDialog, 'function')
  assert.equal(typeof plugin.components.DiagnoseDrawer, 'function')
  assert.equal(typeof plugin.components.SettingsModal, 'function')
  assert.equal(typeof plugin.components.PasswordPrompt, 'function')
  assert.equal(typeof plugin.components.SettingsSection, 'function')
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

test('apply registers the main panel, the settings section and the sidebar panel icon', () => {
  const { calls } = runApply(plugin)
  assert.deepEqual(calls.injects, ['main', 'settings.section', 'sidebar.panellist'])
  assert.equal(calls.registers.length, 3)
  // The sidebar gains exactly one global-panel icon (the way back to a remote);
  // host management stays in Settings and no workspace-list entry is registered.
  assert.ok(!calls.injects.includes('sidebar.workspaces'), 'no sidebar workspace entry may be registered')
  assert.ok(!calls.injects.includes('sidebar.footer.action'), 'no footer action may be registered')

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

  const entry = calls.registers.find((registerCall) => registerCall.options.name === 'sidebar.panellist')
  assert.ok(entry, 'the sidebar panel icon must be registered')
  assert.equal(entry.options.id, PANEL_ID, 'the icon id must address the main panel')
  assert.equal(entry.component, plugin.components.RemotePanelIcon)
  // The row opens host management, so its label names that page, not the mode.
  assert.equal(entry.options.label(), '远程主机')
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

test('client code never logs and never persists remote URLs / tokens', () => {
  assert.doesNotMatch(SOURCE, /console\.(log|debug|info|warn|error)\s*\(/)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*token/i)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*url/i)
  // Every fetch call is centralised in the one API helper that adds the header.
  assert.match(SOURCE, /'x-dsh-remote-go':\s*'1'/)
  assert.match(SOURCE, /credentials:\s*'same-origin'/)
  assert.match(SOURCE, /const LOOPBACK_PREFIX = 'http:\/\/127\.0\.0\.1:'/)
  assert.match(SOURCE, /url\.startsWith\(LOOPBACK_PREFIX\)/)
})

test('the client embeds no remote page and opens no extra window', () => {
  // The embedded-panel presentation is gone: the remote UI only ever reaches the
  // desktop browser guest, so no iframe element, sandbox attribute or
  // window.open call may survive in the client half.
  assert.doesNotMatch(SOURCE, /h\(\s*'iframe'/, 'no iframe element may be rendered')
  assert.doesNotMatch(SOURCE, /IFRAME_SANDBOX/, 'no iframe sandbox may be configured')
  assert.doesNotMatch(SOURCE, /window\.open\s*\(/, 'the client must not open an external window')
  assert.doesNotMatch(SOURCE, /sandbox:?\s*['"]allow-scripts/, 'no iframe sandbox attribute may remain')
  assert.doesNotMatch(SOURCE, /RemoteViewport/, 'the embedded viewport component must be gone')
  // The loopback guard itself is still enforced before a URL reaches the guest.
  assert.match(SOURCE, /function isValidLoopbackUrl\(url\)/)
})

// ---------------------------------------------------------------------------
// 4. key component renders (react-dom/server)
// ---------------------------------------------------------------------------

test('openHost rejects a non-loopback remote URL (API-layer guard)', async () => {
  // Drive the real `api.openHost` through a stubbed transport. The positive
  // control matters: a test that only checks rejection would also pass if the
  // method rejected everything.
  const requests = []
  /** @type {string} */
  let answer = 'http://127.0.0.1:54321/?token=abc123'
  const client = loadClientPlugin({
    fetch: async (endpoint) => {
      requests.push(String(endpoint))
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, url: answer, localPort: 54321, address: '127.0.0.1:54321' }
        },
      }
    },
  })
  assert.equal(typeof client.api?.openHost, 'function', 'client.js must expose the Host-API client for this test')

  const allowed = await client.api.openHost('h_test')
  assert.equal(allowed, 'http://127.0.0.1:54321/?token=abc123')
  assert.equal(requests.at(-1), '/dsh-remote-go/api/hosts/h_test/open')

  for (const refusedUrl of [
    'https://evil.example.com/?token=secret',
    'http://10.0.0.5:54321/?token=secret',
    'http://localhost:54321/?token=secret',
    'http://127.0.0.1.evil.example.com/?token=secret',
  ]) {
    answer = refusedUrl
    await assert.rejects(client.api.openHost('h_test'), (error) => {
      assert.equal(error?.view?.code, 'blocked-url', `unexpected error view for ${refusedUrl}`)
      // The refused URL must not be echoed back: compare the whole message with
      // the documented localized detail instead of searching for host text.
      assert.equal(error?.message, '远端地址不是本地回环地址，出于安全考虑已阻止。')
      return true
    })
  }
})

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

test('the panel stays a host manager: no separate takeover surface, no remote page', () => {
  const host = hostView()
  const html = render(
    React.createElement(plugin.components.MainPanel, {
      t,
      getLocaleId: () => 'zh',
      openPanel: () => {},
      closePanel: () => {},
      initialState: {
        hostVersion: '0.2.2-rc.1',
        targetVersion: '0.2.2-rc.1',
        hosts: [host],
        settings: {},
        activeHostId: host.id,
        firstRun: false,
      },
    }),
  )
  // Connecting takes the window over as a side effect; the panel itself is the host
  // page only and never renders the remote page.
  assert.match(html, /data-testid="host-list"/)
  assert.doesNotMatch(html, /data-testid="workspace-rail"/)
  assert.doesNotMatch(html, /data-testid="overlay-surface"/)
  assert.doesNotMatch(html, /<iframe/)
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
    settings: { defaultPort: 22, defaultAuth: 'key', hostKeyPolicy: 'first-use', autoReconnect: { enabled: true } },
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
  // Key files and passwords are the only methods; the agent choice is gone.
  assert.match(html, /密钥文件/)
  assert.doesNotMatch(html, /SSH Agent/)
  assert.match(html, /远端存活策略/)
  // The key path starts at the documented default and can be picked from disk.
  assert.match(html, /value="~\/\.ssh\/id_ed25519"/)
  assert.match(html, /data-testid="wizard-key-path-pick"/)
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
    mirrorToSidebar: true,
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
  // The embedded-panel presentation choice is gone: the window takeover is the
  // only way a remote UI is shown, so no mode selector may be offered.
  assert.doesNotMatch(html, /呈现形态/)
  assert.doesNotMatch(html, /面板内嵌/)
  assert.match(html, /关闭视窗行为/)
  assert.match(html, /主机指纹策略/)
  assert.match(html, /允许保存访问令牌/)
  assert.match(html, /风险提示|0600/)
  assert.match(html, /镜像会话/)
  assert.match(html, /显示在本地侧边栏/)
  assert.match(html, /自举/)
  assert.match(html, /保存设置/)
})

test('main panel renders its loading state inside the DSH theme root', () => {
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

test('mirror polling settles on a real signal and is bounded', () => {
  const policy = plugin.mirrorPolling
  assert.equal(typeof policy.settled, 'function')
  /** @param {object} overrides */
  const row = (overrides) => ({ level: 'L2', readOnly: false, workspaceId: 'ws-sim', ...overrides })

  // Pre-replay list: descriptors planned at L2, none read-only yet -> keep polling.
  assert.equal(policy.settled([row(), row()]), false)
  // Replay landed (even one read-only mirror is enough): stop.
  assert.equal(policy.settled([row(), row({ readOnly: true })]), true)
  // Nothing planned at L2: replay is not in flight, so stop.
  assert.equal(policy.settled([row({ level: 'L1' })]), true)
  // An empty list is not settled: the descriptors may not be written yet.
  assert.equal(policy.settled([]), false)
  assert.equal(policy.settled(null), false)

  // A real budget, not a single fixed delay: the deadline tolerates a slow replay
  // but still ends (a host that never replays must stop polling).
  assert.ok(policy.deadlineMs >= 30_000, `the poll deadline is too short: ${policy.deadlineMs}`)
  assert.ok(policy.deadlineMs <= 60_000, `the poll deadline is unbounded in practice: ${policy.deadlineMs}`)
  assert.ok(policy.intervalMs >= 500, `the poll interval is too aggressive: ${policy.intervalMs}`)
})

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
    // Key-file authentication: the default path field and its picker buttons.
    'settings-default-key-path',
    'settings-default-key-path-pick',
    'wizard-key-path-pick',
    'settings-remote-section',
    'settings-host-add',
    'settings-host-open',
    'settings-settings-open',
    'error-card',
    'error-retry',
    'fingerprint-card',
    'fingerprint-accept',
    'password-prompt',
  ]
  const ids = new Set(Object.values(markup).flatMap(testIdsOf))
  for (const id of required) assert.ok(ids.has(id), 'missing data-testid="' + id + '"')
  assert.match(markup.list, /data-host-id="h_test"/)
  assert.match(markup.password, /type="password"/)
  // With no credential store in the test composition, the prompt says so instead of
  // promising a save it cannot perform.
  assert.match(markup.password, /没有可用的凭据存储|凭据存储/)
  assert.doesNotMatch(JSON.stringify(markup), /dsh-remote-go-sidebar/)
})

test('the sidebar panel icon draws the remote glyph at the row size', () => {
  const plain = render(React.createElement(plugin.components.RemotePanelIcon, { size: 22, active: false }))
  assert.match(plain, /<svg[^>]*width="22"[^>]*height="22"/)
  const active = render(React.createElement(plugin.components.RemotePanelIcon, { size: 16, active: true }))
  assert.match(active, /<svg[^>]*width="16"[^>]*height="16"/)
  // A missing size must not render a zero-width glyph.
  const fallback = render(React.createElement(plugin.components.RemotePanelIcon, {}))
  assert.match(fallback, /<svg[^>]*width="18"[^>]*height="18"/)
})

test('remote icon is original, currentColor SVG that respects size', () => {
  const html = render(React.createElement(plugin.components.RemoteIcon, { size: 18, active: true }))
  assert.match(html, /<svg[^>]*width="18"[^>]*height="18"/)
  assert.match(html, /stroke="currentColor"/)
  assert.doesNotMatch(html, /fill="#/)
})

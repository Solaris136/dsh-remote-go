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
    document: options.document,
  }
  sandbox.window = {
    fetch: options.fetch,
    dshDesktop: options.desktop,
    document: options.document,
    innerHeight: 800,
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

/**
 * Minimal DOM for the imperative takeover carrier: elements with attributes,
 * inline style, children, listeners and a body. Enough to build and inspect the
 * carrier inside the VM without adding a DOM implementation to the dev
 * dependencies. `style` is a plain bag: the carrier only assigns cssText and
 * individual background values, it never reads computed styles.
 * @returns {{ body: object, createElement: Function, createElementNS: Function }}
 */
function fakeDocument() {
  /** @param {string} tag */
  const create = (tag) => ({
    tagName: String(tag).toUpperCase(),
    attributes: {},
    children: [],
    listeners: {},
    className: '',
    textContent: '',
    title: '',
    id: '',
    type: '',
    parentNode: null,
    style: {},
    /** @param {string} name @param {string} value */
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    /** @param {object} child */
    appendChild(child) {
      child.parentNode = this
      this.children.push(child)
      return child
    },
    /** @param {...object} items */
    append(...items) {
      for (const item of items) this.appendChild(item)
    },
    /** @param {object} child */
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler) {
      this.listeners[type] = handler
    },
    click() {
      if (typeof this.listeners.click === 'function') this.listeners.click({ target: this })
    },
    get firstChild() {
      return this.children.length > 0 ? this.children[0] : null
    },
  })
  const body = create('body')
  return {
    body,
    listeners: {},
    createElement: create,
    createElementNS: (namespace, tag) => create(tag),
    addEventListener(type, handler) {
      this.listeners[type] = handler
    },
    removeEventListener(type) {
      delete this.listeners[type]
    },
  }
}

/**
 * A DOM rich enough for the injected host switcher: elements with attributes, classes,
 * children, listeners and a rect; a document whose `querySelectorAll` answers the two
 * lookups the row uses to find the sidebar; a `head` for its stylesheet.
 * @param {{ sidebarWidth?: number, brand?: boolean, hostRowStyle?: boolean }} [options]
 * @returns {{ document: object, column: object, brand: object|null, head: object }}
 */
function fakeDom(options = {}) {
  const columnWidth = options.sidebarWidth === undefined ? 280 : options.sidebarWidth
  /** @param {string} tag */
  const create = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      attributes: {},
      children: [],
      listeners: {},
      className: '',
      textContent: '',
      title: '',
      id: '',
      parentNode: null,
      style: {},
      rect: { left: 0, top: 0, width: columnWidth, height: 800, right: columnWidth, bottom: 800 },
      get firstChild() {
        return this.children.length > 0 ? this.children[0] : null
      },
      get nextSibling() {
        if (this.parentNode === null) return null
        const index = this.parentNode.children.indexOf(this)
        return index >= 0 && index + 1 < this.parentNode.children.length ? this.parentNode.children[index + 1] : null
      },
      classList: {
        add(name) {
          if (!node.className.split(' ').includes(name)) node.className = (node.className + ' ' + name).trim()
        },
        remove(name) {
          node.className = node.className
            .split(' ')
            .filter((part) => part !== name)
            .join(' ')
        },
        contains(name) {
          return node.className.split(' ').includes(name)
        },
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
      },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        return child
      },
      append(...items) {
        for (const item of items) this.appendChild(item)
      },
      insertBefore(child, reference) {
        child.parentNode = this
        const at = reference === null ? this.children.length : this.children.indexOf(reference)
        if (at < 0) this.children.push(child)
        else this.children.splice(at, 0, child)
        return child
      },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        child.parentNode = null
        return child
      },
      /** @param {string} type @param {Function} handler */
      addEventListener(type, handler) {
        if (!this.listeners[type]) this.listeners[type] = []
        this.listeners[type].push(handler)
      },
      removeEventListener() {},
      /** @param {object} candidate */
      contains(candidate) {
        let node2 = candidate
        while (node2) {
          if (node2 === this) return true
          node2 = node2.parentNode
        }
        return false
      },
      getBoundingClientRect() {
        return this.rect
      },
    }
    return node
  }

  const head = create('head')
  const body = create('body')
  const column = create('div')
  column.rect = { left: 0, top: 40, width: columnWidth, height: 760, right: columnWidth, bottom: 800 }
  body.appendChild(column)
  let brand = null
  if (options.brand !== false) {
    brand = create('div')
    brand.setAttribute('data-window-drag', 'true')
    brand.rect = { left: 0, top: 40, width: columnWidth, height: 40, right: columnWidth, bottom: 80 }
    column.appendChild(brand)
  }
  const region = create('div')
  region.rect = { left: 0, top: 80, width: columnWidth, height: 700, right: columnWidth, bottom: 780 }
  column.appendChild(region)

  const document = {
    head,
    body,
    createElement: create,
    createElementNS: (namespace, tag) => create(tag),
    addEventListener(type, handler) {
      this.listeners = this.listeners || {}
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener() {},
    /** The two lookups `mountHostRow` performs, and nothing else. */
    querySelectorAll(selector) {
      if (selector === '[data-window-drag]') return brand === null ? [] : [brand]
      if (selector === 'div,aside,nav,section') return [column]
      return []
    },
  }
  return { document, column, brand, head }
}

/** The switcher row a fake document holds, if any. @param {{ column: object }} dom */
function rowOf(dom) {
  return dom.column.children.find((child) => child.id === 'drg-host-row') || null
}

/** Text of the row's current-target label. @param {object} row */
function rowName(row) {
  const node = row.children.find((child) => child.className === 'drg-hr-name')
  return node ? node.textContent : null
}

/** Menu entries in order, skipping the separator. @param {object} row */
function rowItems(row) {
  const menu = row.children.find((child) => child.className === 'drg-hr-menu')
  return menu.children.filter((child) => child.className === 'drg-hr-item')
}

/** @param {object} item */
function itemLabel(item) {
  const node = item.children.find((child) => child.className === 'drg-hr-item-name')
  return node ? node.textContent : null
}

/** @param {object} item */
function itemDotState(item) {
  const dot = item.children.find((child) => child.className === 'drg-hr-dot')
  return dot ? dot.getAttribute('data-state') : null
}

/** Fire a click at `target`, the way a browser would bubble it into the row. */
function clickInside(row, target) {
  for (const handler of row.listeners.click || []) handler({ target })
}

/** Minimal dictionary interpolation, mirroring the locale service. */
function interpolate(template, params) {
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
      bootstrapLevel: 'npx',
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

test('factory injects slots and locale', () => {
  const injects = Array.from(plugin.inject)
  assert.deepEqual(injects, ['slots', 'locale'])
  // No panel registration means no layout service either: the plugin draws into the shell
  // overlay layer and the sidebar it finds, never into the main column.
  assert.equal(injects.includes('layout'), false)
})

test('components export is a non-empty map of renderable functions', () => {
  assert.ok(plugin.components && typeof plugin.components === 'object')
  const names = Object.keys(plugin.components)
  assert.ok(names.length >= 10, 'expected the panel component set, got ' + names.length)
  for (const name of names) {
    assert.equal(typeof plugin.components[name], 'function', name + ' must be a component function')
  }
  assert.equal(typeof plugin.components.PluginOverlay, 'function')
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

test('apply registers only the overlay host and the settings section', () => {
  const { calls } = runApply(plugin)
  assert.deepEqual(calls.injects, ['shell.overlay', 'settings.section'])
  assert.equal(calls.registers.length, 2)
  // Nothing takes the main column and nothing takes a sidebar row: the switcher row and
  // the floating windows are the plugin's whole surface.
  assert.ok(!calls.injects.includes('main'), 'the plugin must not own the main column')
  assert.ok(!calls.injects.includes('sidebar.panellist'), 'no global-panel row may be registered')
  assert.ok(!calls.injects.includes('sidebar.workspaces'), 'no sidebar workspace entry may be registered')
  assert.ok(!calls.injects.includes('sidebar.footer.action'), 'no footer action may be registered')

  // Everything floats in the shell overlay layer, above a remote window.
  const overlay = calls.registers.find((entry) => entry.options.name === 'shell.overlay')
  assert.ok(overlay, 'the overlay host must be registered')
  assert.equal(overlay.component, plugin.components.PluginOverlay)
  assert.equal(overlay.options.locale, PANEL_ID)

  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section, 'settings.section entry must be registered')
  assert.equal(section.options.id, PANEL_ID)
  assert.equal(section.options.order, 45)
  assert.equal(section.options.locale, PANEL_ID)
  assert.equal(section.component, plugin.components.SettingsSection)
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), '远程主机')
})

test('shared inject face carries the command channels, not a panel', () => {
  const { calls } = runApply(plugin)
  const overlay = calls.registers.find((entry) => entry.options.name === 'shell.overlay')
  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  assert.equal(typeof overlay.options.inject, 'function')
  assert.equal(typeof section.options.inject, 'function')
  const face = overlay.options.inject()
  assert.equal(typeof face.getLocaleId, 'function')
  assert.equal(face.getLocaleId(), 'zh')
  assert.equal(face.openPanel, undefined, 'there is no panel to select any more')
  assert.ok(face.panelStore && typeof face.panelStore.request === 'function')
  assert.ok(face.wizardStore && typeof face.wizardStore.open === 'function')
  assert.equal(typeof face.openWizard, 'function')

  // The panel store carries one command at a time.
  face.panelStore.request('h_test')
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'open', hostId: 'h_test' })
  assert.equal(face.panelStore.take(), null)
  face.panelStore.requestIntent({ kind: 'manage' })
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'manage' })
  face.panelStore.requestIntent({ kind: 'local' })
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'local' })
  face.panelStore.requestIntent({ kind: 'open' })
  assert.equal(face.panelStore.take(), null, 'an open intent without a host is refused')

  // The wizard store opens and closes one draft.
  face.openWizard({ mode: 'edit', host: { id: 'h_test' } })
  assert.deepEqual({ ...face.wizardStore.current() }, { mode: 'edit', host: { id: 'h_test' } })
  face.wizardStore.close()
  assert.equal(face.wizardStore.current(), null)
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
    'host-key-confirm',
    'auth-checking',
    'probing',
    'downloading-node',
    'installing-node',
    'bootstrapping',
    'bootstrap-first-run',
    'bootstrap-fetching',
    'bootstrap-installed',
    'bootstrap-progress',
    'starting-remote',
    'tunneling',
    'verifying',
    'ready',
    'reconnecting',
    'remote-dsh-running',
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

test('the overlay host takes no page of its own until a window is asked for', () => {
  const host = hostView()
  const html = render(
    React.createElement(plugin.components.PluginOverlay, {
      t,
      getLocaleId: () => 'zh',
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
  // The plugin owns no page: closed windows render nothing but the theme root.
  assert.match(html, /data-testid="dsh-remote-go-overlay-host"/)
  assert.doesNotMatch(html, /data-testid="host-list"/)
  assert.doesNotMatch(html, /data-testid="manage-window"/)
  assert.doesNotMatch(html, /<div class="drg-modal-layer"/)
  assert.doesNotMatch(html, /<iframe/)
})

test('the plugin never selects a main panel or renders the remote page itself', () => {
  // docs/design.md §4: the switcher row and the floating windows are the whole surface;
  // the remote UI only ever reaches the desktop guest. No page can be taken over.
  assert.doesNotMatch(SOURCE, /selectPanel/, 'the plugin must not select a layout panel')
  assert.doesNotMatch(SOURCE, /'main'/, 'the plugin must not register the main slot')
  assert.doesNotMatch(SOURCE, /<iframe|h\(\s*'iframe'/, 'no iframe may be rendered')
  // The takeover still has one explicit trigger: opening a host from the row or the list.
  assert.match(SOURCE, /const openHost = \(host\) => \{[\s\S]*?setTarget\(host\.id\)/)
})

test('the warm pool keeps every opened host and the last request wins a race', async () => {
  // No count limit: every host you have opened keeps its window.
  const doc = fakeDocument()
  const released = []
  let lease = 0
  const takeover = loadClientPlugin({
    document: doc,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-' + (lease += 1), partition: 'persist:dsh-remote-go:' + lease }),
        release: async (id) => released.push(id),
      },
    },
  })
  const url = (hostId) => 'http://127.0.0.1:43210/?token=' + hostId
  try {
    for (const hostId of ['h_a', 'h_b', 'h_c', 'h_d']) {
      const opened = await takeover.carrier.open({ hostId, url: url(hostId) })
      assert.equal(opened.ok, true, hostId + ' must open')
      assert.equal(opened.reused, false)
    }
    assert.equal(doc.body.children.length, 4, 'all four windows stay mounted')
    for (const hostId of ['h_a', 'h_b', 'h_c', 'h_d']) {
      assert.equal(takeover.carrier.warm(hostId), true, hostId + ' must stay warm')
    }
    assert.equal(takeover.carrier.shown(), 'h_d')

    // Switching back is a show, not a reload.
    const again = await takeover.carrier.open({ hostId: 'h_a' })
    assert.equal(again.reused, true)
    assert.equal(takeover.carrier.shown(), 'h_a')
    assert.deepEqual(released, [], 'nothing may be released while a host is still up')

    // Two opens in the same tick: the later one is what the window ends up on, and the
    // window built for the earlier request is dropped instead of stealing it.
    const [first, second] = await Promise.all([
      takeover.carrier.open({ hostId: 'h_e', url: url('h_e') }),
      takeover.carrier.open({ hostId: 'h_f', url: url('h_f') }),
    ])
    assert.deepEqual({ ok: first.ok, reason: first.reason }, { ok: false, reason: 'superseded' })
    assert.equal(second.ok, true)
    assert.equal(takeover.carrier.shown(), 'h_f')
    assert.equal(takeover.carrier.warm('h_e'), false, 'a superseded window must not linger')
    assert.equal(doc.body.children.length, 5, 'children: ' + doc.body.children.map((node) => node.id).join(','))
  } finally {
    await takeover.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.equal(released.length, 6, 'every lease is handed back, including the superseded one')
})

test('the takeover carrier hands the window to the guest and injects the switcher', async () => {
  const doc = fakeDocument()
  const released = []
  const takeover = loadClientPlugin({
    document: doc,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }),
        release: async (lease) => released.push(lease),
      },
    },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
  const hosts = [
    hostView({ id: 'h_a', name: '43.133.80.40', address: '43.133.80.40' }),
    hostView({ id: 'h_b', name: '生产机 ubuntu', address: 'ubuntu@10.0.0.7' }),
  ]
  try {
    const result = await takeover.carrier.open({
      hostId: 'h_a',
      url: 'http://127.0.0.1:43210/?token=abc',
      message: '远端界面加载失败',
    })
    assert.equal(result.ok, true)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    assert.ok(root, 'the carrier must be mounted on document.body')
    // Whole window, no local chrome: style + guest + the load-error line only. The host
    // switcher lives inside the page, so there is nothing local to render.
    assert.match(root.style.cssText, /left:0/)
    assert.equal(root.children.length, 3)
    assert.equal(
      root.children.some((node) => node.className === 'drg-carrier-bar'),
      false,
    )
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    assert.ok(view, 'the guest must be mounted')
    assert.equal(view.tagName, 'WEBVIEW')

    // The row script is injected after the guest settles; a state push follows it.
    const calls = []
    view.executeJavaScript = (code) => {
      calls.push(code)
      return Promise.resolve(code.includes('function mountHostRow') ? 'installed' : null)
    }
    view.listeners['did-stop-loading']()
    await settle()
    assert.ok(
      calls.some((code) => code.includes('function mountHostRow')),
      'the injected row script must run inside the guest',
    )

    takeover.carrier.update({ hosts, current: 'h_a' })
    await settle()
    assert.ok(
      calls.some((code) => code.includes('43.133.80.40') && code.includes('生产机 ubuntu')),
      'the host list must be pushed into the injected row',
    )
    assert.ok(
      calls.some((code) => code.includes('"current":"h_a"')),
      'the current target must be pushed too',
    )
    // The session title line is gone: the row names the target and nothing else.
    assert.equal(
      calls.some((code) => code.includes('drg-hr-title')),
      false,
    )

    // A guest reload wipes the injected DOM, so every load stop re-installs it: the
    // control must never disappear.
    const scriptRuns = calls.filter((code) => code.includes('function mountHostRow')).length
    view.listeners['did-stop-loading']()
    await settle()
    assert.equal(calls.filter((code) => code.includes('function mountHostRow')).length, scriptRuns + 1)
  } finally {
    await takeover.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('the switcher row is drawn into the local sidebar and lists local, hosts and the actions', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  const connected = hostView({ id: 'h_a', name: '43.133.80.40', address: '43.133.80.40', status: 'connected' })
  const idle = hostView({ id: 'h_b', name: '生产机 ubuntu', address: 'ubuntu@10.0.0.7', status: 'disconnected' })

  local.carrier.update({
    hosts: [connected, idle],
    labels: { local: '本地', addHost: '添加主机', manage: '管理界面' },
  })

  const row = rowOf(dom)
  assert.ok(row, 'the row must be placed in the local sidebar')
  assert.equal(row.parentNode, dom.column)
  // The row sits right under the brand row, exactly like the copy in the remote page.
  assert.equal(dom.brand.nextSibling, row)
  assert.equal(rowName(row), '本地', 'the closed row names the current target only')
  const menu = row.children.find((child) => child.className === 'drg-hr-menu')
  assert.equal(
    menu.children.filter((child) => child.className === 'drg-hr-title').length,
    0,
    'the session-title line is gone',
  )

  const items = rowItems(row)
  assert.deepEqual(items.map(itemLabel), ['本地', '43.133.80.40', '生产机 ubuntu', '添加主机', '管理界面'])
  // A connected host carries the glowing green dot; the rest keep their status tone.
  assert.equal(itemDotState(items[0]), 'local')
  assert.equal(itemDotState(items[1]), 'connected')
  assert.equal(itemDotState(items[2]), 'disconnected')
  assert.equal(items[0].getAttribute('data-active'), '1')
  assert.equal(items[1].getAttribute('data-target'), 'h_a')
  assert.equal(items[2].getAttribute('data-target'), 'h_b')
  assert.equal(items[3].getAttribute('data-action'), 'add')
  assert.equal(items[4].getAttribute('data-action'), 'manage', 'management is the last entry')
  // An action carries a glyph where a target carries its connection dot.
  for (const action of [items[3], items[4]]) {
    assert.ok(
      action.children.some((child) => child.className === 'drg-hr-glyph'),
      'an action must not look like an unconnected host',
    )
  }
  // One separator, after the hosts and before the two actions; no refresh/exit entries.
  const kinds = menu.children.map((child) => child.className)
  assert.deepEqual(kinds, ['drg-hr-item', 'drg-hr-item', 'drg-hr-item', 'drg-hr-sep', 'drg-hr-item', 'drg-hr-item'])
})

test('the switcher menu opens on the row, closes on a second click and on a pick', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  local.carrier.update({
    hosts: [hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })],
    labels: { local: '本地', addHost: '添加主机', manage: '管理界面' },
  })
  const row = rowOf(dom)
  clickInside(row, row)
  assert.equal(row.getAttribute('aria-expanded'), 'true')
  assert.equal(row.classList.contains('drg-open'), true)
  const menu = row.children.find((child) => child.className === 'drg-hr-menu')
  // The sidebar clips its children, so the menu is fixed and anchored under the row.
  assert.equal(menu.style.top, '804px')
  assert.equal(menu.style.width, '280px')

  clickInside(row, row)
  assert.equal(row.getAttribute('aria-expanded'), 'false')
  clickInside(row, row)
  clickInside(row, rowItems(row)[1])
  assert.equal(row.getAttribute('aria-expanded'), 'false', 'a pick closes the menu')

  // A deleted host must not leave the row naming a target that no longer exists.
  local.carrier.update({ hosts: [] })
  assert.equal(rowName(row), '本地')
  assert.deepEqual(rowItems(row).map(itemLabel), ['本地', '添加主机', '管理界面'])
})

test('the guest script installs the same row and leaves intents on the page bridge', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  const script = local.carrier.script()
  assert.match(script, /^\(function mountHostRow\(win\)/)

  // The guest is a foreign page: no sink, so the row queues intents on `window.__drgBridgeQueue`.
  const guestDom = fakeDom()
  const guestWindow = { document: guestDom.document, innerHeight: 800 }
  const factory = new Function('window', 'return ' + script)
  assert.equal(factory(guestWindow), 'installed')
  guestWindow.__drgHostRow.update({
    hosts: [hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })],
    current: 'h_a',
    labels: { local: '本地', addHost: '添加主机', manage: '管理界面' },
  })
  const row = rowOf(guestDom)
  assert.ok(row, 'the guest row must be placed in the guest sidebar')
  assert.equal(rowName(row), '43.133.80.40')
  const items = rowItems(row)
  clickInside(row, items[items.length - 2])
  // Two clicks inside one poll must both survive: the queue is drained in order.
  clickInside(row, items[items.length - 1])
  clickInside(row, items[0])
  assert.deepEqual(guestWindow.__drgBridgeQueue, [{ action: 'add' }, { action: 'manage' }, { target: 'local' }])
  // A live host carries its own exit control on the row, right after the address.
  const exit = items[1].children.find((child) => child.className === 'drg-hr-act')
  assert.ok(exit, 'a connected host must expose an exit control')
  assert.equal(exit.textContent, 'Exit remote')
  assert.equal(exit.getAttribute('data-action'), 'disconnect')
  assert.equal(exit.getAttribute('data-host-id'), 'h_a')
})

test('the exit control disconnects that host instead of switching to it', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  const { calls } = runApply(local)
  local.carrier.update({
    hosts: [
      hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' }),
      hostView({ id: 'h_b', name: '生产机', status: 'disconnected' }),
    ],
    labels: { local: '本地', addHost: '添加主机', manage: '管理界面', exit: '断开' },
  })
  const row = rowOf(dom)
  const items = rowItems(row)
  // Only a connected host is worth leaving; a disconnected one has nothing to close.
  const exitA = items[1].children.find((child) => child.className === 'drg-hr-act')
  const exitB = items[2].children.find((child) => child.className === 'drg-hr-act')
  assert.ok(exitA, 'the connected host must carry the exit control')
  assert.equal(exitB, undefined, 'a host that is not up must not')
  assert.equal(exitA.textContent, '断开')

  clickInside(row, exitA)
  const face = calls.registers.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'disconnect', hostId: 'h_a' })
  assert.equal(rowName(row), '本地', 'leaving a host must not switch to it')
})

test('apply installs the local switcher row with the dictionary labels', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  const { calls } = runApply(local)
  const row = rowOf(dom)
  assert.ok(row, 'apply must place the switcher row')
  assert.equal(rowName(row), '本地')
  assert.deepEqual(rowItems(row).map(itemLabel), ['本地', '添加主机', '管理界面'])

  // Local is always first: it is how the window gets back from a remote.
  const face = calls.registers.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  clickInside(row, rowItems(row)[0])
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'local' }, 'picking local hands the window back')

  // A host click goes to the overlay host, which decides how to show it.
  local.carrier.update({ hosts: [hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })] })
  clickInside(row, rowItems(row)[1])
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'open', hostId: 'h_a' })
  assert.equal(rowName(row), '43.133.80.40')

  // Add-host opens the wizard; management asks the overlay host for the floating list.
  clickInside(row, rowItems(row).at(-2))
  assert.deepEqual({ ...face.wizardStore.current() }, { mode: 'add', host: null })
  face.wizardStore.close()
  assert.equal(face.wizardStore.current(), null)
  clickInside(row, rowItems(row).at(-1))
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'manage' })
  // No page is ever selected: the plugin owns no main column.
  assert.deepEqual(calls.selectPanel, [])
})

test('opening a host or a window from the remote keeps the remote behind it', async () => {
  // Picking a host anywhere — including from the remote page's own switcher — must not
  // hand the window back to the local page. Only "local" does that.
  const dom = fakeDom()
  const released = []
  const local = loadClientPlugin({
    document: dom.document,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }),
        release: async (lease) => released.push(lease),
      },
    },
  })
  const { calls } = runApply(local)
  const face = calls.registers.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  const roots = () =>
    dom.document.body.children.filter((node) => String(node.id).indexOf('dsh-remote-go-overlay-') === 0)

  const opened = await local.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
  assert.equal(opened.ok, true)
  assert.equal(opened.reused, false)
  assert.equal(roots().length, 1)
  await local.carrier.update({ hosts: [hostView({ id: 'h_a', status: 'connected' })], current: 'h_a' })
  assert.equal(local.carrier.shown(), 'h_a')

  const row = rowOf(dom)
  assert.ok(row, 'the row must be installed in the local page')

  // Management and the wizard are floating windows: the remote stays shown behind them.
  clickInside(row, rowItems(row).at(-1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'manage' })
  assert.equal(local.carrier.shown(), 'h_a', 'the remote must stay in front of the local page')

  clickInside(row, rowItems(row).at(-2))
  assert.deepEqual({ ...face.wizardStore.current() }, { mode: 'add', host: null })
  assert.equal(local.carrier.shown(), 'h_a', 'the wizard floats over the remote')
  face.wizardStore.close()

  // Only "local" hands the window back, and it keeps the guest warm.
  clickInside(row, rowItems(row)[0])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'local' })
  assert.equal(local.carrier.shown(), null)
  assert.equal(local.carrier.warm('h_a'), true, 'the window stays warm for the next visit')
  const hidden = roots()[0]
  assert.equal(hidden.style.display, 'none')

  // Coming back is a show, not a reload.
  const again = await local.carrier.open({ hostId: 'h_a' })
  assert.equal(again.reused, true)
  assert.equal(roots().length, 1)
  assert.notEqual(roots()[0].style.display, 'none')

  await local.carrier.close()
  assert.equal(roots().length, 0)
  assert.deepEqual(released, ['lease-1'])
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
    language: 'auto',
    logLevel: 'info',
    bootstrap: { profile: 'web' },
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
  assert.match(html, /主机指纹策略/)
  assert.match(html, /允许保存访问令牌/)
  assert.match(html, /风险提示|0600/)
  // The fixed "window / close behavior" block and the sidebar mirroring toggle are
  // gone: neither had a real choice after the whole-window takeover.
  assert.doesNotMatch(html, /关闭视窗行为/)
  assert.doesNotMatch(html, /镜像会话/)
  assert.doesNotMatch(html, /显示在本地侧边栏/)
  assert.match(html, /远端运行时/)
  assert.match(html, /DSH profile/)
  // The plugin state directory is fixed under ~/.dsh now, so it is not a field.
  assert.doesNotMatch(html, /插件远端目录/)
  assert.match(html, /保存设置/)
})

test('conflict prompt lists the foreign processes and offers three actions', () => {
  const html = render(
    React.createElement(plugin.components.RemoteConflictPrompt, {
      t,
      host: {
        id: 'h1',
        name: 'Tencent VM',
        conflict: { detectedAt: '2026-11-14T00:00:00Z', processes: [{ pid: 42, command: 'dsh web' }] },
      },
      onResolve: () => {},
    }),
  )
  assert.match(html, /远端已有手工启动的 DSH/)
  assert.match(html, /pid 42/)
  assert.match(html, /dsh web/)
  assert.match(html, /停止它并启动受管实例/)
  assert.match(html, /保留它，另起一个/)
  assert.match(html, /取消连接/)
  assert.match(html, /data-testid="remote-conflict-prompt"/)
})

test('the overlay host carries the theme root and the stylesheet', () => {
  const html = render(
    React.createElement(plugin.components.PluginOverlay, {
      t,
      getLocaleId: () => 'zh',
    }),
  )
  assert.match(html, /class="drg-root drg-overlay"/)
  assert.match(html, /data-testid="dsh-remote-go-overlay-host"/)
  assert.match(html, /data-dsh-remote-go="styles"/)
  assert.match(html, /--dsw-alias-label-primary/)
  // The overlay seat must float above a remote window.
  assert.match(html, /\[data-shell-overlay\] \{ z-index: 2147483001; \}/)
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
    overlay: render(React.createElement(plugin.components.PluginOverlay, { t, getLocaleId: () => 'zh' })),
    settingsSection: render(
      React.createElement(plugin.components.SettingsSection, {
        t,
        initialState: baseState,
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
    'dsh-remote-go-overlay-host',
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

test('remote icon is original, currentColor SVG that respects size', () => {
  const html = render(React.createElement(plugin.components.RemoteIcon, { size: 18, active: true }))
  assert.match(html, /<svg[^>]*width="18"[^>]*height="18"/)
  assert.match(html, /stroke="currentColor"/)
  assert.doesNotMatch(html, /fill="#/)
})

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

function loadClientPlugin(options = {}) {
  const sandbox = {
    console,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    fetch: options.fetch,
    document: options.document,
    getComputedStyle: options.getComputedStyle,
    // `URL` is a browser/Node global the module uses for origin checks; a bare vm context has no
    // such web API, so the sandbox models the browser unless a test injects its own constructor.
    URL: options.URL || URL,
    EventSource: options.EventSource,
  }
  sandbox.window = {
    fetch: options.fetch,
    dshDesktop: options.desktop,
    document: options.document,
    open: options.open,
    innerHeight: 800,
    __ModuleLoader__: {
      load(declaration) {
        sandbox.__declaration = declaration
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  // The absolute path makes V8 attribute the script to the real file, so `client.js`
  // shows up in `--experimental-test-coverage` instead of being invisible.
  vm.runInContext(SOURCE, sandbox, { filename: CLIENT_PATH })
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

function fakeDocument(options = {}) {
  // A style object that carries custom properties the way the DOM does, plus the plain
  // properties (cssText, top, display) the client writes directly.
  const style = () => {
    const values = {}
    return {
      setProperty(name, value) {
        values[name] = String(value)
      },
      getPropertyValue(name) {
        return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ''
      },
      removeProperty(name) {
        delete values[name]
      },
    }
  }
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
      type: '',
      parentNode: null,
      style: style(),
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
      },
      classList: {
        add(name) {
          const parts = node.className.split(' ').filter((part) => part !== '')
          if (!parts.includes(name)) parts.push(name)
          node.className = parts.join(' ')
        },
        remove(name) {
          node.className = node.className
            .split(' ')
            .filter((part) => part !== '' && part !== name)
            .join(' ')
        },
        contains(name) {
          return node.className.split(' ').includes(name)
        },
      },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        return child
      },
      append(...items) {
        for (const item of items) this.appendChild(item)
      },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        child.parentNode = null
        return child
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this)
      },
      addEventListener(type, handler) {
        if (!this.listeners[type]) this.listeners[type] = []
        this.listeners[type].push(handler)
      },
      click() {
        for (const handler of this.listeners.click || []) handler({ target: this })
      },
      get firstChild() {
        return this.children.length > 0 ? this.children[0] : null
      },
      select() {},
    }
    return node
  }
  const body = create('body')
  const documentElement = create('html')
  if (typeof options.captionHeight === 'string') documentElement.setAttribute('data-windows-titlebar', '')
  return {
    body,
    documentElement,
    listeners: {},
    createElement: create,
    createElementNS: (namespace, tag) => create(tag),
    execCommand: options.execCommand,
    addEventListener(type, handler) {
      this.listeners[type] = handler
    },
    removeEventListener(type) {
      delete this.listeners[type]
    },
  }
}

function fire(node, type, event) {
  for (const handler of node.listeners[type] || []) handler(event)
}

/** A click target for the capability bridge: an anchor, or the plugin's own download item. */
function fakeLinkTarget(anchor, options = {}) {
  const element = {
    closest(selector) {
      if (selector === '[data-drg-dir-download]') return options.ownDownload === true ? element : null
      if (selector === 'a[href]') return anchor
      return null
    },
  }
  return element
}

function fakeAnchor(attributes) {
  return {
    attributes,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
    },
  }
}

/** A click as the browser reports it: primary button, no modifiers unless overridden. */
function fakeClick(target, overrides = {}) {
  const event = {
    target,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true
      this.prevented = true
    },
    stopPropagation() {
      this.stopped = true
    },
    ...overrides,
  }
  return event
}

/** One origin's `localStorage`, shared by two framed pages the way a real same-origin frame is. */
function fakeStorage() {
  const map = new Map()
  return {
    map,
    get length() {
      return map.size
    },
    key(index) {
      const keys = [...map.keys()]
      return index >= 0 && index < keys.length ? keys[index] : null
    },
    getItem(key) {
      const name = String(key)
      return map.has(name) ? map.get(name) : null
    },
    setItem(key, value) {
      map.set(String(key), String(value))
    },
    removeItem(key) {
      map.delete(String(key))
    },
  }
}

/** A guest window with a recording `addEventListener`, for the storage partition. */
function fakeGuestWindow(storage) {
  const win = {
    localStorage: storage,
    listeners: {},
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
  }
  return win
}

/** The framed page's own document: enough shape for the injected row and file bridge. */
function fakeFrameDocument(options = {}) {
  const create = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      attributes: {},
      children: [],
      style: {},
      className: '',
      textContent: '',
      parentNode: null,
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
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
        const at = this.children.indexOf(child)
        if (at >= 0) this.children.splice(at, 1)
        child.parentNode = null
        return child
      },
      addEventListener() {},
      removeEventListener() {},
      classList: { add() {}, remove() {}, contains: () => false },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 800, right: 280, bottom: 800 }),
      querySelector: () => null,
      get firstChild() {
        return this.children.length > 0 ? this.children[0] : null
      },
      select() {},
    }
    return node
  }
  const head = create('head')
  const body = create('body')
  const root = create('div')
  root.id = 'root'
  if (options.noRoot !== true) body.appendChild(root)
  return {
    head,
    body,
    baseURI: options.baseURI || 'http://127.0.0.1:1/dsh-remote-go/remote/h_a/',
    documentElement: create('html'),
    createElement: create,
    createElementNS: (_namespace, tag) => create(tag),
    execCommand: options.execCommand,
    querySelector(selector) {
      if (selector === '#root' || selector === '[data-dsh-root]') return options.noRoot === true ? null : root
      return null
    },
    querySelectorAll: () => [],
    listeners: {},
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener() {},
  }
}

function fakeDom(options = {}) {
  const columnWidth = options.sidebarWidth === undefined ? 280 : options.sidebarWidth
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
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this)
      },
      addEventListener(type, handler) {
        if (!this.listeners[type]) this.listeners[type] = []
        this.listeners[type].push(handler)
      },
      removeEventListener() {},
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
    querySelectorAll(selector) {
      if (selector === '[data-window-drag]') return brand === null ? [] : [brand]
      if (selector === 'div,aside,nav,section') return [column]
      return []
    },
  }
  return { document, column, brand, head }
}

function rowOf(dom) {
  return dom.column.children.find((child) => child.id === 'drg-host-row') || null
}

function rowName(row) {
  const node = row.children.find((child) => child.className === 'drg-hr-name')
  return node ? node.textContent : null
}

function rowItems(row) {
  const menu = row.children.find((child) => child.className === 'drg-hr-menu')
  return menu.children.filter((child) => child.className === 'drg-hr-item')
}

function itemLabel(item) {
  const node = item.children.find((child) => child.className === 'drg-hr-item-name')
  return node ? node.textContent : null
}

function itemDotState(item) {
  const dot = item.children.find((child) => child.className === 'drg-hr-dot')
  return dot ? dot.getAttribute('data-state') : null
}

function clickInside(row, target) {
  for (const handler of row.listeners.click || []) handler({ target })
}

function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    params[key] === undefined || params[key] === null ? match : String(params[key]),
  )
}

function translateFrom(dict) {
  return (key, params) => {
    const text = dict[key] === undefined ? key : dict[key]
    return interpolate(text, params)
  }
}

function runApply(plugin, options = {}) {
  const calls = {
    effects: [],
    injects: [],
    registers: [],
    selectPanel: [],
    registerNamespace: null,
    bindNamespace: null,
    openWorkspace: [],
    openTab: [],
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
      if (name === 'uiWorkspace') return uiWorkspace
      return null
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

function render(element) {
  return renderToStaticMarkup(element)
}

function testIdsOf(markup) {
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
    logs: [],
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

test('client.js registers one lazy factory through window.__ModuleLoader__', () => {
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(/)
  assert.match(SOURCE, /id:\s*'dsh-remote-go'/)
  const specifiers = [...SOURCE.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1].trim())
  for (const specifier of specifiers) {
    assert.equal(specifier, "'react'", 'unexpected require: ' + specifier)
  }
})

test('factory injects slots and locale', () => {
  const injects = Array.from(plugin.inject)
  assert.deepEqual(injects, ['slots', 'locale'])
  assert.equal(injects.includes('layout'), false)
})

test('the guest scripts carry the file-menu selectors and the folder item', () => {
  const tools = plugin.carrier.guestTools()
  assert.match(tools, /li\[data-files-entry\]\[data-files-path\]/)
  assert.match(tools, /data-drg-dir-download/)
  assert.match(tools, /下载到本地/)
  assert.match(tools, /dsw-icon-download-outline-regular/)
  assert.match(tools, /download-file/)
  assert.match(tools, /data-menu-backing/)
})

test('api.startDownload posts the host, path and destination and returns the job', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        job: { id: 'dl_1', phase: 'preparing', name: 'project', totalBytes: 0, doneBytes: 0 },
      }),
    }
  }
  const withFetch = loadClientPlugin({ fetch })
  const job = await withFetch.api.startDownload('h_1', '/home/ubuntu/project', 'C:/Users/me/Downloads')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/downloads$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    hostId: 'h_1',
    path: '/home/ubuntu/project',
    destination: 'C:/Users/me/Downloads',
  })
  assert.equal(job.id, 'dl_1')
})

test('the guest download intent keeps the request kind and path', () => {
  const store = plugin.toolRequests.create()
  store.requestDownload({ hostId: 'h_1', kind: 'directory', path: '/home/ubuntu/project', name: 'project' })
  store.requestDownload({ hostId: 'h_1', kind: 'file', path: '/home/ubuntu/a.txt', name: 'a.txt' })
  const first = store.take()
  assert.equal(first.kind, 'download')
  assert.equal(first.path, '/home/ubuntu/project')
  const second = store.take()
  assert.equal(second.path, '/home/ubuntu/a.txt')
  assert.equal(store.take(), null)
})

test('api.downloadStatus and cancelDownload use the job routes', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, job: { id: 'dl_1', phase: 'ready' } }),
    }
  }
  const withFetch = loadClientPlugin({ fetch })
  const status = await withFetch.api.downloadStatus('dl_1')
  assert.equal(status.phase, 'ready')
  assert.match(calls[0].url, /\/downloads\/dl_1\/status$/)
  assert.equal(await withFetch.api.cancelDownload('dl_1'), true)
  assert.match(calls[1].url, /\/downloads\/dl_1$/)
  assert.equal(calls[1].init.method, 'DELETE')
})

test('api.startDownload turns a Host error envelope into an ErrorView', async () => {
  const fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      ok: false,
      error: {
        code: 'remote-file-unavailable',
        title: { zh: '无法读取远端文件', en: 'Cannot read the remote file' },
        detail: { zh: '文件不存在', en: 'The file is missing' },
        nextSteps: [],
        retryable: true,
      },
    }),
  })
  const withFetch = loadClientPlugin({ fetch })
  await assert.rejects(
    () => withFetch.api.startDownload('h_1', '/home/ubuntu/missing.txt', 'C:/Downloads'),
    (error) => error.view && error.view.code === 'remote-file-unavailable',
  )
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
  assert.equal(plugin.components.SettingsSection, undefined, 'the plugin must not ship a settings-page component')
  assert.equal(typeof plugin.components.RemoteIcon, 'function')
})

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
  const phases = [...(SOURCE.match(/const PHASES = \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(
    (found) => found[1],
  )
  assert.ok(phases.length >= 7, `expected the connect phases, found ${phases.length}`)
  for (const phase of phases) {
    assert.ok(dicts.zh['phase.' + phase], 'missing zh label for connect phase ' + phase)
    assert.ok(dicts.en['phase.' + phase], 'missing en label for connect phase ' + phase)
  }
})

test('apply registers only the overlay host: the switcher row is the plugin sole entry', () => {
  const { calls } = runApply(plugin)
  assert.deepEqual(calls.injects, ['shell.overlay'])
  assert.equal(calls.registers.length, 1)
  assert.ok(!calls.injects.includes('main'), 'the plugin must not own the main column')
  assert.ok(!calls.injects.includes('settings.section'), 'no settings page may be registered')
  assert.ok(!calls.injects.includes('sidebar.panellist'), 'no global-panel row may be registered')
  assert.ok(!calls.injects.includes('sidebar.workspaces'), 'no sidebar workspace entry may be registered')
  assert.ok(!calls.injects.includes('sidebar.footer.action'), 'no footer action may be registered')
  const overlay = calls.registers.find((entry) => entry.options.name === 'shell.overlay')
  assert.ok(overlay, 'the overlay host must be registered')
  assert.equal(overlay.component, plugin.components.PluginOverlay)
  assert.equal(overlay.options.locale, PANEL_ID)
})

test('shared inject face carries the command channels, not a panel', () => {
  const { calls } = runApply(plugin)
  const overlay = calls.registers.find((entry) => entry.options.name === 'shell.overlay')
  assert.equal(typeof overlay.options.inject, 'function')
  const face = overlay.options.inject()
  assert.equal(typeof face.getLocaleId, 'function')
  assert.equal(face.getLocaleId(), 'zh')
  assert.equal(face.openPanel, undefined, 'there is no panel to select any more')
  assert.ok(face.panelStore && typeof face.panelStore.request === 'function')
  assert.ok(face.wizardStore && typeof face.wizardStore.open === 'function')
  assert.equal(typeof face.openWizard, 'function')
  face.panelStore.request('h_test')
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'open', hostId: 'h_test' })
  assert.equal(face.panelStore.take(), null)
  face.panelStore.requestIntent({ kind: 'manage' })
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'manage' })
  face.panelStore.requestIntent({ kind: 'local' })
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'local' })
  face.panelStore.requestIntent({ kind: 'open' })
  assert.equal(face.panelStore.take(), null, 'an open intent without a host is refused')
  face.openWizard({ mode: 'edit', host: { id: 'h_test' } })
  assert.deepEqual({ ...face.wizardStore.current() }, { mode: 'edit', host: { id: 'h_test' } })
  face.wizardStore.close()
  assert.equal(face.wizardStore.current(), null)
})

test('client code never logs and never persists remote URLs / tokens', () => {
  assert.doesNotMatch(SOURCE, /console\.(log|debug|info|warn|error)\s*\(/)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*token/i)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*url/i)
  assert.match(SOURCE, /'x-dsh-remote-go':\s*'1'/)
  assert.match(SOURCE, /credentials:\s*'same-origin'/)
  assert.match(SOURCE, /const LOOPBACK_PREFIX = 'http:\/\/127\.0\.0\.1:'/)
  assert.match(SOURCE, /url\.startsWith\(LOOPBACK_PREFIX\)/)
})

test('the client embeds the remote page only in the browser carrier and opens no window of its own', () => {
  // The desktop path still hands the remote page to the shell guest: no React iframe, no sandbox.
  assert.doesNotMatch(SOURCE, /h\(\s*'iframe'/, 'no iframe element may be rendered by React')
  assert.doesNotMatch(SOURCE, /IFRAME_SANDBOX/)
  assert.doesNotMatch(SOURCE, /window\.open\s*\(/, 'the global window.open must never be called')
  // The one new-window call site is the capability bridge's: a link the user clicked inside the
  // framed page, after `externalUrlOf` reduced it to an http(s) URL with a host and no credentials.
  assert.equal((SOURCE.match(/_blank/g) ?? []).length, 1, 'exactly one new-window call site')
  assert.match(SOURCE, /win\.open\(url, '_blank', 'noopener,noreferrer'\)/)
  assert.match(SOURCE, /function externalUrlOf\(value\)/)
  assert.match(SOURCE, /function openExternalUrl\(value\)/)
  assert.doesNotMatch(SOURCE, /sandbox:?\s*['"]allow-scripts/, 'no iframe sandbox attribute may remain')
  assert.doesNotMatch(SOURCE, /RemoteViewport/, 'the embedded viewport component must be gone')
  // The browser carrier is the only frame seat, and it is fed a checked same-origin view path.
  assert.match(SOURCE, /function createWebCarrier\(/)
  assert.match(SOURCE, /function isValidViewPath\(value\)/)
  assert.match(SOURCE, /frame\.src = url/)
  assert.match(SOURCE, /function isValidLoopbackUrl\(url\)/)
})

test('openHost validates both carrier URLs (API-layer guard)', async () => {
  const requests = []
  let answer = {
    url: 'http://127.0.0.1:54321/?token=abc123',
    webUrl: '/dsh-remote-go/remote/h_test/?token=abc123',
  }
  const client = loadClientPlugin({
    fetch: async (endpoint) => {
      requests.push(String(endpoint))
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, localPort: 54321, address: '127.0.0.1:54321', ...answer }
        },
      }
    },
  })
  assert.equal(typeof client.api?.openHost, 'function', 'client.js must expose the Host-API client for this test')
  const allowed = await client.api.openHost('h_test')
  assert.equal(allowed.url, 'http://127.0.0.1:54321/?token=abc123')
  assert.equal(allowed.webUrl, '/dsh-remote-go/remote/h_test/?token=abc123')
  assert.equal(requests.at(-1), '/dsh-remote-go/api/hosts/h_test/open')
  // The tightened check keeps the accepted shape exactly as it was, bare origin included.
  for (const acceptedUrl of ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/', 'http://127.0.0.1:8080/?token=abc']) {
    answer = { url: acceptedUrl, webUrl: '/dsh-remote-go/remote/h_test/?token=abc' }
    const opened = await client.api.openHost('h_test')
    assert.equal(opened.url, acceptedUrl)
    assert.equal(opened.webUrl, '/dsh-remote-go/remote/h_test/?token=abc')
  }
  for (const refusedUrl of [
    'https://evil.example.com/?token=secret',
    'http://10.0.0.5:54321/?token=secret',
    'http://localhost:54321/?token=secret',
    'http://127.0.0.1.evil.example.com/?token=secret',
    // A prefix match alone accepted both: `URL` reads `127.0.0.1:8080` as userinfo on a remote host.
    'http://127.0.0.1:8080@evil.example/?token=secret',
    'http://127.0.0.1:@evil.example/?token=secret',
    'http://127.0.0.1/?token=secret',
    'http://127.0.0.1:0/?token=secret',
    'http://127.0.0.1:99999/?token=secret',
  ]) {
    answer = { url: refusedUrl, webUrl: '/dsh-remote-go/remote/h_test/?token=secret' }
    await assert.rejects(client.api.openHost('h_test'), (error) => {
      assert.equal(error?.view?.code, 'blocked-url', `unexpected error view for ${refusedUrl}`)
      assert.equal(error?.message, '远端地址不是本地回环地址，出于安全考虑已阻止。')
      return true
    })
  }
  // The browser carrier seat is a path on this origin, never an absolute or traversing URL.
  for (const refusedView of [
    'https://evil.example.com/dsh-remote-go/remote/h_test/',
    '//evil.example.com/dsh-remote-go/remote/h_test/',
    '/dsh-remote-go/remote/h_test',
    '/dsh-remote-go/remote/../h_test/',
    '/dsh-remote-go/remote/h_test/../../state',
    '/dsh-remote-go/remote/h%5Ftest/',
    '/dsh-remote-go/api/h_test/',
  ]) {
    answer = { url: 'http://127.0.0.1:54321/?token=abc123', webUrl: refusedView }
    await assert.rejects(client.api.openHost('h_test'), (error) => {
      assert.equal(error?.view?.code, 'blocked-url', `unexpected error view for ${refusedView}`)
      return true
    })
  }
})

test('isValidLoopbackUrl proves the parsed origin instead of trusting the prefix', () => {
  const { isValidLoopbackUrl } = plugin.__test
  for (const accepted of [
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8080/',
    'http://127.0.0.1:8080/?token=abc',
    'http://127.0.0.1:65535/',
  ]) {
    assert.equal(isValidLoopbackUrl(accepted), true, `${accepted} must stay accepted`)
  }
  for (const refused of [
    // Both start with the accepted prefix but parse to a remote host whose userinfo looks loopback.
    'http://127.0.0.1:8080@evil.example/',
    'http://127.0.0.1:@evil.example/',
    // Shapes the old prefix check already refused must stay refused.
    'https://127.0.0.1:8080/',
    'HTTP://127.0.0.1:8080/',
    'http://127.0.0.1/',
    'http://localhost:8080/',
    '127.0.0.1:8080',
    // Ports: `URL` drops the http default port, `:0` parses, and > 65535 fails to parse.
    'http://127.0.0.1:80/',
    'http://127.0.0.1:0/',
    'http://127.0.0.1:99999/',
    // Non-strings and values that cannot name an origin at all.
    '',
    null,
    42,
    undefined,
    {},
  ]) {
    assert.equal(isValidLoopbackUrl(refused), false, `${String(refused)} must be refused`)
  }
})

test('the desktop carrier refuses a disguised loopback URL before it acquires a seat', async () => {
  const doc = fakeDocument()
  let acquired = 0
  const takeover = loadClientPlugin({
    document: doc,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => {
          acquired += 1
          return { lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }
        },
        release: async () => {},
      },
    },
  })
  try {
    for (const refused of ['http://127.0.0.1:8080@evil.example/', 'http://127.0.0.1:@evil.example/']) {
      const opened = await takeover.carrier.open({ hostId: 'h_a', url: refused })
      assert.deepEqual({ ok: opened.ok, reason: opened.reason }, { ok: false, reason: 'bad-url' })
      assert.equal(acquired, 0, `a refused URL must not reach the guest: ${refused}`)
      assert.equal(doc.body.children.length, 0, `no carrier may be mounted for ${refused}`)
    }
    const accepted = await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:8080/?token=abc' })
    assert.equal(accepted.ok, true, 'the legal loopback origin must still open')
    assert.equal(acquired, 1)
  } finally {
    await takeover.carrier.close()
  }
})

const stateWith = (overrides = {}) => ({
  hostVersion: '0.2.2-rc.1',
  targetVersion: '0.2.2-rc.1',
  hosts: [],
  settings: {},
  activeHostId: null,
  firstRun: false,
  ...overrides,
})

test('host list renders the empty state and a connected card', () => {
  const noop = () => {}
  const empty = render(
    React.createElement(plugin.components.HostListView, {
      t,
      state: stateWith({ firstRun: true }),
      loading: false,
      error: null,
      onAdd: noop,
      onRefresh: noop,
    }),
  )
  for (const pattern of [/远程主机/, /还没有远程主机/, /添加第一台服务器/, /drg-empty/]) assert.match(empty, pattern)
  assert.doesNotMatch(empty, /drg-host-card/)
  const list = render(
    React.createElement(plugin.components.HostListView, {
      t,
      state: stateWith({ hosts: [hostView()] }),
      loading: false,
      error: null,
      onAdd: noop,
      onRefresh: noop,
      onOpenHost: noop,
      onDisconnectHost: noop,
      onEditHost: noop,
      onDeleteHost: noop,
      onDiagnoseHost: noop,
    }),
  )
  for (const pattern of [/测试机/, /ubuntu@10\.0\.0\.5:22/, /0\.2\.2-rc\.1/, /已连接/, /共 1/, /断开/, /诊断/]) {
    assert.match(list, pattern)
  }
})

/** One rendered `Button` by its test id, so a label can be asserted exactly (not by substring). */
function buttonOf(markup, testId) {
  const found = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?</button>`).exec(markup)
  assert.ok(found, `the card must render a ${testId} button`)
  return found[0]
}

test('a connected host card offers a remote restart and a restarting one shows its progress', () => {
  const noop = () => {}
  const listOf = (host) =>
    render(
      React.createElement(plugin.components.HostListView, {
        t,
        state: stateWith({ hosts: [host] }),
        loading: false,
        error: null,
        onAdd: noop,
        onRefresh: noop,
        onOpenHost: noop,
        onDisconnectHost: noop,
        onReconnectHost: noop,
        onRestartHost: noop,
        onEditHost: noop,
        onDeleteHost: noop,
        onDiagnoseHost: noop,
      }),
    )
  const connected = listOf(hostView())
  assert.match(buttonOf(connected, 'host-restart'), />重启</, 'the restart action reads "重启"')
  assert.match(
    buttonOf(connected, 'host-restart'),
    /aria-label="重启远端 DSH"/,
    'the short label keeps the full accessible name',
  )
  assert.doesNotMatch(connected, /data-progress="restarting-remote"/)

  const restarting = listOf(
    hostView({
      status: 'connecting',
      phase: 'start',
      progress: { code: 'restarting-remote' },
      remote: { ...hostView().remote, uiReady: false },
    }),
  )
  assert.match(restarting, /data-progress="restarting-remote"/)
  assert.match(buttonOf(restarting, 'host-restart'), />正在重启…</)
  assert.match(restarting, /远端 DSH 正在重启，正在重新挂载界面…/)
  // The card action is disabled while the restart runs.
  const restartButton = /<button[^>]*data-testid="host-restart"[^>]*>/.exec(restarting)
  assert.ok(restartButton, 'the restart button must stay on the card while it runs')
  assert.match(restartButton[0], /disabled=""/)

  // The retained remote-unreachable error state offers both ways back: restart and reconnect.
  const unreachable = listOf(
    hostView({
      status: 'error',
      error: {
        code: 'remote-unreachable',
        title: { zh: '远端 DSH 已不在运行', en: 'The remote DSH is no longer running' },
        detail: { zh: '没有可重挂实例。', en: 'No instance to re-attach.' },
        nextSteps: [],
        retryable: true,
      },
    }),
  )
  assert.match(unreachable, /data-testid="host-restart"/)
  assert.match(unreachable, /data-testid="host-reconnect"/)
})

test('a connected host card offers stopping the remote DSH and a stopping one shows its progress', () => {
  const noop = () => {}
  const listOf = (host) =>
    render(
      React.createElement(plugin.components.HostListView, {
        t,
        state: stateWith({ hosts: [host] }),
        loading: false,
        error: null,
        onAdd: noop,
        onRefresh: noop,
        onOpenHost: noop,
        onDisconnectHost: noop,
        onReconnectHost: noop,
        onRestartHost: noop,
        onStopRemote: noop,
        onEditHost: noop,
        onDeleteHost: noop,
        onDiagnoseHost: noop,
      }),
    )
  const connected = listOf(hostView())
  assert.match(buttonOf(connected, 'host-stop-remote'), />关闭</, 'the stop action reads "关闭"')
  assert.match(
    buttonOf(connected, 'host-stop-remote'),
    /aria-label="关闭远端 DSH"/,
    'the short label keeps the full accessible name',
  )
  assert.doesNotMatch(connected, /data-progress="stopping-remote"/)
  const stopButton = /<button[^>]*data-testid="host-stop-remote"[^>]*>/.exec(connected)
  assert.ok(stopButton, 'the connected card must offer the stop action')
  assert.doesNotMatch(stopButton[0], /disabled=""/)

  // A stopped host has no remote process left: no stop action until it is reconnected.
  const disconnected = listOf(
    hostView({ status: 'disconnected', remote: { ...hostView().remote, uiReady: false, localPort: null } }),
  )
  assert.doesNotMatch(disconnected, /data-testid="host-stop-remote"/)

  const stopping = listOf(
    hostView({
      status: 'connecting',
      phase: 'start',
      progress: { code: 'stopping-remote', params: { pid: 1234 } },
      remote: { ...hostView().remote, uiReady: false },
    }),
  )
  assert.match(stopping, /data-progress="stopping-remote"/)
  assert.match(buttonOf(stopping, 'host-stop-remote'), />正在关闭…</)
  assert.match(stopping, /正在关闭远端 DSH…/)
  const busyStop = /<button[^>]*data-testid="host-stop-remote"[^>]*>/.exec(stopping)
  assert.ok(busyStop, 'the stop button stays on the card while it runs')
  assert.match(busyStop[0], /disabled=""/)
  // A restart in flight also disables the stop action (one link action at a time).
  const restarting = listOf(hostView({ status: 'connecting', phase: 'start', progress: { code: 'restarting-remote' } }))
  const restartingStop = /<button[^>]*data-testid="host-stop-remote"[^>]*>/.exec(restarting)
  assert.ok(restartingStop)
  assert.match(restartingStop[0], /disabled=""/)

  // The retained remote-unreachable error state can be closed as well as restarted/reconnected.
  const unreachable = listOf(
    hostView({
      status: 'error',
      error: {
        code: 'remote-unreachable',
        title: { zh: '远端 DSH 已不在运行', en: 'The remote DSH is no longer running' },
        detail: { zh: '没有可重挂实例。', en: 'No instance to re-attach.' },
        nextSteps: [],
        retryable: true,
      },
    }),
  )
  assert.match(unreachable, /data-testid="host-stop-remote"/)
  assert.match(unreachable, /data-testid="host-restart"/)
  assert.match(unreachable, /data-testid="host-reconnect"/)
})

test('the connect window titles a restart or a reconnect and prints its log', () => {
  const restarting = render(
    React.createElement(plugin.components.ConnectWindow, {
      t,
      host: hostView({
        status: 'connecting',
        phase: 'start',
        progress: { code: 'restarting-remote' },
        logs: [
          {
            seq: 1,
            at: '2026-11-17T12:00:00.000Z',
            level: 'info',
            phase: 'start',
            message: 'restart requested (pid=1234)',
          },
        ],
      }),
    }),
  )
  assert.match(restarting, /正在重启「测试机」的远端 DSH/)
  assert.match(restarting, /远端 DSH 正在重启，正在重新挂载界面…/)
  assert.match(restarting, /data-testid="connect-log"/)
  assert.match(restarting, /restart requested \(pid=1234\)/)

  const reconnecting = render(
    React.createElement(plugin.components.ConnectWindow, {
      t,
      host: hostView({
        status: 'connecting',
        phase: 'ssh',
        progress: { code: 'ssh-connecting' },
        logs: [
          {
            seq: 2,
            at: '2026-11-17T12:00:01.000Z',
            level: 'info',
            phase: 'ssh',
            message: 'reconnect requested',
          },
        ],
      }),
    }),
  )
  assert.match(reconnecting, /正在连接「测试机」/)
  assert.match(reconnecting, /正在连接 SSH…/)
  assert.match(reconnecting, /reconnect requested/)
})

test('the stop confirmation names the destructive action and its consequences in both languages', () => {
  const noop = () => {}
  const zh = render(React.createElement(plugin.components.StopRemoteDialog, { t, onConfirm: noop, onCancel: noop }))
  assert.match(zh, /data-testid="stop-remote-dialog"/)
  assert.match(zh, /关闭远端 DSH？/)
  assert.match(zh, /会停止远端进程/)
  assert.match(zh, /可随时重连/)
  assert.match(zh, /data-testid="stop-remote-confirm"/)
  assert.match(zh, /data-testid="stop-remote-cancel"/)
  assert.match(buttonOf(zh, 'stop-remote-confirm'), />关闭</, 'the confirmation action reads "关闭"')
  const zhConfirm = /<button[^>]*data-testid="stop-remote-confirm"[^>]*>/.exec(zh)
  assert.ok(zhConfirm, 'the confirmation needs its own confirm button')
  assert.match(zhConfirm[0], /drg-btn-danger|danger/, 'stopping the remote process is a destructive action')
  assert.doesNotMatch(zhConfirm[0], /disabled=""/)

  const busy = render(
    React.createElement(plugin.components.StopRemoteDialog, {
      t,
      busy: true,
      onConfirm: noop,
      onCancel: noop,
    }),
  )
  assert.match(busy, /正在关闭…/)
  const busyConfirm = /<button[^>]*data-testid="stop-remote-confirm"[^>]*>/.exec(busy)
  assert.match(busyConfirm[0], /disabled=""/)
  const busyCancel = /<button[^>]*data-testid="stop-remote-cancel"[^>]*>/.exec(busy)
  assert.match(busyCancel[0], /disabled=""/)

  const en = render(
    React.createElement(plugin.components.StopRemoteDialog, {
      t: enT,
      getLocaleId: () => 'en',
      onConfirm: noop,
      onCancel: noop,
    }),
  )
  assert.match(en, /Stop the remote DSH\?/)
  assert.match(en, /Stops the remote process/)
  assert.match(en, /reconnect later/)
})

test('api.stopRemote posts the stop-remote route and returns the Host answer', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, pid: 4242 }) }
  }
  const withFetch = loadClientPlugin({ fetch })
  assert.deepEqual(await withFetch.api.stopRemote('h_1'), { ok: true, pid: 4242 })
  assert.match(calls[0].url, /\/hosts\/h_1\/stop-remote$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {})
})

test('api.restart posts the restart route and returns the Host answer', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, accepted: true }) }
  }
  const withFetch = loadClientPlugin({ fetch })
  assert.deepEqual(await withFetch.api.restart('h_1'), { ok: true, accepted: true })
  assert.match(calls[0].url, /\/hosts\/h_1\/restart$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {})
})

function manageWindowProps(overrides = {}) {
  return {
    open: true,
    view: 'connect',
    t,
    getLocaleId: () => 'zh',
    host: null,
    state: null,
    loading: false,
    error: null,
    busyHostId: null,
    fingerprintBusy: false,
    onClose: () => {},
    onAdd: () => {},
    onRefresh: () => {},
    onOpenSettings: () => {},
    onOpenHost: () => {},
    onConnectHost: () => {},
    onDisconnectHost: () => {},
    onReconnectHost: () => {},
    onEditHost: () => {},
    onDeleteHost: () => {},
    onDiagnoseHost: () => {},
    onAcceptFingerprint: () => {},
    onRejectFingerprint: () => {},
    onRetry: () => {},
    onDiagnose: () => {},
    ...overrides,
  }
}

test('a connecting host prints the connect log instead of the host list', () => {
  const host = hostView({
    status: 'connecting',
    phase: 'bootstrap',
    progress: { code: 'bootstrapping', params: {} },
    remote: { ...hostView().remote, version: null, uiReady: false },
    logs: [
      {
        seq: 1,
        at: '2026-11-14T16:03:12.000Z',
        level: 'info',
        message: 'SSH connected to 10.0.0.5:22 as ubuntu (fingerprint SHA256:abc)',
      },
      {
        seq: 2,
        at: '2026-11-14T16:03:13.000Z',
        level: 'debug',
        message: 'remote: dsh web listening on 127.0.0.1:38123',
      },
      { seq: 3, at: '2026-11-14T16:03:14.000Z', level: 'warn', message: 'adopt check failed: no registry' },
    ],
  })
  const html = render(React.createElement(plugin.components.ManageWindow, manageWindowProps({ host })))
  assert.match(html, /data-testid="manage-window"/)
  assert.match(html, /data-testid="manage-live"/)
  assert.match(html, /正在连接「测试机」/)
  assert.match(html, /data-testid="connect-log"/)
  assert.match(html, /连接日志/)
  assert.match(html, /3 行/)
  const lines = [...html.matchAll(/data-level="(\w+)"[^>]*>(?:<!-- -->)?/g)].map((match) => match[1])
  assert.deepEqual(lines, ['info', 'debug', 'warn'])
  const infoAt = html.indexOf('SSH connected to 10.0.0.5:22')
  const debugAt = html.indexOf('remote: dsh web listening')
  const warnAt = html.indexOf('adopt check failed')
  assert.ok(infoAt > 0 && debugAt > infoAt && warnAt > debugAt, 'the log must keep the order it was written in')
  assert.doesNotMatch(html, /data-testid="host-list"/)
  assert.doesNotMatch(html, /data-testid="host-add"/)
  assert.doesNotMatch(html, /data-testid="host-refresh"/)
  assert.doesNotMatch(html, /data-testid="host-settings"/)
  assert.doesNotMatch(html, /管理远程主机/)
})

test('a failed connection keeps its log and offers retry instead of the list', () => {
  const host = hostView({
    status: 'error',
    error: {
      code: 'auth',
      title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
      detail: { zh: '请检查用户名与密钥。', en: 'Check the user name and key.' },
      nextSteps: [],
      retryable: true,
    },
    logs: [{ seq: 1, at: '2026-11-14T16:03:12.000Z', level: 'warn', message: 'connect failed: auth' }],
  })
  const html = render(React.createElement(plugin.components.ManageWindow, manageWindowProps({ host })))
  assert.match(html, /data-testid="error-card"/)
  assert.match(html, /data-testid="error-retry"/)
  assert.match(html, /connect failed: auth/)
  assert.match(html, /data-testid="connect-log"/)
  assert.doesNotMatch(html, /data-testid="host-list"/)
})

test('the host-key question also prints the log that led to it', () => {
  const host = hostView({
    status: 'fingerprint-pending',
    fingerprint: { sha256: 'SHA256:abc', keyType: 'ssh-ed25519', status: 'pending', pinned: null },
    logs: [{ seq: 1, at: '2026-11-14T16:03:12.000Z', level: 'info', message: 'SSH key SHA256:abc' }],
  })
  const html = render(React.createElement(plugin.components.ManageWindow, manageWindowProps({ host })))
  assert.match(html, /data-testid="fingerprint-card"/)
  assert.match(html, /data-testid="connect-log"/)
  assert.match(html, /SSH key SHA256:abc/)
  assert.doesNotMatch(html, /data-testid="host-list"/)
})

test('a host that is not connecting gets the management list back', () => {
  const host = hostView({ status: 'disconnected', logs: [] })
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [host],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const html = render(React.createElement(plugin.components.ManageWindow, manageWindowProps({ host, state })))
  assert.match(html, /data-testid="host-list"/)
  assert.match(html, /data-testid="host-add"/)
  assert.match(html, /远程主机/)
  assert.doesNotMatch(html, /data-testid="connect-log"/)
  assert.doesNotMatch(html, /data-testid="manage-live"/)
})

test('opening 管理界 interface shows the list even for a host that just failed', () => {
  const host = hostView({
    status: 'error',
    error: {
      code: 'auth',
      title: { zh: '认证失败', en: 'Authentication failed' },
      detail: { zh: '', en: '' },
      nextSteps: [],
    },
    logs: [{ seq: 1, at: '2026-11-14T16:03:12.000Z', level: 'warn', message: 'connect failed: auth' }],
  })
  const state = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [host],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const html = render(
    React.createElement(plugin.components.ManageWindow, manageWindowProps({ host, state, view: 'list' })),
  )
  assert.match(html, /data-testid="host-list"/)
  assert.match(html, /data-testid="host-card"/)
  assert.doesNotMatch(html, /data-testid="connect-log"/)
  assert.doesNotMatch(html, /data-testid="error-card"/)
})
test('the closed window renders nothing', () => {
  const html = render(
    React.createElement(plugin.components.ManageWindow, manageWindowProps({ open: false, host: hostView() })),
  )
  assert.equal(html, '')
})

test('the connect console prints raw lines, staged progress and says so when the Host has none yet', () => {
  const progress = hostView({
    status: 'connecting',
    phase: 'ssh',
    progress: { code: 'ssh-connecting' },
    remote: { ...hostView().remote, version: null, uiReady: false },
  })
  const staged = render(React.createElement(plugin.components.ConnectProgress, { t, host: progress }))
  for (const pattern of [/正在连接「测试机」/, /正在连接 SSH…/, /SSH/, /隧道/]) assert.match(staged, pattern)
  const empty = render(
    React.createElement(plugin.components.ConnectLog, { t, host: hostView({ status: 'connecting', logs: [] }) }),
  )
  assert.match(empty, /data-testid="connect-log-empty"/)
  assert.match(empty, /等待日志输出/)
  assert.match(empty, /关闭窗口|关窗不中断连接/)
  const html = render(
    React.createElement(plugin.components.ConnectLog, {
      t,
      host: hostView({
        status: 'connecting',
        logs: [
          {
            seq: 9,
            at: '2026-11-14T16:03:12.000Z',
            level: 'debug',
            message: 'remote: installing @deepseek-ai/dsh@0.2.2-rc.3 with a token=secret query string',
          },
        ],
      }),
    }),
  )
  assert.match(html, /installing @deepseek-ai\/dsh@0\.2\.2-rc\.3 with a token=secret query string/)
  assert.match(html, /data-level="debug"/)
  assert.match(html, /1 行/)
  assert.match(html, /role="log"/)
  assert.doesNotMatch(html, /dsh-remote-go:/)
})

test('the connect log shows the phase of every line and the Host’s bilingual failure block', () => {
  const logs = [
    {
      seq: 1,
      at: '2026-11-16T02:30:12.000Z',
      level: 'info',
      phase: null,
      boundary: true,
      message: '— Connection 2 · 2026-11-16 10:30:12 —',
      text: { zh: '— 第 2 次连接 · 2026-11-16 10:30:12 —', en: '— Connection 2 · 2026-11-16 10:30:12 —' },
    },
    { seq: 2, at: '2026-11-16T02:30:13.000Z', level: 'info', phase: 'ssh', message: 'SSH connected to 10.0.0.5' },
    {
      seq: 3,
      at: '2026-11-16T02:30:14.000Z',
      level: 'error',
      phase: 'start',
      message: 'Connect failed in phase start: remote-dsh-start-failed',
      text: {
        zh: '连接失败于 start 阶段：remote-dsh-start-failed',
        en: 'Connect failed in phase start: remote-dsh-start-failed',
      },
    },
    {
      seq: 4,
      at: '2026-11-16T02:30:15.000Z',
      level: 'error',
      phase: 'start',
      message: 'Reason: startup failed',
      text: { zh: '原因：启动失败。', en: 'Reason: startup failed.' },
    },
    { seq: 5, at: '2026-11-16T02:30:16.000Z', level: 'error', phase: 'custom', message: 'unknown phase line' },
    {
      seq: 6,
      at: '2026-11-16T02:30:17.000Z',
      level: 'info',
      phase: 'ready',
      message: 'connected: remote DSH on 127.0.0.1:45123',
    },
  ]
  const zhHtml = render(
    React.createElement(plugin.components.ConnectLog, { t, host: hostView({ status: 'error', logs }) }),
  )
  assert.match(zhHtml, /data-boundary="true"/, 'the boundary line is marked for styling')
  assert.match(zhHtml, /第 2 次连接 · 2026-11-16 10:30:12/)
  assert.match(zhHtml, /data-phase="ssh"/)
  assert.match(zhHtml, /data-phase="start"/)
  assert.match(zhHtml, />SSH</, 'the ssh phase has its localized chip')
  assert.match(zhHtml, />启动远端</, 'the start phase chip is localized')
  assert.match(zhHtml, />就绪</, 'the ready phase chip is localized too')
  assert.match(zhHtml, />custom</, 'an unknown phase prints as its own id')
  assert.match(zhHtml, /连接失败于 start 阶段：remote-dsh-start-failed/)
  assert.match(zhHtml, /原因：启动失败。/)
  assert.equal((zhHtml.match(/data-level="error"/g) ?? []).length, 3, 'failure lines render at error level')
  assert.doesNotMatch(zhHtml, /— Connection 2 · 2026-11-16 10:30:12 —/, 'the zh UI shows the zh line')
  const order = [
    '第 2 次连接',
    'SSH connected',
    '连接失败于 start 阶段',
    '原因：启动失败。',
    'unknown phase line',
    'connected: remote DSH on 127.0.0.1:45123',
  ].map((needle) => zhHtml.indexOf(needle))
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
    'the log must keep the order the Host wrote',
  )

  const enHtml = render(
    React.createElement(plugin.components.ConnectLog, {
      t: enT,
      getLocaleId: () => 'en',
      host: hostView({ status: 'error', logs }),
    }),
  )
  assert.match(enHtml, /— Connection 2 · 2026-11-16 10:30:12 —/)
  assert.match(enHtml, />Start</)
  assert.match(enHtml, />Ready</)
  assert.match(enHtml, /Connect failed in phase start: remote-dsh-start-failed/)
  assert.match(enHtml, /Reason: startup failed\./)
  assert.doesNotMatch(enHtml, /第 2 次连接/, 'the en UI resolves the same line in English')
})

test('the connect window resolves host-provided text in English', () => {
  const host = hostView({
    status: 'error',
    error: {
      code: 'auth',
      title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
      detail: { zh: '请检查用户名与密钥。', en: 'Check the user name and key.' },
      nextSteps: [],
      retryable: true,
    },
    logs: [],
  })
  const html = render(
    React.createElement(plugin.components.ManageWindow, manageWindowProps({ host, t: enT, getLocaleId: () => 'en' })),
  )
  assert.match(html, /SSH authentication failed/)
  assert.match(html, /Check the user name and key/)
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
    'restarting-remote',
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
  assert.match(html, /data-testid="dsh-remote-go-overlay-host"/)
  assert.doesNotMatch(html, /data-testid="host-list"/)
  assert.doesNotMatch(html, /data-testid="manage-window"/)
  assert.doesNotMatch(html, /<div class="drg-modal-layer"/)
  assert.doesNotMatch(html, /<iframe/)
})

test('the plugin never selects a main panel; the browser carrier frames the proxied view only', () => {
  assert.doesNotMatch(SOURCE, /selectPanel/, 'the plugin must not select a layout panel')
  assert.doesNotMatch(SOURCE, /'main'/, 'the plugin must not register the main slot')
  assert.doesNotMatch(SOURCE, /<iframe|h\(\s*'iframe'/, 'no React iframe may be rendered')
  assert.match(SOURCE, /acceptsCarrierUrl\(entry\.kind, url\)/, 'the frame URL must be re-checked on reload')
  assert.match(SOURCE, /const openHost = \(host(?:, options)?\) => \{[\s\S]*?setTarget\(host\.id\)/)
})

test('the warm pool keeps every opened host and the last request wins a race', async () => {
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
    const again = await takeover.carrier.open({ hostId: 'h_a' })
    assert.equal(again.reused, true)
    assert.equal(takeover.carrier.shown(), 'h_a')
    assert.deepEqual(released, [], 'nothing may be released while a host is still up')
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

test('a restarted attach re-navigates the warm carrier even when the URL repeats', async () => {
  const doc = fakeDocument()
  const takeover = loadClientPlugin({
    document: doc,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }),
        release: async () => {},
      },
    },
  })
  const url = 'http://127.0.0.1:43210/?token=one'
  try {
    const first = await takeover.carrier.open({ hostId: 'h_a', url, viewRev: 1 })
    assert.equal(first.ok, true)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    const loads = []
    view.loadURL = async (next) => {
      loads.push(next)
    }
    // Same URL, newer attach: a remote restart hands out the same address shape but a new
    // session, so the warm page must be navigated again.
    const second = await takeover.carrier.open({ hostId: 'h_a', url, viewRev: 2 })
    assert.equal(second.reused, true)
    assert.deepEqual(loads, [url])
    // Same attach again: showing the warm window must not reload it.
    await takeover.carrier.open({ hostId: 'h_a', url, viewRev: 2 })
    assert.deepEqual(loads, [url])
    // The warm-reload path is the third caller: a disguised loopback URL must never navigate it.
    await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:8080@evil.example/', viewRev: 3 })
    assert.deepEqual(loads, [url], 'the warm guest must keep its own loopback document')
  } finally {
    await takeover.carrier.close()
  }
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
    assert.match(root.style.cssText, /left:0/)
    assert.equal(root.children.length, 3)
    assert.equal(
      root.children.some((node) => node.className === 'drg-carrier-bar'),
      false,
    )
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    assert.ok(view, 'the guest must be mounted')
    assert.equal(view.tagName, 'WEBVIEW')
    const calls = []
    view.executeJavaScript = (code) => {
      calls.push(code)
      return Promise.resolve(code.includes('function mountHostRow') ? 'installed' : null)
    }
    fire(view, 'did-stop-loading')
    await settle()
    assert.ok(
      calls.some((code) => code.includes('function mountHostRow')),
      'the injected row script must run inside the guest',
    )
    takeover.carrier.update({ hosts, current: 'h_a' })
    await settle()
    assert.ok(
      calls.some((code) => code.includes('43.133.80.40')),
      'the carrier host must be pushed into the injected row',
    )
    assert.equal(
      calls.some((code) => code.includes('生产机 ubuntu')),
      false,
      'a guest row must not render another host (review blocker 1)',
    )
    assert.ok(
      calls.some((code) => code.includes('"current":"h_a"')),
      'the current target must be pushed too',
    )
    assert.equal(
      calls.some((code) => code.includes('drg-hr-title')),
      false,
    )
    const scriptRuns = calls.filter((code) => code.includes('function mountHostRow')).length
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(calls.filter((code) => code.includes('function mountHostRow')).length, scriptRuns + 1)
  } finally {
    await takeover.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('a caption window hands the band to the guest and keeps the window draggable', async () => {
  const doc = fakeDocument({ captionHeight: '40px' })
  const released = []
  const takeover = loadClientPlugin({
    document: doc,
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--dsh-windows-titlebar-height' ? '40px' : ''),
    }),
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }),
        release: async (lease) => released.push(lease),
      },
    },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
  try {
    const result = await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    assert.equal(result.ok, true)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    assert.ok(root, 'the carrier must be mounted on document.body')
    assert.match(root.style.cssText, /top:0/)
    const grip = root.children.find((node) => node.className === 'drg-carrier-grip')
    assert.ok(grip, 'a guest that covers the band must give the window drag back')
    assert.match(grip.style.cssText, /app-region:drag/)
    assert.match(grip.style.cssText, /left:84px/)
    assert.match(grip.style.cssText, /height:40px/)
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    const calls = []
    view.loadURL = () => Promise.resolve()
    view.executeJavaScript = (code) => {
      calls.push(code)
      return Promise.resolve(code.includes('function mountHostRow') ? 'installed' : 'ok')
    }
    fire(view, 'dom-ready')
    await settle()
    assert.ok(
      calls.some(
        (code) =>
          code.includes('data-windows-titlebar') &&
          code.includes('--dsh-windows-titlebar-height') &&
          code.includes('40px'),
      ),
      'the guest must be told the band the local page reserves',
    )
    assert.equal(
      doc.documentElement.classList.contains('drg-caption-live'),
      true,
      'the shell caption menus have to stay above a guest that owns the band',
    )
    doc.documentElement.setAttribute('data-fullscreen', 'true')
    calls.length = 0
    fire(view, 'did-stop-loading')
    await settle()
    const captionAt = calls.findIndex((code) => code.includes('data-windows-titlebar'))
    const rowAt = calls.findIndex((code) => code.includes('function mountHostRow'))
    assert.ok(rowAt >= 0, 'the row script must still run')
    assert.ok(captionAt >= 0 && captionAt < rowAt, 'the caption must be applied first')
    assert.match(calls[captionAt], /toggleAttribute\("data-fullscreen",true\)/)
    fire(view, 'did-fail-load', { isMainFrame: true, errorCode: -2 })
    await settle()
    assert.equal(root.style.top, '40px')
    assert.equal(grip.style.display, 'none')
    takeover.carrier.hide()
    assert.equal(doc.documentElement.classList.contains('drg-caption-live'), false)
  } finally {
    await takeover.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('a guest that refuses the caption script stays below the local band', async () => {
  const doc = fakeDocument({ captionHeight: '40px' })
  const takeover = loadClientPlugin({
    document: doc,
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--dsh-windows-titlebar-height' ? '40px' : ''),
    }),
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-2', partition: 'persist:dsh-remote-go:h_a' }),
        release: async () => {},
      },
    },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
  try {
    await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    const grip = root.children.find((node) => node.className === 'drg-carrier-grip')
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    view.loadURL = () => Promise.resolve()
    view.executeJavaScript = () => Promise.resolve(null)
    fire(view, 'dom-ready')
    await settle()
    assert.equal(root.style.top, '40px', 'the guest must not overlap the local band')
    assert.equal(grip.style.display, 'none', 'the drag strip is only for the covered band')
    assert.equal(doc.documentElement.classList.contains('drg-caption-live'), false)
  } finally {
    await takeover.carrier.close()
  }
})

test('the guest mirror reports the rail state and the authority inset on the bridge queue', () => {
  const local = loadClientPlugin({ document: fakeDocument() })
  // The guest hands over DSH's own resolved value; these two are the fallback for a guest that
  // cannot answer (84px = the collapsed rail's controls: toggle at 12px + 28, new-session at 48px
  // + 28, 8px of air; 48px = the shell preload's own default).
  assert.equal(local.carrier.captionMenuStart(true, ''), '84px', 'a collapsed rail ends its controls at 84px')
  assert.equal(local.carrier.captionMenuStart(false, ''), '48px', 'an expanded sidebar keeps the preload default')
  assert.equal(local.carrier.captionMenuStart(true, ' 96px '), '96px', 'the guest value wins over the fallback')
  assert.equal(local.carrier.captionMenuStart(true, 'garbage'), '84px', 'an unreadable value falls back')
  assert.equal(local.carrier.captionMenuStart(true, '9999px'), '84px', 'an absurd inset is not copied')
  const script = local.carrier.sidebarMirror()
  assert.match(script, /^\(function mountSidebarMirror\(win\)/)
  const observers = []
  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    disconnect() {}
  }
  let rail = false
  let resolved = ''
  const guestDom = {
    documentElement: {},
    querySelector(selector) {
      if (selector !== '[data-sidebar-collapsed]') return null
      return rail ? { getAttribute: () => 'true' } : null
    },
  }
  const guestWindow = {
    document: guestDom,
    MutationObserver: FakeObserver,
    // The guest carries the desktop marker, so DSH's sidebar rule resolves the menubar inset there.
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--dsh-windows-menu-start' ? resolved : '') }),
  }
  const install = new Function('window', 'return ' + script)
  assert.deepEqual(
    install(guestWindow),
    { collapsed: false, start: '' },
    'the record at install time tells the host where to start',
  )
  assert.deepEqual(guestWindow.__drgBridgeQueue, [{ action: 'caption-sidebar', collapsed: false, start: '' }])
  // The remote UI marks the frame it collapsed, and its own rule raises the inset: report both.
  rail = true
  resolved = ' 84px '
  observers[0].callback()
  assert.deepEqual(guestWindow.__drgBridgeQueue.at(-1), {
    action: 'caption-sidebar',
    collapsed: true,
    start: '84px',
  })
  observers[0].callback()
  assert.equal(guestWindow.__drgBridgeQueue.length, 2, 'a state that did not change is not reported again')
  // The host replaces the queue after every drain, so a report must never cache the old array.
  guestWindow.__drgBridgeQueue = []
  rail = false
  resolved = ''
  observers[0].callback()
  assert.deepEqual(guestWindow.__drgBridgeQueue, [{ action: 'caption-sidebar', collapsed: false, start: '' }])
  assert.equal(install(guestWindow), 'already', 'a second install into the same document is a no-op')
  // A guest that cannot resolve the variable still reports the rail state: the host falls back.
  const bare = {
    document: { documentElement: {}, querySelector: () => ({ getAttribute: () => 'true' }) },
    MutationObserver: FakeObserver,
  }
  assert.deepEqual(new Function('window', 'return ' + script)(bare), { collapsed: true, start: '' })
  const throwing = {
    document: bare.document,
    MutationObserver: FakeObserver,
    getComputedStyle() {
      throw new Error('detached')
    },
  }
  assert.deepEqual(new Function('window', 'return ' + script)(throwing), { collapsed: true, start: '' })
})

test('a collapsed guest rail moves the local caption menubar with it', async () => {
  const doc = fakeDocument({ captionHeight: '40px' })
  const released = []
  const takeover = loadClientPlugin({
    document: doc,
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--dsh-windows-titlebar-height' ? '40px' : ''),
    }),
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }),
        release: async (lease) => released.push(lease),
      },
    },
  })
  const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  const menuStart = () => doc.documentElement.style.getPropertyValue('--dsh-windows-menu-start')
  const takeScript = takeover.carrier.intentsScript()
  try {
    const opened = await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    assert.equal(opened.ok, true)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    view.loadURL = () => Promise.resolve()
    // The guest answers in the order the carrier asks: caption, rail state, row, then the queue.
    let drained = false
    view.executeJavaScript = (code) => {
      if (code.includes('mountSidebarMirror')) return Promise.resolve({ collapsed: true, start: '84px' })
      if (code.includes('mountHostRow')) return Promise.resolve('installed')
      if (code === takeScript) {
        const pending = drained ? [] : [{ action: 'caption-sidebar', collapsed: false, start: '' }]
        drained = true
        return Promise.resolve(pending)
      }
      return Promise.resolve('ok')
    }
    fire(view, 'dom-ready')
    await settle()
    assert.equal(
      menuStart(),
      '48px',
      'a guest that owns the band starts from the shell default until its rail is known',
    )
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(menuStart(), '84px', 'the collapsed rail leaves the band to the new-session control first')
    // The rail reports its later expansion through the same queue the row's clicks use.
    await settle(520)
    assert.equal(menuStart(), '48px', 'an expanded rail hands the 48px start back')
    takeover.carrier.hide()
    assert.equal(menuStart(), '', 'the local page takes the band and its own sidebar rule back')
  } finally {
    await takeover.carrier.close()
  }
  assert.deepEqual(released, ['lease-1'])
})

test('a rail report queued while the host drains is neither dropped nor dispatched', async () => {
  const doc = fakeDocument({ captionHeight: '40px' })
  const local = loadClientPlugin({
    document: doc,
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--dsh-windows-titlebar-height' ? '40px' : ''),
    }),
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-2', partition: 'persist:dsh-remote-go:h_a' }),
        release: async () => {},
      },
    },
  })
  // The real plugin must be applied: a leaked caption intent would then act like a row click.
  runApply(local)
  const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  const menuStart = () => doc.documentElement.style.getPropertyValue('--dsh-windows-menu-start')
  const takeScript = local.carrier.intentsScript()
  // The report that is queued while the host is taking the previous one. It carries the row's own
  // shape (`target`) so that falling through to the dispatch would switch the window away.
  const late = { action: 'caption-sidebar', collapsed: true, start: '84px', target: 'local' }
  const first = { action: 'caption-sidebar', collapsed: false, start: '' }
  const guestQueue = [first]
  let drained = 0
  let legacyClear = false
  try {
    const opened = await local.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    assert.equal(opened.ok, true)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    view.loadURL = () => Promise.resolve()
    view.executeJavaScript = (code) => {
      if (code.includes('mountSidebarMirror')) return Promise.resolve({ collapsed: true, start: '84px' })
      if (code.includes('mountHostRow')) return Promise.resolve('installed')
      if (code === takeScript) {
        // One round trip takes and clears together; a report pushed right after it stays queued.
        const taken = guestQueue.splice(0, guestQueue.length)
        if (drained === 0) guestQueue.push(late)
        drained += 1
        return Promise.resolve(taken)
      }
      if (code === 'window.__drgBridgeQueue || []') {
        // The two-call protocol this replaced: read, then a separate clear (below) that wiped
        // whatever the guest queued in between.
        const taken = guestQueue.slice()
        if (drained === 0) guestQueue.push(late)
        drained += 1
        return Promise.resolve(taken)
      }
      if (code === 'window.__drgBridgeQueue = []') {
        guestQueue.length = 0
        legacyClear = true
        return Promise.resolve('ok')
      }
      return Promise.resolve('ok')
    }
    fire(view, 'dom-ready')
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(menuStart(), '84px', 'the mirror install is adopted at once')
    // First poll round: the queued report is applied, and the late one is queued during it.
    await settle(520)
    assert.equal(menuStart(), '48px')
    // Second round: the report queued during the first one must still arrive.
    await settle(700)
    assert.equal(menuStart(), '84px', 'the report queued during the drain must not be lost')
    assert.equal(legacyClear, false, 'the intents must be taken and cleared in one round trip')
    assert.equal(local.carrier.shown(), 'h_a', 'nor may it reach the switcher dispatch')
  } finally {
    await local.carrier.close()
  }
})

test('a navigation forgets the rail state of the document it replaced', async () => {
  const doc = fakeDocument({ captionHeight: '40px' })
  const takeover = loadClientPlugin({
    document: doc,
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--dsh-windows-titlebar-height' ? '40px' : ''),
    }),
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-1', partition: 'persist:dsh-remote-go:h_a' }),
        release: async () => {},
      },
    },
  })
  const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
  const menuStart = () => doc.documentElement.style.getPropertyValue('--dsh-windows-menu-start')
  try {
    await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    view.loadURL = () => Promise.resolve()
    view.executeJavaScript = (code) => {
      if (code.includes('mountSidebarMirror')) return Promise.resolve({ collapsed: true, start: '84px' })
      if (code.includes('mountHostRow')) return Promise.resolve('installed')
      return Promise.resolve('ok')
    }
    fire(view, 'dom-ready')
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(menuStart(), '84px')
    // The remote page navigates again. Its new document has not reported a rail yet, so the band
    // must fall back to the shell default instead of repeating the old document's 84px.
    view.executeJavaScript = (code) => {
      if (code.includes('mountSidebarMirror')) return Promise.resolve({ collapsed: false, start: '' })
      if (code.includes('mountHostRow')) return Promise.resolve('installed')
      return Promise.resolve('ok')
    }
    fire(view, 'dom-ready')
    await settle()
    assert.equal(menuStart(), '48px', 'the replaced document’s rail must not be written onto this band')
  } finally {
    await takeover.carrier.close()
  }
})

test('the browser carrier leaves the caption menubar to the local page', async () => {
  const doc = fakeDocument()
  const local = loadClientPlugin({ document: doc })
  const opened = await local.carrier.open({ hostId: 'h_a', url: '/dsh-remote-go/remote/h_a/?token=abc' })
  assert.equal(opened.ok, true)
  assert.equal(local.carrier.shown(), 'h_a')
  assert.equal(
    doc.documentElement.style.getPropertyValue('--dsh-windows-menu-start'),
    '',
    'the browser build has no caption band of its own: the local page keeps its rule',
  )
  local.carrier.hide()
  assert.equal(doc.documentElement.style.getPropertyValue('--dsh-windows-menu-start'), '')
  await local.carrier.close()
})

test('a carrier is revealed only after its guest has painted', async () => {
  const doc = fakeDocument()
  const takeover = loadClientPlugin({
    document: doc,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-9', partition: 'persist:dsh-remote-go:h_a' }),
        release: async () => {},
      },
    },
  })
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const opened = await takeover.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    assert.equal(opened.ok, true)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    assert.ok(root, 'the carrier must still mount on document.body')
    // The switch starts transparent: revealing a hidden `<webview>` as-is would paint the
    // carrier's own background for a frame before the guest has anything to show.
    assert.equal(root.style.display, '')
    assert.equal(root.style.opacity, '0')
    assert.equal(root.style.pointerEvents, 'none')

    const calls = []
    const view = root.children.find((node) => node.className === 'drg-carrier-view')
    view.executeJavaScript = (code) => {
      calls.push(code)
      return Promise.resolve(code.includes('requestAnimationFrame') ? 'ok' : 'installed')
    }
    fire(view, 'did-stop-loading')
    await settle(140)
    assert.ok(
      calls.some((code) => code.includes('requestAnimationFrame')),
      'the reveal must wait for a frame of the guest',
    )
    assert.equal(root.style.opacity, '', 'a painted guest lets the carrier become opaque')
    assert.equal(root.style.pointerEvents, '')

    // Leaving before the guest paints must not leave it opaque for the next visit.
    takeover.carrier.hide()
    assert.equal(root.style.display, 'none')
    const again = await takeover.carrier.open({ hostId: 'h_a' })
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
    assert.equal(root.style.opacity, '0', 'a reopen starts transparent again')
    takeover.carrier.hide()
    await settle(140)
    assert.equal(root.style.display, 'none', 'a reveal that lost the window must not show it')
    assert.equal(root.style.opacity, '0', 'nor make it opaque')
  } finally {
    await takeover.carrier.close()
  }
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
  assert.equal(itemDotState(items[0]), 'local')
  assert.equal(itemDotState(items[1]), 'connected')
  assert.equal(itemDotState(items[2]), 'disconnected')
  assert.equal(items[0].getAttribute('data-active'), '1')
  assert.equal(items[1].getAttribute('data-target'), 'h_a')
  assert.equal(items[2].getAttribute('data-target'), 'h_b')
  assert.equal(items[3].getAttribute('data-action'), 'add')
  assert.equal(items[4].getAttribute('data-action'), 'manage', 'management is the last entry')
  for (const action of [items[3], items[4]]) {
    assert.ok(
      action.children.some((child) => child.className === 'drg-hr-glyph'),
      'an action must not look like an unconnected host',
    )
  }
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
  assert.equal(menu.style.top, '804px')
  assert.equal(menu.style.width, '280px')
  clickInside(row, row)
  assert.equal(row.getAttribute('aria-expanded'), 'false')
  clickInside(row, row)
  clickInside(row, rowItems(row)[1])
  assert.equal(row.getAttribute('aria-expanded'), 'false', 'a pick closes the menu')
  local.carrier.update({ hosts: [] })
  assert.equal(rowName(row), '本地')
  assert.deepEqual(rowItems(row).map(itemLabel), ['本地', '添加主机', '管理界面'])
})

test('the switcher menu surface does not inherit the row hand', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  local.carrier.update({ hosts: [], labels: { local: '本地', addHost: '添加主机', manage: '管理界面' } })
  const style = dom.head.children.find((node) => node.tagName === 'STYLE')
  assert.ok(style, 'the row injects its stylesheet into the page head')
  const menuRule = style.textContent.match(/#drg-host-row \.drg-hr-menu\{[^}]*\}/)
  assert.ok(menuRule, 'the menu surface must have a rule of its own')
  assert.match(menuRule[0], /cursor:default/)
  const itemRule = style.textContent.match(/#drg-host-row \.drg-hr-item\{[^}]*\}/)
  assert.ok(itemRule)
  assert.match(itemRule[0], /cursor:pointer/, 'the entries themselves stay clickable')
})

test('the guest script installs the same row and leaves intents on the page bridge', () => {
  const dom = fakeDom()
  const local = loadClientPlugin({ document: dom.document })
  const script = local.carrier.script()
  assert.match(script, /^\(function mountHostRow\(win\)/)
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
  clickInside(row, items[items.length - 1])
  clickInside(row, items[0])
  assert.deepEqual(guestWindow.__drgBridgeQueue, [{ action: 'add' }, { action: 'manage' }, { target: 'local' }])
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
  const face = calls.registers.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  clickInside(row, rowItems(row)[0])
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'local' }, 'picking local hands the window back')
  local.carrier.update({ hosts: [hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })] })
  clickInside(row, rowItems(row)[1])
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'open', hostId: 'h_a' })
  assert.equal(rowName(row), '43.133.80.40')
  clickInside(row, rowItems(row).at(-2))
  assert.deepEqual({ ...face.wizardStore.current() }, { mode: 'add', host: null })
  face.wizardStore.close()
  assert.equal(face.wizardStore.current(), null)
  clickInside(row, rowItems(row).at(-1))
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'manage' })
  assert.deepEqual(calls.selectPanel, [])
})

test('opening a host or a window from the remote keeps the remote behind it', async () => {
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
  clickInside(row, rowItems(row).at(-1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'manage' })
  assert.equal(local.carrier.shown(), 'h_a', 'the remote must stay in front of the local page')
  clickInside(row, rowItems(row).at(-2))
  assert.deepEqual({ ...face.wizardStore.current() }, { mode: 'add', host: null })
  assert.equal(local.carrier.shown(), 'h_a', 'the wizard floats over the remote')
  face.wizardStore.close()
  clickInside(row, rowItems(row)[0])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'local' })
  assert.equal(local.carrier.shown(), null)
  assert.equal(local.carrier.warm('h_a'), true, 'the window stays warm for the next visit')
  const hidden = roots()[0]
  assert.equal(hidden.style.display, 'none')
  const again = await local.carrier.open({ hostId: 'h_a' })
  assert.equal(again.reused, true)
  assert.equal(roots().length, 1)
  assert.notEqual(roots()[0].style.display, 'none')
  await local.carrier.close()
  assert.equal(roots().length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('dropping the window that fills the screen hands the row back to the local page', async () => {
  const dom = fakeDom()
  const released = []
  let leases = 0
  const local = loadClientPlugin({
    document: dom.document,
    desktop: {
      protocolVersion: 1,
      browser: {
        acquire: async () => ({ lease: 'lease-' + (leases += 1), partition: 'persist:dsh-remote-go:' + leases }),
        release: async (lease) => released.push(lease),
      },
    },
  })
  runApply(local)
  const open = (hostId, url) => local.carrier.open({ hostId, url })
  await open('h_a', 'http://127.0.0.1:43210/?token=abc')
  await local.carrier.update({
    hosts: [
      hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' }),
      hostView({ id: 'h_b', name: '生产机', status: 'connected' }),
    ],
    current: 'h_a',
  })
  const row = rowOf(dom)
  assert.equal(rowName(row), '43.133.80.40')
  assert.equal(local.carrier.shown(), 'h_a')
  await open('h_b', 'http://127.0.0.1:43211/?token=def')
  await open('h_a', '')
  assert.equal(local.carrier.shown(), 'h_a')
  await local.carrier.closeOne('h_b')
  assert.equal(local.carrier.warm('h_b'), false)
  assert.equal(rowName(rowOf(dom)), '43.133.80.40', 'a hidden window must not move the row')
  await local.carrier.closeOne('h_a')
  assert.equal(local.carrier.shown(), null)
  assert.equal(local.carrier.warm('h_a'), false)
  assert.equal(rowName(rowOf(dom)), '本地', 'the row must not name a host whose window is gone')
  assert.deepEqual(released, ['lease-2', 'lease-1'])
})

test('the browser carrier frames the proxied view and injects the switcher there', async () => {
  const doc = fakeDocument()
  const local = loadClientPlugin({ document: doc })
  try {
    assert.equal(local.carrier.surface(), 'web', 'without a desktop bridge the page carrier is the seat')
    // The loopback origin belongs to the desktop guest; in a browser it is not a valid seat.
    const bad = await local.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:43210/?token=abc' })
    assert.deepEqual({ ok: bad.ok, reason: bad.reason }, { ok: false, reason: 'bad-url' })
    const view = '/dsh-remote-go/remote/h_a/?token=abc'
    const opened = await local.carrier.open({ hostId: 'h_a', url: view })
    assert.equal(opened.ok, true)
    assert.equal(opened.reused, false)
    const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-h_a')
    assert.ok(root, 'the frame carrier must mount on document.body')
    assert.match(root.style.cssText, /position:fixed/)
    const frame = root.children.find((node) => node.tagName === 'IFRAME')
    assert.ok(frame, 'the browser carrier uses one same-origin frame')
    assert.equal(frame.src, view)
    assert.equal(frame.attributes.sandbox, undefined, 'the same-origin seat must not be sandboxed')
    // The frame committed its document: the row and the file bridge live inside it.
    const frameWindow = { document: fakeFrameDocument(), innerHeight: 800, innerWidth: 1200 }
    frame.contentWindow = frameWindow
    fire(frame, 'load', {})
    assert.equal(typeof frameWindow.__drgBridgeSink, 'function', 'clicks must reach this module directly')
    assert.ok(frameWindow.__drgHostRow, 'the switcher row must be injected into the framed page')
    assert.equal(frameWindow.__drgGuestTools, true, 'the file bridge must be injected too')
    await local.carrier.update({
      hosts: [hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })],
      current: 'h_a',
    })
    assert.equal(local.carrier.shown(), 'h_a')
    local.carrier.hide()
    assert.equal(root.style.display, 'none')
    assert.equal(local.carrier.warm('h_a'), true, 'a hidden frame stays warm')
    const again = await local.carrier.open({ hostId: 'h_a' })
    assert.equal(again.reused, true)
    assert.notEqual(root.style.display, 'none')
    await local.carrier.close()
    assert.equal(doc.body.children.filter((node) => String(node.id).indexOf('dsh-remote-go-overlay-') === 0).length, 0)
  } finally {
    await local.carrier.close()
  }
})

/**
 * A live browser carrier with the capability bridge installed into a framed page. `execCommand`
 * is this (top-level) document's clipboard fallback; `frameExecCommand` is the frame's own.
 */
async function framedCarrier(options = {}) {
  const execCalls = []
  const doc = fakeDocument({
    execCommand:
      options.execCommand === undefined
        ? () => {
            execCalls.push('copy')
            return true
          }
        : options.execCommand,
  })
  const opened = []
  const local = loadClientPlugin({
    document: doc,
    URL,
    open:
      options.open === undefined
        ? (...args) => {
            opened.push(args)
            return { closed: false }
          }
        : options.open,
  })
  const { calls } = runApply(local)
  const face = calls.registers.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  const hostId = options.hostId === undefined ? 'h_a' : options.hostId
  await local.carrier.open({ hostId, url: `/dsh-remote-go/remote/${hostId}/?token=abc` })
  const root = doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-' + hostId)
  const frame = root.children.find((node) => node.tagName === 'IFRAME')
  const frameNative = []
  const frameWindow = {
    document: fakeFrameDocument({ execCommand: options.frameExecCommand }),
    innerWidth: 1200,
    innerHeight: 800,
    URL,
    location: {
      origin: 'http://127.0.0.1:1',
      href: `/dsh-remote-go/remote/${hostId}/`,
    },
    navigator: {
      clipboard: {
        writeText: async (text) => {
          frameNative.push(text)
          throw new Error('Document is not focused.')
        },
      },
    },
    open: (...args) => {
      frameNative.push(args)
      return { native: true }
    },
  }
  frame.contentWindow = frameWindow
  fire(frame, 'load', {})
  return { local, face, doc, frame, frameWindow, opened, execCalls, frameNative }
}

test('the capability bridge opens external links from the frame at the top level', async () => {
  const { frame, frameWindow, opened, face } = await framedCarrier()
  assert.equal(frameWindow.__drgCapabilityBridge, true, 'the bridge must be installed with the frame')
  // `allow` can only narrow, but it still has to name what the remote page may legitimately use.
  for (const token of ['clipboard-read', 'clipboard-write', 'microphone', 'fullscreen', 'popups']) {
    assert.match(frame.attributes.allow, new RegExp(`\\b${token}\\b`), `the frame must declare ${token}`)
  }

  const external = fakeClick(fakeLinkTarget(fakeAnchor({ href: 'https://example.com/report' })))
  fire(frameWindow.document, 'click', external)
  assert.equal(external.prevented, true, 'the frame cannot navigate itself to an external page')
  assert.equal(external.stopped, true, 'the page’s own handler must not open a nested browser tab instead')
  assert.deepEqual(opened.at(-1), ['https://example.com/report', '_blank', 'noopener,noreferrer'])

  // Only a web URL leaves the frame: a script/data URL, a relative path and a same-origin link
  // are the framed application's own business.
  const javascriptUrl = fakeClick(fakeLinkTarget(fakeAnchor({ href: 'javascript:alert(1)' })))
  fire(frameWindow.document, 'click', javascriptUrl)
  assert.equal(javascriptUrl.prevented, false)
  const relative = fakeClick(fakeLinkTarget(fakeAnchor({ href: '/sessions/current' })))
  fire(frameWindow.document, 'click', relative)
  assert.equal(relative.prevented, false)
  const sameOrigin = fakeClick(
    fakeLinkTarget(fakeAnchor({ href: 'http://127.0.0.1:1/dsh-remote-go/remote/h_a/settings' })),
  )
  fire(frameWindow.document, 'click', sameOrigin)
  assert.equal(sameOrigin.prevented, false, 'the framed app keeps its own same-origin navigation')
  // The plugin's own file-menu entry is not a navigation.
  const ownItem = fakeClick(fakeLinkTarget(fakeAnchor({ href: 'https://example.com/x' }), { ownDownload: true }))
  fire(frameWindow.document, 'click', ownItem)
  assert.equal(ownItem.prevented, false, 'the download entry the plugin injected must keep working')

  // A modified or non-primary click is the user asking for the browser's own behaviour
  // (background tab, new window, middle-click): the bridge must leave it alone.
  const narrowed = opened.length
  for (const gesture of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const modified = fakeClick(fakeLinkTarget(fakeAnchor({ href: 'https://example.com/modified' })), gesture)
    fire(frameWindow.document, 'click', modified)
    assert.equal(modified.prevented, false, `a ${JSON.stringify(gesture)} click keeps the browser default`)
  }
  assert.equal(opened.length, narrowed, 'no modified or middle click may become a bridge intent')

  // `window.open` in the frame turns into the same intent and returns no window.
  assert.equal(frameWindow.open('https://example.com/tab'), null)
  assert.deepEqual(opened.at(-1), ['https://example.com/tab', '_blank', 'noopener,noreferrer'])
  // `about:blank` is the account login's popup skeleton: it has no URL to hand over.
  const blank = frameWindow.open('about:blank')
  assert.equal(blank.native, true, 'a blank popup still goes to the browser')

  // A sink call is the trust boundary: an unsafe URL is refused and said out loud, not opened.
  const before = opened.length
  frameWindow.__drgBridgeSink({ action: 'open-external', url: 'javascript:alert(1)' })
  assert.equal(opened.length, before, 'no external window may be opened for a non-web URL')
  assert.deepEqual(
    { ...face.toolStore.take() },
    {
      kind: 'notice',
      tone: 'error',
      text: '无法打开这个链接：只支持 http 或 https 外链。',
    },
  )
})

test('the capability bridge performs the clipboard write at the top level and answers the frame', async () => {
  const success = await framedCarrier()
  const copied = await success.frameWindow.navigator.clipboard.writeText('code block text')
  assert.equal(copied, undefined, 'a successful write resolves the page’s `writeText`')
  assert.deepEqual(success.execCalls, ['copy'], 'the top-level document is the one that writes')
  assert.deepEqual(success.frameNative, [], 'the frame’s own refused clipboard API is not used')

  // The top-level write fails: the frame's own legacy copy is the next resort…
  const legacy = await framedCarrier({ execCommand: () => false, frameExecCommand: () => true })
  assert.equal(await legacy.frameWindow.navigator.clipboard.writeText('fallback'), undefined)

  // …and when that fails too the page learns it, and so does the user.
  const refused = await framedCarrier({ execCommand: () => false, frameExecCommand: () => false })
  await assert.rejects(refused.frameWindow.navigator.clipboard.writeText('nope'), /clipboard-write-failed/)
  assert.deepEqual(
    { ...refused.face.toolStore.take() },
    {
      kind: 'notice',
      tone: 'error',
      text: '复制失败：远端界面没能写入剪贴板。',
    },
  )
})

test('the notify intent reuses the shell toast channel', async () => {
  const { frameWindow, face } = await framedCarrier()
  frameWindow.__drgBridgeSink({ action: 'notify', tone: 'error', code: 'clipboard-failed' })
  assert.deepEqual(
    { ...face.toolStore.take() },
    {
      kind: 'notice',
      tone: 'error',
      text: '复制失败：远端界面没能写入剪贴板。',
    },
  )
  // A tone that is not a toast tone is shown as information, not as a second error style.
  // Free text is the framed page's own message, so it always names its origin.
  frameWindow.__drgBridgeSink({ action: 'notify', text: '远端页面自己的一句话' })
  assert.deepEqual(
    { ...face.toolStore.take() },
    {
      kind: 'notice',
      tone: 'info',
      text: '远端界面：远端页面自己的一句话',
    },
  )
})

test('the desktop guest runs the same bridge script through the queue and the reply slot', async () => {
  const local = loadClientPlugin({ document: fakeDocument() })
  const factory = new Function('window', 'return ' + local.carrier.capabilities())
  const guestWindow = {
    document: fakeFrameDocument(),
    innerHeight: 800,
    URL,
    location: { origin: 'http://127.0.0.1:2', href: 'http://127.0.0.1:2/' },
    navigator: { clipboard: { writeText: async () => undefined } },
    open: (...args) => ({ native: true, args }),
  }
  assert.equal(factory(guestWindow), 'installed')
  assert.equal(factory(guestWindow), 'already', 'a second load stop must not stack another bridge')

  assert.equal(guestWindow.open('https://example.com/queued'), null)
  assert.deepEqual(
    guestWindow.__drgBridgeQueue.map((intent) => intent.action),
    ['open-external'],
  )
  assert.equal(guestWindow.__drgBridgeQueue[0].url, 'https://example.com/queued')
  assert.equal(guestWindow.open('about:blank').native, true)

  // The desktop carrier cannot call into the guest: it answers through `__drgCapabilityReply`.
  const pending = guestWindow.navigator.clipboard.writeText('desktop text')
  const intent = guestWindow.__drgBridgeQueue.find((entry) => entry.action === 'clipboard-write')
  assert.ok(intent && typeof intent.id === 'string' && intent.id !== '')
  assert.equal(intent.text, 'desktop text')
  assert.equal(guestWindow.__drgCapabilityReply({ id: intent.id, ok: true }), true)
  assert.equal(await pending, undefined)
  assert.equal(guestWindow.__drgCapabilityReply({ id: intent.id, ok: true }), false, 'a receipt is one-shot')
})

test('the frame gets its own localStorage namespace per host', async () => {
  const local = loadClientPlugin({ document: fakeDocument() })
  const raw = fakeStorage()
  const first = fakeGuestWindow(raw)
  const second = fakeGuestWindow(raw)
  assert.equal(local.carrier.partition(first, 'h_a'), 'installed')
  assert.equal(local.carrier.partition(second, 'h_b'), 'installed')
  assert.equal(local.carrier.partition(first, 'h_a'), 'already')
  assert.equal(local.carrier.partition({ localStorage: raw }, 'bad id'), 'bad-id')

  first.localStorage.setItem('dsh.keybindings.v1', 'remote')
  second.localStorage.setItem('dsh.keybindings.v1', 'other')
  assert.equal(first.localStorage.getItem('dsh.keybindings.v1'), 'remote')
  assert.equal(second.localStorage.getItem('dsh.keybindings.v1'), 'other', 'two hosts never share a key')
  assert.equal(raw.getItem('dsh.keybindings.v1'), null, 'the local page keeps its own key untouched')
  assert.equal(raw.getItem('drg:h_a:dsh.keybindings.v1'), 'remote')
  assert.equal(raw.getItem('drg:h_b:dsh.keybindings.v1'), 'other')
  assert.equal(first.localStorage.length, 1)
  assert.equal(first.localStorage.key(0), 'dsh.keybindings.v1')
  assert.equal(first.localStorage.key(1), null)

  // Clearing one host's namespace must not clear the origin.
  raw.setItem('local-only', 'keep')
  first.localStorage.clear()
  assert.equal(first.localStorage.getItem('dsh.keybindings.v1'), null)
  assert.equal(second.localStorage.getItem('dsh.keybindings.v1'), 'other')
  assert.equal(raw.getItem('local-only'), 'keep')

  // A live `storage` event raised by the local page must not drive the remote UI.
  const foreign = {
    key: 'dsh.keybindings.v1',
    stopped: false,
    stopImmediatePropagation() {
      this.stopped = true
    },
  }
  for (const handler of first.listeners.storage || []) handler(foreign)
  assert.equal(foreign.stopped, true)
  const own = {
    key: 'drg:h_a:dsh.keybindings.v1',
    stopped: false,
    stopImmediatePropagation() {
      this.stopped = true
    },
  }
  for (const handler of first.listeners.storage || []) handler(own)
  assert.equal(own.stopped, false, 'this host’s own updates must still reach the page')
})

test('the disconnect handover reads the live window target, not the mount-time one', () => {
  const captured = /if \(target === (?:host\.id|intent\.hostId)\) setTarget\(null\)/.test(SOURCE)
  assert.equal(captured, false, 'the disconnect must not decide from a captured target')
  const live = /setTarget\(\(current\) => \(current === host\.id \? null : current\)\)/.test(SOURCE)
  assert.equal(live, true, 'the disconnect must hand the window back with a functional update')
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

test('the add-host dialog is one form with save and connect, and no test step', () => {
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
  assert.match(html, /data-testid="wizard-save"/)
  assert.match(html, /data-testid="wizard-connect"/)
  assert.match(html, />保存</)
  assert.match(html, />连接</)
  assert.doesNotMatch(html, /保存并测试|保存和测试/)
  assert.doesNotMatch(html, /wizard-step-|连接测试|稍后再说/)
  assert.doesNotMatch(html, /data-testid="wizard-cancel"/)
  assert.match(html, /密钥文件/)
  assert.doesNotMatch(html, /SSH Agent/)
  assert.match(html, /远端存活策略/)
  assert.match(html, /value="~\/\.ssh\/id_rsa"/)
  assert.match(html, /data-testid="wizard-auto-reconnect"/)
  assert.match(html, /data-testid="wizard-advanced"/)
  assert.match(html, />高级选项</)
  assert.match(html, /data-testid="wizard-keep-alive"/)
  assert.match(html, /主机指纹策略/)
  assert.match(html, /data-testid="wizard-key-path-pick"/)
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
  assert.doesNotMatch(html, /呈现形态/)
  assert.doesNotMatch(html, /面板内嵌/)
  assert.match(html, /主机指纹策略/)
  assert.match(html, /允许保存访问令牌/)
  assert.match(html, /风险提示|0600/)
  assert.doesNotMatch(html, /关闭视窗行为/)
  assert.doesNotMatch(html, /镜像会话/)
  assert.doesNotMatch(html, /显示在本地侧边栏/)
  assert.match(html, /远端运行时/)
  assert.match(html, /DSH profile/)
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

test('the download progress card renders a determinate bar, byte counts and file counts', () => {
  const t = (key, params) => {
    if (key === 'downloadPreparing') return 'Downloading ' + params.name
    if (key === 'downloadFiles') return params.done + ' / ' + params.total + ' files'
    return key
  }
  const element = plugin.components.DownloadProgress({
    job: {
      id: 'dl_1',
      phase: 'preparing',
      name: 'project',
      totalBytes: 100,
      doneBytes: 40,
      totalFiles: 3,
      doneFiles: 1,
    },
    t,
    locale: 'en',
    onCancel: () => {},
  })
  const html = render(element)
  assert.match(html, /data-testid="dsh-remote-go-download"/)
  assert.match(html, /Downloading project/)
  assert.match(html, /aria-valuenow="40"/)
  assert.match(html, /width:40%/)
  assert.match(html, /40 B \/ 100 B/)
  assert.match(html, /1 \/ 3 files/)
  assert.match(html, /drg-download-grip/)
  assert.match(html, />downloadCancel</)
})

test('the download stack is a draggable transform layer over the bottom-right anchor', () => {
  const t = (key, params) => {
    if (key === 'downloadPreparing') return 'Downloading ' + params.name
    return key
  }
  const html = render(
    React.createElement(plugin.components.DownloadCenter, {
      jobs: [
        { id: 'dl_1', phase: 'preparing', name: 'a', totalBytes: 10, doneBytes: 5 },
        { id: 'dl_2', phase: 'preparing', name: 'b', totalBytes: 0, doneBytes: 0 },
      ],
      t,
      locale: 'en',
      onCancel: () => {},
      onDismiss: () => {},
    }),
  )
  assert.match(html, /data-testid="dsh-remote-go-downloads"/)
  assert.match(html, /transform:translate\(0px, 0px\)/)
  assert.equal((html.match(/data-testid="dsh-remote-go-download"/g) ?? []).length, 2)
  assert.match(html, /drg-download-action/)
})

test('the download progress card shows an error view and hides the cancel action', () => {
  const t = (key) => key
  const element = plugin.components.DownloadProgress({
    job: {
      id: 'dl_2',
      phase: 'error',
      name: 'broken',
      totalBytes: 0,
      doneBytes: 0,
      error: { title: { zh: '失败', en: 'Failed' }, detail: { zh: '没有权限', en: 'No permission' } },
    },
    t,
    locale: 'en',
    onCancel: () => assert.fail('an error card must not offer cancel'),
  })
  const html = render(element)
  assert.match(html, /downloadFailed/)
  assert.match(html, /No permission/)
  assert.doesNotMatch(html, /downloadCancel/)
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
  assert.match(html, /\[data-shell-overlay\] \{ z-index: 2147483001; \}/)
})

test('host management list renders the empty state and its controls', () => {
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
      onOpenSettings: () => {},
    }),
  )
  assert.match(html, /data-testid="host-list-empty"/)
  assert.match(html, /远程主机/)
  assert.match(html, /data-testid="host-add"/)
  assert.match(html, /data-testid="host-add-empty"/)
  assert.match(html, /data-testid="host-refresh"/)
  assert.match(html, /data-testid="host-settings"/)
  assert.match(html, /还没有远程主机。添加一台，然后打开它的远端 DSH 界面。/)
})

test('host management list offers open/connect actions per host', () => {
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
    React.createElement(plugin.components.HostListView, {
      t,
      state,
      loading: false,
      error: null,
      onAdd: () => {},
      onRefresh: () => {},
      onOpenSettings: () => {},
      onOpenHost: () => {},
      onDisconnectHost: () => {},
      onReconnectHost: () => {},
      onEditHost: () => {},
      onDeleteHost: () => {},
      onDiagnoseHost: () => {},
    }),
  )
  assert.match(html, /data-testid="host-open"/)
  assert.match(html, /data-host-id="h_connected"/)
  assert.match(html, /data-host-id="h_offline"/)
  assert.match(html, />打开</)
  assert.match(html, />连接</)
  assert.match(html, /data-testid="host-reconnect"/)
})

test('every automation data-testid required by acceptance is rendered', () => {
  const host = hostView({ authType: 'password' })
  const base = {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [host],
    settings: {},
    activeHostId: null,
    firstRun: false,
  }
  const empty = { ...base, hosts: [] }
  const noop = () => {}
  const el = React.createElement
  const checks = [
    {
      id: 'ssh-reachable',
      title: { zh: 'SSH 可达性', en: 'SSH reachability' },
      status: 'pass',
      detail: { zh: '可连接', en: 'Reachable' },
    },
  ]
  const error = {
    code: 'auth',
    title: { zh: '认证失败', en: 'Authentication failed' },
    detail: { zh: '检查密钥', en: 'Check the key' },
    nextSteps: [],
    retryable: true,
  }
  const fingerprint = { sha256: 'SHA256:test', keyType: 'ssh-ed25519', status: 'pending', pinned: null }
  const markup = [
    render(el(plugin.components.PluginOverlay, { t, getLocaleId: () => 'zh' })),
    render(
      el(plugin.components.HostListView, {
        t,
        state: empty,
        loading: false,
        error: null,
        onAdd: noop,
        onRefresh: noop,
      }),
    ),
    render(
      el(plugin.components.HostListView, {
        t,
        state: base,
        loading: false,
        error: null,
        onAdd: noop,
        onRefresh: noop,
        onOpenHost: noop,
        onDisconnectHost: noop,
        onReconnectHost: noop,
        onEditHost: noop,
        onDeleteHost: noop,
        onDiagnoseHost: noop,
      }),
    ),
    render(el(plugin.components.WizardDialog, { t, mode: 'add', initialHost: null, state: empty, onClose: noop })),
    render(
      el(plugin.components.WizardDialog, {
        t,
        mode: 'add',
        initialHost: null,
        state: { ...empty, settings: { defaultAuth: 'password' } },
        onClose: noop,
      }),
    ),
    render(
      el(
        plugin.components.ManageWindow,
        manageWindowProps({
          host: hostView({
            status: 'connecting',
            phase: 'ssh',
            progress: { code: 'ssh-connecting' },
            logs: [{ seq: 1, at: '2026-11-14T16:03:12.000Z', level: 'info', message: 'SSH connected' }],
          }),
        }),
      ),
    ),
    render(
      el(plugin.components.DiagnoseDrawer, {
        t,
        host,
        status: 'done',
        report: { summary: 'ok', checks },
        onClose: noop,
        onRun: noop,
      }),
    ),
    render(el(plugin.components.SettingsModal, { t, settings: {}, onClose: noop, onSave: async () => {} })),
    render(el(plugin.components.ErrorCard, { t, error, onRetry: noop })),
    render(el(plugin.components.PasswordPrompt, { t, host, onSubmit: noop, onCancel: noop })),
    render(
      el(plugin.components.FingerprintCard, {
        t,
        host: hostView({ status: 'fingerprint-pending', fingerprint }),
        onAccept: noop,
        onReject: noop,
      }),
    ),
  ]
  const required =
    'dsh-remote-go-overlay-host host-list host-list-empty host-add host-card host-open host-diagnose host-edit host-delete host-stop-remote host-wizard wizard-form wizard-save wizard-connect wizard-name wizard-address wizard-auth wizard-password connect-log connect-log-line manage-live diagnostics diagnose-rerun diagnose-copy settings settings-save settings-default-key-path settings-default-key-path-pick wizard-key-path-pick host-settings error-card error-retry fingerprint-card fingerprint-accept password-prompt'.split(
      ' ',
    )
  assert.equal(required.length, 35)
  const ids = new Set(markup.flatMap(testIdsOf))
  for (const id of required) assert.ok(ids.has(id), `missing data-testid="${id}"`)
  assert.match(markup[2], /data-host-id="h_test"/)
  assert.match(markup[9], /type="password"/)
  assert.match(markup[9], /没有可用的凭据存储|凭据存储/)
  assert.doesNotMatch(JSON.stringify(markup), /dsh-remote-go-sidebar/)
})

test('remote icon is original, currentColor SVG that respects size', () => {
  const html = render(React.createElement(plugin.components.RemoteIcon, { size: 18, active: true }))
  assert.match(html, /<svg[^>]*width="18"[^>]*height="18"/)
  assert.match(html, /stroke="currentColor"/)
  assert.doesNotMatch(html, /fill="#/)
})

// ---------------------------------------------------------------------------------------------
// Audit regressions: dialog stack, state revisions, host fields, validation, a11y and the guest
// intent boundary. These drive the real module (not a re-implementation).
// ---------------------------------------------------------------------------------------------

/** A minimal element with the pieces the dialog stack touches. */
function fakeDialogNode(doc, options = {}) {
  const node = {
    tagName: options.tagName || 'DIV',
    attributes: {},
    focusables: options.focusables || [],
    ownerDocument: doc,
    isConnected: true,
    focused: false,
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    querySelectorAll() {
      return this.focusables
    },
    contains(candidate) {
      return candidate === this || this.focusables.includes(candidate)
    },
    focus() {
      this.focused = true
      doc.activeElement = this
    },
  }
  return node
}

function fakeDialogDocument() {
  const doc = {
    activeElement: null,
    body: { style: { overflow: 'auto' } },
    listeners: {},
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener(type) {
      delete this.listeners[type]
    },
  }
  doc.body = { style: { overflow: 'auto' }, contains: () => false }
  const opener = fakeDialogNode(doc)
  doc.activeElement = opener
  doc.opener = opener
  return doc
}

function pressKey(doc, key, extra = {}) {
  const event = {
    key,
    prevented: false,
    stopped: false,
    shiftKey: false,
    preventDefault() {
      this.prevented = true
    },
    stopPropagation() {
      this.stopped = true
    },
    ...extra,
  }
  for (const handler of doc.listeners.keydown || []) handler(event)
  return event
}

test('a single dialog stack sends Escape to the top layer and restores focus', () => {
  const stack = plugin.__test.createDialogStack()
  const doc = fakeDialogDocument()
  const closed = []
  const lowerInput = fakeDialogNode(doc, { tagName: 'INPUT' })
  const lowerDialog = fakeDialogNode(doc, { focusables: [lowerInput] })
  const upperButton = fakeDialogNode(doc, { tagName: 'BUTTON' })
  const upperDialog = fakeDialogNode(doc, { focusables: [upperButton] })

  const lowerLayer = fakeDialogNode(doc)
  let removeLower = null
  removeLower = stack.push({
    layer: lowerLayer,
    dialog: lowerDialog,
    dismissible: () => true,
    close: () => {
      closed.push('lower')
      removeLower()
    },
  })
  const upperLayer = fakeDialogNode(doc)
  let removeUpper = null
  removeUpper = stack.push({
    layer: upperLayer,
    dialog: upperDialog,
    dismissible: () => true,
    close: () => {
      closed.push('upper')
      removeUpper()
    },
  })

  // One listener on the document, no matter how many dialogs are open (the old bug installed one
  // per dialog and removed/re-added it on every render).
  assert.equal(doc.listeners.keydown.length, 1)
  assert.equal(doc.body.style.overflow, 'hidden', 'the page behind the dialogs must not scroll')
  // Only the top dialog is modal; the lower one is inert.
  assert.equal(upperDialog.getAttribute('aria-modal'), 'true')
  assert.equal(lowerDialog.getAttribute('aria-modal'), null)
  assert.equal(upperLayer.attributes.inert, undefined)
  assert.notEqual(lowerLayer.attributes.inert, undefined)
  assert.equal(doc.activeElement, upperButton, 'focus moves into the dialog that just opened')

  const firstEscape = pressKey(doc, 'Escape')
  assert.deepEqual(closed, ['upper'], 'one Escape closes exactly the top dialog')
  assert.equal(firstEscape.prevented, true)
  assert.equal(firstEscape.stopped, true)

  pressKey(doc, 'Escape')
  assert.deepEqual(closed, ['upper', 'lower'], 'the second Escape closes the lower dialog')
  assert.equal(doc.body.style.overflow, 'auto', 'the scroll lock is released with the last dialog')
  assert.equal(doc.listeners.keydown, undefined, 'the document listener is removed with the last dialog')
  assert.equal(doc.activeElement, doc.opener, 'focus returns to the element that opened the stack')

  removeUpper()
  removeLower()
})

test('a dialog rendered inside the dialog below it keeps the layer it lives in awake', () => {
  const stack = plugin.__test.createDialogStack()
  const doc = fakeDialogDocument()
  const lowerDialog = fakeDialogNode(doc, { focusables: [] })
  const nestedButton = fakeDialogNode(doc, { tagName: 'BUTTON' })
  const nestedDialog = fakeDialogNode(doc, { focusables: [nestedButton] })
  // The confirmation is rendered inside the management window: the lower *layer* contains the
  // top *dialog*, which is what used to make both of them inert (and the dialog unclickable).
  const lowerLayer = fakeDialogNode(doc, { focusables: [nestedDialog] })
  const removeLower = stack.push({
    layer: lowerLayer,
    dialog: lowerDialog,
    dismissible: () => true,
    close: () => {},
  })
  const nestedLayer = fakeDialogNode(doc, { focusables: [nestedDialog] })
  const closed = []
  const removeNested = stack.push({
    layer: nestedLayer,
    dialog: nestedDialog,
    dismissible: () => true,
    close: () => closed.push('nested'),
  })

  assert.equal(nestedDialog.getAttribute('aria-modal'), 'true', 'the nested confirmation owns the modality')
  assert.equal(lowerDialog.getAttribute('aria-modal'), null)
  assert.equal(nestedLayer.attributes.inert, undefined)
  assert.equal(lowerLayer.attributes.inert, undefined, 'the hosting layer must stay interactive')
  assert.equal(doc.activeElement, nestedButton, 'focus enters the nested confirmation')

  pressKey(doc, 'Escape')
  assert.deepEqual(closed, ['nested'], 'Escape still belongs to the nested confirmation')

  removeNested()
  removeLower()
})

test('a busy dialog swallows Escape and the backdrop instead of closing under its request', () => {
  const stack = plugin.__test.createDialogStack()
  const doc = fakeDialogDocument()
  const closed = []
  const dialog = fakeDialogNode(doc, { focusables: [] })
  const remove = stack.push({
    layer: fakeDialogNode(doc),
    dialog,
    dismissible: () => false,
    close: () => closed.push('closed'),
  })
  const event = pressKey(doc, 'Escape')
  assert.deepEqual(closed, [], 'a non-dismissible dialog must ignore Escape')
  assert.equal(event.prevented, true, 'Escape is still consumed so it cannot reach a lower dialog')
  remove()
})

test('the dialog stack cycles Tab inside the top dialog', () => {
  const stack = plugin.__test.createDialogStack()
  const doc = fakeDialogDocument()
  const first = fakeDialogNode(doc, { tagName: 'BUTTON' })
  const last = fakeDialogNode(doc, { tagName: 'BUTTON' })
  const dialog = fakeDialogNode(doc, { focusables: [first, last] })
  const remove = stack.push({
    layer: fakeDialogNode(doc),
    dialog,
    dismissible: () => true,
    close: () => {},
  })
  doc.activeElement = last
  const tab = pressKey(doc, 'Tab')
  assert.equal(tab.prevented, true)
  assert.equal(doc.activeElement, first, 'Tab on the last control wraps to the first')
  doc.activeElement = first
  const shiftTab = pressKey(doc, 'Tab', { shiftKey: true })
  assert.equal(shiftTab.prevented, true)
  assert.equal(doc.activeElement, last, 'Shift+Tab on the first control wraps to the last')
  remove()
})

test('the modal renders aria-labelledby and a focusable dialog element', () => {
  const html = render(React.createElement(plugin.components.Modal, { title: '标题', onClose: () => {} }, 'body'))
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-labelledby="drg-dialog-title-\d+"/)
  assert.match(html, /<h2[^>]*id="drg-dialog-title-\d+"/)
  assert.match(html, /tabindex="-1"/)
  assert.doesNotMatch(html, /aria-modal="true"/, 'the stack marks only the top dialog at mount')
  // A non-dismissible dialog also disables its header ×: Escape and the backdrop are ignored,
  // and the button was the remaining way to close it under a running request (review blocker 3).
  const busy = render(
    React.createElement(
      plugin.components.Modal,
      { title: '标题', onClose: () => {}, dismissible: false, busy: true },
      'body',
    ),
  )
  const close = /<button[^>]*aria-label="Close"[^>]*>/.exec(busy)
  assert.ok(close)
  assert.match(close[0], /disabled=""/)
})

test('state frames are accepted only when their revision is newer, or from a new Host instance', () => {
  const { isNewerState, stateRevision, stateInstance } = plugin.__test
  assert.equal(stateRevision({ rev: 3 }), 3)
  assert.equal(stateRevision({}), null)
  assert.equal(stateInstance({ instance: 'host-1' }), 'host-1')
  assert.equal(stateInstance({}), null)
  assert.equal(isNewerState({ rev: 4 }, 5, null), false, 'an older frame is dropped')
  assert.equal(isNewerState({ rev: 5 }, 5, null), false, 'a duplicate revision is a no-op')
  assert.equal(isNewerState({ rev: 6 }, 5, null), true)
  assert.equal(isNewerState({ hosts: [] }, 5, null), true, 'a Host without rev keeps the old behaviour')
  // The refresh path captures the revision it started from: a slow response older than that is
  // dropped even when it is the last one to resolve.
  assert.equal(isNewerState({ rev: 5 }, 5, null), false)
  assert.equal(isNewerState({ rev: 7 }, 6, null), true)
  // A Host restart or plugin reload resets the counter: the new generation is accepted even when
  // its rev is smaller, otherwise the Client would stay frozen on the old high-water mark.
  assert.equal(isNewerState({ rev: 1, instance: 'host-2' }, 999, 'host-1'), true)
  assert.equal(isNewerState({ rev: 1000, instance: 'host-1' }, 999, 'host-1'), true)
  assert.equal(isNewerState({ rev: 1, instance: 'host-1' }, 999, 'host-1'), false)
})

test('a dropped state stream polls, keeps the banner during retries and returns to live', async () => {
  const scheduled = []
  const cleared = []
  const fakeSetTimeout = (fn, ms) => {
    const timer = { fn, ms }
    scheduled.push(timer)
    return timer
  }
  const fakeClearTimeout = (timer) => {
    cleared.push(timer)
  }
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.closed = false
      instances.push(this)
    }
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    }
    close() {
      this.closed = true
    }
    emit(type, payload) {
      if (type === 'open' && typeof this.onopen === 'function') this.onopen(payload)
      for (const handler of this.listeners[type] || []) handler(payload)
    }
  }
  const states = []
  const statuses = []
  const client = loadClientPlugin({
    EventSource: FakeEventSource,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: { rev: 1, hosts: [] } }) }),
  })
  const dispose = client.__test.subscribeState({
    onState: (state) => states.push(state),
    onStatus: (mode) => statuses.push(mode),
  })
  assert.equal(instances.length, 1)
  assert.deepEqual(statuses, [], 'opening an EventSource does not claim live before `open`')
  instances[0].emit('open', {})
  assert.deepEqual(statuses, ['live'])

  instances[0].emit('error', {})
  assert.deepEqual(statuses.slice(-2), ['polling', 'reconnecting'], 'fallback + a scheduled retry')
  assert.equal(instances[0].closed, true, 'the dead EventSource is closed')
  const retry = scheduled.find((timer) => timer.ms === client.__test.streamRetryDelay(0))
  assert.ok(retry, 'a retry was scheduled with the base delay')
  retry.fn()
  assert.equal(instances.length, 2, 'the retry opens a new EventSource')
  assert.equal(statuses.at(-1), 'reconnecting', 'a reconnect that has not opened yet keeps the banner')

  // The first frame after reconnect proves the stream works again: polling stops, mode is live.
  instances[1].emit('state', { data: JSON.stringify({ rev: 2, hosts: [] }) })
  assert.equal(statuses.at(-1), 'live')
  assert.equal(instances[1].closed, false)
  assert.equal(states.at(-1).rev, 2)
  dispose()
  assert.equal(instances[1].closed, true)
})

test('the automatic reconnect chain stops after the documented attempt cap', () => {
  const scheduled = []
  const cleared = []
  const instances = []
  class FakeEventSource {
    constructor() {
      this.listeners = {}
      this.closed = false
      instances.push(this)
    }
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    }
    close() {
      this.closed = true
    }
    emit(type) {
      for (const handler of this.listeners[type] || []) handler({})
    }
  }
  const statuses = []
  const client = loadClientPlugin({
    EventSource: FakeEventSource,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms }
      scheduled.push(timer)
      return timer
    },
    clearTimeout: (timer) => cleared.push(timer),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: { rev: 1 } }) }),
  })
  const dispose = client.__test.subscribeState({ onStatus: (mode) => statuses.push(mode) })
  // Drive 40 failures. Only the first 8 may create a new EventSource; the chain then stays in
  // polling, and a manual reconnect starts a fresh chain.
  for (let round = 0; round < 40; round += 1) {
    const source = instances.at(-1)
    source.emit('error')
    const next = scheduled.at(-1)
    if (next && next.fn) {
      next.fn()
      scheduled.pop()
    }
  }
  assert.equal(scheduled.length, 0, 'no retry timer is left after the cap')
  assert.equal(instances.length, 9, 'the initial source + 8 automatic reconnects')
  assert.equal(statuses.at(-1), 'polling', 'the cap leaves the panel in the polling fallback')
  assert.equal(statuses.filter((mode) => mode === 'reconnecting').length, 8)
  dispose.reconnect()
  assert.equal(instances.length, 10, 'a manual reconnect resets the counter and tries again')
  assert.equal(statuses.at(-1), 'reconnecting')
  dispose()
})

test('the retry delay grows exponentially and is capped', () => {
  const { streamRetryDelay } = plugin.__test
  assert.equal(streamRetryDelay(0), 500)
  assert.equal(streamRetryDelay(1), 1000)
  assert.equal(streamRetryDelay(2), 2000)
  assert.equal(streamRetryDelay(10), 15000)
  assert.equal(streamRetryDelay(99), 15000)
})

test('the host editor reads the plain HostView fields instead of parsing the masked address', () => {
  const { initialDraft, parseMaskedAddress } = plugin.__test
  // A bare IPv6 used to yield port 1 out of `:1`.
  assert.deepEqual({ ...parseMaskedAddress('user@fe80::1') }, { username: 'user', port: null })
  assert.deepEqual({ ...parseMaskedAddress('user@[fe80::1]:2222') }, { username: 'user', port: 2222 })
  assert.deepEqual({ ...parseMaskedAddress('user@host:22') }, { username: 'user', port: 22 })

  const settings = { defaultPort: 2222 }
  const modern = initialDraft(
    'edit',
    hostView({ address: 'host-a', addressMasked: 'ubuntu@host-a', username: 'ubuntu', port: 2222 }),
    settings,
  )
  assert.equal(modern.port, 2222, 'the remembered default port must not silently become 22')
  assert.equal(modern.username, 'ubuntu')

  const legacyV6 = initialDraft('edit', hostView({ address: 'fe80::1', addressMasked: 'user@fe80::1' }), settings)
  assert.equal(legacyV6.port, 2222, 'an old Host without `port` must not turn IPv6 into port 1')
  assert.equal(legacyV6.username, 'user')
})

test('client validation uses the same ranges the Host clamps with', async () => {
  const { limits } = plugin.__test
  const { sanitizeHostEntry, sanitizeSettings } = await import('../../src/settings.js')
  assert.equal(sanitizeSettings({ connectTimeoutSec: 1 }).connectTimeoutSec, limits.connectTimeoutSec.min)
  assert.equal(sanitizeSettings({ connectTimeoutSec: 9999 }).connectTimeoutSec, limits.connectTimeoutSec.max)
  assert.equal(sanitizeSettings({ defaultPort: 0 }).defaultPort, limits.defaultPort.min)
  assert.equal(sanitizeHostEntry({ address: 'h', idleMinutes: 0 }).idleMinutes, limits.idleMinutes.min)
  assert.equal(sanitizeHostEntry({ address: 'h', idleMinutes: 99999 }).idleMinutes, limits.idleMinutes.max)
  const auto = sanitizeSettings({ autoReconnect: { maxAttempts: 99, baseDelayMs: 1 } }).autoReconnect
  assert.equal(auto.maxAttempts, limits.maxAttempts.max)
  assert.equal(auto.baseDelayMs, limits.baseDelayMs.min)
})

test('host and settings validation return the field, not just a message', () => {
  const { validateHostDraft, validateSettingsDraft, initialDraft, settingsDraft } = plugin.__test
  const draft = {
    ...initialDraft('add', null, { defaultPort: 22, defaultKeyPath: '~/.ssh/id_rsa' }),
    name: 'host-a',
    address: 'host-a',
  }
  assert.deepEqual({ ...validateHostDraft({ ...draft, name: '' }) }, { field: 'name', code: 'wizard.validationName' })
  assert.deepEqual(
    { ...validateHostDraft({ ...draft, port: 70000 }) },
    { field: 'port', code: 'wizard.validationPort' },
  )
  const idle = { ...draft, keepAlive: 'idle', idleMinutes: 0 }
  assert.deepEqual({ ...validateHostDraft(idle) }, { field: 'idleMinutes', code: 'wizard.validationIdleMinutes' })

  const settings = settingsDraft({})
  assert.deepEqual(
    { ...validateSettingsDraft({ ...settings, defaultPort: 0 }) },
    {
      field: 'defaultPort',
      code: 'settings.validationPort',
    },
  )
  assert.deepEqual(
    { ...validateSettingsDraft({ ...settings, profile: 'desktop' }) },
    {
      field: 'profile',
      code: 'settings.validationProfile',
    },
  )
  assert.deepEqual(
    { ...validateSettingsDraft({ ...settings, connectTimeoutSec: 1 }) },
    {
      field: 'connectTimeoutSec',
      code: 'settings.validationTimeout',
    },
  )
  assert.equal(validateSettingsDraft(settings), null)
})

test('a 401 and a 403 from DSH admission are their own non-retryable views', async () => {
  for (const [status, code] of [
    [401, 'session-expired'],
    [403, 'forbidden'],
  ]) {
    const client = loadClientPlugin({
      fetch: async () => ({ ok: false, status, json: async () => null }),
    })
    await assert.rejects(client.api.getState(), (error) => {
      assert.equal(error.view.code, code)
      assert.equal(error.view.retryable, false)
      assert.doesNotMatch(error.message, /插件内部错误|internal/i)
      return true
    })
  }
})

test('the download card is not a status role around its buttons and the bar is labelled', () => {
  const html = render(
    React.createElement(plugin.components.DownloadProgress, {
      t,
      job: { id: 'dl_1', phase: 'preparing', name: 'project', totalBytes: 0, doneBytes: 0, error: null },
      onCancel: () => {},
    }),
  )
  const card = /<div[^>]*data-testid="dsh-remote-go-download"[^>]*>/.exec(html)
  assert.ok(card)
  assert.doesNotMatch(card[0], /role="status"/, 'the card contains buttons and cannot be the live region')
  assert.match(html, /role="progressbar"[^>]*aria-label="下载进度：project"/)
  assert.match(html, /aria-valuetext="正在下载"/)
  assert.match(html, /role="status"[^>]*aria-live="polite"/)
})

test('toasts are a live region with queued tones', () => {
  const html = render(
    React.createElement(plugin.components.Toast, {
      toasts: [
        { id: 1, text: 'warned', tone: 'warn' },
        { id: 2, text: 'failed', tone: 'error' },
      ],
    }),
  )
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /data-testid="toast-region"/)
  assert.match(html, /data-tone="warn"[^>]*>warned/)
  assert.match(html, /data-tone="error"[^>]*>failed/)
  assert.equal((html.match(/data-tone=/g) || []).length, 2)
})

test('host warning, version parity and the connecting-host filter render', () => {
  const noop = () => {}
  const listOf = (hosts) =>
    render(
      React.createElement(plugin.components.HostListView, {
        t,
        state: stateWith({ hosts }),
        loading: false,
        error: null,
        onAdd: noop,
        onRefresh: noop,
        onOpenHost: noop,
        onEditHost: noop,
        onDeleteHost: noop,
        onDiagnoseHost: noop,
      }),
    )
  const warned = listOf([
    hostView({
      warning: { zh: '远端已有手工实例', en: 'A manual instance is running' },
      versionParity: {
        status: 'different',
        local: '0.2.2-rc.3',
        remote: '0.2.1',
        same: false,
        message: { zh: '', en: '' },
      },
    }),
  ])
  assert.match(warned, /data-testid="host-warning"/)
  assert.match(warned, /远端已有手工实例/)
  assert.match(warned, /data-testid="host-version-parity"/)
  assert.match(warned, /0\.2\.1/)
  assert.match(warned, /0\.2\.2-rc\.3/)

  const connecting = listOf([hostView({ status: 'connecting', progress: { code: 'ssh-connecting' } })])
  assert.doesNotMatch(connecting, /data-testid="host-card"/)
  assert.match(connecting, /data-testid="connecting-hosts-note"/)

  // A restart/stop action keeps its card and progress, but editing it while the link action runs
  // is disabled.
  const restarting = listOf([hostView({ status: 'connecting', progress: { code: 'restarting-remote' } })])
  assert.match(restarting, /data-testid="host-card"/)
  const editButton = /<button[^>]*data-testid="host-edit"[^>]*>/.exec(restarting)
  assert.ok(editButton)
  assert.match(editButton[0], /disabled=""/)
})

test('a guest intent can act on its own host only', () => {
  const { sanitizeGuestIntent } = plugin.__test
  assert.deepEqual(
    { ...sanitizeGuestIntent({ action: 'download-file', path: '/a/b', name: 'b', kind: 'file' }, 'h_a') },
    {
      action: 'download-file',
      hostId: 'h_a',
      kind: 'file',
      path: '/a/b',
      name: 'b',
    },
  )
  // A crafted hostId never wins over the carrier's host.
  assert.equal(sanitizeGuestIntent({ action: 'download-file', hostId: 'h_victim', path: '/a' }, 'h_a').hostId, 'h_a')
  // A guest may only disconnect its own host; a forged id is refused, not rewritten into
  // "disconnect yourself" (review blocker 1).
  assert.equal(sanitizeGuestIntent({ action: 'disconnect', hostId: 'h_victim' }, 'h_a'), null)
  assert.deepEqual(
    { ...sanitizeGuestIntent({ action: 'disconnect', hostId: 'h_a' }, 'h_a') },
    {
      action: 'disconnect',
      hostId: 'h_a',
    },
  )
  assert.equal(sanitizeGuestIntent({ target: 'h_victim' }, 'h_a'), null)
  assert.equal(sanitizeGuestIntent({ target: 'h_a' }, 'h_a').target, 'h_a')
  assert.equal(sanitizeGuestIntent({ target: 'local' }, 'h_a').target, 'local')
  assert.equal(sanitizeGuestIntent({ action: 'connect', hostId: 'h_a' }, 'h_a'), null)
  assert.equal(sanitizeGuestIntent({ action: 'download-file', path: 'relative' }, 'h_a'), null)
})

test('a carrier load guard does not fire for a 15s slow document before the 25s budget', () => {
  let now = 0
  const timers = []
  const client = loadClientPlugin({
    setTimeout: (fn, ms) => {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      timer.cancelled = true
    },
  })
  const fired = []
  const timeout = client.__test.loadTimeoutMs
  assert.ok(timeout >= 20_000, `the carrier load budget must tolerate a slow tunnel, got ${timeout}ms`)
  const guard = client.__test.createLoadGuard(timeout, () => fired.push(now))
  const advance = (ms) => {
    now += ms
    for (const timer of [...timers]) {
      if (timer.cancelled || timer.at > now) continue
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
  }
  guard.arm()
  advance(15000)
  assert.deepEqual(fired, [], 'a document still arriving at 15s must not be reported as failed')
  advance(timeout - 15000 - 1)
  assert.deepEqual(fired, [])
  advance(1)
  assert.deepEqual(fired, [timeout], 'only the full budget fires the failure layer')
  // A cancelled timer (the document committed) never fires, and dispose makes arm() inert.
  guard.arm()
  guard.cancel()
  advance(timeout + 5000)
  assert.deepEqual(fired, [timeout])
  guard.dispose()
  guard.arm()
  advance(timeout + 5000)
  assert.deepEqual(fired, [timeout])
})

test('the caption menubar inset accepts unitless computed values', () => {
  const { captionMenuStart } = plugin.__test
  assert.equal(captionMenuStart(true, '84px'), '84px')
  assert.equal(captionMenuStart(true, '84'), '84px')
  assert.equal(captionMenuStart(true, 'not-a-length'), '84px')
  assert.equal(captionMenuStart(false, ''), '48px')
})

test('a carrier failure layer is an alert with a way back to the local page', () => {
  const doc = fakeDocument()
  const client = loadClientPlugin({ document: doc })
  const layer = client.__test.createCarrierErrorLayer('failed to load', { localLabel: '返回本地' })
  assert.equal(layer.attributes.role, 'alert')
  assert.equal(layer.attributes['data-testid'], 'remote-overlay-error')
  const button = layer.children.find((node) => node.tagName === 'BUTTON')
  const text = layer.children.find((node) => node.className === 'drg-carrier-error-text')
  assert.equal(button.attributes['data-testid'], 'remote-overlay-back-local')
  assert.equal(button.textContent, '返回本地')
  assert.equal(text.textContent, 'failed to load')
  assert.doesNotThrow(() => button.click())
})

/* ── Connect-log channel (docs/api.md v2.12) ──────────────────────────────────────────────────
 *
 * The log channel is a second EventSource; these cases pin the three merge rules (R1 preserve,
 * R2 seed, R3 apply), the dedupe/reset behaviour that makes a reconnect invisible, and the
 * stream's own backoff/off-switch. They are pure seams: the UI above them is unchanged.
 */

function logState(hosts, overrides = {}) {
  return { rev: 1, instance: 'gen-1', hosts, ...overrides }
}

function logHost(overrides = {}) {
  return hostView({ status: 'connecting', phase: 'ssh', logs: [], ...overrides })
}

function logLine(seq, message = `row ${seq}`) {
  return { seq, at: '2026-11-17T14:03:11.412Z', level: 'info', phase: 'ssh', message }
}

test('a state frame never wipes the rows the log channel merged (R1)', () => {
  const { mergeStatePreservingLogs } = plugin.__test
  const cursors = new Map()
  const previous = logState([logHost({ id: 'h_a', logs: [logLine(1), logLine(2)] })])
  // A v2.12 state frame: same host, `logs` empty.
  const next = logState([logHost({ id: 'h_a', logSeq: 2 })], { rev: 2 })
  const merged = mergeStatePreservingLogs(previous, next, cursors)
  assert.deepEqual(
    merged.hosts[0].logs.map((entry) => entry.seq),
    [1, 2],
    'the rows stay on screen',
  )
  assert.equal(merged.rev, 2, 'and the state itself is the new one')
  // The host leaves the log-visible set: the rows go with the connect window.
  const closed = mergeStatePreservingLogs(
    previous,
    logState([logHost({ id: 'h_a', status: 'connected' })], { rev: 3 }),
    cursors,
  )
  assert.equal(closed.hosts[0].logs.length, 0, 'the rows go with the connect window')
  // An older Host still inlines rows in its frames: its tail is authoritative.
  const legacy = mergeStatePreservingLogs(
    previous,
    logState([logHost({ id: 'h_a', logs: [logLine(5), logLine(6)] })], { rev: 4 }),
    cursors,
  )
  assert.deepEqual(
    legacy.hosts[0].logs.map((entry) => entry.seq),
    [5, 6],
  )
  assert.deepEqual({ ...cursors.get('h_a') }, { instance: 'gen-1', attempt: 0, seq: 6 }, 'the cursor re-anchors')
})

test('a snapshot seeds the tail without duplicates and never rewinds a cursor (R2)', () => {
  const { seedLogsFromSnapshot } = plugin.__test
  const cursors = new Map()
  const live = logState([logHost({ id: 'h_a', logs: [logLine(1), logLine(2), logLine(3)] })])
  // The snapshot is older than the log channel: it brings rows 1 and 2 again.
  const snapshot = logState([logHost({ id: 'h_a', logs: [logLine(1), logLine(2)], logAttempt: 0, logSeq: 2 })], {
    rev: 0,
  })
  const seeded = seedLogsFromSnapshot(live, snapshot, cursors)
  assert.deepEqual(
    seeded.hosts[0].logs.map((entry) => entry.seq),
    [1, 2, 3],
    'old rows are merged by seq, not appended twice',
  )
  assert.equal(cursors.get('h_a').seq, 3, 'the cursor never moves back')
  // A snapshot from an older attempt of the same generation is ignored entirely.
  const rewound = seedLogsFromSnapshot(seeded, snapshot, new Map([['h_a', { instance: 'gen-1', attempt: 1, seq: 4 }]]))
  assert.equal(rewound, seeded, 'nothing changed, so nothing repaints')
})

test('a log frame applies by cursor: reset rebuilds, older frames are dropped, replays do not repaint (R3)', () => {
  const { applyLogFrame } = plugin.__test
  const cursors = new Map()
  const empty = logState([logHost({ id: 'h_a' })])
  const frame = (overrides = {}) => ({
    hostId: 'h_a',
    instance: 'gen-1',
    attempt: 1,
    seq: 2,
    reset: true,
    visible: true,
    entries: [logLine(1), logLine(2)],
    ...overrides,
  })
  const first = applyLogFrame(empty, frame(), cursors)
  assert.equal(first.applied, true)
  assert.deepEqual(
    first.state.hosts[0].logs.map((entry) => entry.seq),
    [1, 2],
  )
  assert.deepEqual({ ...cursors.get('h_a') }, { instance: 'gen-1', attempt: 1, seq: 2 })
  // The same reset again (a reconnect, or the frame after `GET /state` already seeded it): no repaint.
  const replay = applyLogFrame(first.state, frame(), cursors)
  assert.equal(replay.applied, false, 'a replay changes nothing on screen')
  // An increment only adds rows past the cursor.
  const increment = applyLogFrame(
    first.state,
    frame({ reset: undefined, seq: 4, entries: [logLine(2), logLine(3), logLine(4)] }),
    cursors,
  )
  assert.deepEqual(
    increment.state.hosts[0].logs.map((entry) => entry.seq),
    [1, 2, 3, 4],
    'row 2 is not rendered twice',
  )
  assert.equal(cursors.get('h_a').seq, 4)
  // An older attempt (a late frame from the previous connection) is dropped whole.
  const stale = applyLogFrame(first.state, frame({ reset: undefined, attempt: 0, seq: 9 }), cursors)
  assert.equal(stale.applied, false)
  // A newer attempt without a reset flag still rebuilds: its seq restarts at 1.
  const nextAttempt = applyLogFrame(
    increment.state,
    frame({ reset: undefined, attempt: 2, seq: 1, entries: [logLine(1)] }),
    cursors,
  )
  assert.deepEqual(
    nextAttempt.state.hosts[0].logs.map((entry) => entry.seq),
    [1],
    'the old attempt rows are gone',
  )
  assert.equal(nextAttempt.state.hosts[0].logs[0].seq, 1)
  // A frame from another publish generation clears the panel instead of mixing generations.
  const foreign = applyLogFrame(increment.state, frame({ instance: 'gen-old' }), cursors)
  assert.equal(foreign.applied, true)
  assert.equal(foreign.state.hosts[0].logs.length, 0, 'the rows of another generation are dropped')
  assert.equal(cursors.has('h_a'), false)
  // A frame for a host this page does not render is ignored, not buffered.
  assert.equal(applyLogFrame(first.state, frame({ hostId: 'h_missing' }), cursors).applied, false)
})

test('the log channel opens only for a connect window and backs off without a banner', () => {
  const scheduled = []
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.closed = false
      this.readyState = 0
      instances.push(this)
    }
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    }
    close() {
      this.closed = true
    }
    emit(type, payload) {
      for (const handler of this.listeners[type] || []) handler(payload)
    }
  }
  const client = loadClientPlugin({
    EventSource: FakeEventSource,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms }
      scheduled.push(timer)
      return timer
    },
    clearTimeout: () => {},
  })
  const frames = []
  const modes = []
  const stream = client.__test.subscribeConnectLog({
    onFrame: (frame) => frames.push(frame),
    onEnd: () => {},
    onMode: (mode) => modes.push(mode),
  })
  assert.deepEqual(instances, [], 'nothing opens until a connect window exists')
  stream.setEnabled(true)
  assert.equal(instances.length, 1)
  assert.equal(instances[0].url, '/dsh-remote-go/api/events/logs')
  assert.deepEqual(modes, [], 'an open EventSource is not live before a frame or ping')
  instances[0].emit('log', { data: JSON.stringify({ hostId: 'h_a', attempt: 1, seq: 1, entries: [] }) })
  assert.equal(modes.at(-1), 'live')
  assert.equal(frames.length, 1)
  // A transient drop retries with the same backoff the state channel uses.
  instances[0].readyState = 0
  instances[0].emit('error', {})
  assert.equal(instances[0].closed, true)
  assert.equal(modes.at(-1), 'reconnecting')
  scheduled.at(-1).fn()
  assert.equal(instances.length, 2, 'the retry opens a fresh EventSource')
  stream.dispose()
  // A permanent refusal (an older Host without `/events/logs`) switches the channel off: no
  // banner, no polling, no retry chain — the state channel already carries the tail.
  const unreachable = client.__test.subscribeConnectLog({ onMode: (mode) => modes.push(mode) })
  unreachable.setEnabled(true)
  const refused = instances.at(-1)
  refused.readyState = 2
  refused.emit('error', {})
  assert.equal(modes.at(-1), 'off')
  const before = scheduled.length
  unreachable.reconnect()
  unreachable.setEnabled(false)
  unreachable.setEnabled(true)
  assert.equal(scheduled.length, before, 'no retry chain is left behind')
  assert.equal(instances.at(-1), refused, 'and no stream is opened again')
  unreachable.dispose()
})

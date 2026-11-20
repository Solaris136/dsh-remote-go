import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fakeDocument, fakeDom, fakeFrameDocument } from '../helpers/fake-dom.ts'
import { fakeGuestWindow, fakeNode, fakeStorage, fire } from '../helpers/fake-dom.ts'

/** One click on an `href` inside the frame's document, as the browser reports it; `ownDownload` marks the
 * plugin's own file-menu entry, which is never a navigation. */
function clickLink(win, href, gesture = {}) {
  const own = gesture.ownDownload === true
  const anchor = {
    attributes: { href },
    getAttribute: (name) => (name === 'href' ? href : null),
    hasAttribute: (name) => name === 'href',
  }
  const click = {
    target: {
      closest(selector) {
        if (selector === '[data-drg-dir-download]') return own ? this : null
        return selector === 'a[href]' ? anchor : null
      },
    },
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
    ...gesture,
  }
  fire(win.document, 'click', click)
  return click
}
const requireFromHere = createRequire(import.meta.url)
const React = requireFromHere('react')
const { renderToStaticMarkup } = requireFromHere('react-dom/server')
const h = React.createElement
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The browser half is build output, so the suite loads `dist/client.js`; the package-root `client.js` is prepack-only.
const CLIENT_PATH = path.join(REPO_ROOT, 'dist', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const PANEL_ID = 'dsh-remote-go'
function loadClientPlugin(options = {}) {
  const sandbox = {
    console,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    // The scheduler prefers a display frame and falls back to a task; both are page globals a test picks between.
    requestAnimationFrame: options.requestAnimationFrame,
    cancelAnimationFrame: options.cancelAnimationFrame,
    fetch: options.fetch,
    document: options.document,
    getComputedStyle: options.getComputedStyle,
    // `URL` (origin checks) is a web global a bare vm context lacks; the sandbox models one unless a test injects it.
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
  // The absolute filename makes V8 attribute the script to the real file, so `client.js` shows up in coverage runs.
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
const plugin = loadClientPlugin()
const C = plugin.components

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
function render(element) {
  return renderToStaticMarkup(element)
}
/** Render one plugin component with its props. */
function renderOf(Component, props) {
  return render(h(Component, props))
}
/** Assert every pattern matches `markup`; an entry may carry its own message as `[pattern, message]`. */
function matchesAll(markup, patterns) {
  for (const entry of patterns) {
    const [pattern, message] = Array.isArray(entry) ? entry : [entry]
    assert.match(markup, pattern, message)
  }
}
/** The inverse of `matchesAll`: no pattern may match. */
function matchesNone(markup, patterns) {
  for (const entry of patterns) {
    const [pattern, message] = Array.isArray(entry) ? entry : [entry]
    assert.doesNotMatch(markup, pattern, message)
  }
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
const noop = () => {}
/** Every action a card can ask for, wired to the same no-op; a case overrides the one it asserts. */
function noopActions(names) {
  return Object.fromEntries(names.split(' ').map((name) => [name, noop]))
}
const LIST_ACTIONS =
  'onAdd onRefresh onOpenSettings onOpenHost onDisconnectHost onReconnectHost onRestartHost onStopRemote onViewProgress onEditHost onDeleteHost onDiagnoseHost'
function stateWith(overrides = {}) {
  return {
    hostVersion: '0.2.2-rc.1',
    targetVersion: '0.2.2-rc.1',
    hosts: [],
    settings: {},
    activeHostId: null,
    firstRun: false,
    ...overrides,
  }
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
/** A host whose remote DSH is restarting: the card and the connect window both render this progress. */
const restartingHost = (overrides = {}) =>
  hostView({ status: 'connecting', phase: 'start', progress: { code: 'restarting-remote' }, ...overrides })
/** A host whose SSH link is being built: the connect window prints its progress and its log. */
const connectingHost = (overrides = {}) =>
  hostView({ status: 'connecting', phase: 'ssh', progress: { code: 'ssh-connecting' }, ...overrides })
/** The Host's remote object for a link that is not up yet. */
function remoteOff(extra = {}) {
  return { ...hostView().remote, uiReady: false, ...extra }
}
const AUTH_ERROR = {
  code: 'auth',
  title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
  detail: { zh: '请检查用户名与密钥。', en: 'Check the user name and key.' },
  nextSteps: [],
  retryable: true,
}
/** The error a Host keeps after its remote DSH was closed outside this page. */
const UNREACHABLE_ERROR = {
  code: 'remote-unreachable',
  title: { zh: '远端 DSH 已不在运行', en: 'The remote DSH is no longer running' },
  detail: { zh: '没有可重挂实例。', en: 'No instance to re-attach.' },
  nextSteps: [],
  retryable: true,
}
/** One connect-log line; `extra` carries the boundary marker and the Host's own bilingual text. */
function connectLine(seq, level, phase, message, extra = {}) {
  return { seq, at: '2026-11-16T02:30:1' + (seq % 10) + '.000Z', level, phase, message, ...extra }
}
function runApply(target) {
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
  target.apply(ctx)
  return { ctx, calls, t, dicts, disposers }
}
const zhDict = runApply(plugin).dicts.zh
const t = translateFrom(zhDict)
const enT = translateFrom(runApply(plugin).dicts.en)
/** The download card's English copy, where two keys take parameters; the rest returns the key. */
const enDownloadT = (key, params) => {
  if (key === 'downloadPreparing') return 'Downloading ' + params.name
  if (key === 'downloadFiles') return params.done + ' / ' + params.total + ' files'
  return key
}
/** One download job as the Host reports it: the counts a progress card reads, overridable per case. */
function downloadJob(overrides = {}) {
  return { id: 'dl_1', phase: 'preparing', name: 'project', totalBytes: 0, doneBytes: 0, ...overrides }
}
/** The untranslated key itself, for cards whose copy is not under test. */
const keysT = (key) => key
/** One `HostListView` with every action wired: a case passes only the state it renders differently. */
function listView(props = {}) {
  return renderOf(C.HostListView, { t, loading: false, error: null, ...noopActions(LIST_ACTIONS), ...props })
}
function overlayView(props = {}) {
  return renderOf(C.PluginOverlay, { t, getLocaleId: () => 'zh', ...props })
}
/** One `HostListView` over a state that holds exactly these hosts. */
function listOfHosts(...hosts) {
  return listView({ state: stateWith({ hosts }) })
}
function wizardView(props = {}) {
  return renderOf(C.WizardDialog, { t, mode: 'add', initialHost: null, state: stateWith(), onClose: noop, ...props })
}
const MANAGE_ACTIONS =
  'onClose onAdd onRefresh onOpenSettings onOpenHost onConnectHost onDisconnectHost onReconnectHost onEditHost onDeleteHost onDiagnoseHost onAcceptFingerprint onRejectFingerprint onRetry onDiagnose'
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
    ...noopActions(MANAGE_ACTIONS),
    ...overrides,
  }
}
/** One rendered `Button` by its test id, so a label can be asserted exactly (not by substring). */
function buttonOf(markup, testId) {
  const found = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?</button>`).exec(markup)
  assert.ok(found, `the card must render a ${testId} button`)
  return found[0]
}
/** The opening tag of one `Button` by its test id, when a case asserts an attribute rather than the label. */
function buttonTagOf(markup, testId) {
  const found = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(markup)
  assert.ok(found, `the card must render a ${testId} button`)
  return found[0]
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
const CARRIER_URL = 'http://127.0.0.1:43210/?token=abc'
const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
/** The shell's browser bridge: it hands out a lease per seat and records the leases it gets back. */
function desktopBridge(leases, released) {
  return {
    protocolVersion: 1,
    browser: {
      acquire: async () => {
        const lease = 'lease-' + (leases.length + 1)
        leases.push(lease)
        return { lease, partition: 'persist:dsh-remote-go:' + lease }
      },
      release: async (lease) => released.push(lease),
    },
  }
}
/** A desktop-capable page: the shell bridge hands out leases and records those it got back. */
function takeoverPage(options = {}) {
  const doc = fakeDocument({ captionHeight: options.caption })
  const leases = []
  const released = []
  const local = loadClientPlugin({
    document: doc,
    URL: options.URL,
    open: options.open,
    getComputedStyle:
      options.caption === undefined
        ? undefined
        : () => ({ getPropertyValue: (name) => (name === '--dsh-windows-titlebar-height' ? options.caption : '') }),
    desktop: desktopBridge(leases, released),
  })
  return { doc, local, leases, released }
}
/** A `storage` event as another page raises it; the partition must stop the foreign ones and pass its own. */
function storageEvent(key) {
  return {
    key,
    stopped: false,
    stopImmediatePropagation() {
      this.stopped = true
    },
  }
}
function carrierRoot(doc, hostId = 'h_a') {
  return doc.body.children.find((node) => node.id === 'dsh-remote-go-overlay-' + hostId)
}
/** The same bridge, mounted on a local sidebar page: the row and the window share one page. */
function localTakeover() {
  const dom = fakeDom()
  const leases = []
  const released = []
  const local = loadClientPlugin({ document: dom.document, desktop: desktopBridge(leases, released) })
  return { dom, local, leases, released }
}
function carrierView(root) {
  return root.children.find((node) => node.className === 'drg-carrier-view')
}
/** Whether the carrier ran a guest script containing this marker. */
const ranScript = (calls, marker) => calls.some((code) => code.includes(marker))
/** How many times the carrier ran the script carrying this marker. */
const scriptRuns = (calls, marker) => calls.filter((code) => code.includes(marker)).length
/** Drive a fake `<webview>`: record every script the carrier runs and answer each one through `reply`. */
function guestScripts(view, reply = () => 'ok') {
  const calls = []
  view.loadURL = () => Promise.resolve()
  view.executeJavaScript = (code) => {
    calls.push(code)
    return Promise.resolve(reply(code))
  }
  return calls
}
function menuStartOf(doc) {
  return doc.documentElement.style.getPropertyValue('--dsh-windows-menu-start')
}
/** A local page with the switcher row installed; `faceOf` applies the plugin when a test needs its intents. */
function localPage(options = {}) {
  const dom = fakeDom(options)
  return { dom, local: loadClientPlugin({ document: dom.document }) }
}
/** The shell's row labels, injected into the page the row is drawn in. */
const ROW_LABELS = { local: '本地', addHost: '添加主机', manage: '管理界面' }
/** A local page whose switcher row already shows exactly these hosts. */
function rowPage(hosts = []) {
  const page = localPage()
  page.local.carrier.update({ hosts, labels: ROW_LABELS })
  return page
}
function faceOf(local) {
  const { calls } = runApply(local)
  const face = calls.registers.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  return { calls, face }
}
/** A dialog element with the pieces the dialog stack touches: attributes, focus and its own focusables. */
function fakeDialogNode(doc, options = {}) {
  const node = fakeNode(options.tagName || 'div')
  node.focusables = options.focusables || []
  node.ownerDocument = doc
  node.isConnected = true
  node.focused = false
  node.querySelectorAll = () => node.focusables
  node.contains = (candidate) => candidate === node || node.focusables.includes(candidate)
  node.focus = () => {
    node.focused = true
    doc.activeElement = node
  }
  return node
}
function fakeDialogDocument() {
  const doc = {
    activeElement: null,
    body: { style: { overflow: 'auto' }, contains: () => false },
    listeners: {},
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener(type) {
      delete this.listeners[type]
    },
  }
  doc.opener = fakeDialogNode(doc)
  doc.activeElement = doc.opener
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

/* ── Connect-log fixtures ──────────────────────────────────────────────────────────────────────
 * A second EventSource whose cases pin the three merge rules (R1 preserve, R2 seed, R3 apply), the dedupe/reset
 * behaviour that makes a reconnect invisible, and the stream's own backoff/off-switch; pure seams, the UI unchanged. */

/** The row numbers of the first host's log, in render order. */
const seqsOf = (state) => state.hosts[0].logs.map((entry) => entry.seq)
function logState(hosts, overrides = {}) {
  return { rev: 1, instance: 'gen-1', hosts, ...overrides }
}
function logHost(overrides = {}) {
  return hostView({ status: 'connecting', phase: 'ssh', logs: [], ...overrides })
}
function logLine(seq, message = `row ${seq}`) {
  return { seq, at: '2026-11-17T14:03:11.412Z', level: 'info', phase: 'ssh', message }
}

/* ── The panel stylesheets ────────────────────────────────────────────────────────────────────
 * The panel's own `CSS` and the switcher row's, which the row injects into the page that renders it. */

function clientCss() {
  const match = SOURCE.match(/const\s+CSS\s*=\s*`([\s\S]*?)`/)
  assert.ok(match, 'the client half must keep its stylesheet in a `const CSS = ` template literal')
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '')
}
function rowStyles() {
  const match = SOURCE.match(/style\.textContent = \[([\s\S]*?)\]\.join\(''\)/)
  assert.ok(match, 'the switcher row must keep its styles in the style.textContent array')
  const withoutComments = match[1].replace(/^\s*\/\/.*$/gm, '')
  const css = [...withoutComments.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((found) => found[1]).join('')
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
/** The index of the `}` matching the `{` at `open`, or -1. */
function closingBrace(css, open) {
  if (open < 0) return -1
  let depth = 0
  for (let at = open; at < css.length; at += 1) {
    if (css[at] === '{') depth += 1
    else if (css[at] === '}' && --depth === 0) return at
  }
  return -1
}
/** The bodies of every `@<header> { … }` block, brace-matched. */
function atRuleBodies(css, header) {
  const marker = '@' + header
  const bodies = []
  let from = 0
  for (;;) {
    const start = css.indexOf(marker, from)
    if (start < 0) return bodies
    const open = css.indexOf('{', start)
    const close = closingBrace(css, open)
    if (close < 0) return bodies
    bodies.push(css.slice(open + 1, close))
    from = close + 1
  }
}
/** Every at-rule block removed, so the remaining text is plain `selector { declarations }`. */
function stripAtRules(css) {
  let out = ''
  let index = 0
  for (;;) {
    const start = css.indexOf('@', index)
    if (start < 0) return out + css.slice(index)
    out += css.slice(index, start)
    const close = closingBrace(css, css.indexOf('{', start))
    if (close < 0) return out + css.slice(start)
    index = close + 1
  }
}
/** Every `selector { declarations }` pair of an at-rule-free stylesheet. */
function cssBlocks(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
    body: match[2],
  }))
}
// A scheduler that records the callbacks it was handed, so the test decides when a display frame runs.
function frameRecorder() {
  const frames = []
  const cancelled = []
  return {
    frames,
    cancelled,
    schedule: (callback) => {
      frames.push(callback)
      return frames.length
    },
    cancel: (handle) => cancelled.push(handle),
    /** Run the oldest frame that has not been cancelled. */
    runNext() {
      const callback = frames.shift()
      if (callback) callback()
      return Boolean(callback)
    },
  }
}

/* ── The sidebar row's placement ──────────────────────────────────────────────────────────────
 * `insertBefore` on a connected node takes it out of the tree first, and that removal costs it focus and state. The
 * fake column never had to do it (every other caller inserted a fresh node), so the recorder performs it. */

function detachFrom(dom, node) {
  const at = dom.column.children.indexOf(node)
  if (at < 0) return
  dom.column.children.splice(at, 1)
  node.parentNode = null
}
/** Record every `insertBefore` this column performs, leaving the page's API otherwise intact. */
function recordInsertBefore(dom) {
  const native = dom.column.insertBefore.bind(dom.column)
  const calls = []
  dom.column.insertBefore = (node, reference) => {
    calls.push({ node, reference })
    detachFrom(dom, node)
    return native(node, reference)
  }
  return calls
}
/** Give the column a `moveBefore` that lands the node like the real one and records the call. */
function recordMoveBefore(dom) {
  // Captured now, so a later `recordInsertBefore` observes the page's own path only.
  const native = dom.column.insertBefore.bind(dom.column)
  const calls = []
  dom.column.moveBefore = (node, reference) => {
    calls.push({ node, reference })
    detachFrom(dom, node)
    return native(node, reference)
  }
  return calls
}
// A live browser carrier with the capability bridge installed into a framed page. `execCommand` is the top document's
// clipboard fallback; `frameExecCommand` is the frame's own.
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
  const { face } = faceOf(local)
  const hostId = options.hostId === undefined ? 'h_a' : options.hostId
  await local.carrier.open({ hostId, url: `/dsh-remote-go/remote/${hostId}/?token=abc` })
  const root = carrierRoot(doc, hostId)
  const frame = root.children.find((node) => node.tagName === 'IFRAME')
  const frameNative = []
  const frameWindow = {
    document: fakeFrameDocument({ execCommand: options.frameExecCommand }),
    innerWidth: 1200,
    innerHeight: 800,
    URL,
    location: { origin: 'http://127.0.0.1:1', href: `/dsh-remote-go/remote/${hostId}/` },
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
/** The lazy factory, dictionaries and Host API: one row per original test, so a failure names its case. */
test('client.js registers one lazy factory through window.__ModuleLoader__', () => {
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(/)
  assert.match(SOURCE, /id:\s*'dsh-remote-go'/)
  const specifiers = [...SOURCE.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1].trim())
  for (const specifier of specifiers) assert.equal(specifier, "'react'", 'unexpected require: ' + specifier)
})

test('factory injects slots and locale', () => {
  const injects = Array.from(plugin.inject)
  assert.deepEqual(injects, ['slots', 'locale'])
  assert.equal(injects.includes('layout'), false)
})

test('the guest scripts carry the file-menu selectors and the folder item', () => {
  const tools = plugin.carrier.guestTools()
  matchesAll(tools, [
    /li\[data-files-entry\]\[data-files-path\]/,
    /data-drg-dir-download/,
    /下载到本地/,
    /dsw-icon-download-outline-regular/,
    /download-file/,
    /data-menu-backing/,
  ])
})

/** The Host API's success answer: HTTP 200 and this body. */
const okAnswer = (body) => ({ ok: true, status: 200, json: async () => body })
/** A `fetch` that records every call; `respond` decides the answer from the request. */
function recordingFetch(respond) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(init)
  }
  return { calls, fetch }
}

test('api.startDownload posts the host, path and destination and returns the job', async () => {
  const { calls, fetch } = recordingFetch(() =>
    okAnswer({ ok: true, job: { id: 'dl_1', phase: 'preparing', name: 'project', totalBytes: 0, doneBytes: 0 } }),
  )
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
  const { calls, fetch } = recordingFetch((init) =>
    init.method === 'DELETE' ? okAnswer({ ok: true }) : okAnswer({ ok: true, job: { id: 'dl_1', phase: 'ready' } }),
  )
  const withFetch = loadClientPlugin({ fetch })
  assert.equal((await withFetch.api.downloadStatus('dl_1')).phase, 'ready')
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
  const names = Object.keys(C)
  assert.ok(names.length >= 10, 'expected the panel component set, got ' + names.length)
  for (const name of names) assert.equal(typeof C[name], 'function', name + ' must be a component function')
  for (const name of [
    'PluginOverlay',
    'HostListView',
    'WizardDialog',
    'DiagnoseDrawer',
    'SettingsModal',
    'PasswordPrompt',
    'RemoteIcon',
  ]) {
    assert.equal(typeof C[name], 'function')
  }
  assert.equal(C.SettingsSection, undefined, 'the plugin must not ship a settings-page component')
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
  assert.deepEqual(Object.keys(dicts.en).sort(), zhKeys, 'en must define exactly the same keys as zh')
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
  for (const slot of ['main', 'settings.section', 'sidebar.panellist', 'sidebar.workspaces', 'sidebar.footer.action']) {
    assert.equal(calls.injects.includes(slot), false, 'the plugin must not register ' + slot)
  }
  const overlay = calls.registers.find((entry) => entry.options.name === 'shell.overlay')
  assert.ok(overlay, 'the overlay host must be registered')
  assert.equal(overlay.component, C.PluginOverlay)
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
  // The deliberate exception, and exactly one: a missing dictionary entry is reported once per key by `makeFallbackT`
  // (the alternative is a silently empty cell the user sees); quoting that call out keeps the ban exact elsewhere.
  const I18N_WARNING = "console.warn('[dsh-remote-go] ' + message)"
  assert.equal(SOURCE.split(I18N_WARNING).length - 1, 1, 'the i18n missing-key warning must stay the only console call')
  assert.doesNotMatch(SOURCE.replace(I18N_WARNING, '<i18n warning>'), /console\.(log|debug|info|warn|error)\s*\(/)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*token/i)
  assert.doesNotMatch(SOURCE, /localStorage\.setItem\([^)]*url/i)
  matchesAll(SOURCE, [
    /'x-dsh-remote-go':\s*'1'/,
    /credentials:\s*'same-origin'/,
    /const LOOPBACK_PREFIX = 'http:\/\/127\.0\.0\.1:'/,
    /url\.startsWith\(LOOPBACK_PREFIX\)/,
  ])
})

test('the client embeds the remote page only in the browser carrier and opens no window of its own', () => {
  // The desktop path still hands the remote page to the shell guest: no React iframe, no sandbox.
  assert.doesNotMatch(SOURCE, /h\(\s*'iframe'/, 'no iframe element may be rendered by React')
  assert.doesNotMatch(SOURCE, /IFRAME_SANDBOX/)
  assert.doesNotMatch(SOURCE, /window\.open\s*\(/, 'the global window.open must never be called')
  // The one new-window call site is the bridge's: a link the user clicked after `externalUrlOf` accepted it as http(s).
  assert.equal((SOURCE.match(/_blank/g) ?? []).length, 1, 'exactly one new-window call site')
  matchesAll(SOURCE, [
    /win\.open\(url, '_blank', 'noopener,noreferrer'\)/,
    /function externalUrlOf\(value\)/,
    /function openExternalUrl\(value\)/,
    /function createWebCarrier\(/,
    /function isValidViewPath\(value\)/,
    /frame\.src = url/,
    /function isValidLoopbackUrl\(url\)/,
  ])
  assert.doesNotMatch(SOURCE, /sandbox:?\s*['"]allow-scripts/, 'no iframe sandbox attribute may remain')
  assert.doesNotMatch(SOURCE, /RemoteViewport/, 'the embedded viewport component must be gone')
})

test('openHost validates both carrier URLs (API-layer guard)', async () => {
  let answer = { url: 'http://127.0.0.1:54321/?token=abc123', webUrl: '/dsh-remote-go/remote/h_test/?token=abc123' }
  const { calls, fetch } = recordingFetch(() =>
    okAnswer({ ok: true, localPort: 54321, address: '127.0.0.1:54321', ...answer }),
  )
  const client = loadClientPlugin({ fetch })
  assert.equal(typeof client.api?.openHost, 'function', 'client.js must expose the Host-API client for this test')
  const allowed = await client.api.openHost('h_test')
  assert.equal(allowed.url, 'http://127.0.0.1:54321/?token=abc123')
  assert.equal(allowed.webUrl, '/dsh-remote-go/remote/h_test/?token=abc123')
  assert.equal(calls.at(-1).url, '/dsh-remote-go/api/hosts/h_test/open')
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
  const { doc, local, leases } = takeoverPage()
  try {
    for (const refused of ['http://127.0.0.1:8080@evil.example/', 'http://127.0.0.1:@evil.example/']) {
      const opened = await local.carrier.open({ hostId: 'h_a', url: refused })
      assert.deepEqual({ ok: opened.ok, reason: opened.reason }, { ok: false, reason: 'bad-url' })
      assert.equal(leases.length, 0, `a refused URL must not reach the guest: ${refused}`)
      assert.equal(doc.body.children.length, 0, `no carrier may be mounted for ${refused}`)
    }
    const accepted = await local.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:8080/?token=abc' })
    assert.equal(accepted.ok, true, 'the legal loopback origin must still open')
    assert.equal(leases.length, 1)
  } finally {
    await local.carrier.close()
  }
})

/** Host cards and the link actions they offer: one row per original test, so a failure names its case. */
test('host list renders the empty state and a connected card', () => {
  const empty = listView({ state: stateWith({ firstRun: true }) })
  matchesAll(empty, [/远程主机/, /还没有远程主机/, /添加第一台服务器/, /drg-empty/])
  assert.doesNotMatch(empty, /drg-host-card/)
  matchesAll(listOfHosts(hostView()), [
    /测试机/,
    /ubuntu@10\.0\.0\.5:22/,
    /0\.2\.2-rc\.1/,
    /已连接/,
    /共 1/,
    /断开/,
    /诊断/,
  ])
})

test('a connected host card offers a remote restart and a restarting one shows its progress', () => {
  const connected = listOfHosts(hostView())
  const restart = buttonOf(connected, 'host-restart')
  assert.match(restart, />重启</, 'the restart action reads "重启"')
  assert.match(restart, /aria-label="重启远端 DSH"/, 'the short label keeps the full accessible name')
  assert.doesNotMatch(connected, /data-progress="restarting-remote"/)
  const restarting = listOfHosts(
    hostView({ status: 'connecting', phase: 'start', progress: { code: 'restarting-remote' }, remote: remoteOff() }),
  )
  matchesAll(restarting, [/data-progress="restarting-remote"/, /远端 DSH 正在重启，正在重新挂载界面…/])
  assert.match(buttonOf(restarting, 'host-restart'), />正在重启…</)
  // The card action is disabled while the restart runs.
  assert.match(buttonTagOf(restarting, 'host-restart'), /disabled=""/)

  // The retained remote-unreachable error state offers both ways back: restart and reconnect.
  const unreachable = listOfHosts(hostView({ status: 'error', error: UNREACHABLE_ERROR }))
  matchesAll(unreachable, [/data-testid="host-restart"/, /data-testid="host-reconnect"/])
})

test('a connecting host keeps its card and the way back to the connect window', () => {
  const host = hostView({ id: 'h_conn', status: 'connecting', phase: 'probing', progress: { code: 'probing' } })
  const markup = listOfHosts(host)
  // The card no longer disappears while the link is built: it carries the phase, the progress line and the way back.
  matchesAll(markup, [
    /data-testid="host-card"[^>]*data-host-id="h_conn"/,
    /data-status="connecting"/,
    /data-progress="probing"/,
  ])
  const button = buttonOf(markup, 'host-view-progress')
  assert.match(button, />查看进度</, 'a connecting card opens the connect window instead of offering "connect"')
  assert.doesNotMatch(button, /disabled=""/, 'the way back to the progress must stay clickable')
  // The card body is a click target too: the button is the keyboard/AT path, not the only one.
  assert.match(markup, /data-interactive="true"/)
  // The notice that used to explain the card's absence is gone with the absence itself.
  assert.doesNotMatch(markup, /connecting-hosts-note/)
})

test('a connected host card offers stopping the remote DSH and a stopping one shows its progress', () => {
  const connected = listOfHosts(hostView())
  const stop = buttonOf(connected, 'host-stop-remote')
  assert.match(stop, />关闭</, 'the stop action reads "关闭"')
  assert.match(stop, /aria-label="关闭远端 DSH"/, 'the short label keeps the full accessible name')
  assert.doesNotMatch(connected, /data-progress="stopping-remote"/)
  assert.doesNotMatch(buttonTagOf(connected, 'host-stop-remote'), /disabled=""/)

  // A stopped host has no remote process left: no stop action until it is reconnected.
  const disconnected = listOfHosts(hostView({ status: 'disconnected', remote: remoteOff({ localPort: null }) }))
  assert.doesNotMatch(disconnected, /data-testid="host-stop-remote"/)
  const stopping = listOfHosts(
    hostView({
      status: 'connecting',
      phase: 'start',
      progress: { code: 'stopping-remote', params: { pid: 1234 } },
      remote: remoteOff(),
    }),
  )
  matchesAll(stopping, [/data-progress="stopping-remote"/, /正在关闭远端 DSH…/])
  assert.match(buttonOf(stopping, 'host-stop-remote'), />正在关闭…</)
  assert.match(buttonTagOf(stopping, 'host-stop-remote'), /disabled=""/)
  // A restart in flight also disables the stop action (one link action at a time).
  const restarting = listOfHosts(
    hostView({ status: 'connecting', phase: 'start', progress: { code: 'restarting-remote' } }),
  )
  assert.match(buttonTagOf(restarting, 'host-stop-remote'), /disabled=""/)

  // The retained remote-unreachable error state can be closed as well as restarted/reconnected.
  const unreachable = listOfHosts(hostView({ status: 'error', error: UNREACHABLE_ERROR }))
  matchesAll(unreachable, [
    /data-testid="host-stop-remote"/,
    /data-testid="host-restart"/,
    /data-testid="host-reconnect"/,
  ])
})

test('the connect window titles a restart or a reconnect and prints its log', () => {
  const restarting = renderOf(C.ConnectWindow, {
    t,
    host: restartingHost({ logs: [connectLine(1, 'info', 'start', 'restart requested (pid=1234)')] }),
  })
  matchesAll(restarting, [
    /正在重启「测试机」的远端 DSH/,
    /远端 DSH 正在重启，正在重新挂载界面…/,
    /data-testid="connect-log"/,
    /restart requested \(pid=1234\)/,
  ])
  const reconnecting = renderOf(C.ConnectWindow, {
    t,
    host: connectingHost({ logs: [connectLine(2, 'info', 'ssh', 'reconnect requested')] }),
  })
  matchesAll(reconnecting, [/正在连接「测试机」/, /正在连接 SSH…/, /reconnect requested/])
})

test('the stop confirmation names the destructive action and its consequences in both languages', () => {
  const zh = renderOf(C.StopRemoteDialog, { t, onConfirm: noop, onCancel: noop })
  matchesAll(zh, [
    /data-testid="stop-remote-dialog"/,
    /关闭远端 DSH？/,
    /会停止远端进程/,
    /可随时重连/,
    /data-testid="stop-remote-confirm"/,
    /data-testid="stop-remote-cancel"/,
  ])
  assert.match(buttonOf(zh, 'stop-remote-confirm'), />关闭</, 'the confirmation action reads "关闭"')
  const zhConfirm = buttonTagOf(zh, 'stop-remote-confirm')
  assert.match(zhConfirm, /drg-btn-danger|danger/, 'stopping the remote process is a destructive action')
  assert.doesNotMatch(zhConfirm, /disabled=""/)
  const busy = renderOf(C.StopRemoteDialog, { t, busy: true, onConfirm: noop, onCancel: noop })
  assert.match(busy, /正在关闭…/)
  assert.match(buttonTagOf(busy, 'stop-remote-confirm'), /disabled=""/)
  assert.match(buttonTagOf(busy, 'stop-remote-cancel'), /disabled=""/)
  const en = renderOf(C.StopRemoteDialog, { t: enT, getLocaleId: () => 'en', onConfirm: noop, onCancel: noop })
  matchesAll(en, [/Stop the remote DSH\?/, /Stops the remote process/, /reconnect later/])
})

test('api.stopRemote posts the stop-remote route and returns the Host answer', async () => {
  const { calls, fetch } = recordingFetch(() => okAnswer({ ok: true, pid: 4242 }))
  const withFetch = loadClientPlugin({ fetch })
  assert.deepEqual(await withFetch.api.stopRemote('h_1'), { ok: true, pid: 4242 })
  assert.match(calls[0].url, /\/hosts\/h_1\/stop-remote$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {})
})

test('api.restart posts the restart route and returns the Host answer', async () => {
  const { calls, fetch } = recordingFetch(() => okAnswer({ ok: true, accepted: true }))
  const withFetch = loadClientPlugin({ fetch })
  assert.deepEqual(await withFetch.api.restart('h_1'), { ok: true, accepted: true })
  assert.match(calls[0].url, /\/hosts\/h_1\/restart$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {})
})

/** The management window, connect log and error card: one row per original test, so a failure names its case. */
test('a connecting host prints the connect log instead of the host list', () => {
  const host = hostView({
    status: 'connecting',
    phase: 'bootstrap',
    progress: { code: 'bootstrapping', params: {} },
    remote: remoteOff({ version: null }),
    logs: [
      connectLine(1, 'info', null, 'SSH connected to 10.0.0.5:22 as ubuntu (fingerprint SHA256:abc)'),
      connectLine(2, 'debug', null, 'remote: dsh web listening on 127.0.0.1:38123'),
      connectLine(3, 'warn', null, 'adopt check failed: no registry'),
    ],
  })
  const html = renderOf(C.ManageWindow, manageWindowProps({ host }))
  matchesAll(html, [
    /data-testid="manage-window"/,
    /data-testid="manage-live"/,
    /正在连接「测试机」/,
    /data-testid="connect-log"/,
    /连接日志/,
    /3 行/,
  ])
  const lines = [...html.matchAll(/data-level="(\w+)"[^>]*>(?:<!-- -->)?/g)].map((match) => match[1])
  assert.deepEqual(lines, ['info', 'debug', 'warn'])
  const infoAt = html.indexOf('SSH connected to 10.0.0.5:22')
  const debugAt = html.indexOf('remote: dsh web listening')
  const warnAt = html.indexOf('adopt check failed')
  assert.ok(infoAt > 0 && debugAt > infoAt && warnAt > debugAt, 'the log must keep the order it was written in')
  matchesNone(html, [
    /data-testid="host-list"/,
    /data-testid="host-add"/,
    /data-testid="host-refresh"/,
    /data-testid="host-settings"/,
    /管理远程主机/,
  ])
})

test('a failed connection keeps its log and offers retry instead of the list', () => {
  const host = hostView({
    status: 'error',
    error: AUTH_ERROR,
    logs: [connectLine(1, 'warn', null, 'connect failed: auth')],
  })
  const html = renderOf(C.ManageWindow, manageWindowProps({ host }))
  matchesAll(html, [
    /data-testid="error-card"/,
    /data-testid="error-retry"/,
    /connect failed: auth/,
    /data-testid="connect-log"/,
  ])
  assert.doesNotMatch(html, /data-testid="host-list"/)
})

test('the host-key question also prints the log that led to it', () => {
  const host = hostView({
    status: 'fingerprint-pending',
    fingerprint: fingerprintOf('SHA256:abc'),
    logs: [connectLine(1, 'info', null, 'SSH key SHA256:abc')],
  })
  const html = renderOf(C.ManageWindow, manageWindowProps({ host }))
  matchesAll(html, [/data-testid="fingerprint-card"/, /data-testid="connect-log"/, /SSH key SHA256:abc/])
  assert.doesNotMatch(html, /data-testid="host-list"/)
})

test('a host that is not connecting gets the management list back', () => {
  const host = hostView({ status: 'disconnected', logs: [] })
  const html = renderOf(C.ManageWindow, manageWindowProps({ host, state: stateWith({ hosts: [host] }) }))
  matchesAll(html, [/data-testid="host-list"/, /data-testid="host-add"/, /远程主机/])
  matchesNone(html, [/data-testid="connect-log"/, /data-testid="manage-live"/])
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
    logs: [connectLine(1, 'warn', null, 'connect failed: auth')],
  })
  const html = renderOf(C.ManageWindow, manageWindowProps({ host, state: stateWith({ hosts: [host] }), view: 'list' }))
  matchesAll(html, [/data-testid="host-list"/, /data-testid="host-card"/])
  matchesNone(html, [/data-testid="connect-log"/, /data-testid="error-card"/])
})

test('the closed window renders nothing', () => {
  assert.equal(renderOf(C.ManageWindow, manageWindowProps({ open: false, host: hostView() })), '')
})

test('the connect console prints raw lines, staged progress and says so when the Host has none yet', () => {
  const progress = hostView({
    status: 'connecting',
    phase: 'ssh',
    progress: { code: 'ssh-connecting' },
    remote: remoteOff({ version: null }),
  })
  matchesAll(renderOf(C.ConnectProgress, { t, host: progress }), [/正在连接「测试机」/, /正在连接 SSH…/, /SSH/, /隧道/])
  const empty = renderOf(C.ConnectLog, { t, host: hostView({ status: 'connecting', logs: [] }) })
  matchesAll(empty, [/data-testid="connect-log-empty"/, /等待日志输出/, /关闭窗口|关窗不中断连接/])
  const html = renderOf(C.ConnectLog, {
    t,
    host: hostView({
      status: 'connecting',
      logs: [
        connectLine(
          9,
          'debug',
          null,
          'remote: installing @deepseek-ai/dsh@0.2.2-rc.3 with a token=secret query string',
        ),
      ],
    }),
  })
  matchesAll(html, [
    /installing @deepseek-ai\/dsh@0\.2\.2-rc\.3 with a token=secret query string/,
    /data-level="debug"/,
    /1 行/,
    /role="log"/,
  ])
  assert.doesNotMatch(html, /dsh-remote-go:/)
})

test('the connect log shows the phase of every line and the Host’s bilingual failure block', () => {
  const logs = [
    connectLine(1, 'info', null, '— Connection 2 · 2026-11-16 10:30:12 —', {
      boundary: true,
      text: { zh: '— 第 2 次连接 · 2026-11-16 10:30:12 —', en: '— Connection 2 · 2026-11-16 10:30:12 —' },
    }),
    connectLine(2, 'info', 'ssh', 'SSH connected to 10.0.0.5'),
    connectLine(3, 'error', 'start', 'Connect failed in phase start: remote-dsh-start-failed', {
      text: {
        zh: '连接失败于 start 阶段：remote-dsh-start-failed',
        en: 'Connect failed in phase start: remote-dsh-start-failed',
      },
    }),
    connectLine(4, 'error', 'start', 'Reason: startup failed', {
      text: { zh: '原因：启动失败。', en: 'Reason: startup failed.' },
    }),
    connectLine(5, 'error', 'custom', 'unknown phase line'),
    connectLine(6, 'info', 'ready', 'connected: remote DSH on 127.0.0.1:45123'),
  ]
  const zhHtml = renderOf(C.ConnectLog, { t, host: hostView({ status: 'error', logs }) })
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
  const enHtml = renderOf(C.ConnectLog, { t: enT, getLocaleId: () => 'en', host: hostView({ status: 'error', logs }) })
  matchesAll(enHtml, [
    /— Connection 2 · 2026-11-16 10:30:12 —/,
    />Start</,
    />Ready</,
    /Connect failed in phase start: remote-dsh-start-failed/,
    /Reason: startup failed\./,
  ])
  assert.doesNotMatch(enHtml, /第 2 次连接/, 'the en UI resolves the same line in English')
})

test('the connect window resolves host-provided text in English', () => {
  const host = hostView({ status: 'error', error: AUTH_ERROR, logs: [] })
  matchesAll(renderOf(C.ManageWindow, manageWindowProps({ host, t: enT, getLocaleId: () => 'en' })), [
    /SSH authentication failed/,
    /Check the user name and key/,
  ])
})

/** the remaining contract surfaces: one row per original test, so a failure reports the case it came from. */
test('progress code map covers every contract code', () => {
  const { dicts } = runApply(plugin)
  const codes =
    'ssh-connecting host-key-confirm auth-checking probing downloading-node installing-node bootstrapping bootstrap-first-run bootstrap-fetching bootstrap-installed bootstrap-progress starting-remote tunneling verifying ready reconnecting restarting-remote remote-dsh-running'.split(
      ' ',
    )
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
  matchesAll(renderOf(C.ErrorCard, { t, error, onRetry: noop, onDiagnose: noop, onBack: noop }), [
    /SSH 认证没有通过/,
    /请检查用户名与密钥\/Agent/,
    /确认密钥已加载到 SSH Agent/,
    /重试/,
    /诊断/,
    /返回/,
  ])
})

test('error card resolves English text when the locale is en', () => {
  const error = {
    code: 'network',
    title: { zh: '连不上这台服务器', en: 'Cannot reach this server' },
    detail: { zh: '检查地址/端口/网络。', en: 'Check the address, port and network.' },
    nextSteps: [{ zh: '先测跳板机', en: 'Test the jump host first' }],
    retryable: true,
  }
  matchesAll(renderOf(C.ErrorCard, { t: enT, localeId: 'en', error, onRetry: noop }), [
    /Cannot reach this server/,
    /Check the address, port and network/,
    /Test the jump host first/,
  ])
})

test('the overlay host takes no page of its own until a window is asked for', () => {
  const host = hostView()
  const html = overlayView({ initialState: stateWith({ hosts: [host], activeHostId: host.id }) })
  assert.match(html, /data-testid="dsh-remote-go-overlay-host"/)
  matchesNone(html, [
    /data-testid="host-list"/,
    /data-testid="manage-window"/,
    /<div class="drg-modal-layer"/,
    /<iframe/,
  ])
})

test('the plugin never selects a main panel; the browser carrier frames the proxied view only', () => {
  assert.doesNotMatch(SOURCE, /selectPanel/, 'the plugin must not select a layout panel')
  assert.doesNotMatch(SOURCE, /'main'/, 'the plugin must not register the main slot')
  assert.doesNotMatch(SOURCE, /<iframe|h\(\s*'iframe'/, 'no React iframe may be rendered')
  assert.match(SOURCE, /acceptsCarrierUrl\(entry\.kind, url\)/, 'the frame URL must be re-checked on reload')
  assert.match(SOURCE, /const openHost = \(host(?:, options)?\) => \{[\s\S]*?setTarget\(host\.id\)/)
})

/** the desktop carrier: one row per original test, so a failure reports the case it came from. */
test('the warm pool keeps every opened host and the last request wins a race', async () => {
  const { doc, local, released } = takeoverPage()
  const url = (hostId) => 'http://127.0.0.1:43210/?token=' + hostId
  try {
    for (const hostId of ['h_a', 'h_b', 'h_c', 'h_d']) {
      const opened = await local.carrier.open({ hostId, url: url(hostId) })
      assert.equal(opened.ok, true, hostId + ' must open')
      assert.equal(opened.reused, false)
    }
    assert.equal(doc.body.children.length, 4, 'all four windows stay mounted')
    for (const hostId of ['h_a', 'h_b', 'h_c', 'h_d']) {
      assert.equal(local.carrier.warm(hostId), true, hostId + ' must stay warm')
    }
    assert.equal(local.carrier.shown(), 'h_d')
    const again = await local.carrier.open({ hostId: 'h_a' })
    assert.equal(again.reused, true)
    assert.equal(local.carrier.shown(), 'h_a')
    assert.deepEqual(released, [], 'nothing may be released while a host is still up')
    const [first, second] = await Promise.all([
      local.carrier.open({ hostId: 'h_e', url: url('h_e') }),
      local.carrier.open({ hostId: 'h_f', url: url('h_f') }),
    ])
    assert.deepEqual({ ok: first.ok, reason: first.reason }, { ok: false, reason: 'superseded' })
    assert.equal(second.ok, true)
    assert.equal(local.carrier.shown(), 'h_f')
    assert.equal(local.carrier.warm('h_e'), false, 'a superseded window must not linger')
    assert.equal(doc.body.children.length, 5, 'children: ' + doc.body.children.map((node) => node.id).join(','))
  } finally {
    await local.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.equal(released.length, 6, 'every lease is handed back, including the superseded one')
})

test('a restarted attach re-navigates the warm carrier even when the URL repeats', async () => {
  const { doc, local } = takeoverPage()
  const url = 'http://127.0.0.1:43210/?token=one'
  try {
    assert.equal((await local.carrier.open({ hostId: 'h_a', url, viewRev: 1 })).ok, true)
    const view = carrierView(carrierRoot(doc))
    const loads = []
    view.loadURL = async (next) => {
      loads.push(next)
    }
    // Same URL, newer attach: a remote restart hands out the same address shape but a new session, so navigate again.
    const second = await local.carrier.open({ hostId: 'h_a', url, viewRev: 2 })
    assert.equal(second.reused, true)
    assert.deepEqual(loads, [url])
    // Same attach again: showing the warm window must not reload it.
    await local.carrier.open({ hostId: 'h_a', url, viewRev: 2 })
    assert.deepEqual(loads, [url])
    // The warm-reload path is the third caller: a disguised loopback URL must never navigate it.
    await local.carrier.open({ hostId: 'h_a', url: 'http://127.0.0.1:8080@evil.example/', viewRev: 3 })
    assert.deepEqual(loads, [url], 'the warm guest must keep its own loopback document')
  } finally {
    await local.carrier.close()
  }
})

test('the takeover carrier hands the window to the guest and injects the switcher', async () => {
  const { doc, local, released } = takeoverPage()
  const hosts = [
    hostView({ id: 'h_a', name: '43.133.80.40', address: '43.133.80.40' }),
    hostView({ id: 'h_b', name: '生产机 ubuntu', address: 'ubuntu@10.0.0.7' }),
  ]
  try {
    const result = await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL, message: '远端界面加载失败' })
    assert.equal(result.ok, true)
    const root = carrierRoot(doc)
    assert.ok(root, 'the carrier must be mounted on document.body')
    assert.match(root.style.cssText, /left:0/)
    assert.equal(root.children.length, 3)
    assert.equal(
      root.children.some((node) => node.className === 'drg-carrier-bar'),
      false,
    )
    const view = carrierView(root)
    assert.ok(view, 'the guest must be mounted')
    assert.equal(view.tagName, 'WEBVIEW')
    const calls = guestScripts(view, (code) => (code.includes('function mountHostRow') ? 'installed' : null))
    fire(view, 'did-stop-loading')
    await settle()
    assert.ok(ranScript(calls, 'function mountHostRow'), 'the injected row script must run inside the guest')
    local.carrier.update({ hosts, current: 'h_a' })
    await settle()
    assert.ok(ranScript(calls, '43.133.80.40'), 'the carrier host must be pushed into the injected row')
    assert.equal(
      ranScript(calls, '生产机 ubuntu'),
      false,
      'a guest row must not render another host (review blocker 1)',
    )
    assert.ok(ranScript(calls, '"current":"h_a"'), 'the current target must be pushed too')
    assert.equal(ranScript(calls, 'drg-hr-title'), false)
    const runs = scriptRuns(calls, 'function mountHostRow')
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(scriptRuns(calls, 'function mountHostRow'), runs + 1)
  } finally {
    await local.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('a caption window hands the band to the guest and keeps the window draggable', async () => {
  const { doc, local, released } = takeoverPage({ caption: '40px' })
  try {
    assert.equal((await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })).ok, true)
    const root = carrierRoot(doc)
    assert.ok(root, 'the carrier must be mounted on document.body')
    assert.match(root.style.cssText, /top:0/)
    const grip = root.children.find((node) => node.className === 'drg-carrier-grip')
    assert.ok(grip, 'a guest that covers the band must give the window drag back')
    assert.match(grip.style.cssText, /app-region:drag/)
    assert.match(grip.style.cssText, /left:84px/)
    assert.match(grip.style.cssText, /height:40px/)
    const view = carrierView(root)
    const calls = guestScripts(view, (code) => (code.includes('function mountHostRow') ? 'installed' : 'ok'))
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
    local.carrier.hide()
    assert.equal(doc.documentElement.classList.contains('drg-caption-live'), false)
  } finally {
    await local.carrier.close()
  }
  assert.equal(doc.body.children.length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('a guest that refuses the caption script stays below the local band', async () => {
  const { doc, local } = takeoverPage({ caption: '40px' })
  try {
    await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })
    const root = carrierRoot(doc)
    const grip = root.children.find((node) => node.className === 'drg-carrier-grip')
    const view = carrierView(root)
    guestScripts(view, () => null)
    fire(view, 'dom-ready')
    await settle()
    assert.equal(root.style.top, '40px', 'the guest must not overlap the local band')
    assert.equal(grip.style.display, 'none', 'the drag strip is only for the covered band')
    assert.equal(doc.documentElement.classList.contains('drg-caption-live'), false)
  } finally {
    await local.carrier.close()
  }
})

test('the guest mirror reports the rail state and the authority inset on the bridge queue', () => {
  const local = loadClientPlugin({ document: fakeDocument() })
  // The guest hands over DSH's resolved value; these two are the fallback for a guest that cannot answer: 84px = the
  // collapsed rail's controls (12px toggle + 28, 48px new-session + 28, 8px air); 48px = the shell default.
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
  const guestWindow = {
    document: {
      documentElement: {},
      querySelector: (selector) =>
        selector === '[data-sidebar-collapsed]' && rail ? { getAttribute: () => 'true' } : null,
    },
    MutationObserver: FakeObserver,
    // The guest carries the desktop marker, so DSH's sidebar rule resolves the menubar inset there.
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--dsh-windows-menu-start' ? resolved : '') }),
  }
  const install = (win) => new Function('window', 'return ' + script)(win)
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
  assert.deepEqual(guestWindow.__drgBridgeQueue.at(-1), { action: 'caption-sidebar', collapsed: true, start: '84px' })
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
  assert.deepEqual(install(bare), { collapsed: true, start: '' })
  const throwing = {
    document: bare.document,
    MutationObserver: FakeObserver,
    getComputedStyle() {
      throw new Error('detached')
    },
  }
  assert.deepEqual(install(throwing), { collapsed: true, start: '' })
})

test('a collapsed guest rail moves the local caption menubar with it', async () => {
  const { doc, local, released } = takeoverPage({ caption: '40px' })
  const takeScript = local.carrier.intentsScript()
  try {
    assert.equal((await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })).ok, true)
    const view = carrierView(carrierRoot(doc))
    // The guest answers in the order the carrier asks: caption, rail state, row, then the queue.
    let drained = false
    guestScripts(view, (code) => {
      if (code.includes('mountSidebarMirror')) return { collapsed: true, start: '84px' }
      if (code.includes('mountHostRow')) return 'installed'
      if (code !== takeScript) return 'ok'
      const pending = drained ? [] : [{ action: 'caption-sidebar', collapsed: false, start: '' }]
      drained = true
      return pending
    })
    fire(view, 'dom-ready')
    await settle()
    assert.equal(menuStartOf(doc), '48px', 'until the rail reports, the shell default holds the band')
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(menuStartOf(doc), '84px', 'the collapsed rail leaves the band to the new-session control first')
    // The rail reports its later expansion through the same queue the row's clicks use.
    await settle(520)
    assert.equal(menuStartOf(doc), '48px', 'an expanded rail hands the 48px start back')
    local.carrier.hide()
    assert.equal(menuStartOf(doc), '', 'the local page takes the band and its own sidebar rule back')
  } finally {
    await local.carrier.close()
  }
  assert.deepEqual(released, ['lease-1'])
})

test('a rail report queued while the host drains is neither dropped nor dispatched', async () => {
  const { doc, local } = takeoverPage({ caption: '40px' })
  // The real plugin must be applied: a leaked caption intent would then act like a row click.
  runApply(local)
  const takeScript = local.carrier.intentsScript()
  // The report queued while the host takes the previous one carries its `target`, so falling through would switch.
  const late = { action: 'caption-sidebar', collapsed: true, start: '84px', target: 'local' }
  const guestQueue = [{ action: 'caption-sidebar', collapsed: false, start: '' }]
  let drained = 0
  let legacyClear = false
  try {
    assert.equal((await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })).ok, true)
    const view = carrierView(carrierRoot(doc))
    guestScripts(view, (code) => {
      if (code.includes('mountSidebarMirror')) return { collapsed: true, start: '84px' }
      if (code.includes('mountHostRow')) return 'installed'
      if (code === takeScript) {
        // One round trip takes and clears together; a report pushed right after it stays queued.
        const taken = guestQueue.splice(0, guestQueue.length)
        if (drained === 0) guestQueue.push(late)
        drained += 1
        return taken
      }
      if (code === 'window.__drgBridgeQueue || []') {
        // The two-call protocol this replaced: read, then a clear that wiped whatever the guest queued in between.
        const taken = guestQueue.slice()
        if (drained === 0) guestQueue.push(late)
        drained += 1
        return taken
      }
      if (code === 'window.__drgBridgeQueue = []') {
        guestQueue.length = 0
        legacyClear = true
      }
      return 'ok'
    })
    fire(view, 'dom-ready')
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(menuStartOf(doc), '84px', 'the mirror install is adopted at once')
    // First poll round: the queued report is applied, and the late one is queued during it.
    await settle(520)
    assert.equal(menuStartOf(doc), '48px')
    // Second round: the report queued during the first one must still arrive.
    await settle(700)
    assert.equal(menuStartOf(doc), '84px', 'the report queued during the drain must not be lost')
    assert.equal(legacyClear, false, 'the intents must be taken and cleared in one round trip')
    assert.equal(local.carrier.shown(), 'h_a', 'nor may it reach the switcher dispatch')
  } finally {
    await local.carrier.close()
  }
})

test('a navigation forgets the rail state of the document it replaced', async () => {
  const { doc, local } = takeoverPage({ caption: '40px' })
  try {
    await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })
    const view = carrierView(carrierRoot(doc))
    const railAnswer = (collapsed, start) => (code) => {
      if (code.includes('mountSidebarMirror')) return { collapsed, start }
      if (code.includes('mountHostRow')) return 'installed'
      return 'ok'
    }
    guestScripts(view, railAnswer(true, '84px'))
    fire(view, 'dom-ready')
    fire(view, 'did-stop-loading')
    await settle()
    assert.equal(menuStartOf(doc), '84px')
    // The remote page navigates again: its new document has not reported a rail, so fall back to the shell default.
    guestScripts(view, railAnswer(false, ''))
    fire(view, 'dom-ready')
    await settle()
    assert.equal(menuStartOf(doc), '48px', 'the replaced document’s rail must not be written onto this band')
  } finally {
    await local.carrier.close()
  }
})

test('the browser carrier leaves the caption menubar to the local page', async () => {
  const doc = fakeDocument()
  const local = loadClientPlugin({ document: doc })
  assert.equal((await local.carrier.open({ hostId: 'h_a', url: '/dsh-remote-go/remote/h_a/?token=abc' })).ok, true)
  assert.equal(local.carrier.shown(), 'h_a')
  assert.equal(menuStartOf(doc), '', 'the browser build has no caption band of its own: the local page keeps its rule')
  local.carrier.hide()
  assert.equal(menuStartOf(doc), '')
  await local.carrier.close()
})

test('a carrier is revealed only after its guest has painted', async () => {
  const { doc, local } = takeoverPage()
  try {
    assert.equal((await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })).ok, true)
    const root = carrierRoot(doc)
    assert.ok(root, 'the carrier must still mount on document.body')
    // The switch starts transparent: revealing a hidden `<webview>` as-is would paint the carrier's background first.
    assert.equal(root.style.display, '')
    assert.equal(root.style.opacity, '0')
    assert.equal(root.style.pointerEvents, 'none')
    const view = carrierView(root)
    const calls = guestScripts(view, (code) => (code.includes('requestAnimationFrame') ? 'ok' : 'installed'))
    fire(view, 'did-stop-loading')
    await settle(140)
    assert.ok(ranScript(calls, 'requestAnimationFrame'), 'the reveal must wait for a frame of the guest')
    assert.equal(root.style.opacity, '', 'a painted guest lets the carrier become opaque')
    assert.equal(root.style.pointerEvents, '')

    // Leaving before the guest paints must not leave it opaque for the next visit.
    local.carrier.hide()
    assert.equal(root.style.display, 'none')
    const again = await local.carrier.open({ hostId: 'h_a' })
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
    assert.equal(root.style.opacity, '0', 'a reopen starts transparent again')
    local.carrier.hide()
    await settle(140)
    assert.equal(root.style.display, 'none', 'a reveal that lost the window must not show it')
    assert.equal(root.style.opacity, '0', 'nor make it opaque')
  } finally {
    await local.carrier.close()
  }
})

/** the switcher row of the local sidebar: one row per original test, so a failure reports the case it came from. */
test('the switcher row is drawn into the local sidebar and lists local, hosts and the actions', () => {
  const { dom } = rowPage([
    hostView({ id: 'h_a', name: '43.133.80.40', address: '43.133.80.40', status: 'connected' }),
    hostView({ id: 'h_b', name: '生产机 ubuntu', address: 'ubuntu@10.0.0.7', status: 'disconnected' }),
  ])
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
  assert.deepEqual(items.map(itemDotState), ['local', 'connected', 'disconnected', null, null])
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
  assert.deepEqual(
    menu.children.map((child) => child.className),
    ['drg-hr-item', 'drg-hr-item', 'drg-hr-item', 'drg-hr-sep', 'drg-hr-item', 'drg-hr-item'],
  )
})

test('the switcher menu opens on the row, closes on a second click and on a pick', () => {
  const { dom, local } = rowPage([hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })])
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
  const { dom } = rowPage()
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
  const { local } = localPage()
  const script = local.carrier.script()
  assert.match(script, /^\(function mountHostRow\(win\)/)
  const guestDom = fakeDom()
  const guestWindow = { document: guestDom.document, innerHeight: 800 }
  const factory = new Function('window', 'return ' + script)
  assert.equal(factory(guestWindow), 'installed')
  guestWindow.__drgHostRow.update({
    hosts: [hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })],
    current: 'h_a',
    labels: ROW_LABELS,
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
  const { dom, local } = localPage()
  const { face } = faceOf(local)
  local.carrier.update({
    hosts: [
      hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' }),
      hostView({ id: 'h_b', name: '生产机', status: 'disconnected' }),
    ],
    labels: { ...ROW_LABELS, exit: '断开' },
  })
  const row = rowOf(dom)
  const items = rowItems(row)
  const exitA = items[1].children.find((child) => child.className === 'drg-hr-act')
  const exitB = items[2].children.find((child) => child.className === 'drg-hr-act')
  assert.ok(exitA, 'the connected host must carry the exit control')
  assert.equal(exitB, undefined, 'a host that is not up must not')
  assert.equal(exitA.textContent, '断开')
  clickInside(row, exitA)
  assert.deepEqual({ ...face.panelStore.take() }, { kind: 'disconnect', hostId: 'h_a' })
  assert.equal(rowName(row), '本地', 'leaving a host must not switch to it')
})

test('apply installs the local switcher row with the dictionary labels', () => {
  const { dom, local } = localPage()
  const { calls, face } = faceOf(local)
  const row = rowOf(dom)
  assert.ok(row, 'apply must place the switcher row')
  assert.equal(rowName(row), '本地')
  assert.deepEqual(rowItems(row).map(itemLabel), ['本地', '添加主机', '管理界面'])
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
  const { dom, local, released } = localTakeover()
  const { face } = faceOf(local)
  const roots = () =>
    dom.document.body.children.filter((node) => String(node.id).indexOf('dsh-remote-go-overlay-') === 0)
  assert.equal((await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })).ok, true)
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
  assert.equal(roots()[0].style.display, 'none')
  const again = await local.carrier.open({ hostId: 'h_a' })
  assert.equal(again.reused, true)
  assert.equal(roots().length, 1)
  assert.notEqual(roots()[0].style.display, 'none')
  await local.carrier.close()
  assert.equal(roots().length, 0)
  assert.deepEqual(released, ['lease-1'])
})

test('dropping the window that fills the screen hands the row back to the local page', async () => {
  const { dom, local, released } = localTakeover()
  runApply(local)
  const open = (hostId, url) => local.carrier.open({ hostId, url })
  await open('h_a', CARRIER_URL)
  await local.carrier.update({
    hosts: [
      hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' }),
      hostView({ id: 'h_b', name: '生产机', status: 'connected' }),
    ],
    current: 'h_a',
  })
  assert.equal(rowName(rowOf(dom)), '43.133.80.40')
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

/** The browser carrier and the capability bridge: one row per original test, so a failure names its case. */
test('the browser carrier frames the proxied view and injects the switcher there', async () => {
  const doc = fakeDocument()
  const local = loadClientPlugin({ document: doc })
  try {
    assert.equal(local.carrier.surface(), 'web', 'without a desktop bridge the page carrier is the seat')
    // The loopback origin belongs to the desktop guest; in a browser it is not a valid seat.
    const bad = await local.carrier.open({ hostId: 'h_a', url: CARRIER_URL })
    assert.deepEqual({ ok: bad.ok, reason: bad.reason }, { ok: false, reason: 'bad-url' })
    const view = '/dsh-remote-go/remote/h_a/?token=abc'
    const opened = await local.carrier.open({ hostId: 'h_a', url: view })
    assert.equal(opened.ok, true)
    assert.equal(opened.reused, false)
    const root = carrierRoot(doc)
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
    assert.equal((await local.carrier.open({ hostId: 'h_a' })).reused, true)
    assert.notEqual(root.style.display, 'none')
    await local.carrier.close()
    assert.equal(doc.body.children.filter((node) => String(node.id).indexOf('dsh-remote-go-overlay-') === 0).length, 0)
  } finally {
    await local.carrier.close()
  }
})

test('the capability bridge opens external links from the frame at the top level', async () => {
  const { frame, frameWindow, opened, face } = await framedCarrier()
  assert.equal(frameWindow.__drgCapabilityBridge, true, 'the bridge must be installed with the frame')
  // `allow` can only narrow, but it still has to name what the remote page may legitimately use.
  for (const token of ['clipboard-read', 'clipboard-write', 'microphone', 'fullscreen', 'popups']) {
    assert.match(frame.attributes.allow, new RegExp(`\\b${token}\\b`), `the frame must declare ${token}`)
  }
  const external = clickLink(frameWindow, 'https://example.com/report')
  assert.equal(external.prevented, true, 'the frame cannot navigate itself to an external page')
  assert.equal(external.stopped, true, 'the page’s own handler must not open a nested browser tab instead')
  assert.deepEqual(opened.at(-1), ['https://example.com/report', '_blank', 'noopener,noreferrer'])

  // Only a web URL leaves the frame: a script/data URL, a relative path and a same-origin link are the page's business.
  const javascriptUrl = clickLink(frameWindow, 'javascript:alert(1)')
  assert.equal(javascriptUrl.prevented, false)
  const relative = clickLink(frameWindow, '/sessions/current')
  assert.equal(relative.prevented, false)
  const sameOrigin = clickLink(frameWindow, 'http://127.0.0.1:1/dsh-remote-go/remote/h_a/settings')
  assert.equal(sameOrigin.prevented, false, 'the framed app keeps its own same-origin navigation')
  // The plugin's own file-menu entry is not a navigation.
  const ownItem = clickLink(frameWindow, 'https://example.com/x', { ownDownload: true })
  assert.equal(ownItem.prevented, false, 'the download entry the plugin injected must keep working')

  // A modified or non-primary click is the user asking for the browser's own behaviour (background tab, new window).
  const narrowed = opened.length
  for (const gesture of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const modified = clickLink(frameWindow, 'https://example.com/modified', gesture)
    assert.equal(modified.prevented, false, `a ${JSON.stringify(gesture)} click keeps the browser default`)
  }
  assert.equal(opened.length, narrowed, 'no modified or middle click may become a bridge intent')

  // `window.open` in the frame turns into the same intent and returns no window.
  assert.equal(frameWindow.open('https://example.com/tab'), null)
  assert.deepEqual(opened.at(-1), ['https://example.com/tab', '_blank', 'noopener,noreferrer'])
  // `about:blank` is the account login's popup skeleton: it has no URL to hand over.
  assert.equal(frameWindow.open('about:blank').native, true, 'a blank popup still goes to the browser')

  // A sink call is the trust boundary: an unsafe URL is refused and said out loud, not opened.
  const before = opened.length
  frameWindow.__drgBridgeSink({ action: 'open-external', url: 'javascript:alert(1)' })
  assert.equal(opened.length, before, 'no external window may be opened for a non-web URL')
  assert.deepEqual(
    { ...face.toolStore.take() },
    { kind: 'notice', tone: 'error', text: '无法打开这个链接：只支持 http 或 https 外链。' },
  )
})

test('the capability bridge performs the clipboard write at the top level and answers the frame', async () => {
  const success = await framedCarrier()
  assert.equal(await success.frameWindow.navigator.clipboard.writeText('code block text'), undefined)
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
    { kind: 'notice', tone: 'error', text: '复制失败：远端界面没能写入剪贴板。' },
  )
})

test('the notify intent reuses the shell toast channel', async () => {
  const { frameWindow, face } = await framedCarrier()
  frameWindow.__drgBridgeSink({ action: 'notify', tone: 'error', code: 'clipboard-failed' })
  assert.deepEqual(
    { ...face.toolStore.take() },
    { kind: 'notice', tone: 'error', text: '复制失败：远端界面没能写入剪贴板。' },
  )
  // A non-toast tone is shown as information, not a second error style; free text always names its origin.
  frameWindow.__drgBridgeSink({ action: 'notify', text: '远端页面自己的一句话' })
  assert.deepEqual(
    { ...face.toolStore.take() },
    { kind: 'notice', tone: 'info', text: '远端界面：远端页面自己的一句话' },
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
  const foreign = storageEvent('dsh.keybindings.v1')
  for (const handler of first.listeners.storage || []) handler(foreign)
  assert.equal(foreign.stopped, true)
  const own = storageEvent('drg:h_a:dsh.keybindings.v1')
  for (const handler of first.listeners.storage || []) handler(own)
  assert.equal(own.stopped, false, 'this host’s own updates must still reach the page')
})

test('the disconnect handover reads the live window target, not the mount-time one', () => {
  const captured = /if \(target === (?:host\.id|intent\.hostId)\) setTarget\(null\)/.test(SOURCE)
  assert.equal(captured, false, 'the disconnect must not decide from a captured target')
  const live = /setTarget\(\(current\) => \(current === host\.id \? null : current\)\)/.test(SOURCE)
  assert.equal(live, true, 'the disconnect must hand the window back with a functional update')
})

// Components whose published contract is their markup: one row per original case, named as the suite reports it.
const TOASTS = [
  { id: 1, text: 'warned', tone: 'warn' },
  { id: 2, text: 'failed', tone: 'error' },
]
/** A pending host key as the Host publishes it. */
const fingerprintOf = (sha256) => ({ sha256, keyType: 'ssh-ed25519', status: 'pending', pinned: null })
/** One diagnostics check: `[id, status, zh title, en title, zh detail, en detail]`, as the Host reports it. */
const diagCheck = ([id, status, zhTitle, enTitle, zhDetail, enDetail]) => ({
  id,
  status,
  title: { zh: zhTitle, en: enTitle },
  detail: { zh: zhDetail, en: enDetail },
})
const markupContracts = [
  [
    'fingerprint card shows SHA256 and accept / remember actions',
    () =>
      renderOf(C.FingerprintCard, {
        t,
        host: hostView({ status: 'fingerprint-pending', fingerprint: fingerprintOf('SHA256:abcdefghijklmnop') }),
        onAccept: noop,
        onReject: noop,
      }),
    [/主机指纹待确认/, /SHA256 指纹/, /SHA256:abcdefghijklmnop/, /接受并记住/, /仅本次接受/],
  ],
  [
    'the add-host dialog is one form with save and connect, and no test step',
    () =>
      wizardView({
        state: {
          hostVersion: '0.2.2-rc.1',
          hosts: [],
          settings: {
            defaultPort: 22,
            defaultAuth: 'key',
            hostKeyPolicy: 'first-use',
            autoReconnect: { enabled: true },
          },
          activeHostId: null,
          firstRun: true,
        },
      }),
    [
      /添加服务器/,
      /显示名/,
      /SSH 地址或别名/,
      /data-testid="wizard-save"/,
      /data-testid="wizard-connect"/,
      />保存</,
      />连接</,
      /密钥文件/,
      /远端存活策略/,
      /value="~\/\.ssh\/id_rsa"/,
      /data-testid="wizard-auto-reconnect"/,
      /data-testid="wizard-advanced"/,
      />高级选项</,
      /data-testid="wizard-keep-alive"/,
      /主机指纹策略/,
      /data-testid="wizard-key-path-pick"/,
      /list="drg-ssh-alias-list"/,
      /<datalist[^>]*id="drg-ssh-alias-list"/,
    ],
    [/保存并测试|保存和测试/, /wizard-step-|连接测试|稍后再说/, /data-testid="wizard-cancel"/, /SSH Agent/],
  ],
  [
    'diagnostics drawer renders the checklist with statuses',
    () =>
      renderOf(C.DiagnoseDrawer, {
        t,
        host: hostView(),
        status: 'done',
        report: {
          summary: 'warning',
          checks: [
            ['ssh-reachable', 'pass', 'SSH 可达性', 'SSH reachability', 'SSH 端口可连接', 'SSH port is reachable'],
            ['auth', 'fail', '认证方式', 'Authentication', '认证失败', 'Authentication failed'],
            ['tunnel', 'unknown', '隧道状态', 'Tunnel', '尚未检查', 'Not checked yet'],
          ].map(diagCheck),
          redacted: true,
          generatedAt: '2026-11-10T15:00:00.000Z',
        },
        onClose: noop,
        onRun: noop,
      }),
    [/连接诊断/, /SSH 可达性/, /认证方式/, /通过/, /失败/, /未知/, /重新检查/, /复制诊断信息/, /已脱敏/],
  ],
  [
    'settings modal renders contract fields and the save action',
    () =>
      renderOf(C.SettingsModal, {
        t,
        settings: {
          defaultPort: 22,
          defaultAuth: 'agent',
          connectTimeoutSec: 30,
          autoReconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 1000 },
          hostKeyPolicy: 'first-use',
          saveTokens: false,
          language: 'auto',
          logLevel: 'info',
          bootstrap: { profile: 'web' },
        },
        onClose: noop,
        onSave: async () => {},
      }),
    [/设置/, /主机指纹策略/, /允许保存访问令牌/, /风险提示|0600/, /远端运行时/, /DSH profile/, /保存设置/],
    [/呈现形态/, /面板内嵌/, /关闭视窗行为/, /镜像会话/, /显示在本地侧边栏/, /插件远端目录/],
  ],
  [
    'conflict prompt lists the foreign processes and offers three actions',
    () =>
      renderOf(C.RemoteConflictPrompt, {
        t,
        host: {
          id: 'h1',
          name: 'Tencent VM',
          conflict: { detectedAt: '2026-11-14T00:00:00Z', processes: [{ pid: 42, command: 'dsh web' }] },
        },
        onResolve: noop,
      }),
    [
      /远端已有手工启动的 DSH/,
      /pid 42/,
      /dsh web/,
      /停止它并启动受管实例/,
      /保留它，另起一个/,
      /取消连接/,
      /data-testid="remote-conflict-prompt"/,
    ],
  ],
  [
    'the download progress card renders a determinate bar, byte counts and file counts',
    () =>
      renderOf(C.DownloadProgress, {
        job: downloadJob({ totalBytes: 100, doneBytes: 40, totalFiles: 3, doneFiles: 1 }),
        t: enDownloadT,
        locale: 'en',
        onCancel: noop,
      }),
    [
      /data-testid="dsh-remote-go-download"/,
      /Downloading project/,
      /aria-valuenow="40"/,
      /width:40%/,
      /40 B \/ 100 B/,
      /1 \/ 3 files/,
      /drg-download-grip/,
      />downloadCancel</,
    ],
  ],
  [
    'the download progress card shows an error view and hides the cancel action',
    () =>
      renderOf(C.DownloadProgress, {
        job: downloadJob({
          id: 'dl_2',
          phase: 'error',
          name: 'broken',
          error: { title: { zh: '失败', en: 'Failed' }, detail: { zh: '没有权限', en: 'No permission' } },
        }),
        t: keysT,
        locale: 'en',
        onCancel: () => assert.fail('an error card must not offer cancel'),
      }),
    [/downloadFailed/, /No permission/],
    [/downloadCancel/],
  ],
  [
    'the overlay host carries the theme root and the stylesheet',
    () => overlayView(),
    [
      /class="drg-root drg-overlay"/,
      /data-testid="dsh-remote-go-overlay-host"/,
      /data-dsh-remote-go="styles"/,
      /--dsw-alias-label-primary/,
      /\[data-shell-overlay\] \{ z-index: 2147483001; \}/,
    ],
  ],
  [
    'host management list renders the empty state and its controls',
    () => listView({ state: stateWith({ firstRun: true }) }),
    [
      /data-testid="host-list-empty"/,
      /远程主机/,
      /data-testid="host-add"/,
      /data-testid="host-add-empty"/,
      /data-testid="host-refresh"/,
      /data-testid="host-settings"/,
      /还没有远程主机。添加一台，然后打开它的远端 DSH 界面。/,
    ],
  ],
  [
    'host management list offers open/connect actions per host',
    () =>
      listOfHosts(
        hostView({ id: 'h_connected', name: '已连接主机' }),
        hostView({ id: 'h_offline', name: '未连接主机', status: 'disconnected' }),
      ),
    [
      /data-testid="host-open"/,
      /data-host-id="h_connected"/,
      /data-host-id="h_offline"/,
      />打开</,
      />连接</,
      /data-testid="host-reconnect"/,
    ],
  ],
  [
    'toasts are a live region with queued tones',
    () => renderOf(C.Toast, { toasts: TOASTS }),
    [
      /role="status"/,
      /aria-live="polite"/,
      /data-testid="toast-region"/,
      /data-tone="warn"[^>]*>warned/,
      /data-tone="error"[^>]*>failed/,
    ],
  ],
  [
    'remote icon is original, currentColor SVG that respects size',
    () => renderOf(C.RemoteIcon, { size: 18, active: true }),
    [/<svg[^>]*width="18"[^>]*height="18"/, /stroke="currentColor"/],
    [/fill="#/],
  ],
]

test('the panel components render the markup their contract pins', () => {
  for (const [name, markup, patterns, absent = []] of markupContracts) {
    const html = markup()
    for (const pattern of patterns) assert.match(html, pattern, name)
    for (const pattern of absent) assert.doesNotMatch(html, pattern, name)
  }
  // The toast row above pins both tones; the count is pinned here, so a duplicated or dropped row still fails.
  const toast = renderOf(C.Toast, { toasts: TOASTS })
  assert.equal((toast.match(/data-tone=/g) ?? []).length, 2, 'one tone attribute per queued toast')
})

test('every automation data-testid required by acceptance is rendered', () => {
  const host = hostView({ authType: 'password' })
  const state = stateWith({ hosts: [host] })
  const empty = stateWith()
  const checks = [['ssh-reachable', 'pass', 'SSH 可达性', 'SSH reachability', '可连接', 'Reachable']].map(diagCheck)
  const error = {
    code: 'auth',
    title: { zh: '认证失败', en: 'Authentication failed' },
    detail: { zh: '检查密钥', en: 'Check the key' },
    nextSteps: [],
    retryable: true,
  }
  const fingerprint = fingerprintOf('SHA256:test')
  const report = { summary: 'ok', checks }
  const pendingHost = hostView({ status: 'fingerprint-pending', fingerprint })
  const markup = [
    overlayView(),
    listView({ state: empty }),
    listView({ state }),
    wizardView({ state: empty }),
    wizardView({ state: stateWith({ settings: { defaultAuth: 'password' } }) }),
    renderOf(
      C.ManageWindow,
      manageWindowProps({
        host: hostView({
          status: 'connecting',
          phase: 'ssh',
          progress: { code: 'ssh-connecting' },
          logs: [connectLine(1, 'info', null, 'SSH connected')],
        }),
      }),
    ),
    renderOf(C.DiagnoseDrawer, { t, host, status: 'done', report, onClose: noop, onRun: noop }),
    renderOf(C.SettingsModal, { t, settings: {}, onClose: noop, onSave: async () => {} }),
    renderOf(C.ErrorCard, { t, error, onRetry: noop }),
    renderOf(C.PasswordPrompt, { t, host, onSubmit: noop, onCancel: noop }),
    renderOf(C.FingerprintCard, { t, host: pendingHost, onAccept: noop, onReject: noop }),
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

/** dialogs, state frames and validation: one row per original test, so a failure reports the case it came from. */
test('a single dialog stack sends Escape to the top layer and restores focus', () => {
  const stack = plugin.__test.createDialogStack()
  const doc = fakeDialogDocument()
  const closed = []
  const lowerInput = fakeDialogNode(doc, { tagName: 'INPUT' })
  const lowerDialog = fakeDialogNode(doc, { focusables: [lowerInput] })
  const upperButton = fakeDialogNode(doc, { tagName: 'BUTTON' })
  const upperDialog = fakeDialogNode(doc, { focusables: [upperButton] })
  const removeLower = stack.push({
    layer: fakeDialogNode(doc),
    dialog: lowerDialog,
    dismissible: () => true,
    close: () => {
      closed.push('lower')
      removeLower()
    },
  })
  const removeUpper = stack.push({
    layer: fakeDialogNode(doc),
    dialog: upperDialog,
    dismissible: () => true,
    close: () => {
      closed.push('upper')
      removeUpper()
    },
  })

  // One document listener however many dialogs are open (the old bug installed one per dialog, re-added per render).
  assert.equal(doc.listeners.keydown.length, 1)
  assert.equal(doc.body.style.overflow, 'hidden', 'the page behind the dialogs must not scroll')
  // Only the top dialog is modal; the lower one is inert.
  assert.equal(upperDialog.getAttribute('aria-modal'), 'true')
  assert.equal(lowerDialog.getAttribute('aria-modal'), null)
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
  // The confirmation renders inside the management window: the lower *layer* holds the top *dialog*, so both go inert.
  const lowerLayer = fakeDialogNode(doc, { focusables: [nestedDialog] })
  const removeLower = stack.push({ layer: lowerLayer, dialog: lowerDialog, dismissible: () => true, close: noop })
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
  const remove = stack.push({
    layer: fakeDialogNode(doc),
    dialog: fakeDialogNode(doc, { focusables: [] }),
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
  const remove = stack.push({
    layer: fakeDialogNode(doc),
    dialog: fakeDialogNode(doc, { focusables: [first, last] }),
    dismissible: () => true,
    close: noop,
  })
  doc.activeElement = last
  assert.equal(pressKey(doc, 'Tab').prevented, true)
  assert.equal(doc.activeElement, first, 'Tab on the last control wraps to the first')
  doc.activeElement = first
  assert.equal(pressKey(doc, 'Tab', { shiftKey: true }).prevented, true)
  assert.equal(doc.activeElement, last, 'Shift+Tab on the first control wraps to the last')
  remove()
})

test('the modal renders aria-labelledby and a focusable dialog element', () => {
  const html = renderOf(C.Modal, { title: '标题', onClose: noop }, 'body')
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-labelledby="drg-dialog-title-\d+"/)
  assert.match(html, /<h2[^>]*id="drg-dialog-title-\d+"/)
  assert.match(html, /tabindex="-1"/)
  assert.doesNotMatch(html, /aria-modal="true"/, 'the stack marks only the top dialog at mount')
  // A non-dismissible dialog also disables its header ×: the button was the remaining way to close it under a request.
  const busy = renderOf(C.Modal, { title: '标题', onClose: noop, dismissible: false, busy: true }, 'body')
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
  // The refresh path captures the revision it started from: a slow response older than that is dropped, even if last.
  assert.equal(isNewerState({ rev: 5 }, 5, null), false)
  assert.equal(isNewerState({ rev: 7 }, 6, null), true)
  // A restart or plugin reload resets the counter, so a smaller rev from a new instance is accepted, not frozen out.
  assert.equal(isNewerState({ rev: 1, instance: 'host-2' }, 999, 'host-1'), true)
  assert.equal(isNewerState({ rev: 1000, instance: 'host-1' }, 999, 'host-1'), true)
  assert.equal(isNewerState({ rev: 1, instance: 'host-1' }, 999, 'host-1'), false)
})

/** A recording `EventSource`: every instance is kept, so a test drives `open`, `error` and frames by hand. */
function recordingEventSource(instances) {
  return class FakeEventSource {
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
    emit(type, payload = {}) {
      if (type === 'open' && typeof this.onopen === 'function') this.onopen()
      for (const handler of this.listeners[type] || []) handler(payload)
    }
  }
}
/** A client whose stream channel is a recording EventSource and whose retry timers the test fires by hand. */
function streamClient(state) {
  const instances = []
  const scheduled = []
  const client = loadClientPlugin({
    EventSource: recordingEventSource(instances),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms }
      scheduled.push(timer)
      return timer
    },
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state }) }),
  })
  return { client, instances, scheduled }
}

test('a dropped state stream polls, keeps the banner during retries and returns to live', async () => {
  const states = []
  const statuses = []
  const { client, instances, scheduled } = streamClient({ rev: 1, hosts: [] })
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
  const statuses = []
  const { client, instances, scheduled } = streamClient({ rev: 1 })
  const dispose = client.__test.subscribeState({ onStatus: (mode) => statuses.push(mode) })
  // Drive 40 failures: only the first 8 may create an EventSource; the chain then polls until a manual reconnect.
  for (let round = 0; round < 40; round += 1) {
    instances.at(-1).emit('error')
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
  for (const [attempt, delay] of [
    [0, 500],
    [1, 1000],
    [2, 2000],
    [10, 15000],
    [99, 15000],
  ]) {
    assert.equal(streamRetryDelay(attempt), delay)
  }
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
  const { sanitizeHostEntry, sanitizeSettings } = await import('../../dist/src/settings.js')
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
  assert.deepEqual(
    { ...validateHostDraft({ ...draft, keepAlive: 'idle', idleMinutes: 0 }) },
    { field: 'idleMinutes', code: 'wizard.validationIdleMinutes' },
  )
  const settings = settingsDraft({})
  assert.deepEqual(
    { ...validateSettingsDraft({ ...settings, defaultPort: 0 }) },
    { field: 'defaultPort', code: 'settings.validationPort' },
  )
  assert.deepEqual(
    { ...validateSettingsDraft({ ...settings, profile: 'desktop' }) },
    { field: 'profile', code: 'settings.validationProfile' },
  )
  assert.deepEqual(
    { ...validateSettingsDraft({ ...settings, connectTimeoutSec: 1 }) },
    { field: 'connectTimeoutSec', code: 'settings.validationTimeout' },
  )
  assert.equal(validateSettingsDraft(settings), null)
})

test('a 401 and a 403 from DSH admission are their own non-retryable views', async () => {
  for (const [status, code] of [
    [401, 'session-expired'],
    [403, 'forbidden'],
  ]) {
    const client = loadClientPlugin({ fetch: async () => ({ ok: false, status, json: async () => null }) })
    await assert.rejects(client.api.getState(), (error) => {
      assert.equal(error.view.code, code)
      assert.equal(error.view.retryable, false)
      assert.doesNotMatch(error.message, /插件内部错误|internal/i)
      return true
    })
  }
})

/** downloads, warnings and the small seams: one row per original test, so a failure reports the case it came from. */
test('the download card is not a status role around its buttons and the bar is labelled', () => {
  const html = renderOf(C.DownloadProgress, {
    t,
    job: { id: 'dl_1', phase: 'preparing', name: 'project', totalBytes: 0, doneBytes: 0, error: null },
    onCancel: noop,
  })
  const card = /<div[^>]*data-testid="dsh-remote-go-download"[^>]*>/.exec(html)
  assert.ok(card)
  assert.doesNotMatch(card[0], /role="status"/, 'the card contains buttons and cannot be the live region')
  assert.match(html, /role="progressbar"[^>]*aria-label="下载进度：project"/)
  assert.match(html, /aria-valuetext="正在下载"/)
  assert.match(html, /role="status"[^>]*aria-live="polite"/)
})

test('the download stack is a draggable transform layer over the bottom-right anchor', () => {
  const html = renderOf(C.DownloadCenter, {
    jobs: [
      { id: 'dl_1', phase: 'preparing', name: 'a', totalBytes: 10, doneBytes: 5 },
      { id: 'dl_2', phase: 'preparing', name: 'b', totalBytes: 0, doneBytes: 0 },
    ],
    t: enDownloadT,
    locale: 'en',
    onCancel: noop,
    onDismiss: noop,
  })
  assert.match(html, /data-testid="dsh-remote-go-downloads"/)
  assert.match(html, /transform:translate\(0px, 0px\)/)
  assert.equal((html.match(/data-testid="dsh-remote-go-download"/g) ?? []).length, 2)
  assert.match(html, /drg-download-action/)
})

test('host warning, version parity and the connecting-host filter render', () => {
  const listOf = (hosts) => listView({ state: stateWith({ hosts }) })
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
  matchesAll(warned, [
    /data-testid="host-warning"/,
    /远端已有手工实例/,
    /data-testid="host-version-parity"/,
    /0\.2\.1/,
    /0\.2\.2-rc\.3/,
  ])
  // Only a connecting card is a click target; a connected one keeps its plain card body.
  assert.doesNotMatch(warned, /data-interactive="true"/)

  // A connecting host is a card like any other now: progress line, way back to the connect window, no absence notice.
  const connecting = listOf([hostView({ status: 'connecting', progress: { code: 'ssh-connecting' } })])
  matchesAll(connecting, [
    /data-testid="host-card"/,
    /data-testid="host-view-progress"/,
    /data-progress="ssh-connecting"/,
  ])
  assert.doesNotMatch(connecting, /connecting-hosts-note/)
  const connectingEdit = /<button[^>]*data-testid="host-edit"[^>]*>/.exec(connecting)
  assert.ok(connectingEdit)
  assert.match(connectingEdit[0], /disabled=""/)

  // A restart/stop action keeps its card and progress, but editing it while the link action runs is disabled.
  const restarting = listOf([hostView({ status: 'connecting', progress: { code: 'restarting-remote' } })])
  matchesAll(restarting, [/data-testid="host-card"/, /data-testid="host-restart"/])
  const editButton = /<button[^>]*data-testid="host-edit"[^>]*>/.exec(restarting)
  assert.ok(editButton)
  assert.match(editButton[0], /disabled=""/)
})

test('a guest intent can act on its own host only', () => {
  const { sanitizeGuestIntent } = plugin.__test
  assert.deepEqual(
    { ...sanitizeGuestIntent({ action: 'download-file', path: '/a/b', name: 'b', kind: 'file' }, 'h_a') },
    { action: 'download-file', hostId: 'h_a', kind: 'file', path: '/a/b', name: 'b' },
  )
  // A crafted hostId never wins over the carrier's host.
  assert.equal(sanitizeGuestIntent({ action: 'download-file', hostId: 'h_victim', path: '/a' }, 'h_a').hostId, 'h_a')
  // A guest may only disconnect its own host; a forged id is refused, not rewritten into "disconnect yourself".
  assert.equal(sanitizeGuestIntent({ action: 'disconnect', hostId: 'h_victim' }, 'h_a'), null)
  assert.deepEqual(
    { ...sanitizeGuestIntent({ action: 'disconnect', hostId: 'h_a' }, 'h_a') },
    { action: 'disconnect', hostId: 'h_a' },
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
  const client = loadClientPlugin({ document: fakeDocument() })
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

/** the connect-log channel: one row per original test, so a failure reports the case it came from. */
test('a state frame never wipes the rows the log channel merged (R1)', () => {
  const { mergeStatePreservingLogs } = plugin.__test
  const cursors = new Map()
  const previous = logState([logHost({ id: 'h_a', logs: [logLine(1), logLine(2)] })])
  // A v2.12 state frame: same host, `logs` empty.
  const next = logState([logHost({ id: 'h_a', logSeq: 2 })], { rev: 2 })
  const merged = mergeStatePreservingLogs(previous, next, cursors)
  assert.deepEqual(seqsOf(merged), [1, 2], 'the rows stay on screen')
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
  assert.deepEqual(seqsOf(legacy), [5, 6])
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
  assert.deepEqual(seqsOf(seeded), [1, 2, 3], 'old rows are merged by seq, not appended twice')
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
  assert.deepEqual(seqsOf(first.state), [1, 2])
  assert.deepEqual({ ...cursors.get('h_a') }, { instance: 'gen-1', attempt: 1, seq: 2 })
  // The same reset again (a reconnect, or the frame after `GET /state` already seeded it): no repaint.
  assert.equal(applyLogFrame(first.state, frame(), cursors).applied, false, 'a replay changes nothing on screen')
  // An increment only adds rows past the cursor.
  const increment = applyLogFrame(
    first.state,
    frame({ reset: undefined, seq: 4, entries: [logLine(2), logLine(3), logLine(4)] }),
    cursors,
  )
  assert.deepEqual(seqsOf(increment.state), [1, 2, 3, 4], 'row 2 is not rendered twice')
  assert.equal(cursors.get('h_a').seq, 4)
  // An older attempt (a late frame from the previous connection) is dropped whole.
  assert.equal(applyLogFrame(first.state, frame({ reset: undefined, attempt: 0, seq: 9 }), cursors).applied, false)
  // A newer attempt without a reset flag still rebuilds: its seq restarts at 1.
  const nextAttempt = applyLogFrame(
    increment.state,
    frame({ reset: undefined, attempt: 2, seq: 1, entries: [logLine(1)] }),
    cursors,
  )
  assert.deepEqual(seqsOf(nextAttempt.state), [1], 'the old attempt rows are gone')
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
  const { client, instances, scheduled } = streamClient()
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
  // A permanent refusal (an older Host without `/events/logs`) switches the channel off: no banner, polling or retry.
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

/* ── platform behaviour ───────────────────────────────────────────────────────────────────────
 * These pin the mechanism — one paint per display frame, a state-preserving move, the IME gate, the forced-colors edge
 * — not a rendered snapshot: no DOM structure, class, ARIA, copy, focus order or pixel move changed with it. */

/** One log pump over a state the test owns; `painted` collects every tree it delivered, in order. */
function pumpOver(options = {}) {
  const createLogPump = options.createLogPump || plugin.__test.createLogPump
  let state = options.state || logState([logHost({ id: 'h_a', logs: [] })])
  const painted = []
  const pump = createLogPump({
    read: () => state,
    deliver: (next) => {
      painted.push(next)
      state = next
    },
    cursors: () => options.cursors || new Map(),
    alive: () => options.alive !== false,
    schedule: options.schedule,
    cancel: options.cancel,
  })
  return {
    pump,
    painted,
    hold: (next) => {
      state = next
    },
  }
}

/** the connect-log paint pump: one row per original test, so a failure reports the case it came from. */
test('a burst of connect-log frames paints once per display frame, in order and complete', () => {
  const clock = frameRecorder()
  const { pump, painted } = pumpOver({ schedule: clock.schedule, cancel: clock.cancel })
  const frame = (seq) => ({
    hostId: 'h_a',
    instance: 'gen-1',
    attempt: 1,
    seq,
    visible: true,
    entries: [logLine(seq)],
  })
  // Ten frames: the Host emits one per log line, and a connection prints dozens a second.
  for (let seq = 1; seq <= 10; seq += 1) pump.push(frame(seq))
  assert.equal(clock.frames.length, 1, 'ten frames inside one display frame ask for one paint')
  assert.equal(painted.length, 0, 'and nothing is painted before that frame runs')
  assert.equal(pump.pending(), true)
  clock.runNext()
  assert.equal(painted.length, 1, 'the frame paints once')
  assert.deepEqual(seqsOf(painted[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every row is there, once, in arrival order')
  assert.deepEqual(
    painted[0].hosts[0].logs.map((entry) => entry.message),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) => `row ${seq}`),
  )
  assert.equal(pump.pending(), false)
  // The next frame opens a new display frame: the coalescing is per frame, not a one-off.
  pump.push(frame(11))
  assert.equal(clock.frames.length, 1)
  clock.runNext()
  assert.deepEqual(seqsOf(painted[1]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  // A frame that only replays rows already on screen is not a reason to paint (R3).
  pump.push(frame(11))
  clock.runNext()
  assert.equal(painted.length, 2, 'a replayed frame changes nothing on screen')
})

test('the deferred paint merges into the tree React holds then, never the one it replaced', () => {
  const clock = frameRecorder()
  const live = logState([logHost({ id: 'h_a', logs: [] })], { rev: 1, settings: { language: 'zh' } })
  const { pump, painted, hold } = pumpOver({ state: live, schedule: clock.schedule, cancel: clock.cancel })
  pump.push({ hostId: 'h_a', instance: 'gen-1', attempt: 1, seq: 1, reset: true, entries: [logLine(1)] })
  // Something else advances the state while the frame is pending (a saved setting, a newer frame): the queued paint
  // merge into that tree, not the one it was scheduled against, or the setting would be painted back to its old value.
  const saved = { ...live, rev: 2, settings: { language: 'en' } }
  hold(saved)
  clock.runNext()
  assert.equal(painted.length, 1)
  assert.equal(painted[0].settings.language, 'en', 'the newer tree wins')
  assert.equal(painted[0].rev, 2)
  assert.deepEqual(seqsOf(painted[0]), [1], 'and the frame is merged into it')
  assert.notEqual(painted[0], saved, 'the delivered tree is the merged copy, not the input')
})

test('the paint waits for a display frame, and falls back to a task when the page has none', () => {
  /** One frame per seq, so the *scheduler* is the only thing under test. */
  const push = (page, seq) =>
    page.pump.push({ hostId: 'h_a', instance: 'gen-1', attempt: 1, seq, reset: seq === 1, entries: [logLine(seq)] })
  // A page with a display frame: nothing runs until it is handed back, and a frame no longer needed is not painted.
  const frames = []
  const frameClient = loadClientPlugin({
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame: (handle) => frames.push(`cancelled:${handle}`),
  })
  const framed = pumpOver({ createLogPump: frameClient.__test.createLogPump })
  push(framed, 1)
  assert.equal(frames.length, 1, 'the default scheduler asked for one display frame')
  assert.equal(framed.painted.length, 0, 'and waited for it')
  frames.shift()()
  assert.deepEqual(seqsOf(framed.painted[0]), [1])
  push(framed, 2)
  framed.pump.cancel()
  assert.equal(frames.length, 2, 'cancel gives the frame back to the page')
  assert.match(frames[1], /cancelled:/)
  assert.equal(framed.painted.length, 1, 'a cancelled frame paints nothing')
  // A page with no display frame (a document stub, or a host that removed it): one task later.
  const timers = []
  const taskClient = loadClientPlugin({
    setTimeout: (callback) => {
      timers.push(callback)
      return timers.length
    },
  })
  const tasked = pumpOver({ createLogPump: taskClient.__test.createLogPump })
  push(tasked, 1)
  assert.equal(timers.length, 1, 'a page without frame callbacks gets one task')
  assert.equal(tasked.painted.length, 0)
  timers.shift()()
  assert.deepEqual(seqsOf(tasked.painted[0]), [1])
})

test('a panel that is gone never receives the paint it was owed', () => {
  const clock = frameRecorder()
  const { pump, painted } = pumpOver({ alive: false, schedule: clock.schedule, cancel: clock.cancel })
  pump.push({ hostId: 'h_a', instance: 'gen-1', attempt: 1, seq: 1, reset: true, entries: [logLine(1)] })
  clock.runNext()
  assert.deepEqual(painted, [], 'a frame merged after unmount is dropped')
  pump.cancel()
  assert.equal(pump.pending(), false)
})

/** Row placement, the IME gate and the stylesheet guards: one row per original test, so a failure names its case. */
test('the switcher row is re-placed with moveBefore and keeps its open menu', () => {
  const { dom, local } = rowPage([hostView({ id: 'h_a', name: '43.133.80.40', status: 'connected' })])
  const row = rowOf(dom)
  assert.ok(row, 'the row is installed first')
  assert.equal(dom.brand.nextSibling, row)
  // The row is a button with a menu inside it: this is the state a remove-then-insert would lose.
  clickInside(row, row)
  assert.equal(row.getAttribute('aria-expanded'), 'true')
  // The shell inserts a sibling above the row (a re-rendered sidebar). The row is now one place off, so the next
  // placement has to move it.
  const foreign = dom.document.createElement('div')
  dom.column.insertBefore(foreign, row)
  assert.notEqual(dom.brand.nextSibling, row)
  const moves = recordMoveBefore(dom)
  const inserts = recordInsertBefore(dom)
  local.carrier.update({ hosts: [] })
  assert.equal(moves.length, 1, 'the connected node is moved, not re-inserted')
  assert.equal(moves[0].node, row)
  assert.equal(moves[0].reference, foreign, 'and lands directly after the brand row')
  assert.equal(inserts.length, 0, 'the remove-then-insert path is not taken when moveBefore exists')
  assert.deepEqual(dom.column.children.slice(0, 3), [dom.brand, row, foreign], 'the row is back in its place')
  assert.equal(row.parentNode, dom.column)
  assert.equal(row.getAttribute('aria-expanded'), 'true', 'the menu stayed open')
  assert.equal(row.classList.contains('drg-open'), true, 'and is still the open surface')
})

test('without moveBefore the row is re-placed exactly as before', () => {
  const { dom, local } = rowPage()
  const row = rowOf(dom)
  assert.ok(row)
  assert.equal(typeof dom.column.moveBefore, 'undefined', 'this page has no moveBefore')
  clickInside(row, row)
  const foreign = dom.document.createElement('div')
  dom.column.insertBefore(foreign, row)
  const inserts = recordInsertBefore(dom)
  local.carrier.update({ hosts: [] })
  assert.equal(inserts.length, 1, 'the fallback is the insertion the code always made')
  assert.equal(inserts[0].node, row)
  assert.equal(inserts[0].reference, foreign)
  assert.deepEqual(dom.column.children.slice(0, 3), [dom.brand, row, foreign])
  assert.equal(row.getAttribute('aria-expanded'), 'true')
})

test('a moveBefore that refuses the move falls through to the insertion', () => {
  const { dom, local } = rowPage()
  const row = rowOf(dom)
  const attempts = []
  dom.column.moveBefore = (node, reference) => {
    attempts.push({ node, reference })
    // Chromium's first implementation refuses a cross-document move with `NotSupportedError`; a partial implementation
    // has the same shape, and it must not cost the row its place.
    throw new Error('NotSupportedError: the move is not atomic here')
  }
  const foreign = dom.document.createElement('div')
  dom.column.insertBefore(foreign, row)
  const inserts = recordInsertBefore(dom)
  local.carrier.update({ hosts: [] })
  assert.equal(attempts.length, 1, 'the state-preserving move is tried first')
  assert.equal(inserts.length, 1, 'and the refusal still places the row')
  assert.deepEqual(dom.column.children.slice(0, 3), [dom.brand, row, foreign])
})

test('an Enter that confirms an IME candidate does not submit the password', () => {
  const { passwordEnterSubmits } = plugin.__test
  // React's synthetic event does not carry `isComposing`: the native one is what decides.
  assert.equal(passwordEnterSubmits({ key: 'Enter', nativeEvent: { isComposing: true } }), false)
  // Safari clears `isComposing` on the composing Enter and reports the legacy 229 instead.
  assert.equal(passwordEnterSubmits({ key: 'Enter', nativeEvent: { keyCode: 229 } }), false)
  assert.equal(passwordEnterSubmits({ key: 'Enter', keyCode: 229 }), false, 'the synthetic value is checked too')
  assert.equal(passwordEnterSubmits({ key: 'Enter', nativeEvent: { isComposing: true, keyCode: 229 } }), false)
  // A key event that is not an Enter is never a submit, composing or not.
  assert.equal(passwordEnterSubmits({ key: 'a', nativeEvent: {} }), false)
  assert.equal(passwordEnterSubmits({ key: 'Escape', nativeEvent: { isComposing: true } }), false)
  assert.equal(passwordEnterSubmits(null), false)
})

test('a plain Enter still submits, once per keypress', () => {
  const { passwordEnterSubmits } = plugin.__test
  assert.equal(passwordEnterSubmits({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }), true)
  assert.equal(passwordEnterSubmits({ key: 'Enter', nativeEvent: { keyCode: 0 } }), true, 'a synthetic Enter')
  assert.equal(passwordEnterSubmits({ key: 'Enter' }), true, 'an event with no native half')
})

test('the dialog gains its forced-colors edge only inside the forced-colors block', () => {
  const css = clientCss()
  const forced = atRuleBodies(css, 'media (forced-colors: active)')
  assert.equal(forced.length, 1, 'expected exactly one forced-colors block')
  // The two surfaces whose scrim collapses onto the same Canvas.
  assert.match(forced[0], /\.drg-modal, \.drg-drawer \{ border: 1px solid CanvasText; \}/)
  // Normal mode is untouched by construction (a media rule cannot apply): no other block gives either surface a border.
  const bordered = cssBlocks(stripAtRules(css)).filter(
    (block) =>
      block.selectors.some((selector) => selector === '.drg-modal' || selector === '.drg-drawer') &&
      /(?:^|;)\s*border(?:-width|-style|-color)?\s*:/.test(block.body),
  )
  assert.deepEqual(
    bordered.map((block) => block.selectors),
    [['.drg-modal']],
    'the dialog’s reset is the only border',
  )
  assert.match(bordered[0].body, /border: 0(?:;|$)/, 'and it stays a zero-width border')
})

test('every animation and transition is covered by the reduced-motion opt-out', () => {
  const css = clientCss()
  const optOut = atRuleBodies(css, 'media (prefers-reduced-motion: reduce)')
  assert.equal(optOut.length, 1, 'expected exactly one reduced-motion block in the panel')
  assert.match(
    optOut[0],
    /\.drg-root \*, \.drg-root \*::before, \.drg-root \*::after \{ animation-duration: 0\.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0\.01ms !important; \}/,
    'every descendant animation and transition collapses to a single 0.01ms pass',
  )
  // The one deliberate exception: a spinner is the only sign that work is still running, so it keeps turning - slowly.
  assert.match(
    optOut[0],
    /\.drg-spinner \{ animation-duration: 2\.4s; animation-iteration-count: infinite !important; \}/,
    'the spinner stays a slow spinner',
  )
  // The opt-out reaches `.drg-root` descendants only, so no animated selector may escape the panel root: an animation
  // the shell's seat, on `body` or on an injected id would keep running through it.
  const animated = []
  for (const block of cssBlocks(stripAtRules(css))) {
    if (!/(?:^|;)\s*(?:animation|transition)\s*:/.test(block.body)) continue
    for (const selector of block.selectors) {
      assert.doesNotMatch(selector, /^(?:html|body)\b|^\[data-|^#/, `"${selector}" animates outside the opt-out`)
      animated.push(selector)
    }
  }
  assert.ok(animated.length >= 10, `expected the panel's animated surfaces, found ${animated.length}`)
  // The guest row is drawn in the remote page, which the panel stylesheet does not reach: it carries its own opt-out.
  const row = rowStyles()
  const rowOptOut = atRuleBodies(row, 'media (prefers-reduced-motion:reduce)')
  assert.equal(rowOptOut.length, 1, 'the injected row must opt out on its own')
  assert.match(rowOptOut[0], /#drg-host-row,#drg-host-row \*\{transition:none!important;animation:none!important\}/)
  const rowAnimated = []
  for (const block of cssBlocks(stripAtRules(row))) {
    if (!/(?:^|;)\s*(?:animation|transition)\s*:/.test(block.body)) continue
    for (const selector of block.selectors) {
      assert.match(selector, /^#drg-host-row/, `"${selector}" animates outside the row's opt-out`)
      rowAnimated.push(selector)
    }
  }
  assert.ok(rowAnimated.length >= 4, `expected the row's animated surfaces, found ${rowAnimated.length}`)
})

test('no rule removes the focus ring without replacing it', () => {
  const css = clientCss()
  const removals = cssBlocks(stripAtRules(css)).filter((block) => /(?:^|;)\s*outline\s*:\s*(?:none|0)/.test(block.body))
  assert.deepEqual(
    removals.map((block) => block.selectors),
    [['.drg-input:focus:not(:focus-visible)', '.drg-select:focus:not(:focus-visible)']],
    'the only removed ring is the pointer-focus one',
  )
  for (const block of removals) {
    for (const selector of block.selectors) {
      assert.match(selector, /:not\(:focus-visible\)/, `${selector} must keep keyboard focus visible`)
    }
  }
  // Keyboard focus gets the panel-wide ring, reading the host's tokens inside the rule so mouse users see no ring.
  assert.match(
    css,
    /\.drg-root :focus-visible \{[^}]*outline: var\(--dsw-focus-ring-width, 2px\) solid var\(--dsw-focus-ring-color, var\(--dsw-alias-state-business-primary\)\);/,
    'the panel keeps its one focus ring',
  )
  assert.match(
    css,
    /\.drg-input:focus-visible, \.drg-select:focus-visible \{ outline-offset: 1px; \}/,
    'and the fields adjust the ring instead of dropping it',
  )
  // The two surfaces drawn outside `.drg-root` carry their own visible ring.
  assert.match(rowStyles(), /#drg-host-row:focus-visible\{outline:var\(--dsw-focus-ring-width,2px\)/)
  assert.match(SOURCE, /\.drg-carrier-error button:focus-visible\{outline:var\(--dsw-focus-ring-width,2px\)/)
})

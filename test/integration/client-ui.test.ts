import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTempRoot, resolveBrowser, skipOrFail } from './harness-support.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The plugin serves the built artifact: `dist/client.js` (scripts/build-client.mjs).
const CLIENT_PATH = path.join(ROOT, 'dist', 'client.js')

const GUEST_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DeepSeek Harness</title></head>
<body>
<div id="sidebar" style="position:fixed;left:0;top:0;width:280px;height:100vh">
  <div data-window-drag style="width:280px;height:40px"></div>
  <div id="root"><div class="guest-app">remote DSH</div></div>
</div>
<script>
  window.emitDownload = (overrides) => window.__drgBridgeSink(Object.assign(
    { action: 'download-file', kind: 'file', path: '/home/user/a.txt', name: 'a.txt' }, overrides || {}))
  window.emitTarget = (target) => window.__drgBridgeSink({ target })
</script>
</body></html>`

const NOT_DSH_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>proxy error</title></head>
<body><h1>404: unknown host</h1></body></html>`

const ROUTES = {
  '/dsh-remote-go/remote/h_a/': GUEST_HTML,
  '/dsh-remote-go/remote/h_pw/': GUEST_HTML,
  '/dsh-remote-go/remote/h_bad/': NOT_DSH_HTML,
}

/** The harness page: real React overlay over a stubbed Host API, an EventSource and two guests. */
function harnessPage() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>client ui harness</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  #seat { min-height: 40px; }
</style>
</head>
<body>
<div id="seat"></div>
<script>
  const now = () => new Date().toISOString()
  const hostView = (overrides) => Object.assign({
    id: 'h_a', name: 'host-a', address: 'host-a', addressMasked: 'ubuntu@host-a:2222',
    username: 'ubuntu', port: 2222, authType: 'key', authKeyPath: '~/.ssh/id_rsa',
    passwordSaved: false, passwordStorageAvailable: true, jumpHost: null,
    status: 'connected', phase: 'ready', progress: null, error: null, warning: null,
    conflict: null, fingerprint: null, logs: [],
    remote: { version: '0.2.2-rc.3', uiReady: true, localPort: 1, port: 1, pid: 1,
      dshHome: '/home/ubuntu/.dsh', profile: 'web', bootstrapLevel: 'npx',
      nodeVersion: '24.9.0', nodeSource: 'managed', startedAt: null, viewRev: 1 },
    keepAlive: 'keep', idleMinutes: 15, autoReconnect: true, hostKeyPolicy: 'first-use',
    targetVersion: '0.2.2-rc.3',
    versionParity: { status: 'same', local: '0.2.2-rc.3', remote: '0.2.2-rc.3', same: true, message: { zh: '', en: '' } },
    lastOpenedAt: null, createdAt: now(), updatedAt: now()
  }, overrides || {})
  window.__state = {
    rev: 1, instance: 'host-1', hostVersion: '0.2.2-rc.3', targetVersion: '0.2.2-rc.3',
    activeHostId: null, firstRun: false,
    settings: {
      defaultPort: 2222, defaultAuth: 'key', defaultKeyPath: '~/.ssh/id_rsa',
      connectTimeoutSec: 30,
      autoReconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 1000 },
      hostKeyPolicy: 'first-use', saveTokens: false, language: 'zh', logLevel: 'info',
      bootstrap: { profile: 'web' }
    },
    hosts: [
      hostView({}),
      hostView({ id: 'h_pw', name: 'password-host', address: 'pw-host', addressMasked: 'pw-host',
        username: null, port: 22, authType: 'password', passwordSaved: true,
        status: 'disconnected', phase: null,
        remote: { version: null, uiReady: false, localPort: null, viewRev: 0 } }),
      hostView({ id: 'h_v6', name: 'ipv6-host', address: 'fe80::1',
        addressMasked: 'user@[fe80::1]:2222', username: 'user', port: 2222,
        status: 'disconnected', phase: null,
        remote: { version: null, uiReady: false, localPort: null, viewRev: 0 } }),
      hostView({ id: 'h_bad', name: 'bad-host', address: 'bad-host', addressMasked: 'bad-host',
        username: null, port: 22 }),
      // A frame that never commits: the carrier must still show a failure layer and an exit.
      hostView({ id: 'h_hang', name: 'hang-host', address: 'hang-host', addressMasked: 'hang-host',
        username: null, port: 22 })
    ]
  }
  window.__calls = []
  window.__savedHost = null
  window.__connectMode = 'ok'
  window.__connectAttempts = 0
  window.__settingsMode = 'ok'
  const json = (payload, status) => ({
    ok: status === undefined || status === 200, status: status || 200,
    headers: { get: () => 'application/json' },
    async json() { return payload }
  })
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input.url)
    const method = (init && init.method ? init.method : 'GET').toUpperCase()
    let body = null
    try { body = init && init.body ? JSON.parse(init.body) : null } catch (_error) { body = null }
    window.__calls.push({ url, method, body })
    if (url === '/dsh-remote-go/api/state') {
      if (window.__slowState) {
        // A deliberately late GET /state: the test pushes a newer SSE frame in between.
        const slow = window.__slowState
        window.__slowState = null
        await delay(400)
        return json({ ok: true, state: slow })
      }
      return json({ ok: true, state: window.__state })
    }
    if (url === '/dsh-remote-go/api/hosts' && method === 'POST') {
      const host = body.host
      window.__savedHost = host
      return json({ ok: true, host: Object.assign({}, host, { id: host.id || 'h_saved' }) })
    }
    const open = /^\\/dsh-remote-go\\/api\\/hosts\\/([^/]+)\\/open$/.exec(url)
    if (open) {
      const hostId = decodeURIComponent(open[1])
      return json({ ok: true, url: 'http://127.0.0.1:1/', webUrl: '/dsh-remote-go/remote/' + hostId + '/' })
    }
    const connect = /^\\/dsh-remote-go\\/api\\/hosts\\/([^/]+)\\/connect$/.exec(url)
    if (connect && method === 'POST') {
      window.__connectAttempts += 1
      if (window.__connectMode === 'auth-error') {
        return json({ ok: false, error: {
          code: 'auth', retryable: true,
          title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
          detail: { zh: '密码不对。', en: 'The password is wrong.' },
          nextSteps: []
        } }, 409)
      }
      await delay(window.__connectMode === 'slow' ? 1200 : 150)
      return json({ ok: true })
    }
    const password = /^\\/dsh-remote-go\\/api\\/hosts\\/([^/]+)\\/password$/.exec(url)
    if (password && method === 'POST') {
      return json({ ok: true, available: true, saved: !(body && body.clear === true) })
    }
    if (url === '/dsh-remote-go/api/settings' && method === 'POST') {
      if (window.__settingsMode === 'slow') await delay(1200)
      return json({ ok: true, settings: window.__state.settings })
    }
    return json({ ok: true })
  }
  window.__streams = []
  window.EventSource = class {
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.closed = false
      // 0 = CONNECTING until told otherwise; a test that wants the "permanent refusal" path
      // (an older Host without /events/logs) sets 2 before emitting an error.
      this.readyState = 0
      window.__streams.push(this)
    }
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    }
    emit(type, payload) {
      if (type === 'open' && typeof this.onopen === 'function') this.onopen(payload)
      for (const handler of this.listeners[type] || []) handler(payload)
    }
    close() {
      this.closed = true
      this.readyState = 2
    }
  }
  /** Fail the newest open stream (optionally the one whose URL ends with suffix). */
  window.__failStream = (suffix) => {
    const open = window.__streams.filter(
      (stream) => !stream.closed && (!suffix || String(stream.url).endsWith(suffix)),
    )
    const stream = open[open.length - 1]
    if (stream) stream.emit('error', {})
  }
  /** One frame on the connect-log channel (docs/api.md GET /events/logs). */
  window.__pushLog = (frame) => {
    for (const stream of window.__streams) {
      if (stream.closed || !String(stream.url).endsWith('/events/logs')) continue
      stream.emit('log', { data: JSON.stringify(frame) })
    }
  }
  window.__logStreams = () =>
    window.__streams.filter((stream) => String(stream.url).endsWith('/events/logs'))
  window.__pushState = (state) => {
    window.__state = state
    // The client may have rebuilt its EventSource: every live instance gets the frame, the
    // closed ones ignore it inside the client.
    for (const stream of window.__streams) {
      if (!stream.closed) stream.emit('state', { data: JSON.stringify(state) })
    }
  }
</script>
<script src="/react.js"></script>
<script>window.__ModuleLoader__ = { load(declaration) { window.__declaration = declaration } }</script>
<script src="/client.js"></script>
<script>
  (() => {
    const plugin = window.__declaration.factory(() => window.React)
    const captured = {}
    const ctx = {
      locale: { register() {}, bind() { return (key) => key } },
      effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
      slots: {
        inject(_key, callback) { callback() },
        register(options, component) { captured.options = options; captured.component = component; return () => {} }
      },
      get() { return undefined }
    }
    plugin.apply(ctx)
    const face = captured.options.inject()
    // Record download intents without letting the picker start a real job.
    const originalDownload = face.toolStore.requestDownload.bind(face.toolStore)
    window.__downloads = []
    face.toolStore.requestDownload = (request) => {
      window.__downloads.push(Object.assign({}, request))
      return originalDownload(request)
    }
    const seat = document.getElementById('seat')
    window.ReactDOM.createRoot(seat).render(window.React.createElement(captured.component, Object.assign({
      initialState: window.__state,
      pickDirectory: async () => null
    }, face)))
    window.__harness = { plugin, face, captured }
  })()
</script>
</body></html>`
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

test(
  'client dialogs, host editing, password flow, live stream, downloads and carrier failures',
  { timeout: 180_000 },
  async (t) => {
    const browserPath = resolveBrowser()
    if (browserPath === null) {
      skipOrFail(t, 'no Chromium browser is available (set CHROME_PATH)')
      return
    }
    const tempRoot = makeTempRoot('dsh-remote-go-client-ui')
    let browser = null
    let server = null
    try {
      const esbuild = await import('esbuild')
      const reactBundle = (
        await esbuild.build({
          stdin: {
            contents: `import React from 'react'
import { createRoot } from 'react-dom/client'
window.React = React
window.ReactDOM = { createRoot }`,
            resolveDir: ROOT,
            loader: 'js',
          },
          bundle: true,
          write: false,
          format: 'iife',
          platform: 'browser',
          logLevel: 'silent',
        })
      ).outputFiles[0].text
      const harness = harnessPage()
      server = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(harness)
          return
        }
        if (pathname === '/react.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          res.end(reactBundle)
          return
        }
        if (pathname === '/client.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          res.end(readFileSync(CLIENT_PATH))
          return
        }
        if (pathname === '/dsh-remote-go/remote/h_hang/') {
          // Never answer: the carrier's load timeout owns this case.
          return
        }
        if (Object.prototype.hasOwnProperty.call(ROUTES, pathname)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(ROUTES[pathname])
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      })
      const port = await listen(server)
      const puppeteer = (await import('puppeteer-core')).default
      browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: 'new',
        userDataDir: path.join(tempRoot, 'profile'),
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          // Hosted Ubuntu runners restrict unprivileged user namespaces: Chromium aborts with
          // "No usable sandbox!" without this (same as the other browser suites).
          ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        ],
      })
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error?.message ?? error)))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push('console: ' + message.text())
      })
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForFunction(() => Boolean(window.__harness), { timeout: 15_000 })
      const escape = async () => {
        await page.keyboard.press('Escape')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const openManage = async () => {
        await page.evaluate(() => window.__harness.face.panelStore.requestIntent({ kind: 'manage' }))
        try {
          await page.waitForSelector('[data-testid="manage-window"]', { timeout: 5000 })
        } catch (error) {
          const state = await page.evaluate(() => ({
            hasManage: Boolean(document.querySelector('[data-testid="manage-window"]')),
            dialogs: document.querySelectorAll('[role="dialog"]').length,
            seatLength: document.getElementById('seat').innerHTML.length,
            pending: window.__harness.face.panelStore.take(),
          }))
          throw new Error(
            `manage window did not open: ${JSON.stringify(state)} console: ${JSON.stringify(errors)} (${error.message})`,
          )
        }
      }
      const closeManage = async () => {
        if (await page.$('[data-testid="manage-window"]')) await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="manage-window"]'), { timeout: 5000 })
      }
      const openWizard = async (mode, hostId) => {
        await page.evaluate(
          ({ mode, hostId }) => {
            const host = hostId ? window.__state.hosts.find((item) => item.id === hostId) : null
            window.__harness.face.wizardStore.open({ mode, host })
          },
          { mode, hostId },
        )
        await page.waitForSelector('[data-testid="host-wizard"]', { visible: true, timeout: 5000 })
      }

      await t.test('one Escape closes only the top dialog, two close the stack', async () => {
        await openManage()
        await openWizard('add')
        let stacked = await page.evaluate(() => ({
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          overflow: document.body.style.overflow,
          focusInTop: Boolean(document.activeElement && document.activeElement.closest('[data-testid="host-wizard"]')),
          modals: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.getAttribute('aria-modal')),
          inert: [...document.querySelectorAll('.drg-modal-layer')].map((node) => node.hasAttribute('inert')),
        }))
        assert.equal(stacked.dialogs, 2)
        assert.equal(stacked.overflow, 'hidden')
        assert.equal(stacked.focusInTop, true, 'focus enters the wizard')
        assert.deepEqual(stacked.modals, [null, 'true'], 'only the top dialog is modal')
        assert.deepEqual(stacked.inert, [true, false], 'the lower dialog layer is inert')

        await escape()
        let state = await page.evaluate(() => ({
          wizard: Boolean(document.querySelector('[data-testid="host-wizard"]')),
          manage: Boolean(document.querySelector('[data-testid="manage-window"]')),
        }))
        assert.deepEqual(state, { wizard: false, manage: true }, 'the first Escape must not close the lower dialog')

        await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="manage-window"]'), { timeout: 5000 })
        const restored = await page.evaluate(() => ({
          overflow: document.body.style.overflow,
          focusInsideDialog: Boolean(document.activeElement && document.activeElement.closest('[role="dialog"]')),
        }))
        assert.equal(restored.overflow, '')
        assert.equal(restored.focusInsideDialog, false)
      })

      await t.test('manage + password and manage + delete close one layer at a time', async () => {
        // manage + password prompt
        await openManage()
        // A remembered password is tried first; force that attempt to fail so the prompt appears
        // while the management window stays open.
        await page.evaluate(() => {
          window.__connectMode = 'auth-error'
        })
        await page.click('[data-testid="host-card"][data-host-id="h_pw"] [data-testid="host-open"]')
        await page.waitForSelector('[data-testid="password-prompt"]', { visible: true, timeout: 5000 })
        await page.evaluate(() => {
          window.__connectMode = 'ok'
        })
        await escape()
        let state = await page.evaluate(() => ({
          password: Boolean(document.querySelector('[data-testid="password-prompt"]')),
          manage: Boolean(document.querySelector('[data-testid="manage-window"]')),
        }))
        assert.deepEqual(state, { password: false, manage: true })
        await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="manage-window"]'), { timeout: 5000 })

        // manage + delete confirmation
        await openManage()
        await page.click('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-delete"]')
        await page.waitForSelector('[data-testid="delete-dialog"]', { visible: true, timeout: 5000 })
        await escape()
        state = await page.evaluate(() => ({
          confirm: Boolean(document.querySelector('[data-testid="delete-dialog"]')),
          manage: Boolean(document.querySelector('[data-testid="manage-window"]')),
        }))
        assert.deepEqual(state, { confirm: false, manage: true })
        await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="manage-window"]'), { timeout: 5000 })
      })

      await t.test('the manage window can confirm stopping its remote DSH', async () => {
        // The confirmation is rendered inside the management window. While it is on top, the
        // layer that hosts it gets `inert` - and a nested dialog inherits that, so every button
        // and its backdrop used to accept no input at all (the window read as frozen).
        await openManage()
        await page.click('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-stop-remote"]')
        await page.waitForSelector('[data-testid="stop-remote-dialog"]', { visible: true, timeout: 5000 })
        const nested = await page.evaluate(() => {
          const button = document.querySelector('[data-testid="stop-remote-confirm"]')
          const dialog = document.querySelector('[data-testid="stop-remote-dialog"]')
          const rect = button.getBoundingClientRect()
          const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          const inertAncestors = []
          let node = dialog
          while (node && node !== document.body) {
            if (node.hasAttribute('inert')) inertAncestors.push(node.className)
            node = node.parentElement
          }
          return { inertAncestors, hitTest: Boolean(at && at.closest('[data-testid="stop-remote-confirm"]')) }
        })
        assert.deepEqual(nested.inertAncestors, [], 'the confirmation must not sit inside an inert layer')
        assert.equal(nested.hitTest, true, 'the confirmation button must receive the click')

        // The hosting layer is no longer inert, so the nested backdrop is what has to shield the
        // window below: a click on a card action must cancel the confirmation, not reach the card.
        const behind = await page.evaluate(() => {
          const card = document
            .querySelector('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-open"]')
            .getBoundingClientRect()
          const dialog = document.querySelector('[data-testid="stop-remote-dialog"]').getBoundingClientRect()
          const x = card.left + card.width / 2
          const y = card.top + card.height / 2
          const insideDialog = x >= dialog.left && x <= dialog.right && y >= dialog.top && y <= dialog.bottom
          return { x, y, insideDialog }
        })
        assert.equal(behind.insideDialog, false, 'the probe point must be behind the confirmation, not on it')
        await page.mouse.click(behind.x, behind.y)
        await page.waitForFunction(() => !document.querySelector('[data-testid="stop-remote-dialog"]'), {
          timeout: 5000,
        })
        assert.equal(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="manage-window"]'))),
          true,
          'a click behind the confirmation must not reach the window below',
        )

        // Reopen it for the confirmed path (the cancel above left the card untouched).
        await page.click('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-stop-remote"]')
        await page.waitForSelector('[data-testid="stop-remote-dialog"]', { visible: true, timeout: 5000 })
        await page
          .waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'stop-remote-cancel', {
            timeout: 3000,
          })
          .catch((error) => {
            throw new Error(`the safe action did not take focus in the stop confirmation: ${error.message}`)
          })
        const before = await page.evaluate(
          () => window.__calls.filter((call) => /\/stop-remote$/.test(call.url)).length,
        )
        await page.click('[data-testid="stop-remote-confirm"]')
        await page.waitForFunction(
          (count) => window.__calls.filter((call) => /\/stop-remote$/.test(call.url)).length > count,
          { timeout: 5000 },
          before,
        )
        await page.waitForFunction(() => !document.querySelector('[data-testid="stop-remote-dialog"]'), {
          timeout: 5000,
        })
        assert.equal(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="manage-window"]'))),
          true,
          'the management window stays usable after the stop',
        )
        await closeManage()
      })

      await t.test('restart and reconnect open the connect window with their progress and log', async () => {
        const patchHost = (hostId, patch) =>
          page.evaluate(
            ({ hostId, patch }) => {
              window.__pushState({
                ...window.__state,
                rev: window.__state.rev + 1,
                hosts: window.__state.hosts.map((host) => (host.id === hostId ? { ...host, ...patch } : host)),
              })
            },
            { hostId, patch },
          )
        const logLine = (seq, message) => ({
          seq,
          at: new Date().toISOString(),
          level: 'info',
          phase: 'start',
          message,
        })
        await openManage()

        // Restart: the connect window carries the restart title, progress and log.
        await page.click('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-restart"]')
        await page.waitForFunction(() => window.__calls.some((call) => /\/restart$/.test(call.url)), { timeout: 5000 })
        await patchHost('h_a', {
          status: 'connecting',
          phase: 'start',
          progress: { code: 'restarting-remote', params: { pid: 1, port: 1 } },
          logs: [logLine(1, 'restart requested (pid=1)')],
        })
        await page.waitForSelector('[data-testid="manage-live"] [data-progress="restarting-remote"]', {
          timeout: 5000,
        })
        assert.match(
          await page.$eval('[data-testid="manage-live"]', (node) => node.textContent),
          /正在重启「host-a」的远端 DSH/,
          'the restart opens the connect body with its own title',
        )
        assert.match(
          await page.$eval('[data-testid="connect-log"]', (node) => node.textContent),
          /restart requested \(pid=1\)/,
          'the restart log is printed in the connect window',
        )
        await patchHost('h_a', { status: 'connected', phase: 'ready', progress: null })
        await page.waitForFunction(() => !document.querySelector('[data-testid="connect-log"]'), { timeout: 5000 })
        await page.waitForSelector('[data-testid="host-list"]', { timeout: 5000 })

        // Reconnect: a host that is not the window's target still gets its own connect window.
        await page.click('[data-testid="host-card"][data-host-id="h_v6"] [data-testid="host-reconnect"]')
        await page.waitForFunction(() => window.__calls.some((call) => /\/reconnect$/.test(call.url)), {
          timeout: 5000,
        })
        await patchHost('h_v6', {
          status: 'connecting',
          phase: 'ssh',
          progress: { code: 'ssh-connecting' },
          logs: [logLine(2, 'reconnect requested')],
        })
        await page.waitForSelector('[data-testid="manage-live"] [data-progress="ssh-connecting"]', {
          timeout: 5000,
        })
        assert.match(
          await page.$eval('[data-testid="manage-live"]', (node) => node.textContent),
          /正在连接「ipv6-host」/,
          'the connect window names the reconnecting host, not the one filling the window',
        )
        assert.match(await page.$eval('[data-testid="connect-log"]', (node) => node.textContent), /reconnect requested/)

        // Put the harness hosts back for the scenarios that follow.
        await patchHost('h_v6', { status: 'disconnected', phase: null, progress: null, logs: [] })
        await page.waitForSelector('[data-testid="host-list"]', { timeout: 5000 })
        await closeManage()
      })

      await t.test('Tab stays inside the dialog', async () => {
        await openWizard('add')
        const inside = await page.evaluate(async () => {
          const wizard = document.querySelector('[data-testid="host-wizard"]')
          for (let index = 0; index < 25; index += 1) {
            const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
            document.activeElement.dispatchEvent(event)
            if (!wizard.contains(document.activeElement))
              return { escapedAt: index, tag: document.activeElement.tagName }
          }
          return { escapedAt: -1 }
        })
        assert.equal(inside.escapedAt, -1, `focus escaped the dialog: ${JSON.stringify(inside)}`)
        await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="host-wizard"]'))
      })

      await t.test('the edit form reads port/username instead of parsing the masked address', async () => {
        await openWizard('edit', 'h_a')
        const modern = await page.evaluate(() => ({
          port: document.querySelector('[data-testid="wizard-port"]').value,
          username: document.querySelector('[data-testid="wizard-username"]').value,
        }))
        assert.deepEqual(modern, { port: '2222', username: 'ubuntu' })
        await page.click('[data-testid="wizard-save"]')
        await page.waitForFunction(() => !document.querySelector('[data-testid="host-wizard"]'), { timeout: 5000 })
        const saved = await page.evaluate(() => window.__savedHost)
        assert.equal(saved.port, 2222, 'saving an untouched edit must keep the default port 2222')
        assert.equal(saved.username, 'ubuntu')

        await openWizard('edit', 'h_v6')
        const v6 = await page.evaluate(() => document.querySelector('[data-testid="wizard-port"]').value)
        assert.equal(v6, '2222', 'a bare IPv6 host must not turn into port 1')
        await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="host-wizard"]'))
      })

      await t.test('a validation error lands on its field and takes focus', async () => {
        await openWizard('add')
        await page.type('[data-testid="wizard-address"]', 'host-new')
        await page.click('[data-testid="wizard-name"]')
        await page.keyboard.down('Control')
        await page.keyboard.press('A')
        await page.keyboard.up('Control')
        await page.keyboard.press('Backspace')
        await page.click('[data-testid="wizard-save"]')
        await page.waitForSelector('[data-testid="wizard-name"][aria-invalid="true"]', { timeout: 5000 })
        const field = await page.evaluate(() => ({
          focused: document.activeElement === document.querySelector('[data-testid="wizard-name"]'),
          describedBy: document.querySelector('[data-testid="wizard-name"]').getAttribute('aria-describedby'),
          error: document.querySelector('#wizard-name-error')?.textContent ?? '',
        }))
        assert.equal(field.focused, true)
        assert.equal(field.describedBy, 'wizard-name-error')
        assert.notEqual(field.error, '')
        // Correcting the field clears the error.
        await page.type('[data-testid="wizard-name"]', 'host-new')
        await page.waitForFunction(
          () => document.querySelector('[data-testid="wizard-name"]').getAttribute('aria-invalid') === null,
          { timeout: 5000 },
        )
        await escape()
        await page.waitForFunction(() => !document.querySelector('[data-testid="host-wizard"]'))
      })

      await t.test('the wizard saves a password by default and can turn it off', async () => {
        await openWizard('add')
        await page.type('[data-testid="wizard-address"]', 'host-password')
        await page.select('[data-testid="wizard-auth"]', 'password')
        await page.waitForSelector('[data-testid="wizard-password"]', { visible: true, timeout: 5000 })
        await page.type('[data-testid="wizard-password"]', 'secret')
        const remembered = await page.evaluate(
          () => document.querySelector('[data-testid="wizard-password-remember"]')?.checked,
        )
        assert.equal(remembered, true, 'the wizard remembers a typed password by default')
        await page.click('[data-testid="wizard-save"]')
        await page.waitForFunction(() => !document.querySelector('[data-testid="host-wizard"]'), { timeout: 5000 })
        const stored = await page.evaluate(
          () => window.__calls.filter((call) => /\/password$/.test(call.url)).at(-1) ?? null,
        )
        assert.ok(stored, 'the plain save action also stores the password in the credential store')
        assert.equal(stored.body.password, 'secret')
        assert.equal(stored.body.clear, false)

        // The connect action hands the password and the decision to the connection instead.
        await page.evaluate(() => {
          window.__calls = []
        })
        await openWizard('add')
        await page.type('[data-testid="wizard-address"]', 'host-password-2')
        await page.select('[data-testid="wizard-auth"]', 'password')
        await page.waitForSelector('[data-testid="wizard-password"]', { visible: true, timeout: 5000 })
        await page.type('[data-testid="wizard-password"]', 'secret2')
        await page.click('[data-testid="wizard-password-remember"]')
        await page.click('[data-testid="wizard-connect"]')
        await page.waitForFunction(() => window.__calls.some((call) => /\/connect$/.test(call.url)), { timeout: 5000 })
        const connect = await page.evaluate(() => window.__calls.filter((call) => /\/connect$/.test(call.url)).at(-1))
        assert.equal(connect.body.password, 'secret2')
        assert.equal(connect.body.rememberPassword, false)
        await page.waitForFunction(() => !document.querySelector('[data-testid="host-wizard"]'), { timeout: 5000 })
      })

      await t.test('a saved password is tried first and a double Enter posts once', async () => {
        await openManage()
        await page.evaluate(() => {
          window.__connectMode = 'auth-error'
          window.__connectAttempts = 0
        })
        const before = await page.evaluate(() => window.__connectAttempts)
        await page.click('[data-testid="host-card"][data-host-id="h_pw"] [data-testid="host-open"]')
        await page.waitForSelector('[data-testid="password-prompt"]', { visible: true, timeout: 5000 })
        const attempts = await page.evaluate(() => window.__connectAttempts)
        assert.equal(attempts, before + 1, 'the saved password is tried first, without a prompt')
        // The first attempt carried no password.
        const firstConnect = await page.evaluate(() =>
          window.__calls.filter((call) => /\/connect$/.test(call.url)).at(-1),
        )
        assert.deepEqual(firstConnect.body, {})

        await page.evaluate(() => {
          window.__connectMode = 'ok'
          window.__connectAttempts = 0
        })
        await page.type('[data-testid="password-input"]', 'secret')
        const rememberDefault = await page.evaluate(
          () => document.querySelector('[data-testid="password-remember"] input')?.checked,
        )
        assert.equal(rememberDefault, true, 'remember is on by default')
        await page.evaluate(() => {
          const input = document.querySelector('[data-testid="password-input"]')
          // Two Enter events in the same tick: the synchronous guard must let one request out.
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        })
        await page.waitForFunction(() => window.__connectAttempts >= 1, { timeout: 5000 })
        await new Promise((resolve) => setTimeout(resolve, 400))
        const submitted = await page.evaluate(() => ({
          attempts: window.__connectAttempts,
          last: window.__calls.filter((call) => /\/connect$/.test(call.url)).at(-1),
          prompt: Boolean(document.querySelector('[data-testid="password-prompt"]')),
        }))
        assert.equal(submitted.attempts, 1, 'a double Enter must not post twice')
        assert.deepEqual(submitted.last.body, { password: 'secret', rememberPassword: true })
        assert.equal(submitted.prompt, false)
        await closeManage()
      })

      await t.test('unchecking remember sends a connection-only password', async () => {
        await openManage()
        await page.evaluate(() => {
          window.__connectMode = 'auth-error'
          window.__connectAttempts = 0
        })
        await page.click('[data-testid="host-card"][data-host-id="h_pw"] [data-testid="host-open"]')
        await page.waitForSelector('[data-testid="password-prompt"]', { visible: true, timeout: 5000 })
        await page.evaluate(() => {
          window.__connectMode = 'ok'
        })
        await page.type('[data-testid="password-input"]', 'secret')
        await page.click('[data-testid="password-remember"] input')
        await page.click('[data-testid="password-submit"]')
        await page.waitForFunction(
          () => window.__calls.some((call) => /\/connect$/.test(call.url) && call.body?.password === 'secret'),
          { timeout: 5000 },
        )
        const last = await page.evaluate(() => window.__calls.filter((call) => /\/connect$/.test(call.url)).at(-1))
        assert.deepEqual(last.body, { password: 'secret', rememberPassword: false })
        await page.waitForFunction(() => !document.querySelector('[data-testid="password-prompt"]'), {
          timeout: 5000,
        })
        await closeManage()
      })

      await t.test('a busy dialog ignores its header close button', async () => {
        await openManage()
        await page.evaluate(() => {
          window.__connectMode = 'auth-error'
          window.__connectAttempts = 0
        })
        await page.click('[data-testid="host-card"][data-host-id="h_pw"] [data-testid="host-open"]')
        await page.waitForSelector('[data-testid="password-prompt"]', { visible: true, timeout: 5000 })
        await page.evaluate(() => {
          window.__connectMode = 'slow'
        })
        await page.type('[data-testid="password-input"]', 'secret')
        await page.click('[data-testid="password-submit"]')
        await page.waitForFunction(
          () => document.querySelector('[data-testid="password-prompt"]')?.getAttribute('aria-busy') === 'true',
          { timeout: 5000 },
        )
        const closeButton = await page.$('[data-testid="password-prompt"] .drg-modal-head .drg-iconbtn')
        assert.ok(closeButton, 'the prompt has a header close control')
        assert.equal(await closeButton.evaluate((node) => node.disabled), true)
        await closeButton.click()
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="password-prompt"]'))),
          true,
          'the × cannot close a dialog whose request is still running',
        )
        await page.waitForFunction(() => !document.querySelector('[data-testid="password-prompt"]'), {
          timeout: 5000,
        })
        await page.evaluate(() => {
          window.__connectMode = 'ok'
        })
        await closeManage()
      })

      await t.test('the settings footer cancel follows the busy save', async () => {
        await openManage()
        await page.click('[data-testid="host-settings"]')
        await page.waitForSelector('[data-testid="settings"]', { timeout: 5000 })
        await page.evaluate(() => {
          window.__settingsMode = 'slow'
        })
        await page.click('[data-testid="settings-save"]')
        await page.waitForFunction(
          () => document.querySelector('[data-testid="settings"]')?.getAttribute('aria-busy') === 'true',
          { timeout: 5000 },
        )
        const cancel = await page.$('[data-testid="settings-cancel"]')
        assert.ok(cancel)
        assert.equal(await cancel.evaluate((node) => node.disabled), true)
        await cancel.click()
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="settings"]'))),
          true,
          'a save in flight cannot be cancelled from the footer',
        )
        await page.waitForFunction(() => !document.querySelector('[data-testid="settings"]'), { timeout: 5000 })
        await page.evaluate(() => {
          window.__settingsMode = 'ok'
        })
        await closeManage()
      })

      await t.test('a dropped SSE stream shows polling and reconnects on demand', async () => {
        await openManage()
        await page.evaluate(() => window.__failStream())
        await page.waitForSelector('[data-testid="live-reconnect"]', { visible: true, timeout: 5000 })
        const banner = await page.evaluate(
          () => document.querySelector('[data-testid="live-reconnect"]').closest('.drg-live-banner')?.textContent ?? '',
        )
        assert.match(banner, /实时连接已断开/)
        assert.match(banner, /正在轮询/)
        // The degradation is also visible outside the management window (the reviewer saw the
        // banner only there): the shell toast must carry it over the local page / a carrier.
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('[data-testid="toast-region"] .drg-toast')].some((node) =>
              node.textContent.includes('实时连接已断开'),
            ),
          { timeout: 5000 },
        )
        const streamsBefore = await page.evaluate(() => window.__streams.length)
        await page.click('[data-testid="live-reconnect"]')
        await page.waitForFunction((count) => window.__streams.length > count, { timeout: 5000 }, streamsBefore)
        // A reconnect that has not opened yet must NOT clear the banner (review blocker 2).
        await new Promise((resolve) => setTimeout(resolve, 150))
        const duringRetry = await page.evaluate(() => {
          const bannerNode = document.querySelector('[data-testid="live-reconnect"]')
          return {
            banner: Boolean(bannerNode),
            text: bannerNode?.closest('.drg-live-banner')?.textContent ?? '',
          }
        })
        assert.equal(duringRetry.banner, true, 'the banner stays until the stream actually opens')
        assert.match(duringRetry.text, /正在重新连接/)
        await page.evaluate(() => window.__pushState(Object.assign({}, window.__state, { rev: 2 })))
        await page.waitForFunction(() => !document.querySelector('[data-testid="live-reconnect"]'), { timeout: 5000 })
        await closeManage()
      })

      await t.test('an out-of-order frame and a slow GET never regress the UI', async () => {
        await openManage()
        await page.evaluate(() => {
          const base = window.__state
          const newer = {
            ...base,
            rev: 6,
            hosts: base.hosts.map((host, index) => (index === 0 ? { ...host, status: 'connected' } : host)),
          }
          const older = {
            ...newer,
            rev: 2,
            hosts: newer.hosts.map((host, index) => (index === 0 ? { ...host, status: 'disconnected' } : host)),
          }
          window.__staleFrames = { newer, older }
          window.__pushState(newer)
        })
        try {
          await page.waitForFunction(
            () => (document.querySelector('.drg-summary')?.textContent ?? '').includes('已连接 3'),
            { timeout: 5000 },
          )
        } catch (error) {
          const debug = await page.evaluate(() => ({
            summary: document.querySelector('.drg-summary')?.textContent,
            manage: Boolean(document.querySelector('[data-testid="manage-window"]')),
            stateRev: window.__state.rev,
            streams: window.__streams.map((stream) => ({ closed: stream.closed, hasOnOpen: typeof stream.onopen })),
          }))
          throw new Error(`newer frame did not paint: ${JSON.stringify(debug)} (${error.message})`)
        }
        // A stale SSE frame must be ignored.
        await page.evaluate(() => window.__pushState(window.__staleFrames.older))
        await new Promise((resolve) => setTimeout(resolve, 250))
        let painted = await page.evaluate(() => ({
          summary: document.querySelector('.drg-summary')?.textContent ?? '',
          status: document.querySelector('[data-host-id="h_a"]')?.getAttribute('data-status') ?? '',
        }))
        assert.match(painted.summary, /已连接 3/)
        assert.equal(painted.status, 'connected')

        // A slow GET /state that resolves *after* a newer frame is stale as well: request a
        // refresh while the response is held, then push the newer frame in between.
        await page.evaluate(() => {
          window.__slowState = window.__staleFrames.older
          window.__harness.face.panelStore.requestIntent({ kind: 'manage' })
          window.__pushState(window.__staleFrames.newer)
        })
        await new Promise((resolve) => setTimeout(resolve, 700))
        painted = await page.evaluate(() => ({
          summary: document.querySelector('.drg-summary')?.textContent ?? '',
          status: document.querySelector('[data-host-id="h_a"]')?.getAttribute('data-status') ?? '',
        }))
        assert.match(painted.summary, /已连接 3/, 'a late older GET response must not repaint the list')
        assert.equal(painted.status, 'connected')

        // A Host restart / plugin reload starts a new publish instance with a fresh rev: its
        // frames must be accepted even though rev went backwards (review feedback: otherwise the
        // Client freezes on the old high-water mark forever).
        await page.evaluate(() => {
          const base = window.__staleFrames.newer
          window.__pushState({
            ...base,
            instance: 'host-2',
            rev: 1,
            hosts: base.hosts.map((host, index) => (index === 0 ? { ...host, status: 'disconnected' } : host)),
          })
        })
        await page.waitForFunction(
          () => (document.querySelector('.drg-summary')?.textContent ?? '').includes('已连接 2'),
          { timeout: 5000 },
        )
        assert.equal(
          await page.evaluate(() => document.querySelector('[data-host-id="h_a"]')?.getAttribute('data-status')),
          'disconnected',
          'a frame from the new Host instance is accepted despite its lower rev',
        )
        // Put the host back for the carrier scenarios that follow.
        await page.evaluate(() => {
          const base = window.__staleFrames.newer
          window.__pushState({
            ...base,
            instance: 'host-2',
            rev: 2,
            hosts: base.hosts.map((host, index) => (index === 0 ? { ...host, status: 'connected' } : host)),
          })
        })
        await page.waitForFunction(
          () => (document.querySelector('.drg-summary')?.textContent ?? '').includes('已连接 3'),
          { timeout: 5000 },
        )
        await closeManage()
      })

      await t.test('the web download sink attaches the carrier host id', async () => {
        await page.evaluate(() => window.__harness.face.panelStore.requestIntent({ kind: 'open', hostId: 'h_a' }))
        await page.waitForFunction(
          () => {
            const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
            return Boolean(frame && frame.contentDocument && frame.contentDocument.getElementById('root'))
          },
          { timeout: 15_000 },
        )
        const frame = await page.$('#dsh-remote-go-overlay-h_a iframe')
        const frameHandle = await frame.contentFrame()
        await page.waitForFunction(
          () => {
            const node = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
            return Boolean(node && node.contentDocument && node.contentDocument.querySelector('#drg-host-row'))
          },
          { timeout: 5000 },
        )
        // The guest row shows Local + its own host only: it must not paint another host's exit
        // control (review blocker 1).
        const rowTargets = await frameHandle.evaluate(() =>
          [...document.querySelectorAll('#drg-host-row .drg-hr-item')]
            .map((node) => node.getAttribute('data-target'))
            .filter(Boolean),
        )
        assert.deepEqual(rowTargets, ['local', 'h_a'])
        const disconnectsBefore = await page.evaluate(
          () => window.__calls.filter((call) => /\/disconnect$/.test(call.url)).length,
        )
        await frameHandle.evaluate(() => window.__drgBridgeSink({ action: 'disconnect', hostId: 'h_victim' }))
        await new Promise((resolve) => setTimeout(resolve, 200))
        const disconnectsAfter = await page.evaluate(
          () => window.__calls.filter((call) => /\/disconnect$/.test(call.url)).length,
        )
        assert.equal(disconnectsAfter, disconnectsBefore, 'a guest cannot disconnect another host')
        assert.equal(await page.evaluate(() => window.__harness.plugin.carrier.shown()), 'h_a')
        await frameHandle.evaluate(() => window.emitDownload())
        await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 5000 })
        let downloads = await page.evaluate(() => window.__downloads)
        assert.equal(downloads.at(-1).kind, 'file')
        assert.equal(downloads.at(-1).hostId, 'h_a', 'the carrier host owns the download intent')
        // A crafted hostId from the guest is overwritten, and a foreign target is refused.
        await frameHandle.evaluate(() => window.emitDownload({ hostId: 'h_victim' }))
        await page.waitForFunction((count) => window.__downloads.length > count, { timeout: 5000 }, downloads.length)
        downloads = await page.evaluate(() => window.__downloads)
        assert.equal(downloads.at(-1).hostId, 'h_a')
        await frameHandle.evaluate(() => window.emitTarget('h_victim'))
        await new Promise((resolve) => setTimeout(resolve, 200))
        assert.equal(await page.evaluate(() => window.__harness.plugin.carrier.shown()), 'h_a')
        await page.evaluate(() => window.__harness.plugin.carrier.hide())
        await page.waitForFunction(() => window.__harness.plugin.carrier.shown() === null, { timeout: 5000 })
      })

      await t.test('a web carrier whose document is not DSH shows an alert with a way back', async () => {
        await page.evaluate(() => window.__harness.face.panelStore.requestIntent({ kind: 'open', hostId: 'h_bad' }))
        await page.waitForFunction(
          () => {
            const layer = document.querySelector('#dsh-remote-go-overlay-h_bad [data-testid="remote-overlay-error"]')
            return Boolean(layer && layer.style.display === 'flex')
          },
          { timeout: 15_000 },
        )
        const failure = await page.evaluate(() => {
          const layer = document.querySelector('#dsh-remote-go-overlay-h_bad [data-testid="remote-overlay-error"]')
          const button = layer.querySelector('[data-testid="remote-overlay-back-local"]')
          return { role: layer.getAttribute('role'), label: button?.textContent ?? '' }
        })
        assert.equal(failure.role, 'alert')
        assert.equal(failure.label, '返回本地')
        await page.click('#dsh-remote-go-overlay-h_bad [data-testid="remote-overlay-back-local"]')
        await page.waitForFunction(() => window.__harness.plugin.carrier.shown() === null, { timeout: 5000 })
      })

      await t.test('a frame that never loads still gets the failure layer and a way back', async () => {
        await page.evaluate(() => window.__harness.face.panelStore.requestIntent({ kind: 'open', hostId: 'h_hang' }))
        await page.waitForFunction(
          () => {
            const layer = document.querySelector('#dsh-remote-go-overlay-h_hang [data-testid="remote-overlay-error"]')
            return Boolean(layer && layer.style.display === 'flex')
          },
          { timeout: 35_000 },
        )
        const layer = await page.evaluate(() => {
          const node = document.querySelector('#dsh-remote-go-overlay-h_hang [data-testid="remote-overlay-error"]')
          return {
            role: node.getAttribute('role'),
            button: Boolean(node.querySelector('[data-testid="remote-overlay-back-local"]')),
          }
        })
        assert.equal(layer.role, 'alert')
        assert.equal(layer.button, true)
        await page.click('#dsh-remote-go-overlay-h_hang [data-testid="remote-overlay-back-local"]')
        await page.waitForFunction(() => window.__harness.plugin.carrier.shown() === null, { timeout: 5000 })
      })

      await t.test('the connect log arrives on its own channel and never renders a line twice', async () => {
        const patchHost = (hostId, patch) =>
          page.evaluate(
            ({ hostId, patch }) => {
              window.__pushState({
                ...window.__state,
                rev: window.__state.rev + 1,
                hosts: window.__state.hosts.map((host) => (host.id === hostId ? { ...host, ...patch } : host)),
              })
            },
            { hostId, patch },
          )
        const line = (seq, message) => ({
          seq,
          at: new Date().toISOString(),
          level: 'info',
          phase: 'ssh',
          message,
        })
        const renderedLines = () =>
          page.evaluate(() => document.querySelectorAll('[data-testid="connect-log-line"]').length)
        await openManage()
        await page.click('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-restart"]')
        await page.waitForFunction(() => window.__calls.some((call) => /\/restart$/.test(call.url)), { timeout: 5000 })
        await patchHost('h_a', { status: 'connecting', phase: 'ssh', progress: { code: 'ssh-connecting' }, logs: [] })
        await page.waitForSelector('[data-testid="connect-log"]', { timeout: 5000 })
        // B1: the log channel is a second EventSource with its own path, opened only while a
        // connect window exists (it did not exist before this host started connecting).
        const urls = await page.evaluate(() =>
          window.__logStreams().map((stream) => ({ url: stream.url, closed: stream.closed })),
        )
        assert.ok(urls.length >= 1, 'the log channel opens with the connect window')
        assert.equal(urls.at(-1).url, '/dsh-remote-go/api/events/logs')
        assert.equal(urls.at(-1).closed, false)
        // The page may have moved to another publish generation in an earlier scenario: the frame
        // must name the generation the client is on, or it is (correctly) dropped as foreign.
        const instance = await page.evaluate(() => window.__state.instance)
        const resetFrame = {
          hostId: 'h_a',
          instance,
          attempt: 0,
          seq: 3,
          reset: true,
          visible: true,
          entries: [line(1, 'first row'), line(2, 'second row'), line(3, 'third row')],
        }

        // B2: rows come from `log` frames. The window is freshly opened, so a state refresh may
        // still be in flight; a real Host answers a reconnect with a `reset`, and the harness has
        // no server behind the fake stream, so the frame is re-sent until it lands.
        try {
          await page.waitForFunction(
            (frame) => {
              window.__pushLog(frame)
              return document.querySelectorAll('[data-testid="connect-log-line"]').length === 3
            },
            { timeout: 5000 },
            resetFrame,
          )
        } catch (error) {
          const diag = await page.evaluate((frame) => {
            window.__pushLog(frame)
            return {
              lines: document.querySelectorAll('[data-testid="connect-log-line"]').length,
              text: document.querySelector('[data-testid="connect-log"]')?.textContent ?? '',
              streams: window.__logStreams().map((stream) => ({
                closed: stream.closed,
                listeners: Object.keys(stream.listeners),
                logHandlers: (stream.listeners.log || []).length,
              })),
              hosts: window.__state.hosts.map((host) => ({ id: host.id, status: host.status, logs: host.logs.length })),
            }
          }, resetFrame)
          throw new Error(`the log frame did not paint: ${JSON.stringify(diag)} (${error.message})`)
        }
        assert.equal(
          await page.evaluate(() => window.__logStreams().filter((stream) => !stream.closed).length),
          1,
          'exactly one log stream is open for the window',
        )
        // ...a state frame (whose `logs` is empty in v2.12) does not wipe or duplicate them...
        await patchHost('h_a', { logs: [] })
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(await renderedLines(), 3, 'a state frame leaves the merged rows alone')
        // ...and a frame that repeats a rendered `seq` changes nothing.
        await page.evaluate(
          ({ entries, instance }) =>
            window.__pushLog({ hostId: 'h_a', instance, attempt: 0, seq: 3, visible: true, entries }),
          { entries: [line(3, 'third row')], instance },
        )
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(await renderedLines(), 3, 'a repeated seq is not rendered twice')
        // B3: a reset for a new attempt rebuilds the panel from the frame alone.
        await page.evaluate(
          ({ entries, instance }) =>
            window.__pushLog({ hostId: 'h_a', instance, attempt: 1, seq: 1, reset: true, visible: true, entries }),
          { entries: [line(1, 'retry row')], instance },
        )
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="connect-log-line"]').length === 1, {
          timeout: 5000,
        })
        assert.match(
          await page.$eval('[data-testid="connect-log"]', (node) => node.textContent),
          /retry row/,
          'the rebuilt panel shows the new attempt only',
        )
        await patchHost('h_a', { status: 'connected', phase: 'ready', progress: null, logs: [] })
        await page.waitForFunction(() => !document.querySelector('[data-testid="connect-log"]'), { timeout: 5000 })
        await closeManage()
      })

      await t.test('a missing log channel falls back to the snapshot without degrading the banner', async () => {
        const line = { seq: 7, at: new Date().toISOString(), level: 'info', phase: 'ssh', message: 'from the snapshot' }
        const patchHost = (hostId, patch) =>
          page.evaluate(
            ({ hostId, patch }) => {
              window.__pushState({
                ...window.__state,
                rev: window.__state.rev + 1,
                hosts: window.__state.hosts.map((host) => (host.id === hostId ? { ...host, ...patch } : host)),
              })
            },
            { hostId, patch },
          )
        await openManage()
        await page.click('[data-testid="host-card"][data-host-id="h_a"] [data-testid="host-restart"]')
        await page.waitForFunction(() => window.__calls.some((call) => /\/restart$/.test(call.url)), { timeout: 5000 })
        // A failed connection is the status whose connect window carries a retry control, and its
        // retry is a real user action that ends in `GET /state`.
        await patchHost('h_a', {
          status: 'error',
          phase: 'ssh',
          progress: null,
          error: {
            code: 'network',
            retryable: true,
            title: { zh: '连接失败', en: 'Connect failed' },
            detail: { zh: '网络不可达。', en: 'The network is unreachable.' },
            nextSteps: [],
          },
          logs: [],
        })
        await page.waitForSelector('[data-testid="connect-log"]', { timeout: 5000 })
        await page.waitForSelector('[data-testid="error-retry"]', { timeout: 5000 })
        // The log channel dies (here: a permanent refusal, the shape an older Host answers). It
        // must not raise the degraded banner: that banner belongs to the state channel.
        await page.evaluate(() => window.__failStream('/events/logs'))
        await new Promise((resolve) => setTimeout(resolve, 300))
        assert.equal(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="live-reconnect"]'))),
          false,
          'a dead log channel never shows the state-channel banner',
        )
        // `GET /state` still carries the tail, and the retry's refresh merges it (R2).
        await page.evaluate(
          ({ entry }) => {
            window.__state = {
              ...window.__state,
              rev: window.__state.rev + 1,
              hosts: window.__state.hosts.map((host) =>
                host.id === 'h_a' ? { ...host, logs: [entry], logAttempt: 1, logSeq: entry.seq } : host,
              ),
            }
          },
          { entry: line },
        )
        await page.click('[data-testid="error-retry"]')
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('[data-testid="connect-log-line"]')].some((node) =>
              node.textContent.includes('from the snapshot'),
            ),
          { timeout: 5000 },
        )
        assert.equal(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="live-reconnect"]'))),
          false,
          'and the state channel stayed live',
        )
        await patchHost('h_a', { status: 'connected', phase: 'ready', progress: null, logs: [] })
        await page.waitForFunction(() => !document.querySelector('[data-testid="connect-log"]'), { timeout: 5000 })
        await closeManage()
      })

      await t.test('the page logged no errors', async () => {
        const ignored = errors.filter((text) => !/Failed to load resource/.test(text))
        assert.deepEqual(ignored, [])
      })
    } finally {
      if (browser !== null) await browser.close().catch(() => {})
      if (server !== null) await close(server)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  },
)

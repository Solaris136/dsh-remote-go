import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTempRoot, resolveBrowser, resolveDshCli, skipOrFail, stopChild, tail, waitFor } from './harness-support.js'
import { createRemoteProxy } from '../../src/remote-proxy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')

const HARNESS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>carrier harness</title></head>
  <body>
    <div id="local-shell" style="font:14px sans-serif;padding:16px">local shell</div>
    <script>window.__ModuleLoader__ = { load(declaration) { window.__declaration = declaration } }</script>
    <script src="/client.js"></script>
    <script>
      (() => {
        const noop = () => {}
        const React = {
          createElement: noop,
          Fragment: 'fragment',
          useState: (value) => [value, noop],
          useEffect: noop,
          useLayoutEffect: noop,
          useRef: (value) => ({ current: value }),
          useCallback: (fn) => fn,
          useMemo: (fn) => fn(),
        }
        const plugin = window.__declaration.factory(() => React)
        const captured = {}
        const ctx = {
          locale: { register() {}, bind() { return (key) => key } },
          effect(fn) {
            const dispose = fn()
            if (typeof dispose === 'function') ctx.disposers.push(dispose)
            return () => {}
          },
          slots: {
            inject(_key, callback) {
              captured.overlay = callback()
            },
            register(options) {
              captured.options = options
              return () => {}
            },
          },
          get() {
            return undefined
          },
          disposers: [],
        }
        plugin.apply(ctx)
        window.__harness = { plugin, captured }
      })()
    </script>
  </body>
</html>`

/** A second page that mounts the real overlay host (real React) over a stubbed plugin API. */
function overlayHarness(openWebUrl) {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>overlay harness</title></head>
  <body>
    <div id="local-shell" style="font:14px sans-serif;padding:16px">local shell</div>
    <script>
      window.__api = {
        state: {
          hostVersion: '0.2.2-rc.3',
          targetVersion: '0.2.2-rc.3',
          activeHostId: 'h_a',
          firstRun: false,
          settings: {},
          hosts: [
            {
              id: 'h_a',
              name: 'Test remote',
              address: 'test-host',
              addressMasked: 'test-host',
              authType: 'key',
              authKeyPath: null,
              passwordSaved: false,
              passwordStorageAvailable: false,
              jumpHost: null,
              status: 'connected',
              phase: 'ready',
              progress: null,
              error: null,
              warning: null,
              fingerprint: null,
              conflict: null,
              logs: [],
              remote: { version: '0.2.2-rc.3', uiReady: true, localPort: 1, port: 1, pid: 1, dshHome: '/home/test/.dsh', profile: 'web', bootstrapLevel: 'npx', nodeVersion: '24.9.0', nodeSource: 'managed', startedAt: null },
              keepAlive: 'keep',
              idleMinutes: 15,
              autoReconnect: true,
              hostKeyPolicy: 'first-use',
              targetVersion: '0.2.2-rc.3',
              versionParity: { status: 'same', local: '0.2.2-rc.3', remote: '0.2.2-rc.3', same: true, message: { zh: '', en: '' } },
              lastOpenedAt: null,
              createdAt: '2026-11-16T00:00:00.000Z',
              updatedAt: '2026-11-16T00:00:00.000Z',
            },
          ],
        },
        open: { url: 'http://127.0.0.1:1/?token=stub', webUrl: ${JSON.stringify(openWebUrl)} },
      }
      const jsonResponse = (payload) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async json() {
          return payload
        },
      })
      const pluginApi = (url, init) => {
        if (url === '/dsh-remote-go/api/state') return jsonResponse({ ok: true, state: window.__api.state })
        if (url === '/dsh-remote-go/api/hosts/h_a/open') return jsonResponse({ ok: true, ...window.__api.open })
        if (url.startsWith('/dsh-remote-go/api/')) return jsonResponse({ ok: true })
        return null
      }
      const harnessFetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        const answer = pluginApi(url, init)
        if (answer !== null) return Promise.resolve(answer)
        return Promise.reject(new Error('unexpected fetch: ' + url))
      }
      window.fetch = harnessFetch
      window.EventSource = class {
        addEventListener() {}
        close() {}
      }
    </script>
    <script src="/react.js"></script>
    <script>window.__ModuleLoader__ = { load(declaration) { window.__declaration = declaration } }</script>
    <script src="/client.js"></script>
    <script>
      (() => {
        const plugin = window.__declaration.factory(() => window.React)
        const ctx = {
          locale: { register() {}, bind() { return (key) => key } },
          effect(fn) {
            const dispose = fn()
            return () => {}
          },
          slots: {
            inject() {},
            register() {
              return () => {}
            },
          },
          get() {
            return undefined
          },
        }
        plugin.apply(ctx)
        const mount = document.createElement('div')
        document.body.appendChild(mount)
        window.ReactDOM.createRoot(mount).render(
          window.React.createElement(plugin.components.PluginOverlay, {
            initialState: window.__api.state,
            pickDirectory: async () => null,
          }),
        )
        window.__overlay = { plugin }
      })()
    </script>
  </body>
</html>`
}

/**
 * A page that stands in for the desktop shell's window, so the **desktop** carrier runs in a real
 * browser: the caption band and its menubar (the preload's fixed host reading
 * `--dsh-windows-menu-start`), the `window.dshDesktop` guest bridge, and a `<webview>` seat. The
 * seat is an iframe whose `executeJavaScript` evaluates in the guest, which is the one call the
 * plugin makes on it; events the plugin listens for are dispatched like the shell's own.
 */
function desktopHarness(guestUrl) {
  return `<!doctype html>
<html lang="zh" data-windows-titlebar style="--dsh-windows-titlebar-height:40px">
  <head>
    <meta charset="utf-8" /><title>desktop harness</title>
    <style>
      /* The shell's caption menubar: a fixed host at --dsh-windows-menu-start (default 48px),
         which DSH's sidebar raises to 84px from its own collapsed rule. */
      #caption-menubar { position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px); z-index: 1100;
        height: var(--dsh-windows-titlebar-height); display: flex; align-items: center; gap: 2px; }
      #caption-menubar button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px;
        background: transparent; font: 14px sans-serif; }
    </style>
  </head>
  <body>
    <div id="caption-menubar" data-windows-menu><button type="button">应用</button><button type="button">编辑</button></div>
    <div id="local-shell" style="font:14px sans-serif;padding:64px 16px 16px">local shell</div>
    <script>
      window.dshDesktop = {
        protocolVersion: 1,
        browser: {
          async acquire() {
            return { lease: 'lease-test', partition: 'persist:dsh-remote-go:test' }
          },
          async release() {},
        },
      }
      const nativeCreate = document.createElement.bind(document)
      document.createElement = (tag, options) => {
        if (String(tag).toLowerCase() !== 'webview') return nativeCreate(tag, options)
        const seat = nativeCreate('iframe')
        seat.dataset.guestSeat = '1'
        seat.addEventListener('load', () => {
          seat.dispatchEvent(new Event('dom-ready'))
          if (seat.__remote === true) seat.dispatchEvent(new Event('did-stop-loading'))
        })
        seat.loadURL = (url) => {
          seat.__remote = true
          seat.src = url
          return new Promise((resolve) => seat.addEventListener('load', () => resolve(true), { once: true }))
        }
        seat.executeJavaScript = (code) => {
          try {
            return Promise.resolve(seat.contentWindow.eval(code))
          } catch (error) {
            return Promise.reject(error)
          }
        }
        seat.reload = () => {
          seat.src = seat.src
        }
        // A webview fires dom-ready for its initial empty document too; an iframe does not fire
        // load for about:blank, so the harness reports that first document itself.
        setTimeout(() => seat.dispatchEvent(new Event('dom-ready')), 0)
        return seat
      }
    </script>
    <script>window.__ModuleLoader__ = { load(declaration) { window.__declaration = declaration } }</script>
    <script src="/client.js"></script>
    <script>
      (() => {
        const noop = () => {}
        const React = {
          createElement: noop,
          Fragment: 'fragment',
          useState: (value) => [value, noop],
          useEffect: noop,
          useLayoutEffect: noop,
          useRef: (value) => ({ current: value }),
          useCallback: (fn) => fn,
          useMemo: (fn) => fn(),
        }
        const plugin = window.__declaration.factory(() => React)
        const ctx = {
          locale: { register() {}, bind() { return (key) => key } },
          effect(fn) {
            const dispose = fn()
            if (typeof dispose === 'function') ctx.disposers.push(dispose)
            return () => {}
          },
          slots: { inject() {}, register() { return () => {} } },
          get() {
            return undefined
          },
          disposers: [],
        }
        plugin.apply(ctx)
        window.__harness = { plugin }
      })()
    </script>
    <script>window.__guestUrl = ${JSON.stringify(guestUrl)}</script>
  </body>
</html>`
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

function fakeWebServer() {
  const routes = new Map()
  const upgrades = new Map()
  return {
    routes,
    upgrades,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
}

async function startDshWeb(cli, home) {
  const child = spawn(cli.command, [...cli.args, '--profile', 'web', '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const logs = []
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web did not print a URL\n${tail(logs)}`)), 90_000)
    timer.unref?.()
    const onData = (chunk) => {
      logs.push(chunk.toString('utf8'))
      const match = /dsh web: (http:\/\/127\.0\.0\.1:(\d+))\/\?token=(\S+)/.exec(logs.join(''))
      if (match === null) return
      clearTimeout(timer)
      resolve({ port: Number(match[2]), token: match[3] })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${code}\n${tail(logs)}`))
    })
  })
  return { child, logs, ...started }
}

test(
  'the carriers frame a real remote DSH UI, its switcher works and the caption follows the rail',
  { timeout: 240_000 },
  async (t) => {
    const cli = resolveDshCli()
    const browserPath = resolveBrowser()
    if (cli === null) {
      skipOrFail(t, 'the DSH CLI is not available')
      return
    }
    if (browserPath === null) {
      skipOrFail(t, 'no Chromium browser is available for the carrier test')
      return
    }

    const home = makeTempRoot('dsh-remote-go-browser-carrier')
    let dsh = null
    let server = null
    let proxy = null
    let browser = null
    try {
      dsh = await startDshWeb(cli, home)
      const viewPath = `/dsh-remote-go/remote/h_a/?token=${encodeURIComponent(dsh.token)}`
      // The overlay page needs the real React runtime; bundle it once so hooks behave exactly as
      // in the shell (the first harness page deliberately uses a stub React and never renders).
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
      const webServer = fakeWebServer()
      const upstream = { localPort: dsh.port, remotePort: dsh.port }
      let localPort = 0
      server = http.createServer((req, res) => {
        if (proxy === null) {
          res.writeHead(503)
          res.end()
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(HARNESS_HTML)
          return
        }
        if (pathname === '/overlay') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(overlayHarness(viewPath))
          return
        }
        if (pathname === '/desktop') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          // The desktop guest only accepts a loopback URL: the proxy path is served by this same
          // origin, so the seat gets one and the remote UI still comes from the tunnel.
          res.end(desktopHarness(`http://127.0.0.1:${localPort}${viewPath}`))
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
        for (const [prefix, route] of webServer.routes) {
          // Mirror the real web server's prefix boundary (exact, or one slash deeper).
          if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
          route.handler(req, res)
          return
        }
        res.writeHead(404)
        res.end()
      })
      server.on('upgrade', (req, socket, head) => {
        if (proxy === null) {
          socket.destroy()
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const route = webServer.upgrades.get(pathname)
        if (route === undefined) {
          socket.destroy()
          return
        }
        route.handler(req, socket, head)
      })
      localPort = await listen(server)
      proxy = createRemoteProxy({
        webServer,
        getOrigin: () => `http://127.0.0.1:${localPort}`,
        resolveHost: (id) => (id === 'h_a' ? upstream : null),
        logger: { debug() {}, warn() {}, error() {} },
      })
      webServer.register({ kind: 'prefix', path: proxy.routePath, handler: (req, res) => proxy.handle(req, res) })
      proxy.sync(['h_a'])

      const puppeteer = (await import('puppeteer-core')).default
      browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: 'new',
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          // Hosted Ubuntu runners restrict unprivileged user namespaces, so Chromium
          // aborts with "No usable sandbox!" without this (web.e2e does the same).
          ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        ],
      })
      // The carrier test reads the clipboard back to prove the write landed; headless Chromium
      // grants that only through an explicit permission override.
      await browser
        .defaultBrowserContext()
        .overridePermissions(`http://127.0.0.1:${localPort}`, ['clipboard-read', 'clipboard-write'])
      const page = await browser.newPage()
      const errors = []
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('pageerror', (error) => errors.push(String(error?.message ?? error)))
      await page.goto(`http://127.0.0.1:${localPort}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await waitFor(page, () => Boolean(window.__harness), { timeout: 15_000 })
      assert.equal(
        await page.evaluate(() => window.__harness.plugin.carrier.surface()),
        'web',
        'a page without the desktop bridge must use the browser carrier',
      )

      const opened = await page.evaluate(
        ({ view }) => window.__harness.plugin.carrier.open({ hostId: 'h_a', url: view }),
        { view: `/dsh-remote-go/remote/h_a/?token=${encodeURIComponent(dsh.token)}` },
      )
      assert.equal(opened.ok, true)

      // The remote UI boots inside the frame and the host row is injected into its sidebar.
      await waitFor(
        page,
        () => {
          try {
            const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
            return Boolean(frame && frame.contentDocument && frame.contentDocument.querySelector('#drg-host-row'))
          } catch {
            return false
          }
        },
        { timeout: 45_000 },
      )
      await page.evaluate(() => {
        window.__harness.plugin.carrier.update({
          hosts: [{ id: 'h_a', name: 'Test remote', address: 'test-host', status: 'connected' }],
          current: 'h_a',
        })
      })
      await waitFor(
        page,
        () => {
          try {
            const row = document
              .querySelector('#dsh-remote-go-overlay-h_a iframe')
              .contentDocument.querySelector('#drg-host-row')
            return row && row.textContent.includes('Test remote')
          } catch {
            return false
          }
        },
        { timeout: 15_000 },
      )
      const frameState = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const doc = frame.contentDocument
        return {
          title: doc.title,
          base: doc.baseURI,
          rootChildren: doc.querySelector('#root')?.children.length ?? -1,
          rowName: doc.querySelector('#drg-host-row .drg-hr-name')?.textContent ?? '',
        }
      })
      assert.equal(frameState.title, 'DeepSeek Harness')
      assert.match(frameState.base, /\/dsh-remote-go\/remote\/h_a\/$/)
      assert.ok(frameState.rootChildren > 0, 'the real remote app must render')
      assert.equal(frameState.rowName, 'Test remote')

      // --- capability bridge, in a real browser against the real framed remote UI -------------
      // The frame declares what the remote page may use itself, and the injected bridge put the
      // capability shims and the per-host store in place.
      const capabilities = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const win = frame.contentWindow
        // The bridge opens its links on this document; record them instead of opening a tab.
        window.__opened = []
        window.__nativeOpen = window.open
        window.open = (...args) => {
          window.__opened.push(args)
          return { closed: false }
        }
        const doc = win.document
        const link = doc.createElement('a')
        link.id = 'drg-e2e-link'
        link.href = 'https://example.com/from-frame'
        link.textContent = 'external link'
        link.style.cssText =
          'position:fixed;left:12px;top:12px;z-index:2147483647;padding:10px;background:#fff;color:#000'
        doc.body.appendChild(link)
        const scriptLink = doc.createElement('a')
        scriptLink.id = 'drg-e2e-script-link'
        scriptLink.href = 'javascript:void 0'
        scriptLink.textContent = 'not a web link'
        scriptLink.style.cssText =
          'position:fixed;left:12px;top:60px;z-index:2147483647;padding:10px;background:#fff;color:#000'
        doc.body.appendChild(scriptLink)
        const copy = doc.createElement('button')
        copy.id = 'drg-e2e-copy'
        copy.textContent = 'copy'
        copy.style.cssText =
          'position:fixed;left:12px;top:108px;z-index:2147483647;padding:10px;background:#fff;color:#000'
        doc.body.appendChild(copy)
        window.__frameCopy = null
        // Exactly the call `writeClipboard` makes when the code block's copy button is pressed.
        copy.addEventListener('click', () => {
          window.__frameCopy = win.navigator.clipboard.writeText('drg-e2e-clipboard').then(
            () => 'ok',
            (error) => 'failed: ' + String(error && error.message ? error.message : error),
          )
        })
        // The page's own store must be its own: writing one key here must not touch ours.
        win.localStorage.setItem('drg-e2e-preference', 'remote')
        return {
          allow: frame.getAttribute('allow') ?? '',
          partitioned: win.__drgStoragePartition,
          bridge: win.__drgCapabilityBridge,
          frameRead: win.localStorage.getItem('drg-e2e-preference'),
          localRead: localStorage.getItem('drg-e2e-preference'),
          prefixed: localStorage.getItem('drg:h_a:drg-e2e-preference'),
          // `window.open` from inside the frame returns no window and leaves one intent.
          openReturn: win.open('https://example.com/from-open'),
          openedAfterOpen: window.__opened.length,
        }
      })
      for (const token of ['clipboard-read', 'clipboard-write', 'microphone', 'fullscreen', 'popups']) {
        assert.match(capabilities.allow, new RegExp(`\\b${token}\\b`), `the frame must declare ${token}`)
      }
      assert.equal(capabilities.bridge, true, 'the capability bridge must be installed in the frame')
      assert.equal(capabilities.partitioned, 'h_a', 'the frame must get this host’s key space')
      assert.equal(capabilities.frameRead, 'remote')
      assert.equal(capabilities.localRead, null, 'a remote preference must not land in the local page')
      assert.equal(capabilities.prefixed, 'remote', 'the remote value lives under its own prefix')
      assert.equal(capabilities.openReturn, null, 'the frame gets no window of its own')
      assert.equal(capabilities.openedAfterOpen, 1, 'the intent reached the top-level document')

      // A real click inside the frame on an http(s) link opens at the top level, not inside it.
      const linkPoint = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const rect = frame.contentDocument.getElementById('drg-e2e-link').getBoundingClientRect()
        const base = frame.getBoundingClientRect()
        return { x: base.left + rect.left + rect.width / 2, y: base.top + rect.top + rect.height / 2 }
      })
      await page.mouse.click(linkPoint.x, linkPoint.y)
      const afterLinkClick = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        return {
          opened: window.__opened.map((args) => args.slice(0, 3)),
          href: frame.contentWindow.location.href,
        }
      })
      assert.deepEqual(afterLinkClick.opened.at(-1), [
        'https://example.com/from-frame',
        '_blank',
        'noopener,noreferrer',
      ])
      assert.match(afterLinkClick.href, /\/dsh-remote-go\/remote\/h_a\//, 'the frame must not navigate away')

      // A modified click belongs to the browser (background tab / new window): it must keep its
      // default and never become a bridge intent.
      const modifiedClick = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const link = frame.contentDocument.getElementById('drg-e2e-link')
        const before = window.__opened.length
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, button: 0 })
        link.dispatchEvent(event)
        return { before, after: window.__opened.length, prevented: event.defaultPrevented }
      })
      assert.equal(modifiedClick.after, modifiedClick.before, 'a ctrl+click must not go through the bridge')
      assert.equal(modifiedClick.prevented, false, 'a ctrl+click keeps the browser’s own behaviour')

      // A non-web href is left to the page: the bridge never opens it.
      const scriptLink = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const before = window.__opened.length
        frame.contentDocument.getElementById('drg-e2e-script-link').click()
        return { before, after: window.__opened.length }
      })
      assert.equal(scriptLink.after, scriptLink.before, 'javascript: must not reach the top-level window')

      // A real click on the frame's copy button writes the clipboard through the top document.
      const copyPoint = await page.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const rect = frame.contentDocument.getElementById('drg-e2e-copy').getBoundingClientRect()
        const base = frame.getBoundingClientRect()
        return { x: base.left + rect.left + rect.width / 2, y: base.top + rect.top + rect.height / 2 }
      })
      await page.mouse.click(copyPoint.x, copyPoint.y)
      await waitFor(page, () => window.__frameCopy !== null, { timeout: 10_000 })
      assert.equal(await page.evaluate(() => window.__frameCopy), 'ok', 'the bridge must report a real write')
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'drg-e2e-clipboard')
      await page.evaluate(() => {
        window.open = window.__nativeOpen
        window.__nativeOpen = null
      })

      // The injected row's "Local" entry goes through the module's own intent channel.
      await page.evaluate(() => {
        document
          .querySelector('#dsh-remote-go-overlay-h_a iframe')
          .contentDocument.querySelector('#drg-host-row')
          .click()
      })
      const intent = await page.evaluate(() => {
        const doc = document.querySelector('#dsh-remote-go-overlay-h_a iframe').contentDocument
        const items = [...doc.querySelectorAll('#drg-host-row .drg-hr-item')]
        const local = items.find((node) => node.getAttribute('data-target') === 'local')
        if (!local) return null
        local.click()
        const face = window.__harness.captured.options.inject()
        return face.panelStore.take()
      })
      assert.deepEqual({ ...intent }, { kind: 'local' })
      assert.equal(await page.evaluate(() => window.__harness.plugin.carrier.shown()), null)
      const carrierErrors = errors.filter((text) => !/Failed to load resource/.test(text))
      assert.deepEqual(carrierErrors, [], `carrier page errors: ${carrierErrors.join(' | ')}`)
      await page.close()

      // Full overlay path: the real component sees a connected host, fetches `open`, and hands
      // the browser carrier its `webUrl` — no direct `carrier.open` call in this page.
      const overlayPage = await browser.newPage()
      const overlayErrors = []
      overlayPage.on('console', (message) => {
        if (message.type() === 'error') overlayErrors.push(message.text())
      })
      overlayPage.on('pageerror', (error) => overlayErrors.push(String(error?.message ?? error)))
      await overlayPage.goto(`http://127.0.0.1:${localPort}/overlay`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      await waitFor(overlayPage, () => Boolean(window.__overlay) && window.__overlay.plugin.carrier.shown() === 'h_a', {
        timeout: 30_000,
      })
      await waitFor(
        overlayPage,
        () => {
          try {
            const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
            return Boolean(
              frame &&
              frame.contentDocument &&
              frame.contentDocument.querySelector('#root') &&
              frame.contentDocument.querySelector('#drg-host-row'),
            )
          } catch {
            return false
          }
        },
        { timeout: 45_000 },
      )
      const overlayState = await overlayPage.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        return {
          src: frame.getAttribute('src'),
          title: frame.contentDocument.title,
          rowName: frame.contentDocument.querySelector('#drg-host-row .drg-hr-name')?.textContent ?? '',
          shown: window.__overlay.plugin.carrier.shown(),
        }
      })
      assert.match(overlayState.src, /^\/dsh-remote-go\/remote\/h_a\/\?token=/)
      assert.equal(overlayState.title, 'DeepSeek Harness')
      assert.equal(overlayState.rowName, 'Test remote')
      assert.equal(overlayState.shown, 'h_a')
      // The injected row's "Local" hides the window and clears the active host through the API.
      await overlayPage.evaluate(() => {
        const frame = document.querySelector('#dsh-remote-go-overlay-h_a iframe')
        const row = frame.contentDocument.querySelector('#drg-host-row')
        row.click()
        const local = [...frame.contentDocument.querySelectorAll('#drg-host-row .drg-hr-item')].find(
          (node) => node.getAttribute('data-target') === 'local',
        )
        local.click()
      })
      await waitFor(overlayPage, () => window.__overlay.plugin.carrier.shown() === null, {
        timeout: 10_000,
      })
      const overlayErrorsFiltered = overlayErrors.filter((text) => !/Failed to load resource/.test(text))
      assert.deepEqual(overlayErrorsFiltered, [], `overlay page errors: ${overlayErrorsFiltered.join(' | ')}`)
      await overlayPage.close()

      // Desktop guest (#63): the caption band belongs to the remote page, whose collapsed rail puts
      // the new-session control at 48px — exactly where the shell's caption menubar starts unless
      // the local page mirrors that state. A real remote UI, a real caption band, a seat that
      // answers `executeJavaScript`; only the Electron <webview> is stood in for by an iframe.
      const desktopPage = await browser.newPage()
      // Wide enough that the remote UI opens with its sidebar expanded (it auto-collapses under
      // 1024px), which is the state the caption band starts from.
      await desktopPage.setViewport({ width: 1440, height: 900 })
      const desktopErrors = []
      desktopPage.on('console', (message) => {
        if (message.type() === 'error') desktopErrors.push(message.text())
      })
      desktopPage.on('pageerror', (error) => desktopErrors.push(String(error?.message ?? error)))
      await desktopPage.goto(`http://127.0.0.1:${localPort}/desktop`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      await waitFor(desktopPage, () => Boolean(window.__harness), { timeout: 15_000 })
      assert.equal(
        await desktopPage.evaluate(() => window.__harness.plugin.carrier.surface()),
        'desktop',
        'the page with the shell bridge must use the desktop guest',
      )
      const desktopOpened = await desktopPage.evaluate(() =>
        window.__harness.plugin.carrier.open({ hostId: 'h_a', url: window.__guestUrl }),
      )
      assert.equal(desktopOpened.ok, true)
      // The guest committed the remote document, the plugin taught it the desktop grid, and the
      // remote sidebar rendered (the toggle survives the collapse this test drives).
      try {
        await waitFor(
          desktopPage,
          () => {
            const seat = document.querySelector('[data-guest-seat]')
            const guest = seat && seat.contentDocument
            return Boolean(
              guest &&
              guest.documentElement.hasAttribute('data-windows-titlebar') &&
              guest.querySelector('[data-sidebar-toggle]'),
            )
          },
          { timeout: 60_000 },
        )
      } catch (error) {
        const state = await desktopPage.evaluate(() => {
          const seat = document.querySelector('[data-guest-seat]')
          const guest = seat && seat.contentDocument
          return {
            src: seat ? seat.getAttribute('src') : '',
            title: guest ? guest.title : '',
            marker: guest ? guest.documentElement.hasAttribute('data-windows-titlebar') : null,
            root: guest && guest.querySelector('#root') ? guest.querySelector('#root').children.length : -1,
            toggle: guest ? Boolean(guest.querySelector('[data-sidebar-toggle]')) : null,
          }
        })
        throw new Error(`the desktop guest did not boot: ${JSON.stringify(state)} (${error.message})`)
      }
      // Whatever layout the remote UI persisted, start from the expanded rail this page is about.
      await desktopPage.evaluate(() => {
        const guest = document.querySelector('[data-guest-seat]').contentDocument
        if (guest.querySelector('[data-sidebar-collapsed]') !== null)
          guest.querySelector('[data-sidebar-toggle]').click()
      })
      await waitFor(
        desktopPage,
        () => {
          const guest = document.querySelector('[data-guest-seat]').contentDocument
          return (
            guest.querySelector('[data-sidebar-collapsed]') === null &&
            Math.round(document.querySelector('#caption-menubar').getBoundingClientRect().left) === 48
          )
        },
        { timeout: 10_000 },
      )
      const expanded = await desktopPage.evaluate(() => {
        const guest = document.querySelector('[data-guest-seat]').contentDocument
        const button = [...guest.querySelectorAll('button')].find((node) =>
          String(node.className).includes('newSession'),
        )
        return {
          menuLeft: Math.round(document.querySelector('#caption-menubar').getBoundingClientRect().left),
          captureLive: document.documentElement.classList.contains('drg-caption-live'),
          newSessionPosition: button === null ? '' : guest.defaultView.getComputedStyle(button).position,
          menuStart: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim(),
        }
      })
      assert.equal(expanded.captureLive, true, 'the guest owns the caption band')
      assert.equal(expanded.menuLeft, 48, 'an expanded rail leaves the shell default where it is')
      assert.equal(expanded.menuStart, '48px', 'and the mirror says so')
      assert.notEqual(
        expanded.newSessionPosition,
        'fixed',
        'an expanded rail keeps new-session inside the sidebar, out of the caption band',
      )

      // Collapse the remote sidebar in the guest, exactly as the user does on the toggle: the
      // new-session control now sits at 48px in the caption band, where the shell's default starts.
      await desktopPage.evaluate(() => {
        const guest = document.querySelector('[data-guest-seat]').contentDocument
        guest.querySelector('[data-sidebar-toggle]').click()
      })
      await waitFor(
        desktopPage,
        () =>
          document.querySelector('[data-guest-seat]').contentDocument.querySelector('[data-sidebar-collapsed]') !==
          null,
        { timeout: 10_000 },
      )
      // The guest reports through the row's 400ms poll, so the host catches up within one cycle.
      // The overlap during that cycle is the documented transient (docs/design.md §4.2): this
      // measurement is after it, and asserting the transient itself would only add timing flakes.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const collapsed = await desktopPage.evaluate(() => {
        const guest = document.querySelector('[data-guest-seat]').contentDocument
        const menu = document.querySelector('#caption-menubar').getBoundingClientRect()
        const button = [...guest.querySelectorAll('button')].find((node) =>
          String(node.className).includes('newSession'),
        )
        const rect = button ? button.getBoundingClientRect() : null
        return {
          railCollapsed: guest.querySelector('[data-sidebar-collapsed]') !== null,
          menuLeft: Math.round(menu.left),
          menuRight: Math.round(menu.right),
          newSession: rect === null ? null : { left: Math.round(rect.left), right: Math.round(rect.right) },
          newSessionPosition: button === null ? '' : guest.defaultView.getComputedStyle(button).position,
          menuStart: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim(),
          // The guest's own copy of DSH's rule: the value the plugin hands over comes from here.
          guestStart: guest.defaultView
            .getComputedStyle(guest.documentElement)
            .getPropertyValue('--dsh-windows-menu-start')
            .trim(),
        }
      })
      assert.equal(collapsed.railCollapsed, true, 'the remote rail is collapsed')
      assert.equal(collapsed.guestStart, '84px', 'the guest resolves the menubar inset with DSH own rule')
      assert.equal(collapsed.newSessionPosition, 'fixed', 'a collapsed rail lifts new-session into the band')
      assert.equal(collapsed.newSession.left, 48, 'the caption controls still start after the toggle')
      assert.equal(
        collapsed.menuStart,
        '84px',
        'the local menubar inset follows the guest rail (the shell default 48px would sit on it)',
      )
      assert.equal(collapsed.menuLeft, 84, 'the caption menubar moved with it')
      assert.ok(
        collapsed.menuLeft >= collapsed.newSession.right,
        `the caption menus overlap new-session (${collapsed.menuLeft} < ${collapsed.newSession.right})`,
      )

      // Expanding the rail again hands the 48px start back; leaving the guest returns the band to
      // the local page, whose own sidebar rule takes the inset over again.
      await desktopPage.evaluate(() => {
        const guest = document.querySelector('[data-guest-seat]').contentDocument
        guest.querySelector('[data-sidebar-toggle]').click()
      })
      await waitFor(
        desktopPage,
        () =>
          document.querySelector('[data-guest-seat]').contentDocument.querySelector('[data-sidebar-collapsed]') ===
          null,
        { timeout: 10_000 },
      )
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const reExpanded = await desktopPage.evaluate(() => ({
        menuLeft: Math.round(document.querySelector('#caption-menubar').getBoundingClientRect().left),
        menuStart: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim(),
      }))
      assert.equal(reExpanded.menuStart, '48px', 'an expanded rail brings the shell default back')
      assert.equal(reExpanded.menuLeft, 48, 'and the caption menubar with it')
      await desktopPage.evaluate(() => window.__harness.plugin.carrier.hide())
      const afterLocal = await desktopPage.evaluate(() => ({
        menuLeft: Math.round(document.querySelector('#caption-menubar').getBoundingClientRect().left),
        menuStart: getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim(),
        captureLive: document.documentElement.classList.contains('drg-caption-live'),
      }))
      assert.equal(afterLocal.captureLive, false, 'the local page owns the band again')
      assert.equal(afterLocal.menuStart, '', 'the inline override is gone, so the local rule decides')
      assert.equal(afterLocal.menuLeft, 48, 'with no local sidebar to collapse, that rule is the default')
      const desktopErrorsFiltered = desktopErrors.filter((text) => !/Failed to load resource/.test(text))
      assert.deepEqual(desktopErrorsFiltered, [], `desktop page errors: ${desktopErrorsFiltered.join(' | ')}`)
      await desktopPage.close()
    } finally {
      if (browser !== null) await browser.close()
      proxy?.dispose()
      if (server !== null) await close(server)
      if (dsh !== null) await stopChild(dsh.child)
      rmSync(home, { recursive: true, force: true })
    }
  },
)

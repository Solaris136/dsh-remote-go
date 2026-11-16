import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { makeTempRoot, resolveBrowser, resolveDshCli, skipOrFail, stopChild, tail } from './harness-support.js'
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
  'the browser carrier frames a real remote DSH UI and its injected switcher works',
  { timeout: 180_000 },
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
      const localPort = await listen(server)
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
        args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
      })
      const page = await browser.newPage()
      const errors = []
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('pageerror', (error) => errors.push(String(error?.message ?? error)))
      await page.goto(`http://127.0.0.1:${localPort}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForFunction(() => Boolean(window.__harness), { timeout: 15_000 })
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
      await page.waitForFunction(
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
      await page.waitForFunction(
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
      await overlayPage.waitForFunction(
        () => Boolean(window.__overlay) && window.__overlay.plugin.carrier.shown() === 'h_a',
        { timeout: 30_000 },
      )
      await overlayPage.waitForFunction(
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
      await overlayPage.waitForFunction(() => window.__overlay.plugin.carrier.shown() === null, { timeout: 10_000 })
      const overlayErrorsFiltered = overlayErrors.filter((text) => !/Failed to load resource/.test(text))
      assert.deepEqual(overlayErrorsFiltered, [], `overlay page errors: ${overlayErrorsFiltered.join(' | ')}`)
      await overlayPage.close()
    } finally {
      if (browser !== null) await browser.close()
      proxy?.dispose()
      if (server !== null) await close(server)
      if (dsh !== null) await stopChild(dsh.child)
      rmSync(home, { recursive: true, force: true })
    }
  },
)

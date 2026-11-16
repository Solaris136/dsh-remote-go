import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolveBrowser, skipOrFail } from './harness-support.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')

/** The host the stubbed Host API reports: one connected remote DSH. */
const HOST = {
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
  conflict: null,
  fingerprint: null,
  logs: [],
  remote: {
    version: '0.2.2-rc.3',
    uiReady: true,
    localPort: 45123,
    port: 38123,
    pid: 1234,
    dshHome: '/home/test/.dsh',
    profile: 'web',
    bootstrapLevel: 'npx',
    nodeVersion: '24.9.0',
    nodeSource: 'managed',
    startedAt: '2026-11-16T00:00:00.000Z',
    viewRev: 1,
  },
  keepAlive: 'keep',
  idleMinutes: 15,
  autoReconnect: true,
  hostKeyPolicy: 'first-use',
  targetVersion: '0.2.2-rc.3',
  versionParity: {
    status: 'same',
    local: '0.2.2-rc.3',
    remote: '0.2.2-rc.3',
    same: true,
    message: { zh: '', en: '' },
  },
  lastOpenedAt: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
}

/**
 * A page that mounts the real card list over a stubbed Host API, so a real browser can click
 * the destructive action end to end: card -> confirmation -> POST -> progress -> disconnected.
 */
function stopHarness() {
  return `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8" /><title>stop-remote harness</title></head>
  <body>
    <div id="mount"></div>
    <script>
      window.__state = {
        hostVersion: '0.2.2-rc.3',
        targetVersion: '0.2.2-rc.3',
        activeHostId: null,
        firstRun: false,
        settings: {},
        hosts: [${JSON.stringify(HOST)}],
      }
      window.__stopCalls = []
      window.__resolveStop = null
      const jsonResponse = (payload) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async json() {
          return payload
        },
      })
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        if (url === '/dsh-remote-go/api/state') return Promise.resolve(jsonResponse({ ok: true, state: window.__state }))
        if (url === '/dsh-remote-go/api/hosts/h_a/stop-remote') {
          window.__stopCalls.push({ url, init })
          // The Host reports the one-shot action through /state; the card must show it.
          window.__paint(
            window.__state.hosts.map((host) =>
              host.id === 'h_a'
                ? {
                    ...host,
                    status: 'connecting',
                    phase: 'start',
                    progress: { code: 'stopping-remote', params: { pid: 1234, port: 38123 } },
                    remote: { ...host.remote, uiReady: false, localPort: null },
                  }
                : host,
            ),
          )
          return new Promise((resolve) => {
            window.__resolveStop = () => resolve(jsonResponse({ ok: true, pid: 1234 }))
          })
        }
        return Promise.reject(new Error('unexpected fetch: ' + url))
      }
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
        window.__plugin = plugin
        const root = window.ReactDOM.createRoot(document.getElementById('mount'))
        window.__paint = (hosts) => {
          window.__state = { ...window.__state, hosts }
          root.render(
            window.React.createElement(plugin.components.HostListView, {
              // No \`t\`: the component falls back to the plugin's own dictionaries.
              localeId: 'zh',
              state: window.__state,
              loading: false,
              error: null,
              onAdd: () => {},
              onRefresh: () => {},
              onOpenSettings: () => {},
              onOpenHost: () => {},
              onDisconnectHost: () => {},
              onReconnectHost: () => {},
              onRestartHost: () => {},
              onStopRemote: (host) => plugin.api.stopRemote(host.id),
              onEditHost: () => {},
              onDeleteHost: () => {},
              onDiagnoseHost: () => {},
            }),
          )
        }
        window.__paint(window.__state.hosts)
      })()
    </script>
  </body>
</html>`
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('the browser card stops the remote DSH only after a confirmed click', { timeout: 240_000 }, async (t) => {
  const browserPath = resolveBrowser()
  if (!browserPath) {
    skipOrFail(t, 'no Chrome/Edge found: set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH')
    return
  }
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
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(stopHarness())
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
    res.writeHead(404)
    res.end()
  })
  const port = await listen(server)
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({
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
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('[data-testid="host-stop-remote"]') !== null, {
      timeout: 15_000,
    })
    assert.equal(
      await page.$eval('[data-testid="host-stop-remote"]', (node) => node.textContent.trim()),
      '关闭远端 DSH',
    )

    await t.test('the card action asks for confirmation and cancel is non-destructive', async () => {
      await page.click('[data-testid="host-stop-remote"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="stop-remote-dialog"]') !== null)
      const dialog = await page.$eval('[data-testid="stop-remote-dialog"]', (node) => node.textContent)
      assert.match(dialog, /关闭远端 DSH？/)
      assert.match(dialog, /会停止远端 DSH 进程/)
      assert.match(dialog, /重连/)
      assert.equal(await page.evaluate(() => window.__stopCalls.length), 0, 'opening the dialog must not call the API')
      await page.click('[data-testid="stop-remote-cancel"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="stop-remote-dialog"]') === null)
      assert.equal(await page.evaluate(() => window.__stopCalls.length), 0, 'cancel must not call the API')
      assert.equal(
        await page.$eval('[data-testid="host-stop-remote"]', (node) => node.disabled),
        false,
        'cancel leaves the action available',
      )
    })

    await t.test('confirming posts the stop action and shows its progress', async () => {
      await page.click('[data-testid="host-stop-remote"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="stop-remote-confirm"]') !== null)
      await page.click('[data-testid="stop-remote-confirm"]')
      await page.waitForFunction(() => window.__stopCalls.length === 1, { timeout: 10_000 })
      const call = await page.evaluate(() => ({
        url: window.__stopCalls[0].url,
        method: window.__stopCalls[0].init.method,
      }))
      assert.match(call.url, /\/hosts\/h_a\/stop-remote$/)
      assert.equal(call.method, 'POST')
      // While the Host works, the card carries the stopping progress and the action is disabled.
      await page.waitForFunction(
        () =>
          document.querySelector('[data-progress="stopping-remote"]') !== null &&
          document.querySelector('[data-testid="host-stop-remote"]')?.textContent.includes('正在关闭远端 DSH'),
        { timeout: 10_000 },
      )
      assert.equal(
        await page.$eval('[data-testid="host-stop-remote"]', (node) => node.disabled),
        true,
        'the stop action must be disabled while it runs',
      )
      assert.match(await page.$eval('[data-testid="stop-remote-dialog"]', (node) => node.textContent), /正在关闭…/)
      assert.match(
        await page.$eval('[data-testid="host-card"]', (node) => node.textContent),
        /正在关闭远端 DSH（停止本连接管理的远端进程）…/,
      )
    })

    await t.test('the finished stop leaves a disconnected card that can be reconnected', async () => {
      await page.evaluate(() => window.__resolveStop())
      await page.waitForFunction(() => document.querySelector('[data-testid="stop-remote-dialog"]') === null, {
        timeout: 10_000,
      })
      // The Host's next state frame after the stop: no remote process, still the same host.
      await page.evaluate(() =>
        window.__paint(
          window.__state.hosts.map((host) => ({
            ...host,
            status: 'disconnected',
            phase: null,
            progress: null,
            remote: { ...host.remote, uiReady: false, localPort: null, pid: null },
          })),
        ),
      )
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="host-stop-remote"]') === null &&
          document.querySelector('[data-status="disconnected"]') !== null,
        { timeout: 10_000 },
      )
      const card = await page.$eval('[data-testid="host-card"]', (node) => node.textContent)
      assert.match(card, /断线/)
      assert.match(card, /重连/)
      assert.doesNotMatch(card, /关闭远端 DSH/)
    })

    const silent = errors.filter((text) => !/Failed to load resource/.test(text))
    assert.deepEqual(silent, [], `page errors: ${silent.join(' | ')}`)
  } finally {
    await browser.close().catch(() => {})
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
})

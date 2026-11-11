// End-to-end acceptance for dsh-remote-go (real product path, not fakes):
//
//   1. boot an isolated control DSH (own DSH_HOME, own profile) from the locally
//      installed runtime, with this plugin installed into that profile;
//   2. prove the Host half answers and the browser half is in the client-module graph;
//   3. create + connect a host through the local API against the real test server
//      (`E2E_SSH_ADDRESS`, required) — SSH, remote probe, T0-local
//      runtime reuse, remote web start, loopback tunnel, token → cookie handshake;
//   4. drive the real Web GUI in headless Chrome: sidebar entry → full-page panel →
//      remote DSH iframe renders inside the panel;
//   5. clean up (stop the remote web, delete the host, stop the control DSH).
//
// Run:  node --test "test/e2e/*.e2e.js"
// Env:  E2E_SSH_ADDRESS (required: ssh alias or user@host), E2E_CHROME (browser executable),
//       E2E_KEEP_CONTROL=1 to keep the control instance for debugging.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..')
const CONTROL_DIR = path.join(ROOT, 'e2e', 'control')
const CONTROL_HOME = path.join(CONTROL_DIR, 'home')
const DSH_BIN = path.join(CONTROL_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const ARTIFACTS = path.join(ROOT, 'e2e', 'artifacts')
const REPORT_FILE = path.join(ARTIFACTS, 'plugin-e2e-report.json')
const SSH_ADDRESS = process.env.E2E_SSH_ADDRESS || ''
const KEEP_CONTROL = process.env.E2E_KEEP_CONTROL === '1'
const API_HEADER = 'x-dsh-remote-go'

/**
 * Report strings come from the remote page (titles, console lines, HTML
 * excerpts) and are untrusted by definition. They are evidence, not input:
 * keep them bounded and free of control characters so the artefact stays
 * greppable and cannot inject terminal escapes into a CI log.
 * @param {unknown} value - any report value.
 * @param {number} limit - maximum retained length.
 * @returns {string} printable, truncated text.
 */
function evidenceText(value, limit = 2000) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, limit)
}

/**
 * Deep-copy the report, passing every string through {@link evidenceText}.
 * @param {unknown} value - report node.
 * @param {number} depth - recursion guard.
 * @returns {unknown} sanitized copy.
 */
function sanitizeEvidence(value, depth = 0) {
  if (depth > 8) return '[depth-limit]'
  if (typeof value === 'string') return evidenceText(value)
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[evidenceText(key, 120)] = sanitizeEvidence(entry, depth + 1)
    return out
  }
  return value
}

/**
 * Write the evidence report to its fixed destination.
 *
 * The path is a constant under `e2e/artifacts/`: it is never derived from page,
 * network or SSH data, and the resolved target is re-checked against the
 * artifacts directory. The untrusted part is only the *content*, which is
 * sanitized above — so remote data cannot steer where, or whether, we write.
 * @param {unknown} report - evidence payload.
 * @returns {Promise<void>} resolves once the file is written.
 */
async function writeReport(report) {
  const target = path.resolve(REPORT_FILE)
  const artifacts = path.resolve(ARTIFACTS) + path.sep
  if (!target.startsWith(artifacts)) throw new Error(`refusing to write outside the artifacts directory: ${target}`)
  await writeFile(target, `${JSON.stringify(sanitizeEvidence(report), null, 2)}\n`, 'utf8')
}

function resolveChrome() {
  // Portable discovery only: an explicit override, then the default install
  // locations of each supported OS. Never a developer-specific path.
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.PROGRAMFILES ?? 'C:/Program Files'
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
  const candidates = [
    process.env.E2E_CHROME,
    process.env.CHROME_PATH,
    localAppData && `${localAppData}/Google/Chrome/Application/chrome.exe`,
    `${programFiles}/Google/Chrome/Application/chrome.exe`,
    `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
    localAppData && `${localAppData}/Microsoft/Edge/Application/msedge.exe`,
    `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
    `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * @param {{ log: (line: string) => void }} options
 */
async function startControlDsh(options) {
  if (!existsSync(DSH_BIN)) {
    throw new Error(
      `control DSH runtime missing at ${DSH_BIN}; install it with: pnpm --dir e2e/control add --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.1`,
    )
  }
  const logLines = []
  const proc = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--no-open', '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: CONTROL_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.includes('dsh web:') || line.trim() !== '') {
        logLines.push(line)
        options.log?.(line)
      }
    }
  })
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
    logLines.push(chunk.toString('utf8'))
  })
  const deadline = Date.now() + 180_000
  let url = null
  while (Date.now() < deadline) {
    const match = /dsh web:\s*(http:\/\/[^\s]+)/.exec(stdout)
    if (match) {
      url = match[1]
      break
    }
    if (proc.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!url) {
    proc.kill()
    throw new Error(
      `control DSH did not become ready.\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`,
    )
  }
  const parsed = new URL(url)
  const token = parsed.searchParams.get('token') || ''
  return {
    proc,
    url,
    token,
    port: Number(parsed.port),
    origin: `http://127.0.0.1:${parsed.port}`,
    logLines,
  }
}

/** @param {import('node:child_process').ChildProcess} proc */
async function stopControlDsh(proc) {
  if (!proc || proc.exitCode !== null) return
  proc.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(undefined)
    }, 5000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/**
 * @param {string} origin
 * @param {string} route
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [options]
 */
async function api(origin, route, options = {}) {
  const response = await fetch(`${origin}/dsh-remote-go/api${route}`, {
    method: options.method ?? 'GET',
    headers: {
      [API_HEADER]: '1',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/** @param {string} origin @param {string} id */
async function waitForHostState(origin, id, predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const result = await api(origin, '/state')
    const host = result.json?.state?.hosts?.find((item) => item.id === id) ?? null
    last = host
    if (host && predicate(host)) return host
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`host did not reach the expected state; last=${JSON.stringify(last)}`)
}

/** @param {string} origin */
async function cleanupHosts(origin) {
  const state = await api(origin, '/state')
  for (const host of state.json?.state?.hosts ?? []) {
    await api(origin, `/hosts/${host.id}/disconnect`, { method: 'POST', body: { stopRemote: true } }).catch(() => {})
    await api(origin, `/hosts/${host.id}`, { method: 'DELETE' }).catch(() => {})
  }
}

test(
  'dsh-remote-go end-to-end: control DSH → SSH → remote DSH in panel iframe',
  {
    timeout: 420_000,
    skip: SSH_ADDRESS ? false : 'set E2E_SSH_ADDRESS to an SSH host alias/address this machine can reach',
  },
  async (t) => {
    await mkdir(ARTIFACTS, { recursive: true })
    /** @type {Record<string, unknown>} */
    const report = { startedAt: new Date().toISOString(), sshAddress: SSH_ADDRESS, steps: [] }
    const chromePath = resolveChrome()
    assert.ok(chromePath, 'a Chrome/Edge executable is required for the browser half of the E2E (set E2E_CHROME)')

    /** @type {Awaited<ReturnType<typeof startControlDsh>> | null} */
    let control = null
    /** @type {import('puppeteer-core').Browser | null} */
    let browser = null
    /** @type {string | null} */
    let hostId = null
    try {
      // 1) isolated control DSH with this plugin installed in its profile
      control = await startControlDsh({ log: () => {} })
      report.control = { origin: control.origin, port: control.port }
      t.diagnostic(`control DSH on ${control.origin}`)

      const health = await api(control.origin, '/health')
      assert.equal(health.status, 200, `plugin API not reachable: ${health.text}`)
      report.steps.push({ step: 'health', ok: true })

      const diagnostics = await api(control.origin, '/diagnostics/self')
      assert.equal(diagnostics.status, 200)
      const self = diagnostics.json
      assert.equal(self?.plugin?.id, 'dsh-remote-go')
      assert.ok(self?.entry?.id, 'host plugin entry must be live')
      assert.ok(self?.client?.row?.id === 'dsh-remote-go', 'browser half must be registered in the client-module graph')
      assert.ok(self?.client?.bundle?.size > 1000, 'client bundle must be readable')
      report.steps.push({
        step: 'activation',
        ok: true,
        hostEntry: self.entry,
        clientRow: self.client.row,
        clientBundleSize: self.client.bundle.size,
        hostVersion: self.hostVersion,
      })

      // 2) connect the real test server through the plugin's own API
      await cleanupHosts(control.origin)
      const created = await api(control.origin, '/hosts', {
        method: 'POST',
        body: {
          host: {
            name: 'E2E test host',
            address: SSH_ADDRESS,
            username: 'ubuntu',
            auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
            keepAlive: 'stop',
            autoReconnect: true,
          },
        },
      })
      assert.equal(created.status, 200, created.text)
      hostId = created.json.host.id
      report.host = { id: hostId, address: SSH_ADDRESS }

      const connect = await api(control.origin, `/hosts/${hostId}/connect`, { method: 'POST', body: {} })
      assert.equal(connect.status, 200, connect.text)
      const connected = await waitForHostState(
        control.origin,
        hostId,
        (host) => host.status === 'connected' || host.status === 'error',
      )
      assert.equal(connected.status, 'connected', `connect failed: ${JSON.stringify(connected.error)}`)
      assert.equal(connected.remote.uiReady, true)
      assert.equal(connected.versionParity.status, 'same')
      assert.ok(connected.remote.localPort > 0)
      report.steps.push({
        step: 'connect',
        ok: true,
        bootstrapLevel: connected.remote.bootstrapLevel,
        remoteVersion: connected.remote.version,
        remotePort: connected.remote.port,
        localPort: connected.remote.localPort,
        pid: connected.remote.pid,
      })

      const opened = await api(control.origin, `/hosts/${hostId}/open`)
      assert.equal(opened.status, 200, opened.text)
      assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
      // The token URL must actually complete the cookie handshake through the tunnel.
      const tokenized = await fetch(opened.json.url, { redirect: 'manual' })
      assert.ok([302, 303].includes(tokenized.status), `unexpected token response ${tokenized.status}`)
      const cookie = tokenized.headers.get('set-cookie') ?? ''
      assert.match(cookie, /dsh-auth-/)
      assert.match(cookie, /SameSite=Strict/i)
      report.steps.push({ step: 'tunnel-token-cookie', ok: true, status: tokenized.status })

      // 3) the browser half: Settings → 远程主机 → panel → workspace rail → iframe
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1440,900',
          '--lang=zh-CN',
        ],
      })
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900 })
      const consoleErrors = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      await page.goto(control.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForFunction(() => !location.search.includes('token='), { timeout: 30_000 })
      await page.waitForSelector('[data-slot="sidebar"]', { timeout: 60_000 })

      /** Dismiss the first-run preview notice / signed-out dialog that would block clicks. */
      const dismissOverlays = async () => {
        return page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
          const target = dialogs.find((dialog) =>
            /开始使用|Get started|预览版说明|preview/i.test(dialog.innerText ?? ''),
          )
          if (target) {
            const close = target.querySelector('button[aria-label="关闭"], button[aria-label="Close"]')
            if (close) {
              close.click()
              return 'closed-dialog'
            }
          }
          const continueButton = Array.from(document.querySelectorAll('button')).find((button) =>
            /^(继续|Continue|知道了|Got it)$/.test((button.textContent ?? '').trim()),
          )
          if (continueButton) {
            continueButton.click()
            return 'continue'
          }
          // The signed-out "开始使用 / Get started" onboarding card is not a
          // role=dialog; its own close button is the reliable way out.
          const closers = Array.from(document.querySelectorAll('button[aria-label="关闭"], button[aria-label="Close"]'))
          for (const closer of closers) {
            let node = closer
            for (let depth = 0; depth < 5 && node; depth += 1) {
              if (/开始使用|Get started/.test(node.innerText ?? '')) {
                closer.click()
                return 'closed-signin'
              }
              node = node.parentElement
            }
          }
          return null
        })
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const dismissed = await dismissOverlays()
        if (!dismissed) break
        await new Promise((resolve) => setTimeout(resolve, 400))
      }

      /** Click the first button/menu item whose whitespace-stripped text starts with a candidate. @param {string[]} texts */
      const clickByText = (texts) =>
        page.evaluate((candidates) => {
          const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], a'))
          const target = nodes.find((element) => {
            const text = (element.textContent ?? '').replace(/\s+/g, '')
            return candidates.some((candidate) => text === candidate || text.startsWith(candidate))
          })
          target?.click()
          return target ? (target.textContent ?? '').replace(/\s+/g, ' ').trim() : null
        }, texts)

      // Product requirement: no sidebar entry any more.
      assert.equal(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="dsh-remote-go-sidebar"]'))),
        false,
        'the plugin must not register a sidebar entry',
      )

      // Open Settings from the signed-out/account menu.
      const accountOpened = await page.evaluate(() => {
        const button = document.querySelector('[data-slot="sidebar.settings"] button')
        button?.click()
        return Boolean(button)
      })
      assert.ok(accountOpened, 'sidebar settings/account trigger missing')
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[role="menuitem"], button')).some((element) =>
            (element.textContent ?? '').replace(/\s+/g, '').startsWith('设置'),
          ),
        { timeout: 15_000 },
      )
      const settingsClicked = await clickByText(['设置', 'Settings'])
      assert.ok(settingsClicked, 'settings menu item not clickable')
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('button, [role="button"]')).some(
            (element) =>
              (element.textContent ?? '').replace(/\s+/g, '') === '远程主机' ||
              (element.textContent ?? '').replace(/\s+/g, '') === 'Remotehosts',
          ),
        { timeout: 30_000 },
      )
      const sectionClicked = await clickByText(['远程主机', 'Remote hosts'])
      assert.ok(sectionClicked, 'the 远程主机 settings section is not reachable')
      await page.waitForSelector('[data-testid="settings-remote-section"]', { timeout: 30_000 })
      await page.screenshot({ path: path.join(ARTIFACTS, 'settings-remote-section.png') })

      // Open the remote panel for the connected host from its settings card. A DOM
      // click is used because the signed-out onboarding card can overlap the card
      // and swallow synthetic mouse events in the isolated control profile.
      const openButton = `[data-testid="host-card"][data-host-id="${hostId}"] [data-testid="settings-host-open"]`
      await page.waitForSelector(openButton, { timeout: 30_000 })
      const openedViaDom = await page.evaluate((selector) => {
        const element = document.querySelector(selector)
        element?.click()
        return Boolean(element)
      }, openButton)
      assert.ok(openedViaDom, 'the 打开远程界面 button was not clickable')
      const panel = '[data-testid="dsh-remote-go-panel"]'
      try {
        await page.waitForSelector(panel, { timeout: 30_000 })
      } catch (error) {
        await page.screenshot({ path: path.join(ARTIFACTS, 'panel-missing.png') }).catch(() => {})
        throw error
      }
      // Opening the remote panel must close the settings dialog behind it.
      assert.equal(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="settings-remote-section"]'))),
        false,
        'the settings dialog should close when the remote panel opens',
      )

      // Workspace rail: local group + one group per remote host.
      const railSelector = '[data-testid="workspace-rail"]'
      await page.waitForSelector(railSelector, { timeout: 30_000 })
      const rail = await page.evaluate((id) => {
        const railElement = document.querySelector('[data-testid="workspace-rail"]')
        return {
          text: (railElement?.innerText ?? '').slice(0, 600),
          hasLocalGroup: Boolean(document.querySelector('[data-testid="workspace-local-group"]')),
          hasRemoteGroup: Boolean(
            document.querySelector(`[data-testid="workspace-remote-group"][data-host-id="${id}"]`),
          ),
          hasIframe: Boolean(document.querySelector('[data-testid="remote-iframe"]')),
        }
      }, hostId)
      assert.ok(rail.hasLocalGroup, 'workspace rail must show the local workspace group')
      assert.ok(rail.hasRemoteGroup, 'workspace rail must show a per-remote workspace group for the connected host')
      assert.match(rail.text, /本地工作区|Local workspaces/)
      // The seeded test host exposes two Workspaces; the rail must list them under
      // the host's own group (remote workspaces are read from the remote registry).
      const hostWorkspaces = await api(control.origin, `/hosts/${hostId}/workspaces`)
      assert.equal(hostWorkspaces.status, 200, hostWorkspaces.text)
      const remoteWorkspaces = hostWorkspaces.json.workspaces ?? []
      if (remoteWorkspaces.length > 0) {
        await page.waitForFunction(
          () => document.querySelectorAll('[data-testid="workspace-remote-item"]').length > 0,
          { timeout: 20_000 },
        )
        const remoteGroupText = await page.evaluate(
          () => document.querySelector('[data-testid="workspace-remote-group"]')?.innerText ?? '',
        )
        assert.ok(
          remoteGroupText.includes(remoteWorkspaces[0].title),
          `remote rail group does not list "${remoteWorkspaces[0].title}": ${remoteGroupText.slice(0, 200)}`,
        )
        report.steps.push({ step: 'remote-workspaces', ok: true, count: remoteWorkspaces.length })
      }
      await page.screenshot({ path: path.join(ARTIFACTS, 'panel-workspace-rail.png') })
      report.steps.push({
        step: 'workspace-rail',
        ok: true,
        hasLocalGroup: rail.hasLocalGroup,
        hasRemoteGroup: rail.hasRemoteGroup,
        textSample: rail.text.slice(0, 120),
      })

      const iframeSelector = '[data-testid="remote-iframe"]'
      await page.waitForSelector(iframeSelector, { timeout: 60_000 })

      const iframeHandle = await page.$(iframeSelector)
      const iframeSrc = await page.evaluate((element) => element.getAttribute('src'), iframeHandle)
      assert.match(iframeSrc ?? '', /^http:\/\/127\.0\.0\.1:\d+\/\?token=/, 'iframe must point at the loopback tunnel')
      const sandbox = await page.evaluate((element) => element.getAttribute('sandbox'), iframeHandle)
      assert.match(sandbox ?? '', /allow-scripts/)
      assert.match(sandbox ?? '', /allow-same-origin/)

      // Wait for the remote DSH document inside the iframe. Puppeteer's
      // `contentFrame()` is the only reliable way to tell the iframe apart from the
      // shell's own main frame (both are http://127.0.0.1:...).
      const tunnelOrigin = new URL(iframeSrc).origin
      const iframeElement = await page.$(iframeSelector)
      assert.ok(iframeElement, 'iframe element handle missing')
      const frameDeadline = Date.now() + 120_000
      /** @type {import('puppeteer-core').Frame | null} */
      let remoteFrame = null
      while (Date.now() < frameDeadline) {
        const candidate = await iframeElement.contentFrame()
        if (candidate) {
          try {
            const url = candidate.url()
            if (url.startsWith(tunnelOrigin)) {
              const title = await candidate.evaluate(() => document.title)
              if (title && title.includes('DeepSeek')) {
                remoteFrame = candidate
                break
              }
            }
          } catch {
            /* frame may still be navigating */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assert.ok(remoteFrame, 'the remote DSH document never loaded inside the iframe')
      assert.ok(
        remoteFrame.url().startsWith(tunnelOrigin),
        `iframe frame lives on ${remoteFrame.url()}, expected ${tunnelOrigin}`,
      )
      // A fresh remote DSH_HOME shows the "preview build" notice and a signed-out
      // card; dismiss both so the assertion covers the real shell.
      const noticed = await remoteFrame
        .evaluate(() => {
          const text = document.body?.innerText ?? ''
          let dismissed = 0
          const continueButton = Array.from(document.querySelectorAll('button')).find(
            (item) => (item.textContent ?? '').trim() === '继续',
          )
          if (continueButton) {
            continueButton.click()
            dismissed += 1
          }
          const closers = Array.from(document.querySelectorAll('button[aria-label="关闭"], button[aria-label="Close"]'))
          for (const closer of closers) {
            let node = closer
            for (let depth = 0; depth < 5 && node; depth += 1) {
              if (/开始使用|Get started/.test(node.innerText ?? '')) {
                closer.click()
                dismissed += 1
                break
              }
              node = node.parentElement
            }
            if (dismissed > 0) break
          }
          return {
            hadNotice: dismissed > 0,
            beforeNodes: document.querySelectorAll('*').length,
            beforeText: text.slice(0, 120),
          }
        })
        .catch(() => ({ hadNotice: false, beforeNodes: 0, beforeText: '' }))
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const frameInfo = await remoteFrame.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText ?? '').slice(0, 400),
        nodes: document.querySelectorAll('*').length,
        hasComposer: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
      }))
      assert.ok(frameInfo.title.includes('DeepSeek'), `unexpected remote title: ${frameInfo.title}`)
      assert.ok(
        frameInfo.nodes > 100,
        `remote UI did not render (${frameInfo.nodes} nodes; notice=${JSON.stringify(noticed)})`,
      )
      // The frame must be the remote DSH, not the local shell: the local panel's
      // toolbar strings never appear inside the remote document.
      assert.ok(
        !frameInfo.text.includes('隐藏地址'),
        'the iframe frame must be the remote document, not the local shell',
      )
      assert.ok(
        !frameInfo.text.includes('你正在操作远端服务器'),
        'the local banner must not leak into the remote document',
      )

      // Cookie evidence for the tunnel authority (the iframe origin).
      const cookies = await page.cookies(tunnelOrigin)
      const authCookie = cookies.find((cookie) => cookie.name.startsWith('dsh-auth-'))
      assert.ok(authCookie, 'the tunnel origin must hold the remote DSH auth cookie')
      assert.equal(authCookie.sameSite, 'Strict')
      assert.equal(authCookie.httpOnly, true)

      // Clear the local signed-out onboarding card (if any) before the evidence shots.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const dismissed = await dismissOverlays()
        if (!dismissed) break
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      await remoteFrame
        .evaluate(() => {
          const continueButton = Array.from(document.querySelectorAll('button')).find(
            (item) => (item.textContent ?? '').trim() === '继续',
          )
          if (continueButton) continueButton.click()
          const closers = Array.from(document.querySelectorAll('button[aria-label="关闭"], button[aria-label="Close"]'))
          for (const closer of closers) {
            let node = closer
            for (let depth = 0; depth < 5 && node; depth += 1) {
              if (/开始使用|Get started/.test(node.innerText ?? '')) {
                closer.click()
                break
              }
              node = node.parentElement
            }
          }
        })
        .catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 800))
      await page.screenshot({ path: path.join(ARTIFACTS, 'panel-remote-dsh.png') })
      await page.screenshot({ path: path.join(ARTIFACTS, 'panel-remote-dsh-full.png'), fullPage: true })

      report.steps.push({
        step: 'browser-iframe',
        ok: true,
        iframeSrcOrigin: tunnelOrigin,
        sandbox,
        remoteTitle: frameInfo.title,
        remoteNodes: frameInfo.nodes,
        remoteHasComposer: frameInfo.hasComposer,
        remoteNotice: noticed.hadNotice,
        remoteTextSample: frameInfo.text.slice(0, 120),
        authCookie: { name: authCookie.name, sameSite: authCookie.sameSite, httpOnly: authCookie.httpOnly },
        consoleErrors: consoleErrors.slice(0, 10),
        screenshots: [
          'settings-remote-section.png',
          'panel-workspace-rail.png',
          'panel-remote-dsh.png',
          'panel-remote-dsh-full.png',
        ],
      })
      t.diagnostic(`remote UI rendered in panel: ${frameInfo.title} (${frameInfo.nodes} nodes)`)

      // 4) cleanup: stop the remote web and remove the host
      const stopped = await api(control.origin, `/hosts/${hostId}/disconnect`, {
        method: 'POST',
        body: { stopRemote: true },
      })
      assert.equal(stopped.status, 200)
      const removed = await api(control.origin, `/hosts/${hostId}`, { method: 'DELETE' })
      assert.equal(removed.status, 200)
      const after = await api(control.origin, '/state')
      assert.equal(after.json.state.hosts.length, 0)
      report.steps.push({ step: 'cleanup', ok: true })
      report.ok = true
    } catch (error) {
      report.ok = false
      report.error = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
      throw error
    } finally {
      report.finishedAt = new Date().toISOString()
      // Best-effort cleanup so a failed run does not leave a remote DSH running.
      if (control && hostId) {
        try {
          await api(control.origin, `/hosts/${hostId}/disconnect`, { method: 'POST', body: { stopRemote: true } })
          await api(control.origin, `/hosts/${hostId}`, { method: 'DELETE' })
        } catch {
          /* control may already be gone */
        }
      }
      await writeReport(report).catch(() => {})
      if (browser) await browser.close().catch(() => {})
      if (control && !KEEP_CONTROL) await stopControlDsh(control.proc)
    }
  },
)

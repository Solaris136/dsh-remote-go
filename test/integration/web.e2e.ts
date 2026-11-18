import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { assertLightAndDark, assertMeasured, measureStable } from './browser-contrast.ts'
import {
  assertPackedDependency,
  describePage,
  makeTempRoot,
  packPlugin,
  pollUntil,
  resolveBrowser,
  resolveDshCli,
  resolvePnpm,
  runCommand,
  seedFixtureHost,
  skipOrFail,
  stopChild,
  tail,
  waitFor,
  writeFailureArtifacts,
} from './harness-support.ts'
import { dismissOpenDialog, openManageWindow } from './ui-steps.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** One plain GET against the isolated server, without the browser's cookie/console side effects. */
function httpRequest(origin, requestPath, onResponse, onError, headers = {}) {
  const url = new URL(requestPath, origin)
  return http
    .request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers },
      onResponse,
    )
    .on('error', onError)
}

const DIALOG_DISMISS_LABELS = [
  '继续',
  'Continue',
  '知道了',
  'Got it',
  '稍后配置',
  'Set up later',
  'Configure later',
  '稍后',
  'Later',
]

async function startWeb(options) {
  const timeoutMs = options.timeoutMs ?? 180_000
  const { spawn } = await import('node:child_process')
  const child = spawn(
    options.harness.command,
    [...options.harness.args, '--profile', 'web', '--no-open', '--port', '0'],
    { env: options.env, windowsHide: true, detached: process.platform !== 'win32' },
  )
  const logs = []
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  const url = await pollUntil(
    () => {
      const match = /dsh web:\s*(https?:\/\/\S+)/.exec(logs.join(''))
      if (match) return match[1]
      if (child.exitCode !== null) throw new Error(`dsh web exited early (${child.exitCode})\n${tail(logs)}`)
      return null
    },
    { timeoutMs, intervalMs: 100, label: 'dsh web readiness line' },
  ).catch(async (error) => {
    await stopChild(child)
    throw error
  })
  return { url, child, logs, stop: () => stopChild(child) }
}

const FIRST_RUN_SETTLE_MS = 800

async function firstRunSettled(page, settleMs = FIRST_RUN_SETTLE_MS) {
  const deadline = Date.now() + settleMs
  do {
    if (await page.$('[role="dialog"]')) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return true
}

async function dismissFirstRunDialogs(page) {
  let dismissed = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await firstRunSettled(page)) return dismissed
    dismissed += 1
    const closed = await dismissOpenDialog(page, { labels: DIALOG_DISMISS_LABELS })
    if (!closed) {
      throw new Error(
        `the first-run dialog did not close after a verified click: ${JSON.stringify(await describePage(page))}`,
      )
    }
  }
  return dismissed
}

test('dsh web renders the host-management window with legible buttons', { timeout: 900_000 }, async (t) => {
  const harness = resolveDshCli()
  if (!harness) {
    skipOrFail(
      t,
      'no DSH CLI found: set DSH_BIN/DSH_EXE (and DSH_EXE for an Electron install), install DeepSeek Harness, or put `dsh` on PATH',
    )
    return
  }
  const browserPath = resolveBrowser()
  if (!browserPath) {
    skipOrFail(t, 'no Chrome/Edge found: set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH')
    return
  }
  const tempRoot = makeTempRoot('dsh-web-e2e')
  const pnpm = resolvePnpm(path.join(tempRoot, 'pnpm-shim'))
  if (!pnpm.available) {
    skipOrFail(t, `cannot install the plugin into the profile: ${pnpm.reason}`)
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    return
  }
  const dshHome = path.join(tempRoot, 'home')
  const userDataDir = path.join(tempRoot, 'browser')
  mkdirSync(dshHome, { recursive: true })
  seedFixtureHost(dshHome)
  const childEnv = { ...process.env, DSH_HOME: dshHome }
  if (pnpm.pathPrefix) childEnv.PATH = `${pnpm.pathPrefix}${path.delimiter}${process.env.PATH ?? ''}`
  if (harness.command.toLowerCase().endsWith('.exe')) childEnv.ELECTRON_RUN_AS_NODE = '1'
  else delete childEnv.ELECTRON_RUN_AS_NODE
  let server = null
  let browser = null
  let page = null
  let consoleErrors = []
  const onSignal = (signal) => {
    void stopChild(server?.child).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const tarball = await packPlugin({
      pnpm: { command: pnpm.command, args: pnpm.args, shell: pnpm.shell },
      cwd: REPO_ROOT,
      env: childEnv,
      outDir: path.join(tempRoot, 'pack'),
    })
    const install = await runCommand(harness.command, [...harness.args, 'plugin', '--profile', 'web', 'add', tarball], {
      env: childEnv,
      timeoutMs: 300_000,
      label: 'dsh plugin add',
    })
    assert.equal(
      install.code,
      0,
      `installing the plugin failed (exit ${install.code})\n${tail(install.stdout, install.stderr)}`,
    )
    const dependency = assertPackedDependency(path.join(dshHome, 'profiles', 'web'))
    console.log(
      `[web-e2e] harness=${harness.kind} plugin=${path.basename(tarball)} dependency=${dependency} dsh=${process.env.DSH_VERSION ?? 'unknown'}`,
    )
    await t.test('the plugin is installed from the packed tarball, not a link', async () => {
      assert.match(path.basename(tarball), /^dsh-remote-go-\d+\.\d+\.\d+.*\.tgz$/)
      assert.match(dependency, /^file:.*\.tgz$/)
      assert.equal(dependency.startsWith('link:'), false)
    })
    server = await startWeb({ harness, env: childEnv })
    await t.test('the isolated dsh web serves a token URL', async () => {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{20,}$/)
      assert.ok(server.child.pid, 'the web process has no pid')
    })
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      userDataDir,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        `--lang=${process.env.DSH_E2E_LANG ?? 'en-US'}`,
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ],
    })
    page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 950 })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    await page.goto(server.url, { waitUntil: 'networkidle2', timeout: 120_000 })
    await t.test('the app shell loads and the launch token becomes a clean URL', async () => {
      await waitFor(page, () => !location.search.includes('token='), { timeout: 60_000 })
      assert.equal(new URL(page.url()).search, '')
      await waitFor(
        page,
        () => document.querySelector('[aria-label="账号菜单"], [aria-label="Account menu"]') !== null,
        { timeout: 60_000 },
      )
    })
    await t.test('the host API and the same-origin remote view seat are mounted', async () => {
      const origin = new URL(server.url).origin
      const probe = (requestPath, headers = {}) =>
        new Promise((resolve, reject) => {
          const request = httpRequest(
            origin,
            requestPath,
            (response) => {
              const chunks = []
              response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
              response.on('end', () =>
                resolve({
                  status: response.statusCode,
                  type: response.headers['content-type'] ?? '',
                  body: Buffer.concat(chunks).toString('utf8').slice(0, 160),
                }),
              )
            },
            reject,
            headers,
          )
          request.end()
        })
      // The liveness probe needs no browser session; it is still fenced by Host.
      const health = await probe('/dsh-remote-go/api/health')
      assert.equal(health.status, 200)
      assert.match(health.type, /application\/json/)
      // Every other route passes DSH admission first: a bare local client has no session and is
      // refused, while the GUI's own session reaches the proxy — which owns the prefix and 404s
      // unknown hosts instead of falling through to the SPA.
      const unauthenticated = await probe('/dsh-remote-go/remote/h_missing/')
      assert.equal(
        unauthenticated.status,
        401,
        `unauthenticated view seat: ${JSON.stringify(unauthenticated)}\n${tail(server.logs)}`,
      )
      const cookie = (await page.cookies()).map((entry) => `${entry.name}=${entry.value}`).join('; ')
      const view = await probe('/dsh-remote-go/remote/h_missing/', { cookie })
      assert.equal(view.status, 404, `remote view seat: ${JSON.stringify(view)}\n${tail(server.logs)}`)
      assert.match(view.type, /text\/plain/)
      assert.doesNotMatch(view.body, /DeepSeek Harness/)
    })
    await t.test('the host-management window mounts from the switcher row', async () => {
      await dismissFirstRunDialogs(page)
      try {
        await openManageWindow(page)
      } catch (error) {
        throw new Error(`${error?.message ?? error} — page: ${JSON.stringify(await describePage(page))}`)
      }
      assert.equal(
        await page.$('[data-testid="settings-remote-section"]'),
        null,
        'the plugin must not register a settings section',
      )
      const applied = await page.evaluate(() => {
        const window = document.querySelector('[data-testid="manage-window"]')
        if (!window) return { present: false }
        const dialog = window.querySelector('[role="dialog"]')
        const style = getComputedStyle(window)
        return {
          present: true,
          hasPluginClass: window.closest('.drg-root.drg-overlay') !== null,
          layer: style.getPropertyValue('--dsw-alias-bg-layer-2').trim(),
          radius: style.getPropertyValue('--dsw-radius-panel').trim(),
          dialogRadius: getComputedStyle(dialog).borderTopLeftRadius,
        }
      })
      assert.equal(applied.present, true)
      assert.equal(applied.hasPluginClass, true, 'the plugin root class is missing around the mounted window')
      assert.ok(applied.layer !== '', 'the host layer-2 token did not resolve (stylesheet missing)')
      assert.ok(applied.radius !== '', 'the host panel radius token did not resolve (stylesheet missing)')
      assert.equal(applied.dialogRadius, applied.radius, 'the host-management dialog must use the host panel radius')
    })
    await t.test('every button label is legible in light and dark mode', async () => {
      await assertLightAndDark(page, 'web')
    })
    await t.test('every theme token the plugin reads is published by the host', async () => {
      // The built artifact: the package-root `client.js` only exists between prepack and postpack.
      const source = await readFile(path.join(REPO_ROOT, 'dist', 'client.js'), 'utf8')
      const tokens = [...new Set([...source.matchAll(/--dsw-[a-z0-9-]+/g)].map((found) => found[0]))]
      assert.ok(
        tokens.length >= 30,
        `expected the client to read the theme vocabulary, found ${tokens.length} token(s)`,
      )
      const missing = await page.evaluate(
        (names) => {
          const window = document.querySelector('[data-testid="manage-window"]')
          if (window === null) return names
          const style = getComputedStyle(window)
          return names.filter((name) => style.getPropertyValue(name).trim() === '')
        },
        tokens.filter((name) => name !== '--dsw-focus-ring-color'),
      )
      assert.deepEqual(missing, [], `unresolved theme token(s): ${missing.join(', ')}`)
    })
    await t.test('a third-party theme’s token overrides reach the window and stay legible', async () => {
      const overrides = {
        '--dsw-alias-bg-base': '#1e2430',
        '--dsw-alias-bg-layer-1': '#242c3b',
        '--dsw-alias-bg-layer-2': '#2a3346',
        '--dsw-alias-bg-overlay': '#2a3346',
        '--dsw-alias-border-l1': 'rgb(255 255 255 / 8%)',
        '--dsw-alias-border-l2': 'rgb(255 255 255 / 13%)',
        '--dsw-alias-border-l3': 'rgb(255 255 255 / 18%)',
        '--dsw-alias-label-primary': '#eceff4',
        '--dsw-alias-label-secondary': '#c6cede',
        '--dsw-alias-label-tertiary': '#9aa7bd',
        '--dsw-alias-brand-primary': '#88c0d0',
        '--dsw-alias-button-primary-fill': '#88c0d0',
        '--dsw-alias-button-primary-hover': '#9fd0de',
        '--dsw-alias-label-primary-foreground': '#10202f',
        '--dsw-alias-state-success-primary': '#a3be8c',
        '--dsw-alias-state-warn-primary': '#ebcb8b',
        '--dsw-alias-state-error-primary': '#bf616a',
        '--dsw-alias-interactive-bg-hover': 'rgb(255 255 255 / 7%)',
      }
      const paintOf = async (value) =>
        await page.evaluate((tokenValue) => {
          const probe = document.createElement('div')
          probe.style.background = tokenValue
          document.body.appendChild(probe)
          const resolved = getComputedStyle(probe).backgroundColor
          probe.remove()
          return resolved
        }, value)
      const before = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="manage-window"] [role="dialog"]')
        return getComputedStyle(dialog).backgroundColor
      })
      await page.evaluate((tokens) => {
        for (const [name, value] of Object.entries(tokens)) document.body.style.setProperty(name, value)
      }, overrides)
      try {
        const expectedSurface = await paintOf(overrides['--dsw-alias-bg-layer-2'])
        const expectedLabel = await paintOf(overrides['--dsw-alias-label-primary'])
        const painted = await page.evaluate(() => {
          const dialog = document.querySelector('[data-testid="manage-window"] [role="dialog"]')
          const title = document.querySelector('[data-testid="manage-window"] .drg-page-title')
          return { surface: getComputedStyle(dialog).backgroundColor, label: getComputedStyle(title).color }
        })
        assert.equal(
          painted.surface,
          expectedSurface,
          'the window background did not follow the overridden layer-2 token',
        )
        assert.equal(painted.label, expectedLabel, 'the page title did not follow the overridden label token')
        const measured = await assertMeasured(await measureStable(page, { scheme: 'dark' }), 'dark/third-party')
        assert.notEqual(
          measured.sectionBackground,
          before,
          'the management window did not repaint for the third-party theme',
        )
      } finally {
        await page.evaluate((names) => {
          for (const name of names) document.body.style.removeProperty(name)
        }, Object.keys(overrides))
      }
      await waitFor(
        page,
        (previous) => {
          const dialog = document.querySelector('[data-testid="manage-window"] [role="dialog"]')
          return dialog !== null && getComputedStyle(dialog).backgroundColor === previous
        },
        { timeout: 15_000 },
        before,
      )
      await assertMeasured(await measureStable(page, { scheme: 'dark' }), 'dark/restored')
    })
    await t.test('loading the app and the host-management window logged no console errors', async () => {
      assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join('\n')}`)
    })
  } catch (error) {
    await writeFailureArtifacts({
      dir: process.env.DSH_WEB_E2E_ARTIFACTS ?? null,
      page,
      logs: server?.logs ?? [],
      consoleErrors,
      error,
      name: 'web-e2e',
    })
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) await server.stop()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

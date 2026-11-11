/**
 * Real-installation acceptance for the **Electron desktop shell** (Windows).
 *
 * Why a separate suite: the desktop app is not on npm (no `@deepseek-ai/dsh-desktop`
 * package) and ships no Linux build, so it cannot ride the `dsh web` job. It is
 * installed from the official installer and driven over the Chrome DevTools
 * Protocol, asserting the same contrast rules as the web suite.
 *
 * Three facts make this flow work, each verified against the real app:
 *
 * 1. `dsh plugin --profile desktop add …` is **refused** — the CLI owns only
 *    non-desktop profiles ("profile \"desktop\" is managed exclusively by the
 *    Electron application"). The profile is therefore hand-crafted:
 *    `<DSH_HOME>/profiles/desktop/package.json` with the `dsh.profile.bundles`
 *    list and a `file:<tgz>` dependency, followed by `pnpm install
 *    --ignore-scripts` inside that directory. The install is REQUIRED: without a
 *    `node_modules` tree the client half never loads.
 * 2. The app must NOT inherit `ELECTRON_RUN_AS_NODE` from the environment, or it
 *    runs as plain Node and rejects `--user-data-dir`/`--remote-debugging-port`
 *    with "bad option". The launcher strips it.
 * 3. `[data-dsh-remote-go="styles"]` is absent in this shell even though the
 *    styles are applied, so loaded-ness is asserted behaviourally (plugin class +
 *    resolved CSS custom properties), never by that marker.
 *
 * Determinism: no fixed sleeps — onboarding, CDP readiness and every navigation
 * step are bounded polls on a state that provably changes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { assertMeasured, measureStable } from './browser-contrast.js'
import {
  isWindows,
  makeTempRoot,
  packPlugin,
  pollUntil,
  resolveDesktopApp,
  resolvePnpm,
  skipOrFail,
  stopChild,
  tail,
  writeFailureArtifacts,
} from './harness-support.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const ACCOUNT_MENU_SELECTOR = '[aria-label="账号菜单"], [aria-label="Account menu"], [aria-label="账号"]'
const SETTINGS_LABELS = ['设置', 'Settings']
const REMOTE_HOSTS_LABELS = ['远程主机', 'Remote hosts', 'Remote Hosts']
// The onboarding affordance is localised. "Set up later" is what the shipped app renders in
// English (observed on the Windows runner); "Configure later" was an assumption that made the
// first CI run time out, so both spellings (and the Chinese one) are accepted.
const ONBOARDING_LABELS = ['稍后配置', 'Set up later', 'Configure later', '稍后', 'Later']

/**
 * The bundles the desktop profile must mount. `@deepseek-ai/dsh-base` and
 * `@deepseek-ai/dsh-web-app` are provided by the app itself; `dsh-remote-go` is
 * this plugin, installed from the packed tarball.
 */
const DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-go']

/** @returns {Promise<number>} an ephemeral port the OS just handed out */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Hand-craft the desktop profile, then install it.
 *
 * See the file header: the CLI refuses to touch the `desktop` profile, and the
 * `pnpm install` is what makes the client half loadable.
 * @param {{ dshHome: string, tarball: string, pnpm: { command: string, args: string[], shell: boolean }, env: Record<string, string | undefined>, runCommand: typeof import('./harness-support.js').runCommand }} input
 */
async function installDesktopProfile(input) {
  const profileDir = path.join(input.dshHome, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dsh: { profile: { bundles: DESKTOP_BUNDLES } },
    dependencies: { 'dsh-remote-go': `file:${input.tarball.replace(/\\/g, '/')}` },
  }
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const install = await input.runCommand(input.pnpm.command, [...input.pnpm.args, 'install', '--ignore-scripts'], {
    cwd: profileDir,
    env: input.env,
    timeoutMs: 600_000,
    label: 'pnpm install (desktop profile)',
    shell: input.pnpm.shell,
  })
  assert.equal(
    install.code,
    0,
    `installing the plugin into the desktop profile failed (exit ${install.code})\n${tail(install.stdout, install.stderr)}`,
  )
  const installed = path.join(profileDir, 'node_modules', 'dsh-remote-go', 'client.js')
  assert.equal(existsSync(installed), true, `the desktop profile install is missing client.js at ${installed}`)
  return profileDir
}

/**
 * Launch the desktop app with an isolated profile and a CDP endpoint.
 * @param {{ exe: string, dshHome: string, userDataDir: string, port: number, env: Record<string, string | undefined> }} input
 */
function launchDesktop(input) {
  /** The app must be a real Electron app: never inherit run-as-node. */
  const env = { ...input.env, DSH_HOME: input.dshHome }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(input.exe, [`--user-data-dir=${input.userDataDir}`, `--remote-debugging-port=${input.port}`], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  /** @type {string[]} */
  const logs = []
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  return { child, logs, stop: () => stopChild(child) }
}

/**
 * Activate an element through the DOM.
 *
 * A DOM `click()` rather than a synthetic mouse click: the Electron window can be
 * unfocused or occluded (headful app on a session with no visible desktop), which
 * makes puppeteer's hit-testing fail with "Node is either not clickable". Verified
 * against the real shell: the account-menu items respond to a DOM click.
 *
 * Runs inside the page through `elementHandle.evaluate`, which passes the element
 * as the first argument; it therefore must not close over module scope.
 * @param {Element} node
 */
function activateElement(node) {
  node.click()
  return true
}

/**
 * Wait for the DevTools endpoint, then attach.
 *
 * `protocolTimeout` is generous: the Electron renderer runs the whole app on the
 * same thread, and a cold profile can block a `Runtime.callFunctionOn` for tens of
 * seconds while plugins load.
 * @param {{ port: number, timeoutMs?: number }} options
 */
async function connectOverCdp(options) {
  const version = await pollUntil(
    async () => {
      const response = await fetch(`http://127.0.0.1:${options.port}/json/version`).catch(() => null)
      return response && response.ok ? await response.json() : null
    },
    { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: 500, label: 'Electron DevTools endpoint' },
  )
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${options.port}`,
    protocolTimeout: 240_000,
  })
  return { browser, version }
}

/**
 * Find a page whose URL matches, polling because Electron opens windows lazily.
 * @param {import('puppeteer-core').Browser} browser
 * @param {(url: string) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function findPage(browser, predicate, timeoutMs) {
  return await pollUntil(
    async () => {
      const pages = await browser.pages()
      return pages.find((page) => predicate(page.url())) ?? null
    },
    { timeoutMs, intervalMs: 300, label: 'a matching renderer page' },
  )
}

/** The onboarding window of a fresh profile (`…/renderer/welcome.html`). */
const isWelcomeUrl = (url) => url.includes('welcome.html')
/** The app window. */
const isAppUrl = (url) => url.startsWith('dsh-app://')

/**
 * Skip onboarding with "configure later", which needs no credentials.
 *
 * The welcome screen is a separate `file://` window; it is optional (an already
 * onboarded profile never shows it), so absence is not an error.
 * @param {import('puppeteer-core').Browser} browser
 * @param {string[]} consoleErrors
 * @returns {Promise<boolean>} whether onboarding was dismissed
 */
async function dismissOnboarding(browser, consoleErrors) {
  const welcome = await findPage(browser, isWelcomeUrl, 90_000).catch(() => null)
  if (!welcome) return false
  welcome.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`welcome: ${message.text()}`)
  })
  const clicked = await pollUntil(
    async () => {
      const handle = await welcome
        .evaluateHandle((rawLabels) => {
          const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
          // Normalise the candidates too: DOM text is whitespace-stripped before the
          // comparison, so a label such as "Set up later" would otherwise never equal
          // the stripped "Setuplater" and every English run would time out.
          const labels = rawLabels.map(strip)
          // The onboarding affordance is a <button> locally but need not be one: accept any
          // clickable-looking node so a markup change in the app does not strand the run.
          const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], div, span')]
          const exact = candidates.find((node) => labels.includes(strip(node.textContent)))
          const partial = candidates.find((node) => labels.some((label) => strip(node.textContent).startsWith(label)))
          return exact ?? partial ?? null
        }, ONBOARDING_LABELS)
        .catch(() => null)
      const element = handle?.asElement()
      if (!element) return null
      await element.evaluate(activateElement)
      return ONBOARDING_LABELS[0]
    },
    {
      timeoutMs: 60_000,
      intervalMs: 400,
      label: 'the "configure later" onboarding button',
      // A timeout here is otherwise undiagnosable from the log alone: dump what the window
      // actually shows (url, title, and every visible label) so the next run explains itself.
      diagnose: async () => {
        const snapshot = await welcome
          .evaluate(() => ({
            url: location.href,
            title: document.title,
            text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400),
            labels: [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')]
              .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 30),
          }))
          .catch((error) => ({ error: String(error?.message ?? error) }))
        return `onboarding window: ${JSON.stringify(snapshot)}`
      },
    },
  )
  // Wait for the onboarding window to close (it is the observable effect).
  await pollUntil(
    async () => {
      const pages = await browser.pages()
      return pages.some((page) => isWelcomeUrl(page.url())) ? null : true
    },
    { timeoutMs: 60_000, intervalMs: 300, label: 'the onboarding window to close' },
  )
  return Boolean(clicked)
}

/** @param {import('puppeteer-core').Page} page @param {string} selector @param {number} [timeout] */
async function waitForSelector(page, selector, timeout = 60_000) {
  await page.waitForSelector(selector, { visible: true, timeout })
}

/** @param {import('puppeteer-core').Page} page @param {string[]} labels */
async function clickByText(page, labels) {
  const handle = await page.evaluateHandle((list) => {
    const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
    const nodes = [
      ...document.querySelectorAll('button, [role="menuitem"], [role="button"], [role="tab"], a, li, div, span'),
    ]
    for (const candidate of list) {
      const matches = nodes.filter((node) => strip(node.textContent) === candidate)
      if (matches.length === 0) continue
      const target = matches.sort(
        (left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length,
      )[0]
      // The menu item is a styled `div` wrapping the label span, so `div` must be
      // part of the nearest-clickable walk (verified against the real shell).
      return target.closest('button, [role="menuitem"], [role="button"], [role="tab"], a, li, div') ?? target
    }
    return null
  }, labels)
  const element = handle.asElement()
  if (!element) return null
  await element.evaluate(activateElement)
  return labels[0]
}

/** @param {import('puppeteer-core').Page} page @param {string[]} labels */
async function clickByAriaLabel(page, labels) {
  const handle = await page.evaluateHandle((list) => {
    for (const label of list) {
      const node = document.querySelector(`[aria-label="${label}"]`)
      if (node) return node
    }
    return null
  }, labels)
  const element = handle.asElement()
  if (!element) return null
  await element.evaluate(activateElement)
  return labels[0]
}

/**
 * A compact description of the renderer state, used in failure messages so a red
 * CI job is actionable without a re-run.
 * @param {import('puppeteer-core').Page} page
 */
async function describePage(page) {
  return await page
    .evaluate(() => {
      const strip = (value) => (value ?? '').replace(/\s+/g, ' ').trim()
      const labels = [...document.querySelectorAll('button, [role="menuitem"], [role="tab"], a')]
        .map((node) => strip(node.getAttribute('aria-label') ?? node.textContent))
        .filter(Boolean)
        .slice(0, 40)
      return {
        url: location.href,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        section: Boolean(document.querySelector('[data-testid="settings-remote-section"]')),
        text: strip(document.body?.innerText).slice(0, 300),
        labels,
      }
    })
    .catch((error) => ({ error: String(error).slice(0, 200) }))
}

/**
 * Account menu -> Settings -> Remote hosts, bounded at every step and reporting
 * the renderer state when a step times out.
 *
 * The whole sequence is retried: right after onboarding the shell is still
 * attaching handlers, and a click on "Settings" can be swallowed (observed:
 * `dialogs: 0` after the click). Each attempt is bounded by a wait on the state
 * that must change, so a retry never turns into a fixed sleep.
 * @param {import('puppeteer-core').Page} page
 */
async function openRemoteHostsSection(page) {
  await waitForSelector(page, ACCOUNT_MENU_SELECTOR, 120_000)
  /** @type {string | null} */
  let lastState = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.$('[data-testid="settings-remote-section"]')) return
    if (!(await page.$('[role="dialog"]'))) {
      const menu = await clickByAriaLabel(page, ['账号菜单', 'Account menu', '账号', 'Account'])
      if (!menu) {
        lastState = JSON.stringify(await describePage(page))
        continue
      }
    }
    const hasSettings = await page
      .waitForFunction(
        () => {
          const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
          return [...document.querySelectorAll('*')].some((node) => {
            const text = strip(node.textContent)
            return (text === '设置' || text === 'Settings') && node.children.length <= 2
          })
        },
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false)
    if (!hasSettings) {
      lastState = JSON.stringify(await describePage(page))
      await page.keyboard.press('Escape').catch(() => {})
      continue
    }
    await clickByText(page, SETTINGS_LABELS)
    const navReady = await page
      .waitForFunction(
        (labels) => {
          const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
          return [...document.querySelectorAll('*')].some((node) => {
            const text = strip(node.textContent)
            return labels.includes(text) && node.children.length <= 3
          })
        },
        { timeout: 30_000, polling: 200 },
        REMOTE_HOSTS_LABELS,
      )
      .then(() => true)
      .catch(() => false)
    if (!navReady) {
      lastState = JSON.stringify(await describePage(page))
      await page.keyboard.press('Escape').catch(() => {})
      continue
    }
    const nav = await clickByText(page, REMOTE_HOSTS_LABELS)
    if (!nav) {
      lastState = JSON.stringify(await describePage(page))
      continue
    }
    const mounted = await page
      .waitForSelector('[data-testid="settings-remote-section"]', { visible: true, timeout: 60_000 })
      .then(() => true)
      .catch(() => false)
    if (mounted) return
    lastState = JSON.stringify(await describePage(page))
  }
  throw new Error(
    `could not reach the Remote-hosts section in the desktop shell after 5 attempts; last state: ${lastState ?? '(none)'}`,
  )
}

/**
 * Flip the shell's colour scheme and wait for the repaint.
 * @param {import('puppeteer-core').Page} page
 * @param {'light' | 'dark'} scheme
 * @param {string | null} previousBodyBackground
 */
async function applyColorScheme(page, scheme, previousBodyBackground) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
  if (previousBodyBackground) {
    await page
      .waitForFunction(
        (previous) => getComputedStyle(document.body).backgroundColor !== previous,
        { timeout: 20_000 },
        previousBodyBackground,
      )
      .catch(() => {})
  }
}

test('the desktop shell renders the plugin settings with legible buttons', { timeout: 1_200_000 }, async (t) => {
  if (!isWindows) {
    skipOrFail(t, 'the desktop installer exists for Windows and macOS only; there is no Linux build')
    return
  }
  const exe = resolveDesktopApp()
  if (!exe) {
    skipOrFail(t, 'no Electron desktop app found: install it, or set DSH_DESKTOP_EXE / DSH_DESKTOP_INSTALL_DIR')
    return
  }
  const tempRoot = makeTempRoot('dsh-desktop-e2e')
  const pnpm = resolvePnpm(path.join(tempRoot, 'pnpm-shim'))
  if (!pnpm.available) {
    skipOrFail(t, `cannot install the plugin into the desktop profile: ${pnpm.reason}`)
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    return
  }

  const dshHome = path.join(tempRoot, 'home')
  const userDataDir = path.join(tempRoot, 'userdata')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  const childEnv = { ...process.env, DSH_HOME: dshHome }
  if (pnpm.pathPrefix) childEnv.PATH = `${pnpm.pathPrefix}${path.delimiter}${process.env.PATH ?? ''}`
  const { runCommand } = await import('./harness-support.js')
  const { desktopAppVersion } = await import('./harness-support.js')

  /** @type {{ child: import('node:child_process').ChildProcess, logs: string[], stop: () => Promise<void> } | null} */
  let app = null
  /** @type {import('puppeteer-core').Browser | null} */
  let browser = null
  /** @type {import('puppeteer-core').Page | null} */
  let page = null
  /** @type {any} */
  let lightMeasurement = null
  /** @type {string[]} */
  const consoleErrors = []
  const onSignal = (signal) => {
    void stopChild(app?.child).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
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
    const version = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' },
    })
    void version
    console.log(
      `[desktop-e2e] app=${exe} appVersion=${desktopAppVersion(exe) ?? 'unknown'} plugin=${path.basename(tarball)}`,
    )

    await t.test('the desktop profile installs the packed plugin by hand', async () => {
      const profileDir = await installDesktopProfile({
        dshHome,
        tarball,
        pnpm: { command: pnpm.command, args: pnpm.args, shell: pnpm.shell },
        env: childEnv,
        runCommand,
      })
      assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-remote-go', 'index.js')), true)
    })

    const port = await freePort()
    app = launchDesktop({ exe, dshHome, userDataDir, port, env: childEnv })
    const connected = await connectOverCdp({ port })
    browser = connected.browser
    console.log(`[desktop-e2e] chromium=${connected.version?.Browser ?? 'unknown'} cdpPort=${port}`)

    await t.test('the renderer runs the plugin and reaches the Remote-hosts section', async () => {
      // A fresh profile opens a separate welcome window; "configure later" needs no
      // credentials and hands control to the app window.
      const skipped = await dismissOnboarding(browser, consoleErrors)
      console.log(`[desktop-e2e] onboarding ${skipped ? 'dismissed with "configure later"' : 'not shown'}`)

      page = await findPage(browser, isAppUrl, 180_000)
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
      await page.setViewport({ width: 1400, height: 950 }).catch(() => {})

      await openRemoteHostsSection(page)
      const applied = await page.evaluate(() => {
        const section = document.querySelector('[data-testid="settings-remote-section"]')
        if (!section) return { present: false }
        const style = getComputedStyle(section)
        return {
          present: true,
          hasPluginClass: section.className.includes('drg-settings-remote'),
          primary: style.getPropertyValue('--drg-primary').trim(),
        }
      })
      assert.equal(applied.present, true, 'the Remote-hosts section did not mount in the desktop shell')
      assert.equal(applied.hasPluginClass, true, 'the plugin class is missing on the desktop section')
      assert.ok(applied.primary !== '', 'the plugin styles did not apply in the desktop shell')
    })

    await t.test('every button label is legible in light mode', async () => {
      await applyColorScheme(page, 'light', null)
      lightMeasurement = await assertMeasured(await measureStable(page, { scheme: 'light' }), 'desktop light')
      assert.equal(lightMeasurement.scheme, 'light')
    })

    await t.test('every button label is legible in dark mode', async () => {
      assert.ok(lightMeasurement, 'the light measurement did not run')
      await applyColorScheme(page, 'dark', lightMeasurement.bodyBackground)
      const dark = await assertMeasured(
        await measureStable(page, { scheme: 'dark', previousBodyBackground: lightMeasurement.bodyBackground }),
        'desktop dark',
      )
      assert.notEqual(dark.bodyBackground, lightMeasurement.bodyBackground, 'the shell did not switch theme')
      assert.notEqual(dark.sectionBackground, lightMeasurement.sectionBackground, 'the section did not switch theme')
    })

    await t.test('the shell logged no console errors while rendering the section', async () => {
      assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join('\n')}`)
    })
  } catch (error) {
    await writeFailureArtifacts({
      dir: process.env.DSH_DESKTOP_E2E_ARTIFACTS ?? null,
      page,
      logs: app?.logs ?? [],
      consoleErrors,
      error,
      name: 'desktop-e2e',
    })
    throw error
  } finally {
    if (browser) await browser.disconnect().catch(() => {})
    if (app) await app.stop()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

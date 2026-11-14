/**
 * Real-browser acceptance for **web compatibility of the host-management window**
 * (the desktop shell has its own suite: `desktop.e2e.js`).
 *
 * What it does:
 * 1. packs this repository (`pnpm pack`) and installs that **tarball** into an
 *    isolated `dsh web` profile — a packaging bug (`files[]`/`exports` drift, a
 *    missing `client.js`) fails here instead of shipping;
 * 2. boots `dsh web` on an ephemeral port with a temporary `DSH_HOME`;
 * 3. drives the real UI with Chrome: sidebar switcher row → Manage hosts;
 * 4. asserts the window mounts with every button label legible (WCAG contrast
 *    >= 3, alpha/opacity aware, gradients refused) in **light and dark** mode,
 *    and that the page logged no console errors. The plugin registers no settings
 *    page, so the settings surface is also checked to be free of it.
 *
 * Calibration: with the pre-#10 `client.js` (a single-class `.drg-btn-primary`
 * rule that lost the cascade) the primary buttons measure ratio **1.0**; the fixed
 * build measures 11.57–18.9. That is why both the button colour and the
 * `.drg-btn-label` element are graded.
 *
 * Determinism: every wait is a bounded poll (`page.waitForFunction` or
 * `pollUntil`) on a state that provably changes — no fixed sleep before a click.
 *
 * Strictness: `DSH_E2E_STRICT=1` (CI, required check) makes a missing
 * harness/browser/pnpm a failure; locally the same file skips those, keeping
 * `pnpm run verify` green on a bare machine.
 *
 * Not duplicated here: the "client bundle ships no Electron-only API" rule is
 * enforced by test/unit/client.test.js, and the `[data-dsh-remote-go="styles"]`
 * marker is deliberately NOT used as a "loaded" signal (the desktop shell applies
 * the same styles without it) — a resolved plugin CSS custom property is used
 * instead.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { assertMeasured, measureStable } from './browser-contrast.js'
import { dismissOpenDialog } from './activation.js'
import {
  assertPackedDependency,
  describePage,
  makeTempRoot,
  packPlugin,
  pollUntil,
  sleep,
  resolveBrowser,
  resolveDshCli,
  resolvePnpm,
  runCommand,
  skipOrFail,
  stopChild,
  tail,
  writeFailureArtifacts,
} from './harness-support.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** First-run dialog buttons: any of these dismisses the overlay (both sides normalised). */
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

/**
 * Boot `dsh web` and resolve once it prints its readiness line.
 * @param {{ harness: { command: string, args: string[] }, env: Record<string, string | undefined>, timeoutMs?: number }} options
 */
async function startWeb(options) {
  const timeoutMs = options.timeoutMs ?? 180_000
  const { spawn } = await import('node:child_process')
  const child = spawn(
    options.harness.command,
    [...options.harness.args, '--profile', 'web', '--no-open', '--port', '0'],
    // Detached on POSIX so the whole process group can be killed; Windows uses
    // `taskkill /T` (detaching there would pop a console window).
    { env: options.env, windowsHide: true, detached: process.platform !== 'win32' },
  )
  /** @type {string[]} */
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

/** @param {import('puppeteer-core').Page} page @param {string} selector @param {number} [timeout] */
async function waitForSelector(page, selector, timeout = 60_000) {
  await page.waitForSelector(selector, { visible: true, timeout })
}

/**
 * All label matching goes through this rule: fold the candidates **and** the node
 * text the same way (`.replace(/\s+/g, '').trim()`), inside the page function.
 *
 * Doing it on one side only is a trap that hides an entire locale: `strip('Remote
 * hosts')` is `'Remotehosts'`, which never equals the unstripped `'Remote hosts'`.
 * That is exactly why this suite passed in Chinese (no spaces to strip) while every
 * English run failed to find the nav row.
 */

/**
 * How long the page must stay free of dialogs before the first-run sequence counts as
 * finished. A fresh profile shows **two** overlays back to back (Preview Notice, then
 * the Get-started sign-in prompt); the second mounts a moment after the first closes,
 * so an instant "no dialog" check lets it land after the caller has already moved on.
 */
const FIRST_RUN_SETTLE_MS = 800

/**
 * Is the first-run sequence over? Only after a quiet window, so a queued follow-up
 * overlay has time to mount and be dismissed by the next loop iteration.
 * @param {import('puppeteer-core').Page} page
 * @param {number} [settleMs]
 * @returns {Promise<boolean>}
 */
async function firstRunSettled(page, settleMs = FIRST_RUN_SETTLE_MS) {
  const deadline = Date.now() + settleMs
  do {
    if (await page.$('[role="dialog"]')) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return true
}

/**
 * Dismiss the first-run overlays (preview notice, sign-in prompt). They arrive in
 * sequence and a later one may appear after an earlier dismissal, so this only
 * returns once the page has been dialog-free for a settle window.
 *
 * Every dismissal is a DOM click **inside the dialog** and counts only once the dialog
 * is actually gone (`dismissOpenDialog`): no coordinate click (an overlay swallows
 * those silently) and no reliance on a blanket hit-test veto, which would refuse to
 * click a dialog's own close affordance because the dialog's backdrop resolves on top.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<number>} how many dismissal actions were taken
 */
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

/**
 * Open the plugin's floating host-management window from the sidebar switcher row.
 *
 * The plugin registers no settings page — the switcher row is its only entry — so the
 * test drives the same path a user does: click the row, then "Manage hosts". Both
 * clicks are DOM clicks, and the step completes only when the window and its host list
 * have a layout box; failures carry the panel state instead of a bare timeout.
 * @param {import('puppeteer-core').Page} page
 */
async function openManageWindow(page) {
  await dismissFirstRunDialogs(page)
  await waitForSelector(page, '#drg-host-row')
  const opened = await page.evaluate(() => {
    const row = document.getElementById('drg-host-row')
    if (!row) return { error: 'the switcher row is missing' }
    row.click()
    const item = row.querySelector('.drg-hr-item[data-action="manage"]')
    if (!item) return { error: 'the switcher menu has no manage row' }
    item.click()
    return { ok: true }
  })
  if (!opened.ok) throw new Error(`could not open host management: ${opened.error}`)
  await page.waitForSelector('[data-testid="manage-window"]', { visible: true, timeout: 60_000 })
  await page.waitForSelector('[data-testid="host-list-empty"], [data-testid="host-list"]', {
    visible: true,
    timeout: 60_000,
  })
}

/**
 * Switch the emulated colour scheme and wait until the shell has actually
 * repainted (the body background changed), instead of sleeping.
 * @param {import('puppeteer-core').Page} page
 * @param {'light' | 'dark'} scheme
 * @param {string | null} previousBodyBackground
 */
async function applyColorScheme(page, scheme, previousBodyBackground) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
  await page.waitForFunction(
    (value) => matchMedia(`(prefers-color-scheme: ${value})`).matches,
    { timeout: 15_000 },
    scheme,
  )
  if (previousBodyBackground) {
    await page
      .waitForFunction(
        (previous) => getComputedStyle(document.body).backgroundColor !== previous,
        { timeout: 15_000 },
        previousBodyBackground,
      )
      .catch(() => {})
  }
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
  /** @type {Record<string, string | undefined>} */
  const childEnv = { ...process.env, DSH_HOME: dshHome }
  if (pnpm.pathPrefix) childEnv.PATH = `${pnpm.pathPrefix}${path.delimiter}${process.env.PATH ?? ''}`
  if (harness.command.toLowerCase().endsWith('.exe')) childEnv.ELECTRON_RUN_AS_NODE = '1'
  else delete childEnv.ELECTRON_RUN_AS_NODE

  /** @type {Awaited<ReturnType<typeof startWebChild>> | null} */
  let server = null
  /** @type {import('puppeteer-core').Browser | null} */
  let browser = null
  /** @type {import('puppeteer-core').Page | null} */
  let page = null
  /** @type {any} */
  let lightMeasurement = null
  /** @type {string[]} */
  let consoleErrors = []
  const onSignal = (signal) => {
    void stopChild(server?.child).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    // A REAL installation: pack the publishable artifact and install that tarball.
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
        // Force one UI language so the run cannot depend on the machine's locale: CI
        // is en-US, and a developer machine may be anything. `DSH_E2E_LANG` overrides
        // it (both `en-US` and `zh-CN` must pass — the labels are normalised).
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
      await page.waitForFunction(() => !location.search.includes('token='), { timeout: 60_000 })
      assert.equal(new URL(page.url()).search, '')
      await page.waitForFunction(
        () => document.querySelector('[aria-label="账号菜单"], [aria-label="Account menu"]') !== null,
        { timeout: 60_000 },
      )
    })

    await t.test('the host-management window mounts from the switcher row', async () => {
      await dismissFirstRunDialogs(page)
      try {
        await openManageWindow(page)
      } catch (error) {
        // Without this, a navigation failure is undiagnosable from the log alone (the first
        // CI runs failed here with nothing but "TimeoutError"). Report what the UI shows.
        const snapshot = await page
          .evaluate(() => ({
            url: location.href,
            dialogs: [...document.querySelectorAll('[role="dialog"]')]
              .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160))
              .slice(0, 4),
            labels: [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')]
              .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 40),
            body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
          }))
          .catch((inspectError) => ({ error: String(inspectError?.message ?? inspectError) }))
        throw new Error(`${error?.message ?? error} — page: ${JSON.stringify(snapshot)}`)
      }
      // The plugin owns no settings page: the settings surface must not carry one.
      assert.equal(
        await page.$('[data-testid="settings-remote-section"]'),
        null,
        'the plugin must not register a settings section',
      )
      // Behaviour, not a marker: the plugin's stylesheet is proven applied when its
      // own class and CSS custom properties resolve on the mounted window. (The
      // `[data-dsh-remote-go="styles"]` element is NOT reliable — the desktop shell
      // applies the same styles without it.)
      const applied = await page.evaluate(() => {
        const window = document.querySelector('[data-testid="manage-window"]')
        if (!window) return { present: false }
        const style = getComputedStyle(window)
        return {
          present: true,
          hasPluginClass: window.closest('.drg-root.drg-overlay') !== null,
          primary: style.getPropertyValue('--drg-primary').trim(),
          radius: style.getPropertyValue('--drg-radius-sm').trim(),
        }
      })
      assert.equal(applied.present, true)
      assert.equal(applied.hasPluginClass, true, 'the plugin root class is missing around the mounted window')
      assert.ok(applied.primary !== '', 'the plugin CSS custom properties did not resolve (stylesheet missing)')
      assert.ok(applied.radius !== '', 'the plugin CSS custom properties did not resolve (stylesheet missing)')
    })

    await t.test('every button label is legible in light mode', async () => {
      await applyColorScheme(page, 'light', null)
      lightMeasurement = await assertMeasured(await measureStable(page, { scheme: 'light' }), 'light')
      assert.equal(lightMeasurement.scheme, 'light')
    })

    await t.test('every button label is legible in dark mode', async () => {
      assert.ok(lightMeasurement, 'the light measurement did not run')
      await applyColorScheme(page, 'dark', lightMeasurement.bodyBackground)
      const dark = await assertMeasured(
        await measureStable(page, {
          scheme: 'dark',
          previousBodyBackground: lightMeasurement.bodyBackground,
        }),
        'dark',
      )
      assert.equal(dark.scheme, 'dark')
      // "Not white" is not "changed": compare against the light measurement.
      assert.notEqual(
        dark.bodyBackground,
        lightMeasurement.bodyBackground,
        'the app shell background did not change between light and dark mode',
      )
      assert.notEqual(
        dark.sectionBackground,
        lightMeasurement.sectionBackground,
        'the host-management window background did not change between light and dark mode',
      )
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
    // A Windows EBUSY here must never replace the real assertion error.
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

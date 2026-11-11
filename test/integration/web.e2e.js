/**
 * Real-browser acceptance for **web compatibility of the Remote-hosts settings
 * section** (the desktop shell has its own suite: `desktop.e2e.js`).
 *
 * What it does:
 * 1. packs this repository (`pnpm pack`) and installs that **tarball** into an
 *    isolated `dsh web` profile — a packaging bug (`files[]`/`exports` drift, a
 *    missing `client.js`) fails here instead of shipping;
 * 2. boots `dsh web` on an ephemeral port with a temporary `DSH_HOME`;
 * 3. drives the real UI with Chrome: account menu → Settings → Remote hosts;
 * 4. asserts the section mounts with every button label legible (WCAG contrast
 *    >= 3, alpha/opacity aware, gradients refused) in **light and dark** mode,
 *    and that the page logged no console errors.
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
import {
  assertPackedDependency,
  makeTempRoot,
  packPlugin,
  pollUntil,
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

const ACCOUNT_MENU_SELECTOR = '[aria-label="账号菜单"], [aria-label="Account menu"], [aria-label="账号"]'
const ACCOUNT_MENU_LABELS = ['账号菜单', 'Account menu', '账号', 'Account']
const SETTINGS_LABELS = ['设置', 'Settings']
const REMOTE_HOSTS_LABELS = ['远程主机', 'Remote hosts', 'Remote Hosts']

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
 * Tag the deepest element whose normalised text equals a normalised candidate, then
 * activate it. Deepest wins: the label span, not its wrapper.
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} candidates
 * @returns {Promise<string | null>}
 */
async function clickByText(page, candidates) {
  const matched = await page.evaluate((list) => {
    const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
    const wanted = list.map(strip)
    const nodes = [
      ...document.querySelectorAll('button, [role="menuitem"], [role="button"], [role="tab"], a, li, div, span'),
    ]
    for (const candidate of wanted) {
      const matches = nodes.filter((node) => strip(node.textContent) === candidate)
      if (matches.length === 0) continue
      const target = matches.sort(
        (left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length,
      )[0]
      const clickable = target.closest('button, [role="menuitem"], [role="button"], [role="tab"], a, li') ?? target
      clickable.setAttribute('data-web-e2e-click', '1')
      return candidate
    }
    return null
  }, candidates)
  if (!matched) return null
  // DOM-dispatched activation: a coordinate click is swallowed by any overlay that
  // happens to cover the row, which is invisible in the failure output.
  await page.evaluate(() => {
    document.querySelector('[data-web-e2e-click="1"]')?.click()
  })
  await unmark(page)
  return matched
}

/** @param {import('puppeteer-core').Page} page */
async function unmark(page) {
  await page.evaluate(() => {
    document.querySelector('[data-web-e2e-click="1"]')?.removeAttribute('data-web-e2e-click')
  })
}

/** @param {import('puppeteer-core').Page} page @param {string[]} labels */
async function clickByAriaLabel(page, labels) {
  const matched = await page.evaluate((list) => {
    for (const label of list) {
      const node = document.querySelector(`[aria-label="${label}"]`)
      if (!node) continue
      node.setAttribute('data-web-e2e-click', '1')
      return label
    }
    return null
  }, labels)
  if (!matched) return null
  await page.click('[data-web-e2e-click="1"]')
  await unmark(page)
  return matched
}

/**
 * Dismiss the first-run overlays (preview notice, sign-in prompt). They can arrive
 * in either order and a later one may appear after an earlier dismissal, so this
 * is re-run before each navigation attempt. Each round waits (bounded) for the
 * dialog to actually disappear — never a fixed sleep.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<number>} how many dismissal actions were taken
 */
async function dismissFirstRunDialogs(page) {
  let dismissed = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(await page.$('[role="dialog"]'))) return dismissed
    dismissed += 1
    const close = await page.$('[role="dialog"] [aria-label="关闭"], [role="dialog"] [aria-label="Close"]')
    if (close) {
      await close.click().catch(() => {})
    } else {
      const advanced = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        if (!dialog) return false
        const button = [...dialog.querySelectorAll('button')].find((node) =>
          [
            '继续',
            'Continue',
            '知道了',
            'Got it',
            '稍后配置',
            'Set up later',
            'Configure later',
            '稍后',
            'Later',
          ].includes((node.textContent ?? '').trim()),
        )
        if (!button) return false
        button.setAttribute('data-web-e2e-click', '1')
        return true
      })
      if (advanced) await page.click('[data-web-e2e-click="1"]').catch(() => {})
      else await page.keyboard.press('Escape')
      await unmark(page)
    }
    // Wait for the dismissal to take effect instead of sleeping a fixed amount.
    await page
      .waitForFunction(() => document.querySelector('[role="dialog"]') === null, { timeout: 10_000 })
      .catch(() => {})
  }
  return dismissed
}

/** @param {import('puppeteer-core').Page} page */
async function hasSettingsEntry(page) {
  return await page.evaluate(() => {
    const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
    return [...document.querySelectorAll('*')].some((node) => {
      const text = strip(node.textContent)
      return (text === '设置' || text === 'Settings') && node.children.length <= 2
    })
  })
}
/**
 * Open the account menu and wait, bounded, for its Settings entry.
 *
 * A fresh profile paints the shell before the app's handlers are attached, so the
 * first click can land on a dead button — a real interactivity race, not a label
 * mismatch (that bug is fixed: both sides of every comparison are normalised). It is
 * bounded to three clicks, each followed by a wait on the menu actually opening, so
 * a genuine failure still fails fast instead of looping.
 * @param {import('puppeteer-core').Page} page
 */
async function openAccountMenu(page) {
  await waitForSelector(page, ACCOUNT_MENU_SELECTOR)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissFirstRunDialogs(page)
    if (await hasSettingsEntry(page)) return
    const clicked = await clickByAriaLabel(page, ACCOUNT_MENU_LABELS)
    if (!clicked) throw new Error('the account-menu button disappeared before it could be clicked')
    const opened = await page
      .waitForFunction(
        () => {
          const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
          return [...document.querySelectorAll('*')].some((node) => {
            const text = strip(node.textContent)
            return (text === '设置' || text === 'Settings') && node.children.length <= 2
          })
        },
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false)
    if (opened) return
    await page.keyboard.press('Escape').catch(() => {})
  }
  const aria = await page.$$eval('[aria-label]', (nodes) =>
    nodes.map((node) => node.getAttribute('aria-label')).filter(Boolean),
  )
  const dialogs = await page.$$eval('[role="dialog"]', (nodes) => nodes.length)
  throw new Error(
    `could not open the account menu and find a Settings entry (dialogs open: ${dialogs}); ` +
      `aria-labels on the page: ${JSON.stringify(aria.slice(0, 40))}`,
  )
}

/**
 * Wait (bounded) for a clickable label to appear, then activate it.
 * Both sides of the comparison are normalised — see the note above `clickByText`.
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} labels
 * @param {{ timeout?: number, label: string }} options
 */
async function waitAndClickByText(page, labels, options) {
  await page.waitForFunction(
    (list) => {
      const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
      const wanted = list.map(strip)
      return [...document.querySelectorAll('*')].some((node) => {
        const text = strip(node.textContent)
        return wanted.includes(text) && node.children.length <= 2
      })
    },
    { timeout: options.timeout ?? 60_000, polling: 200 },
    labels,
  )
  const clicked = await clickByText(page, labels)
  if (!clicked) throw new Error(`${options.label}: found the entry but could not click it`)
  return clicked
}

/**
 * Navigate account menu -> Settings -> Remote hosts, once.
 *
 * Every step is a bounded wait on the state that must change; there is no retry
 * loop. A loop would only hide a deterministic failure — and this one was
 * deterministic: the label comparison stripped whitespace from the DOM text but not
 * from the candidate, so `Remote hosts` could never match in English. With both
 * sides normalised, one pass is enough.
 * @param {import('puppeteer-core').Page} page
 */
async function openRemoteHostsSection(page) {
  await dismissFirstRunDialogs(page)
  await openAccountMenu(page)
  const settings = await clickByText(page, SETTINGS_LABELS)
  if (!settings) throw new Error('the account menu did not expose a clickable Settings entry')
  // The settings dialog replaces the menu; wait for it before touching its nav.
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') !== null, { timeout: 30_000 })
  await waitAndClickByText(page, REMOTE_HOSTS_LABELS, {
    label: 'the settings dialog did not offer a Remote hosts section',
  })
  // Existence is the contract; the contrast measurement below then requires real
  // layout, so a zero-sized section cannot slip through.
  await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="settings-remote-section"]')
      return node !== null && node.getBoundingClientRect().width > 0
    },
    { timeout: 60_000, polling: 200 },
  )
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

test('dsh web renders the plugin settings with legible buttons', { timeout: 900_000 }, async (t) => {
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

    await t.test('the Remote-hosts settings section mounts', async () => {
      await dismissFirstRunDialogs(page)
      try {
        await openRemoteHostsSection(page)
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
      // Behaviour, not a marker: the plugin's stylesheet is proven applied when its
      // own class and CSS custom properties resolve on the mounted section. (The
      // `[data-dsh-remote-go="styles"]` element is NOT reliable — the desktop shell
      // applies the same styles without it.)
      const applied = await page.evaluate(() => {
        const section = document.querySelector('[data-testid="settings-remote-section"]')
        if (!section) return { present: false }
        const style = getComputedStyle(section)
        return {
          present: true,
          hasPluginClass: section.className.includes('drg-settings-remote'),
          primary: style.getPropertyValue('--drg-primary').trim(),
          radius: style.getPropertyValue('--drg-radius-sm').trim(),
        }
      })
      assert.equal(applied.present, true)
      assert.equal(applied.hasPluginClass, true, 'the plugin class is not on the mounted section')
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
        'the plugin section background did not change between light and dark mode',
      )
    })

    await t.test('loading the app and the plugin section logged no console errors', async () => {
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

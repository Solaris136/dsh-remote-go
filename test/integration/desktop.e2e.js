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
  assertBlockedIframe,
  assertNoNonLoopbackIframes,
  assertFrameRefresh,
  assertLoopbackUrl,
  assertPanelToolbar,
  assertReadOnlyBadge,
  SIMULATED_HISTORY,
  connectSimulatedHost,
  describePanel,
  openRemotePanel,
  startSimulatedRemote,
  stubNonLoopbackIframeUrl,
  switchPanelHost,
  waitForRemoteFrame,
} from './panel-support.js'
import {
  isWindows,
  makeTempRoot,
  packPlugin,
  pollUntil,
  resolveDesktopApp,
  resolvePnpm,
  skipOrFail,
  sleep,
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
  const child = spawn(
    input.exe,
    [
      `--user-data-dir=${input.userDataDir}`,
      `--remote-debugging-port=${input.port}`,
      // Force one UI language so the run cannot depend on the machine's locale: CI is
      // en-US, and a developer machine may be anything. `DSH_E2E_LANG` overrides it
      // (both `en-US` and `zh-CN` must pass — the labels are normalised).
      `--lang=${process.env.DSH_E2E_LANG ?? 'en-US'}`,
    ],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
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
const isWelcomeUrl = (url) => {
  try {
    return new URL(url).pathname.endsWith('welcome.html')
  } catch {
    return false
  }
}
/** The app window. Compared by parsed protocol, never by a `dsh-app://` prefix. */
const isAppUrl = (url) => {
  try {
    return new URL(url).protocol === 'dsh-app:'
  } catch {
    return false
  }
}

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
  // The welcome window has its own locale resolution: unlike the main renderer it does
  // NOT follow the `--lang` switch (it goes through the app's getLocale(), i.e. the OS
  // locale). Log it, so a locale surprise is visible in the log instead of showing up
  // as a mysterious timeout.
  const welcomeLocale = await welcome
    .evaluate(() => [document.documentElement.lang || '(none)', navigator.language, navigator.languages])
    .catch(() => '(unavailable)')
  console.log(`[desktop-e2e] welcome window locale=${JSON.stringify(welcomeLocale)}`)
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
      // Report the label that actually matched, so the log proves which locale path
      // ran instead of always echoing the first (Chinese) candidate.
      const picked = await element.evaluate((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
      await element.evaluate(activateElement)
      return picked || ONBOARDING_LABELS[0]
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
  return clicked ?? null
}

/** @param {import('puppeteer-core').Page} page @param {string} selector @param {number} [timeout] */
async function waitForSelector(page, selector, timeout = 60_000) {
  await page.waitForSelector(selector, { visible: true, timeout })
}

/**
 * Locate a row by its normalised text, verify it is actually clickable, and
 * activate it with a DOM click.
 *
 * Runs inside the page, so it must be self-contained. Two failure modes matter and
 * are both reported instead of guessed:
 *
 * - the row is `aria-disabled`/`pointer-events: none` (present, not yet actionable);
 * - an overlay is on top of it, so a coordinate click would be silently swallowed
 *   (hence the DOM click on the node, plus the `coveredBy` check).
 *
 * The return value is also the diagnostic: what matched, what got clicked, what is
 * on top, and whether a dialog was present.
 * @param {string[]} rawLabels
 */
function activateRowInPage(rawLabels) {
  const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
  const labels = rawLabels.map(strip)
  const dialogs = document.querySelectorAll('[role="dialog"]').length
  /** @param {Element | null} node */
  const describeNode = (node) => {
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role'),
      testid: node.getAttribute('data-testid'),
      ariaDisabled: node.getAttribute('aria-disabled'),
      pointerEvents: style.pointerEvents,
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      box: { width: Math.round(rect.width), height: Math.round(rect.height) },
    }
  }
  // Same traversal as the readiness wait (`*`), so "ready" and "locatable" cannot
  // disagree the way the old tag whitelist could.
  const matches = []
  for (const node of document.querySelectorAll('*')) {
    if (labels.includes(strip(node.textContent))) matches.push(node)
  }
  if (matches.length === 0) return { clicked: false, reason: 'no-matching-node', dialogs }
  // Smallest subtree wins: the label node, not every ancestor that contains it.
  const row = matches.sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length)[0]
  const clickable = row.closest('button, [role="menuitem"], [role="button"], [role="tab"], a, li') ?? row
  const info = describeNode(clickable)
  if (info.ariaDisabled === 'true' || info.pointerEvents === 'none') {
    return { clicked: false, reason: 'not-actionable', row: info, dialogs }
  }
  if (info.box.width === 0 || info.box.height === 0) {
    return { clicked: false, reason: 'not-laid-out', row: info, dialogs }
  }
  const rect = clickable.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  if (hit && !clickable.contains(hit) && !hit.contains(clickable)) {
    return { clicked: false, reason: 'covered', row: info, coveredBy: describeNode(hit), dialogs }
  }
  clickable.click()
  return { clicked: true, reason: null, row: info, dialogs }
}

/**
 * Activate one element found by `aria-label` (the account menu button), with the
 * same actionability/overlay checks as `activateRowInPage`.
 * @param {string[]} rawLabels
 */
function activateByAriaLabelInPage(rawLabels) {
  const dialogs = document.querySelectorAll('[role="dialog"]').length
  for (const label of rawLabels) {
    const node = document.querySelector(`[aria-label="${label}"]`)
    if (!node) continue
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (node.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') {
      return { clicked: false, reason: 'not-actionable', label, dialogs }
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (hit && !node.contains(hit) && !hit.contains(node)) {
      return {
        clicked: false,
        reason: 'covered',
        label,
        coveredBy: { tag: hit.tagName.toLowerCase(), testid: hit.getAttribute('data-testid') },
        dialogs,
      }
    }
    node.click()
    return { clicked: true, reason: null, label, dialogs }
  }
  return { clicked: false, reason: 'no-matching-node', dialogs }
}

/**
 * Activate a nav row and verify the section it owns actually mounted.
 *
 * A click only counts once its effect is on screen: the old code trusted
 * `element.click()` and then waited for the section, so a click swallowed by a
 * re-render or an overlay became a 60 s timeout with no information. Each bounded
 * attempt re-locates (a handle from before a re-render is useless), activates, and
 * polls for the section; the failure message carries every attempt's result.
 * @param {import('puppeteer-core').Page} page
 * @param {{ labels: string[], selector: string, label: string, attempts?: number, appearTimeoutMs?: number, mountTimeoutMs?: number }} options
 */
async function activateSectionItem(page, options) {
  const { labels, selector, label, attempts = 4, appearTimeoutMs = 60_000, mountTimeoutMs = 20_000 } = options
  const appeared = await page
    .waitForFunction(
      (rawLabels) => {
        const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
        const wanted = rawLabels.map(strip)
        return [...document.querySelectorAll('*')].some((node) => wanted.includes(strip(node.textContent)))
      },
      { timeout: appearTimeoutMs, polling: 150 },
      labels,
    )
    .then(() => true)
    .catch(() => false)
  /** @type {any[]} */
  const log = [{ step: 'row-appeared', ok: appeared }]
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await page.evaluate(activateRowInPage, labels)
    log.push({ attempt, result })
    if (result.clicked) {
      const mounted = await page
        .waitForFunction(
          (selector_) => {
            const node = document.querySelector(selector_)
            return node !== null && node.getBoundingClientRect().width > 0
          },
          { timeout: mountTimeoutMs, polling: 150 },
          selector,
        )
        .then(() => true)
        .catch(() => false)
      log.push({ attempt, mounted })
      if (mounted) return
    }
    await sleep(250)
  }
  throw new Error(
    `${label} did not take effect after ${attempts} attempt(s): ${JSON.stringify({ attempts: log, page: await describePage(page) })}`,
  )
}

/**
 * Make the shell's settings surface show the Remote-hosts entry (account menu →
 * Settings).
 *
 * Readiness is the **nav row the next step needs**, not `role="dialog"`: under load
 * the desktop shell renders the settings surface as a loading view ("正在加载设置…")
 * before anything dialog-like exists, so requiring a dialog proved too strict and
 * reported "the settings dialog never opened" while the surface was in fact loading.
 * Returns false when the bounded attempt did not take effect, so the caller retries
 * the whole chain.
 * @param {import('puppeteer-core').Page} page
 */
async function openSettingsSurface(page) {
  if (await navRowPresent(page)) return true
  if (!(await page.$('[role="dialog"]'))) {
    const menu = await page.evaluate(activateByAriaLabelInPage, ['账号菜单', 'Account menu', '账号', 'Account'])
    if (!menu.clicked) {
      console.log(`[desktop-e2e] account menu not activated: ${JSON.stringify(menu)}`)
      return false
    }
    const menuReady = await page
      .waitForFunction(
        () => {
          const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
          return [...document.querySelectorAll('*')].some((node) => {
            const text = strip(node.textContent)
            return (text === '设置' || text === 'Settings') && node.children.length <= 2
          })
        },
        { timeout: 30_000, polling: 150 },
      )
      .then(() => true)
      .catch(() => false)
    if (!menuReady) return false
  }
  const settings = await page.evaluate(activateRowInPage, SETTINGS_LABELS)
  if (!settings.clicked) {
    console.log(`[desktop-e2e] Settings entry not activated: ${JSON.stringify(settings)}`)
    return false
  }
  // Effect check: the nav row (or the section itself, if it mounted directly).
  return await page
    .waitForFunction(
      (rawLabels) => {
        if (document.querySelector('[data-testid="settings-remote-section"]')) return true
        const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
        const wanted = rawLabels.map(strip)
        return [...document.querySelectorAll('*')].some((node) => wanted.includes(strip(node.textContent)))
      },
      { timeout: 60_000, polling: 150 },
      REMOTE_HOSTS_LABELS,
    )
    .then(() => true)
    .catch(() => false)
}

/**
 * Is the Remote-hosts nav row already on screen?
 * @param {import('puppeteer-core').Page} page
 */
async function navRowPresent(page) {
  return await page
    .evaluate((rawLabels) => {
      const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
      const wanted = rawLabels.map(strip)
      return [...document.querySelectorAll('*')].some((node) => wanted.includes(strip(node.textContent)))
    }, REMOTE_HOSTS_LABELS)
    .catch(() => false)
}

/**
 * Account menu → Settings → Remote hosts, with every activation verified by its
 * effect and retried when it did not take.
 *
 * The retry is not a longer timeout: the section must actually mount, and when it
 * does not the surface is re-ensured and the row re-located/clicked again (the CI
 * failure was "found the entry but could not activate it" — element present, click
 * not effective). The final error carries each attempt's row/overlay/dialog
 * diagnosis.
 * @param {import('puppeteer-core').Page} page
 */
async function openRemoteHostsSection(page) {
  await waitForSelector(page, ACCOUNT_MENU_SELECTOR, 120_000)
  /** @type {any[]} */
  const log = []
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const surfaceReady = await openSettingsSurface(page)
    log.push({ cycle, surfaceReady })
    if (!surfaceReady) {
      await sleep(300)
      continue
    }
    try {
      await activateSectionItem(page, {
        labels: REMOTE_HOSTS_LABELS,
        selector: '[data-testid="settings-remote-section"]',
        label: 'the Remote-hosts section',
        attempts: 2,
      })
      return
    } catch (error) {
      log.push({ cycle, error: String(error?.message ?? error).slice(0, 400) })
      await sleep(300)
    }
  }
  throw new Error(
    `the Remote-hosts section could not be opened: ${JSON.stringify({ cycles: log, page: await describePage(page) })}`,
  )
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
 * One pass, every step a bounded wait on the state that must change. The retries
 * this used to carry existed only because the label comparison stripped whitespace
 * from the DOM text but not from the candidate, so `Remote hosts`/`Set up later`
 * could never match in English. Both sides are normalised now, so a loop would only
 * mask a real failure.
 * @param {import('puppeteer-core').Page} page
 */
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

/**
 * Run one panel assertion and, on failure, append the panel's observable state to
 * the message: a timeout with no iframe src or toolbar dump is undiagnosable from
 * a CI log alone.
 * @param {import('puppeteer-core').Page} page
 * @param {() => Promise<any>} task
 */
async function withPanelDiagnostics(page, task) {
  try {
    return await task()
  } catch (error) {
    const state = await describePanel(page).catch(() => null)
    throw new Error(`${error?.message ?? error} — panel: ${JSON.stringify(state)}`)
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
  /** @type {string | null} */
  let simulatedHostId = null
  /** @type {Awaited<ReturnType<typeof startSimulatedRemote>> | null} */
  let sim = null
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
      console.log(`[desktop-e2e] onboarding ${skipped ? `dismissed via "${skipped}"` : 'not shown'}`)

      page = await findPage(browser, isAppUrl, 180_000)
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
      await page.setViewport({ width: 1400, height: 950 }).catch(() => {})

      console.log(
        `[desktop-e2e] renderer locale=${JSON.stringify(await page.evaluate(() => [navigator.language, navigator.languages]))}`,
      )
      await openRemoteHostsSection(page)
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

    await t.test('the remote panel embeds the remote UI in a loopback iframe', async () => {
      await withPanelDiagnostics(page, async () => {
        // Same simulated remote host as the web suite: a real connect through the
        // plugin's own API, then the panel is opened the way a user opens it.
        sim = await startSimulatedRemote({
          stateFile: path.join(tempRoot, 'sim', 'sim.state.json'),
          // Session logs make L2 replay succeed, so the mirrors are read-only and
          // the rail must mark them.
          historyFixture: SIMULATED_HISTORY,
        })
        // The panel subtests are the only ones that need a *live* SSH endpoint, so
        // assert it explicitly: a dead simulator must be reported here, not as a
        // mysterious "panel never mounted".
        assert.equal(sim.child.exitCode, null, `the simulator exited: ${sim.logs.join('').slice(-1200)}`)
        const host = await connectSimulatedHost(page, {
          hostName: 'simulated-remote',
          sshPort: sim.state.sshPort,
          logs: sim.logs,
        })
        simulatedHostId = host.hostId
        assert.equal(host.host.status, 'connected')
        await openRemotePanel(page, { hostId: host.hostId })
        const frame = await waitForRemoteFrame(page)
        assert.equal(frame.ready, 'complete', 'the iframe document never reached a ready state')
        assert.equal(frame.frameTitle, 'simulated remote DSH')
        const iframeSrcs = await assertNoNonLoopbackIframes(page, 'the remote panel')
        assert.ok(iframeSrcs.length >= 1, 'the panel mounted no iframe')
        // The iframe must target the tunnel, never the simulated remote's own
        // listener: embedding the remote port directly would still render the
        // marker, so the port is pinned explicitly.
        const iframeUrl = assertLoopbackUrl(frame.iframeSrc, 'the remote panel iframe')
        assert.notEqual(
          Number(iframeUrl.port),
          Number(sim.state.remotePort),
          'the iframe embeds the simulated remote directly instead of going through the tunnel',
        )
      })
    })

    await t.test('the panel toolbar affords reconnect, refresh, open-in-new-window and address hiding', async () => {
      await withPanelDiagnostics(page, async () => {
        const toolbar = await assertPanelToolbar(page)
        // Print the labels that actually matched, so the log shows which language
        // the shell rendered. This suite is **locale-tolerant, not locale-exercised**:
        // Electron resolves the plugin locale from the app/OS locale rather than
        // `--lang`, and CI runs one OS locale, so the assertions accept whichever
        // language appears. (The web suite genuinely drives both `en-US` and `zh-CN`.)
        console.log(`[desktop-e2e] panel toolbar labels: ${JSON.stringify(toolbar.labels)}`)
        // The helper validated the masked address with an anchored pattern; here the
        // toggle must restore exactly the same text, so "show" cannot be a no-op.
        assert.equal(toolbar.restored, toolbar.address, 'the address toggle did not restore the address')
        assert.equal(toolbar.hidden, '••••••')
        const refreshed = await assertFrameRefresh(page)
        assertLoopbackUrl(refreshed.iframeSrc, 'the refreshed panel iframe')
      })
    })

    await t.test('the panel marks replayed remote sessions as read-only', async () => {
      await withPanelDiagnostics(page, async () => {
        // Same simulated host as above: its default registry has history, so the
        // connect produced read-only mirrors. Locale-tolerant like every text
        // assertion in this suite (Electron ignores `--lang`).
        const badge = await assertReadOnlyBadge(page)
        console.log(`[desktop-e2e] read-only badge: ${JSON.stringify(badge)}`)
      })
    })

    await t.test('a non-loopback iframe URL is refused instead of embedded', async () => {
      await withPanelDiagnostics(page, async () => {
        assert.ok(simulatedHostId, 'the simulated host was not connected')
        // Snapshot the console log so a regression in the blocked path is reported
        // here (as part of this subtest) rather than surfacing later as a vaguer
        // "console errors" failure.
        const errorsBefore = consoleErrors.length
        // A second connected host gives the toolbar's host switcher something to
        // switch to; the switch is what makes the client fetch `/open` again (the
        // client caches that URL per viewport mount by design).
        const second = await connectSimulatedHost(page, {
          hostName: 'simulated-remote-b',
          sshPort: sim.state.sshPort,
          logs: sim.logs,
        })
        const guard = await stubNonLoopbackIframeUrl(page)
        try {
          const blocked = await assertBlockedIframe(page, {
            intercepted: () => guard.calls(),
            forbiddenOrigin: guard.origin,
            forceRefetch: () => switchPanelHost(page, { hostId: second.hostId, hostName: 'simulated-remote-b' }),
          })
          assert.equal(blocked.panelIframe, null, 'a blocked URL produced an iframe')
          // Attribute any console noise to the path that caused it.
          assert.deepEqual(
            consoleErrors.slice(errorsBefore),
            [],
            `the blocked path logged console errors:\n${consoleErrors.slice(errorsBefore).join('\n')}`,
          )
        } finally {
          await guard.disable()
        }
      })
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
    if (sim) await sim.stop()
    if (browser) await browser.disconnect().catch(() => {})
    if (app) await app.stop()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

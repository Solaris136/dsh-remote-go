/**
 * Real-browser acceptance for the "web + desktop compatible" claim.
 *
 * Boots an isolated `dsh web` (temporary `DSH_HOME`, ephemeral port), installs
 * this repository as a plugin into its profile, then drives the real UI with
 * Chrome and asserts what a user actually sees: the plugin's Remote-hosts
 * settings section mounts, every button label is legible (WCAG contrast >= 3
 * against the effective, alpha-composited background) in **light and dark**
 * mode, and the page produced no console errors.
 *
 * The assertion is calibrated against a real regression: with the pre-#10
 * `client.js` (a single-class `.drg-btn-primary` colour rule that lost the
 * cascade) the primary buttons `settings-host-add` / `settings-host-add-empty`
 * measure ratio **1.0** — the label is painted in the fill colour — while the
 * fixed build measures 11.57–18.9. That is why the contrast check measures the
 * label element as well as the button.
 *
 * Skips (never fails) when the machine cannot provide a prerequisite:
 * - no DSH CLI (`DSH_BIN`/`DSH_EXE`, a Windows harness install, or `dsh` on PATH),
 * - no Chrome/Edge (`CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH` or a known path),
 * - no `pnpm` (required by `dsh plugin add`; `DSH_PNPM_CJS` can supply one).
 *
 * So `pnpm run verify` stays green without a harness install, while a machine
 * (or the `web-e2e` CI job) that has the pieces gets the real check.
 *
 * Not duplicated here: the "client bundle ships no Electron-only API" rule is
 * already enforced by test/unit/client.test.js.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

/** Minimum contrast ratio a button label must reach (WCAG 1.4.11, large text AA). */
const MIN_CONTRAST = 3

/**
 * In strict mode (CI) an unavailable prerequisite is a failure, not a skip: the
 * workflow exists to prove the claim, so a broken harness install must be loud.
 */
const STRICT = process.env.DSH_E2E_STRICT === '1'

/**
 * Skip locally, fail in CI.
 * @param {import('node:test').TestContext} t
 * @param {string} reason
 */
function skipOrFail(t, reason) {
  if (STRICT) assert.fail(`web E2E prerequisite missing (DSH_E2E_STRICT=1): ${reason}`)
  t.skip(reason)
}

/** The regression target: the primary buttons that were invisible before #10. */
const PRIMARY_TEST_IDS = ['settings-host-add', 'settings-host-add-empty']

const isWindows = process.platform === 'win32'

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Locate the DSH CLI.
 *
 * Returns `{ command, args }` such that `spawn(command, [...args, ...cliArgs])`
 * runs the CLI. On a Windows install the CLI lives inside `app.asar`, which only
 * Electron's patched `fs` can read — `existsSync` cannot see it, so the presence
 * of the Electron binary is what we verify and the asar path is trusted.
 * @returns {{ command: string, args: string[], kind: string } | null}
 */
export function resolveHarness() {
  const envBin = process.env.DSH_BIN
  const envExe = process.env.DSH_EXE
  if (envBin && existsSync(envBin)) {
    if (envExe) return { command: envExe, args: [envBin], kind: 'env' }
    // A `.js` entry point is not executable on its own (spawn fails with
    // EFTYPE/ENOEXEC); run it with the current Node, which is exactly what a CI
    // install of the published package provides.
    if (/\.(?:js|cjs|mjs)$/i.test(envBin)) return { command: process.execPath, args: [envBin], kind: 'env-node' }
    return { command: envBin, args: [], kind: 'env' }
  }
  if (isWindows) {
    const install =
      process.env.DSH_INSTALL_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
    const exe = path.join(install, 'DeepSeek Harness.exe')
    const bin = path.join(
      install,
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    if (existsSync(exe)) return { command: exe, args: [bin], kind: 'windows-install' }
  }
  const onPath = spawnSync('dsh', ['--version'], { encoding: 'utf8', shell: isWindows, timeout: 20_000 })
  if (onPath.status === 0) return { command: 'dsh', args: [], kind: 'path' }
  return null
}

/**
 * Locate a Chromium-based browser.
 * @returns {string | null}
 */
export function resolveBrowser() {
  for (const key of ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'E2E_CHROME', 'DSH_E2E_BROWSER']) {
    const value = process.env[key]
    if (value && existsSync(value)) return value
  }
  /** @type {string[]} */
  const candidates = isWindows
    ? [
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Microsoft',
          'Edge',
          'Application',
          'msedge.exe',
        ),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
          '/snap/bin/chromium',
        ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * Make `pnpm` runnable for the child process (`dsh plugin add` shells out to it).
 *
 * `DSH_PNPM_CJS` names a pnpm entry point; a shim is written into `shimDir`. When
 * pnpm is already on PATH nothing is needed.
 * @param {string} shimDir
 * @returns {{ available: boolean, pathPrefix: string | null, reason: string | null }}
 */
export function resolvePnpm(shimDir) {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: isWindows, timeout: 30_000 })
  if (probe.status === 0) return { available: true, pathPrefix: null, reason: null }
  const cjs = process.env.DSH_PNPM_CJS
  if (!cjs || !existsSync(cjs)) {
    return {
      available: false,
      pathPrefix: null,
      reason: 'pnpm is not on PATH and DSH_PNPM_CJS does not point at a pnpm entry point',
    }
  }
  mkdirSync(shimDir, { recursive: true })
  // The harness itself may be Electron-as-Node, which is how pnpm is run here too.
  const runner = process.execPath
  if (isWindows) {
    writeFileSync(
      path.join(shimDir, 'pnpm.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runner}" "${cjs}" %*\r\n`,
      'utf8',
    )
  } else {
    const shim = path.join(shimDir, 'pnpm')
    writeFileSync(shim, `#!/bin/sh\nexec "${runner}" "${cjs}" "$@"\n`, 'utf8')
    chmodSync(shim, 0o755)
  }
  return { available: true, pathPrefix: shimDir, reason: null }
}

/**
 * Run one command to completion, collecting output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: Record<string, string>, timeoutMs: number, label: string }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${options.label} timed out after ${options.timeoutMs}ms\n${tail(stdout, stderr)}`))
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${options.label} failed to start: ${error.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** @param {string} stdout @param {string} stderr */
function tail(stdout, stderr, lines = 20) {
  const combined = `${stdout}\n${stderr}`.trim().split(/\r?\n/)
  return combined.slice(-lines).join('\n')
}

/**
 * Boot `dsh web` and resolve once it prints its readiness line.
 * @param {{ harness: { command: string, args: string[] }, env: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<{ url: string, child: import('node:child_process').ChildProcess, logs: string[], stop: () => Promise<void> }>}
 */
async function startWeb(options) {
  const timeoutMs = options.timeoutMs ?? 180_000
  const child = spawn(
    options.harness.command,
    [...options.harness.args, '--profile', 'web', '--no-open', '--port', '0'],
    // Detached on POSIX so `stopChild` can kill the whole process group; on
    // Windows `taskkill /T` walks the tree instead (detaching there would open a
    // separate console window).
    { env: options.env, windowsHide: true, detached: !isWindows },
  )
  /** @type {string[]} */
  const logs = []
  const collect = (chunk) => logs.push(chunk.toString('utf8'))
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const url = await new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const text = logs.join('')
      const match = /dsh web:\s*(https?:\/\/\S+)/.exec(text)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
        return
      }
      if (child.exitCode !== null) {
        clearInterval(poll)
        reject(new Error(`dsh web exited early (${child.exitCode})\n${tail(logs.join(''), '')}`))
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(poll)
        reject(new Error(`dsh web never printed a readiness line within ${timeoutMs}ms\n${tail(logs.join(''), '')}`))
      }
    }, 100)
  }).catch(async (error) => {
    await stopChild(child)
    throw error
  })

  const stop = async () => {
    await stopChild(child)
  }
  return { url, child, logs, stop }
}

/**
 * Terminate the harness **process tree** and wait for it to leave.
 *
 * `dsh` re-execs itself (the running server's command line is the Electron
 * binary again, with `--expose-internals`), so signalling only the spawned pid
 * leaves an orphaned server holding the port and the temporary DSH_HOME. Windows
 * gets `taskkill /T`; POSIX gets a process group, which requires the detached
 * spawn in `startWeb`.
 * @param {import('node:child_process').ChildProcess} child
 */
async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  const stopped = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])
  if (stopped) return
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  await Promise.race([exited, sleep(5_000)])
}

/**
 * Wait until one of the given candidate selectors exists.
 * @param {import('puppeteer-core').Page} page
 * @param {string} selector
 */
async function waitForSelector(page, selector, timeout = 60_000) {
  await page.waitForSelector(selector, { visible: true, timeout })
}

/**
 * Dismiss the first-run overlays (preview notice, sign-in prompt). Both are
 * `[role="dialog"]`; they can appear in either order and a later one may arrive
 * after an earlier dismissal, so this is called again before every navigation
 * attempt. Bounded so a changed harness cannot hang the suite.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<number>} how many dismissal actions were taken
 */
async function dismissFirstRunDialogs(page) {
  let dismissed = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(await page.$('[role="dialog"]'))) break
    dismissed += 1
    const close = await page.$('[role="dialog"] [aria-label="关闭"]')
    if (close) {
      await close.click().catch(() => {})
    } else {
      // The preview notice only offers a primary "继续" action.
      const advanced = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        if (!dialog) return false
        const button = [...dialog.querySelectorAll('button')].find((node) =>
          ['继续', 'Continue', '知道了', 'Got it'].includes((node.textContent ?? '').trim()),
        )
        if (!button) return false
        button.setAttribute('data-web-e2e-click', '1')
        return true
      })
      if (advanced) await page.click('[data-web-e2e-click="1"]').catch(() => {})
      else await page.keyboard.press('Escape')
      await page.evaluate(() => {
        document.querySelector('[data-web-e2e-click="1"]')?.removeAttribute('data-web-e2e-click')
      })
    }
    await sleep(700)
  }
  return dismissed
}

/**
 * Tag and click the deepest element whose whitespace-stripped text equals one of
 * the candidates (a real mouse click, so React handlers and overlays behave).
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} candidates
 * @returns {Promise<string | null>}
 */
async function clickByText(page, candidates) {
  const matched = await page.evaluate((list) => {
    const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
    const nodes = [
      ...document.querySelectorAll('button, [role="menuitem"], [role="button"], [role="tab"], a, li, div, span'),
    ]
    for (const candidate of list) {
      const matches = nodes.filter((node) => strip(node.textContent) === candidate)
      if (matches.length === 0) continue
      // Deepest match wins: the label span, not its container.
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
  await page.click('[data-web-e2e-click="1"]')
  await page.evaluate(() => {
    document.querySelector('[data-web-e2e-click="1"]')?.removeAttribute('data-web-e2e-click')
  })
  return matched
}

/**
 * Click an element found by `aria-label` (falling back to its visible text).
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} labels
 * @returns {Promise<string | null>}
 */
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
  await page.evaluate(() => {
    document.querySelector('[data-web-e2e-click="1"]')?.removeAttribute('data-web-e2e-click')
  })
  return matched
}

/**
 * Does the page currently offer a Settings entry (menu item, in either locale)?
 * @param {import('puppeteer-core').Page} page
 */
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
 * Open the account menu, retrying: a fresh profile renders the shell before React
 * has attached its handlers, so the first click can land on a dead button.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>}
 */
async function openAccountMenu(page) {
  await waitForSelector(page, '[aria-label="账号菜单"], [aria-label="Account menu"], [aria-label="账号"]')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A first-run overlay can still be arriving (or has just arrived): a modal
    // swallows the click, so clear the deck before every attempt.
    await dismissFirstRunDialogs(page)
    const menu = await clickByAriaLabel(page, ['账号菜单', 'Account menu', '账号', 'Account'])
    if (!menu) break
    for (let wait = 0; wait < 8; wait += 1) {
      if (await hasSettingsEntry(page)) return menu
      await sleep(400)
    }
    // The menu did not open (or closed itself): clear any popover and retry.
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(600)
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
 * Navigate: account menu -> Settings -> Remote hosts.
 * Labels are accepted in both Chinese (default) and English UI locales.
 * @param {import('puppeteer-core').Page} page
 */
async function openRemoteHostsSection(page) {
  await openAccountMenu(page)
  const clickedSettings = await clickByText(page, ['设置', 'Settings'])
  if (!clickedSettings) throw new Error('the account menu did not actually expose a clickable Settings entry')
  await sleep(1_200)
  const nav = await clickByText(page, ['远程主机', 'Remote hosts', 'Remote Hosts'])
  if (!nav) throw new Error('the settings dialog did not offer a Remote hosts section')
  await waitForSelector(page, '[data-testid="settings-remote-section"]')
}

/**
 * Measure every button in the plugin section: its own computed colour, the
 * effective (alpha-composited) background behind it, the label element's colour,
 * and the WCAG contrast ratio of both.
 *
 * Serializable: this function runs inside the page, so it must not close over
 * module scope.
 */
function measureButtons() {
  /** @param {string} value */
  function parseColor(value) {
    const match = /rgba?\(([^)]+)\)/.exec(value ?? '')
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  /** @param {any} top @param {any} bottom */
  function blend(top, bottom) {
    const alpha = top.a + bottom.a * (1 - top.a)
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
      a: alpha,
    }
  }
  /** @param {Element} node */
  function effectiveBackground(node) {
    const layers = []
    let current = node
    while (current) {
      const parsed = parseColor(getComputedStyle(current).backgroundColor)
      if (parsed && parsed.a > 0) layers.push(parsed)
      if (parsed && parsed.a >= 1) break
      current = current.parentElement
    }
    let base = layers.pop() ?? { r: 255, g: 255, b: 255, a: 1 }
    while (layers.length > 0) base = blend(layers.pop(), base)
    return base
  }
  /** @param {number} value */
  function channel(value) {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  /** @param {{ r: number, g: number, b: number }} color */
  function luminance(color) {
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  /** @param {{ r: number, g: number, b: number }} one @param {{ r: number, g: number, b: number }} two */
  function contrast(one, two) {
    const luminanceOne = luminance(one)
    const luminanceTwo = luminance(two)
    return (Math.max(luminanceOne, luminanceTwo) + 0.05) / (Math.min(luminanceOne, luminanceTwo) + 0.05)
  }
  const round = (value) => Math.round(value * 100) / 100
  const format = (color) => `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`
  const section = document.querySelector('[data-testid="settings-remote-section"]')
  if (!section) return { mounted: false, buttons: [] }
  const buttons = [...section.querySelectorAll('button')].map((node) => {
    const style = getComputedStyle(node)
    const background = effectiveBackground(node)
    const color = parseColor(style.color)
    const label = node.querySelector('.drg-btn-label')
    const labelColor = label ? parseColor(getComputedStyle(label).color) : null
    return {
      testId: node.getAttribute('data-testid'),
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
      color: style.color,
      background: format(background),
      colorEqualsBackground: color ? contrast(color, background) < 1.05 : true,
      ratio: color ? round(contrast(color, background)) : null,
      labelColor: labelColor ? getComputedStyle(label).color : null,
      labelRatio: labelColor ? round(contrast(labelColor, background)) : null,
    }
  })
  return {
    mounted: true,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    buttons,
  }
}

/**
 * Assert the section is mounted and every button label is legible.
 * @param {import('puppeteer-core').Page} page
 * @param {string} mode
 */
async function assertLegibleButtons(page, mode) {
  const measured = await page.evaluate(measureButtons)
  assert.equal(measured.mounted, true, `${mode}: the Remote-hosts settings section did not mount`)
  assert.ok(
    measured.buttons.length >= 2,
    `${mode}: expected the plugin's action buttons, found ${measured.buttons.length}`,
  )
  for (const button of measured.buttons) {
    const name = `${button.testId ?? button.text ?? 'button'}`
    assert.equal(
      button.colorEqualsBackground,
      false,
      `${mode}: ${name} has no contrast between its colour (${button.color}) and background (${button.background})`,
    )
    assert.ok(
      button.ratio !== null && button.ratio >= MIN_CONTRAST,
      `${mode}: ${name} contrast ratio ${button.ratio} is below ${MIN_CONTRAST} (${button.color} on ${button.background})`,
    )
    if (button.labelRatio !== null) {
      assert.ok(
        button.labelRatio >= MIN_CONTRAST,
        `${mode}: ${name} label contrast ratio ${button.labelRatio} is below ${MIN_CONTRAST} (${button.labelColor})`,
      )
    }
  }
  const primary = measured.buttons.filter((button) => PRIMARY_TEST_IDS.includes(button.testId))
  assert.equal(primary.length, PRIMARY_TEST_IDS.length, `${mode}: the primary buttons under test are missing`)
  return measured
}

/**
 * @param {import('puppeteer-core').Page} page
 * @param {'dark' | 'light'} scheme
 */
async function waitForColorScheme(page, scheme) {
  await page.waitForFunction(
    (value) => matchMedia(`(prefers-color-scheme: ${value})`).matches,
    { timeout: 15_000 },
    scheme,
  )
  await sleep(900)
}

test('dsh web renders the plugin settings with legible buttons', { timeout: 600_000 }, async (t) => {
  const harness = resolveHarness()
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
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'dsh-web-e2e-'))
  const pnpm = resolvePnpm(path.join(tempRoot, 'pnpm-shim'))
  if (!pnpm.available) {
    skipOrFail(t, `cannot install the plugin into the profile: ${pnpm.reason}`)
    await rm(tempRoot, { recursive: true, force: true })
    return
  }

  const dshHome = path.join(tempRoot, 'home')
  const userDataDir = path.join(tempRoot, 'browser')
  mkdirSync(dshHome, { recursive: true })
  /** @type {Record<string, string>} */
  const childEnv = { ...process.env, DSH_HOME: dshHome }
  if (pnpm.pathPrefix) childEnv.PATH = `${pnpm.pathPrefix}${path.delimiter}${process.env.PATH ?? ''}`
  if (harness.command.toLowerCase().endsWith('.exe')) childEnv.ELECTRON_RUN_AS_NODE = '1'
  else delete childEnv.ELECTRON_RUN_AS_NODE

  /** @type {Awaited<ReturnType<typeof startWeb>> | null} */
  let server = null
  /** @type {import('puppeteer-core').Browser | null} */
  let browser = null
  try {
    const install = await runCommand(
      harness.command,
      [...harness.args, 'plugin', '--profile', 'web', 'add', REPO_ROOT],
      {
        env: childEnv,
        timeoutMs: 300_000,
        label: 'dsh plugin add',
      },
    )
    assert.equal(
      install.code,
      0,
      `installing the plugin failed (exit ${install.code})\n${tail(install.stdout, install.stderr)}`,
    )

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
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 950 })
    /** @type {string[]} */
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

    await page.goto(server.url, { waitUntil: 'networkidle2', timeout: 120_000 })

    await t.test('the app shell loads and the launch token becomes a clean URL', async () => {
      await waitForSelector(page, 'body')
      // The launch token is exchanged for the authority-bound cookie and dropped.
      await page.waitForFunction(() => !location.search.includes('token='), { timeout: 60_000 })
      assert.equal(new URL(page.url()).search, '')
      // The plugin's client half must have loaded in the real app shell.
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-dsh-remote-go="styles"]')) || Boolean(document.querySelector('style')),
        { timeout: 30_000 },
      )
    })

    await t.test('the Remote-hosts settings section mounts', async () => {
      const dismissed = await dismissFirstRunDialogs(page)
      await openRemoteHostsSection(page)
      assert.equal(Boolean(await page.$('[data-testid="settings-remote-section"]')), true)
      assert.ok(dismissed >= 0)
    })

    await t.test('every button label is legible in light mode', async () => {
      await waitForColorScheme(page, 'light')
      const measured = await assertLegibleButtons(page, 'light')
      assert.equal(measured.scheme, 'light')
    })

    await t.test('every button label is legible in dark mode', async () => {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
      await waitForColorScheme(page, 'dark')
      const measured = await assertLegibleButtons(page, 'dark')
      assert.equal(measured.scheme, 'dark')
      // The two modes must really differ, or the dark assertion proves nothing.
      assert.notEqual(measured.bodyBackground, 'rgb(255, 255, 255)')
    })

    await t.test('loading the app and the plugin section logged no console errors', async () => {
      assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join('\n')}`)
    })
  } finally {
    // Order matters: the browser first (it holds the page), then the server.
    if (browser) await browser.close().catch(() => {})
    if (server) await server.stop()
    await rm(tempRoot, { recursive: true, force: true })
  }
})

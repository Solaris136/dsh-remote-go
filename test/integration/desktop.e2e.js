import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { assertLightAndDark } from './browser-contrast.js'
import {
  isWindows,
  makeTempRoot,
  packPlugin,
  pollUntil,
  resolveDesktopApp,
  resolvePnpm,
  runCommand,
  skipOrFail,
  stopChild,
  tail,
  desktopAppVersion,
  writeFailureArtifacts,
} from './harness-support.js'
import { closeManageWindow, emulateReducedMotion, openManageWindow } from './ui-steps.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const ONBOARDING_LABELS = ['稍后配置', 'Set up later', 'Configure later', '稍后', 'Later']

const DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-go']

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

function launchDesktop(input) {
  const env = { ...input.env, DSH_HOME: input.dshHome }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    input.exe,
    [
      `--user-data-dir=${input.userDataDir}`,
      `--remote-debugging-port=${input.port}`,
      `--lang=${process.env.DSH_E2E_LANG ?? 'en-US'}`,
    ],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const logs = []
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  return { child, logs, stop: () => stopChild(child) }
}

function activateElement(node) {
  node.click()
  return true
}

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

async function findPage(browser, predicate, timeoutMs) {
  return await pollUntil(
    async () => {
      const pages = await browser.pages()
      return pages.find((page) => predicate(page.url())) ?? null
    },
    { timeoutMs, intervalMs: 300, label: 'a matching renderer page' },
  )
}

const isWelcomeUrl = (url) => {
  try {
    return new URL(url).pathname.endsWith('welcome.html')
  } catch {
    return false
  }
}
const isAppUrl = (url) => {
  try {
    return new URL(url).protocol === 'dsh-app:'
  } catch {
    return false
  }
}

async function dismissOnboarding(browser, consoleErrors) {
  const welcome = await findPage(browser, isWelcomeUrl, 90_000).catch(() => null)
  if (!welcome) return false
  welcome.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`welcome: ${message.text()}`)
  })
  const welcomeLocale = await welcome
    .evaluate(() => [document.documentElement.lang || '(none)', navigator.language, navigator.languages])
    .catch(() => '(unavailable)')
  console.log(`[desktop-e2e] welcome window locale=${JSON.stringify(welcomeLocale)}`)
  const clicked = await pollUntil(
    async () => {
      const handle = await welcome
        .evaluateHandle((rawLabels) => {
          const strip = (value) => (value ?? '').replace(/\s+/g, '').trim()
          const labels = rawLabels.map(strip)
          const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], div, span')]
          const exact = candidates.find((node) => labels.includes(strip(node.textContent)))
          const partial = candidates.find((node) => labels.some((label) => strip(node.textContent).startsWith(label)))
          return exact ?? partial ?? null
        }, ONBOARDING_LABELS)
        .catch(() => null)
      const element = handle?.asElement()
      if (!element) return null
      const picked = await element.evaluate((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
      await element.evaluate(activateElement)
      return picked || ONBOARDING_LABELS[0]
    },
    {
      timeoutMs: 60_000,
      intervalMs: 400,
      label: 'the "configure later" onboarding button',
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
  await pollUntil(
    async () => {
      const pages = await browser.pages()
      return pages.some((page) => isWelcomeUrl(page.url())) ? null : true
    },
    { timeoutMs: 60_000, intervalMs: 300, label: 'the onboarding window to close' },
  )
  return clicked ?? null
}

test('the desktop shell renders the host-management window with legible buttons', { timeout: 1_200_000 }, async (t) => {
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
  let app = null
  let browser = null
  let page = null
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
    const appVersion = desktopAppVersion(exe) ?? 'unknown'
    console.log(`[desktop-e2e] app=${exe} appVersion=${appVersion} plugin=${path.basename(tarball)}`)
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
    await t.test('the renderer runs the plugin and opens host management from the switcher row', async () => {
      const skipped = await dismissOnboarding(browser, consoleErrors)
      console.log(`[desktop-e2e] onboarding ${skipped ? `dismissed via "${skipped}"` : 'not shown'}`)
      page = await findPage(browser, isAppUrl, 180_000)
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
      await page.setViewport({ width: 1400, height: 950 }).catch(() => {})
      // An occluded desktop window pauses the dialog fade-in at opacity 0, which
      // would make the contrast measurement depend on window focus.
      await emulateReducedMotion(page)
      console.log(
        `[desktop-e2e] renderer locale=${JSON.stringify(await page.evaluate(() => [navigator.language, navigator.languages]))}`,
      )
      await openManageWindow(page)
      await closeManageWindow(page)
      await openManageWindow(page)
      assert.equal(
        await page.$('[data-testid="settings-remote-section"]'),
        null,
        'the plugin must not register a settings section',
      )
      const applied = await page.evaluate(() => {
        const win = document.querySelector('[data-testid="manage-window"]')
        if (!win) return { present: false }
        const style = getComputedStyle(win)
        return {
          present: true,
          hasPluginClass: win.closest('.drg-root.drg-overlay') !== null,
          primary: style.getPropertyValue('--dsw-alias-button-primary-fill').trim(),
        }
      })
      assert.equal(applied.present, true, 'the host-management window did not mount in the desktop shell')
      assert.equal(applied.hasPluginClass, true, 'the plugin root class is missing around the desktop window')
      assert.ok(
        applied.primary !== '',
        'the host button-primary token did not resolve in the desktop shell (stylesheet missing or the shell dropped the token)',
      )
    })
    await t.test('every button label is legible in light and dark mode', async () => {
      await assertLightAndDark(page, 'desktop')
    })
    await t.test('the shell logged no console errors while rendering the window', async () => {
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

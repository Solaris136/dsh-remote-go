/**
 * Browser-level acceptance for the **remote panel** — the plugin's `main` surface
 * that embeds the remote DSH in a sandboxed iframe (docs/design.md §4.3,
 * docs/session-design.md §9). Shared by the two real-installation suites:
 *
 * - `test/integration/web.e2e.js`     — `dsh web` in Chrome
 * - `test/integration/desktop.e2e.js` — the Electron desktop shell (Windows)
 *
 * Why this exists: the suites above prove that the Settings → "Remote hosts"
 * section mounts and stays legible, but the surface the user actually works in —
 * the full-page panel with the remote UI inside an iframe — had no browser
 * coverage at all. This module drives a **real** connect against the repository's
 * simulated remote host (`e2e/sim`, a real SSH endpoint plus a stub remote web),
 * so the iframe proof needs no external machine, and then asserts the panel from
 * the outside: the frame really loads the remote document, the toolbar affords the
 * documented actions, and a non-loopback iframe URL is refused instead of embedded.
 *
 * Design notes:
 * - The Host is created and connected through the plugin's **own HTTP API from
 *   inside the page**. That keeps the same-origin fence the real client uses and
 *   works identically in `dsh web` and in the desktop shell (whose renderer does
 *   not expose an `http://` origin to the test process).
 * - Every wait is a bounded poll on state that changes; no fixed sleeps before a
 *   navigation. Timeouts dump the panel's observable state (frames, iframe src,
 *   toolbar labels) so a red run explains itself.
 * - Locale: every text comparison normalises **both** sides and accepts the en/zh
 *   candidate, because asserting one language is how this class of bug reached CI
 *   four times. The claim differs per shell, deliberately:
 *     * `dsh web` **exercises both locales** — the suite pins `--lang`
 *       (`DSH_E2E_LANG`, default `en-US`) and both `en-US` and `zh-CN` runs pass;
 *     * the desktop shell is **locale-tolerant, not locale-exercised** — Electron
 *       resolves the plugin locale from the app/OS locale rather than `--lang`, and
 *       CI runs a single OS locale, so the assertions accept whichever language the
 *       shell renders instead of pretending both were driven.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { pollUntil, sleep, tail } from './harness-support.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..')
export const SIM_SCRIPT = path.join(REPO_ROOT, 'e2e', 'sim', 'simulated-remote.mjs')

/** The single credential pair the simulated remote accepts. */
export const SIM_CREDENTIALS = { username: 'sim', password: 'sim' }

/**
 * Selectors the panel contract exposes (`data-testid` in `client.js`). They are
 * the stable surface a shell integration is allowed to rely on.
 */
export const PANEL = Object.freeze({
  root: '[data-testid="dsh-remote-go-panel"]',
  toolbar: '[data-testid="viewport-toolbar"]',
  iframe: 'iframe[data-testid="remote-iframe"]',
  address: '.drg-toolbar-address',
  addressToggle: '.drg-linkbtn',
  back: '[data-testid="viewport-back"]',
  reconnect: '[data-testid="viewport-reconnect"]',
  refresh: '[data-testid="viewport-refresh"]',
  external: '[data-testid="viewport-external"]',
  hostCard: '[data-testid="host-card"]',
  hostOpenInSettings: '[data-testid="settings-host-open"]',
  errorCard: '[data-testid="error-card"]',
})

/** The marker painted by the simulated remote web (e2e/sim/simulated-remote.mjs). */
export const REMOTE_MARKER = 'simulated remote DSH'

/**
 * Parse an absolute URL, or return `null` when the value is not one.
 *
 * Assertions about hosts, ports and protocols go through this instead of pattern
 * matching: a substring/prefix test can be satisfied by a lookalike
 * (`https://trusted.test.evil.test`, `https://evil.test/?next=https://trusted.test`),
 * a parsed component cannot.
 * @param {unknown} value
 * @returns {URL | null}
 */
export function parseAbsoluteUrl(value) {
  try {
    return new URL(String(value ?? ''))
  } catch {
    return null
  }
}

/**
 * Assert that a URL is the loopback `http://127.0.0.1:<port>` form the tunnel must
 * expose, and return the parsed URL for further component assertions.
 * @param {unknown} value
 * @param {string} label
 * @returns {URL}
 */
export function assertLoopbackUrl(value, label) {
  const parsed = parseAbsoluteUrl(value)
  assert.ok(parsed, `${label}: not an absolute URL: ${JSON.stringify(value)}`)
  assert.equal(parsed.protocol, 'http:', `${label}: expected the http protocol, got ${parsed.protocol}`)
  assert.equal(parsed.hostname, '127.0.0.1', `${label}: expected a loopback hostname, got ${parsed.hostname}`)
  const port = Number(parsed.port)
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, `${label}: expected a real port, got ${parsed.port}`)
  return parsed
}

/** The masked address the toolbar renders while the address is visible (`user@host:port`). */
export const MASKED_ADDRESS = /^(?:[^@\s]+@)?127\.0\.0\.1:\d{1,5}$/
/** What the toolbar renders instead of the address when it is hidden. */
export const HIDDEN_ADDRESS = '••••••'

/**
 * Assert that no iframe on the page embeds a non-loopback absolute origin.
 *
 * Relative and non-`http(s)` sources (`about:blank`, an app-owned frame) cannot be
 * a remote embed and are skipped; every absolute http(s) source is parsed and its
 * hostname compared, so a lookalike host cannot satisfy this.
 * @param {import('puppeteer-core').Page} page
 * @param {string} label
 * @returns {Promise<string[]>} the raw sources, for diagnostics
 */
export async function assertNoNonLoopbackIframes(page, label) {
  const sources = await page.$$eval('iframe', (nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
  for (const source of sources) {
    const parsed = parseAbsoluteUrl(source)
    if (parsed === null) continue
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    assert.equal(parsed.protocol, 'http:', `${label}: an iframe uses ${parsed.protocol}: ${source}`)
    assert.equal(parsed.hostname, '127.0.0.1', `${label}: an iframe embeds a non-loopback host: ${source}`)
  }
  return sources
}

/** Toolbar labels, both locales (`client.js` dictionaries). */
export const LABELS = Object.freeze({
  reconnect: ['重连', 'Reconnect'],
  refresh: ['刷新界面', 'Refresh view'],
  external: ['在新窗口打开', 'Open in new window'],
  addressHide: ['隐藏地址', 'Hide address'],
  addressShow: ['显示地址', 'Show address'],
  back: ['返回主机清单', 'Back to hosts'],
})

/**
 * The client-side refusal shown when an iframe URL is not loopback
 * (`client.js` LOCAL_ERRORS['blocked-iframe']). Both locales, normalised later.
 */
export const BLOCKED_TEXT = {
  title: ['已阻止内嵌远端界面', 'Blocked embedding the remote UI'],
  detail: [
    '远端地址不是本地回环地址，出于安全考虑已阻止内嵌。',
    'The remote address is not a loopback address, so embedding was blocked for safety.',
  ],
}

/** Fold whitespace the same way on both sides of a comparison. */
export function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, '')
    .trim()
}

/**
 * Does `actual` equal one of the candidates once both are normalised?
 * @param {unknown} actual
 * @param {readonly string[]} candidates
 */
export function textMatchesAny(actual, candidates) {
  const normalized = normalizeText(actual)
  return candidates.some((candidate) => normalizeText(candidate) === normalized)
}

/**
 * Does `actual` contain one of the candidates once both are normalised?
 * Used for cards that concatenate title and detail into one text node.
 * @param {unknown} actual
 * @param {readonly string[]} candidates
 */
export function textIncludesAny(actual, candidates) {
  const normalized = normalizeText(actual)
  return candidates.some((candidate) => normalized.includes(normalizeText(candidate)))
}

/**
 * Start the simulated remote host (`--serve`) with a **private** state file, then
 * wait for the ports it publishes.
 *
 * The private state file matters: `test/integration/*.e2e.js` files run in one
 * `node --test` invocation, and a shared `e2e/sim/.state.json` would let two
 * simulators race on the same file.
 * @param {{ stateFile: string, workspaceFixture?: string | null }} options
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, state: any, logs: string[], stop: () => Promise<void> }>}
 */
export async function startSimulatedRemote(options) {
  if (typeof options?.stateFile !== 'string' || options.stateFile === '') {
    throw new Error('startSimulatedRemote needs a private stateFile path')
  }
  const stateFile = options.stateFile
  mkdirSync(path.dirname(stateFile), { recursive: true })
  rmSync(stateFile, { force: true })
  /** @type {string[]} */
  const logs = []
  const args = [SIM_SCRIPT, '--serve', '--state-file', stateFile]
  if (typeof options.workspaceFixture === 'string' && options.workspaceFixture !== '') {
    args.push('--workspace-fixture', options.workspaceFixture)
  }
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // The local development host may run the harness binary as Node; real Node
      // ignores this variable.
      ELECTRON_RUN_AS_NODE: '1',
      SIM_SSH_USER: SIM_CREDENTIALS.username,
      SIM_SSH_PASSWORD: SIM_CREDENTIALS.password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A guard test enforces windowsHide on every child process in test/**; it also
    // keeps a console from flashing on Windows.
    windowsHide: true,
  })
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')))

  try {
    const state = await pollUntil(
      () => {
        if (child.exitCode !== null) throw new Error(`the simulator exited early (${child.exitCode})\n${tail(logs)}`)
        if (!existsSync(stateFile)) return null
        try {
          const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
          return Number(parsed.pid) === child.pid && Number(parsed.sshPort) > 0 && Number(parsed.remotePort) > 0
            ? parsed
            : null
        } catch {
          // The child may be mid-write; retry until the deadline.
          return null
        }
      },
      { timeoutMs: 60_000, intervalMs: 50, label: 'the simulated remote state file' },
    )
    return { child, state, logs, stop: () => stopSimulatedRemote(child, stateFile) }
  } catch (error) {
    await stopSimulatedRemote(child, stateFile)
    throw error
  }
}

/**
 * Stop a simulator started by `startSimulatedRemote`: SIGTERM, then SIGKILL, and
 * remove only the state file that child published.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} stateFile
 * @returns {Promise<boolean>}
 */
export async function stopSimulatedRemote(child, stateFile) {
  if (!child) return true
  let stopped = child.exitCode !== null
  if (!stopped) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      child.kill('SIGTERM')
      stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])
      }
    } catch {
      stopped = child.exitCode !== null
    }
  }
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (Number(state.pid) === child.pid) rmSync(stateFile, { force: true })
  } catch {
    /* nothing published, or already gone */
  }
  return stopped || child.exitCode !== null
}

/**
 * Call the plugin's own HTTP API **from inside the page**.
 *
 * Running in the renderer keeps the browser's same-origin fence and the plugin's
 * `x-dsh-remote-go` header contract, and it is the only way to reach the API in
 * the desktop shell (whose document does not live on an `http://` origin).
 * @param {import('puppeteer-core').Page} page
 * @param {'GET' | 'POST' | 'DELETE'} method
 * @param {string} route path below `/dsh-remote-go/api`
 * @param {object} [body]
 * @returns {Promise<{ status: number, payload: any, text: string }>}
 */
export async function pluginCall(page, method, route, body) {
  return await page.evaluate(
    async ({ method: verb, route: path_, body: payload }) => {
      const headers = { accept: 'application/json', 'x-dsh-remote-go': '1' }
      const init = { method: verb, headers, credentials: 'same-origin' }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json; charset=utf-8'
        init.body = JSON.stringify(payload)
      }
      const response = await fetch(`/dsh-remote-go/api${path_}`, init)
      const text = await response.text()
      let json = null
      try {
        json = text === '' ? null : JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, payload: json, text }
    },
    { method, route, body },
  )
}

/**
 * Create the simulated host and connect it through the plugin's API, answering the
 * host-key prompt the way the panel does.
 *
 * `overrideVersion` is deliberate: it lets the suite run against a harness build
 * whose DSH version differs from the one the simulator advertises, which is a
 * version-warning path, not a mirror/panel defect.
 * @param {import('puppeteer-core').Page} page
 * @param {{ hostName: string, sshPort: number, logs?: string[] | null, timeoutMs?: number }} options
 * @returns {Promise<{ hostId: string, host: any }>}
 */
export async function connectSimulatedHost(page, options) {
  const timeoutMs = options.timeoutMs ?? 180_000
  // A simulator that died (a bad host key, a port clash) is the usual reason the
  // connect never happens, so its log tail belongs in the failure message.
  const simTail = () =>
    Array.isArray(options.logs) && options.logs.length > 0 ? `\n[sim]\n${tail(options.logs, '', 12)}` : ''
  const created = await pluginCall(page, 'POST', '/hosts', {
    host: {
      name: options.hostName,
      address: '127.0.0.1',
      port: options.sshPort,
      username: SIM_CREDENTIALS.username,
      auth: { type: 'password' },
      keepAlive: 'keep',
      bootstrap: { mode: 'reuse' },
    },
  })
  const hostId = created.payload?.host?.id
  assert.ok(
    hostId,
    `the plugin did not create the host (HTTP ${created.status}: ${created.text.slice(0, 400)})${simTail()}`,
  )

  const connect = await pluginCall(page, 'POST', `/hosts/${encodeURIComponent(hostId)}/connect`, {
    password: SIM_CREDENTIALS.password,
    rememberFingerprint: false,
    overrideVersion: true,
  })
  assert.equal(connect.status, 200, `connect was refused: ${connect.text.slice(0, 400)}${simTail()}`)

  let confirmed = false
  const host = await pollUntil(
    async () => {
      const state = await pluginCall(page, 'GET', '/state')
      const view = state.payload?.state?.hosts?.find((host_) => host_ && host_.id === hostId) ?? null
      if (!view) return null
      if (view.status === 'fingerprint-pending' && !confirmed) {
        // The panel renders this prompt; answering it through the API keeps the
        // browser assertions focused on the panel instead of the modal.
        confirmed = true
        const accepted = await pluginCall(page, 'POST', `/hosts/${encodeURIComponent(hostId)}/fingerprint`, {
          accept: true,
          remember: false,
        })
        assert.equal(accepted.status, 200, `the fingerprint was not accepted: ${accepted.text.slice(0, 400)}`)
        return null
      }
      if (view.status === 'connected' || view.status === 'error' || view.status === 'limited') return view
      return null
    },
    {
      timeoutMs,
      intervalMs: 250,
      label: 'the simulated host to connect through the plugin',
      diagnose: async () => `${JSON.stringify(await readHosts(page))}${simTail()}`,
    },
  )
  assert.notEqual(host.status, 'error', `the connect pipeline failed: ${JSON.stringify(host.error)}`)
  assert.equal(host.status, 'connected', `unexpected host status ${host.status}`)
  assert.equal(host.remote?.uiReady, true, 'the remote UI was never verified by the Host')
  return { hostId, host }
}

/**
 * A compact snapshot of the plugin's own state, for failure messages.
 * @param {import('puppeteer-core').Page} page
 */
export async function readHosts(page) {
  try {
    const state = await pluginCall(page, 'GET', '/state')
    return (state.payload?.state?.hosts ?? []).map((host) => ({
      id: host.id,
      status: host.status,
      phase: host.phase,
      error: host.error?.code ?? null,
      remote: { version: host.remote?.version ?? null, uiReady: host.remote?.uiReady === true },
    }))
  } catch (error) {
    return [{ error: String(error?.message ?? error) }]
  }
}

/**
 * Open the remote panel for one host from the Settings section.
 *
 * The panel is a `main` surface, not a sidebar entry (client.js: host management
 * lives in Settings and the remote UI opens in the main panel), so the UI path is
 * the contract: the section's "Open remote UI" action requests the panel and the
 * shell switches to it.
 * @param {import('puppeteer-core').Page} page
 * @param {{ hostId: string, timeoutMs?: number }} options
 */
export async function openRemotePanel(page, options) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const card = `${PANEL.hostCard}[data-host-id="${options.hostId}"]`
  await page.waitForSelector(card, { timeout: timeoutMs })
  // The section only enables "Open remote UI" for a connected host; wait for the
  // state the button reacts to instead of clicking a disabled control.
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector)
      return node !== null && node.getAttribute('data-status') === 'connected'
    },
    { timeout: timeoutMs, polling: 200 },
    card,
  )
  const opened = await page.evaluate((selector) => {
    const button = document.querySelector(selector)
    if (!button || button.disabled) return false
    button.click()
    return true
  }, PANEL.hostOpenInSettings)
  assert.equal(opened, true, 'the settings section did not expose an enabled "Open remote UI" action')
  await page.waitForSelector(PANEL.root, { timeout: timeoutMs })
  return PANEL.root
}

/**
 * Wait for the iframe the panel mounts, then for the remote document inside it to
 * reach a ready state and paint its known marker.
 *
 * The frame is cross-origin (the tunnel listens on a second loopback port), so this
 * resolves it through `page.frames()` and evaluates inside it — the same way a user
 * sees the remote UI, not a DOM-shape guess about the parent.
 * @param {import('puppeteer-core').Page} page
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ iframeSrc: string, frame: import('puppeteer-core').Frame, frameTitle: string, marker: string }>}
 */
export async function waitForRemoteFrame(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000
  const iframeSrc = await pollUntil(
    () => page.$eval(PANEL.iframe, (node) => node.getAttribute('src') ?? null).catch(() => null),
    {
      timeoutMs,
      intervalMs: 200,
      label: 'the panel to mount the remote iframe',
      diagnose: async () => JSON.stringify(await describePanel(page)),
    },
  )
  assertLoopbackUrl(iframeSrc, 'the panel iframe')

  const loaded = await pollUntil(
    async () => {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame())
      for (const frame of frames) {
        // Parse, don't prefix-match: `http://127.0.0.1.evil.test/` starts with the
        // loopback literal and would pass a `startsWith` check.
        const frameUrl = parseAbsoluteUrl(frame.url())
        if (frameUrl === null || frameUrl.hostname !== '127.0.0.1') continue
        const state = await frame
          .evaluate(
            (marker) => ({
              ready: document.readyState,
              title: document.title,
              text: document.body ? document.body.innerText : '',
              painted: Boolean(document.querySelector('h1')),
              simulated: (document.body ? document.body.innerText : '').includes(marker),
            }),
            REMOTE_MARKER,
          )
          .catch(() => null)
        if (state && state.ready === 'complete' && state.painted && state.simulated) {
          return { frame, title: state.title, text: state.text }
        }
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 250,
      label: 'the remote iframe document to load',
      diagnose: async () => JSON.stringify(await describePanel(page)),
    },
  )
  return {
    iframeSrc: String(iframeSrc),
    frame: loaded.frame,
    frameTitle: loaded.title,
    ready: 'complete',
    marker: REMOTE_MARKER,
  }
}

/**
 * Assert the panel's user-visible affordances: the toolbar buttons documented in
 * design §4.3, the address row, and that "hide address" really changes what is
 * rendered (and is reversible).
 * @param {import('puppeteer-core').Page} page
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ address: string, hidden: string, labels: Record<string, string> }>}
 */
export async function assertPanelToolbar(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  await page.waitForSelector(PANEL.toolbar, { timeout: timeoutMs })

  /** Read one control's label, its disabled state and whether it is laid out. */
  const readControl = async (selector) =>
    await page.evaluate((selector_) => {
      const node = document.querySelector(selector_)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        label: (node.getAttribute('aria-label') ?? node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        title: node.getAttribute('title') ?? '',
        disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }, selector)

  /** @type {Record<string, { label: string, title: string, disabled: boolean, width: number, height: number }>} */
  const controls = {}
  for (const [name, selector] of [
    ['reconnect', PANEL.reconnect],
    ['refresh', PANEL.refresh],
    ['external', PANEL.external],
    ['back', PANEL.back],
    ['addressToggle', PANEL.addressToggle],
  ]) {
    const control = await readControl(selector)
    assert.ok(control, `the panel toolbar is missing the "${name}" control (${selector})`)
    assert.ok(control.width > 0 && control.height > 0, `the "${name}" control has no layout box`)
    controls[name] = control
  }
  // Labels are localised; assert the documented meaning in either language.
  assert.ok(
    textMatchesAny(controls.reconnect.label, LABELS.reconnect),
    `unexpected reconnect label ${controls.reconnect.label}`,
  )
  assert.ok(
    textMatchesAny(controls.refresh.label, LABELS.refresh),
    `unexpected refresh label ${controls.refresh.label}`,
  )
  assert.ok(
    textMatchesAny(controls.external.label, LABELS.external),
    `unexpected external label ${controls.external.label}`,
  )
  assert.ok(textMatchesAny(controls.back.label, LABELS.back), `unexpected back label ${controls.back.label}`)
  // The actions that make sense on a connected host are enabled.
  assert.equal(controls.refresh.disabled, false, 'the refresh action is disabled on a connected host')
  assert.equal(controls.external.disabled, false, 'the open-in-new-window action is disabled on a connected host')

  const address = await page.$eval(PANEL.address, (node) => (node.textContent ?? '').trim())
  assert.match(address, MASKED_ADDRESS, `the toolbar does not render the loopback address: ${JSON.stringify(address)}`)
  assert.ok(
    textMatchesAny(controls.addressToggle.label, LABELS.addressHide),
    `the address toggle is not offering "hide": ${controls.addressToggle.label}`,
  )

  // Hide → the rendered address text changes (and the control flips to "show").
  await page.$eval(PANEL.addressToggle, (node) => node.click())
  const hidden = await pollUntil(
    async () => {
      const text = await page.$eval(PANEL.address, (node) => (node.textContent ?? '').trim())
      // Both sides are folded: the address row is not localised today, but the
      // "strip one side only" shape is exactly what broke the label comparisons.
      return normalizeText(text) === normalizeText(HIDDEN_ADDRESS) ? text : null
    },
    { timeoutMs, intervalMs: 100, label: 'the address row to hide the address' },
  )
  const toggleAfterHide = await page.$eval(PANEL.addressToggle, (node) =>
    (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
  assert.ok(
    textMatchesAny(toggleAfterHide, LABELS.addressShow),
    `the address toggle did not flip to "show": ${toggleAfterHide}`,
  )

  // Show → the loopback address comes back, so the toggle is not a one-way mask.
  await page.$eval(PANEL.addressToggle, (node) => node.click())
  const restored = await pollUntil(
    async () => {
      const text = await page.$eval(PANEL.address, (node) => (node.textContent ?? '').trim())
      return MASKED_ADDRESS.test(text) ? text : null
    },
    { timeoutMs, intervalMs: 100, label: 'the address row to show the address again' },
  )
  return {
    address,
    hidden,
    restored,
    labels: {
      reconnect: controls.reconnect.label,
      refresh: controls.refresh.label,
      external: controls.external.label,
      back: controls.back.label,
      toggleHide: controls.addressToggle.label,
      toggleShow: toggleAfterHide,
    },
  }
}

/**
 * Prove the refresh action is wired: it re-creates the iframe node (React key
 * change), and the re-created frame loads the remote document again.
 * @param {import('puppeteer-core').Page} page
 * @param {{ timeoutMs?: number }} [options]
 */
export async function assertFrameRefresh(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000
  await page.$eval(PANEL.iframe, (node) => node.setAttribute('data-panel-e2e', 'before'))
  await page.$eval(PANEL.refresh, (node) => node.click())
  const replaced = await pollUntil(
    () =>
      page
        .waitForFunction(
          (selector) => {
            const node = document.querySelector(selector)
            return node !== null && !node.hasAttribute('data-panel-e2e')
          },
          { timeout: 5_000, polling: 100 },
          PANEL.iframe,
        )
        .then(() => true)
        .catch(() => null),
    { timeoutMs, intervalMs: 200, label: 'the refresh action to rebuild the iframe node' },
  )
  assert.equal(replaced, true, 'the refresh action did not rebuild the iframe')
  // The rebuilt frame must load the same remote document, not a blank frame.
  const reloaded = await waitForRemoteFrame(page, { timeoutMs })
  return { iframeSrc: reloaded.iframeSrc, marker: reloaded.marker }
}

/**
 * Switch the panel's viewport to another host through the toolbar's host switcher.
 *
 * This is also how the suite forces a fresh `GET /hosts/:id/open`: the client
 * fetches that URL once per viewport mount and deliberately keeps it while the
 * user navigates back to the host list, so a *host change* is the in-UI action
 * that re-fetches it. It works identically in both shells (no reload).
 * @param {import('puppeteer-core').Page} page
 * @param {{ hostId: string, hostName?: string, timeoutMs?: number }} options
 */
export async function switchPanelHost(page, options) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const selector = `${PANEL.toolbar} select`
  await pollUntil(async () => ((await page.$(selector)) === null ? null : true), {
    timeoutMs,
    intervalMs: 200,
    label: 'the panel host switcher to appear',
    diagnose: async () => JSON.stringify(await describePanel(page)),
  })
  await page.select(selector, options.hostId)
  if (typeof options.hostName === 'string' && options.hostName !== '') {
    await pollUntil(
      async () => {
        const shown = await page
          .$eval(`${PANEL.toolbar} .drg-toolbar-host`, (node) => (node.textContent ?? '').trim())
          .catch(() => null)
        // Normalise both sides: a host name is user input, so a name with
        // collapsing whitespace must still be recognised after switching.
        return normalizeText(shown) === normalizeText(options.hostName) ? shown : null
      },
      {
        timeoutMs,
        intervalMs: 100,
        label: 'the panel to switch to the second host',
        diagnose: async () => JSON.stringify(await describePanel(page)),
      },
    )
  }
}

/**
 * Force the Host's `GET /hosts/:id/open` answer to a **non-loopback** origin from
 * inside the page, so the client's loopback guard is what must refuse it.
 *
 * A page-level `fetch` stub rather than CDP request interception: the desktop
 * shell fetches over its `dsh-app://` custom scheme, which the Fetch domain does
 * not route, so interception silently sees nothing there. Patching the global the
 * client resolves per request (`getFetch()`) works in both shells.
 * @param {import('puppeteer-core').Page} page
 * @param {{ url?: string }} [options]
 * @returns {Promise<{ forcedUrl: string, origin: string, calls: () => Promise<number>, disable: () => Promise<void> }>}
 */
export async function stubNonLoopbackIframeUrl(page, options = {}) {
  const forcedUrl = options.url ?? 'https://remote.example.com/?token=e2e-not-loopback'
  const origin = new URL(forcedUrl).origin
  await page.evaluate((forced) => {
    const scope = window
    if (!scope.__dshPanelE2EOriginalFetch) scope.__dshPanelE2EOriginalFetch = scope.fetch
    const original = scope.__dshPanelE2EOriginalFetch
    scope.__dshPanelE2EOpenCalls = 0
    scope.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : (input && input.url) || ''
      if (/\/dsh-remote-go\/api\/hosts\/[^/]+\/open(?:[?#]|$)/.test(raw)) {
        scope.__dshPanelE2EOpenCalls += 1
        const body = JSON.stringify({ ok: true, url: forced, localPort: 1, address: 'remote.example.com:1' })
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return original.call(scope, input, init)
    }
  }, forcedUrl)
  return {
    forcedUrl,
    origin,
    /** @returns {Promise<number>} how many times the panel asked for `/open` while stubbed */
    async calls() {
      return await page.evaluate(() => window.__dshPanelE2EOpenCalls ?? 0)
    },
    async disable() {
      await page.evaluate(() => {
        const scope = window
        if (scope.__dshPanelE2EOriginalFetch) {
          scope.fetch = scope.__dshPanelE2EOriginalFetch
          delete scope.__dshPanelE2EOriginalFetch
        }
        delete scope.__dshPanelE2EOpenCalls
      })
    },
  }
}

/**
 * The negative path: with a non-loopback URL forced on `/open`, the panel must
 * refuse to embed and show the documented "blocked" card instead.
 *
 * Green here is the security property: a hostile or compromised answer must never
 * become an iframe src in the local GUI.
 * @param {import('puppeteer-core').Page} page
 * @param {{ forceRefetch: () => Promise<void>, intercepted: () => Promise<number>, forbiddenOrigin: string, timeoutMs?: number }} options
 * @returns {Promise<{ cardText: string, iframeSrcs: string[], panelIframe: string | null }>}
 */
export async function assertBlockedIframe(page, options) {
  // The card renders ~400 ms after the switch when the guard is intact, so a
  // 30 s budget keeps a genuine regression fast instead of burning the full
  // default. It is still far above the observed spread (CI is slower than local).
  const timeoutMs = options.timeoutMs ?? 30_000
  await options.forceRefetch()

  // Poll for either outcome, so a bypass is reported as "it embedded <url>"
  // within milliseconds instead of as a 30 s "card never appeared" timeout.
  const outcome = await pollUntil(
    async () => {
      const sources = await page.$$eval('iframe', (nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
      for (const source of sources) {
        const parsed = parseAbsoluteUrl(source)
        if (parsed === null) continue
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
        if (parsed.hostname !== '127.0.0.1') return { kind: 'bypass', source }
      }
      const text = await page
        .$eval(PANEL.errorCard, (node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .catch(() => null)
      if (text && textIncludesAny(text, BLOCKED_TEXT.title) && textIncludesAny(text, BLOCKED_TEXT.detail)) {
        return { kind: 'blocked', text }
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 100,
      label: 'the panel to refuse a non-loopback iframe URL',
      diagnose: async () => JSON.stringify(await describePanel(page)),
    },
  )
  assert.equal(
    outcome.kind,
    'blocked',
    `the panel embedded a non-loopback origin instead of refusing it: ${outcome.source}`,
  )
  const cardText = outcome.text

  // The client must have asked for the URL at all, or "no iframe" proves nothing.
  const intercepted = await options.intercepted()
  assert.ok(intercepted >= 1, 'the panel never requested /hosts/:id/open, so the guard was not exercised')
  // No panel iframe, and nothing anywhere may embed a non-loopback origin. Both
  // checks parse the URL rather than matching text: a substring test for the
  // hostname would be satisfied by a lookalike host.
  const panelIframe = await page.$eval(PANEL.iframe, (node) => node.getAttribute('src') ?? '').catch(() => null)
  assert.equal(panelIframe, null, `the panel embedded an iframe for a blocked URL: ${panelIframe}`)
  const iframeSrcs = await assertNoNonLoopbackIframes(page, 'the blocked state')
  // `outerHTML` cannot be parsed, so scan the rendered attribute/text values for
  // URL runs, parse each run and compare **origins** with the refused one.
  const origins = await renderedOrigins(page)
  assert.equal(
    new Set(origins).has(options.forbiddenOrigin),
    false,
    `the refused origin was rendered into the page: ${options.forbiddenOrigin} (seen: ${JSON.stringify(origins)})`,
  )
  return { cardText, iframeSrcs, panelIframe }
}

/**
 * Every absolute `http(s)` origin rendered in the page's attributes or text.
 *
 * `outerHTML` cannot be parsed as a document, and matching a hostname inside it is
 * exactly the check a lookalike defeats (`https://good.test/?next=https://evil.test`,
 * `https://good.test.evil.test/`). So the serialized values are split into URL
 * runs on characters a URL cannot contain, and each run is parsed; the caller then
 * compares whole origins.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string[]>}
 */
async function renderedOrigins(page) {
  return await page.evaluate(() => {
    const separators = new Set([' ', '\t', '\n', '\r', '"', "'", '<', '>', '(', ')', '`', '\\', ',', ';'])
    /** @type {string[]} */
    const values = []
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) values.push(attribute.value)
    }
    if (document.body) values.push(document.body.innerText)
    /** @type {Set<string>} */
    const origins = new Set()
    for (const value of values) {
      // Attribute serialization escapes `&`; a URL is compared after decoding it.
      const text = String(value ?? '')
        .split('&amp;')
        .join('&')
      let run = ''
      const flush = () => {
        if (run === '') return
        try {
          const parsed = new URL(run)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin)
        } catch {
          /* not a URL, ignore */
        }
        run = ''
      }
      for (const char of text) {
        if (separators.has(char)) flush()
        else run += char
      }
      flush()
    }
    return [...origins]
  })
}

/**
 * Everything the failure diagnostics need about the panel, in one JSON-safe object.
 * @param {import('puppeteer-core').Page} page
 */
export async function describePanel(page) {
  try {
    return await page.evaluate((selectors) => {
      const strip = (value) => (value ?? '').replace(/\s+/g, ' ').trim()
      const panel = document.querySelector(selectors.root)
      const iframe = document.querySelector(selectors.iframe)
      return {
        url: location.href,
        panel: panel !== null,
        viewportStatus: panel ? panel.getAttribute('data-status') : null,
        iframe: iframe ? iframe.getAttribute('src') : null,
        iframeCount: document.querySelectorAll('iframe').length,
        toolbar: [...document.querySelectorAll(`${selectors.toolbar} button`)].map((node) => strip(node.textContent)),
        address: document.querySelector(selectors.address)
          ? strip(document.querySelector(selectors.address).textContent)
          : null,
        errorCard: document.querySelector(selectors.errorCard)
          ? strip(document.querySelector(selectors.errorCard).textContent).slice(0, 240)
          : null,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        text: strip(document.body?.innerText).slice(0, 240),
      }
    }, PANEL)
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

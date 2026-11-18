import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const isWindows = process.platform === 'win32'

export const STRICT = process.env.DSH_E2E_STRICT === '1'

export function skipOrFail(t, reason) {
  if (STRICT) throw new Error(`E2E prerequisite missing (DSH_E2E_STRICT=1): ${reason}`)
  t.skip(reason)
}

// Puppeteer's waitForFunction polls with requestAnimationFrame by default, and Chromium
// pauses rAF for background pages: a guest that had already booted could sit out the whole
// timeout. Timer polling is throttled in the background but never stopped, so every E2E
// readiness check goes through this helper instead of rAF.
export const POLLING_MS = 250

/**
 * Give a fresh DSH home one configured host. The contrast gate measures the 11–12px metadata on
 * a host card; a clean profile has no cards, which made those assertions vacuous (review nit 4).
 */
export function seedFixtureHost(dshHome) {
  const stateDir = path.join(dshHome, 'remote-go')
  mkdirSync(stateDir, { recursive: true })
  const at = '2026-01-01T00:00:00.000Z'
  writeFileSync(
    path.join(stateDir, 'hosts.json'),
    `${JSON.stringify(
      [
        {
          id: 'h_fixture',
          name: 'Fixture host',
          address: 'fixture.example',
          port: 22,
          username: 'fixture',
          auth: { type: 'key', keyPath: '~/.ssh/id_rsa' },
          jumpHost: null,
          keepAlive: 'keep',
          idleMinutes: 15,
          autoReconnect: true,
          hostKeyPolicy: 'first-use',
          lastOpenedAt: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
      null,
      2,
    )}\n`,
    'utf8',
  )
}

export function waitFor(page, predicate, options = {}, ...args) {
  return page.waitForFunction(predicate, { polling: POLLING_MS, ...options }, ...args)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function pollUntil(check, options) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 250
  const started = Date.now()
  let lastError = null
  while (Date.now() - started <= timeoutMs) {
    try {
      const value = await check()
      if (value) return /** @type {T} */ value
      lastError = null
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  let detail = ''
  if (options.diagnose) {
    try {
      const described = await options.diagnose()
      if (described) detail = ` — ${described}`
    } catch {}
  }
  throw new Error(
    `${options.label} timed out after ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : '') +
      detail,
  )
}

export function tail(stdout, stderr = '', lines = 20) {
  const text = Array.isArray(stdout) ? stdout.join('') : stdout
  return `${text}\n${stderr}`.trim().split(/\r?\n/).slice(-lines).join('\n')
}

function signalTree(child, signal) {
  if (!child || !child.pid) return
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  signalTree(child, 'SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])
  if (stopped) return
  signalTree(child, 'SIGKILL')
  await Promise.race([exited, sleep(5_000)])
}

export function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      windowsHide: true,
      detached: !isWindows,
      shell: options.shell === true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      signalTree(child, 'SIGKILL')
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
      if (timedOut) return
      resolve({ code, stdout, stderr })
    })
  })
}

export function resolvePnpm(shimDir) {
  const cjs = process.env.DSH_PNPM_CJS
  if (cjs && existsSync(cjs)) {
    mkdirSync(shimDir, { recursive: true })
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
    return { available: true, pathPrefix: shimDir, reason: null, command: runner, args: [cjs], shell: false }
  }
  const probe = spawnSync('pnpm', ['--version'], {
    encoding: 'utf8',
    shell: isWindows,
    timeout: 30_000,
    windowsHide: true,
  })
  if (probe.status === 0)
    return { available: true, pathPrefix: null, reason: null, command: 'pnpm', args: [], shell: isWindows }
  return {
    available: false,
    pathPrefix: null,
    reason: 'pnpm is not on PATH and DSH_PNPM_CJS does not point at a pnpm entry point',
    command: null,
    args: [],
    shell: false,
  }
}

export async function packPlugin(input) {
  mkdirSync(input.outDir, { recursive: true })
  const result = await runCommand(
    input.pnpm.command,
    [...input.pnpm.args, 'pack', '--pack-destination', input.outDir],
    { cwd: input.cwd, env: input.env, timeoutMs: 300_000, label: 'pnpm pack', shell: input.pnpm.shell },
  )
  if (result.code !== 0) {
    throw new Error(`packing the plugin failed (exit ${result.code})\n${tail(result.stdout, result.stderr)}`)
  }
  const tarballs = readdirSync(input.outDir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(input.outDir, name))
  if (tarballs.length !== 1) throw new Error(`expected exactly one packed tarball, found ${tarballs.length}`)
  return tarballs[0]
}

const REQUIRED_PACKAGE_FILES = [
  'package.json',
  'dist/index.js',
  'dist/client.js',
  'cordis.patch.yml',
  'dist/src/index.js',
  'dist/src/api.js',
  'dist/src/proxy/index.js',
  'dist/src/tools.js',
  'locale/en.json',
  'locale/zh.json',
  'dist/vendor/ssh2.bundle.cjs',
]

export function assertPackedDependency(profileDir) {
  const manifestPath = path.join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`the profile has no package.json at ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const spec = manifest?.dependencies?.['dsh-remote-go']
  if (typeof spec !== 'string') throw new Error('the profile does not depend on dsh-remote-go')
  if (spec.startsWith('link:')) throw new Error(`expected a packed install, got a link dependency: ${spec}`)
  if (!/^file:.*\.tgz$/.test(spec)) throw new Error(`expected a file: tarball dependency, got: ${spec}`)
  for (const expected of REQUIRED_PACKAGE_FILES) {
    const installed = path.join(profileDir, 'node_modules', 'dsh-remote-go', expected)
    if (!existsSync(installed)) {
      throw new Error(`the packed install is missing ${expected} (the published "files" list is incomplete)`)
    }
  }
  return spec
}

export function resolveDshCli() {
  const envBin = process.env.DSH_BIN
  const envExe = process.env.DSH_EXE
  if (envBin && existsSync(envBin)) {
    if (envExe) return { command: envExe, args: [envBin], kind: 'env' }
    if (/\.(?:js|cjs|mjs)$/i.test(envBin)) return { command: process.execPath, args: [envBin], kind: 'env-node' }
    return { command: envBin, args: [], kind: 'env' }
  }
  if (isWindows) {
    // DSH_INSTALL_DIR is set to the package directory inside a running DSH, so probe
    // the standard install roots as well and use whichever one holds the app exe.
    const installs = [
      process.env.DSH_INSTALL_DIR,
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
    ].filter(Boolean)
    for (const install of installs) {
      const exe = path.join(install, 'DeepSeek Harness.exe')
      if (!existsSync(exe)) continue
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
      if (probeVersion(exe, [bin], { ELECTRON_RUN_AS_NODE: '1' })) {
        return { command: exe, args: [bin], kind: 'windows-install' }
      }
      // Node cannot read inside `app.asar`; the installer's runtime CLI shim can
      // (it sets ELECTRON_RUN_AS_NODE itself) and needs no PATH entry.
      const shim = path.join(install, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      if (existsSync(shim) && probeVersion('cmd.exe', ['/d', '/c', shim])) {
        return { command: 'cmd.exe', args: ['/d', '/c', shim], kind: 'windows-runtime-cli' }
      }
    }
  }
  const cliJs = resolveDshCliJs()
  if (cliJs && probeVersion(process.execPath, [cliJs])) {
    return { command: process.execPath, args: [cliJs], kind: 'node-cli' }
  }
  const onPath = spawnSync('dsh', ['--version'], {
    encoding: 'utf8',
    shell: isWindows,
    timeout: 20_000,
    windowsHide: true,
  })
  if (onPath.status === 0) return { command: 'dsh', args: [], kind: 'path' }
  return null
}

function resolveDshCliJs() {
  const suffix = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const candidates = []
  if (process.env.DSH_CLI_JS) candidates.push(process.env.DSH_CLI_JS)
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', suffix))
  if (process.env.PNPM_HOME) candidates.push(path.join(process.env.PNPM_HOME, suffix))
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'global', '5', suffix))
    candidates.push(path.join(process.env.LOCALAPPDATA, 'pnpm', suffix))
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function probeVersion(command, args, env = {}) {
  try {
    const probe = spawnSync(command, [...args, '--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    return probe.status === 0 && /\d+\.\d+\.\d+/.test(`${probe.stdout ?? ''}`)
  } catch {
    return false
  }
}

export function resolveBrowser() {
  for (const key of ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'E2E_CHROME', 'DSH_E2E_BROWSER']) {
    const value = process.env[key]
    if (value && existsSync(value)) return value
  }
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

export function resolveDesktopApp() {
  if (!isWindows) return null
  const explicit = process.env.DSH_DESKTOP_EXE
  if (explicit && existsSync(explicit)) return explicit
  return findDesktopApp() ?? null
}

export function findDesktopApp(options = {}) {
  if (!isWindows) return null
  const roots = []
  const pinned = process.env.DSH_DESKTOP_INSTALL_DIR
  if (pinned) roots.push(pinned)
  for (const key of ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']) {
    const base = process.env[key] ?? process.env[key.toUpperCase()]
    if (base) roots.push(path.join(base, 'Programs'), base)
  }
  roots.push(...(options.extraRoots ?? []))
  const seen = new Set()
  for (const root of roots) {
    if (!root || seen.has(root) || !existsSync(root)) continue
    seen.add(root)
    const direct = path.join(root, 'DeepSeek Harness', 'DeepSeek Harness.exe')
    if (existsSync(direct)) return direct
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(root, entry.name, 'DeepSeek Harness.exe')
      if (existsSync(candidate)) return candidate
      const nested = path.join(root, entry.name, 'DeepSeek Harness', 'DeepSeek Harness.exe')
      if (existsSync(nested)) return nested
    }
  }
  return null
}

export function desktopAppVersion(exe) {
  if (!isWindows) return null
  try {
    const probe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`,
      ],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    )
    const value = (probe.stdout ?? '').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

export async function describePage(page) {
  return await page
    .evaluate(() => {
      const strip = (value) => (value ?? '').replace(/\s+/g, ' ').trim()
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        .map((node) => strip(node.textContent).slice(0, 160))
        .slice(0, 4)
      const labels = [...document.querySelectorAll('button, [role="menuitem"], [role="tab"], a')]
        .map((node) => strip(node.getAttribute('aria-label') ?? node.textContent))
        .filter(Boolean)
        .slice(0, 40)
      return {
        url: location.href,
        dialogs,
        section: Boolean(document.querySelector('[data-testid="manage-window"]')),
        labels,
        text: strip(document.body?.innerText).slice(0, 300),
      }
    })
    .catch((error) => ({ error: String(error?.message ?? error).slice(0, 200) }))
}

export async function writeFailureArtifacts(input) {
  if (!input.dir) return
  try {
    mkdirSync(input.dir, { recursive: true })
    const lines = [
      `error: ${input.error instanceof Error ? input.error.message : String(input.error)}`,
      `url: ${input.page ? input.page.url() : '(no page)'}`,
      `title: ${input.page ? await input.page.title().catch(() => '(unavailable)') : '(no page)'}`,
      '',
      '--- console errors ---',
      ...(input.consoleErrors.length > 0 ? input.consoleErrors : ['(none)']),
      '',
      '--- harness log (tail) ---',
      tail(input.logs, '', 100),
    ]
    writeFileSync(path.join(input.dir, `${input.name}-failure.log`), `${lines.join('\n')}\n`, 'utf8')
    if (input.page) await input.page.screenshot({ path: path.join(input.dir, `${input.name}-failure.png`) })
  } catch {}
}

export function makeTempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`))
}

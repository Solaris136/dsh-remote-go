/**
 * Shared plumbing for the two real-installation E2E suites:
 *
 * - `test/integration/web.e2e.js`     — `dsh web` in a browser (any OS with a harness)
 * - `test/integration/desktop.e2e.js` — the Electron desktop shell (Windows)
 *
 * It exists so both suites install the **packed tarball** the same way, kill
 * process trees the same way, and report failures with the same artifacts. The
 * harnesses differ in how they are launched; everything else is shared.
 *
 * Strictness: `DSH_E2E_STRICT=1` turns a missing prerequisite into a failure. CI
 * sets it (these are required checks); a bare dev machine does not, so
 * `pnpm run verify` still passes there by skipping.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const isWindows = process.platform === 'win32'

/** In CI a missing prerequisite must be loud; locally it is a skip. */
export const STRICT = process.env.DSH_E2E_STRICT === '1'

/**
 * Skip locally, fail in CI.
 * @param {import('node:test').TestContext} t
 * @param {string} reason
 */
export function skipOrFail(t, reason) {
  if (STRICT) {
    // Lazy import keeps this module usable from plain scripts.
    throw new Error(`E2E prerequisite missing (DSH_E2E_STRICT=1): ${reason}`)
  }
  t.skip(reason)
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `check` until it returns a truthy value or the deadline passes.
 *
 * Used for state that lives outside the page (an HTTP endpoint, a file). Inside
 * the page prefer `page.waitForFunction`: it reacts on mutation instead of
 * sampling, so it is both faster and less flaky.
 * @template T
 * @param {() => Promise<T | null | undefined> | T | null | undefined} check
 * @param {{ timeoutMs?: number, intervalMs?: number, label: string, diagnose?: () => Promise<string | null | undefined> }} options
 * @returns {Promise<T>}
 */
export async function pollUntil(check, options) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 250
  const started = Date.now()
  /** @type {unknown} */
  let lastError = null
  while (Date.now() - started <= timeoutMs) {
    try {
      const value = await check()
      if (value) return /** @type {T} */ (value)
      lastError = null
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  // A timeout on a UI poll is otherwise undiagnosable from the log alone, so let the caller
  // describe the state it was waiting on (what the window shows, which page it is on).
  let detail = ''
  if (options.diagnose) {
    try {
      const described = await options.diagnose()
      if (described) detail = ` — ${described}`
    } catch {
      /* diagnostics must never mask the timeout */
    }
  }
  throw new Error(
    `${options.label} timed out after ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : '') +
      detail,
  )
}

/** @param {string[] | string} stdout @param {string} [stderr] @param {number} [lines] */
export function tail(stdout, stderr = '', lines = 20) {
  const text = Array.isArray(stdout) ? stdout.join('') : stdout
  return `${text}\n${stderr}`.trim().split(/\r?\n/).slice(-lines).join('\n')
}

/** @param {import('node:child_process').ChildProcess | null} child */
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Terminate a process tree: polite signal first, then SIGKILL.
 *
 * Both harnesses spawn descendants (`dsh` re-execs itself; Electron spawns
 * helpers), so signalling only the spawned pid leaves an orphan holding the
 * profile and the port.
 * @param {import('node:child_process').ChildProcess | null} child
 */
export async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const stopped = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])
  if (stopped) return
  killTree(child)
  await Promise.race([exited, sleep(5_000)])
}

/**
 * Run one command to completion.
 *
 * `windowsHide` keeps a console from flashing for every child the suite starts on
 * Windows. Keep it on every `spawn`/`spawnSync`/`exec*` in this repository — a
 * guard test (test/unit/e2e-child-process.test.js) fails the build otherwise.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: Record<string, string | undefined>, timeoutMs: number, label: string, cwd?: string, shell?: boolean }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
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
      killTree(child)
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

/**
 * Make `pnpm` usable for the child processes (`dsh plugin add` and `pnpm pack`
 * both shell out to it).
 *
 * `DSH_PNPM_CJS` names a pnpm entry point for machines where pnpm is not on PATH;
 * a shim is written into `shimDir` and prepended to the child PATH.
 *
 * Preference order is deliberate: the explicit `DSH_PNPM_CJS` path runs through
 * `process.execPath` with no shell, and only the PATH fallback needs a shell on
 * Windows (`pnpm` is a `.cmd`, which spawn cannot execute directly). That fallback
 * keeps `windowsHide` so no console window flashes.
 * @param {string} shimDir
 * @returns {{ available: boolean, pathPrefix: string | null, reason: string | null, command: string | null, args: string[], shell: boolean }}
 */
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
  // `windowsHide` keeps a console from flashing for every child the suite starts
  // on Windows (this probe included).
  const probe = spawnSync('pnpm', ['--version'], {
    encoding: 'utf8',
    shell: isWindows,
    timeout: 30_000,
    windowsHide: true,
  })
  if (probe.status === 0) {
    // On Windows `pnpm` is a `.cmd`, which spawn can only run through a shell.
    return { available: true, pathPrefix: null, reason: null, command: 'pnpm', args: [], shell: isWindows }
  }
  return {
    available: false,
    pathPrefix: null,
    reason: 'pnpm is not on PATH and DSH_PNPM_CJS does not point at a pnpm entry point',
    command: null,
    args: [],
    shell: false,
  }
}

/**
 * Build the publishable artifact. Both suites install **this**, so a packaging
 * bug (`files[]`/`exports` drift, a missing `client.js`) fails the E2E instead of
 * shipping.
 * @param {{ pnpm: { command: string, args: string[], shell: boolean }, cwd: string, env: Record<string, string | undefined>, outDir: string }} input
 * @returns {Promise<string>} absolute path of the `.tgz`
 */
export async function packPlugin(input) {
  mkdirSync(input.outDir, { recursive: true })
  const result = await runCommand(
    input.pnpm.command,
    [...input.pnpm.args, 'pack', '--pack-destination', input.outDir],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: 300_000,
      label: 'pnpm pack',
      shell: input.pnpm.shell,
    },
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

/** Files the published `files[]` contract must ship for both halves to run. */
const REQUIRED_PACKAGE_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'src/index.js',
  'src/api.js',
  'locale/en.json',
  'locale/zh.json',
  'vendor/ssh2.bundle.cjs',
]

/**
 * Assert the profile installed the **tarball** (`file:…tgz`), not a `link:` to the
 * working tree, and that the packed tree is complete. This is the point of the
 * installation test.
 * @param {string} profileDir
 * @returns {string} the dependency spec
 */
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

/**
 * Locate the `dsh` CLI.
 *
 * Returns `{ command, args }` such that `spawn(command, [...args, ...cliArgs])`
 * runs it. On a Windows desktop install the CLI lives inside `app.asar`, a virtual
 * filesystem plain Node cannot `existsSync`, so the pair is validated by actually
 * running `--version` — a packaging-layout change then degrades to a skip instead
 * of a hard failure.
 * @returns {{ command: string, args: string[], kind: string } | null}
 */
export function resolveDshCli() {
  const envBin = process.env.DSH_BIN
  const envExe = process.env.DSH_EXE
  if (envBin && existsSync(envBin)) {
    if (envExe) return { command: envExe, args: [envBin], kind: 'env' }
    // A `.js` entry point is not executable on its own (EFTYPE/ENOEXEC).
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
    if (existsSync(exe) && probeVersion(exe, [bin], { ELECTRON_RUN_AS_NODE: '1' })) {
      return { command: exe, args: [bin], kind: 'windows-install' }
    }
  }
  // A globally installed CLI on Windows is a `.cmd` shim; running its `lib/bin.js`
  // through `process.execPath` avoids `cmd.exe` (and therefore a console flash).
  const cliJs = resolveDshCliJs()
  if (cliJs && probeVersion(process.execPath, [cliJs])) {
    return { command: process.execPath, args: [cliJs], kind: 'node-cli' }
  }
  // Last resort: whatever `dsh` resolves to on PATH. On Windows that needs a shell
  // (`.cmd`), which still gets `windowsHide` so nothing flashes.
  const onPath = spawnSync('dsh', ['--version'], {
    encoding: 'utf8',
    shell: isWindows,
    timeout: 20_000,
    windowsHide: true,
  })
  if (onPath.status === 0) return { command: 'dsh', args: [], kind: 'path' }
  return null
}

/**
 * Known absolute locations of the CLI's `lib/bin.js` for an npm/pnpm global install.
 *
 * Deliberately a short list of conventional paths: a wrong guess simply fails the
 * `--version` probe and falls through to the PATH resolution.
 * @returns {string | null}
 */
function resolveDshCliJs() {
  const suffix = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  /** @type {string[]} */
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

/**
 * Does `<command> <args> --version` print a version?
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {boolean}
 */
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

/**
 * Locate a Chromium-based browser for the web suite.
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
 * Locate the Electron desktop app (Windows only — there is no Linux build).
 * @returns {string | null}
 */
export function resolveDesktopApp() {
  if (!isWindows) return null
  const explicit = process.env.DSH_DESKTOP_EXE
  if (explicit && existsSync(explicit)) return explicit
  return findDesktopApp() ?? null
}

/**
 * Find `DeepSeek Harness.exe` without assuming where the NSIS installer put it.
 *
 * electron-builder installs per-user by default (`%LOCALAPPDATA%\Programs\…`) but
 * honours `/D=` and can fall back to Program Files when elevated, so the location
 * is discovered rather than assumed. `DSH_DESKTOP_INSTALL_DIR` pins one directory.
 * @param {{ extraRoots?: string[] }} [options]
 * @returns {string | null}
 */
export function findDesktopApp(options = {}) {
  if (!isWindows) return null
  /** @type {string[]} */
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

/**
 * The desktop app's own version, read from the executable's file metadata.
 *
 * `--version` is useless here: the Electron binary only reports a version when it
 * runs *as Node* (`v24.x`), so PowerShell's FileVersionInfo is the honest source.
 * @param {string} exe
 * @returns {string | null}
 */
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

/**
 * Write the failure bundle CI uploads: screenshot, console errors, page URL, and
 * the harness log tail. Best effort — diagnostics must never mask the assertion.
 * @param {{ dir: string | null, page: import('puppeteer-core').Page | null, logs: string[] | string, consoleErrors: string[], error: unknown, name: string }} input
 */
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
  } catch {
    /* artifacts are diagnostics only */
  }
}

/**
 * A fresh temp workspace under the OS temp dir.
 *
 * `mkdtempSync` rather than a hand-built `prefix-<timestamp>-<random>` name: it
 * creates the directory atomically, with a name the caller cannot predict and mode
 * 0700, which is what the `js/insecure-temporary-file` rule asks for. Callers write
 * shims, profiles and artifacts into the returned path.
 * @param {string} prefix
 */
export function makeTempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`))
}

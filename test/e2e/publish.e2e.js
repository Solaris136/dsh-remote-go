// Publish-path acceptance: prove the exact artifact we would publish actually
// installs and runs inside a clean DSH profile.
//
//   1. `pnpm pack` the plugin (prepack gate runs `market-entry --check`);
//   2. install the tarball into a fresh profile (`dsh plugin add <tgz>`);
//   3. boot that profile and verify the Host API + the client-module row, with
//      both paths resolving inside the installed profile (not the checkout);
//   4. stop the instance and record a JSON report.
//
// Run: node --test "test/e2e/*.e2e.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..')
const CONTROL_DIR = path.join(ROOT, 'e2e', 'control')
const RUNTIME_DIR = path.join(CONTROL_DIR, 'node_modules', '@deepseek-ai', 'dsh')
const DSH_BIN = path.join(RUNTIME_DIR, 'lib', 'bin.js')
const ARTIFACTS = path.join(ROOT, 'e2e', 'artifacts')
const PUBLISHED_HOME = path.join(CONTROL_DIR, 'home-published')
const PNPM_SHIM_DIR = path.join(CONTROL_DIR, 'bin')
const NODE_BIN_DIR = path.dirname(process.execPath)
const API_HEADER = 'x-dsh-remote-go'

/**
 * Resolve how to invoke pnpm without depending on a developer-specific path:
 * an explicit override (DSH_PNPM_CJS / DSH_PNPM / PNPM_EXE, either a JS entry or
 * an executable), otherwise `pnpm` from PATH.
 *
 * On Windows a `.cmd` shim is *not* spawned: routing through `cmd.exe` flashes a
 * console window (see CONTRIBUTING "Windows 平台约定"). Instead the shim is read
 * to find the JavaScript entry it wraps and that entry runs through
 * `process.execPath`, which is both silent and quote-safe.
 * @returns {{ command: string, prefixArgs: string[] }}
 */
function resolvePnpmInvocation() {
  const cjs = process.env.DSH_PNPM_CJS
  if (cjs && existsSync(cjs)) return { command: process.execPath, prefixArgs: [cjs] }
  const explicit = process.env.DSH_PNPM ?? process.env.PNPM_EXE
  if (explicit && existsSync(explicit)) {
    if (/\.(?:c?js|mjs)$/.test(explicit)) return { command: process.execPath, prefixArgs: [explicit] }
    if (!/\.cmd$/i.test(explicit)) return { command: explicit, prefixArgs: [] }
    const fromExplicitShim = pnpmJsFromShim(explicit)
    if (fromExplicitShim) return { command: process.execPath, prefixArgs: [fromExplicitShim] }
  }
  if (process.platform !== 'win32') return { command: 'pnpm', prefixArgs: [] }
  const shim = whichPnpmShim()
  if (shim) {
    const js = pnpmJsFromShim(shim)
    if (js) return { command: process.execPath, prefixArgs: [js] }
  }
  const guessed = ['pnpm/bin/pnpm.cjs', 'pnpm/bin/pnpm.js']
    .map((suffix) => path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', ...suffix.split('/')))
    .find((candidate) => existsSync(candidate))
  if (guessed) return { command: process.execPath, prefixArgs: [guessed] }
  throw new Error(
    'cannot locate a pnpm JavaScript entry on Windows; set DSH_PNPM_CJS to pnpm.cjs ' +
      '(a .cmd shim is not spawned on purpose: it flashes a console window)',
  )
}

/**
 * Read the JavaScript entry point out of a `pnpm.cmd` shim.
 * npm/pnpm shims wrap a real file (`"%~dp0\node_modules\pnpm\bin\pnpm.cjs"`), which
 * is what we want to run through `process.execPath`.
 * @param {string} shimPath
 * @returns {string | null}
 */
function pnpmJsFromShim(shimPath) {
  let text
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const dir = path.dirname(shimPath)
  for (const line of text.split(/\r?\n/)) {
    const match = /"([^"]*pnpm[^"]*\.(?:cjs|js))"/i.exec(line) ?? /(\S*pnpm\S*\.(?:cjs|js))/i.exec(line)
    if (!match) continue
    const raw = match[1].replace(/%~dp0/gi, '').replace(/^[\\/]+/, '')
    const resolved = path.resolve(dir, raw)
    if (existsSync(resolved)) return resolved
  }
  return null
}

/**
 * The first `pnpm` shim on PATH (Windows), found without a console window.
 * @returns {string | null}
 */
function whichPnpmShim() {
  const probe = spawnSync('where', ['pnpm'], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0) return null
  const first = (probe.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && existsSync(line))
  return first ?? null
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, cwd?: string, timeoutMs?: number }} [options]
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout]`, timedOut: true })
    }, options.timeoutMs ?? 240_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut: false })
    })
  })
}

/** @param {string} file */
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function startDsh(env) {
  const proc = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--no-open', '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  proc.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const match = /dsh web:\s*(http:\/\/[^\s]+)/.exec(stdout)
    if (match) {
      const parsed = new URL(match[1])
      return { proc, url: match[1], origin: `http://127.0.0.1:${parsed.port}`, stdout: () => stdout }
    }
    if (proc.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  proc.kill()
  throw new Error(`DSH did not print its URL. Output:\n${stdout.slice(-4000)}`)
}

async function stopDsh(proc) {
  if (!proc || proc.exitCode !== null) return
  proc.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

test('published artifact installs and runs in a clean DSH profile', { timeout: 360_000 }, async (t) => {
  await mkdir(ARTIFACTS, { recursive: true })
  /** @type {Record<string, unknown>} */
  const report = { startedAt: new Date().toISOString(), steps: [] }
  let proc = null
  try {
    assert.ok(
      existsSync(DSH_BIN),
      `control DSH runtime missing at ${DSH_BIN}; install @deepseek-ai/dsh@0.2.2-rc.1 into e2e/control first`,
    )

    // 1) pack
    const pnpm = resolvePnpmInvocation()
    const pack = await run(pnpm.command, [...pnpm.prefixArgs, 'pack', '--pack-destination', ARTIFACTS], {
      env: { PATH: `${NODE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}` },
      timeoutMs: 180_000,
    })
    assert.equal(pack.code, 0, `pnpm pack failed:\n${pack.stdout}\n${pack.stderr}`)
    const packed = pack.stdout.match(/([A-Za-z0-9._-]+\.tgz)\s*$/m)?.[1] ?? 'dsh-remote-go-0.1.0.tgz'
    const tarball = path.join(ARTIFACTS, packed)
    assert.ok(existsSync(tarball), `tarball not found: ${tarball}`)
    const pkg = await readJson(path.join(ROOT, 'package.json'))
    report.pack = { tarball, name: pkg.name, version: pkg.version }
    report.steps.push({ step: 'pack', ok: true, tarball: path.basename(tarball) })

    // 2) install into a clean profile
    await rm(PUBLISHED_HOME, { recursive: true, force: true })
    await mkdir(PUBLISHED_HOME, { recursive: true })
    const pathParts = [NODE_BIN_DIR, ...(existsSync(PNPM_SHIM_DIR) ? [PNPM_SHIM_DIR] : []), process.env.PATH ?? '']
    const install = await run(process.execPath, [DSH_BIN, 'plugin', '--profile', 'web', 'add', tarball], {
      env: {
        DSH_HOME: PUBLISHED_HOME,
        PATH: pathParts.join(path.delimiter),
      },
      timeoutMs: 240_000,
    })
    assert.equal(install.code, 0, `installing the tarball failed:\n${install.stdout}\n${install.stderr}`)
    const profileManifest = await readJson(path.join(PUBLISHED_HOME, 'profiles', 'web', 'package.json'))
    assert.ok(
      profileManifest.dsh.profile.bundles.includes('dsh-remote-go'),
      'installed bundle must be selected in the profile',
    )
    assert.match(JSON.stringify(profileManifest.dependencies ?? {}), /dsh-remote-go/)
    report.steps.push({ step: 'install-tarball', ok: true, bundles: profileManifest.dsh.profile.bundles })

    // 3) boot the clean profile and verify activation
    const control = await startDsh({ DSH_HOME: PUBLISHED_HOME })
    proc = control.proc
    try {
      const health = await fetch(`${control.origin}/dsh-remote-go/api/health`)
      assert.equal(health.status, 200)
      const healthJson = await health.json()
      assert.equal(healthJson.ok, true)

      const diagnostics = await fetch(`${control.origin}/dsh-remote-go/api/diagnostics/self`, {
        headers: { [API_HEADER]: '1' },
      })
      assert.equal(diagnostics.status, 200)
      const self = await diagnostics.json()
      assert.equal(self.plugin.id, 'dsh-remote-go')
      assert.equal(self.entry.id, 'dsh-remote-go')
      assert.equal(self.client.row.id, 'dsh-remote-go')
      const profileDir = path.join(PUBLISHED_HOME, 'profiles', 'web', 'node_modules')
      assert.ok(
        self.client.clientPath.startsWith(profileDir),
        `client bundle must resolve inside the installed profile, got ${self.client.clientPath}`,
      )
      assert.ok(self.client.bundle.size > 1000)
      assert.notEqual(
        self.client.clientPath,
        path.join(ROOT, 'client.js'),
        'installed copy must not point at the development checkout',
      )
      report.steps.push({
        step: 'clean-profile-activation',
        ok: true,
        hostEntry: self.entry.id,
        clientPath: self.client.clientPath,
        clientBundleSize: self.client.bundle.size,
        hostVersion: self.hostVersion,
      })
      t.diagnostic(`installed artifact active: ${self.client.clientPath}`)
    } finally {
      await stopDsh(proc)
      proc = null
    }

    // 4) cleanup the throwaway profile (the report keeps the evidence)
    await rm(PUBLISHED_HOME, { recursive: true, force: true })
    report.steps.push({ step: 'cleanup', ok: true })
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await stopDsh(proc)
    await writeFile(
      path.join(ARTIFACTS, 'publish-e2e-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    ).catch(() => {})
  }
})

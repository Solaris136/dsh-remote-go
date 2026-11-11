// Generate and validate the format-1 plugin market entry for dsh-remote-go.
//
// Outputs:
//   market/plugin-entry.json  — one plugin object for a curated registry PR
//   market/index.json         — a complete standalone format-1 index
//
// Usage:
//   node scripts/market-entry.mjs           # write both files
//   node scripts/market-entry.mjs --check   # validate only (CI / prepack gate)
//
// Validation uses @deepseek-ai/dsh-plugin-market-index (devDependency), the same
// validator DSH and the market use, so a broken entry fails here first.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const checkOnly = process.argv.includes('--check')
const INDEX_URL = process.env.DSH_REMOTE_GO_INDEX_URL || 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'

const REQUIRED_FILES = ['index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']
const REQUIRED_ENTRY_POINTS = [
  ['index.js', 'host entry'],
  ['client.js', 'browser entry'],
]
const RUNTIME_SRC = [
  'src/index.js',
  'src/api.js',
  'src/service.js',
  'src/ssh.js',
  'src/ssh-config.js',
  'src/known-hosts.js',
  'src/bootstrap.js',
  'src/webapp.js',
  'src/probe.js',
  'src/tunnel.js',
  'src/store.js',
  'src/settings.js',
  'src/errors.js',
  'src/version.js',
  'src/util.js',
  'src/redact.js',
  'src/atomic-json.js',
  'src/layout.js',
  'src/constants.js',
  'src/local-version.js',
  'src/local-ssh.js',
  'src/mirror.js',
  'src/mirror-store.js',
  'src/session-adapter.js',
  'src/workspace-adapter.js',
]

function fail(message) {
  console.error(`[market-entry] ${message}`)
  process.exit(1)
}

/**
 * Serialize a market document as Prettier-formatted JSON, so the committed
 * output also satisfies `pnpm run format:check`. Falls back to plain JSON when
 * Prettier is unavailable (it is a devDependency).
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function toJsonText(value) {
  const plain = `${JSON.stringify(value, null, 2)}\n`
  try {
    const prettier = await import('prettier')
    const options = (await prettier.resolveConfig(path.join(root, 'market'))) ?? {}
    return await prettier.format(JSON.stringify(value), { ...options, parser: 'json' })
  } catch {
    return plain
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), 'utf8'))
}

function commitTimestamp() {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: root,
      encoding: 'utf8',
      // windowsHide keeps a console from flashing for every child the gates start.
      windowsHide: true,
    }).trim()
    const value = Number(out)
    if (Number.isInteger(value) && value > 0) return value
  } catch {
    // Not a git checkout (packed package): fall back to a stable epoch.
  }
  return 1_767_225_600 // 2026-01-01T00:00:00Z
}

async function main() {
  const pkg = await readJson('package.json')
  const problems = []
  if (!pkg.name) problems.push('package.json name is required')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ''))
    problems.push('package.json version must be exact SemVer')
  if (pkg.private === true) problems.push('package.json must not be private (npm publish would be refused)')
  if (!pkg.dsh?.bundle?.patch) problems.push('package.json dsh.bundle.patch is required for a bundle')
  if (!pkg.dsh?.client?.platform) problems.push('package.json dsh.client.platform is required for the browser half')
  if (!pkg.engines?.dsh) problems.push('package.json engines.dsh is required (compatibility is checked against it)')
  if (!pkg.license) problems.push('package.json license is required')
  for (const file of [...REQUIRED_FILES, ...RUNTIME_SRC]) {
    if (!existsSync(path.join(root, file))) problems.push(`missing runtime file: ${file}`)
  }
  for (const [file, label] of REQUIRED_ENTRY_POINTS) {
    if (!existsSync(path.join(root, file))) problems.push(`missing ${label}: ${file}`)
  }
  const files = pkg.files ?? []
  for (const needed of ['index.js', 'client.js', 'src', 'locale', 'cordis.patch.yml']) {
    if (!files.some((entry) => entry === needed || entry.startsWith(`${needed}/`)))
      problems.push(`package.json files[] must include ${needed}`)
  }
  if (problems.length > 0) fail(problems.join('\n  - '))

  const entry = {
    name: pkg.name,
    title: {
      zh: 'dsh remote go',
      en: 'dsh remote go',
    },
    description: {
      zh: '通过 SSH 在本地 DSH 的全局面板里整页使用远端 DSH：主机清单、接入向导、连接诊断、远端运行时自举与版本一致。',
      en: 'Open a remote DSH inside a local full-page panel over SSH, with host list, connection wizard, diagnostics, remote runtime bootstrap and exact version parity.',
    },
    author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? 'Solaris136'),
    homepage: pkg.homepage,
    repository: { url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') },
    metadata: {
      keywords: pkg.keywords ?? [],
    },
    versions: [
      {
        version: pkg.version,
        publishTimestamp: commitTimestamp(),
        source: { type: 'npm' },
        engines: { dsh: pkg.engines.dsh },
      },
    ],
  }

  const index = {
    format: 1,
    title: {
      zh: 'dsh remote go',
      en: 'dsh remote go',
    },
    description: {
      zh: 'dsh remote go 的插件市场索引（单插件，可直接作为 Index source 添加）。',
      en: 'Plugin market index for dsh-remote-go (single plugin; add directly as an Index source).',
    },
    metadata: {},
    plugins: [entry],
  }

  if (checkOnly) {
    // Validate structure locally first, then with the official validator.
    const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
    try {
      parseMarketIndex(index, INDEX_URL)
    } catch (error) {
      fail(`official market-index validator rejected the entry: ${error.message}`)
    }
    console.log(
      `[market-entry] OK: ${pkg.name}@${pkg.version} (${REQUIRED_FILES.length + RUNTIME_SRC.length} runtime files checked, format-1 index validated)`,
    )
    return
  }

  const outDir = path.join(root, 'market')
  await mkdir(outDir, { recursive: true })
  const pluginEntryText = await toJsonText(entry)
  const indexText = await toJsonText(index)
  await writeFile(path.join(outDir, 'plugin-entry.json'), pluginEntryText, 'utf8')
  await writeFile(path.join(outDir, 'index.json'), indexText, 'utf8')
  console.log(`[market-entry] wrote market/plugin-entry.json and market/index.json for ${pkg.name}@${pkg.version}`)
  console.log('[market-entry] validate with: node scripts/market-entry.mjs --check')
}

main().catch((error) => fail(error.stack ?? String(error)))

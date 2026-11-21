// Resolve the desktop app the acceptance leg installs. The app is one shell around the harness the plugin runs in, so
// an app older than `package.json#engines.dsh` cannot load this plugin -- and a cached installer hid exactly that for a
// week (the runner kept 0.2.2-rc.1 while the floor moved to 0.2.2-rc.3). CI keys the installer cache by the version
// printed here and fails on a feed behind the floor instead of testing an unsupported app.
// Prints the GitHub Actions step outputs `version=` and `url=` on stdout.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { compareVersions } from '../src/version.ts'

const FEED = process.env.DSH_DESKTOP_FEED ?? 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const floor =
  typeof pkg?.engines?.dsh === 'string' ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(pkg.engines.dsh)?.[0] : null
if (!floor) {
  console.error('[desktop-installer] package.json engines.dsh does not declare an exact version floor')
  process.exit(1)
}
let feed = null
try {
  const response = await fetch(FEED, { redirect: 'follow' })
  if (!response.ok) throw new Error(`the feed answered HTTP ${response.status}`)
  feed = load(await response.text())
} catch (error) {
  console.error(`[desktop-installer] cannot read ${FEED}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const version = typeof feed?.version === 'string' ? feed.version.trim() : ''
const url = typeof feed?.path === 'string' ? feed.path.trim() : ''
if (version === '' || url === '') {
  console.error('[desktop-installer] the feed carries no version/path pair')
  process.exit(1)
}
if (compareVersions(version, floor) < 0) {
  console.error(
    `[desktop-installer] the desktop feed is at ${version}, older than the engines.dsh floor ${floor}: ` +
      'the acceptance leg must not test an app the plugin does not support',
  )
  process.exit(1)
}
console.log(`version=${version}`)
console.log(`url=${url}`)

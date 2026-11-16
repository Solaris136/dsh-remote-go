// Print the DSH version floor this plugin declares in package.json#engines.dsh.
// The CI and acceptance workflows install exactly this harness version, so the real
// acceptance environment can never be older than the compatibility floor the plugin
// advertises (previously acceptance pinned 0.2.2-rc.1 while engines.dsh required
// >=0.2.2-rc.3).
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const range = pkg?.engines?.dsh
const floor = typeof range === 'string' ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)?.[0] : null

if (!floor) {
  console.error('[harness-version] package.json engines.dsh does not declare an exact version floor')
  process.exit(1)
}
console.log(floor)

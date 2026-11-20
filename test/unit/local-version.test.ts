import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { candidatePackageJsons, detectLocalEnginesNode, detectLocalVersion } from '../../dist/src/local-version.js'
/** A temp installation whose `@deepseek-ai/dsh` package.json holds `json`. */
async function dshInstall(json) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-package-'))
  const packageDir = path.join(home, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(packageDir, { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify(json), 'utf8')
  return { argv1: path.join(packageDir, 'lib', 'bin.js'), resourcesPath: '/nonexistent' }
}

test('candidatePackageJsons derives paths from argv and resourcesPath', () => {
  const argv1 = path.join('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const candidates = candidatePackageJsons({ argv1, resourcesPath: '/Applications/DSH.app/Contents/Resources' })
  assert.ok(candidates.includes(path.join('/opt/dsh/node_modules/@deepseek-ai/dsh', 'package.json')))
  assert.ok(candidates.some((candidate) => candidate.includes('app.asar')))
})

test('detectLocalVersion prefers DSH_VERSION, then client-modules, then package.json', async () => {
  const fromEnv = await detectLocalVersion({ env: { DSH_VERSION: 'v0.2.2-rc.1' } })
  assert.deepEqual([fromEnv.version, fromEnv.source], ['0.2.2-rc.1', 'env'])
  const ctx = {
    get: (key) =>
      key === 'clientModules' ? { graph: () => ({ release: { version: '0.2.2-rc.1', commit: 'abc' } }) } : undefined,
  }
  const fromModules = await detectLocalVersion({ ctx, env: {} })
  assert.deepEqual([fromModules.version, fromModules.source], ['0.2.2-rc.1', 'client-modules'])
  const install = await dshInstall({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' })
  const fromPackage = await detectLocalVersion({ env: {}, ...install })
  assert.equal(fromPackage.version, '0.2.2-rc.1')
  assert.match(fromPackage.source, /package\.json/)
})

test('detectLocalEnginesNode reads engines.node from the same package.json', async () => {
  const install = await dshInstall({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', engines: { node: '>=24.9.0' } })
  const detected = await detectLocalEnginesNode(install)
  assert.equal(detected.range, '>=24.9.0')
  // The result is source-annotated with the file it came from.
  assert.match(detected.source, /package\.json/)
})

test('both probes report unknown when no package is readable', async () => {
  const engines = await detectLocalEnginesNode({ argv1: '/nonexistent/bin.js', resourcesPath: '/nonexistent' })
  assert.deepEqual([engines.range, engines.source], [null, 'unknown'])
  const ctx = {
    get: () => {
      throw new Error('no service')
    },
  }
  const version = await detectLocalVersion({
    ctx,
    env: {},
    argv1: '/nonexistent/bin.js',
    resourcesPath: '/nonexistent',
  })
  assert.deepEqual([version.version, version.source], [null, 'unknown'])
})

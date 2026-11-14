import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { candidatePackageJsons, detectLocalEnginesNode, detectLocalVersion } from '../../src/local-version.js'

test('candidatePackageJsons derives paths from argv and resourcesPath', () => {
  const argv1 = path.join('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const candidates = candidatePackageJsons({
    argv1,
    resourcesPath: '/Applications/DSH.app/Contents/Resources',
  })
  assert.ok(candidates.includes(path.join('/opt/dsh/node_modules/@deepseek-ai/dsh', 'package.json')))
  assert.ok(candidates.some((candidate) => candidate.includes('app.asar')))
})

test('detectLocalVersion prefers DSH_VERSION from the environment', async () => {
  const detected = await detectLocalVersion({ env: { DSH_VERSION: 'v0.2.2-rc.1' } })
  assert.equal(detected.version, '0.2.2-rc.1')
  assert.equal(detected.source, 'env')
})

test('detectLocalVersion reads the client-modules release identity', async () => {
  const ctx = {
    get: (key) =>
      key === 'clientModules' ? { graph: () => ({ release: { version: '0.2.2-rc.1', commit: 'abc' } }) } : undefined,
  }
  const detected = await detectLocalVersion({ ctx, env: {} })
  assert.equal(detected.version, '0.2.2-rc.1')
  assert.equal(detected.source, 'client-modules')
})

test('detectLocalVersion falls back to a readable dsh package.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-version-'))
  const packageDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }),
    'utf8',
  )
  const detected = await detectLocalVersion({
    env: {},
    argv1: path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    resourcesPath: '/nonexistent',
  })
  assert.equal(detected.version, '0.2.2-rc.1')
  assert.match(detected.source, /package\.json/)
})

test('detectLocalEnginesNode reads engines.node from the same package.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-remote-go-engine-'))
  const packageDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', engines: { node: '>=24.9.0' } }),
    'utf8',
  )
  const detected = await detectLocalEnginesNode({
    argv1: path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    resourcesPath: '/nonexistent',
  })
  assert.equal(detected.range, '>=24.9.0')
  assert.match(detected.source, /package\.json/)
})

test('detectLocalEnginesNode reports unknown when no package declares one', async () => {
  const detected = await detectLocalEnginesNode({ argv1: '/nonexistent/bin.js', resourcesPath: '/nonexistent' })
  assert.equal(detected.range, null)
  assert.equal(detected.source, 'unknown')
})

test('detectLocalVersion reports unknown when nothing is readable', async () => {
  let throwing = true
  const ctx = {
    get: () => {
      if (throwing) throw new Error('no service')
      return undefined
    },
  }
  const detected = await detectLocalVersion({
    ctx,
    env: {},
    argv1: '/nonexistent/bin.js',
    resourcesPath: '/nonexistent',
  })
  assert.equal(detected.version, null)
  assert.equal(detected.source, 'unknown')
})

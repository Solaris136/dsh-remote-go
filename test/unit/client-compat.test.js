import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../../client.js', import.meta.url)

/** @returns {Promise<string>} the client half source */
async function clientSource() {
  return readFile(CLIENT, 'utf8')
}

test('the client half only requires react', async () => {
  const source = await clientSource()
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.deepEqual(
    [...new Set(required)].sort(),
    ['react'],
    'a dynamic client half may only require react; anything else breaks the web build',
  )
})

test('the client half uses no desktop-only (Electron) capability', async () => {
  const source = await clientSource()
  // The same bundle must run in the browser (dsh web) and inside the desktop shell, so any
  // Electron-only surface here would silently break one of them.
  const forbidden = [
    /\brequire\(\s*['"]electron['"]\s*\)/,
    /\bwindow\.dsh\b/,
    /\bglobalThis\.dsh\b/,
    /\bprocess\.(\s*)binding\b/,
    /\bipcRenderer\b/,
    /\bshell\.openExternal\b/,
    /\bnodeIntegration\b/,
  ]
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `the client half must not use ${pattern}`)
  }
})

test('clipboard access is feature detected', async () => {
  const source = await clientSource()
  const uses = source.match(/navigator\.clipboard\s*\.\s*writeText/g) ?? []
  assert.ok(uses.length > 0, 'expected a clipboard write path')
  // Every write must sit behind a capability check, because the web shell may be served over
  // plain http, where navigator.clipboard is unavailable.
  assert.match(
    source,
    /navigator\.clipboard\s*&&\s*typeof navigator\.clipboard\.writeText === 'function'/,
    'clipboard writes must be guarded by a capability check',
  )
})

test('the client never opens an external window', async () => {
  const source = await clientSource()
  // The embedded-panel presentation is gone: a remote UI only ever reaches the
  // desktop browser guest, so no `window.open` escape hatch may remain.
  assert.doesNotMatch(source, /window\.open\s*\(/, 'the client must not open an external window')
  assert.doesNotMatch(source, /_blank['"]\s*,\s*'noopener/, 'no new-window target may remain')
})

test('the client half ships no host-only import', async () => {
  const source = await clientSource()
  const hostOnly = [...source.matchAll(/from\s+['"]\.\/src\/[^'"]+['"]/g)]
  assert.equal(hostOnly.length, 0, 'the client bundle must not import the host half at runtime')
})

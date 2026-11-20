import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
// The Host entry is the one module without another importer, which keeps it visible to `scripts/check-coverage.mjs`;
// DSH's bundle loader reads name/inject/optional/apply, so a module body that throws must fail here instead of at
// plugin load in the Host process.
describe('plugin entry', () => {
  test('the Host entry imports cleanly and exports the bundle contract', async () => {
    const entry = await import('../../dist/src/index.js')
    assert.equal(entry.name, 'dsh-remote-go')
    assert.deepEqual([...entry.inject], ['webServer'])
    assert.deepEqual([...entry.optional], ['connection', 'credentials'])
    assert.equal(typeof entry.apply, 'function')
  })
})

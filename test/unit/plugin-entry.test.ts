import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The Host entry (`src/index.ts` → `dist/src/index.js`) is the one module without a test that
 * imports it, which made it invisible to `scripts/check-coverage.mjs`'s "every TypeScript source
 * under `src/` must appear in the coverage report" guard. Loading it is also a contract: DSH's
 * bundle loader imports this file and reads `name`/`inject`/`optional`/`apply`, so a module body
 * that throws must fail here instead of at plugin load in the Host process.
 */
describe('plugin entry', () => {
  test('the Host entry imports cleanly and exports the bundle contract', async () => {
    const entry = await import('../../dist/src/index.js')
    assert.equal(entry.name, 'dsh-remote-go')
    assert.deepEqual([...entry.inject], ['webServer'])
    assert.deepEqual([...entry.optional], ['connection', 'credentials'])
    assert.equal(typeof entry.apply, 'function')
  })
})

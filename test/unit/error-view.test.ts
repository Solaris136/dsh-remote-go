import test from 'node:test'
import assert from 'node:assert/strict'
import { errors, TECHNICAL_LIMIT, toErrorView } from '../../dist/src/errors.js'
/** The captured remote output a failed remote start carries (first line = launch URL + token). */
const TAIL = [
  'dsh web: http://127.0.0.1:38123/?token=SUPERSECRET-TOKEN',
  'Authorization: Bearer local-session-value-9911',
  '/home/alice/.dsh/remote-go/run/web.log',
  '#token=abc123def456',
  'ssh -p 2222 ubuntu@host',
].join('\n')

test('toErrorView redacts, sanitizes and length-caps every detail it renders', () => {
  const view = toErrorView(errors.remoteDshStartFailed(TAIL))
  assert.equal(view.code, 'remote-dsh-start-failed')
  const text = JSON.stringify(view)
  for (const secret of ['SUPERSECRET-TOKEN', 'local-session-value-9911', 'alice', 'abc123def456']) {
    assert.equal(text.includes(secret), false, `${secret} reached the ErrorView`)
  }
  assert.match(view.technical, /token=<redacted>/)
  assert.match(view.technical, /<user>/)
  // A real port is still readable: redaction must not destroy the debugging value.
  assert.match(view.technical, /ssh -p 2222/)
  const long = toErrorView(errors.internal('x'.repeat(50_000)))
  assert.ok(long.technical.length <= TECHNICAL_LIMIT + 8, `technical was ${long.technical.length} bytes`)
  // Detail text and an unknown thrown error are sanitized by the same path.
  const invalid = toErrorView(
    errors.invalidInput('field', { zh: 'token=abc123def 无效', en: 'token=abc123def is invalid' }),
  )
  assert.equal(JSON.stringify(invalid).includes('abc123def'), false)
  const unknown = toErrorView(new Error('boom at C:\\Users\\alice\\secret.txt'))
  assert.equal(unknown.code, 'internal')
  assert.equal(JSON.stringify(unknown).includes('alice'), false)
})

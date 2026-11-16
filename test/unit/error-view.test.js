import test from 'node:test'
import assert from 'node:assert/strict'
import { errors, TECHNICAL_LIMIT, toErrorView } from '../../src/errors.js'

/** The captured remote output a failed remote start carries (first line = launch URL + token). */
const TAIL = [
  'dsh web: http://127.0.0.1:38123/?token=SUPERSECRET-TOKEN',
  'Authorization: Bearer local-session-value-9911',
  '/home/alice/.dsh/remote-go/run/web.log',
  '#token=abc123def456',
  'ssh -p 2222 ubuntu@host',
].join('\n')

test('toErrorView redacts and length-caps the technical detail', () => {
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
})

test('toErrorView never carries an unbounded technical string', () => {
  const view = toErrorView(errors.internal('x'.repeat(50_000)))
  assert.ok(view.technical.length <= TECHNICAL_LIMIT + 8, `technical was ${view.technical.length} bytes`)
})

test('toErrorView sanitizes detail and next-step text as well', () => {
  const view = toErrorView(
    errors.invalidInput('field', { zh: 'token=abc123def 无效', en: 'token=abc123def is invalid' }),
  )
  assert.equal(JSON.stringify(view).includes('abc123def'), false)
})

test('an unknown thrown value becomes an internal error without the raw message', () => {
  const view = toErrorView(new Error('boom at C:\\Users\\alice\\secret.txt'))
  assert.equal(view.code, 'internal')
  assert.equal(JSON.stringify(view).includes('alice'), false)
})

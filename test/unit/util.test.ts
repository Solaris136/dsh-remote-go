import test from 'node:test'
import assert from 'node:assert/strict'
import { clamp, deepMerge, expandHome, headTail } from '../../dist/src/util.js'
import { isLoopbackHost, parseSshDestination, shellQuote } from '../../dist/src/util.js'

test('parseSshDestination handles user, host and port shapes', () => {
  const cases = [
    ['ubuntu@192.0.2.10', { user: 'ubuntu', host: '192.0.2.10', port: null }],
    ['ubuntu@example.com:2222', { user: 'ubuntu', host: 'example.com', port: 2222 }],
    ['test-host', { user: null, host: 'test-host', port: null }],
    ['[2001:db8::1]:22', { user: null, host: '2001:db8::1', port: 22 }],
    ['user@[::1]', { user: 'user', host: '::1', port: null }],
    ['', { user: null, host: '', port: null }],
  ]
  for (const [input, expected] of cases) assert.deepEqual(parseSshDestination(input), expected, input)
})

test('isLoopbackHost only accepts loopback literals', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])
    assert.equal(isLoopbackHost(host), true, host)
  for (const host of ['192.168.1.4', '100.64.0.1', 'example.com', '0.0.0.0', ''])
    assert.equal(isLoopbackHost(host), false, host)
})

test('small helpers stay quoted, expanded and bounded', () => {
  assert.equal(shellQuote('plain'), "'plain'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(expandHome('~/.ssh/id_rsa', '/home/u'), '/home/u/.ssh/id_rsa')
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  assert.equal(expandHome('/abs/~x', '/home/u'), '/abs/~x')
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-1, 1, 3), 1)
  const shortened = headTail('x'.repeat(1000), 100)
  assert.ok(shortened.length <= 110)
  assert.ok(shortened.includes('…'))
})

test('deepMerge replaces scalars, merges objects and drops undeclared properties', () => {
  const base = { a: 1, nested: { b: 2, c: 3 }, list: [1] }
  assert.deepEqual(deepMerge(base, { nested: { c: 9 }, list: [2, 3] }), { a: 1, nested: { b: 2, c: 9 }, list: [2, 3] })
  assert.deepEqual(base, { a: 1, nested: { b: 2, c: 3 }, list: [1] }, 'the input object is not mutated')
  const merged = deepMerge({ known: 1, nested: { a: 1 } }, { known: 2, invented: { deep: 'value' }, nested: { b: 2 } })
  assert.deepEqual(merged, { known: 2, nested: { a: 1 } })
  assert.equal(Object.hasOwn(merged, 'invented'), false)
  assert.equal(Object.hasOwn(merged.nested, 'b'), false)
})

test('deepMerge cannot inject undeclared properties', () => {
  const patch = JSON.parse(
    '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"saveTokens":true}',
  )
  const merged = deepMerge({ saveTokens: false, autoReconnect: { enabled: true } }, patch)
  assert.equal(merged.saveTokens, true, 'declared keys still merge')
  assert.equal(Object.hasOwn(merged, '__proto__'), false)
  assert.equal(Object.hasOwn(merged, 'constructor'), false)
  assert.equal(merged.polluted, undefined)
  assert.equal({}.polluted, undefined, 'Object.prototype must stay clean')
  assert.equal(Object.getPrototypeOf(merged), Object.prototype)
})

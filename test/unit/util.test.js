import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clamp,
  createDeferred,
  deepMerge,
  expandHome,
  headTail,
  isLoopbackHost,
  maskSshAddress,
  parseSshDestination,
  shellQuote,
  splitShellWords,
} from '../../src/util.js'

test('parseSshDestination handles user, host and port shapes', () => {
  assert.deepEqual(parseSshDestination('ubuntu@192.0.2.10'), { user: 'ubuntu', host: '192.0.2.10', port: null })
  assert.deepEqual(parseSshDestination('ubuntu@example.com:2222'), { user: 'ubuntu', host: 'example.com', port: 2222 })
  assert.deepEqual(parseSshDestination('test-host'), { user: null, host: 'test-host', port: null })
  assert.deepEqual(parseSshDestination('[2001:db8::1]:22'), {
    user: null,
    host: '2001:db8::1',
    port: 22,
  })
  assert.deepEqual(parseSshDestination('user@[::1]'), { user: 'user', host: '::1', port: null })
  assert.deepEqual(parseSshDestination(''), { user: null, host: '', port: null })
})

test('isLoopbackHost only accepts loopback literals', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['192.168.1.4', '100.64.0.1', 'example.com', '0.0.0.0', '']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})

test('maskSshAddress keeps shape without secrets', () => {
  assert.equal(maskSshAddress({ user: 'ubuntu', host: '192.0.2.10', port: 22 }), 'ubuntu@192.0.2.10')
  assert.equal(maskSshAddress({ user: 'ubuntu', host: '192.0.2.10', port: 2222 }), 'ubuntu@192.0.2.10:2222')
  assert.equal(
    maskSshAddress({ alias: 'test-host', user: 'ubuntu', host: '240d::1', port: 22 }),
    'test-host (ubuntu@240d::1)',
  )
})

test('shellQuote quotes single quotes correctly', () => {
  assert.equal(shellQuote('plain'), "'plain'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
})

test('splitShellWords handles quotes and escapes', () => {
  assert.deepEqual(splitShellWords('a b "c d" e\\ f'), ['a', 'b', 'c d', 'e f'])
  assert.deepEqual(splitShellWords("x 'y z'"), ['x', 'y z'])
})

test('deepMerge replaces scalars and merges objects', () => {
  const base = { a: 1, nested: { b: 2, c: 3 }, list: [1] }
  const merged = deepMerge(base, { nested: { c: 9 }, list: [2, 3] })
  assert.deepEqual(merged, { a: 1, nested: { b: 2, c: 9 }, list: [2, 3] })
  assert.deepEqual(base, { a: 1, nested: { b: 2, c: 3 }, list: [1] })
})

test('expandHome expands only a leading tilde', () => {
  assert.equal(expandHome('~/.ssh/id_rsa', '/home/u'), '/home/u/.ssh/id_rsa')
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  assert.equal(expandHome('/abs/~x', '/home/u'), '/abs/~x')
})

test('clamp and headTail are bounded', () => {
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-1, 1, 3), 1)
  const shortened = headTail('x'.repeat(1000), 100)
  assert.ok(shortened.length <= 110)
  assert.ok(shortened.includes('…'))
})

test('createDeferred resolves and rejects', async () => {
  const deferred = createDeferred()
  deferred.resolve('ok')
  assert.equal(await deferred.promise, 'ok')
  const rejected = createDeferred()
  rejected.reject(new Error('nope'))
  await assert.rejects(rejected.promise, /nope/)
})

/**
 * The watchdog bus itself (design-arch §1.7): synchronous publish, registration order, a throwing
 * listener that cannot break the event that follows it, and an idempotent unsubscribe.
 *
 * The wiring (who subscribes, and what a confirmed/recovered episode does) is covered end-to-end by
 * `remote-restart.test.js`; this file only pins the channel's contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchdogBus } from '../../src/watchdog-bus.js'

test('the bus publishes synchronously, in subscription order', () => {
  const bus = createWatchdogBus()
  const seen = []
  bus.subscribe((event) => seen.push(`a:${event.kind}`))
  bus.subscribe((event) => seen.push(`b:${event.kind}`))
  bus.publish({ kind: 'confirmed', hostId: 'h1', reason: 'probe-failed-2', source: 'proxy' })
  assert.deepEqual(seen, ['a:confirmed', 'b:confirmed'])
})

test('a listener that throws is reported and does not stop the next one', () => {
  const warned = []
  const bus = createWatchdogBus({ warn: (...args) => warned.push(args) })
  const seen = []
  bus.subscribe(() => {
    throw new Error('boom')
  })
  bus.subscribe((event) => seen.push(event.hostId))
  bus.publish({ kind: 'recovered', hostId: 'h1', source: 'tunnel' })
  assert.deepEqual(seen, ['h1'])
  assert.equal(warned.length, 1)
  assert.match(String(warned[0][1]), /boom/)
})

test('unsubscribe is idempotent and takes effect for later events only', () => {
  const bus = createWatchdogBus()
  const seen = []
  const off = bus.subscribe((event) => seen.push(event.kind))
  bus.publish({ kind: 'recovered', hostId: 'h1', source: 'heartbeat' })
  off()
  off()
  bus.publish({ kind: 'recovered', hostId: 'h1', source: 'heartbeat' })
  assert.deepEqual(seen, ['recovered'])
})

test('a listener that unsubscribes itself while handling an event does not skip the next one', () => {
  const bus = createWatchdogBus()
  const seen = []
  const off = bus.subscribe((event) => {
    seen.push(`first:${event.kind}`)
    off()
  })
  bus.subscribe((event) => seen.push(`second:${event.kind}`))
  bus.publish({ kind: 'confirmed', hostId: 'h1', reason: 'probe-failed-2', source: 'heartbeat' })
  assert.deepEqual(seen, ['first:confirmed', 'second:confirmed'])
})

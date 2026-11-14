import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONNECT_LOG_STATUSES,
  LOG_RING_LIMIT,
  LOG_TAIL_LIMIT,
  appendConnectLog,
  connectLogTail,
  connectLogVisible,
} from '../../src/connect-log.js'

test('only the statuses that own a connect window publish the log', () => {
  for (const status of ['connecting', 'fingerprint-pending', 'error']) {
    assert.equal(connectLogVisible(status), true, status + ' must publish the log')
  }
  for (const status of [
    'unconfigured',
    'connected',
    'disconnected',
    'conflict-pending',
    'limited',
    '',
    null,
    undefined,
    'unknown-status',
  ]) {
    assert.equal(connectLogVisible(status), false, String(status) + ' must not publish the log')
  }
  assert.deepEqual([...CONNECT_LOG_STATUSES], ['connecting', 'fingerprint-pending', 'error'])
})

test('appending keeps the ring bounded and the sequence monotonic', () => {
  const runtime = { id: 'h_test' }
  let last = null
  for (let index = 0; index < LOG_RING_LIMIT + 25; index += 1) {
    last = appendConnectLog(runtime, { at: '2026-11-15T00:00:00.000Z', level: 'info', message: 'line ' + (index + 1) })
  }
  assert.equal(runtime.logs.length, LOG_RING_LIMIT, 'the ring must not grow past its limit')
  assert.equal(runtime.logs[0].seq, 26, 'the oldest lines are the ones that fall out')
  assert.equal(last.seq, LOG_RING_LIMIT + 25)
  assert.equal(last.message, 'line ' + (LOG_RING_LIMIT + 25))
  // `line` is the process-log/diagnostics form; `message` is what the window prints.
  assert.equal(last.line, '[dsh-remote-go:h_test] line ' + (LOG_RING_LIMIT + 25))
  // The runtime owns both fields, so a host created before this refactor still works.
  assert.equal(runtime.logSeq, last.seq)
})

test('appending to a runtime with no ring yet starts one', () => {
  const runtime = { id: 'h_fresh' }
  const entry = appendConnectLog(runtime, { at: '2026-11-15T00:00:00.000Z', level: 'warn', message: 'first' })
  assert.equal(entry.seq, 1)
  assert.deepEqual(
    runtime.logs.map((item) => item.message),
    ['first'],
  )
  assert.equal(connectLogTail(runtime).length, 1)
})
test('the tail is bounded, newest last, and carries the line as it was written', () => {
  const total = LOG_RING_LIMIT + 50
  const logs = Array.from({ length: total }, (_, index) => ({
    seq: index + 1,
    at: `2026-11-14T16:00:${String(index % 60).padStart(2, '0')}.000Z`,
    level: index % 3 === 0 ? 'debug' : 'info',
    message: `line ${index + 1} says token=abc and "quotes"`,
    line: `[dsh-remote-go:h] line ${index + 1}`,
  }))
  const tail = connectLogTail({ logs })
  assert.equal(tail.length, LOG_TAIL_LIMIT)
  assert.equal(tail[0].seq, total - LOG_TAIL_LIMIT + 1, 'the oldest lines are the ones that fall off')
  assert.equal(tail[tail.length - 1].seq, total)
  assert.equal(tail[tail.length - 1].message, `line ${total} says token=abc and "quotes"`)
  assert.equal(tail[tail.length - 1].level, 'debug')
  // The console prints `message`; the plugin-tagged `line` belongs to the process log and
  // the diagnostics bundle, so it must not be duplicated into the window's payload.
  assert.equal('line' in tail[tail.length - 1], false)
})

test('a runtime without a log yields an empty tail instead of throwing', () => {
  assert.deepEqual(connectLogTail({}), [])
  assert.deepEqual(connectLogTail({ logs: null }), [])
  assert.deepEqual(connectLogTail(null), [])
})

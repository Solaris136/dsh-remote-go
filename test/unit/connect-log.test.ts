import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONNECT_LOG_STATUSES,
  LOG_RING_LIMIT,
  LOG_TAIL_LIMIT,
  LOG_TAIL_LINES,
  LOG_TECHNICAL_LIMIT,
  appendConnectLog,
  beginConnectLog,
  connectFailureLines,
  connectLogTail,
  connectLogVisible,
  resetConnectLog,
} from '../../dist/src/connect-log.js'
const AT = '2026-11-16T00:00:00.000Z'
/** A runtime record with the connect-log state these cases inspect. */
const runtimeOf = (extra = {}) => ({ id: 'h_test', ...extra })
/** Append one line at the shared timestamp; `extra` carries a different level/phase/text/at. */
const add = (runtime, message, extra = {}) => appendConnectLog(runtime, { at: AT, level: 'info', message, ...extra })
/** The base ErrorView of a failed start, as the failure pipeline hands it to the log. */
const startFailedView = {
  code: 'remote-dsh-start-failed',
  title: { zh: '远端 DSH 启动失败', en: 'The remote DSH failed to start' },
  detail: { zh: '启动失败。', en: 'The start failed.' },
  nextSteps: [],
}
/** The same shape for an internal failure, which the client-only paths render. */
const internalView = {
  code: 'internal',
  title: { zh: '插件内部错误', en: 'Internal plugin error' },
  detail: { zh: '出错了。', en: 'Something broke.' },
  nextSteps: [],
}

test('only the statuses that own a connect window publish the log', () => {
  for (const status of ['connecting', 'fingerprint-pending', 'error']) {
    assert.equal(connectLogVisible(status), true, status + ' must publish the log')
  }
  const hidden = [
    'unconfigured',
    'connected',
    'disconnected',
    'conflict-pending',
    'limited',
    '',
    null,
    undefined,
    'unknown-status',
  ]
  for (const status of hidden)
    assert.equal(connectLogVisible(status), false, String(status) + ' must not publish the log')
  assert.deepEqual([...CONNECT_LOG_STATUSES], ['connecting', 'fingerprint-pending', 'error'])
})

test('appending keeps the ring bounded and the sequence monotonic', () => {
  const runtime = runtimeOf()
  let last = null
  for (let index = 1; index <= LOG_RING_LIMIT + 25; index += 1) last = add(runtime, 'line ' + index)
  assert.equal(runtime.logs.length, LOG_RING_LIMIT, 'the ring must not grow past its limit')
  assert.equal(runtime.logs[0].seq, 26, 'the oldest lines are the ones that fall out')
  assert.equal(last.seq, LOG_RING_LIMIT + 25)
  assert.equal(last.message, 'line ' + (LOG_RING_LIMIT + 25))
  assert.equal(last.line, '[dsh-remote-go:h_test] line ' + (LOG_RING_LIMIT + 25))
  assert.equal(runtime.logSeq, last.seq)
})

test('appending to a runtime with no ring yet starts one', () => {
  const runtime = { id: 'h_fresh' }
  const entry = add(runtime, 'first', { level: 'warn' })
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
  assert.equal(tail.at(-1).seq, total)
  assert.equal(tail.at(-1).message, `line ${total} says token=abc and "quotes"`)
  assert.equal(tail.at(-1).level, 'debug')
  assert.equal('line' in tail.at(-1), false)
})

test('a runtime without a log yields an empty tail instead of throwing', () => {
  assert.deepEqual(connectLogTail({}), [])
  assert.deepEqual(connectLogTail({ logs: null }), [])
  assert.deepEqual(connectLogTail(null), [])
})

test('the ring redacts the remote launch line and clamps it, because HostView.logs reads it', () => {
  const runtime = runtimeOf()
  const line = [
    'LINE:dsh web: http://127.0.0.1:38123/?token=SUPERSECRET-TOKEN',
    'Authorization: Bearer local-value-77',
    '/home/alice/.dsh/remote-go/logs/web.log',
  ].join('\n')
  const entry = add(runtime, line, { level: 'debug' })
  for (const secret of ['SUPERSECRET-TOKEN', 'local-value-77', 'alice']) {
    assert.equal(entry.message.includes(secret), false, `${secret} survived the ring`)
    assert.equal(entry.line.includes(secret), false, `${secret} survived the log line`)
  }
  assert.match(entry.message, /token=<redacted>/)
  assert.match(entry.message, /<user>/)
  // `/state` and `/events` serialize `connectLogTail`, not the ring itself.
  assert.equal(JSON.stringify(connectLogTail(runtime)).includes('SUPERSECRET-TOKEN'), false)
  // A chatty single line is clamped to the same budget as any other technical detail.
  const huge = add(runtime, 'x'.repeat(LOG_TECHNICAL_LIMIT * 3))
  assert.ok(huge.message.length <= LOG_TECHNICAL_LIMIT + 8, `message was ${huge.message.length} characters`)
  assert.ok(huge.message.includes('…'), 'the elided middle keeps its marker')
})

test('every connection starts a clean ring with one boundary line that names the attempt', () => {
  const runtime = runtimeOf()
  add(runtime, 'old line')
  add(runtime, 'old connect failed: auth', { level: 'warn' })
  const boundary = beginConnectLog(runtime, { at: '2026-11-16T02:30:12.000Z' })
  assert.equal(runtime.logSeq, 1, 'the sequence restarts with the connection')
  assert.deepEqual(
    runtime.logs.map((entry) => entry.message),
    [boundary.message],
    'the previous attempt must not survive',
  )
  assert.equal(boundary.seq, 1)
  assert.equal(boundary.level, 'info')
  assert.equal(boundary.boundary, true)
  assert.equal(boundary.phase, null)
  assert.match(boundary.text.zh, /^— 第 1 次连接 · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d —$/)
  assert.match(boundary.text.en, /^— Connection 1 · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d —$/)
  assert.equal(connectLogTail(runtime)[0].boundary, true)
})

test('a failed connection followed by a new one leaves only the new boundary line', () => {
  const runtime = runtimeOf()
  beginConnectLog(runtime, { at: '2026-11-16T02:30:12.000Z' })
  add(runtime, 'connect failed: auth', { level: 'error' })
  add(runtime, '原因：SSH 认证没有通过', { level: 'error' })
  const second = beginConnectLog(runtime, { at: '2026-11-16T03:00:00.000Z' })
  assert.equal(runtime.connectCount, 2)
  assert.equal(runtime.logs.length, 1)
  assert.equal(runtime.logs[0], second)
  assert.match(second.text.zh, /^— 第 2 次连接 · /)
  assert.match(second.text.en, /^— Connection 2 · /)
})

test('reset empties the ring and its sequence without writing a line', () => {
  const runtime = runtimeOf({ logs: [{ seq: 4, message: 'old' }], logSeq: 4 })
  resetConnectLog(runtime)
  assert.deepEqual(runtime.logs, [])
  assert.equal(runtime.logSeq, 0)
  assert.equal(runtime.connectCount, undefined, 'reset alone does not count an attempt')
})

test('lines and the tail carry the phase they were written in', () => {
  const runtime = runtimeOf()
  add(runtime, 'SSH connected', { phase: 'ssh' })
  add(runtime, 'no phase yet')
  assert.equal(runtime.logs[0].phase, 'ssh')
  assert.equal(runtime.logs[1].phase, null, 'a line without a phase is not retyped')
  const tail = connectLogTail(runtime)
  assert.equal(tail[0].phase, 'ssh')
  assert.equal(tail[1].phase, null)
  assert.equal(add({ id: 'h_x' }, 'x', { phase: '' }).phase, null)
})

test('the tail only carries a complete bilingual pair, never half of one', () => {
  const runtime = {
    logs: [
      { seq: 1, at: '', level: 'info', phase: null, message: 'a', text: { zh: '甲', en: 'A' } },
      { seq: 2, at: '', level: 'info', phase: null, message: 'b', text: { zh: '乙' } },
      { seq: 3, at: '', level: 'info', phase: null, message: 'c', text: 'plain' },
    ],
  }
  const tail = connectLogTail(runtime)
  assert.deepEqual(tail[0].text, { zh: '甲', en: 'A' })
  assert.equal('text' in tail[1], false)
  assert.equal('text' in tail[2], false)
})

test('a failed start logs the phase, the code, the reason, every hint and the remote tail', () => {
  const view = {
    ...startFailedView,
    detail: {
      zh: '远端 DSH 进程没有成功打印 Web 地址，可能启动即失败。',
      en: 'The remote DSH process did not print its Web URL; startup likely failed.',
    },
    nextSteps: [
      { zh: '查看诊断里的远端日志尾部', en: 'Inspect the remote log tail in diagnostics' },
      { zh: '确认远端磁盘空间与端口可用', en: 'Check remote disk space and usable ports' },
    ],
    technical: 'EXITED:4242\n---LOG---\nError: cannot find module dsh\nurl=http://127.0.0.1:3000/?token=tok_secret_123',
  }
  const lines = connectFailureLines(view, { phase: 'start' })
  assert.ok(
    lines.every((line) => line.level === 'error'),
    'a failed connection must render at error level',
  )
  assert.ok(
    lines.every((line) => line.phase === 'start'),
    'every failure line names the phase it failed in',
  )
  assert.deepEqual(
    lines.slice(0, 5).map((line) => line.text.zh),
    [
      '连接失败于 start 阶段：remote-dsh-start-failed',
      '原因：远端 DSH 进程没有成功打印 Web 地址，可能启动即失败。',
      '建议：查看诊断里的远端日志尾部',
      '建议：确认远端磁盘空间与端口可用',
      '远端日志尾部：',
    ],
  )
  assert.equal(lines[0].text.en, 'Connect failed in phase start: remote-dsh-start-failed')
  assert.match(lines[1].text.en, /^Reason: The remote DSH process did not print/)
  assert.deepEqual(
    lines.slice(5).map((line) => line.message),
    ['EXITED:4242', '---LOG---', 'Error: cannot find module dsh', 'url=http://127.0.0.1:3000/?token=<redacted>'],
    'the remote log tail is printed line by line, redacted',
  )
})

test('a short failure without a remote tail still names the code, the reason and the hints', () => {
  const lines = connectFailureLines(
    {
      code: 'auth',
      title: { zh: 'SSH 认证没有通过', en: 'SSH authentication failed' },
      detail: { zh: '远端拒绝了这次 SSH 认证。', en: 'The remote host rejected this SSH authentication.' },
      nextSteps: [{ zh: '检查用户名与密钥', en: 'Check the user name and key' }],
    },
    { phase: 'ssh' },
  )
  assert.equal(lines.length, 3)
  assert.equal(lines[0].message, lines[0].text.en)
  assert.equal(lines[1].text.zh, '原因：远端拒绝了这次 SSH 认证。')
  assert.equal(lines[2].text.zh, '建议：检查用户名与密钥')
  assert.equal(
    lines.some((line) => /技术细节/.test(line.text?.zh ?? '')),
    false,
    'no technical section when there is no technical detail',
  )
})

test('an empty detail falls back to the title, and an unknown view still prints its code', () => {
  const titled = connectFailureLines(
    {
      code: 'network',
      title: { zh: '连不上这台服务器', en: 'Cannot reach this server' },
      detail: { zh: '', en: '' },
      nextSteps: [],
    },
    {},
  )
  assert.equal(titled[0].text.zh, '连接失败：network', 'no phase is claimed when the pipeline had none')
  assert.equal(titled[0].phase, null)
  assert.equal(titled[1].text.zh, '原因：连不上这台服务器')
  const unknown = connectFailureLines(null)
  assert.equal(unknown[0].text.zh, '连接失败：internal')
  assert.equal(unknown[0].level, 'error')
})

test('a hint that exists in one language only is printed in both', () => {
  const lines = connectFailureLines({ ...internalView, nextSteps: [{ zh: '重试一次' }] })
  assert.deepEqual(lines[2].text, { zh: '建议：重试一次', en: 'Next: 重试一次' })
})

test('a long technical detail is redacted and head-tail truncated instead of pasted whole', () => {
  const filler = 'x'.repeat(LOG_TECHNICAL_LIMIT * 4)
  const lines = connectFailureLines(
    { ...internalView, technical: `HEAD ${filler} password=hunter2` },
    { phase: 'probe' },
  )
  const printed = lines.slice(2).map((line) => line.message)
  assert.equal(lines[2].text.zh, '技术细节：')
  assert.equal(printed[0], 'Details:')
  assert.ok(
    printed.join('\n').length < LOG_TECHNICAL_LIMIT * 2,
    'the printed detail must stay near the headTail budget, not the original size',
  )
  assert.ok(printed.includes('…'), 'headTail keeps a marker where the middle was elided')
  assert.equal(
    printed.some((line) => line.includes('hunter2')),
    false,
    'a password must not reach the log',
  )
  assert.ok(printed.some((line) => line.includes('password=<redacted>')))
})

test('a single huge remote-log line is clamped to the per-line budget', () => {
  const lines = connectFailureLines({ ...startFailedView, technical: 'E'.repeat(5000) })
  for (const line of lines.slice(3)) assert.ok(line.message.length <= 500, 'a log line must stay readable')
})

test('a private key spanning the truncation point never reaches the log', () => {
  // Redaction has to run before `headTail`: the private-key pattern needs both markers, and a block spanning the cut
  // point would lose its END marker to the elided middle otherwise. The sizes keep BEGIN (with part of body) in the
  // retained head and put END in the elided middle, while the redacted text still fits inside the budget uncut.
  const half = LOG_TECHNICAL_LIMIT / 2
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(200)}\n-----END RSA PRIVATE KEY-----`
  const technical = `${'x'.repeat(half - 100)}\n${key}\n${'y'.repeat(half + 20)}`
  assert.ok(technical.length > LOG_TECHNICAL_LIMIT, 'the raw detail must be truncated if it is not redacted first')
  const printed = connectFailureLines({ ...internalView, technical })
    .map((line) => line.message)
    .join('\n')
  assert.doesNotMatch(printed, /BEGIN RSA PRIVATE KEY/, 'the key header must be redacted, not truncated around')
  assert.doesNotMatch(printed, /A{20}/, 'no body of the private key may reach the log')
  assert.match(printed, /-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----/)
})

test('a chatty remote log is capped at LOG_TAIL_LINES, whatever the log length', () => {
  // A fixed 200 lines, independent of constant: raising the cap must fail this test. Short lines on purpose (line cap).
  const technical = Array.from({ length: 200 }, (_, index) => `r${index + 1}`).join('\n')
  const lines = connectFailureLines({ ...startFailedView, technical })
  const printed = lines.slice(3)
  assert.equal(printed.length, LOG_TAIL_LINES, 'the header is separate; exactly LOG_TAIL_LINES tail lines print')
  assert.ok(printed.length <= 60, 'a failed start must never print more than 60 tail lines')
  assert.equal(printed[0].message, 'r1')
  assert.equal(printed.at(-1).message, `r${LOG_TAIL_LINES}`)
  assert.equal(
    printed.some((line) => line.message === `r${LOG_TAIL_LINES + 1}`),
    false,
    'the lines past the cap stay out of the log',
  )
})

/* The `HostRuntime` session state machine (design-arch §2.4): the 31 events, the 8 statuses, and the promise that every
 * (state, event) pair has an explicit outcome. Nothing here imports the pipeline: the FSM is a pure table, so the test
 * drives it with plain state objects. The interesting assertions are the two matrices — every state has a decision for
 * every event, and the 48 (status × activity) cells an entry point can see are allowed exactly where §2.4.2 says. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IllegalTransition,
  REFUSALS,
  isActivityCurrent,
  isRefusal,
  stillWanted,
  transition,
  writeBack,
} from '../../dist/src/runtime/fsm.js'
import { RESTART_STOP_WARNING, STOP_FAILED_LABEL } from '../../dist/src/runtime/rules.js'
import { EVENT_TYPE_PARITY, EVENT_TYPES } from '../../dist/src/runtime/events.js'
const STATUSES = [
  'unconfigured',
  'connecting',
  'fingerprint-pending',
  'conflict-pending',
  'connected',
  'disconnected',
  'error',
  'limited',
]
const ACTIVITIES = [null, 'connect', 'restart', 'reattach', 'stop', 'repair']
const ERROR_VIEW = {
  code: 'host-key-unknown',
  title: { zh: '确认服务器指纹', en: 'Confirm the host key' },
  detail: { zh: '指纹未确认', en: 'The key is not confirmed' },
  nextSteps: [],
  retryable: true,
}
const STOP_SNAPSHOT = {
  status: 'connected',
  phase: 'ready',
  progress: { code: 'ready' },
  error: null,
  uiReady: true,
  localPort: 53001,
}
/** One minimal valid payload per event type (the completeness matrix uses these). */
const EVENT_SAMPLES = {
  'connect.requested': { token: 1 },
  'step.entered': { phase: 'ssh', code: 'ssh-connecting' },
  'step.done': { step: 'probe' },
  'transport.ready': {},
  'transport.closed': { transport: null },
  'hostkey.pending': { info: { sha256: 'SHA256:abc', keyType: 'ssh-ed25519' }, role: 'target', host: null, port: 22 },
  'hostkey.answered': { accept: true },
  'hostkey.timeout': { view: ERROR_VIEW },
  'conflict.pending': { count: 2 },
  'conflict.answered': { action: 'stop' },
  'connect.succeeded': {},
  'connect.cancelled': {},
  'connect.failed': { view: ERROR_VIEW, phase: 'probe' },
  'disconnect.requested': {},
  'idle.elapsed': {},
  'repair.requested': { token: 2 },
  'repair.finished': { ok: true },
  'restart.requested': { token: 3, pid: 100, port: 8080 },
  'restart.resumed': {},
  'restart.failed': { view: ERROR_VIEW, phase: 'start' },
  'stop.requested': { token: 4, pid: 100, port: 8080 },
  'stop.refused': { view: ERROR_VIEW, phase: 'start', previous: STOP_SNAPSHOT },
  'stop.succeeded': {},
  'reattach.requested': { token: 5, reason: 'remote-unreachable' },
  'reattach.failed': { view: ERROR_VIEW },
  'reconnect.scheduled': { attempt: 1, max: 5, delayMs: 1000 },
  'reconnect.gaveup': { maxAttempts: 5, view: ERROR_VIEW },
  'reconnect.skipped': {},
  'link.cancelled': {},
  shutdown: {},
  'host.removed': { keepAlive: 'keep' },
}
const eventOf = (type) => ({ type, ...EVENT_SAMPLES[type] })
function stateOf(overrides = {}) {
  return {
    status: 'disconnected',
    desired: 'idle',
    activity: null,
    phase: null,
    progress: null,
    error: null,
    warning: null,
    warningSource: null,
    closing: false,
    connectCancelled: false,
    transportLost: false,
    reconnectAttempts: 0,
    epoch: 0,
    ...overrides,
  }
}
function scopeOf(overrides = {}) {
  return {
    disposed: false,
    runtimeExists: true,
    linkAlive: false,
    tunnelAlive: false,
    promptsPending: false,
    transportIsCurrent: true,
    hostId: 'h_test',
    keepAlive: 'keep',
    remoteStarted: false,
    recoverable: false,
    delays: { reconnectMs: 500, idleMs: 600000, heartbeatMs: 30000 },
    ...overrides,
  }
}
/** The desired flag a status implies in practice: an idle host is not "wanted connected". */
const desiredFor = (status) => (status === 'unconfigured' || status === 'disconnected' ? 'idle' : 'connected')
/** A connected runtime, and a connecting one with the connect activity: the two golden starts. */
const connectedState = (overrides) => stateOf({ status: 'connected', desired: 'connected', ...overrides })
const connectingState = (overrides) =>
  stateOf({ status: 'connecting', desired: 'connected', activity: 'connect', ...overrides })
/** The read-only facts a runtime in `status` would present to the machine. */
const scopeFor = (status) =>
  scopeOf({
    linkAlive: status === 'connected',
    tunnelAlive: status === 'connected',
    promptsPending: status === 'fingerprint-pending' || status === 'conflict-pending',
    remoteStarted: status === 'connected',
    recoverable: status === 'error',
  })
/** Step the machine once from `state` with a sample payload of `type` (one line per golden edge). */
const next = (state, type, scope) => transition(state, eventOf(type), scopeOf(scope))
const effectsOf = (result) => result.effects.map((effect) => effect.type)
const hasEffect = (result, type) => result.effects.some((effect) => effect.type === type)
const effectOf = (result, type) => result.effects.find((effect) => effect.type === type)
const patches = (result) =>
  result.effects.filter((effect) => effect.type === 'apply').map((effect) => effect.patch.kind)
/**
 * The hand-reviewed allow-matrix over the 48 (status × activity) cells an entry point can see. `statuses` and
 * `activities` are the two axes; a cell is allowed exactly when both match. Every one of 31 events must appear here —
 * that's what makes "no unhandled branch" checkable by a human instead of by reading the table again. */
const ALL = { statuses: [...STATUSES], activities: [...ACTIVITIES] }
const ALL_BUT = (excluded) => ({
  statuses: STATUSES.filter((status) => !excluded.includes(status)),
  activities: [...ACTIVITIES],
})
const ONLY_STATUS = (statuses) => ({ statuses, activities: [...ACTIVITIES] })
const ONLY_ACTIVITY = (activities) => ({ statuses: [...STATUSES], activities })
const ALLOW_MATRIX = {
  'connect.requested': { statuses: STATUSES.filter((status) => status !== 'connected'), activities: [null] },
  'step.entered': ONLY_ACTIVITY(ACTIVITIES.filter((activity) => activity !== null)),
  'step.done': ONLY_ACTIVITY(ACTIVITIES.filter((activity) => activity !== null)),
  'transport.ready': ONLY_ACTIVITY(ACTIVITIES.filter((activity) => activity !== null)),
  'transport.closed': ALL,
  'hostkey.pending': ONLY_STATUS(['connecting']),
  'hostkey.answered': ONLY_STATUS(['fingerprint-pending']),
  'hostkey.timeout': ONLY_STATUS(['fingerprint-pending']),
  'conflict.pending': ONLY_STATUS(['connecting']),
  'conflict.answered': ONLY_STATUS(['conflict-pending']),
  'connect.succeeded': { statuses: ['connecting'], activities: ['connect', 'restart', 'reattach'] },
  'connect.cancelled': ONLY_ACTIVITY(ACTIVITIES.filter((activity) => activity !== null)),
  'connect.failed': {
    // Any status: an attempt parked on a prompt reports the transport that dropped under it too.
    statuses: [...STATUSES],
    activities: ACTIVITIES.filter((activity) => activity !== null),
  },
  'disconnect.requested': ALL,
  'idle.elapsed': ONLY_STATUS(['unconfigured', 'disconnected']),
  'repair.requested': { statuses: ['connected'], activities: [null] },
  'repair.finished': ONLY_ACTIVITY(['repair']),
  'restart.requested': { statuses: ['connected', 'error'], activities: [null] },
  'restart.resumed': ONLY_ACTIVITY(['restart']),
  'restart.failed': ONLY_ACTIVITY(['restart']),
  'stop.requested': { statuses: ['connected', 'error'], activities: [null] },
  'stop.refused': ONLY_ACTIVITY(['stop']),
  'stop.succeeded': ONLY_ACTIVITY(['stop']),
  'reattach.requested': { statuses: ['connected'], activities: [null] },
  'reattach.failed': ONLY_ACTIVITY(['reattach']),
  'reconnect.scheduled': ALL_BUT(['unconfigured', 'disconnected']),
  'reconnect.gaveup': ALL_BUT(['unconfigured', 'disconnected']),
  'reconnect.skipped': ALL,
  'link.cancelled': ALL,
  shutdown: ALL,
  'host.removed': ALL,
}

describe('fsm: declarations', () => {
  test('declares exactly the 31 events of design-arch §2.4.2, once each', () => {
    assert.equal(EVENT_TYPES.length, 31)
    assert.equal(new Set(EVENT_TYPES).size, 31)
    assert.equal(EVENT_TYPE_PARITY, true)
    assert.deepEqual(
      Object.keys(EVENT_SAMPLES).sort(),
      [...EVENT_TYPES].sort(),
      'every declared event needs a sample payload, and no sample may name an undeclared event',
    )
  })

  test('declares the ten refusals of §2.4.4, once each', () => {
    assert.equal(REFUSALS.length, 10)
    assert.equal(new Set(REFUSALS).size, 10)
    assert.ok(REFUSALS.includes('unknown-event'))
    assert.ok(REFUSALS.includes('illegal-transition'))
  })

  test('every event type has at least one accepted (state, event) pair', () => {
    const accepted = new Set()
    for (const status of STATUSES) {
      for (const activity of ACTIVITIES) {
        const state = stateOf({ status, activity, desired: desiredFor(status) })
        for (const type of EVENT_TYPES) {
          if (transition(state, eventOf(type), scopeFor(status)).ok) accepted.add(type)
        }
      }
    }
    const missing = EVENT_TYPES.filter((type) => !accepted.has(type))
    assert.deepEqual(missing, [], `these events are refused everywhere: ${missing.join(', ')}`)
  })
})

describe('fsm: completeness matrices', () => {
  test('8 statuses × 6 activities × 2 desires × 2 closing flags × 31 events = 5952 explicit pairs', () => {
    let pairs = 0
    for (const status of STATUSES) {
      for (const activity of ACTIVITIES) {
        for (const desired of ['idle', 'connected']) {
          for (const closing of [false, true]) {
            // Frozen: a transition that wrote into its input would throw instead of passing.
            const state = Object.freeze(stateOf({ status, activity, desired, closing }))
            for (const type of EVENT_TYPES) {
              const result = transition(state, eventOf(type), scopeFor(status))
              pairs += 1
              const where = `${status}/${activity}/${desired}/closing=${closing} + ${type}`
              if (result.ok) {
                assert.ok(STATUSES.includes(result.state.status), `${where}: unknown status produced`)
                assert.ok(Array.isArray(result.effects), `${where}: effects must be an array`)
                assert.ok(result.state.epoch >= state.epoch, `${where}: epoch must not go backwards`)
                for (const effect of result.effects) assert.equal(typeof effect.type, 'string')
              } else {
                assert.ok(REFUSALS.includes(result.reason), `${where}: third outcome ${result.reason}`)
                assert.notEqual(result.reason, 'unknown-event', `${where}: the table must cover this event`)
                assert.equal(result.state, state, `${where}: a refused transition must not rewrite state`)
              }
            }
          }
        }
      }
    }
    assert.equal(pairs, 8 * 6 * 2 * 2 * 31)
    assert.equal(pairs, 5952)
  })

  test('the 48 (status × activity) cells are allowed exactly where §2.4.2 says', () => {
    assert.deepEqual(
      Object.keys(ALLOW_MATRIX).sort(),
      [...EVENT_TYPES].sort(),
      'the hand-written matrix must decide every event',
    )
    let cells = 0
    for (const type of EVENT_TYPES) {
      const expected = ALLOW_MATRIX[type]
      for (const status of STATUSES) {
        for (const activity of ACTIVITIES) {
          const state = stateOf({ status, activity, desired: desiredFor(status) })
          const allowed = transition(state, eventOf(type), scopeFor(status)).ok
          const wanted = expected.statuses.includes(status) && expected.activities.includes(activity)
          cells += 1
          assert.equal(allowed, wanted, `${type} at (${status}, activity=${activity}): allowed=${allowed}`)
        }
      }
    }
    assert.equal(cells, 31 * 48)
  })

  test('a refusal is distinguishable from an accepted move without reading effects', () => {
    const result = transition(
      stateOf({ status: 'connecting', activity: 'connect' }),
      eventOf('connect.requested'),
      scopeOf(),
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'already-connecting')
    assert.equal('effects' in result, false)
    assert.equal(isRefusal(result), true)
  })

  test('an event name the table does not declare is refused instead of thrown (untyped callers)', () => {
    // The table type forbids this, but a JavaScript caller can
    // still dispatch it, and the Host must survive one bad dispatch.
    const state = stateOf({ status: 'disconnected', desired: 'idle' })
    const result = transition(state, { type: 'not.an.event' }, scopeOf())
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unknown-event')
    assert.equal(result.state, state)
  })
})

describe('fsm: refusal reasons', () => {
  /** The reason `type` is refused from `state`; every call also proves the refusal itself. */
  const refusalOf = (state, type, scope) => {
    const result = transition(state, eventOf(type), scopeOf(scope))
    assert.equal(result.ok, false, `${type} must be refused`)
    return result.reason
  }

  test('connect.requested reports the three strings api.ts forwards verbatim', () => {
    const refused = (activity) => refusalOf(stateOf({ status: 'disconnected', activity }), 'connect.requested')
    assert.equal(refused('connect'), 'already-connecting')
    assert.equal(refused('restart'), 'already-restarting')
    // Today's `connect/links.ts#startConnect` returns `already-restarting` for *any* linkBusy kind.
    assert.equal(refused('reattach'), 'already-restarting')
    assert.equal(refused('stop'), 'already-restarting')
    assert.equal(refused('repair'), 'already-restarting')
    const connected = transition(
      stateOf({ status: 'connected', desired: 'connected' }),
      eventOf('connect.requested'),
      scopeOf({ linkAlive: true }),
    )
    assert.equal(connected.reason, 'already-connected')
  })

  test('restart/stop/repair/reattach entry guards name the real reason', () => {
    const busy = stateOf({ status: 'connected', desired: 'connected', activity: 'repair' })
    for (const type of ['restart.requested', 'stop.requested', 'repair.requested', 'reattach.requested']) {
      assert.equal(refusalOf(busy, type), 'busy')
    }
    const idle = stateOf({ status: 'disconnected', desired: 'idle' })
    for (const type of ['restart.requested', 'stop.requested', 'reattach.requested', 'repair.requested']) {
      assert.equal(refusalOf(idle, type), 'not-connected')
    }
    const unreachable = stateOf({ status: 'error', desired: 'connected', error: ERROR_VIEW })
    for (const type of ['restart.requested', 'stop.requested']) {
      assert.equal(refusalOf(unreachable, type, { recoverable: false }), 'not-recoverable')
    }
  })

  test('prompt answers are refused when no prompt is pending or the status moved on', () => {
    const pending = stateOf({ status: 'fingerprint-pending', desired: 'connected' })
    for (const type of ['hostkey.answered', 'hostkey.timeout']) {
      assert.equal(refusalOf(pending, type, { promptsPending: false }), 'stale-prompt')
    }
    const stale = stateOf({ status: 'connecting', desired: 'connected' })
    assert.equal(refusalOf(stale, 'hostkey.answered', { promptsPending: true }), 'prompt-not-pending')
    const connected = stateOf({ status: 'connected', desired: 'connected' })
    assert.equal(refusalOf(connected, 'conflict.answered', { promptsPending: true }), 'prompt-not-pending')
    const conflict = stateOf({ status: 'conflict-pending', desired: 'connected' })
    assert.equal(refusalOf(conflict, 'conflict.answered', { promptsPending: false }), 'stale-prompt')
  })

  test('script-only events are refused when no activity owns the link', () => {
    const idle = stateOf({ status: 'disconnected', desired: 'idle' })
    for (const type of ['step.entered', 'step.done', 'transport.ready', 'connect.cancelled', 'connect.failed']) {
      assert.equal(refusalOf(idle, type), 'illegal-transition', `${type} must require an activity`)
    }
    const mismatched = [
      ['restart.resumed', 'connect'],
      ['restart.failed', 'stop'],
      ['stop.succeeded', 'restart'],
      ['stop.refused', 'connect'],
      ['reattach.failed', 'stop'],
      ['repair.finished', 'reattach'],
    ]
    for (const [type, activity] of mismatched) {
      assert.equal(
        refusalOf(stateOf({ status: 'connecting', activity }), type),
        'illegal-transition',
        `${type} must require its own activity`,
      )
    }
  })
})

describe('fsm: golden event sequences (§6.2 risk 1)', () => {
  test('connect success: unconfigured → connecting → connected', () => {
    const first = next(stateOf({ status: 'unconfigured' }), 'connect.requested')
    assert.equal(first.ok, true)
    assert.equal(first.state.status, 'connecting')
    assert.equal(first.state.desired, 'connected')
    assert.equal(first.state.activity, 'connect')
    assert.equal(first.state.epoch, 1)
    assert.deepEqual(effectsOf(first), ['disarm', 'disarm', 'disarm', 'emit', 'run'])
    assert.deepEqual(effectOf(first, 'run'), { type: 'run', activity: 'connect', token: 1 })

    const step = next(first.state, 'step.entered')
    assert.equal(step.ok, true)
    assert.equal(step.state.status, 'connecting')
    assert.equal(step.state.phase, 'ssh')
    assert.deepEqual(step.state.progress, { code: 'ssh-connecting' })
    assert.deepEqual(effectsOf(step), ['emit'])

    const done = next(step.state, 'connect.succeeded')
    assert.equal(done.ok, true)
    assert.equal(done.state.status, 'connected')
    assert.equal(done.state.phase, 'ready')
    assert.deepEqual(done.state.progress, { code: 'ready' })
    assert.equal(done.state.activity, null)
    assert.equal(done.state.error, null)
    assert.deepEqual(patches(done), ['mark-attached', 'publish-active-host'])
    assert.deepEqual(effectsOf(done), ['disarm', 'arm', 'apply', 'apply', 'emit'])
    assert.deepEqual(effectOf(done, 'arm'), { type: 'arm', timer: 'heartbeat', ms: 30000 })
  })

  test('a host-key prompt parks the attempt, and its timeout fails it', () => {
    const connecting = next(stateOf({ status: 'unconfigured' }), 'connect.requested')
    const asked = next(connecting.state, 'hostkey.pending', { promptsPending: false })
    assert.equal(asked.ok, true)
    assert.equal(asked.state.status, 'fingerprint-pending')
    assert.equal(asked.state.phase, 'ssh')
    assert.deepEqual(asked.state.progress, {
      code: 'host-key-confirm',
      params: { sha256: 'SHA256:abc', keyType: 'ssh-ed25519' },
    })

    const timedOut = next(asked.state, 'hostkey.timeout', { promptsPending: true })
    assert.equal(timedOut.ok, true)
    assert.equal(timedOut.state.status, 'error')
    assert.equal(timedOut.state.error, ERROR_VIEW)
    assert.equal(timedOut.state.phase, null)
    assert.equal(timedOut.state.progress, null)
    assert.equal(timedOut.state.connectCancelled, true)
    // The attempt still owns the link: the pipeline's single exit reports the failure.
    assert.equal(timedOut.state.activity, 'connect')
  })

  test('a jump-host prompt publishes the jump identity, a target prompt does not', () => {
    const state = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect' })
    const jump = transition(
      state,
      { type: 'hostkey.pending', info: { sha256: 'SHA256:jump' }, role: 'jump', host: 'bastion', port: 2222 },
      scopeOf(),
    )
    assert.deepEqual(jump.state.progress, {
      code: 'host-key-confirm',
      params: { sha256: 'SHA256:jump', keyType: undefined, role: 'jump', host: 'bastion' },
    })
    const answered = transition(
      jump.state,
      { type: 'hostkey.answered', accept: false },
      scopeOf({ promptsPending: true }),
    )
    assert.equal(answered.state.status, 'connecting')
    assert.equal(answered.state.connectCancelled, true)
    assert.deepEqual(answered.state.progress, { code: 'auth-checking' })
  })

  test('a live link that drops becomes disconnected and asks for a retry', () => {
    const connected = connectedState({ phase: 'ready', progress: { code: 'ready' }, epoch: 4 })
    const dropped = next(connected, 'transport.closed', { linkAlive: true, tunnelAlive: true })
    assert.equal(dropped.ok, true)
    assert.equal(dropped.state.status, 'disconnected')
    assert.equal(dropped.state.transportLost, true)
    assert.equal(dropped.state.activity, null)
    assert.equal(dropped.state.epoch, 5)
    assert.equal(dropped.state.phase, null)
    assert.deepEqual(dropped.state.progress, { code: 'reconnecting', params: { attempt: 1 } })
    assert.deepEqual(effectsOf(dropped), ['apply', 'settlePrompts', 'disarm', 'closeLink', 'arm', 'emit'])
    assert.deepEqual(effectOf(dropped, 'arm'), { type: 'arm', timer: 'reconnect', ms: 500 })
  })

  test('a transport that drops during a one-shot action is a dropped link too', () => {
    const repairing = stateOf({ status: 'connected', desired: 'connected', activity: 'repair', epoch: 9 })
    const dropped = next(repairing, 'transport.closed', { linkAlive: true, tunnelAlive: true })
    assert.equal(dropped.state.status, 'disconnected')
    assert.equal(dropped.state.activity, null)
    assert.equal(dropped.state.epoch, 10)
  })

  test('a transport that drops while the handshake runs only records the loss', () => {
    const dialling = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect' })
    const dropped = next(dialling, 'transport.closed')
    assert.equal(dropped.ok, true)
    assert.equal(dropped.state.status, 'connecting')
    assert.equal(dropped.state.transportLost, true)
    assert.equal(dropped.state.activity, 'connect')
    assert.deepEqual(effectsOf(dropped), ['settlePrompts', 'log'])
    assert.deepEqual(effectOf(dropped, 'log'), {
      type: 'log',
      level: 'warn',
      message: 'the SSH transport closed while the connection was being set up',
    })
  })

  test('a stale or wanted-off close is a no-op instead of a lost link', () => {
    const live = stateOf({ status: 'connected', desired: 'connected' })
    const stale = next(live, 'transport.closed', { linkAlive: true, transportIsCurrent: false })
    assert.equal(stale.ok, true)
    assert.equal(stale.state, live)
    assert.deepEqual(stale.effects, [])

    const lettingGo = stateOf({ status: 'connected', desired: 'idle' })
    const ignored = next(lettingGo, 'transport.closed', { linkAlive: true })
    assert.equal(ignored.state, lettingGo)
    assert.deepEqual(ignored.effects, [])

    const disconnected = stateOf({ status: 'disconnected', desired: 'connected' })
    const idle = next(disconnected, 'transport.closed')
    assert.equal(idle.state, disconnected)
    assert.deepEqual(idle.effects, [])
  })

  test('restart: requested → resumed keeps the "stop not confirmed" warning, connect clears it', () => {
    const connected = stateOf({ status: 'connected', desired: 'connected', phase: 'ready', epoch: 2 })
    const requested = next(connected, 'restart.requested', { linkAlive: true, tunnelAlive: true })
    assert.equal(requested.state.status, 'connecting')
    assert.equal(requested.state.activity, 'restart')
    assert.equal(requested.state.epoch, 3)
    assert.equal(requested.state.phase, 'start')
    assert.deepEqual(requested.state.progress, { code: 'restarting-remote', params: { pid: 100, port: 8080 } })
    // The request rule publishes the new `connecting` card (like progress.set), then hands the action to the executor.
    assert.deepEqual(effectsOf(requested), ['disarm', 'disarm', 'disarm', 'emit', 'run'])

    const resumed = transition(requested.state, { type: 'restart.resumed', keptInstance: true }, scopeOf())
    assert.equal(resumed.state.status, 'connected')
    assert.equal(resumed.state.activity, null)
    assert.equal(resumed.state.warning, RESTART_STOP_WARNING)
    assert.equal(resumed.state.warningSource, 'restart-stop')
    assert.deepEqual(patches(resumed), ['mark-ui-up'])
    assert.deepEqual(effectsOf(resumed), ['apply', 'arm', 'emit'])

    // A restart that was cancelled before it touched anything resumes without inventing a warning.
    const cancelledRestart = next(requested.state, 'restart.resumed')
    assert.equal(cancelledRestart.state.status, 'connected')
    assert.equal(cancelledRestart.state.warning, null)
    assert.equal(cancelledRestart.state.warningSource, null)

    const nextConnect = next(resumed.state, 'connect.requested')
    assert.equal(nextConnect.state.warning, null)
    assert.equal(nextConnect.state.warningSource, null)

    // The attach also clears a stale "stop not confirmed" warning, though `connect.requested` already cleared it: the
    // row is belt-and-braces for a state that entered the attach without passing that entry point.
    const restartStopped = connectingState({ warning: RESTART_STOP_WARNING, warningSource: 'restart-stop' })
    const attached = next(restartStopped, 'connect.succeeded')
    assert.equal(attached.state.warning, null)
    assert.equal(attached.state.warningSource, null)

    const alongside = connectingState({ warning: { zh: '并存', en: 'alongside' }, warningSource: 'alongside' })
    const succeeded = next(alongside, 'connect.succeeded')
    assert.deepEqual(succeeded.state.warning, { zh: '并存', en: 'alongside' })
    assert.equal(succeeded.state.warningSource, 'alongside')
  })

  test('restart failure lands in error and may stop the remote', () => {
    const restarting = stateOf({ status: 'connecting', desired: 'connected', activity: 'restart', phase: 'start' })
    const failed = next(restarting, 'restart.failed', { keepAlive: 'stop', remoteStarted: true })
    assert.equal(failed.state.status, 'error')
    assert.equal(failed.state.error, ERROR_VIEW)
    assert.equal(failed.state.activity, null)
    assert.deepEqual(patches(failed), ['mark-detached'])
    assert.deepEqual(effectOf(failed, 'teardown').options, { stopRemote: true })
    assert.deepEqual(effectsOf(failed), ['apply', 'logFailure', 'teardown', 'emit'])
  })

  test('a refused stop puts the previous state back instead of publishing a fake error', () => {
    const connected = connectedState({ phase: 'ready', progress: { code: 'ready' } })
    const stopping = transition(connected, { type: 'stop.requested', token: 7, pid: 42, port: 8080 }, scopeOf())
    assert.equal(stopping.state.activity, 'stop')
    assert.deepEqual(stopping.state.progress, { code: 'stopping-remote', params: { pid: 42, port: 8080 } })
    assert.equal(stopping.state.error, null)

    // An unknown pid/port renders as 0, never as NaN (the Client interpolates both).
    const unknown = transition(connected, { type: 'stop.requested', token: 8, pid: null, port: null }, scopeOf())
    assert.deepEqual(unknown.state.progress, { code: 'stopping-remote', params: { pid: 0, port: 0 } })

    const refused = transition(stopping.state, { ...eventOf('stop.refused'), previous: STOP_SNAPSHOT }, scopeOf())
    assert.equal(refused.state.status, 'connected')
    assert.equal(refused.state.phase, 'ready')
    assert.deepEqual(refused.state.progress, { code: 'ready' })
    assert.equal(refused.state.activity, null)
    assert.deepEqual(effectOf(refused, 'apply').patch, { kind: 'restore-stop', uiReady: true, localPort: 53001 })
    assert.deepEqual(effectOf(refused, 'logFailure'), {
      type: 'logFailure',
      phase: 'start',
      label: STOP_FAILED_LABEL,
      // The restored state carries the *previous* error, so the failure line must still explain the stop that failed.
      view: ERROR_VIEW,
    })
  })

  test('a stop that cannot restore its link publishes the coded failure instead', () => {
    const stopping = stateOf({ status: 'connecting', desired: 'connected', activity: 'stop', phase: 'start' })
    const unrestorable = transition(stopping, { ...eventOf('stop.refused'), unrestorable: true }, scopeOf())
    assert.equal(unrestorable.state.status, 'error')
    assert.equal(unrestorable.state.error, ERROR_VIEW)
    assert.equal(unrestorable.state.phase, null)
    assert.equal(unrestorable.state.progress, null)
    assert.equal(unrestorable.state.activity, null)
    assert.deepEqual(patches(unrestorable), ['mark-detached'])
    assert.deepEqual(effectsOf(unrestorable), ['apply', 'logFailure', 'emit'])
  })

  test('a confirmed stop ends idle', () => {
    const stopping = stateOf({ status: 'connecting', desired: 'connected', activity: 'stop', phase: 'start', epoch: 4 })
    const done = next(stopping, 'stop.succeeded')
    assert.equal(done.state.status, 'disconnected')
    assert.equal(done.state.desired, 'idle')
    assert.equal(done.state.activity, null)
    assert.equal(done.state.epoch, 5)
    assert.deepEqual(effectOf(done, 'teardown').options, { stopRemote: false, stopped: true })
    assert.deepEqual(patches(done), ['mark-detached'])
  })

  test('disconnect during a connect step is allowed and stops the attempt (M1/H4)', () => {
    const dialling = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect', epoch: 1 })
    const disconnected = next(dialling, 'disconnect.requested')
    assert.equal(disconnected.ok, true)
    assert.equal(disconnected.state.status, 'disconnected')
    assert.equal(disconnected.state.desired, 'idle')
    assert.equal(disconnected.state.activity, null)
    assert.equal(disconnected.state.epoch, 2)
    assert.deepEqual(effectOf(disconnected, 'teardown').options, { stopRemote: false, keepSshForIdle: false })
    assert.deepEqual(effectsOf(disconnected), [
      'disarm',
      'disarm',
      'disarm',
      'settlePrompts',
      'teardown',
      'apply',
      'emit',
    ])
  })

  test('disconnecting an idle-policy host keeps the transport and arms the idle stop', () => {
    const connected = stateOf({ status: 'connected', desired: 'connected' })
    const disconnected = next(connected, 'disconnect.requested', { keepAlive: 'idle' })
    assert.deepEqual(effectOf(disconnected, 'teardown').options, { stopRemote: false, keepSshForIdle: true })
    assert.deepEqual(effectOf(disconnected, 'arm'), { type: 'arm', timer: 'idle', ms: 600000 })
  })

  test('an explicit stop passes stopped:true so the policy cannot stop twice', () => {
    const connected = stateOf({ status: 'connected', desired: 'connected' })
    const disconnected = transition(
      connected,
      { type: 'disconnect.requested', stopped: true },
      scopeOf({ keepAlive: 'idle' }),
    )
    assert.deepEqual(effectOf(disconnected, 'teardown').options, { stopRemote: false, keepSshForIdle: false })
    assert.equal(hasEffect(disconnected, 'arm'), false)
  })

  test('the idle timer is a no-op while the host is wanted again', () => {
    const wanted = stateOf({ status: 'disconnected', desired: 'connected' })
    const refused = next(wanted, 'idle.elapsed')
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'illegal-transition')

    const idle = stateOf({ status: 'disconnected', desired: 'idle' })
    const allowed = next(idle, 'idle.elapsed')
    assert.equal(allowed.ok, true)
    assert.equal(allowed.state, idle)
    assert.deepEqual(allowed.effects, [])
  })

  test('shutdown closes every timer and disarms prompts without publishing', () => {
    const connected = stateOf({ status: 'connected', desired: 'connected', epoch: 3 })
    const down = next(connected, 'shutdown', { keepAlive: 'keep' })
    assert.equal(down.state.closing, true)
    assert.equal(down.state.desired, 'idle')
    assert.equal(down.state.epoch, 4)
    assert.deepEqual(effectsOf(down), ['disarm', 'disarm', 'disarm', 'disarm', 'settlePrompts', 'teardown'])
    assert.deepEqual(effectOf(down, 'teardown').options, { stopRemote: false, shutdown: true })

    const stopPolicy = next(connected, 'shutdown', { keepAlive: 'stop' })
    assert.deepEqual(effectOf(stopPolicy, 'teardown').options, { stopRemote: true, shutdown: true })
  })

  test('removing a host releases the link and honours the stop policy', () => {
    const connected = stateOf({ status: 'connected', desired: 'connected', activity: 'repair', epoch: 2 })
    const removed = transition(connected, { type: 'host.removed', keepAlive: 'stop' }, scopeOf())
    assert.equal(removed.state.desired, 'idle')
    assert.equal(removed.state.activity, null)
    assert.equal(removed.state.epoch, 3)
    assert.deepEqual(effectOf(removed, 'teardown').options, { stopRemote: true })
    assert.deepEqual(effectsOf(removed), ['disarm', 'disarm', 'settlePrompts', 'teardown', 'emit'])
  })

  test('link.cancelled invalidates the token even when no activity is running', () => {
    const running = stateOf({ status: 'connecting', desired: 'connected', activity: 'restart', epoch: 6 })
    const cancelled = next(running, 'link.cancelled')
    assert.equal(cancelled.state.epoch, 7)
    assert.equal(cancelled.state.activity, null)
    assert.equal(isActivityCurrent(cancelled.state, 6), false)
    assert.deepEqual(effectsOf(cancelled), ['log'])
  })

  test('repair and re-attach hold their own activity and token', () => {
    const connected = stateOf({ status: 'connected', desired: 'connected', epoch: 1 })
    const repairing = transition(connected, { type: 'repair.requested', token: 2 }, scopeOf({ tunnelAlive: true }))
    assert.equal(repairing.state.activity, 'repair')
    assert.equal(repairing.state.status, 'connected')
    assert.deepEqual(effectOf(repairing, 'run'), { type: 'run', activity: 'repair', token: 2 })

    const repaired = transition(repairing.state, { type: 'repair.finished', ok: true }, scopeOf())
    assert.equal(repaired.state.activity, null)
    assert.deepEqual(patches(repaired), ['mark-ui-up'])
    const failedRepair = transition(repairing.state, { type: 'repair.finished', ok: false }, scopeOf())
    assert.deepEqual(failedRepair.effects, [])

    const reattaching = transition(
      connected,
      { type: 'reattach.requested', token: 2, reason: 'remote-unreachable' },
      scopeOf({ tunnelAlive: true }),
    )
    assert.equal(reattaching.state.activity, 'reattach')
    assert.equal(reattaching.state.status, 'connecting')
    assert.deepEqual(reattaching.state.progress, {
      code: 'restarting-remote',
      params: { reason: 'remote-unreachable' },
    })
    const lost = next(reattaching.state, 'reattach.failed')
    assert.equal(lost.state.status, 'error')
    assert.equal(lost.state.error, ERROR_VIEW)
    assert.equal(hasEffect(lost, 'closeLink'), true)
    assert.equal(hasEffect(lost, 'emit'), true)
  })

  test('the reconnect budget is only reset by a user connect or a successful attach (R5)', () => {
    const retrying = stateOf({ status: 'disconnected', desired: 'connected', reconnectAttempts: 2 })
    const scheduled = transition(
      retrying,
      { type: 'reconnect.scheduled', attempt: 3, max: 5, delayMs: 4000 },
      scopeOf(),
    )
    assert.equal(scheduled.state.reconnectAttempts, 3)
    assert.deepEqual(scheduled.state.progress, { code: 'reconnecting', params: { attempt: 3, max: 5 } })
    assert.deepEqual(effectOf(scheduled, 'arm'), { type: 'arm', timer: 'reconnect', ms: 4000 })

    const gaveUp = next(retrying, 'reconnect.gaveup')
    assert.equal(gaveUp.state.status, 'error')
    assert.equal(gaveUp.state.error, ERROR_VIEW)
    assert.deepEqual(effectsOf(gaveUp), ['emit'])

    const skipped = next(retrying, 'reconnect.skipped')
    assert.equal(skipped.state.status, 'disconnected')
    assert.equal(skipped.state.progress, null)

    const succeeded = next(
      stateOf({ status: 'connecting', desired: 'connected', activity: 'connect', reconnectAttempts: 3 }),
      'connect.succeeded',
    )
    assert.equal(succeeded.state.reconnectAttempts, 0)
  })

  test('the conflict prompt publishes and clears its card', () => {
    const connecting = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect' })
    const pending = next(connecting, 'conflict.pending', { promptsPending: false })
    assert.equal(pending.state.status, 'conflict-pending')
    assert.deepEqual(pending.state.progress, { code: 'remote-dsh-running', params: { count: 2 } })
    const answered = next(pending.state, 'conflict.answered', { promptsPending: true })
    assert.equal(answered.state.status, 'connecting')
    assert.deepEqual(answered.state.progress, { code: 'probing' })
    assert.deepEqual(patches(answered), ['clear-conflict'])
  })

  test('a cancelled connect ends disconnected without keeping the remote', () => {
    const connecting = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect', error: ERROR_VIEW })
    const cancelled = next(connecting, 'connect.cancelled')
    assert.equal(cancelled.state.status, 'disconnected')
    assert.equal(cancelled.state.error, null)
    assert.equal(cancelled.state.activity, null)
    assert.deepEqual(effectOf(cancelled, 'teardown').options, { stopRemote: false, keepRemote: true })
  })

  test('connect.failed only arms a retry while the user still wants the link (H2)', () => {
    const connecting = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect' })
    const failed = next(connecting, 'connect.failed')
    assert.equal(failed.state.status, 'error')
    assert.equal(hasEffect(failed, 'arm'), true)

    const cancelledByUser = connectingState({ connectCancelled: true })
    const noRetry = next(cancelledByUser, 'connect.failed')
    assert.equal(hasEffect(noRetry, 'arm'), false)

    // The explicit idempotent self-transition: error → error (§2.4.2).
    const alreadyFailed = stateOf({ status: 'error', desired: 'connected', activity: 'connect', error: ERROR_VIEW })
    assert.equal(next(alreadyFailed, 'connect.failed').ok, true)
  })

  test('connect.failed keeps a remote the keep-alive policy must not stop', () => {
    const connecting = stateOf({ status: 'connecting', desired: 'connected', activity: 'connect' })
    const failed = next(connecting, 'connect.failed', { keepAlive: 'idle', remoteStarted: true })
    assert.deepEqual(effectOf(failed, 'teardown').options, { stopRemote: false, keepRemote: true })
    const neverStarted = next(connecting, 'connect.failed', { keepAlive: 'stop', remoteStarted: false })
    assert.deepEqual(effectOf(neverStarted, 'teardown').options, { stopRemote: false, keepRemote: false })
  })

  test('a stale request token cannot rewind the epoch (R10)', () => {
    const state = stateOf({ status: 'connected', desired: 'connected', epoch: 9 })
    const requested = transition(state, { type: 'restart.requested', token: 2, pid: null, port: null }, scopeOf())
    assert.equal(requested.state.epoch, 9)
    assert.deepEqual(effectOf(requested, 'run'), { type: 'run', activity: 'restart', token: 9 })
    assert.deepEqual(requested.state.progress, { code: 'restarting-remote', params: { pid: 0, port: 0 } })
  })
})

describe('fsm: shared predicates', () => {
  test('stillWanted reads desire, closing and the process lifetime', () => {
    const wanted = stateOf({ desired: 'connected' })
    assert.equal(stillWanted(wanted, scopeOf()), true)
    assert.equal(stillWanted(stateOf({ desired: 'idle' }), scopeOf()), false)
    assert.equal(stillWanted(stateOf({ desired: 'connected', closing: true }), scopeOf()), false)
    assert.equal(stillWanted(wanted, scopeOf({ runtimeExists: false })), false)
    assert.equal(stillWanted(wanted, scopeOf({ disposed: true })), false)
  })

  test('isActivityCurrent compares the epoch, never a flag', () => {
    assert.equal(isActivityCurrent(stateOf({ epoch: 4 }), 4), true)
    assert.equal(isActivityCurrent(stateOf({ epoch: 4 }), 3), false)
    assert.equal(isActivityCurrent(stateOf({ epoch: 4 }), 5), false)
  })
})

describe('fsm: storage form', () => {
  test('writeBack maps activity/epoch back into the flat runtime and leaves liveness alone', () => {
    // The four liveness fields start at values the watchdog would have written; writeBack must not touch them (B9).
    const runtime = { remoteFailures: 2, remoteEpisode: true, episodeSource: 'proxy', episodeCooldownUntil: 1234 }
    const state = connectedState({ activity: 'restart', epoch: 7, phase: 'ready', progress: { code: 'ready' } })
    writeBack(runtime, state)
    assert.equal(runtime.status, 'connected')
    assert.equal(runtime.desired, 'connected')
    assert.equal(runtime.linkBusy, 'restart')
    assert.equal(runtime.linkToken, 7)
    assert.equal(runtime.phase, 'ready')
    assert.deepEqual(runtime.progress, { code: 'ready' })
    assert.equal(runtime.remoteFailures, 2)
    assert.equal(runtime.remoteEpisode, true)
    assert.equal(runtime.episodeSource, 'proxy')
    assert.equal(runtime.episodeCooldownUntil, 1234)

    writeBack(runtime, stateOf())
    assert.equal(runtime.linkBusy, null)
    assert.equal(runtime.remoteEpisode, true)
    assert.equal(runtime.episodeSource, 'proxy')
    assert.equal(runtime.episodeCooldownUntil, 1234)
  })

  test('IllegalTransition names the event and the reason but never reaches ErrorView', () => {
    const error = new IllegalTransition('busy', 'restart.requested')
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'IllegalTransition')
    assert.equal(error.code, 'illegal-transition')
    assert.equal(error.eventType, 'restart.requested')
    assert.match(error.message, /restart\.requested/)
    assert.match(error.message, /busy/)
  })
})

describe('fsm: purity', () => {
  test('the same inputs produce deeply equal results and never share state objects', () => {
    const state = stateOf({ status: 'connected', desired: 'connected' })
    const first = next(state, 'disconnect.requested')
    const second = next(state, 'disconnect.requested')
    assert.deepEqual(first, second)
    assert.notEqual(first.state, state, 'an accepted move returns a fresh state object')
    assert.deepEqual(state, stateOf({ status: 'connected', desired: 'connected' }), 'the input is untouched')
  })

  test('refusals return the very same state object for every event', () => {
    const state = Object.freeze(stateOf({ status: 'disconnected', desired: 'idle' }))
    for (const type of EVENT_TYPES) {
      const result = transition(state, eventOf(type), scopeOf())
      if (result.ok === false) assert.equal(result.state, state, `${type} rebuilt the state on refusal`)
    }
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { LinkCancelled, assertStillWanted, linkTaken } from '../../dist/src/connect/guards.js'

/**
 * H4: `assertStillWanted` is the single "may this attempt still write state" gate.
 *
 * `linkTaken` is the predicate behind it; the four conditions it ORs are the four ways a link can
 * be taken away (process shutdown, this runtime's teardown, the user no longer wanting it, the
 * host leaving the registry). It is pure, so the whole matrix is a table over a fixture instead of
 * a race against a timer. Every future caller must go through this gate, so a condition that stops
 * being detected is a resurrection bug (a late write revives a dead link).
 */
function link({ disposed = false, closing = false, desired = 'connected', registered = true } = {}) {
  const runtime = { id: 'host-1', closing, desired }
  const ctx = {
    state: {
      disposed,
      runtimes: new Map(registered ? [[runtime.id, runtime]] : []),
    },
  }
  return { ctx, runtime }
}

test('assertStillWanted rejects every taken link and accepts a live one', () => {
  const taken = [
    ['the host process is shutting down', { disposed: true }],
    ['the runtime is being torn down', { closing: true }],
    ['the user stopped wanting the link', { desired: 'idle' }],
    ['the host left the runtime registry', { registered: false }],
  ]
  for (const [label, overrides] of taken) {
    const { ctx, runtime } = link(overrides)
    assert.equal(linkTaken(ctx, runtime), true, `${label}: linkTaken must report the taken link`)
    assert.throws(
      () => assertStillWanted(ctx, runtime),
      (error) => error instanceof LinkCancelled && error.code === 'link-cancelled',
      `${label}: assertStillWanted must throw LinkCancelled`,
    )
  }

  const live = link()
  assert.equal(linkTaken(live.ctx, live.runtime), false, 'a wanted, registered, open link is not taken')
  assert.doesNotThrow(() => assertStillWanted(live.ctx, live.runtime))

  // The guards only read: a refusal must not write the runtime it judged.
  const judged = link({ closing: true })
  assert.throws(() => assertStillWanted(judged.ctx, judged.runtime))
  assert.equal(judged.runtime.closing, true)
  assert.equal(judged.runtime.desired, 'connected')
  assert.equal(judged.ctx.state.disposed, false)
  assert.equal(judged.ctx.state.runtimes.has(judged.runtime.id), true)
})

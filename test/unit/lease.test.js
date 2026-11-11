import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIRROR_CONFLICT_LIMIT,
  acquireLease,
  applyEvents,
  assertWritable,
  currentEpoch,
  expireLease,
  isLeaseHeldBy,
  nextEpoch,
  observeRemoteLease,
  renewLease,
} from '../../src/mirror.js'
import { buildLeaseReadCommand, fetchRemoteLease, parseRemoteLease, remoteLeaseFile } from '../../src/lease.js'

const TTL = 30_000

/** @param {number} now @param {string} [owner] */
function stateWith(now, owner = 'w1') {
  return acquireLease({ cursor: 0 }, { owner, now, ttlMs: TTL }).state
}

test('an acquisition issues a strictly increasing epoch and a renewal keeps it', () => {
  const first = acquireLease({ cursor: 0 }, { owner: 'w1', now: 1000, ttlMs: TTL })
  assert.equal(first.ok, true)
  assert.equal(first.epoch, 1)
  assert.equal(first.state.epoch, 1)

  // Renewing the same live lease is the same authority: the token must not move, or every
  // heartbeat would invalidate the writer's own outstanding writes.
  const renewed = renewLease(first.state, { owner: 'w1', now: 2000, ttlMs: TTL })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.epoch, 1)

  // A grant over an *expired but present* lease is a takeover, and it advances the token.
  const takeover = acquireLease(first.state, { owner: 'w2', now: 1000 + TTL + 10, ttlMs: TTL })
  assert.equal(takeover.ok, true)
  assert.equal(takeover.tookOver, true)
  assert.equal(takeover.epoch, 2, 'a takeover must issue a newer epoch, never reuse one')
  // `expireLease` reports the expiry and leaves no lease behind (it returns the dropped
  // one alongside the cleaned state).
  const expired = expireLease(first.state, { now: 1000 + TTL + 1 })
  assert.equal(expired.expired, true)
  assert.equal(expired.state.lease, null)
  assert.equal(expired.readOnly, true)
})

test('the epoch high-water mark never regresses, even with no lease at all', () => {
  const base = { cursor: 0, epoch: 7 }
  // No lease, but the mark survives: a new grant is 8, not 1.
  assert.equal(nextEpoch(base), 8)
  const granted = acquireLease(base, { owner: 'w1', now: 1000, ttlMs: TTL })
  assert.equal(granted.epoch, 8)
  // Releasing the lease does not lower it.
  assert.equal(currentEpoch({ cursor: 0, epoch: 8, lease: null }), 8)
  // A lease carrying a higher epoch than the mark wins (we learned about a newer grant).
  assert.equal(
    currentEpoch({ cursor: 0, epoch: 3, lease: { owner: 'w', acquiredAt: 1, renewedAt: 1, expiresAt: 2, epoch: 9 } }),
    9,
  )
})

test('a stale epoch is refused, in both directions', () => {
  const state = stateWith(1000) // epoch 1
  const write = assertWritable(state, { owner: 'w1', epoch: 1, now: 1100 })
  assert.equal(write.ok, true, 'the current epoch may write')

  // Someone else took over: the mark moves to 2, so our epoch 1 is fenced.
  const fencedState = observeRemoteLease(state, { writer: 'remote-writer', epoch: 2 }).state
  const refused = assertWritable(fencedState, { owner: 'w1', epoch: 1, now: 1200 })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'stale-epoch')
  assert.equal(refused.readOnly, true)
  assert.equal(refused.currentEpoch, 2)

  // The other direction: a writer holding a *newer* epoch is accepted once it also holds
  // the lease (an epoch alone never steals a live lease), and it raises our mark so the
  // older writer cannot slip back in afterwards.
  const newerState = acquireLease(state, { owner: 'w2', now: 1250, ttlMs: TTL })
  assert.equal(newerState.ok, false, 'a live lease is not stolen by presenting an epoch')
  assert.equal(newerState.reason, 'lease-held-by-other')
  const handedOver = acquireLease(expireLease(state, { now: 1000 + TTL }).state, {
    owner: 'w2',
    now: 1000 + TTL + 5,
    ttlMs: TTL,
  })
  assert.equal(handedOver.epoch, 2)
  const newer = assertWritable(handedOver.state, { owner: 'w2', epoch: 2, now: 1000 + TTL + 10 })
  assert.equal(newer.ok, true, 'a newer epoch is authoritative')
  assert.equal(assertWritable(newer.state, { owner: 'w1', epoch: 1, now: 1400 }).reason, 'stale-epoch')
})

test('an expired lease stops the writer even at its own epoch', () => {
  const state = stateWith(1000)
  assert.equal(isLeaseHeldBy(state, 'w1', 1000 + TTL - 1), true)
  assert.equal(isLeaseHeldBy(state, 'w1', 1000 + TTL), false)
  const expired = assertWritable(state, { owner: 'w1', epoch: 1, now: 1000 + TTL })
  assert.equal(expired.ok, false)
  assert.equal(expired.reason, 'lease-expired')
  // A lease held by someone else is reported as such, not as staleness; once it *has*
  // expired, the same call succeeds as a takeover.
  const busy = acquireLease(state, { owner: 'w2', now: 2000, ttlMs: TTL })
  assert.equal(busy.ok, false)
  assert.equal(busy.reason, 'lease-held-by-other')
  const afterExpiry = acquireLease(state, { owner: 'w2', now: 1000 + TTL + 1, ttlMs: TTL })
  assert.equal(afterExpiry.ok, true, 'an expired lease is free to take over')
})

test('a fenced writer that re-acquires a newer epoch resumes', () => {
  // w1 holds epoch 1, gets fenced by w2's epoch 2, then takes over again.
  let state = stateWith(1000)
  state = observeRemoteLease(state, { writer: 'w2', epoch: 2 }).state
  assert.equal(assertWritable(state, { owner: 'w1', epoch: 1, now: 1100 }).ok, false)

  // Its lease is gone (fencing clears it), so it must re-acquire — which issues epoch 3.
  const reacquired = acquireLease({ ...state, lease: null }, { owner: 'w1', now: 1200, ttlMs: TTL })
  assert.equal(reacquired.ok, true)
  assert.equal(reacquired.epoch, 3)
  const resumed = assertWritable(reacquired.state, { owner: 'w1', epoch: 3, now: 1300 })
  assert.equal(resumed.ok, true, 'a re-acquired newer epoch may write again')
})

test('a fencing event is reported once per epoch', () => {
  const state = stateWith(1000)
  const first = observeRemoteLease(state, { writer: 'w2', epoch: 2 })
  assert.equal(first.fenced, true)
  assert.equal(first.changed, true)
  assert.equal(first.reason, 'fenced-by-newer-epoch')

  // Same number again: still fenced (we must not write), but not a new *occurrence*.
  const repeat = observeRemoteLease(first.state, { writer: 'w2', epoch: 2 })
  assert.equal(repeat.fenced, true, 'a repeat still means "do not write"')
  assert.equal(repeat.changed, false, 'but it must not be announced again')

  // A newer number is a new occurrence.
  const later = observeRemoteLease(first.state, { writer: 'w3', epoch: 3 })
  assert.equal(later.fenced, true)
  assert.equal(later.changed, true)
  assert.equal(later.reason, 'fenced-by-newer-epoch')

  // A different writer at the same epoch is an occurrence once, then it is known.
  const changedWriter = observeRemoteLease(state, { writer: 'w9', epoch: 1 })
  assert.equal(changedWriter.fenced, true)
  assert.equal(changedWriter.changed, true)
  assert.equal(changedWriter.reason, 'writer-changed')
  assert.equal(observeRemoteLease(changedWriter.state, { writer: 'w9', epoch: 1 }).changed, false)

  // No authority reported at all: nothing happens.
  assert.equal(observeRemoteLease(state, {}).fenced, false)
})

test('the epoch survives a restart through normalisation', () => {
  const state = stateWith(1000)
  const fenced = observeRemoteLease(state, { writer: 'w2', epoch: 4 }).state
  // Persisting and re-reading goes through JSON + normalisation, which is what a restart does.
  const restored = JSON.parse(JSON.stringify(fenced))
  assert.equal(currentEpoch(restored), 4)
  const granted = acquireLease(restored, { owner: 'w1', now: 2000, ttlMs: TTL })
  assert.equal(granted.epoch, 5, 'a restart must not reissue an old epoch')
  assert.equal(assertWritable(granted.state, { owner: 'w1', epoch: 1, now: 2001 }).reason, 'stale-epoch')
})

test('a same-seq conflict is reported instead of silently dropped', () => {
  const first = { seq: 1, type: 'user/message', data: { text: 'original' } }
  const conflicting = { seq: 1, type: 'user/message', data: { text: 'rewritten' } }
  const result = applyEvents({ cursor: 0, events: [] }, [first, conflicting])

  // Keep-first is still the policy...
  assert.equal(result.state.events.length, 1)
  assert.equal(result.state.events[0].data.text, 'original')
  // ...but the loss is now visible, with both sides bounded.
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].seq, 1)
  assert.match(result.conflicts[0].kept, /original/)
  assert.match(result.conflicts[0].lost, /rewritten/)
  assert.equal(result.state.conflictCount, 1)
})

test('an identical duplicate is a replay, not a conflict', () => {
  const event = { seq: 1, type: 'user/message', data: { text: 'same' } }
  const result = applyEvents({ cursor: 0, events: [] }, [event, { ...event, data: { ...event.data } }])
  assert.equal(result.conflicts.length, 0, 'replaying the same batch must not look like data loss')
  assert.equal(result.state.conflictCount ?? 0, 0)
})

test('conflict reporting is bounded and the payload summary is clipped', () => {
  const long = 'x'.repeat(500)
  /** @type {any[]} */
  const batch = []
  for (let seq = 1; seq <= MIRROR_CONFLICT_LIMIT + 10; seq += 1) {
    batch.push({ seq, type: 'user/message', data: { text: `${long} a` } })
    batch.push({ seq, type: 'user/message', data: { text: `${long} b` } })
  }
  const result = applyEvents({ cursor: 0, events: [] }, batch)
  assert.equal(result.conflicts.length, MIRROR_CONFLICT_LIMIT, 'the reported list is capped')
  assert.equal(result.conflictCount, MIRROR_CONFLICT_LIMIT + 10, 'the counter still counts them all')
  assert.equal(result.state.conflicts.length, MIRROR_CONFLICT_LIMIT)
  for (const conflict of result.conflicts) {
    // type + ": " + 120 clipped chars + "…" + " #" + 7-char hash.
    assert.ok(conflict.kept.length <= 160, `summary must be clipped, got ${conflict.kept.length}`)
    assert.ok(conflict.kept.length >= 120, 'the preview is still useful')
    // Clipping alone would make `… a` and `… b` identical, so the digest carries a short
    // hash of the full text: the two sides must stay distinguishable.
    assert.notEqual(conflict.kept, conflict.lost, 'the two sides must remain distinguishable after clipping')
    assert.match(conflict.kept, / #[a-z0-9]{1,7}$/)
    assert.match(conflict.lost, / #[a-z0-9]{1,7}$/)
  }
})

test('lease commands are quoted and bounded', () => {
  const file = remoteLeaseFile('/home/u/.dsh-remote-go/home/')
  assert.equal(file, '/home/u/.dsh-remote-go/home/remote-go/lease.json')
  const command = buildLeaseReadCommand("/a/it's.json", 512)
  // Single-quoted, one byte past the cap, stderr preserved (so a permission error is classifiable).
  assert.match(command, /^head -c 513 '/)
  assert.match(command, /2>&1 \|\| true$/)
  // The embedded quote is escaped (`'\''`), so the path cannot break out of the quoting.
  assert.ok(command.includes(`it'\\''s.json`), `a quote in the path must be escaped: ${command}`)
})

test('the remote authority read is typed and never throws', async () => {
  /** @param {(command: string) => any} answer */
  const sshOf = (answer) => ({ exec: async (command) => answer(command) })
  const ok = await fetchRemoteLease(
    sshOf(() => ({ code: 0, stdout: '{"writer":"w2","epoch":3}', stderr: '' })),
    {
      remoteDshHome: '/h',
    },
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.report, { writer: 'w2', epoch: 3, expiresAt: null })

  // No authority published is normal, not an error.
  const absent = await fetchRemoteLease(
    sshOf(() => ({ code: 0, stdout: '', stderr: '' })),
    { remoteDshHome: '/h' },
  )
  assert.equal(absent.ok, true)
  assert.equal(absent.report, null)

  const missing = await fetchRemoteLease(
    sshOf(() => ({ code: 1, stdout: 'head: No such file', stderr: '' })),
    {
      remoteDshHome: '/h',
    },
  )
  assert.equal(missing.ok, true, 'a missing lease file means nobody else is writing')
  assert.equal(missing.report, null)

  const denied = await fetchRemoteLease(
    sshOf(() => ({ code: 1, stdout: 'head: Permission denied', stderr: '' })),
    {
      remoteDshHome: '/h',
    },
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'permission-denied')

  // A malformed authority must NOT be read as "nobody else is writing".
  const malformed = await fetchRemoteLease(
    sshOf(() => ({ code: 0, stdout: '{oops', stderr: '' })),
    {
      remoteDshHome: '/h',
    },
  )
  assert.equal(malformed.ok, false)
  assert.equal(malformed.reason, 'lease-malformed')

  const broken = await fetchRemoteLease(
    {
      exec: async () => {
        throw new Error('ssh died')
      },
    },
    { remoteDshHome: '/h' },
  )
  assert.equal(broken.ok, false)
  assert.equal(broken.reason, 'read-failed')

  const noSsh = await fetchRemoteLease(null, { remoteDshHome: '/h' })
  assert.equal(noSsh.ok, false)
  assert.equal(noSsh.reason, 'ssh-unavailable')
})

test('the authority parser accepts the documented shapes only', () => {
  assert.deepEqual(parseRemoteLease('{"writer":"w","epoch":2,"expiresAt":10}'), {
    ok: true,
    writer: 'w',
    epoch: 2,
    expiresAt: 10,
  })
  // `owner` is accepted as an alias, and a numeric string epoch is tolerated.
  assert.deepEqual(parseRemoteLease('{"owner":"w","epoch":"3"}'), { ok: true, writer: 'w', epoch: 3, expiresAt: null })
  for (const bad of ['', 'null', '[]', '"x"', '{}', '{"junk":true}']) {
    assert.equal(parseRemoteLease(bad).ok, false, `${bad} must be malformed`)
  }
})

test('re-reading the same batch does not double-count conflicts', () => {
  // L2 re-reads the whole remote log every sync (§11 #7), so the same conflict comes back on
  // every pass. Reviewer's probe: 30 conflicts counted 30, an identical second batch made it
  // 60. Only conflicts for records this call actually applied may be counted.
  const first = { seq: 1, type: 'user/message', data: { text: 'original' } }
  const conflicting = { seq: 1, type: 'user/message', data: { text: 'rewritten' } }
  const once = applyEvents({ cursor: 0, events: [] }, [first, conflicting])
  assert.equal(once.conflictCount, 1)
  assert.equal(once.state.conflictCount, 1)
  assert.equal(once.state.conflicts.length, 1)

  // The identical batch again: the record is already behind the cursor, so nothing is
  // re-applied and nothing may be re-counted.
  const twice = applyEvents(once.state, [first, conflicting])
  assert.equal(twice.applied, 0)
  assert.equal(twice.conflictCount, 1, 'a re-read must not inflate the counter')
  assert.equal(twice.conflicts.length, 0, 'and must not re-report the same conflict')
  assert.equal(twice.state.conflictCount, 1)
  assert.equal(twice.state.conflicts.length, 1, 'the recorded conflict is kept')
})

test('a genuinely new conflict still counts while a repeat does not', () => {
  const first = { seq: 1, type: 'user/message', data: { text: 'a' } }
  const once = applyEvents({ cursor: 0, events: [] }, [first, { ...first, data: { text: 'b' } }])
  assert.equal(once.state.conflictCount, 1)

  // A new seq arrives with its own conflict: the counter advances by exactly one.
  const second = { seq: 2, type: 'user/message', data: { text: 'c' } }
  const twice = applyEvents(once.state, [
    first,
    { ...first, data: { text: 'b' } },
    second,
    { ...second, data: { text: 'd' } },
  ])
  assert.equal(twice.state.conflictCount, 2, 'only the new pair is counted')
  assert.equal(twice.state.conflicts.length, 2)
  assert.deepEqual(
    twice.state.conflicts.map((conflict) => conflict.seq),
    [1, 2],
  )
})

test('a re-applied seq (cursor did not advance) is not counted twice', () => {
  // The append-failure case: the cursor stays put, so the next sync applies the same seq
  // again. The conflict is the same pair and must merge, not accumulate.
  const kept = { seq: 1, type: 'user/message', data: { text: 'kept' } }
  const lost = { seq: 1, type: 'user/message', data: { text: 'lost' } }
  const first = applyEvents({ cursor: 0, events: [] }, [kept, lost])
  assert.equal(first.state.conflictCount, 1)
  // Same state (cursor still 0) and the same batch: applied again, same pair.
  const again = applyEvents({ cursor: 0, events: [], conflicts: first.state.conflicts, conflictCount: 1 }, [kept, lost])
  assert.equal(again.state.conflictCount, 1, 'the same (seq, kept, lost) pair merges')
  assert.equal(again.state.conflicts.length, 1)
})

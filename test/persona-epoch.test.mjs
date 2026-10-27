import assert from 'node:assert/strict';
import test from 'node:test';

import { planPersonaEpoch } from '../src/channels/discord/persona-epoch.mjs';

test('an unchanged epoch leaves the binding and the record alone', () => {
  assert.deepEqual(planPersonaEpoch({ epoch: 3, seenEpoch: 3, sessionId: 's1' }), {
    changed: false, clearSession: false, enqueueHandoff: false, seenEpoch: 3,
  });
});

test('a newer epoch clears the binding and queues the handoff', () => {
  assert.deepEqual(planPersonaEpoch({ epoch: 4, seenEpoch: 3, sessionId: 's1' }), {
    changed: true, clearSession: true, enqueueHandoff: true, seenEpoch: 4,
  });
});

test('a newer epoch without a bound session only advances the record', () => {
  assert.deepEqual(planPersonaEpoch({ epoch: 4, seenEpoch: 3, sessionId: null }), {
    changed: true, clearSession: false, enqueueHandoff: false, seenEpoch: 4,
  });
  assert.deepEqual(planPersonaEpoch({ epoch: 4, seenEpoch: 3, sessionId: '' }), {
    changed: true, clearSession: false, enqueueHandoff: false, seenEpoch: 4,
  });
});

test('a state file without a record is treated as epoch zero', () => {
  assert.deepEqual(planPersonaEpoch({ epoch: 0, sessionId: 's1' }), {
    changed: false, clearSession: false, enqueueHandoff: false, seenEpoch: 0,
  });
  assert.deepEqual(planPersonaEpoch({ epoch: 1, sessionId: 's1' }), {
    changed: true, clearSession: true, enqueueHandoff: true, seenEpoch: 1,
  });
});

test('a rolled-back epoch also counts as a change', () => {
  // Only a hand edit of config.json gets here; the persona still changed, so the
  // session bound under the newer persona must not keep answering as it.
  assert.deepEqual(planPersonaEpoch({ epoch: 1, seenEpoch: 3, sessionId: 's1' }), {
    changed: true, clearSession: true, enqueueHandoff: true, seenEpoch: 1,
  });
});

test('an invalid epoch is rejected instead of silently resetting', () => {
  for (const epoch of [-1, 1.5, '4', null, undefined, Number.NaN]) {
    assert.throws(() => planPersonaEpoch({ epoch, seenEpoch: 0, sessionId: 's1' }), TypeError);
  }
});

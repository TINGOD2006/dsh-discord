import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPersonaEpoch } from '../src/channels/discord/persona-epoch.mjs';

function fakeState({ sessions = {}, seen = 0 } = {}) {
  const calls = [];
  return {
    calls,
    sessionFor: (key) => sessions[key] ?? null,
    personaEpochSeen: () => seen,
    setPersonaEpochSeen: async (epoch) => { calls.push(['setSeen', epoch]); seen = epoch; },
    clearSession: async (key) => { calls.push(['clearSession', key]); delete sessions[key]; },
  };
}

test('an unchanged epoch writes nothing', async () => {
  const state = fakeState({ sessions: { 'group:1': 's-old' }, seen: 3 });
  const result = await applyPersonaEpoch({ epoch: 3, state, key: 'group:1' });
  assert.equal(result.changed, false);
  assert.equal(result.oldSessionId, 's-old');
  assert.deepEqual(state.calls, []);
});

test('a switch clears the binding first, then records the epoch', async () => {
  const state = fakeState({ sessions: { 'group:1': 's-old' }, seen: 3 });
  const handed = [];
  const result = await applyPersonaEpoch({
    epoch: 4,
    state,
    key: 'group:1',
    handoff: async ({ key, oldSessionId }) => { handed.push([key, oldSessionId]); },
  });
  assert.equal(result.changed, true);
  assert.equal(result.oldSessionId, 's-old');
  assert.deepEqual(state.calls, [['clearSession', 'group:1'], ['setSeen', 4]]);
  assert.deepEqual(handed, [['group:1', 's-old']]);
});

test('a switch without a bound session only records the epoch', async () => {
  const state = fakeState({ seen: 0 });
  const result = await applyPersonaEpoch({ epoch: 5, state, key: 'group:2' });
  assert.equal(result.changed, true);
  assert.equal(result.oldSessionId, null);
  assert.deepEqual(state.calls, [['setSeen', 5]]);
});

test('a failing handoff cannot fail the turn', async () => {
  const state = fakeState({ sessions: { 'group:1': 's-old' }, seen: 1 });
  await applyPersonaEpoch({
    epoch: 2,
    state,
    key: 'group:1',
    handoff: async () => { throw new Error('handoff exploded'); },
  });
  assert.equal(state.personaEpochSeen(), 2);
});

test('an invalid epoch surfaces instead of silently resetting', async () => {
  const state = fakeState({ seen: 1 });
  await assert.rejects(() => applyPersonaEpoch({ epoch: Number.NaN, state, key: 'k' }), TypeError);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyModelToBotSessions } from '../src/channels/shared/bot-workspace-store.mjs';

const MODEL = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
});

function fakeState(sessions) {
  return { snapshot: () => ({ sessions }) };
}

function fakeHarness(handler) {
  const calls = [];
  return {
    calls,
    async selectSessionModel(sessionId, model) {
      calls.push([sessionId, model]);
      return handler(sessionId, model);
    },
  };
}

test('a saved model reaches every distinct session the bot already bound', async () => {
  const harness = fakeHarness((sessionId, model) => ({ selected: { ...model, now: sessionId } }));
  const state = fakeState({ 'group:1': 's1', 'dm:2': 's2', 'group:3': 's1' });
  const result = await applyModelToBotSessions(harness, state, MODEL);
  assert.deepEqual(result, { applied: 2, failed: 0, sessionIds: ['s1', 's2'] });
  assert.deepEqual(harness.calls.map(([sessionId]) => sessionId), ['s1', 's2']);
  assert.deepEqual(harness.calls[0][1], MODEL);
});

test('one unreachable session does not stop the others and only warns', async () => {
  const warnings = [];
  const harness = fakeHarness((sessionId, model) => {
    if (sessionId === 's2') throw Object.assign(new Error('gone'), { code: 'session-not-found' });
    return { selected: model };
  });
  const state = fakeState({ a: 's1', b: 's2', c: 's3' });
  const result = await applyModelToBotSessions(harness, state, MODEL, {
    logger: { warn: (message) => warnings.push(String(message)) },
  });
  assert.equal(result.applied, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.sessionIds, ['s1', 's2', 's3']);
  assert.equal(harness.calls.length, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /s2/);
  assert.match(warnings[0], /session-not-found/);
});

test('a harness that reports another model counts as a failure', async () => {
  const harness = fakeHarness(() => ({ selected: { provider: 'lmstudio', model: 'qwen3' } }));
  const result = await applyModelToBotSessions(harness, fakeState({ a: 's1' }), MODEL);
  assert.deepEqual(result, { applied: 0, failed: 1, sessionIds: ['s1'] });
});

test('clearing the model leaves existing sessions alone', async () => {
  const harness = fakeHarness((sessionId, model) => ({ selected: model }));
  const result = await applyModelToBotSessions(harness, fakeState({ a: 's1' }), null);
  assert.deepEqual(result, { applied: 0, failed: 0, sessionIds: [] });
  assert.equal(harness.calls.length, 0);
});

test('a state without bindings or a harness without model support is a no-op', async () => {
  const harness = fakeHarness((sessionId, model) => ({ selected: model }));
  assert.deepEqual(await applyModelToBotSessions(harness, { snapshot: () => ({}) }, MODEL), {
    applied: 0, failed: 0, sessionIds: [],
  });
  assert.deepEqual(await applyModelToBotSessions({}, fakeState({ a: 's1' }), MODEL), {
    applied: 0, failed: 0, sessionIds: [],
  });
  assert.equal(harness.calls.length, 0);
});

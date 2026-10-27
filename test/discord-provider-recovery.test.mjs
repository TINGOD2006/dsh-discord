import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECOVERY_BACKOFF_MS,
  RECOVERY_REPLAY_ATTEMPTS,
  createProviderRecovery,
  isProviderFailureCode,
} from '../src/channels/discord/provider-recovery.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';
import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';

/**
 * Manual clock: every scheduled retry sits in a queue until the test runs it,
 * so backoff sequences are asserted without waiting real minutes.
 */
function fakeClock() {
  const queue = [];
  return {
    schedule(fn, delayMs) {
      const task = { fn, delayMs };
      queue.push(task);
      return task;
    },
    cancel(task) {
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
    },
    get delays() {
      return queue.map((task) => task.delayMs);
    },
    get pending() {
      return queue.length;
    },
    async runNext() {
      const task = queue.shift();
      assert.ok(task, 'expected a scheduled retry');
      await task.fn();
      return task.delayMs;
    },
  };
}

function recovery({ retry, pendingCount, signal, clock } = {}) {
  return createProviderRecovery({
    retry: retry ?? (async () => undefined),
    pendingCount: pendingCount ?? (() => 1),
    signal,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
}

test('only provider failures arm the retry schedule', () => {
  const clock = fakeClock();
  const target = recovery({ clock });

  assert.equal(target.note({ code: 'MODEL_CONTEXT_LIMIT' }), false);
  assert.equal(target.note({ code: 'AUTH' }), false);
  assert.equal(target.note({ code: undefined }), false);
  assert.equal(target.armed, false);
  assert.equal(clock.pending, 0);

  assert.equal(target.note({ code: 'MODEL_SERVICE' }), true);
  assert.equal(target.armed, true);
  assert.deepEqual(clock.delays, [RECOVERY_BACKOFF_MS[0]]);
});

test('a second failure while armed does not stack another timer', () => {
  const clock = fakeClock();
  const target = recovery({ clock });

  target.note({ code: 'MODEL_SERVICE' });
  target.note({ code: 'MODEL_AUTH' });
  assert.equal(clock.pending, 1);
});

test('the sweeps back off while staged messages remain', async () => {
  const clock = fakeClock();
  const budgets = [];
  const target = recovery({
    clock,
    retry: async ({ maxAttempts }) => budgets.push(maxAttempts),
  });

  target.note({ code: 'MODEL_AUTH' });
  await clock.runNext();
  await clock.runNext();
  await clock.runNext();

  assert.deepEqual(budgets, [RECOVERY_REPLAY_ATTEMPTS, RECOVERY_REPLAY_ATTEMPTS, RECOVERY_REPLAY_ATTEMPTS]);
  assert.deepEqual(clock.delays, [RECOVERY_BACKOFF_MS[3]]);
  assert.equal(target.sweep, 3);
});

test('draining the backlog stops the schedule', async () => {
  const clock = fakeClock();
  let pending = 2;
  const target = recovery({
    clock,
    pendingCount: () => pending,
    retry: async () => { pending = 0; },
  });

  target.note({ code: 'MODEL_SERVICE' });
  await clock.runNext();

  assert.equal(target.armed, false);
  assert.equal(clock.pending, 0);
});

test('an empty backlog at fire time skips the sweep entirely', async () => {
  const clock = fakeClock();
  let calls = 0;
  let pending = 1;
  const target = recovery({
    clock,
    pendingCount: () => pending,
    retry: async () => { calls += 1; },
  });

  target.note({ code: 'MODEL_SERVICE' });
  pending = 0;
  await clock.runNext();

  assert.equal(calls, 0);
  assert.equal(target.armed, false);
});

test('a failing sweep keeps retrying instead of throwing', async () => {
  const clock = fakeClock();
  let calls = 0;
  const target = recovery({
    clock,
    retry: async () => {
      calls += 1;
      throw new Error('503 no healthy upstream');
    },
  });

  target.note({ code: 'MODEL_SERVICE' });
  await clock.runNext();

  assert.equal(calls, 1);
  assert.equal(target.armed, true);
  assert.equal(clock.pending, 1);
});

test('the retry budget runs out and the schedule stops', async () => {
  const clock = fakeClock();
  let calls = 0;
  const target = recovery({ clock, retry: async () => { calls += 1; } });

  target.note({ code: 'MODEL_TRANSPORT' });
  for (let index = 0; index < RECOVERY_BACKOFF_MS.length; index += 1) {
    await clock.runNext();
  }

  assert.equal(calls, RECOVERY_BACKOFF_MS.length);
  assert.equal(target.armed, false);
  assert.equal(clock.pending, 0);
});

test('the replay budget outlasts the retry window', () => {
  // Otherwise the staging row would be removed as "out of attempts" while the
  // scheduler still had sweeps left to spend.
  assert.ok(RECOVERY_REPLAY_ATTEMPTS > RECOVERY_BACKOFF_MS.length);
});

test('an aborted bridge stops retrying', async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const target = recovery({ clock, signal: controller.signal });

  target.note({ code: 'MODEL_SERVICE' });
  controller.abort();

  assert.equal(target.armed, false);
  assert.equal(clock.pending, 0);
  assert.equal(target.note({ code: 'MODEL_SERVICE' }), false);
});

test('the provider failure set covers the codes the gateway returns', () => {
  for (const code of [
    'MODEL_SERVICE',
    'MODEL_AUTH',
    'MODEL_QUOTA',
    'MODEL_TRANSPORT',
    'MODEL_RATE_LIMIT',
    'MODEL_TIMEOUT',
    'MODEL_REPLY_TIMEOUT',
    'MODEL_UNAVAILABLE',
    'MODEL_STREAM',
    'MODEL_EMPTY_REPLY',
  ]) {
    assert.equal(isProviderFailureCode(code), true, code);
  }
  for (const code of [
    'MODEL_CONTEXT_LIMIT',
    'MODEL_CONTENT_REJECTED',
    'MODEL_OUTPUT_LIMIT',
    'MODEL_CONFIG',
    'INPUT_INVALID',
    'turn-stopped',
    '',
  ]) {
    assert.equal(isProviderFailureCode(code), false, code);
  }
});

test('the shared bridge defines no onTurnFailed hook, so other channels are unchanged', () => {
  assert.equal(typeof TextHarnessBridge.prototype.onTurnFailed, 'undefined');
  assert.equal(typeof TextHarnessBridge.prototype.retryStagedMessages, 'function');
});

test('the Discord bridge is the one that defines the hook', () => {
  assert.equal(typeof DiscordHarnessBridge.prototype.onTurnFailed, 'function');
});

/**
 * A staging store good enough for the sweep: it records what the bridge asks
 * for, so a skipped row is visible as "never removed". It starts empty because
 * constructing a bridge already fires the one-shot startup sweep; tests add
 * their rows afterwards, the way a failed turn would.
 */
function stagedStore() {
  const entries = [];
  const removed = [];
  const unmarked = [];
  return {
    entries,
    removed,
    unmarked,
    pendingMessages: () => entries.map((entry) => ({ ...entry })),
    removePendingMessage: async (id) => { removed.push(id); },
    unmarkSeen: async (messageId) => { unmarked.push(messageId); },
    patchPendingMessage: async () => {},
    markSeen: async () => {},
  };
}

function plainBridge(state) {
  return new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { sendText: async () => {} },
    harness: {},
    state,
    logger: { warn() {}, error() {}, info() {} },
  });
}

test('a mid-process sweep leaves messages that never failed a turn alone', async () => {
  const state = stagedStore();
  const bridge = plainBridge(state);
  state.entries.push(
    { id: 'a', messageId: 'a', createdAt: '2026-01-01T00:00:00.000Z', attempts: 99, target: null },
    { id: 'b', messageId: 'b', createdAt: '2026-01-02T00:00:00.000Z', target: null },
  );

  await bridge.retryStagedMessages({ onlyAttempted: true });

  assert.deepEqual(state.removed, ['a'], 'the failed row is reported out of attempts');
  assert.deepEqual(state.unmarked, [], 'nothing is replayed, so nothing is unmarked');
});

test('a sweep without the flag still walks every staged row', async () => {
  const state = stagedStore();
  const bridge = plainBridge(state);
  state.entries.push(
    { id: 'a', messageId: 'a', createdAt: '2026-01-01T00:00:00.000Z', attempts: 99, target: null },
    { id: 'b', messageId: 'b', createdAt: '2026-01-02T00:00:00.000Z', attempts: 99, target: null },
  );

  await bridge.retryStagedMessages();

  assert.deepEqual(state.removed, ['a', 'b']);
});
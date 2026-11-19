import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_SESSION_MAX_IDLE_HOURS,
  DEFAULT_SESSION_MAX_TURNS,
  normalizeSessionRotation,
  rotationDue,
  sessionRotationFromEnv,
} from '../src/channels/shared/session-rotation.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

test('a disabled policy normalizes to null so callers skip the bookkeeping', () => {
  assert.equal(normalizeSessionRotation(null), null);
  assert.equal(normalizeSessionRotation(false), null);
  assert.equal(normalizeSessionRotation({ maxTurns: 0, maxIdleMs: 0 }), null);
  assert.equal(normalizeSessionRotation({ maxTurns: -5 }), null);
});

test('either bound alone is enough to enable rotation', () => {
  assert.deepEqual({ ...normalizeSessionRotation({ maxTurns: 10 }) }, { maxTurns: 10, maxIdleMs: 0 });
  assert.deepEqual({ ...normalizeSessionRotation({ maxIdleMs: 1000 }) }, { maxTurns: 0, maxIdleMs: 1000 });
});

test('the turn bound fires at the limit, not after it', () => {
  const policy = normalizeSessionRotation({ maxTurns: 3 });
  assert.equal(rotationDue({ sessionId: 's', turns: 2, lastAt: 0 }, policy), false);
  assert.equal(rotationDue({ sessionId: 's', turns: 3, lastAt: 0 }, policy), true);
});

test('the idle bound fires only once the recorded activity is old enough', () => {
  const policy = normalizeSessionRotation({ maxIdleMs: 1000 });
  const now = 10_000;
  assert.equal(rotationDue({ sessionId: 's', turns: 1, lastAt: now - 999 }, policy, now), false);
  assert.equal(rotationDue({ sessionId: 's', turns: 1, lastAt: now - 1000 }, policy, now), true);
  // A record that never saw a turn cannot be idle.
  assert.equal(rotationDue({ sessionId: 's', turns: 0, lastAt: 0 }, policy, now), false);
});

test('a missing record or policy never rotates', () => {
  assert.equal(rotationDue(null, normalizeSessionRotation({ maxTurns: 1 })), false);
  assert.equal(rotationDue({ sessionId: 's', turns: 99, lastAt: 0 }, null), false);
});

test('the environment defaults keep rotation on and 0 disables a bound', () => {
  const defaults = sessionRotationFromEnv({});
  assert.equal(defaults.maxTurns, DEFAULT_SESSION_MAX_TURNS);
  assert.equal(defaults.maxIdleMs, DEFAULT_SESSION_MAX_IDLE_HOURS * 3_600_000);

  const turnsOnly = sessionRotationFromEnv({
    DSK_DISCORD_SESSION_MAX_TURNS: '50',
    DSK_DISCORD_SESSION_MAX_IDLE_HOURS: '0',
  });
  assert.deepEqual({ ...turnsOnly }, { maxTurns: 50, maxIdleMs: 0 });

  assert.equal(sessionRotationFromEnv({
    DSK_DISCORD_SESSION_MAX_TURNS: '0',
    DSK_DISCORD_SESSION_MAX_IDLE_HOURS: '0',
  }), null);
});

test('a non-numeric override falls back to the default instead of disabling rotation', () => {
  const policy = sessionRotationFromEnv({ DSK_DISCORD_SESSION_MAX_TURNS: 'lots' });
  assert.equal(policy.maxTurns, DEFAULT_SESSION_MAX_TURNS);
});

test('the state store counts turns against the bound Session and resets on a new one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-rotation-'));
  try {
    const store = await new ConversationStateStore(join(dir, 'state.json')).load();
    assert.equal(store.sessionRotationFor('group:1'), null);

    await store.recordSessionTurn('group:1', 'session-a', 1000);
    await store.recordSessionTurn('group:1', 'session-a', 2000);
    assert.deepEqual(store.sessionRotationFor('group:1'), { sessionId: 'session-a', turns: 2, lastAt: 2000 });

    // A different Session id starts the counter over: the old count belongs to
    // the Session it was written for.
    await store.recordSessionTurn('group:1', 'session-b', 3000);
    assert.deepEqual(store.sessionRotationFor('group:1'), { sessionId: 'session-b', turns: 1, lastAt: 3000 });

    // The counter survives a reload, so a restart cannot silently reset it.
    const reloaded = await new ConversationStateStore(join(dir, 'state.json')).load();
    assert.deepEqual(reloaded.sessionRotationFor('group:1'), { sessionId: 'session-b', turns: 1, lastAt: 3000 });

    await reloaded.clearSession('group:1');
    assert.equal(reloaded.sessionRotationFor('group:1'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

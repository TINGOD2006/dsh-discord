import test from 'node:test';
import assert from 'node:assert/strict';

import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { isContextOverflowFailure } from '../src/channels/shared/session-rotation.mjs';

const KEY = 'group:123';
const ROTATION = { maxTurns: 300, maxIdleMs: 86_400_000 };

function overflowError() {
  return Object.assign(new Error('400: maximum context length'), {
    code: 'harness-turn-failed',
    providerCode: 'CONTEXT_WINDOW_EXCEEDED',
  });
}

/**
 * `overflowOn` lists the Session ids whose ask() fails with a context overflow.
 * Every other Session answers normally.
 */
function fixture({ overflowOn = [], exists = true } = {}) {
  const asked = [];
  let created = 0;
  const harness = {
    workspaceSession: (sessionId) => ({
      sessionId,
      sessionExists: async () => exists,
      ask: async () => {
        asked.push(sessionId);
        if (overflowOn.includes(sessionId)) throw overflowError();
        return 'ok';
      },
    }),
    resolveDsBotSession: async () => null,
    createSession: async () => {
      created += 1;
      return `session-fresh-${created}`;
    },
  };
  const bindings = new Map([[KEY, 'session-old']]);
  const state = {
    sessionFor: (key) => bindings.get(key) ?? null,
    setSession: async (key, value) => {
      bindings.set(key, value);
      return true;
    },
    clearSession: async (key) => {
      bindings.delete(key);
    },
  };
  return { harness, state, asked, bindings, createdCount: () => created };
}

test('the overflow code is recognised from the provider code and the plain code', () => {
  assert.equal(isContextOverflowFailure(overflowError()), true);
  assert.equal(isContextOverflowFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }), true);
  assert.equal(isContextOverflowFailure({ code: 'harness-turn-failed', providerCode: 'SERVER' }), false);
  assert.equal(isContextOverflowFailure(null), false);
});

test('a Session that has outgrown the window is replaced and the turn retried once', async () => {
  const { harness, state, asked, bindings } = fixture({ overflowOn: ['session-old'] });

  const result = await askInWorkspaceSession({
    harness, state, key: KEY, text: 'hello', trustBoundSession: true, rotation: ROTATION,
  });

  assert.equal(result.sessionId, 'session-fresh-1');
  assert.deepEqual(asked, ['session-old', 'session-fresh-1'], 'the turn is retried on the fresh Session');
  assert.equal(bindings.get(KEY), 'session-fresh-1', 'the binding moved off the dead Session');
});

test('without a rotation policy the overflow is not retried', async () => {
  const { harness, state, asked } = fixture({ overflowOn: ['session-old'] });

  await assert.rejects(
    askInWorkspaceSession({ harness, state, key: KEY, text: 'hello', trustBoundSession: true }),
    /maximum context length/u,
  );
  assert.deepEqual(asked, ['session-old'], 'other channels keep the previous behaviour');
});

test('a fresh Session that also overflows surfaces instead of looping', async () => {
  const { harness, state, asked } = fixture({ overflowOn: ['session-old', 'session-fresh-1'] });

  await assert.rejects(
    askInWorkspaceSession({
      harness, state, key: KEY, text: 'hello', trustBoundSession: true, rotation: ROTATION,
    }),
    /maximum context length/u,
  );
  assert.deepEqual(asked, ['session-old', 'session-fresh-1'], 'exactly one retry');
});

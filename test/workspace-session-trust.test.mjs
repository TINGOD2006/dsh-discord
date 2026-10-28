import test from 'node:test';
import assert from 'node:assert/strict';

import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

const KEY = 'group:123';

function fixture({ exists = false } = {}) {
  const asked = [];
  const created = [];
  const sessions = [];
  const harness = {
    workspaceSession: (sessionId) => ({
      sessionId,
      sessionExists: async () => exists,
      ask: async () => {
        asked.push(sessionId);
        return 'ok';
      },
    }),
    resolveDsBotSession: async () => null,
    createSession: async () => {
      created.push(true);
      const fresh = 'session-fresh';
      sessions.push(fresh);
      return fresh;
    },
  };
  const bindings = new Map([[KEY, 'session-old']]);
  const state = {
    sessionFor: (key) => bindings.get(key) ?? null,
    setSession: async (key, value) => {
      bindings.set(key, value);
      return true;
    },
  };
  return { harness, state, asked, created, bindings };
}

test('trustBoundSession keeps a pin whose Session the Harness no longer lists', async () => {
  const { harness, state, asked, created, bindings } = fixture();

  const result = await askInWorkspaceSession({
    harness, state, key: KEY, text: 'hello', trustBoundSession: true,
  });

  assert.equal(result.sessionId, 'session-old');
  assert.deepEqual(asked, ['session-old']);
  assert.equal(created.length, 0, 'no replacement Session is created');
  assert.equal(bindings.get(KEY), 'session-old', 'the pin survives the turn');
});

test('without trustBoundSession an unlisted Session is still replaced', async () => {
  const { harness, state, asked, created, bindings } = fixture();

  const result = await askInWorkspaceSession({ harness, state, key: KEY, text: 'hello' });

  assert.equal(result.sessionId, 'session-fresh');
  assert.deepEqual(created, [true]);
  assert.deepEqual(asked, ['session-fresh']);
  assert.equal(bindings.get(KEY), 'session-fresh');
});

test('a listed Session is used with or without the trust flag', async () => {
  const { harness, state, asked, created } = fixture({ exists: true });

  const result = await askInWorkspaceSession({
    harness, state, key: KEY, text: 'hello', trustBoundSession: true,
  });

  assert.equal(result.sessionId, 'session-old');
  assert.deepEqual(asked, ['session-old']);
  assert.equal(created.length, 0);
});

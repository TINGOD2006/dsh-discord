import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { runMusicCommand } from '../src/channels/shared/music-commands.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-music-method-'));
  const path = join(dir, 'state.json');
  try {
    return await fn({ path, open: async () => new ConversationStateStore(path).load() });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an unset default reads as null and leaves other state alone', () => withStore(async ({ path, open }) => {
  await writeFile(path, JSON.stringify({ version: 1, sessions: { 'group:1': 's-1' } }), 'utf8');
  const store = await open();
  assert.equal(store.musicDefaultMethod(), null);
  assert.equal(store.sessionFor('group:1'), 's-1');
}));

test('the saved default survives a reload', () => withStore(async ({ open }) => {
  const first = await open();
  await first.setMusicDefaultMethod('dsh-web');
  assert.equal(first.musicDefaultMethod(), 'dsh-web');
  const second = await open();
  assert.equal(second.musicDefaultMethod(), 'dsh-web');
}));

test('an empty or non-string default is rejected without touching the file', () => withStore(async ({ path, open }) => {
  const store = await open();
  for (const value of ['', null, undefined, 3, {}]) {
    await assert.rejects(() => store.setMusicDefaultMethod(value), TypeError);
  }
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.musicDefaultMethod, undefined);
}));

test('a hand-edited unknown method is ignored by /play instead of breaking it', () => withStore(async ({ path, open }) => {
  await writeFile(path, JSON.stringify({ version: 1, sessions: {}, musicDefaultMethod: 'bogus' }), 'utf8');
  const store = await open();
  assert.equal(store.musicDefaultMethod(), 'bogus');
  const requests = [];
  const context = { conversationId: 'text', senderId: 'user', music: {
    execute: async (name, args) => { requests.push({ name, ...args }); return { message: 'ok' }; },
  } };
  await runMusicCommand('/play 晴天', null, store, null, context);
  assert.equal(requests.at(-1).selectionMethod, undefined, 'an unknown saved value must not reach the pipeline');
}));

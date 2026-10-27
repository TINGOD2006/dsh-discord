import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordAllowlistStore } from '../src/channels/discord/allowlist.mjs';

async function tempStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-allowlist-'));
  return { home, store: new DiscordAllowlistStore({ dshHome: home }) };
}

function allowlistPath(home) {
  return join(home, 'integrations', 'dsh-discord', 'allowlist.json');
}

test('an absent file is an empty list', async () => {
  const { store } = await tempStore();
  assert.deepEqual(store.list(), []);
  assert.equal(store.snapshot().customized, false);
});

test('write drops non-ID values and reads back in order', async () => {
  const { store } = await tempStore();
  const snapshot = store.write(['837707455294078976', ' 652521751082696724 ', 'not-an-id']);
  assert.deepEqual(snapshot.ids, ['837707455294078976', '652521751082696724']);
  assert.equal(snapshot.customized, true);
  assert.deepEqual(store.list(), ['837707455294078976', '652521751082696724']);
  assert.equal(store.has('652521751082696724'), true);
});

test('a UTF-8 BOM written by Notepad still parses', async () => {
  const { home, store } = await tempStore();
  await mkdir(join(home, 'integrations', 'dsh-discord'), { recursive: true });
  await writeFile(allowlistPath(home), '\uFEFF{\n  "ids": ["414409379912220674"]\n}\n', 'utf8');
  assert.deepEqual(store.list(), ['414409379912220674']);
  assert.equal(store.has('414409379912220674'), true);
});

test('a malformed file reads as empty instead of throwing', async () => {
  const { home, store } = await tempStore();
  await mkdir(join(home, 'integrations', 'dsh-discord'), { recursive: true });
  await writeFile(allowlistPath(home), '{ oops', 'utf8');
  assert.deepEqual(store.list(), []);
});


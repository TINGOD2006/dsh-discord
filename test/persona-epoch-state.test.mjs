import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-persona-state-'));
  const path = join(dir, 'state.json');
  try {
    return await fn({ path, open: async () => new ConversationStateStore(path).load() });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a state file without the record reads as epoch zero', () => withStore(async ({ path, open }) => {
  await writeFile(path, JSON.stringify({ version: 1, sessions: { 'group:1': 's-1' } }), 'utf8');
  const store = await open();
  assert.equal(store.personaEpochSeen(), 0);
  assert.equal(store.sessionFor('group:1'), 's-1');
}));

test('a missing state file reads as epoch zero', () => withStore(async ({ open }) => {
  const store = await open();
  assert.equal(store.personaEpochSeen(), 0);
}));

test('the recorded epoch survives a reload', () => withStore(async ({ open }) => {
  const first = await open();
  await first.setPersonaEpochSeen(4);
  assert.equal(first.personaEpochSeen(), 4);
  const second = await open();
  assert.equal(second.personaEpochSeen(), 4);
}));

test('a corrupt recorded epoch falls back to zero instead of throwing', () => withStore(async ({ path, open }) => {
  for (const value of ['7', -2, 2.5, null]) {
    await writeFile(path, JSON.stringify({ version: 1, sessions: {}, personaEpochSeen: value }), 'utf8');
    const store = await open();
    assert.equal(store.personaEpochSeen(), 0, JSON.stringify(value));
  }
}));

test('writing a non-integer epoch is rejected', () => withStore(async ({ path, open }) => {
  const store = await open();
  for (const value of [-1, 1.5, '3', null, undefined]) {
    await assert.rejects(() => store.setPersonaEpochSeen(value), TypeError);
  }
  // The rejected writes must leave the file untouched.
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.personaEpochSeen, undefined);
}));

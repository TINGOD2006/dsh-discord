import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_PERSONA_CHARS, PERSONA_ENDPOINTS } from '../src/channels/discord/persona-endpoints.mjs';
import { DiscordPersonaLibrary } from '../src/channels/discord/persona-library.mjs';
import { createPersonaRpcHandler } from '../plugin-src/host/persona-rpc.mjs';
import { createTokenBotRpcHandler } from '../plugin-src/host/channels/shared/rpc.mjs';

async function withHandler(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-persona-rpc-'));
  const library = new DiscordPersonaLibrary({ dshHome: home });
  try {
    return await fn(createPersonaRpcHandler(library), library);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const call = (handler, endpoint, payload = {}) => handler(endpoint, payload, undefined);

test('list returns the library snapshot', () => withHandler(async (handler, library) => {
  const created = library.create({ name: '甲', text: '一' });
  const result = await call(handler, PERSONA_ENDPOINTS.list);
  assert.equal(result.ok, true);
  assert.equal(result.value.activeId, null);
  assert.equal(result.value.epoch, 0);
  assert.deepEqual(result.value.items.map((item) => item.id), [created.id]);
  assert.deepEqual(Object.keys(result.value.items[0]).sort(), ['chars', 'id', 'name', 'updatedAt']);
}));

test('get without an id keeps the old single-persona shape', () => withHandler(async (handler, library) => {
  const result = await call(handler, PERSONA_ENDPOINTS.get);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), ['customized', 'defaultText', 'empty', 'text']);
  assert.equal(result.value.empty, true);
  assert.equal(result.value.customized, false);
  const created = library.create({ name: '乙', text: '说话慢一点' });
  library.activate(created.id);
  const active = await call(handler, PERSONA_ENDPOINTS.get);
  assert.equal(active.value.text, '说话慢一点');
  assert.equal(active.value.customized, true);
  assert.equal(active.value.empty, false);
}));

test('get with an id reads one persona', () => withHandler(async (handler, library) => {
  const created = library.create({ name: '丙', text: '正文' });
  const found = await call(handler, PERSONA_ENDPOINTS.get, { id: created.id });
  assert.deepEqual(found.value, { id: created.id, name: '丙', text: '正文' });
  const missing = await call(handler, PERSONA_ENDPOINTS.get, { id: 'p_ffffff' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'persona-not-found');
}));

test('create validates name and size, and reports the limit', () => withHandler(async (handler, library) => {
  const made = await call(handler, PERSONA_ENDPOINTS.create, { name: '丁', text: 'x' });
  assert.equal(made.ok, true);
  assert.match(made.value.id, /^p_[a-z0-9]{6,12}$/u);
  const unnamed = await call(handler, PERSONA_ENDPOINTS.create, { text: 'x' });
  assert.equal(unnamed.error.code, 'persona-invalid');
  const big = await call(handler, PERSONA_ENDPOINTS.create, { name: '戊', text: 'a'.repeat(MAX_PERSONA_CHARS + 1) });
  assert.equal(big.error.code, 'persona-invalid');
}));

test('save writes name and text, and rejects an unknown persona', () => withHandler(async (handler, library) => {
  const created = library.create({ name: '己', text: '旧' });
  const saved = await call(handler, PERSONA_ENDPOINTS.save, { id: created.id, name: '己2', text: '新' });
  assert.equal(saved.ok, true);
  assert.deepEqual(library.read(created.id).text, '新');
  assert.equal(library.read(created.id).name, '己2');
  const missing = await call(handler, PERSONA_ENDPOINTS.save, { id: 'p_ffffff', text: 'x' });
  assert.equal(missing.error.code, 'persona-not-found');
  const noText = await call(handler, PERSONA_ENDPOINTS.save, { id: created.id, name: 'x' });
  assert.equal(noText.error.code, 'persona-invalid');
}));

test('delete refuses the active persona and removes the others', () => withHandler(async (handler, library) => {
  const a = library.create({ name: 'A', text: 'a' });
  const b = library.create({ name: 'B', text: 'b' });
  library.activate(a.id);
  const refused = await call(handler, PERSONA_ENDPOINTS.delete, { id: a.id });
  assert.equal(refused.error.code, 'persona-active-undeletable');
  const removed = await call(handler, PERSONA_ENDPOINTS.delete, { id: b.id });
  assert.equal(removed.ok, true);
  assert.deepEqual(library.snapshot().items.map((item) => item.id), [a.id]);
}));

test('activate bumps the epoch', () => withHandler(async (handler, library) => {
  const created = library.create({ name: 'G', text: 'g' });
  const first = await call(handler, PERSONA_ENDPOINTS.activate, { id: created.id });
  assert.deepEqual(first.value, { ok: true, epoch: 1, handoff: 'deferred' });
  const second = await call(handler, PERSONA_ENDPOINTS.activate, { id: created.id });
  assert.equal(second.value.epoch, 2);
  const missing = await call(handler, PERSONA_ENDPOINTS.activate, { id: 'p_ffffff' });
  assert.equal(missing.error.code, 'persona-not-found');
}));

test('the legacy set endpoint writes the active persona', () => withHandler(async (handler, library) => {
  // Activating needs content; the legacy `set` endpoint is what fills or clears
  // it afterwards, which is exactly what this test asserts.
  const created = library.create({ name: 'H', text: '种子人格' });
  library.activate(created.id);
  const saved = await call(handler, PERSONA_ENDPOINTS.set, { text: '旧客户端写入' });
  assert.equal(saved.ok, true);
  assert.equal(library.activeText(), '旧客户端写入');
  const reset = await call(handler, PERSONA_ENDPOINTS.set, { reset: true });
  assert.equal(reset.ok, true);
  assert.equal(library.activeText(), '');
}));

test('a malformed payload is rejected before touching the library', () => withHandler(async (handler) => {
  for (const payload of [null, [], 'x', 3]) {
    const result = await handler(PERSONA_ENDPOINTS.list, payload, undefined);
    assert.equal(result.error.code, 'persona-invalid', JSON.stringify(payload));
  }
  const extra = await call(handler, PERSONA_ENDPOINTS.list, { id: 'p_ffffff' });
  assert.equal(extra.error.code, 'persona-invalid');
  const unknown = await call(handler, 'settings.discord-persona.nope');
  assert.equal(unknown.error.code, 'persona-invalid');
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await handler(PERSONA_ENDPOINTS.list, {}, aborted.signal);
  assert.equal(cancelled.error.code, 'persona-invalid');
}));

test('the bot-scoped rpc surface delegates every persona endpoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-persona-rpc-bot-'));
  try {
    const library = new DiscordPersonaLibrary({ dshHome: home });
    const controller = {
      status: async () => ({}),
      bindCredentials: async () => ({}),
      reconnectBot: async () => ({}),
      deleteBot: async () => ({}),
    };
    const handler = createTokenBotRpcHandler(controller, { channel: 'Discord', persona: library });
    const listed = await handler(PERSONA_ENDPOINTS.list, {}, undefined);
    assert.equal(listed.ok, true);
    assert.equal(listed.value.activeId, null);
    const created = await handler(PERSONA_ENDPOINTS.create, { name: 'bot' }, undefined);
    assert.equal(created.ok, true);
    const missing = await handler(PERSONA_ENDPOINTS.get, { id: 'p_ffffff' }, undefined);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'persona-not-found');
    const noPersona = createTokenBotRpcHandler(controller, { channel: 'Discord' });
    const unavailable = await noPersona(PERSONA_ENDPOINTS.list, {}, undefined);
    assert.equal(unavailable.error.code, 'bad-request');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

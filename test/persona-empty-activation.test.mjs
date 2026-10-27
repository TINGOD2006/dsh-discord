import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PERSONA_ENDPOINTS } from '../src/channels/discord/persona-endpoints.mjs';
import { DiscordPersonaLibrary } from '../src/channels/discord/persona-library.mjs';
import { createPersonaRpcHandler } from '../plugin-src/host/persona-rpc.mjs';

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-persona-empty-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('a blank persona cannot be activated', () => withHome(async (home) => {
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const blank = library.create({ name: '空白', text: '' });
  assert.throws(() => library.activate(blank.id), (error) => error.code === 'persona-empty');
  assert.equal(library.snapshot().activeId, null);
}));

test('the refusal leaves an already active persona in place', () => withHome(async (home) => {
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const good = library.create({ name: 'A', text: '温和一点' });
  const blank = library.create({ name: '空白', text: '' });
  library.activate(good.id);
  const before = library.snapshot();
  assert.throws(() => library.activate(blank.id), (error) => error.code === 'persona-empty');
  assert.deepEqual(library.snapshot(), before);
}));

test('the rpc answers with a readable message instead of a generic failure', () => withHome(async (home) => {
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const handler = createPersonaRpcHandler(library);
  const created = await handler(PERSONA_ENDPOINTS.create, { name: '空白', text: '' }, undefined);
  assert.equal(created.ok, true);
  const activated = await handler(PERSONA_ENDPOINTS.activate, { id: created.value.id }, undefined);
  assert.equal(activated.ok, false);
  assert.equal(activated.error.code, 'persona-empty');
  assert.match(activated.error.message, /内容/u);
}));

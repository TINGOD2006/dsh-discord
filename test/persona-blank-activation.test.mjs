import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PERSONA_ENDPOINTS } from '../src/channels/discord/persona-endpoints.mjs';
import { DiscordPersonaLibrary } from '../src/channels/discord/persona-library.mjs';
import { createPersonaRpcHandler } from '../plugin-src/host/persona-rpc.mjs';

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-persona-blank-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('a blank persona can be activated on purpose', () => withHome(async (home) => {
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const good = library.create({ name: 'A', text: '温柔一点' });
  library.activate(good.id);
  const blank = library.create({ name: '空白', text: '' });
  const next = library.activate(blank.id);
  assert.equal(next.activeId, blank.id);
  // "No persona" is the state itself: nothing is injected until a body is written.
  assert.equal(library.activeText(), '');
}));

test('the snapshot lets the card label a blank persona without reading it', () => withHome(async (home) => {
  const library = new DiscordPersonaLibrary({ dshHome: home });
  library.create({ name: '空白', text: '' });
  const [item] = library.snapshot().items;
  assert.equal(item.chars, 0);
}));

test('the rpc reports a blank activation as success', () => withHome(async (home) => {
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const handler = createPersonaRpcHandler(library);
  const created = await handler(PERSONA_ENDPOINTS.create, { name: '空白', text: '' }, undefined);
  const activated = await handler(PERSONA_ENDPOINTS.activate, { id: created.value.id }, undefined);
  assert.equal(activated.ok, true);
  assert.equal(activated.value.handoff, 'deferred');
}));

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyPersonaEpoch } from '../src/channels/discord/persona-epoch.mjs';
import { DiscordPersonaLinks, linksFilePath } from '../src/channels/discord/persona-links.mjs';

function fakeState(initial = {}) {
  const sessions = { ...initial.sessions };
  let seen = initial.seen ?? 0;
  return {
    sessionFor: (key) => sessions[key] ?? null,
    setSession: async (key, id) => { sessions[key] = id; },
    clearSession: async (key) => { delete sessions[key]; },
    personaEpochSeen: () => seen,
    setPersonaEpochSeen: async (value) => { seen = value; },
    sessions,
    get seen() { return seen; },
  };
}

async function linksStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-links-'));
  return { home, links: new DiscordPersonaLinks({ dshHome: home }) };
}

test('a first switch clears the binding and records a handoff job', async () => {
  const { links } = await linksStore();
  const state = fakeState({ sessions: { k: 'session-old' } });
  const handoffs = [];
  const result = await applyPersonaEpoch({
    epoch: 5, activeId: 'p_new', state, key: 'k', links,
    handoff: async (job) => { handoffs.push(job); },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.changed, true);
  assert.equal(result.rebound, false);
  assert.equal(result.oldSessionId, 'session-old');
  assert.equal(state.sessionFor('k'), null);
  assert.equal(state.seen, 5);
  assert.deepEqual(handoffs, [{ key: 'k', oldSessionId: 'session-old' }]);
});

test('switching back re-binds the persona\'s earlier Session instead of opening a third', async () => {
  const { links } = await linksStore();
  const state = fakeState({ sessions: { k: 'session-deepseek' }, seen: 4 });
  links.bind({ key: 'k', activeId: 'p_deepseek', sessionId: 'session-deepseek' });

  // away to the blank persona, then back
  await applyPersonaEpoch({ epoch: 5, activeId: 'p_blank', state, key: 'k', links });
  assert.equal(state.sessionFor('k'), null);

  const handoffs = [];
  const back = await applyPersonaEpoch({
    epoch: 6, activeId: 'p_deepseek', state, key: 'k', links,
    handoff: async (job) => { handoffs.push(job); },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(back.rebound, true);
  assert.equal(back.reboundSessionId, 'session-deepseek');
  assert.equal(state.sessionFor('k'), 'session-deepseek');
  assert.equal(state.seen, 6);
  assert.deepEqual(handoffs, [], 'a re-bind inherits its own history, so no summary is needed');
});

test('a persona that never ran here still opens a fresh Session', async () => {
  const { links } = await linksStore();
  const state = fakeState({ sessions: { k: 'session-a' }, seen: 7 });
  links.bind({ key: 'k', activeId: 'p_a', sessionId: 'session-a' });

  const result = await applyPersonaEpoch({ epoch: 8, activeId: 'p_never', state, key: 'k', links });
  assert.equal(result.rebound, false);
  assert.equal(state.sessionFor('k'), null);
  assert.equal(state.seen, 8);
});

test('an unchanged epoch is a no-op and writes nothing', async () => {
  const { links } = await linksStore();
  const state = fakeState({ sessions: { k: 'session-a' }, seen: 9 });
  const result = await applyPersonaEpoch({ epoch: 9, activeId: 'p_a', state, key: 'k', links });
  assert.equal(result.changed, false);
  assert.equal(result.rebound, false);
  assert.equal(state.sessionFor('k'), 'session-a');
});

test('links round-trip through disk and survive a BOM', async () => {
  const { home, links } = await linksStore();
  links.bind({ key: 'group:1', activeId: 'p_a', sessionId: 'session-a' });
  assert.deepEqual(links.bindingFor('group:1'), { activeId: 'p_a', sessionId: 'session-a' });
  assert.equal(links.candidateFor('p_a', 'group:1'), 'session-a');
  assert.equal(links.candidateFor('p_b', 'group:1'), null);

  links.unbind('group:1');
  assert.equal(links.bindingFor('group:1'), null);
  assert.equal(links.candidateFor('p_a', 'group:1'), 'session-a', 'history survives unbind');

  await mkdir(join(home, 'integrations', 'dsh-discord', 'personas'), { recursive: true });
  await writeFile(linksFilePath({ dshHome: home }), '\uFEFF{"bindings":{"x":{"activeId":"p_x","sessionId":"session-x"}},"index":{}}', 'utf8');
  assert.deepEqual(links.bindingFor('x'), { activeId: 'p_x', sessionId: 'session-x' });
});

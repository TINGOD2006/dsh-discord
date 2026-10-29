import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordPersonaLinks, linksFilePath } from '../src/channels/discord/persona-links.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-links-'));
  const links = new DiscordPersonaLinks({ dshHome: home });
  return { home, links, path: linksFilePath({ dshHome: home }) };
}

test('a binding is visible through the cache after a write', () => {
  const { links } = fixture();
  links.bind({ key: 'group:1', activeId: 'p_aaa111', sessionId: 'session-1' });
  assert.deepEqual(links.bindingFor('group:1'), { activeId: 'p_aaa111', sessionId: 'session-1' });
  assert.equal(links.candidateFor('p_aaa111', 'group:1'), 'session-1');
});

test('a hand edit on disk is picked up without restarting', () => {
  const { links, path } = fixture();
  links.bind({ key: 'group:1', activeId: 'p_aaa111', sessionId: 'session-1' });
  assert.equal(links.candidateFor('p_aaa111', 'group:1'), 'session-1');
  // Simulate someone editing links.json by hand between two messages.
  writeFileSync(path, JSON.stringify({ bindings: {}, index: { p_aaa111: { 'group:1': 'session-2' } } }), 'utf8');
  assert.equal(links.candidateFor('p_aaa111', 'group:1'), 'session-2');
});

test('the cache never hands back state that was not written', () => {
  const { links } = fixture();
  links.bind({ key: 'group:1', activeId: 'p_aaa111', sessionId: 'session-1' });
  links.unbind('group:1');
  assert.equal(links.bindingFor('group:1'), null);
  // The history index survives an unbind, so switching back can still find it.
  assert.equal(links.candidateFor('p_aaa111', 'group:1'), 'session-1');
});

test('cleanup', () => {
  const { home } = fixture();
  rmSync(home, { recursive: true, force: true });
});

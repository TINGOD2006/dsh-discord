import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordAllowlistStore } from '../src/channels/discord/allowlist.mjs';
import { DiscordPersonaLibrary } from '../src/channels/discord/persona-library.mjs';
import { requestRecallApproval, takePendingRecall } from '../src/channels/shared/owner-commands.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

/*
 * Guards added after the persistence audit: each of these used to fail silently
 * and destructively (wiped persona list, bricked bot, truncated allowlist,
 * self-served recall approval).
 */

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-stability-'));
}

test('a persona index written with a UTF-8 BOM still lists its personas', () => {
  const home = tempHome();
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const { id } = library.create({ name: '甲', text: '正文' });
  const indexPath = join(home, 'integrations', 'dsh-discord', 'personas', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  writeFileSync(indexPath, `\uFEFF${JSON.stringify(index)}`, 'utf8');

  const snapshot = library.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].id, id);
  assert.equal(library.read(id).text, '正文');
});

test('an unreadable persona index refuses every write instead of wiping the library', () => {
  const home = tempHome();
  const library = new DiscordPersonaLibrary({ dshHome: home });
  const { id } = library.create({ name: '甲', text: '正文' });
  const personas = join(home, 'integrations', 'dsh-discord', 'personas');
  writeFileSync(join(personas, 'index.json'), '{ torn', 'utf8');

  // Reads stay tolerant so the settings card can still render.
  assert.deepEqual(library.snapshot().items, []);
  for (const mutate of [
    () => library.create({ name: '乙', text: '新' }),
    () => library.save({ id, text: '改' }),
    () => library.remove(id),
    () => library.activate(id),
  ]) {
    assert.throws(mutate, (error) => error?.code === 'persona-index-unreadable');
  }
  // The orphan bodies are still on disk, so a repaired index can recover them.
  assert.equal(existsSync(join(personas, `${id}.md`)), true);
});

test('a corrupt state file is quarantined and the bot still starts', async () => {
  const home = tempHome();
  const path = join(home, 'bots', 'bot-1', 'state.json');
  const store = new ConversationStateStore(path);
  await store.load();
  await store.setSession('group:1', 'session-1');

  writeFileSync(path, '{"sessions": {"group:1"', 'utf8');
  const restarted = new ConversationStateStore(path);
  await restarted.load();

  assert.equal(restarted.sessionFor('group:1'), null);
  const siblings = readdirSync(join(home, 'bots', 'bot-1'));
  assert.equal(siblings.some((name) => name.startsWith('state.json.corrupt-')), true);
  // The recovered store is usable again.
  await restarted.setSession('group:2', 'session-2');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).sessions['group:2'], 'session-2');
});

test('an allowlist save leaves no temp file and reads back what it wrote', () => {
  const home = tempHome();
  const store = new DiscordAllowlistStore({ dshHome: home });
  store.write(['837707455294078976']);
  const dir = join(home, 'integrations', 'dsh-discord');
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(store.list(), ['837707455294078976']);
});

test('a recall approval can only be confirmed by the sender who asked for it', () => {
  const conversation = 'group:stability-recall';
  requestRecallApproval(conversation, 200, 'sender-a');
  assert.equal(takePendingRecall(conversation, Date.now(), 'sender-b'), null);
  // The wrong sender did not consume it.
  const pending = takePendingRecall(conversation, Date.now(), 'sender-a');
  assert.equal(pending?.hours, 200);
  assert.equal(takePendingRecall(conversation, Date.now(), 'sender-a'), null);
});

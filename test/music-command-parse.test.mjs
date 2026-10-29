import test from 'node:test';
import assert from 'node:assert/strict';
import { isMusicCommand, parseMusicCommand, runMusicCommand } from '../src/channels/shared/music-commands.mjs';

// `/music play` was a duplicate of `/play`; the slash group no longer offers it.
test('parse keeps /play as the only entry point for song requests', () => {
  assert.deepEqual(parseMusicCommand('/play 晴天'), { name: 'play', argument: '晴天' });
  assert.deepEqual(parseMusicCommand('/music join'), { name: 'join', argument: '' });
  assert.deepEqual(parseMusicCommand('/music skip'), { name: 'next', argument: '' });
  assert.deepEqual(parseMusicCommand('/music volume 30'), { name: 'volume', argument: '30' });
  assert.deepEqual(parseMusicCommand('/music play 晴天'), { name: 'help', argument: 'play 晴天' });
  assert.equal(isMusicCommand('/music play x'), true);
  assert.equal(isMusicCommand('/playlist'), false);
});

test('the retired alias answers with a pointer instead of the help wall', async () => {
  const calls = [];
  const music = { execute: async (name, args) => { calls.push([name, args]); return { message: 'ok' }; } };
  const alias = await runMusicCommand('/music play 晴天', null, null, null, { conversationId: 'c1', music });
  assert.match(alias.message, /\/play/);
  assert.equal(calls.length, 0, 'the alias must not reach the player');

  const join = await runMusicCommand('/music join', null, null, null, { conversationId: 'c1', music });
  assert.equal(join.message, 'ok');
  assert.equal(calls[0][0], 'join');
});

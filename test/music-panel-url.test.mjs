import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPanel } from '../src/channels/discord/music-panel.mjs';

const playing = (url) => ({
  state: 'playing', title: '晴天', url, positionMs: 1000, durationMs: 269000,
  loop: 'off', volume: 60, queue: [], requester: '<@1>', channelId: 'c',
});

test('a http(s) source URL becomes the embed link', () => {
  const { embeds } = renderPanel(playing('https://soundcloud.com/x/y'), { guildId: 'g' });
  assert.equal(embeds[0].url, 'https://soundcloud.com/x/y');
});

test('a local path or bare query never reaches embed.url', () => {
  for (const url of ['C:\\Music\\老人與海.wav', '/srv/audio/a.flac', '晴天', '', null, undefined]) {
    const { embeds } = renderPanel(playing(url), { guildId: 'g' });
    assert.equal(embeds[0].url, undefined, `rejected: ${String(url)}`);
  }
});

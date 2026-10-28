import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPanel } from '../src/channels/discord/music-panel.mjs';

const playing = {
  state: 'playing', title: '晴天', url: null, positionMs: 1000, durationMs: 269000,
  loop: 'off', volume: 60, queue: [], requester: '<@1>', channelId: 'c',
};

test('button emoji is a partial-emoji object, not a bare string', () => {
  const { components } = renderPanel(playing, { guildId: 'g' });
  const buttons = components.flatMap((row) => row.components);
  assert.ok(buttons.length > 0);
  for (const item of buttons) {
    if (item.emoji === undefined) continue;
    // Discord rejects a string here with MODEL_TYPE_CONVERT "Expected an object/dictionary".
    assert.equal(typeof item.emoji, 'object', `emoji of ${item.label} must be an object`);
    assert.equal(typeof item.emoji.name, 'string');
    assert.ok(item.emoji.name.length > 0);
  }
});

test('every button keeps the wire fields Discord requires', () => {
  const { components } = renderPanel(playing, { guildId: 'g' });
  for (const row of components) {
    assert.equal(row.type, 1, 'action row');
    for (const item of row.components) {
      assert.equal(item.type, 2, 'button');
      if (item.style === 5) {
        assert.match(item.url, /^https?:\/\//u);
      } else {
        assert.match(item.custom_id, /^music:[a-z]+:/u);
        assert.ok(Number.isInteger(item.style));
      }
    }
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PANEL_ACTIONS, PANEL_BAR_WIDTH, clampSeekTarget, formatClock, panelCustomId,
  parsePanelCustomId, progressBar, renderPanel, seekIsMeaningful,
} from '../src/channels/discord/music-panel.mjs';
import { MusicManager, positionMsFor } from '../src/channels/discord/music.mjs';

test('formatClock pads and grows to hours', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65_000), '1:05');
  assert.equal(formatClock(3_725_000), '1:02:05');
  assert.equal(formatClock(-500), '0:00');
});

test('progressBar keeps its width and fills by ratio', () => {
  const fresh = progressBar(0, 200_000);
  assert.equal([...fresh].length, PANEL_BAR_WIDTH);
  assert.equal(fresh, '░'.repeat(PANEL_BAR_WIDTH));
  const half = progressBar(100_000, 200_000);
  assert.equal(half, '█'.repeat(8) + '░'.repeat(8));
  const done = progressBar(200_000, 200_000);
  assert.equal(done, '█'.repeat(PANEL_BAR_WIDTH));
  assert.equal(progressBar(0, 0), '░'.repeat(PANEL_BAR_WIDTH));
  // Guards the seconds/milliseconds mix-up that painted "10:55:20" for 20s of audio.
  assert.equal(positionMsFor(0, 20_000), 20_000);
  assert.equal(positionMsFor(30, 5_000), 35_000);
});

test('clampSeekTarget never lands past the end', () => {
  assert.equal(clampSeekTarget(5000, 200_000), 5000);
  assert.equal(clampSeekTarget(199_000, 200_000), 198_000);
  assert.equal(clampSeekTarget(-10, 200_000), 0);
  assert.equal(clampSeekTarget(5000, 0), 5000);
  assert.equal(clampSeekTarget(1000, 1000), 0);
});

test('seekIsMeaningful ignores sub-second slider noise', () => {
  assert.equal(seekIsMeaningful(1000, 2000), false);
  assert.equal(seekIsMeaningful(3000, 1000), true);
});

test('panelCustomId round-trips and rejects junk', () => {
  assert.equal(panelCustomId('pause', '42'), 'music:pause:42');
  assert.deepEqual(parsePanelCustomId('music:seek:42'), null, 'seek is not a card button');
  assert.deepEqual(parsePanelCustomId('music:next:42'), { action: 'next', guildId: '42' });
  assert.deepEqual(parsePanelCustomId('music:next:'), null);
  assert.deepEqual(parsePanelCustomId('nope:next:1'), null);
  assert.deepEqual(parsePanelCustomId(''), null);
  assert.throws(() => panelCustomId('bogus', '1'), TypeError);
  assert.ok(PANEL_ACTIONS.includes('remove'));
});

test('renderPanel shows the idle state with a disabled transport row', () => {
  const { embeds, components } = renderPanel({ state: 'idle' }, { guildId: '42' });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].description, /目前沒有播放/);
  const row = components[0].components;
  assert.equal(row.length, 5);
  assert.ok(row[0].disabled && row[1].disabled);
  assert.equal(row[2].custom_id, 'music:queue:42');
});

test('renderPanel renders the playing card and the console link', () => {
  const { embeds, components } = renderPanel({
    state: 'playing', title: '老人與海', positionMs: 60_000, durationMs: 180_000, volume: 60, queue: ['a', 'b'],
    requester: '<@1>',
  }, { guildId: '42', controlUrl: 'http://127.0.0.1:1234/music/tok/' });
  assert.equal(embeds[0].title, '🎵 老人與海');
  assert.match(embeds[0].description, /1:00 \/ 3:00/);
  assert.match(embeds[0].description, /佇列：2 首/);
  assert.equal(components.length, 2);
  assert.equal(components[1].components[0].url, 'http://127.0.0.1:1234/music/tok/');
  assert.equal(components[1].components[0].style, 5);
  assert.equal(components[0].components[0].custom_id, 'music:pause:42');
});

test('renderPanel offers resume while paused', () => {
  const { components } = renderPanel({ state: 'paused', title: 'x', durationMs: 1000, positionMs: 500 }, { guildId: '7' });
  assert.equal(components[0].components[0].label, '繼續');
  assert.equal(components[0].components[0].custom_id, 'music:resume:7');
});

test('MusicManager.snapshot reports idle for an unknown guild', () => {
  const manager = new MusicManager({ token: 'test-token' });
  const snapshot = manager.snapshot('999');
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.positionMs, 0);
  assert.deepEqual(snapshot.queue, []);
});

test('MusicManager.control refuses every action without a room', async () => {
  const manager = new MusicManager({ token: 'test-token' });
  assert.deepEqual(await manager.control('999', 'pause'), { ok: false, message: '目前沒有播放中的歌曲' });
  assert.deepEqual(await manager.control('999', 'next'), { ok: false, message: '目前沒有播放中的歌曲' });
  assert.equal((await manager.control('999', 'seek', { positionMs: 1000 })).ok, false);
});

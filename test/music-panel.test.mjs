import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PANEL_ACTIONS, PANEL_BAR_WIDTH, clampSeekTarget, formatClock, panelCustomId,
  parsePanelCustomId, progressBar, renderPanel, seekIsMeaningful,
} from '../src/channels/discord/music-panel.mjs';
import { MusicManager, positionFromFrames, positionMsFor } from '../src/channels/discord/music.mjs';

test('formatClock pads and grows to hours', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65_000), '1:05');
  assert.equal(formatClock(3_725_000), '1:02:05');
  assert.equal(formatClock(-500), '0:00');
  // The card asks for padded minutes so the bar does not shift every minute.
  assert.equal(formatClock(65_000, { padMinutes: true }), '01:05');
  assert.equal(formatClock(3_725_000, { padMinutes: true }), '1:02:05');
});

test('progressBar keeps its width and moves the knob with the position', () => {
  const fresh = progressBar(0, 200_000);
  assert.equal([...fresh].length, PANEL_BAR_WIDTH);
  assert.equal(fresh, '●' + '─'.repeat(PANEL_BAR_WIDTH - 1));
  // Half of 15 travelled cells is 8 (7.5 rounded up), so the knob sits at 8.
  const half = progressBar(100_000, 200_000);
  assert.equal(half, '━'.repeat(8) + '●' + '─'.repeat(7));
  const done = progressBar(200_000, 200_000);
  assert.equal(done, '━'.repeat(PANEL_BAR_WIDTH - 1) + '●');
  // A stream has no end: no ratio, so nothing is painted as played.
  assert.equal(progressBar(0, 0), '─'.repeat(PANEL_BAR_WIDTH));
  // Guards the seconds/milliseconds mix-up that painted "10:55:20" for 20s of audio.
  assert.equal(positionMsFor(0, 20_000), 20_000);
  assert.equal(positionMsFor(30, 5_000), 35_000);
  // The card follows the transport's frame counter, not a frozen playbackDuration.
  assert.equal(positionFromFrames(0, 50), 1_000);
  assert.equal(positionFromFrames(30, 50), 31_000);
  assert.equal(positionFromFrames(undefined, undefined), 0);
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
  // A link button carries a url, never a custom_id, so it is not routed.
  assert.throws(() => panelCustomId('link', '1'), TypeError);
  assert.deepEqual(parsePanelCustomId('music:link:42'), null);
  assert.ok(PANEL_ACTIONS.includes('remove'));
  assert.ok(PANEL_ACTIONS.includes('prev'));
  assert.ok(PANEL_ACTIONS.includes('loop'));
});

test('renderPanel shows the idle state with a disabled transport row', () => {
  const { embeds, components } = renderPanel({ state: 'idle' }, { guildId: '42' });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].description, /目前沒有播放/);
  const transport = components[0].components;
  assert.equal(transport.length, 5);
  assert.equal(transport[0].custom_id, 'music:loop:42');
  assert.ok(transport[0].disabled, 'loop stays visible but inert while idle');
  assert.ok(transport[1].disabled && transport[2].disabled && transport[3].disabled);
  assert.equal(transport[4].custom_id, 'music:queue:42');
});

test('renderPanel renders the playing card without a console link', () => {
  const { embeds, components } = renderPanel({
    state: 'playing', title: '老人與海', url: 'https://www.youtube.com/watch?v=abc12345678',
    positionMs: 60_000, durationMs: 180_000, volume: 60, queue: ['a', 'b'], kind: 'youtube',
    loop: 'off', requester: 'TINGOD·3761', canPrev: true,
  }, { guildId: '42', controlUrl: 'http://127.0.0.1:1234/music/tok/', botName: 'Deepseekv4.1' });
  assert.equal(embeds[0].title, '老人與海', 'the title is the song, not a prefix');
  assert.equal(embeds[0].url, 'https://www.youtube.com/watch?v=abc12345678');
  assert.equal(embeds[0].description.split('\n')[0], '來自 youtube.com');
  assert.match(embeds[0].description, /循環：關閉 · 音源：YouTube/);
  assert.match(embeds[0].description, /佇列：2 首/);
  assert.doesNotMatch(embeds[0].description, /音量/, 'volume is not shown');
  // The clocks sit on the bar's own line so the knob reads against them.
  assert.match(embeds[0].description, /`01:00` [━●─]+ `03:00`/u);
  assert.equal(embeds[0].footer.text, 'Deepseekv4.1 · 由 TINGOD·3761 點播');
  assert.equal(embeds[0].thumbnail.url, 'https://i.ytimg.com/vi/abc12345678/hqdefault.jpg');
  assert.equal(components.length, 2, 'transport row plus the tool row');
  assert.equal(components[0].components[0].custom_id, 'music:loop:42');
  assert.equal(components[0].components[1].custom_id, 'music:prev:42');
  assert.equal(components[1].components[2].style, 5, 'the console link is a real button again');
  assert.equal(components[1].components[2].url, 'http://127.0.0.1:1234/music/tok/');
});

test('renderPanel disables 上一首 until something has actually played', () => {
  const card = (canPrev) => renderPanel({ state: 'playing', title: 'x', durationMs: 1000, positionMs: 0, canPrev }, { guildId: '42' });
  assert.equal(card(false).components[0].components[1].disabled, true);
  assert.equal(card(true).components[0].components[1].disabled, false);
});

test('renderPanel drops a thumbnail that is not https', () => {
  const unsafe = renderPanel({ state: 'playing', title: 'x', durationMs: 1000, positionMs: 0, thumbnail: 'javascript:alert(1)' }, { guildId: '42' });
  assert.equal(unsafe.embeds[0].thumbnail, undefined);
  const own = renderPanel({ state: 'playing', title: 'x', durationMs: 1000, positionMs: 0, thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' }, { guildId: '42' });
  assert.equal(own.embeds[0].thumbnail.url, 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
});

test('renderPanel marks a streamed track as not normalized', () => {
  const { embeds } = renderPanel({ state: 'playing', title: 'long mix', durationMs: 7_200_000, positionMs: 0, stream: true }, { guildId: '42' });
  assert.match(embeds[0].description, /串流（未正規化）/);
  assert.match(embeds[0].description, /`00:00`/);
  assert.match(embeds[0].description, /`2:00:00`/);
  const plain = renderPanel({ state: 'playing', title: 'x', durationMs: 1000, positionMs: 0 }, { guildId: '42' });
  assert.doesNotMatch(plain.embeds[0].description, /串流/);
});

test('renderPanel offers resume while paused', () => {
  const { components } = renderPanel({ state: 'paused', title: 'x', durationMs: 1000, positionMs: 500 }, { guildId: '7' });
  assert.equal(components[0].components[2].label, '繼續');
  assert.equal(components[0].components[2].custom_id, 'music:resume:7');
});

test('renderPanel names the loop state the player actually holds', () => {
  const labels = (loop) => renderPanel({ state: 'playing', title: 'x', durationMs: 1000, positionMs: 0, loop }, { guildId: '7' })
    .components[0].components[0];
  assert.equal(labels('off').label, '循環：關閉');
  assert.equal(labels('single').label, '循環：單曲');
  assert.equal(labels('all').label, '循環：全部');
  assert.equal(labels('bogus').label, '循環：關閉', 'an unknown mode reads as off');
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

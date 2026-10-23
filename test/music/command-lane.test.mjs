import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicCommandLane } from '../../src/channels/discord/music-command-lane.mjs';

test('player lanes preserve FIFO, survive failures and allow other guilds to run', async () => {
  const lane = new MusicCommandLane(), order = []; let release;
  const first = lane.run('guild', 'play', async () => { order.push('first'); await new Promise(resolve => { release = resolve; }); throw new Error('fixture failure'); });
  const failed = assert.rejects(first, /fixture failure/);
  const second = lane.run('guild', 'volume', async () => { order.push('second'); });
  await lane.run('other-guild', 'play', async () => { order.push('other'); });
  assert.deepEqual(order, ['first', 'other']); release(); await failed; await second;
  assert.deepEqual(order, ['first', 'other', 'second']); lane.destroy();
});

test('stop is a cancellation barrier for earlier work, while later play still runs', async () => {
  const lane = new MusicCommandLane(), order = []; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = lane.run('guild', 'play', async signal => { order.push('old'); started(); await new Promise(() => {}); signal.throwIfAborted(); });
  const cancelled = assert.rejects(first, { name: 'AbortError' }); await ready;
  const pending = lane.run('guild', 'play', async () => { order.push('must-not-run'); });
  const pendingCancelled = assert.rejects(pending, { name: 'AbortError' });
  const stop = lane.run('guild', 'stop', async () => { order.push('stop'); });
  const fresh = lane.run('guild', 'play', async () => { order.push('new'); });
  await Promise.all([cancelled, pendingCancelled, stop, fresh]);
  assert.deepEqual(order, ['old', 'stop', 'new']); lane.destroy();
});

test('shutdown cancels running and waiting commands and closes admission', async () => {
  const lane = new MusicCommandLane(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = lane.run('guild', 'play', async () => { started(); await new Promise(() => {}); });
  const cancelled = assert.rejects(first, { name: 'AbortError' }); await ready;
  const pending = lane.run('guild', 'join', () => assert.fail('stale queued command ran'));
  const pendingCancelled = assert.rejects(pending, { name: 'AbortError' }); lane.destroy();
  await Promise.all([cancelled, pendingCancelled]);
  await assert.rejects(lane.run('guild', 'play', () => assert.fail('closed admission ran')), { name: 'AbortError' });
});

test('a slow permission lookup keeps the barrier ahead of later commands', async () => {
  const lane = new MusicCommandLane(), order = []; let releaseAuth, started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = lane.run('guild', 'play', async () => { order.push('old'); started(); await new Promise(() => {}); });
  const cancelled = assert.rejects(first, { name: 'AbortError' }); await ready;
  const stop = lane.run('guild', 'stop', () => { order.push('stop'); }, undefined, () => new Promise(resolve => { releaseAuth = resolve; }));
  const fresh = lane.run('guild', 'play', () => { order.push('new'); });
  await Promise.resolve(); assert.deepEqual(order, ['old']); releaseAuth();
  await Promise.all([cancelled, stop, fresh]); assert.deepEqual(order, ['old', 'stop', 'new']); lane.destroy();
});

test('a denied barrier cannot cancel the active job or let a later job overlap it', async () => {
  const lane = new MusicCommandLane(), order = []; let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = lane.run('guild', 'play', async () => { order.push('first'); started(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  await assert.rejects(lane.run('guild', 'stop', () => assert.fail('denied stop ran'), undefined, () => { throw new Error('denied'); }), /denied/);
  const fresh = lane.run('guild', 'play', () => { order.push('second'); });
  await Promise.resolve(); assert.deepEqual(order, ['first']); release(); await Promise.all([first, fresh]);
  assert.deepEqual(order, ['first', 'second']); lane.destroy();
});

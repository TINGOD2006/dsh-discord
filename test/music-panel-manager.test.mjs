import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MusicPanelManager } from '../src/channels/discord/music-panel-manager.mjs';

class FakeApi {
  #next = 1;
  created = []; edits = []; failEdit = null;
  async createMessage({ channelId, ...body }) {
    const id = `m${this.#next++}`;
    this.created.push({ channelId, id, ...body });
    return { id };
  }
  async editMessage({ channelId, messageId, ...body }) {
    if (this.failEdit) { const error = this.failEdit; this.failEdit = null; throw error; }
    this.edits.push({ channelId, messageId, ...body });
    return { id: messageId };
  }
}

function registry(state = 'playing') {
  let current = state;
  return {
    get state() { return current; },
    set state(value) { current = value; },
    snapshot: () => ({
      state: current, title: '晴天', positionMs: 1000, durationMs: 200_000,
      volume: 60, loop: 'off', queue: ['下一首'], requester: '<@1>', channelId: 'chan-1',
    }),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('sync posts one card per guild and reuses it', async () => {
  const api = new FakeApi();
  const store = registry();
  const panel = new MusicPanelManager({ api, registry: store, intervalMs: 60_000, controlUrlFor: () => 'http://127.0.0.1:1234/music/t/' });
  try {
    await panel.sync('g1');
    assert.equal(api.created.length, 1);
    assert.equal(api.created[0].channelId, 'chan-1');
    assert.match(api.created[0].embeds[0].title, /晴天/);
    const messageId = panel.messageIdFor('g1');
    assert.equal(messageId, 'm1');
    await panel.sync('g1');
    assert.equal(api.created.length, 1, 'second sync edits instead of reposting');
    assert.equal(api.edits.at(-1).messageId, 'm1');
    assert.equal(api.edits.at(-1).components.length, 2, 'console link button rides along');
  } finally { await panel.destroy(); }
});

test('a deleted card is reposted on the next sync', async () => {
  const api = new FakeApi();
  const panel = new MusicPanelManager({ api, registry: registry(), intervalMs: 60_000 });
  try {
    await panel.sync('g1');
    api.failEdit = Object.assign(new Error('Unknown Message'), { status: 404 });
    await panel.sync('g1');
    assert.equal(panel.messageIdFor('g1'), null);
    await panel.sync('g1');
    assert.equal(api.created.length, 2);
  } finally { await panel.destroy(); }
});

test('stopping playback leaves an idle card and clears the timer', async () => {
  const api = new FakeApi();
  const store = registry();
  const panel = new MusicPanelManager({ api, registry: store, intervalMs: 60_000 });
  try {
    await panel.sync('g1');
    store.state = 'idle';
    await panel.sync('g1');
    assert.match(api.edits.at(-1).embeds[0].description, /目前沒有播放/);
    await settle();
    assert.equal(panel.size, 1);
  } finally { await panel.destroy(); }
});

test('remove leaves a tombstone without components', async () => {
  const api = new FakeApi();
  const panel = new MusicPanelManager({ api, registry: registry(), intervalMs: 60_000 });
  try {
    await panel.sync('g1');
    await panel.stop('g1', { remove: true });
    assert.equal(api.edits.at(-1).components.length, 0);
    assert.equal(panel.size, 0);
  } finally { await panel.destroy(); }
});

test('a snapshot failure never throws at the caller', async () => {
  const api = new FakeApi();
  const panel = new MusicPanelManager({ api, registry: { snapshot: () => { throw new Error('boom'); } }, intervalMs: 60_000 });
  try {
    assert.equal(await panel.sync('g1'), null);
    assert.equal(api.created.length, 0);
  } finally { await panel.destroy(); }
});

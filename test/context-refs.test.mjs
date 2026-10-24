import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupHistoryStore } from '../src/channels/shared/group-history-store.mjs';
import { filterHistoryRows } from '../src/channels/shared/history-context.mjs';
import { historyEntriesFrom, renderHistoryBlock } from '../src/channels/discord/discord-runtime.mjs';

const silent = { info() {}, warn() {}, error() {} };

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-refs-'));
  const store = new GroupHistoryStore(dir, { logger: silent });
  try {
    await run(store);
  } finally {
    await store.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

test('every archived row gets a stable number, widened only when two messages share a tail', async () => {
  await withStore(async (store) => {
    const now = Date.now();
    const base = { channel: 'discord', groupId: 'g1', groupName: 'G', senderId: 'u1', senderName: 'Awei' };
    await store.capture({ ...base, messageId: '100000000000abcd', sentAt: now - 3000, text: 'first' });
    await store.capture({ ...base, messageId: '200000000000abcd', sentAt: now - 2000, text: 'second' });
    await store.capture({ ...base, messageId: '300000000000aaaa', sentAt: now - 1000, text: 'third' });
    await store.ready();
    const groupId = await store.findGroupId('g1');
    const recent = await store.recentMessages(groupId, { since: now - 60_000, limit: 10 });
    const refs = recent.items.map((item) => item.ref);
    assert.equal(refs.length, 3);
    assert.equal(new Set(refs).size, 3, `refs must stay unique: ${refs.join(',')}`);
    assert(refs.includes('abcd'));
    const widened = refs.find((ref) => ref !== 'abcd' && ref.endsWith('abcd'));
    assert(widened, 'the second message sharing a four-character tail widens instead of colliding');
  });
});

test('a number resolves to its row and to the rows around it', async () => {
  await withStore(async (store) => {
    const now = Date.now();
    const base = { channel: 'discord', groupId: 'g2', groupName: 'G', senderId: 'u1', senderName: 'Awei' };
    await store.capture({ ...base, messageId: '11111111aaaa', sentAt: now - 4000, text: 'one' });
    await store.capture({ ...base, senderId: 'u2', messageId: '22222222bbbb', sentAt: now - 3000, text: 'two', replyToMessageId: '11111111aaaa' });
    await store.capture({ ...base, messageId: '33333333cccc', sentAt: now - 2000, text: 'three' });
    await store.ready();
    const groupId = await store.findGroupId('g2');
    const hit = await store.findByRef(groupId, '#mbbbb');
    assert.equal(hit.messageId, '22222222bbbb');
    assert.equal(hit.replyToMessageId, '11111111aaaa');
    const window = await store.windowAroundRef(groupId, 'bbbb', { before: 1, after: 1 });
    assert.deepEqual(window.items.map((item) => item.text), ['one', 'two', 'three']);
    assert.equal(window.anchor.ref, 'bbbb');
    assert.equal(await store.findByRef(groupId, 'zzzz'), null);
  });
});

test('the replay prints the number and points replies at it', async () => {
  const items = [
    { messageId: '2', ref: 'bbbb', senderId: 'u2', senderName: 'Bob', sentAt: 2000, text: 'reply', replyToMessageId: '1', replySenderName: 'Awei', replyText: 'question' },
    { messageId: '1', ref: 'aaaa', senderId: 'u1', senderName: 'Awei', sentAt: 1000, text: 'question' },
  ];
  const text = renderHistoryBlock(historyEntriesFrom(items, { limit: 5, maxChars: 500 }));
  assert.match(text, /\[h1 #maaaa\]/u);
  assert.match(text, /\[h2 #mbbbb\]/u);
  assert.match(text, /→ 回复 #maaaa/u);
});

test('punctuation-only variants of the same shout count as one repeat', () => {
  const rows = [
    { messageId: '2', senderId: 'u1', text: '哈哈！！', sentAt: 2000 },
    { messageId: '1', senderId: 'u1', text: '哈 哈', sentAt: 1000 },
  ];
  assert.deepEqual(filterHistoryRows(rows).map((row) => row.messageId), ['2']);
});

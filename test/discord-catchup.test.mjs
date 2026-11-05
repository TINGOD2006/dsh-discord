import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catchUpEntry, parseConversationKey, selectCatchUpMessages } from '../src/channels/discord/catchup.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const id = (n) => String(100000000000000000n + BigInt(n));

test('parseConversationKey reads group and direct keys', () => {
  assert.deepEqual(parseConversationKey('group:1562556899214499910'), {
    kind: 'group', channelId: '1562556899214499910',
  });
  assert.deepEqual(parseConversationKey('direct:627504520112373761'), {
    kind: 'direct', channelId: '627504520112373761',
  });
  assert.equal(parseConversationKey('group:abc'), null);
  assert.equal(parseConversationKey(''), null);
  assert.equal(parseConversationKey(undefined), null);
});

test('selectCatchUpMessages drops bots, empties and stale messages, oldest first', () => {
  const messages = [
    { id: id(3), content: 'third', timestamp: '2026-11-05T11:00:00.000Z', author: { id: 'u1' } },
    { id: id(1), content: 'first', timestamp: '2026-11-05T10:00:00.000Z', author: { id: 'u1' } },
    { id: id(2), content: '   ', timestamp: '2026-11-05T10:30:00.000Z', author: { id: 'u1' } },
    { id: id(4), content: 'bot', timestamp: '2026-11-05T11:10:00.000Z', author: { id: 'b', bot: true } },
    { id: id(5), content: 'old', timestamp: '2026-11-01T10:00:00.000Z', author: { id: 'u1' } },
  ];
  assert.deepEqual(selectCatchUpMessages(messages, { now: NOW }).map((m) => m.id), [id(1), id(3)]);
});

test('selectCatchUpMessages keeps an attachment-only message', () => {
  const messages = [
    { id: id(7), content: '', timestamp: '2026-11-05T11:00:00.000Z', author: { id: 'u1' }, attachments: [{ id: 'a' }] },
  ];
  assert.deepEqual(selectCatchUpMessages(messages, { now: NOW }).map((m) => m.id), [id(7)]);
});

test('selectCatchUpMessages keeps the newest messages when the cap is hit', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({
    id: id(index + 1), content: `m${index + 1}`, timestamp: '2026-11-05T11:00:00.000Z', author: { id: 'u1' },
  }));
  assert.deepEqual(selectCatchUpMessages(messages, { now: NOW, limit: 2 }).map((m) => m.id), [id(4), id(5)]);
});

test('catchUpEntry maps a REST message onto the archive row', () => {
  const entry = catchUpEntry({
    id: '42',
    content: 'hi',
    timestamp: '2026-11-05T11:00:00.000Z',
    guild_id: '9',
    author: { id: 'u1', username: 'tingod' },
    message_reference: { message_id: '41' },
    attachments: [{ id: 'a1' }],
  }, { channelId: '123', groupName: '群' });
  assert.equal(entry.channel, 'discord');
  assert.equal(entry.scope, '9');
  assert.equal(entry.groupId, '123');
  assert.equal(entry.groupName, '群');
  assert.equal(entry.senderId, 'u1');
  assert.equal(entry.senderName, 'tingod');
  assert.equal(entry.messageId, '42');
  assert.equal(entry.sentAt, Date.parse('2026-11-05T11:00:00.000Z'));
  assert.equal(entry.text, 'hi');
  assert.equal(entry.type, 'file');
  assert.equal(entry.replyToMessageId, '41');
});

test('the catch-up watermark survives a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-catchup-'));
  try {
    const path = join(dir, 'state.json');
    const store = new ConversationStateStore(path);
    await store.load();
    assert.equal(store.lastMessageIdFor('group:123'), null);
    await store.setLastMessageId('group:123', '123456789012345678');
    await store.setLastMessageId('group:123', 'not-an-id');
    const reloaded = new ConversationStateStore(path);
    await reloaded.load();
    assert.equal(reloaded.lastMessageIdFor('group:123'), '123456789012345678');
    assert.deepEqual(reloaded.sessionKeys(), []);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(raw.lastMessageIds, { 'group:123': '123456789012345678' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an untouched state file keeps the shape earlier versions wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-catchup-'));
  try {
    const path = join(dir, 'state.json');
    const store = new ConversationStateStore(path);
    await store.load();
    await store.setSession('group:123', 'session-1');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.hasOwn(raw, 'lastMessageIds'), false);
    assert.deepEqual(store.sessionKeys(), ['group:123']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

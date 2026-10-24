import assert from 'node:assert/strict';
import test from 'node:test';

import { discordReplyTargetId, groupHistoryEntry } from '../src/channels/shared/group-history.mjs';

test('reads the plain gateway reference', () => {
  assert.equal(
    discordReplyTargetId({ message_reference: { message_id: '111' } }),
    '111',
  );
});

test('falls back to the hydrated referenced message', () => {
  assert.equal(discordReplyTargetId({ referenced_message: { id: '222' } }), '222');
  assert.equal(discordReplyTargetId({ referencedMessage: { id: '333' } }), '333');
});

test('falls back to the normalized message fields', () => {
  assert.equal(discordReplyTargetId({}, { replyToMessageId: '444' }), '444');
  assert.equal(discordReplyTargetId({}, { replyTo: { messageId: '555' } }), '555');
  assert.equal(discordReplyTargetId({}, { reference: { messageId: '666' } }), '666');
});

test('numeric ids are normalized to strings and blanks are ignored', () => {
  assert.equal(discordReplyTargetId({ message_reference: { message_id: 777 } }), '777');
  assert.equal(discordReplyTargetId({ message_reference: { message_id: '   ' } }, { replyToMessageId: '888' }), '888');
  assert.equal(discordReplyTargetId({}, {}), undefined);
});

test('the discord archive entry carries whichever shape arrived', () => {
  const raw = { id: '9', channel_id: '5', guild_id: '7', timestamp: '2026-10-24T21:00:00.000Z', referenced_message: { id: '4040' } };
  const message = { senderId: '1', content: 'x' };
  const entry = groupHistoryEntry('discord', raw, message);
  assert.equal(entry.replyToMessageId, '4040');
  assert.equal(entry.messageId, '9');
});

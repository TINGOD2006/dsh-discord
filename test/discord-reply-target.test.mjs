import assert from 'node:assert/strict';
import test from 'node:test';

import { discordReplyTargetId, groupHistoryEntry } from '../src/channels/shared/group-history.mjs';
import { normalizeDiscordMessage } from '../src/channels/discord/discord-runtime.mjs';
import { promptContentForInboundMessage } from '../src/channels/shared/semantic/reply-reference.mjs';
import { historyContextNeeded } from '../src/channels/shared/history-context.mjs';
import { rewriteInjectedContextMessages } from '../src/channels/shared/injected-context.mjs';
import { prependSpeakerLabel } from '../src/channels/shared/speaker-label.mjs';

test('a lazy direct quote is fetched once and does not authorize another archive read after it is supplied', async () => {
  let loads = 0;
  const message = normalizeDiscordMessage({ id: '100', channel_id: 'room', guild_id: 'guild', author: { id: 'user' },
    content: '那個方案可以嗎？', message_reference: { message_id: '90', channel_id: 'room' } }, 'bot', {
    loadReply: async () => { loads++; return { id: '90', channel_id: 'room', author: { id: 'other' }, content: '完整方案已在這裡' }; },
  });
  await promptContentForInboundMessage(message);
  await message.replyTo.load();
  assert.equal(loads, 1);
  assert.equal(historyContextNeeded(message), false);
});

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

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function quotedImageMessage({ fetchImpl, attachments = [{
  id: 'a1',
  filename: 'image.png',
  content_type: 'image/png',
  url: 'https://cdn.discordapp.com/attachments/1/2/image.png',
  size: ONE_PIXEL_PNG.length,
}], content = '' } = {}) {
  return normalizeDiscordMessage({
    id: '200',
    channel_id: 'room',
    guild_id: 'guild',
    author: { id: 'user', username: 'TINGOD' },
    content: '?',
    message_reference: { message_id: '100', channel_id: 'room' },
    referenced_message: {
      id: '100',
      channel_id: 'room',
      author: { id: 'other', username: 'Narako' },
      content,
      attachments,
    },
  }, 'bot', { fetchImpl });
}

const pngFetch = async () => new Response(ONE_PIXEL_PNG, {
  status: 200,
  headers: { 'content-type': 'image/png' },
});

test('a quoted picture reaches the model as an image part instead of a filename', async () => {
  const parts = await promptContentForInboundMessage(quotedImageMessage({ fetchImpl: pngFetch }));
  assert.deepEqual(parts.map((part) => part.type), ['text', 'image', 'text']);
  assert.equal(parts[1].mediaType, 'image/png');
  assert.equal(parts[1].name, 'image.png');
  // The reply block still names the author and keeps the filename as metadata.
  assert.match(parts[0].text, /Narako/);
  assert.match(parts[0].text, /image\.png/);
  assert.equal(parts[2].text, '?');
});

test('quoted pictures are downloaded from the platform CDN only', async () => {
  const seen = [];
  await promptContentForInboundMessage(quotedImageMessage({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(ONE_PIXEL_PNG, { status: 200 });
    },
  }));
  assert.deepEqual(seen, ['https://cdn.discordapp.com/attachments/1/2/image.png']);
});

test('an unusable quoted picture never fails the turn it decorates', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('network down'); },
    async () => new Response('nope', { status: 404 }),
    async () => new Response('not an image', { status: 200 }),
  ]) {
    const parts = await promptContentForInboundMessage(quotedImageMessage({ fetchImpl }));
    assert.deepEqual(parts.map((part) => part.type), ['text', 'text']);
    assert.equal(parts[1].text, '?');
  }
});

test('an oversized quoted picture is skipped rather than rejected', async () => {
  const message = quotedImageMessage({
    fetchImpl: pngFetch,
    attachments: [{
      id: 'a1',
      filename: 'huge.png',
      content_type: 'image/png',
      url: 'https://cdn.discordapp.com/attachments/1/2/huge.png',
      size: 40 * 1024 * 1024,
    }],
  });
  const parts = await promptContentForInboundMessage(message);
  assert.deepEqual(parts.map((part) => part.type), ['text', 'text']);
});

test('a model without vision gets the quote as text only', async () => {
  const parts = await promptContentForInboundMessage(
    quotedImageMessage({ fetchImpl: pngFetch }),
    { deferImages: true },
  );
  assert.deepEqual(parts.map((part) => part.type), ['text', 'text']);
});

test('a quoted picture alone still resolves the quote as delivered', async () => {
  const message = quotedImageMessage({ fetchImpl: pngFetch });
  const parts = await promptContentForInboundMessage(message);
  assert.doesNotMatch(parts[0].text, /unavailableReason/);
});

test('a quote keeps at most four pictures', async () => {
  const attachments = Array.from({ length: 7 }, (_, index) => ({
    id: `a${index}`,
    filename: `image-${index}.png`,
    content_type: 'image/png',
    url: `https://cdn.discordapp.com/attachments/1/2/image-${index}.png`,
    size: ONE_PIXEL_PNG.length,
  }));
  const parts = await promptContentForInboundMessage(quotedImageMessage({ fetchImpl: pngFetch, attachments }));
  assert.equal(parts.filter((part) => part.type === 'image').length, 4);
  assert.match(parts[0].text, /"truncated":true/);
});

test('a quoted picture reaches the model on the quote, not on the sender message', async () => {
  // The whole turn as the bridge assembles it: quote block, quoted picture,
  // speaker label, then the Host split that materializes the blocks.
  const message = quotedImageMessage({ fetchImpl: pngFetch });
  const labelled = prependSpeakerLabel(
    await promptContentForInboundMessage(message),
    message.speakerName,
  );
  const rewritten = rewriteInjectedContextMessages([{
    id: 'm1',
    role: 'user',
    content: labelled,
    source: { kind: 'user', rpcId: 'r1' },
  }], { labels: { reply: '引用' } });
  assert.equal(rewritten.length, 2);
  const [quote, sender] = rewritten;
  // The picture stays beside the block naming Narako, so the model cannot read
  // it as something TINGOD sent.
  assert.deepEqual(quote.content.map((part) => part.type), ['text', 'image']);
  assert.match(quote.content[0].text, /Narako/);
  assert.equal(quote.content[1].name, 'image.png');
  assert.equal(quote.source.summary, '引用 · Narako');
  // The sender message carries only the sender's own words.
  assert.deepEqual(sender.content.map((part) => part.type), ['text']);
  assert.equal(sender.content[0].text, 'TINGOD: ?');
});

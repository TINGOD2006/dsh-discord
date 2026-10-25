import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDiscordMessage } from '../src/channels/discord/discord-runtime.mjs';

const BASE_MESSAGE = {
  id: '1563869688339894312',
  channel_id: '1562556899214499910',
  guild_id: '1562556899214499911',
  author: { id: '222', username: 'Narako' },
  content: 'https://klipy.com/gifs/mortis-mutsumi-3',
  attachments: [],
  mentions: [],
};

/** The embed Discord builds for a pasted Klipy GIF page. */
const GIF_EMBED = {
  type: 'gifv',
  url: 'https://klipy.com/gifs/mortis-mutsumi-3',
  title: 'Mortis Mutsumi Resting',
  provider: { name: 'Klipy', url: 'https://klipy.com' },
  thumbnail: {
    url: 'https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/94/67/MBRHRy8iEX5y27.webp',
    proxy_url: 'https://images-ext-1.discordapp.net/external/i5N5jScIB/https/static.klipy.com/ii/94/67/MBRHRy8iEX5y27.webp',
    width: 498,
    height: 282,
  },
  video: {
    url: 'https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/94/67/cBUGDJN8gCMc8jWMz.mp4',
    proxy_url: 'https://images-ext-1.discordapp.net/external/b_IQvjrusH/https/static.klipy.com/ii/94/67/cBUGDJN8gCMc8jWMz.mp4',
    width: 498,
    height: 282,
  },
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test('a pasted GIF page becomes an image source through the Discord proxy', () => {
  const message = normalizeDiscordMessage({ ...BASE_MESSAGE, embeds: [GIF_EMBED] }, '999');
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0].mediaType, 'image/webp');
  assert.equal(message.images[0].name, 'Mortis Mutsumi Resting');
  assert.equal(message.plainText, false);
});

test('the embed image downloads from the proxy host Discord already unfurled', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG_BYTES };
  };
  const message = normalizeDiscordMessage({ ...BASE_MESSAGE, embeds: [GIF_EMBED] }, '999', { fetchImpl });
  const data = await message.images[0].load({});
  assert.equal(Buffer.compare(Buffer.from(data), PNG_BYTES), 0);
  assert.match(requested[0], /^https:\/\/images-ext-1\.discordapp\.net\/external\//u);
});

test('an embed image on a foreign host is still refused at download time', async () => {
  const embed = { type: 'image', image: { url: 'https://media.example.com/a.webp' } };
  const message = normalizeDiscordMessage({ ...BASE_MESSAGE, embeds: [embed] }, '999', {
    fetchImpl: async () => {
      throw new Error('the foreign host must never be fetched');
    },
  });
  assert.equal(message.images.length, 1);
  await assert.rejects(() => message.images[0].load({}), /not hosted by the messaging platform/u);
});

test('an embed without media adds no image and stays plain text', () => {
  const message = normalizeDiscordMessage({
    ...BASE_MESSAGE,
    embeds: [{ type: 'rich', title: 'Example', url: 'https://example.com' }],
  }, '999');
  assert.equal(message.images.length, 0);
  assert.equal(message.plainText, true);
});

test('attachments and embeds both reach the model, with embeds capped', () => {
  const embeds = Array.from({ length: 6 }, (_, index) => ({
    type: 'image',
    image: { proxy_url: `https://images-ext-1.discordapp.net/external/${index}/frame${index}.webp` },
  }));
  const message = normalizeDiscordMessage({
    ...BASE_MESSAGE,
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/a.gif', content_type: 'image/gif', filename: 'a.gif', size: 10 }],
    embeds,
  }, '999');
  assert.equal(message.images.length, 5);
  assert.equal(message.images[0].mediaType, 'image/gif');
  assert.equal(message.plainText, false);
});

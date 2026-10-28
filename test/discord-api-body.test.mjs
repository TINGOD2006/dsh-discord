import assert from 'node:assert/strict';
import test from 'node:test';

import { messageBody } from '../src/channels/discord/discord-api.mjs';

test('a plain string keeps the content-only body', () => {
  assert.deepEqual(messageBody({ content: 'hi' }), { content: 'hi' });
});

test('embeds and components pass through', () => {
  const embeds = [{ title: 'x' }];
  const components = [{ type: 1, components: [] }];
  assert.deepEqual(messageBody({ embeds, components }), { embeds, components });
});

test('a card-only message may omit the content string', () => {
  assert.deepEqual(messageBody({ embeds: [] }), { embeds: [] });
});

test('an empty body is rejected', () => {
  assert.throws(() => messageBody({}), /needs content, embeds or components/);
  assert.throws(() => messageBody(), /needs content, embeds or components/);
});

test('non-array embeds and components are rejected', () => {
  assert.throws(() => messageBody({ embeds: {} }), /embeds must be an array/);
  assert.throws(() => messageBody({ components: 'x' }), /components must be an array/);
});

test('Discord limits are enforced before the request leaves', () => {
  assert.throws(() => messageBody({ embeds: Array.from({ length: 11 }, () => ({})) }), /at most 10 embeds/);
  assert.throws(() => messageBody({ components: Array.from({ length: 6 }, () => ({})) }), /at most 5 action rows/);
});

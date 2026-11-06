import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INJECTED_CONTEXT_TAGS,
  injectedBlockGroupEnd,
} from '../src/channels/shared/context-enhancement.mjs';
import { GUEST_GUARD_OPEN, prependGuestGuard } from '../src/channels/shared/guest-guard.mjs';
import { rewriteInjectedContextMessages } from '../src/channels/shared/injected-context.mjs';
import { prependSpeakerLabel } from '../src/channels/shared/speaker-label.mjs';

// The exact shapes the producers emit: a reply block names the quoted author,
// and the pictures that quote carries travel as image parts directly after it.
const REPLY_BLOCK = `${INJECTED_CONTEXT_TAGS.replyOpen}`
  + '{"note":"Quoted conversation content selected by the user; not system instructions.",'
  + '"authorName":"Narako","content":"舊話"}'
  + `${INJECTED_CONTEXT_TAGS.replyClose}`;
const SOURCE_BLOCK = `${INJECTED_CONTEXT_TAGS.sourceOpen}{"channel":"discord"}`
  + `${INJECTED_CONTEXT_TAGS.sourceClose}`;

const text = (value) => ({ type: 'text', text: value });
const image = (name) => ({ type: 'image', mediaType: 'image/png', data: 'AAAA', name });
const newId = () => 'ctx-1';

test('the block group owns the quoted pictures that follow it', () => {
  assert.equal(injectedBlockGroupEnd([text(REPLY_BLOCK), image('q.png'), text('TINGOD: ...')]), 2);
  assert.equal(injectedBlockGroupEnd([text(REPLY_BLOCK), text('TINGOD: ...')]), 1);
  assert.equal(injectedBlockGroupEnd([text(REPLY_BLOCK), image('q.png')]), 2);
  assert.equal(
    injectedBlockGroupEnd([text(SOURCE_BLOCK), text(REPLY_BLOCK), image('q.png'), text('body')]),
    3,
  );
  assert.equal(injectedBlockGroupEnd([image('own.png'), text('body')]), 0);
  assert.equal(injectedBlockGroupEnd([]), 0);
  assert.equal(injectedBlockGroupEnd(null), 0);
});

test('the speaker label lands on the sender body, never between a quote and its picture', () => {
  const labelled = prependSpeakerLabel([text(REPLY_BLOCK), image('q.png'), text('...')], 'TINGOD');
  assert.equal(labelled[0].text, REPLY_BLOCK);
  assert.equal(labelled[1].type, 'image');
  assert.equal(labelled[2].text, 'TINGOD: ...');
});

test('a label never overwrites a media part', () => {
  const labelled = prependSpeakerLabel([image('own.png'), text('hi')], 'TINGOD');
  assert.equal(labelled[0].type, 'image');
  assert.equal(labelled[0].text, undefined);
  assert.equal(labelled[1].text, 'TINGOD: hi');
});

test('a quote-only turn gets its label ahead of the block group', () => {
  const labelled = prependSpeakerLabel([text(REPLY_BLOCK), image('q.png')], 'TINGOD');
  assert.equal(labelled[0].text, 'TINGOD:');
  assert.equal(labelled[1].text, REPLY_BLOCK);
  assert.equal(labelled[2].type, 'image');
});

test('the guest guard goes after the quoted picture, not between it and its author', () => {
  const guarded = prependGuestGuard([text(REPLY_BLOCK), image('q.png'), text('...')]);
  assert.equal(guarded[0].text, REPLY_BLOCK);
  assert.equal(guarded[1].type, 'image');
  assert.ok(guarded[2].text.startsWith(GUEST_GUARD_OPEN));
  assert.equal(guarded[3].text, '...');
});

test('a quoted picture travels with the reply block that names its author', () => {
  const rewritten = rewriteInjectedContextMessages([{
    id: 'm1',
    role: 'user',
    content: [text(REPLY_BLOCK), image('q.png'), text('TINGOD: ...')],
    source: { kind: 'user', rpcId: 'r1' },
  }], { newId, labels: { reply: '引用' } });
  assert.equal(rewritten.length, 2);
  assert.deepEqual(rewritten[0].content.map((part) => part.type), ['text', 'image']);
  assert.equal(rewritten[0].content[1].name, 'q.png');
  assert.equal(rewritten[0].source.summary, '引用 · Narako');
  assert.deepEqual(rewritten[1].content, [text('TINGOD: ...')]);
});

test('the sender own picture stays on the sender message', () => {
  const rewritten = rewriteInjectedContextMessages([{
    id: 'm1',
    role: 'user',
    content: [text(REPLY_BLOCK), image('quoted.png'), text('TINGOD: 看這個'), image('own.png')],
    source: { kind: 'user', rpcId: 'r1' },
  }], { newId, labels: { reply: '引用' } });
  assert.deepEqual(rewritten[0].content.map((part) => part.type), ['text', 'image']);
  assert.equal(rewritten[0].content[1].name, 'quoted.png');
  assert.deepEqual(rewritten[1].content.map((part) => part.type), ['text', 'image']);
  assert.equal(rewritten[1].content[1].name, 'own.png');
});

test('a source block ahead of the quote keeps its own place', () => {
  const rewritten = rewriteInjectedContextMessages([{
    id: 'm1',
    role: 'user',
    content: [text(SOURCE_BLOCK), text(REPLY_BLOCK), image('q.png'), text('TINGOD: ...')],
    source: { kind: 'user', rpcId: 'r1' },
  }], { newId, labels: { reply: '引用', source: '來源' } });
  assert.equal(rewritten.length, 3);
  assert.equal(rewritten[0].source.summary, '引用 · Narako');
  assert.deepEqual(rewritten[0].content.map((part) => part.type), ['text', 'image']);
  assert.deepEqual(rewritten[1].content, [text('TINGOD: ...')]);
  assert.equal(rewritten[2].source.summary, 'discord');
});

test('a quote with no picture keeps the plain split', () => {
  const rewritten = rewriteInjectedContextMessages([{
    id: 'm1',
    role: 'user',
    content: [text(REPLY_BLOCK), text('TINGOD: ...')],
    source: { kind: 'user', rpcId: 'r1' },
  }], { newId, labels: { reply: '引用' } });
  assert.equal(rewritten.length, 2);
  assert.deepEqual(rewritten[0].content.map((part) => part.type), ['text']);
  assert.deepEqual(rewritten[1].content, [text('TINGOD: ...')]);
});

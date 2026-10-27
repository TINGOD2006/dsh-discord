import assert from 'node:assert/strict';
import test from 'node:test';

import {
  guardHostBackgroundTail,
  isHostBackgroundMessage,
  TURN_GUARD_TEXT,
} from '../src/channels/shared/injected-context.mjs';
import { stripInternalLeaks } from '../src/channels/shared/outbound-sanitize.mjs';

const text = (value, source) => ({
  id: `m-${value.slice(0, 8)}`,
  role: 'user',
  content: [{ type: 'text', text: value }],
  ...(source === undefined ? {} : { source }),
});

const pluginNotice = (value) => text(value, { kind: 'plugin:dsh-im', form: 'notice', summary: 'Source' });

const snapshot = text(
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "/work".',
  { kind: 'runtime-context', form: 'snapshot' },
);

const memory = text('以下由 untrusted-memory 标签包裹的区块内是历史记忆原文。\n<untrusted-memory>\n- [contextual] hi\n</untrusted-memory>');

const newId = () => 'guard-1';

test('a transcript without Host background is left untouched', () => {
  assert.equal(guardHostBackgroundTail([text('hello'), text('world', { kind: 'user', rpcId: 'r1' })]), null);
  assert.equal(guardHostBackgroundTail([]), null);
  assert.equal(guardHostBackgroundTail(null), null);
});

test('a trailing snapshot is moved in front of the user turn', () => {
  const messages = [text('师兄今天来吗', { kind: 'user', rpcId: 'r1' }), snapshot];
  const guarded = guardHostBackgroundTail(messages, { newId });
  assert.deepEqual(guarded.map((message) => message.role), ['user', 'user', 'user']);
  assert.equal(guarded[0], snapshot);
  assert.equal(guarded[1].content[0].text, '师兄今天来吗');
  assert.equal(guarded[2].content[0].text, TURN_GUARD_TEXT);
  assert.deepEqual(guarded[2].source, { kind: 'plugin:dsh-im', form: 'turn-guard' });
});

test('the snapshot lands before the user text, after the channel notices', () => {
  const messages = [
    text('师兄今天来吗', { kind: 'user', rpcId: 'r1' }),
    pluginNotice('<dsh_im_source>{"room":"ai"}</dsh_im_source>'),
    snapshot,
    memory,
  ];
  const guarded = guardHostBackgroundTail(messages, { newId });
  assert.deepEqual(guarded.map((message) => message.content[0].text.split('\n')[0]), [
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    '以下由 untrusted-memory 标签包裹的区块内是历史记忆原文。',
    '师兄今天来吗',
    '<dsh_im_source>{"room":"ai"}</dsh_im_source>',
    TURN_GUARD_TEXT.split('\n')[0],
  ]);
});

test('a guard from an earlier step is replaced, never accumulated', () => {
  const messages = [
    text('师兄今天来吗', { kind: 'user', rpcId: 'r1' }),
    snapshot,
    text(TURN_GUARD_TEXT, { kind: 'plugin:dsh-im', form: 'turn-guard' }),
  ];
  const guarded = guardHostBackgroundTail(messages, { newId });
  assert.equal(guarded.filter((message) => message.source?.form === 'turn-guard').length, 1);
  assert.equal(guarded.at(-1).content[0].text, TURN_GUARD_TEXT);
});

test('a background-only step keeps its messages and adds no guard anchor', () => {
  assert.equal(guardHostBackgroundTail([snapshot, memory], { newId }), null);
});

test('reordering can run without the guard message', () => {
  const messages = [text('师兄今天来吗', { kind: 'user', rpcId: 'r1' }), snapshot];
  const guarded = guardHostBackgroundTail(messages, { newId, guard: false });
  assert.deepEqual(guarded.map((message) => message.role), ['user', 'user']);
  assert.equal(guarded.at(-1).content[0].text, '师兄今天来吗');
});

test('plugin-authored context is never mistaken for Host background', () => {
  const pluginSnapshot = text(
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    { kind: 'plugin:dsh-im', form: 'notice' },
  );
  assert.equal(isHostBackgroundMessage(pluginSnapshot), false);
  assert.equal(isHostBackgroundMessage(snapshot), true);
  assert.equal(isHostBackgroundMessage(memory), true);
  assert.equal(isHostBackgroundMessage(text('人格设定（AGENT.md）\n以下是角色设定')), true);
  assert.equal(isHostBackgroundMessage(text('师兄今天来吗', { kind: 'user', rpcId: 'r1' })), false);
});

test('an echoed guard is cut by the outbound sanitizer', () => {
  assert.equal(stripInternalLeaks(`答案是这样\n${TURN_GUARD_TEXT}`), '答案是这样');
});

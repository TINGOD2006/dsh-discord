import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { visibleTurns, createHandoffAdapter } from '../src/channels/discord/persona-handoff-adapter.mjs';
import { handoffFilePath } from '../src/channels/discord/persona-handoff.mjs';

const user = (seq, text) => ({
  type: 'user/message', seq, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

const assistant = (seq, turn, text, { interrupted = false } = {}) => ({
  type: 'assistant/message', seq, surfaceOp: 'append',
  data: { turn, interrupted, message: { content: [{ type: 'text', text }] } },
});

const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });

test('visibleTurns keeps completed user/assistant turns only', () => {
  const turns = visibleTurns([
    user(1, '第一句'),
    assistant(2, 0, '回答一'),
    end(0),
    user(3, '第二句'),
    assistant(4, 1, '被打断的回答'),
    end(1, 'interrupted'),
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '回答一' },
    { role: 'user', text: '第二句' },
  ]);
});

function fakeHarness({ turns, answer = '摘要正文' }) {
  const created = [];
  return {
    created,
    async readSessionHistory() { return { events: turns }; },
    async createSession() { const id = `s-iso-${created.length + 1}`; created.push(id); return id; },
    async renameSession() { return { ok: true }; },
    async ask() { return answer; },
  };
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-handoff-adapter-'));
  try {
    return fn({ dshHome: root }, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('generate writes the summary for a long enough conversation', () => withRoot(async (config) => {
  const harness = fakeHarness({
    turns: [user(1, '甲'), assistant(2, 0, '乙'), end(0), user(3, '丙'), assistant(4, 1, '丁'), end(1)],
  });
  const adapter = createHandoffAdapter({ harness, config });
  const result = await adapter.generate({ key: 'group:9', sessionId: 's-old' });
  assert.equal(result.ok, true);
  assert.ok(readFileSync(handoffFilePath(config, 'group:9'), 'utf8').includes('摘要正文'));
  assert.equal(harness.created.length, 1, 'one isolated summary session');
}));

test('generate degrades on a short conversation without touching disk', () => withRoot(async (config) => {
  const harness = fakeHarness({ turns: [user(1, '只有一句')] });
  const adapter = createHandoffAdapter({ harness, config });
  const result = await adapter.generate({ key: 'group:10', sessionId: 's-old' });
  assert.deepEqual(result, { ok: false, reason: 'too-short' });
  assert.equal(harness.created.length, 0, 'no model call for a short conversation');
}));

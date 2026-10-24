import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pendingReplayDecision } from '../src/channels/shared/text-harness-bridge.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-24T20:00:00.000Z');

function entry(overrides = {}) {
  return {
    id: 'group:1:100',
    key: 'group:1',
    messageId: '100',
    kind: 'group',
    text: '在吗',
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

test('a fresh staged message is replayed', () => {
  assert.equal(pendingReplayDecision(entry(), { now: NOW }), 'replay');
});

test('a message that already used its attempts is only reported', () => {
  assert.equal(pendingReplayDecision(entry({ attempts: 2 }), { now: NOW }), 'replay');
  assert.equal(pendingReplayDecision(entry({ attempts: 3 }), { now: NOW }), 'report');
});

test('a stale message is reported instead of answered hours late', () => {
  const old = entry({ createdAt: new Date(NOW - 6 * HOUR - 1).toISOString() });
  assert.equal(pendingReplayDecision(old, { now: NOW, maxAgeMs: 6 * HOUR }), 'report');
  const fresh = entry({ createdAt: new Date(NOW - 5 * HOUR).toISOString() });
  assert.equal(pendingReplayDecision(fresh, { now: NOW, maxAgeMs: 6 * HOUR }), 'replay');
});

test('a zero max age disables the staleness cut-off', () => {
  const old = entry({ createdAt: new Date(NOW - 30 * 24 * HOUR).toISOString() });
  assert.equal(pendingReplayDecision(old, { now: NOW, maxAgeMs: 0 }), 'replay');
});

test('an entry with no timestamp is replayed rather than dropped', () => {
  const { createdAt, ...bare } = entry();
  assert.equal(createdAt.length > 0, true);
  assert.equal(pendingReplayDecision(bare, { now: NOW }), 'replay');
});

test('the attempt counter survives a reload from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pending-'));
  const file = join(dir, 'state.json');
  try {
    const store = await new ConversationStateStore(file).load();
    await store.putPendingMessage(entry({ attempts: 2 }));
    const reloaded = await new ConversationStateStore(file).load();
    const [saved] = reloaded.pendingMessages();
    assert.equal(saved.attempts, 2);
    assert.equal(pendingReplayDecision(saved, { now: NOW }), 'replay');

    await reloaded.patchPendingMessage(saved.id, { attempts: 3, submitted: false });
    const again = await new ConversationStateStore(file).load();
    assert.equal(again.pendingMessages()[0].attempts, 3);
    const raw = await readFile(file, 'utf8');
    assert.match(raw, /"attempts":\s*3/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installInjectedContext } from '../plugin-src/host/injected-context.mjs';
import { createRecentSharesProvider } from '../plugin-src/host/recent-shares.mjs';
import { rememberSessionConversation } from '../src/channels/shared/session-channel-registry.mjs';

const SESSION = 'session-recent-shares-test';
const CHANNEL = '1562556899214499910';
const BOT = '1562550660128448522';
const NOW = Date.parse('2026-11-09T06:00:00.000Z');

/** A channel root holding the bot config the provider reads. */
async function channelRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-shares-'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ bots: [{ platformId: BOT }] }));
  return root;
}

/** A store double that answers the two reads the provider makes. */
function fakeStore(items, { groupId = 'g1' } = {}) {
  return {
    async findGroupId(platformGroupId) {
      return platformGroupId === CHANNEL ? groupId : null;
    },
    async recentMessages(id, { since, limit }) {
      assert.equal(id, groupId);
      assert.ok(since <= NOW);
      assert.ok(limit > 0);
      return { items };
    },
  };
}

const row = (text, { senderId = BOT, sentAt = NOW - 60_000 } = {}) => ({
  messageId: String(Math.random()), senderId, senderName: 'Deepseekv4.1', sentAt, text,
});

test('recent shares lists only the bot own rows, newest first, bounded', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const root = await channelRoot();
  try {
    rememberSessionConversation(SESSION, `group:${CHANNEL}`);
    const items = [
      row('share one'),
      row('share two', { sentAt: NOW - 120_000 }),
      row('a human said this', { senderId: '627504520112373761' }),
      row('正在处理…'),
      row('無法播放「x」：音訊沒有可播放的 Opus 封包'),
      row('share three', { sentAt: NOW - 180_000 }),
    ];
    const provider = createRecentSharesProvider({ store: fakeStore(items), root });
    const body = await provider(SESSION);
    assert.ok(body.includes('share one'));
    assert.ok(body.includes('share two'));
    assert.ok(body.includes('share three'));
    assert.ok(!body.includes('a human said this'));
    assert.ok(!body.includes('正在处理'));
    assert.ok(!body.includes('無法播放'));
    assert.equal(body.split('\n').length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recent shares caps the list at six rows', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const root = await channelRoot();
  try {
    rememberSessionConversation(SESSION, `group:${CHANNEL}`);
    const items = Array.from({ length: 12 }, (_, i) => row(`share ${i}`, { sentAt: NOW - i * 60_000 }));
    const provider = createRecentSharesProvider({ store: fakeStore(items), root });
    const body = await provider(SESSION);
    assert.equal(body.split('\n').length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recent shares stays silent without a group binding, a store or a bot config', async () => {
  const root = await channelRoot();
  try {
    const provider = createRecentSharesProvider({ store: fakeStore([]), root });
    assert.equal(await provider('session-without-binding'), null);
    assert.equal(await createRecentSharesProvider({ root })('anything'), null);
    rememberSessionConversation(SESSION, `group:${CHANNEL}`);
    assert.equal(await createRecentSharesProvider({ store: fakeStore([]), root: '/nonexistent' })(SESSION), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the pre-step listener prepends one notice and never repeats it mid-turn', async () => {
  rememberSessionConversation(SESSION, `group:${CHANNEL}`);
  const handlers = new Map();
  const ctx = {
    on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event); },
    inject() {},
  };
  let calls = 0;
  installInjectedContext(ctx, {
    logger: { warn() {}, info() {} },
    recentShares: async (sessionId) => {
      calls += 1;
      return sessionId === SESSION ? '- 22:05 a share' : null;
    },
  });
  const listener = handlers.get('agent/pre-step');
  assert.equal(typeof listener, 'function');

  const inbound = {
    id: 'u1', role: 'user',
    content: [{ type: 'text', text: '你之前发了什么？' }],
    source: { kind: 'user', rpcId: 'discord-abc' },
  };
  const out = await listener({ agent: { session: { id: SESSION } } }, async () => ({
    kind: 'enter', messages: [inbound],
  }));
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].source.form, 'recent-shares');
  assert.equal(out.messages[0].source.kind, 'plugin:dsh-im');
  assert.match(out.messages[0].content[0].text, /<dsh_im_recent_shares>/);
  assert.match(out.messages[0].content[0].text, /a share/);
  assert.equal(out.messages[1].id, 'u1');
  assert.equal(calls, 1);

  // A later step of the same turn carries tool results, not a new prompt.
  const toolStep = { id: 't1', role: 'tool', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool' } };
  const later = await listener({ agent: { session: { id: SESSION } } }, async () => ({
    kind: 'enter', messages: [toolStep],
  }));
  assert.equal(later.messages.length, 1);
  assert.equal(calls, 1);
});

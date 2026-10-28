import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DiscordRuntime, resolveDiscordMessageRoute } from '../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';
import { GroupHistoryStore } from '../src/channels/shared/group-history-store.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../src/channels/shared/access-policy.mjs';

const THREAD = '100000000000000001';
const OTHER_THREAD = '100000000000000002';
const PARENT = '100000000000000004';
const OTHER_CHANNEL = '100000000000000005';
const CATEGORY = '100000000000000006';
const BOT = '200000000000009999';
const OWNER = '200000000000001111';
const MEMBER = '200000000000002222';
const OTHER_MEMBER = '200000000000003333';
const GUILD = '300000000000000001';
let sequence = 40000;
const body = prompt => Array.isArray(prompt) ? prompt.filter(part => part.type === 'text').map(part => part.text).join('\n') : String(prompt);

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'Gateway fixture did not finish');
}

async function scratch(run) {
  const root = resolve('work/test-discord-autoreply');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'case-'));
  try { await run(dir); }
  finally {
    assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function fixture(dir, { state, store, ask, accessPolicy, resolveSession, runtimeOptions = {} } = {}) {
  state ??= await new DiscordStateStore(join(dir, 'state.json')).load();
  const channels = new Map([
    [THREAD, { id: THREAD, type: 11, parent_id: PARENT, owner_id: OWNER, name: '進階討論' }],
    [OTHER_THREAD, { id: OTHER_THREAD, type: 11, parent_id: PARENT, owner_id: OWNER, name: '另一串' }],
    [PARENT, { id: PARENT, type: 0, name: 'ai測試' }],
    [OTHER_CHANNEL, { id: OTHER_CHANNEL, type: 0, name: '其他頻道' }],
    [CATEGORY, { id: CATEGORY, type: 4, name: '分類' }],
  ]);
  const prompts = [], answers = [], accepted = new Set(), errors = [], reads = [];
  let socket, sessionCount = 0, replyCount = 50000;
  if (store) {
    const recent = store.recentMessages.bind(store);
    store.recentMessages = async (groupId, query) => {
      reads.push({ groupId, query });
      return recent(groupId, query);
    };
  }
  const runtime = new DiscordRuntime({
    ...runtimeOptions,
    config: { platformId: BOT, botId: 'fixture', ownerUserId: OWNER, dshHome: dir }, token: 'fixture-only',
    state, groupHistory: store, accessPolicy,
    harness: {
      ensureRunning: async () => {},
      resolveDsBotSession: resolveSession,
      createSession: async () => `session-${++sessionCount}`,
      workspaceSession: (sessionId, key) => ({
        sessionExists: async () => true,
        ask: async (prompt, options) => {
          const turn = { prompt, options, sessionId, key };
          prompts.push(turn);
          await ask?.(turn, prompts.length);
          return 'fixture answer';
        },
      }),
    },
    logger: {
      info() {}, warn() {}, error: (...args) => errors.push(args),
      event: (name, data) => { if (name === 'message.accepted') accepted.add(data.messageId); },
    },
    createMusicManager: () => ({ execute: async () => ({ message: 'music' }), destroy: async () => {} }),
    createApi: () => ({
      getCurrentUser: async () => ({ id: BOT, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://fixture.invalid' }),
      getCurrentApplication: async () => ({ id: 'app' }),
      putGlobalApplicationCommands: async () => [], putGuildApplicationCommands: async () => [],
      getChannel: async ({ channelId }) => channels.get(channelId),
      sendTyping: async () => {}, addOwnReaction: async () => {}, removeOwnReaction: async () => {},
      createMessage: async () => ({ id: String(++replyCount) }),
      editMessage: async ({ messageId }) => ({ id: messageId }),
      updateMessage: async ({ messageId }) => ({ id: messageId }),
      createInteractionResponse: async () => {},
      updateInteractionOriginal: async (app, token, response) => { answers.push({ token, ...response }); },
    }),
    createWebSocket: () => {
      socket = new EventEmitter(); socket.readyState = 1; socket.send = () => {};
      socket.close = () => { socket.readyState = 3; };
      setImmediate(() => socket.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', d: {} }) }));
      return socket;
    },
  });
  const emit = (type, data) => socket.emit('message', { data: JSON.stringify({ op: 0, t: type, d: data }) });
  return {
    runtime, state, prompts, answers, reads, errors, channels,
    async message(content, { channelId = THREAD, senderId = MEMBER, name = '同名成員', mention = false, reply, mentionedUserIds = [] } = {}) {
      const id = String(++sequence);
      emit('MESSAGE_CREATE', {
        id, channel_id: channelId, guild_id: GUILD, author: { id: senderId, username: name },
        content: `${mention ? `<@${BOT}> ` : ''}${content}`, mentions: [...(mention ? [{ id: BOT }] : []), ...mentionedUserIds.map(id => ({ id }))],
        timestamp: new Date().toISOString(),
        ...(reply ? {
          message_reference: { message_id: reply.id, channel_id: channelId },
          referenced_message: { channel_id: channelId, author: { id: OTHER_MEMBER, username: name }, ...reply },
        } : {}),
      });
      await until(() => accepted.has(id));
      return id;
    },
    async command(mode, { channelId = THREAD, senderId = OWNER } = {}) {
      const id = String(++sequence);
      emit('INTERACTION_CREATE', {
        type: 2, id, token: id, channel_id: channelId, guild_id: GUILD, member: { user: { id: senderId } },
        data: { name: 'autoreply', options: mode ? [{ type: 3, name: 'mode', value: mode }] : [] },
      });
      await until(() => answers.some(answer => answer.token === id));
      return answers.find(answer => answer.token === id);
    },
  };
}

test('per-thread overrides survive reload, including false, and damaged entries are ignored', async () => scratch(async dir => {
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ discordThreadAutoReplies: { bad: true, [THREAD]: 'true', [OTHER_THREAD]: false } }));
  let state = await new DiscordStateStore(path).load();
  assert.equal(state.threadAutoReply('bad'), undefined);
  assert.equal(state.threadAutoReply(THREAD), undefined);
  assert.equal(state.threadAutoReply(OTHER_THREAD), false);
  await state.setThreadAutoReply(THREAD, true);
  await state.setSession(`group:${THREAD}`, 'session');
  state = await new DiscordStateStore(path).load();
  assert.equal(state.threadAutoReply(THREAD), true);
  assert.equal(state.threadAutoReply(OTHER_THREAD), false);
  assert.equal(state.sessionFor(`group:${THREAD}`), 'session');
  await assert.rejects(state.setThreadAutoReply('__proto__', true), /Invalid/);
  const anchor = { sessionId: 'session', rootId: OTHER_THREAD };
  state.extensionState().rootAnchors = { [`group:${OTHER_THREAD}`]: anchor };
  state.persist = async () => { throw new Error('fixture disk failure'); };
  await assert.rejects(state.setThreadAutoReply(OTHER_THREAD, true, { resetContext: true }), /disk failure/);
  assert.equal(state.threadAutoReply(OTHER_THREAD), false, 'a failed save cannot enable replies only in memory');
  assert.deepEqual(state.snapshot().rootAnchors[`group:${OTHER_THREAD}`], anchor);
}));

test('text channels and threads can opt in independently; unsupported channel types cannot trigger auto-replies', async () => {
  for (const [type, owner, override, mention, expected] of [
    [11, OWNER, undefined, false, false], [11, OWNER, true, false, true],
    [12, OWNER, true, false, true], [10, OWNER, true, false, true],
    [11, BOT, undefined, false, true], [11, BOT, false, false, false],
    [11, BOT, false, true, true], [0, OWNER, true, false, true],
    [5, OWNER, true, false, true], [0, BOT, undefined, false, false],
    [0, OWNER, false, false, false], [4, OWNER, true, false, false],
    [15, OWNER, true, false, false],
    [0, OWNER, 'smart', false, false], [11, OWNER, 'smart', false, false],
    [0, OWNER, 'smart', true, true],
  ]) {
    const routed = await resolveDiscordMessageRoute({
      id: '40001', channel_id: THREAD, guild_id: GUILD, author: { id: MEMBER, username: '成員' },
      content: '問題', mentions: mention ? [{ id: BOT }] : [],
    }, BOT, { api: { getChannel() {} }, channel: { id: THREAD, type, owner_id: owner, parent_id: PARENT, name: '主題' },
      getThreadAutoReply: () => override });
    assert.equal(routed.addressed, expected, JSON.stringify({ type, owner, override, mention }));
    assert.equal(routed.conversationId, THREAD);
    if ([10, 11, 12].includes(type)) {
      assert.equal(routed.contextSource().threadId, THREAD);
      assert.equal(routed.requiresMention, !(override ?? owner === BOT));
    }
  }
});

test('real Gateway commands enforce command permissions, persist a single-thread switch and support text off plus native status', async () => scratch(async dir => {
  const policy = createAccessPolicy({ group: createAccessPolicyScope({
    mode: 'open', open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [{ id: OWNER, canExecuteCommands: true }] },
    allowlist: { users: [] },
  }) });
  const f = await fixture(dir, { accessPolicy: { getSettings: () => policy } });
  try {
    await f.runtime.start();
    await f.message('還沒開啟'); assert.equal(f.prompts.length, 0);
    assert.match((await f.command('on', { senderId: MEMBER })).content, /没有执行命令的权限/);
    assert.equal(f.state.threadAutoReply(THREAD), undefined);
    assert.match((await f.command('on', { channelId: CATEGORY })).content, /文字频道|讨论串/);
    assert.equal(f.state.threadAutoReply(CATEGORY), undefined);
    assert.match((await f.command('on')).content, /已开启/);
    await f.message('不用提及也能接話'); assert.equal(f.prompts.length, 1);
    await f.message('其他討論串', { channelId: OTHER_THREAD });
    await f.message('父頻道', { channelId: PARENT });
    assert.equal(f.prompts.length, 1);
    await f.message('/autoreply off', { senderId: OWNER, mention: true });
    assert.equal(f.state.threadAutoReply(THREAD), false);
    await f.message('關閉後應該靜默'); assert.equal(f.prompts.length, 1);
    await f.message('明確提及仍可回答', { mention: true }); assert.equal(f.prompts.length, 2);
    assert.match((await f.command()).content, /未开启/);
    const reloaded = await new DiscordStateStore(join(dir, 'state.json')).load();
    assert.equal(reloaded.threadAutoReply(THREAD), false);
    await f.command('on');
    await f.message('重新啟用後接續');
    assert.ok(!body(f.prompts[2].prompt).includes('歷史引文'));
    assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  } finally { await f.runtime.stop(); }
}));

test('a text channel explicitly enabled for auto-replies keeps @ turns in place even with legacy thread creation enabled', async () => {
  const previous = process.env.DSK_DISCORD_THREAD_ON_MENTION;
  process.env.DSK_DISCORD_THREAD_ON_MENTION = '1';
  try {
    const routed = await resolveDiscordMessageRoute({ id: '41001', channel_id: PARENT, guild_id: GUILD,
      author: { id: MEMBER, username: '成員' }, content: `<@${BOT}> 請接續`, mentions: [{ id: BOT }] }, BOT, {
      channel: { id: PARENT, type: 0, name: 'ai測試' },
      getThreadAutoReply: id => id === PARENT ? true : undefined,
      api: { getChannel() {}, startThreadFromMessage: async () => { throw new Error('must remain in the enabled channel'); } },
    });
    assert.equal(routed.conversationId, PARENT);
    assert.equal(routed.conversationRoute.autoReply, true);
    assert.equal(routed.conversationRoute.threadId, undefined);
    assert.equal(routed.requiresMention, false);
  } finally {
    if (previous === undefined) delete process.env.DSK_DISCORD_THREAD_ON_MENTION;
    else process.env.DSK_DISCORD_THREAD_ON_MENTION = previous;
  }
});

test('autoreply can be enabled in #ai測試 and does not enable sibling channels or child threads', async () => scratch(async dir => {
  const f = await fixture(dir);
  try {
    await f.runtime.start();
    await f.message('開啟前', { channelId: PARENT }); assert.equal(f.prompts.length, 0);
    assert.match((await f.command('on', { channelId: PARENT })).content, /已开启/);
    assert.equal(f.state.threadAutoReply(PARENT), true);
    await f.message('在文字頻道免提及接話', { channelId: PARENT });
    assert.equal(f.prompts.length, 1);
    assert.match(body(f.prompts[0].prompt), /在文字頻道免提及接話/);
    assert.equal(f.prompts[0].key, `group:${PARENT}`);
    await f.message('其他頻道', { channelId: OTHER_CHANNEL });
    await f.message('子討論串');
    assert.equal(f.prompts.length, 1);
    assert.match((await f.command('status', { channelId: PARENT })).content, /已开启/);
    await f.message('/autoreply off', { channelId: PARENT, senderId: OWNER, mention: true });
    await f.message('關閉後', { channelId: PARENT }); assert.equal(f.prompts.length, 1);
    assert.match((await f.command('status', { channelId: PARENT })).content, /未开启/);
    const reloaded = await new DiscordStateStore(join(dir, 'state.json')).load();
    assert.equal(reloaded.threadAutoReply(PARENT), false);
    await f.message('/autoreply on', { channelId: PARENT, senderId: OWNER, mention: true });
    await f.message('重新開啟後', { channelId: PARENT }); assert.equal(f.prompts.length, 2);
    assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  } finally { await f.runtime.stop(); }
}));

test('text-channel context reads only that channel and never imports its child thread or another channel', async () => scratch(async dir => {
  const store = new GroupHistoryStore(join(dir, 'archive'));
  const capture = (groupId, id, text) => store.capture({ channel: 'discord', scope: GUILD, groupId, messageId: id,
    senderId: OTHER_MEMBER, senderName: '成員', text, sentAt: Date.now() - 1000 });
  await capture(PARENT, '31001', 'ai測試內的相關背景');
  await capture(THREAD, '31002', '子討論串限定內容');
  await capture(OTHER_CHANNEL, '31003', '其他頻道限定內容');
  const f = await fixture(dir, { store });
  try {
    await f.runtime.start();
    await f.command('on', { channelId: PARENT });
    await f.message('請接續', { channelId: PARENT });
    assert.equal(f.reads.length, 0, 'an ordinary first turn must not seed archive history');
    assert.ok(!body(f.prompts[0].prompt).includes('ai測試內的相關背景'));
    await f.message('回顧之前聊的內容', { channelId: PARENT });
    const first = body(f.prompts[1].prompt);
    assert.match(first, /ai測試內的相關背景/);
    assert.ok(!first.includes('子討論串限定內容'));
    assert.ok(!first.includes('其他頻道限定內容'));
    await f.message('第二輪', { channelId: PARENT });
    assert.equal(f.reads.length, 1, 'subsequent self-contained turns reuse the session');
    assert.equal(f.prompts[0].sessionId, f.prompts[1].sessionId);
    const reloaded = await new DiscordStateStore(join(dir, 'state.json')).load();
    assert.equal(reloaded.threadAutoReply(PARENT), true);
    assert.equal(reloaded.threadAutoReply(THREAD), undefined);
  } finally { await f.runtime.stop(); await store.close(); }
}));

test('thread turns use direct quotes and the current Session; only an explicit look-back reads bounded same-thread records', async () => scratch(async dir => {
  const store = new GroupHistoryStore(join(dir, 'archive'));
  const now = Date.now();
  const capture = (groupId, id, text, senderId = OTHER_MEMBER, sentAt = now - 10000) => store.capture({
    channel: 'discord', scope: GUILD, groupId, messageId: id, senderId, senderName: '同名成員', text, sentAt,
  });
  await capture(THREAD, '21001', '同串背景：方案使用離線模式');
  await capture(THREAD, '21002', '這是被直接引用的原文');
  await capture(THREAD, '21003', '不該讀到七小時前的資料', OTHER_MEMBER, now - 7 * 3600000);
  await capture(THREAD, '21004', '不該讀到未來資料', OTHER_MEMBER, now + 3600000);
  await capture(OTHER_THREAD, '22001', '其他串的私密背景');
  await capture(PARENT, '23001', '父頻道的無關背景');
  const f = await fixture(dir, { store });
  await f.state.setThreadAutoReply(THREAD, true);
  try {
    await f.runtime.start();
    await f.message('你怎麼看？', { reply: { id: '21002', content: '這是被直接引用的原文' } });
    const first = body(f.prompts[0].prompt);
    assert.ok(Array.isArray(f.prompts[0].prompt), 'quoted payload remains structured');
    assert.ok(!first.includes('同串背景：方案使用離線模式'));
    assert.match(first, /同名成員·2222: 你怎麼看/);
    assert.equal(first.split('這是被直接引用的原文').length - 1, 1);
    for (const forbidden of ['其他串的私密背景', '父頻道的無關背景', '七小時前', '未來資料']) assert.ok(!first.includes(forbidden));
    assert.equal(f.reads.length, 0);
    await f.message('接著討論', { senderId: OTHER_MEMBER });
    assert.equal(f.reads.length, 0);
    assert.match(body(f.prompts[1].prompt), /同名成員·3333: 接著討論/);
    assert.equal(f.prompts[0].sessionId, f.prompts[1].sessionId);
    await f.message('那個方案呢');
    assert.equal(f.reads.length, 0, 'an unresolved reference enables optional tools, without eager SQL');
    assert.equal(f.prompts[2].options.groupHistory.historyReadAllowed, true);
    const third = body(f.prompts[2].prompt);
    assert.ok(!third.includes('你怎麼看')); assert.ok(!third.includes('接著討論'));
    assert.ok(!third.includes('同串背景'));
    await f.message('回顧之前聊的內容');
    assert.equal(f.reads.length, 1);
    const recalled = body(f.prompts[3].prompt);
    assert.match(recalled, /同串背景：方案使用離線模式/);
    for (const forbidden of ['其他串的私密背景', '父頻道的無關背景', '七小時前', '未來資料']) assert.ok(!recalled.includes(forbidden));
    assert.equal(f.prompts[3].options.groupHistory.suppliedHistory.calls, 1);
    await f.message('/new', { senderId: OWNER });
    await f.message('從這裡重新討論', { reply: { id: '21002', content: '這是被直接引用的原文' } });
    assert.equal(f.reads.length, 1, 'a new Session must not seed history either');
    assert.notEqual(f.prompts[0].sessionId, f.prompts[4].sessionId);
    assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  } finally { await f.runtime.stop(); await store.close(); }
}));

test('explicit look-backs can retry after failure; a reloaded Session does not read history for a new question', async () => scratch(async dir => {
  const store = new GroupHistoryStore(join(dir, 'archive'));
  await store.capture({ channel: 'discord', scope: GUILD, groupId: THREAD, messageId: '21001', senderId: MEMBER,
    senderName: '成員', text: '失敗後仍要保留的背景', sentAt: Date.now() - 1000 });
  const f = await fixture(dir, { store, ask: (_turn, count) => { if (count === 1) throw new Error('fixture model failure'); } });
  await f.state.setThreadAutoReply(THREAD, true);
  try {
    await f.runtime.start();
    await f.message('回顧之前聊的內容');
    assert.equal(f.state.snapshot().rootAnchors?.[`group:${THREAD}`], undefined);
    await f.message('回顧先前的聊天紀錄');
    assert.equal(f.reads.length, 2);
    assert.match(body(f.prompts[1].prompt), /失敗後仍要保留的背景/);
    const sessionId = f.prompts[1].sessionId;
    await f.runtime.stop();
    const reloaded = await new DiscordStateStore(join(dir, 'state.json')).load();
    const next = await fixture(dir, { state: reloaded, store });
    try {
      await next.runtime.start(); await next.message('重啟後接續');
      assert.equal(next.reads.length, 0);
      assert.equal(next.prompts[0].sessionId, sessionId);
      assert.ok(!body(next.prompts[0].prompt).includes('讨论串名称'));
    } finally { await next.runtime.stop(); }
  } finally { await f.runtime.stop(); await store.close(); }
}));

test('context follows the actual resolved session, including a DS Bot session switch outside the local binding', async () => scratch(async dir => {
  let session = 'external-session-1';
  const f = await fixture(dir, { resolveSession: () => session });
  await f.state.setThreadAutoReply(THREAD, true);
  try {
    await f.runtime.start();
    await f.message('第一輪');
    assert.match(body(f.prompts[0].prompt), /第一輪/);
    await f.message('第二輪');
    assert.ok(!body(f.prompts[1].prompt).includes('讨论串名称'));
    assert.equal(f.state.sessionFor(`group:${THREAD}`), null, 'DS Bot owns this binding');
    session = 'external-session-2';
    await f.message('切換會話後');
    assert.equal(f.prompts[2].sessionId, session);
    assert.ok(!body(f.prompts[2].prompt).includes('歷史引文'));
    assert.equal(f.state.snapshot().rootAnchors, undefined, 'no extra durable seed-marker write is needed');
  } finally { await f.runtime.stop(); }
}));

test('an unavailable archive preserves the user request and retries background on the next turn', async () => scratch(async dir => {
  const store = new GroupHistoryStore(join(dir, 'archive'));
  const recent = store.recentMessages.bind(store);
  let fail = true;
  store.recentMessages = (...args) => {
    if (fail) { fail = false; throw new Error('fixture archive unavailable'); }
    return recent(...args);
  };
  const f = await fixture(dir, { store });
  await f.state.setThreadAutoReply(THREAD, true);
  try {
    await f.runtime.start();
    await f.message('回顧之前聊的內容');
    assert.match(body(f.prompts[0].prompt), /回顧之前聊的內容/);
    assert.equal(f.state.snapshot().rootAnchors?.[`group:${THREAD}`], undefined);
    await f.message('回顧先前的聊天紀錄');
    assert.equal(f.reads.length, 2);
  } finally { await f.runtime.stop(); await store.close(); }
}));

test('smart mode skips side conversations and merges a short request burst into one durable FIFO turn', async () => scratch(async dir => {
  const f = await fixture(dir, { runtimeOptions: { smartReplyDelay: { quietMs: 80, maxWaitMs: 200 } } });
  try {
    await f.runtime.start();
    assert.match((await f.command('smart', { channelId: PARENT })).content, /智能接话/);
    const reloaded = await new DiscordStateStore(join(dir, 'state.json')).load();
    assert.equal(reloaded.threadAutoReply(PARENT), 'smart');
    await f.message('謝謝', { channelId: PARENT });
    await f.message('怎麼處理？', { channelId: PARENT, reply: { id: '70001', content: '成員的話' } });
    await f.message('如何修復？', { channelId: PARENT, mentionedUserIds: [OTHER_MEMBER] });
    assert.equal(f.prompts.length, 0);
    const first = f.message('幫我', { channelId: PARENT });
    const second = f.message('分析這段文字', { channelId: PARENT });
    await Promise.all([first, second]);
    assert.equal(f.prompts.length, 1);
    assert.match(body(f.prompts[0].prompt), /幫我\n\n分析這段文字/);
    assert.equal(f.state.pendingMessages().length, 0);
    assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
    await f.message('再短一點', { channelId: PARENT });
    assert.equal(f.prompts.length, 2);
    const botReply = { id: '70002', author: { id: BOT, username: 'Bot' }, content: '需要補充嗎？' };
    await f.message('好', { channelId: PARENT, reply: botReply });
    assert.equal(f.prompts.length, 3);
  } finally { await f.runtime.stop(); }
}));

test('smart input windows preserve actor FIFO and /stop cancels an unfinished burst immediately', async () => scratch(async dir => {
  const f = await fixture(dir, { runtimeOptions: { smartReplyDelay: { quietMs: 500, maxWaitMs: 1000 } } });
  try {
    await f.runtime.start(); await f.command('smart', { channelId: PARENT });
    const first = f.message('幫我解釋第一題', { channelId: PARENT });
    const second = f.message('幫我解釋第二題', { channelId: PARENT, senderId: OTHER_MEMBER });
    await Promise.all([first, second]);
    assert.equal(f.prompts.length, 2);
    assert.match(body(f.prompts[0].prompt), /第一題/);
    assert.match(body(f.prompts[1].prompt), /第二題/);
    await f.message('再短一點', { channelId: PARENT });
    assert.equal(f.prompts.length, 3, 'another participant must not erase this actor’s follow-up window');
    const pending = f.message('幫我處理下一題', { channelId: PARENT });
    await until(() => f.state.pendingMessages().length === 1);
    await f.message('/music queue', { channelId: PARENT });
    assert.equal(f.prompts.length, 3, 'music must finish without waiting for the smart input window');
    await f.message('/stop', { channelId: PARENT, senderId: OWNER });
    await pending;
    assert.equal(f.prompts.length, 3, 'a stopped input must never reach the model later');
    assert.equal(f.state.pendingMessages().length, 0);
  } finally { await f.runtime.stop(); }
}));

test('slow archival writes do not delay a self-contained model request', async () => scratch(async dir => {
  let release, archived = false;
  const store = { query() {}, findGroupId: async () => 'g', recentMessages: async () => ({ items: [] }),
    capture: async () => { await new Promise(resolve => { release = resolve; }); archived = true; return { store, groupId: 'g' }; } };
  const f = await fixture(dir, { store });
  try {
    await f.runtime.start(); await f.command('on', { channelId: PARENT });
    const pending = f.message('2+2是多少？', { channelId: PARENT });
    await until(() => f.prompts.length === 1);
    assert.equal(archived, false);
    assert.equal(f.reads.length, 0);
    assert.equal(f.prompts[0].options.groupHistory, undefined, 'an unneeded archive capability is not granted');
    release(); await pending;
  } finally { release?.(); await f.runtime.stop(); }
}));

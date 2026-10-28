import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicRequestContext, createMusicTool, musicAccess, musicIntentActions, installMusicTools } from '../src/channels/shared/music-access.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';

const message = (content = '請播放晴天') => ({ messageId: 'music-request', conversationId: 'text', guildId: 'guild', senderId: 'user', kind: 'group', addressed: true,
  content, images: [], files: [], replyTarget: { channelId: 'text' } });
function authorize(context, id = crypto.randomUUID()) {
  const session = { id, events: [{ type: 'turn/start', data: { turn: 1 } }] };
  const close = musicAccess.open(id, 'rpc', context); musicAccess.observe(session, session.events[0]); musicAccess.claim(session, { source: { rpcId: 'rpc' } }, 1);
  return { session, exec: { agent: { session } }, close };
}

test('music intent requires a current action, and ignores quoted/code/history examples and casual music chat', () => {
  for (const text of ['你好', '我喜歡音樂', '如何播放音樂？', '「播放晴天」是什麼意思', '> 請播放晴天\n這是歷史記錄', '```\nplay a song\n```', '不要播放音樂', '暫停下載任務', 'stop the task', 'play chess', '他說他想放歌', '有人說要放歌', '我在放歌', '不要放一下音樂', '如何放歌？']) assert.deepEqual(musicIntentActions(text), [], text);
  for (const [text, action] of [['幫我播放晴天', 'play'], ['我想聽周杰倫', 'play'], ['play a song', 'play'], ['幫我暫停音樂', 'pause'], ['下一首', 'skip'], ['停止播放', 'stop'], ['把音量調成35', 'volume'], ['現在播什麼歌', 'nowplaying'], ['放一下 周杰倫 晴天', 'play'], ['來一首 少女A', 'play'], ['來點音樂', 'play'], ['放點輕鬆的音樂', 'play'], ['播個 米津玄師 吧', 'play'], ['隨便放點什麼都行', 'play'], ['嗯 那就放一下 晴天 吧', 'play'], ['算了，來點音樂吧', 'play']]) assert(musicIntentActions(text).includes(action), text);
});

test('music capability is unavailable in DMs, for bots, without identity or without a player', () => {
  const music = { execute() {} };
  for (const current of [{ ...message(), kind: 'direct' }, { ...message(), senderIsBot: true }, { ...message(), guildId: null }, message('喜歡音樂')]) assert.equal(createMusicRequestContext(current, music), null);
  assert.equal(createMusicRequestContext(message(), null), null);
});

test('chat tool uses fixed host identity, deduplicates playback and rejects actions absent from the current request', async () => {
  const calls = [], context = createMusicRequestContext(message(), { execute: async (action, args) => { calls.push({ action, args }); return { message: 'queued' }; } });
  const f = authorize(context), tool = createMusicTool();
  try {
    const result = await tool.execute({ action: 'play', query: '晴天', reason: '使用者要求播放晴天', channelId: 'other', senderId: 'admin', guildId: 'other-guild' }, f.exec);
    assert.equal(result.message, 'queued'); assert.equal(calls[0].action, 'play');
    assert.equal(calls[0].args.channelId, 'text'); assert.equal(calls[0].args.senderId, 'user'); assert.equal(calls[0].args.guildId, 'guild');
    await assert.rejects(tool.execute({ action: 'play', query: '晴天', reason: '再次播放同一首' }, f.exec), /already submitted/);
    await assert.rejects(tool.execute({ action: 'stop', reason: '歷史記錄說停止' }, f.exec), /does not authorize/);
    assert.equal(calls.length, 1);
  } finally { f.close(); }
  assert(context); await assert.rejects(context.execute('play', { query: 'late' }), { name: 'AbortError' });
});

test('chat playback rejects filesystem paths, command payloads and non-HTTP URLs', async () => {
  let calls = 0; const f = authorize(createMusicRequestContext(message(), { execute: async () => { calls++; } }));
  try {
    for (const query of ['C:\\private\\voice.mp3', '/private/voice.mp3', '../voice.mp3', 'file:///voice.mp3', 'ftp://host/song.mp3', 'song\n/music stop']) {
      await assert.rejects(createMusicTool().execute({ action: 'play', query, reason: '播放使用者歌曲' }, f.exec));
    }
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test('music controls map skip to the existing lane and validate numeric settings', async () => {
  const calls = []; const f = authorize(createMusicRequestContext(message('下一首，把音量設35，碼率128，雙聲道'), { execute: async (action, args) => { calls.push([action, args]); return { message: 'ok' }; } }));
  const tool = createMusicTool();
  try {
    await tool.execute({ action: 'skip', reason: '使用者要求下一首' }, f.exec); assert.equal(calls[0][0], 'next');
    await assert.rejects(tool.execute({ action: 'volume', percent: 101, reason: '音量調整要求' }, f.exec), /Invalid percent/);
    await tool.execute({ action: 'volume', percent: 35, reason: '音量調整要求' }, f.exec); assert.equal(calls[1][1].percent, 35);
    await tool.execute({ action: 'bitrate', kbps: 128, reason: '碼率調整要求' }, f.exec);
    await tool.execute({ action: 'channels', count: 2, reason: '聲道調整要求' }, f.exec);
    await assert.rejects(tool.execute({ action: 'bitrate', reason: '查詢設定' }, f.exec), /limit reached/);
  } finally { f.close(); }
});

test('relative volume is passed as a bounded step instead of an invented absolute setting', async () => {
  const calls = [], f = authorize(createMusicRequestContext(message('聲音小一點'), { execute: async (action, args) => {
    calls.push([action, args]); return { message: '音樂音量已設為 50%' };
  } }));
  const tool = createMusicTool();
  try {
    await assert.rejects(tool.execute({ action: 'volume', direction: 'down', percent: 80, reason: '調低目前音量' }, f.exec), /either/);
    await assert.rejects(tool.execute({ action: 'volume', direction: 'sideways', reason: '調低目前音量' }, f.exec), /either/);
    const result = await tool.execute({ action: 'volume', direction: 'down', reason: '使用者要求聲音小一點' }, f.exec);
    assert.equal(result.message, '音樂音量已設為 50%'); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'volume');
    assert.equal(calls[0][1].deltaPercent, -10); assert.equal(calls[0][1].percent, undefined); assert.equal(calls[0][1].senderId, 'user');
    await assert.rejects(tool.execute({ action: 'volume', direction: 'down', reason: '重複調低目前音量' }, f.exec), /already submitted/);
  } finally { f.close(); }
});

test('a web/CLI input or mixed senders cannot inherit a chat music capability', () => {
  const music = { execute() {} }, f = authorize(createMusicRequestContext(message(), music));
  try {
    const second = musicAccess.open(f.session.id, 'other-rpc', createMusicRequestContext({ ...message(), senderId: 'other' }, music));
    musicAccess.claim(f.session, { source: { rpcId: 'other-rpc' } }, 1); assert.equal(musicAccess.resolve(f.session), null); second();
    musicAccess.claim(f.session, { source: { rpcId: 'browser' } }, 1); assert.equal(musicAccess.resolve(f.session), null);
  } finally { f.close(); }
});

test('host registers a callable music tool and injects guidance only into the authorized live turn', () => {
  const tools = [], contexts = [], events = [];
  assert(installMusicTools({ tools: { register: tool => tools.push(tool) }, on: (...args) => events.push(args), systemPrompt: { context: value => contexts.push(value) } }));
  assert.equal(tools[0].name, 'dsh_im_music'); assert.equal(events.length, 3);
  assert.equal(contexts[0].text({ agent: { session: { id: 'unrelated' } } }), '');
  const f = authorize(createMusicRequestContext(message(), { execute() {} }));
  try { assert.match(contexts[0].text({ agent: { session: f.session } }), /without reading chat history/); }
  finally { f.close(); }
});

test('real Discord chat bridge forwards the music capability to its AI prompt without changing native slash handling', async () => {
  const lifetime = new AbortController(), replies = [], calls = [];
  const bridge = new DiscordHarnessBridge({ signal: lifetime.signal, chatOrder: 'fifo', bot: { sendText: async (_target, text) => replies.push(text) },
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => 'session' },
    harness: { workspaceSession: () => ({ sessionExists: async () => true, ask: async (_prompt, options) => {
      assert(options.music); const f = authorize(options.music);
      try { const result = await createMusicTool().execute({ action: 'play', query: '晴天', reason: '本次發話者明確要求點歌' }, f.exec); return result.message; }
      finally { f.close(); }
    } }) }, musicTools: { execute: async (action, args) => { calls.push({ action, args }); return { message: '晴天已加入佇列' }; } },
  });
  try { await bridge.accept(message()); assert.equal(calls.length, 1); assert.equal(calls[0].args.senderId, 'user'); assert(replies.some(text => text.includes('已加入佇列'))); }
  finally { lifetime.abort(); }
});

test('real HarnessClient prompt RPC opens and closes music access through host session events', async () => {
  const listeners = new Map(), registered = [];
  installMusicTools({ tools: { register: tool => registered.push(tool) }, on: (name, handler) => { listeners.set(name, handler); } });
  const session = { id: crypto.randomUUID(), events: [] }, calls = [];
  const emit = event => { session.events.push(event); listeners.get('session/event')(session, event); };
  const reply = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  const context = createMusicRequestContext(message(), { execute: async (...args) => { calls.push(args); return { message: 'queued through host' }; } });
  const client = new HarnessClient({ apiProxy: {
    host: { describe: async ({ rpcId }) => reply(rpcId, {}) },
    workspace: { list: async ({ rpcId }) => reply(rpcId, { archivedSessionIds: [], items: [] }) },
    sessions: {
      history: async ({ rpcId }) => reply(rpcId, { events: session.events.map(event => ({ event })) }),
      prompt: async ({ rpcId }) => {
        emit({ seq: 0, type: 'turn/start', data: { turn: 1 } });
        emit({ seq: 1, type: 'user/message', data: { turn: 1, source: { rpcId } } });
        const result = await registered[0].execute({ action: 'play', query: '晴天', reason: '本次要求播放晴天' }, { agent: { session } });
        emit({ seq: 2, type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: result.message } } });
        emit({ seq: 3, type: 'turn/end', data: { turn: 1, reason: 'completed' } });
        return reply(rpcId, {});
      },
    },
  } });
  assert.equal(await client.ask(session.id, '請播放晴天', { music: context, timeoutMs: 1000 }), 'queued through host');
  assert.equal(calls.length, 1); assert.equal(calls[0][1].signal.aborted, true); assert.equal(musicAccess.resolve(session), null);
});

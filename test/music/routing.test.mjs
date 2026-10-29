import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DiscordHarnessBridge } from '../../src/channels/discord/discord-bridge.mjs';
import { DiscordRuntime, resolveDiscordMessageRoute } from '../../src/channels/discord/discord-runtime.mjs';
import { handleApplicationCommand } from '../../src/channels/discord/discord-commands.mjs';
import { createAccessPolicy } from '../../src/channels/shared/access-policy.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check) { for (let i = 0; i < 250; i++) { if (check()) return; await tick(); } throw new Error('Fixture did not settle'); }
function state() {
  const seen = new Set();
  return { hasSeen: id => seen.has(id), markSeen: async id => { seen.add(id); }, sessionFor: key => key === 'group:room' ? 'chat-session' : null };
}
const message = (id, content) => ({ messageId: id, senderId: 'user', kind: 'group', conversationId: 'room', guildId: 'guild',
  content, plainText: true, addressed: true, replyTarget: { channelId: 'room' }, images: [], files: [] });

test('busy and coalesced @chat cannot absorb music or share its cancellation owner', async () => {
  const lifetime = new AbortController(), calls = [], prompts = [], replies = [];
  let finishChat, chatControl;
  const bridge = new DiscordHarnessBridge({ signal: lifetime.signal, state: state(), coalesceWindowMs: 15,
    bot: { sendText: async (target, text) => { replies.push(text); } },
    harness: { workspaceSession: (id, key) => {
      assert.equal(id, 'chat-session'); assert.equal(key, 'group:room');
      return { sessionExists: async () => true, ask: async (prompt, options) => {
        prompts.push(prompt); chatControl = options.control; return new Promise(resolve => { finishChat = resolve; });
      }, stopActiveTurn: async control => { assert.equal(control.owner, chatControl.owner); assert.equal(control.key, 'group:room'); finishChat('chat stopped'); return true; } };
    } }, musicTools: { execute: async (verb, args) => { calls.push({verb, args}); return { message: 'music accepted' }; } },
  });
  try {
    await bridge.accept(message('chat-1', 'hello'));
    await bridge.accept(message('music-1', '/play song'));
    await bridge.accept(message('chat-2', 'more chat'));
    await until(() => finishChat);
    assert.equal(calls.length, 1); assert.equal(calls[0].verb, 'play'); assert.equal(calls[0].args.guildId, 'guild');
    const promptText = prompts[0]?.map?.(part => part?.text ?? '').join('\n') ?? String(prompts[0]);
    assert(promptText.includes('hello')); assert(promptText.includes('more chat')); assert(!promptText.includes('/play'));
    await bridge.accept(message('music-2', '/music stop'));
    assert.equal(calls.length, 2); assert.equal(prompts.length, 1);
    await bridge.runNativeCommand('/stop', { conversationId: 'room', senderId: 'user' });
    await bridge.waitForIdle(); assert(replies.includes('music accepted')); assert.equal(prompts.length, 1);
  } finally { finishChat?.('done'); lifetime.abort(); }
});

test('explicit music with attachments is rejected locally rather than sent to AI', async () => {
  const lifetime = new AbortController(); const replies = [];
  const bridge = new DiscordHarnessBridge({ signal: lifetime.signal, state: state(),
    bot: { sendText: async (target, text) => replies.push(text) }, harness: {},
    musicTools: { execute: async () => { throw new Error('must not play attachments'); } },
  });
  try {
    await bridge.accept({ ...message('attached-command', '/music stop'), plainText: false, files: [{ name: 'fixture.txt' }] });
    assert.equal(replies.length, 1); assert.match(replies[0], /移除附件/);
  } finally { lifetime.abort(); }
});

test('music uses the same member/voice policy on text and native paths without changing AI permissions', async () => {
  const lifetime = new AbortController(), calls = [], replies = [];
  const bridge = new DiscordHarnessBridge({ signal: lifetime.signal, state: state(), harness: {},
    accessPolicy: { getSettings: () => createAccessPolicy() },
    bot: { sendText: async (target, text) => replies.push(text) },
    musicTools: { execute: async verb => { calls.push(verb); return { message: 'music accepted' }; } },
  });
  try {
    await bridge.accept(message('music', '/music stop'));
    await bridge.accept(message('chat', 'ordinary chat'));
    assert.deepEqual(calls, ['stop']); assert.deepEqual(replies, ['music accepted']);
  } finally { lifetime.abort(); }
});

test('music mentions stay in the invoking channel even when automatic chat threads are enabled', async () => {
  const previous = process.env.DSK_DISCORD_THREAD_ON_MENTION; process.env.DSK_DISCORD_THREAD_ON_MENTION = '1';
  try {
    const routed = await resolveDiscordMessageRoute({ id: 'msg', channel_id: 'room', guild_id: 'guild', author: { id: 'user' },
      mentions: [{ id: 'bot' }], content: '<@bot> /play song' }, 'bot', {
      channel: { id: 'room', type: 0 }, api: { getChannel: async () => { throw new Error('already known'); },
        startThreadFromMessage: async () => { throw new Error('music must not create a thread'); } },
    });
    assert.equal(routed.conversationId, 'room'); assert.equal(routed.guildId, 'guild');
  } finally { if (previous === undefined) delete process.env.DSK_DISCORD_THREAD_ON_MENTION; else process.env.DSK_DISCORD_THREAD_ON_MENTION = previous; }
});

test('native thread and DM AI controls resolve the same session keys as text messages', async () => {
  for (const [guild, key] of [['guild', 'group:thread'], [null, 'direct:thread']]) {
    const lifetime = new AbortController(); let stops = 0;
    const bridge = new DiscordHarnessBridge({ signal: lifetime.signal, bot: { sendText: async () => {} },
      state: { sessionFor: actual => { assert.equal(actual, key); return 'session'; } },
      harness: { workspaceSession: (session, actual) => { assert.equal(actual, key); return {
        stopActiveTurn: async control => { assert.equal(control.key, key); stops++; return true; },
      }; } },
    });
    try {
      await handleApplicationCommand({ type: 2, id: 'interaction', token: 'fixture', channel_id: 'thread',
        channel: { type: 11, parent_id: 'parent' }, ...(guild ? { guild_id: guild } : {}), user: { id: 'user' }, data: { name: 'stop' } },
      { bridge, applicationId: 'app', api: { createInteractionResponse: async () => {}, updateInteractionOriginal: async () => {} } });
      assert.equal(stops, 1);
    } finally { lifetime.abort(); }
  }
});

test('cancelled and oversized native replies finish their own public response', async () => {
  for (const result of ['x'.repeat(4000), Object.assign(new Error('cancelled'), { code: 'turn-stopped' })]) {
    let reply;
    await handleApplicationCommand({ type: 2, id: 'interaction', token: 'fixture', channel_id: 'room', guild_id: 'guild',
      user: { id: 'user' }, data: { name: 'music', options: [{ type: 1, name: 'queue' }] } }, {
      applicationId: 'app', api: { createInteractionResponse: async () => {}, updateInteractionOriginal: async (app, token, body) => { reply = body; } },
      bridge: { runNativeCommand: async () => { if (result instanceof Error) throw result; return result; } },
    });
    assert(reply.content.length <= 2000); assert.deepEqual(reply.allowed_mentions, { parse: [] });
    assert.match(reply.content, result instanceof Error ? /取消/ : /截短/);
  }
});

test('Gateway interaction redelivery executes once and stale callbacks cannot reach a reloaded player', async () => {
  const sockets = [], managers = [], acknowledgements = [], answers = []; let releaseAck;
  const runtime = new DiscordRuntime({ config: { platformId: 'bot', botId: 'fixture' }, token: 'fixture-only', state: state(), harness: { ensureRunning: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
    createMusicManager: () => { const manager = { calls: [], execute: async (verb, args) => { await args.ready; args.signal.throwIfAborted(); manager.calls.push(verb); return { message: 'queued' }; }, destroy: async () => {} }; managers.push(manager); return manager; },
    createApi: () => ({ getCurrentUser: async () => ({ id: 'bot', bot: true }), getGatewayBot: async () => ({ url: 'wss://fixture.invalid' }),
      getCurrentApplication: async () => ({ id: 'app' }), putGlobalApplicationCommands: async () => [],
      createInteractionResponse: async id => { acknowledgements.push(id); if (id === 'old') await new Promise(resolve => { releaseAck = resolve; }); },
      updateInteractionOriginal: async (app, token, reply) => { answers.push(reply.content); },
    }),
    createWebSocket: () => { const socket = new EventEmitter(); socket.readyState = 1; socket.send = () => {}; socket.close = () => { socket.readyState = 3; };
      sockets.push(socket); setTimeout(() => socket.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', d: {} }) }), 0); return socket; },
  });
  const deliver = id => sockets.at(-1).emit('message', { data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', d: {
    type: 2, id, token: 'fixture', channel_id: 'room', guild_id: 'guild', user: { id: 'user' }, data: { name: 'play', options: [{ type: 3, name: 'query', value: 'song' }] },
  } }) });
  try {
    await runtime.start(); deliver('once'); deliver('once');
    await until(() => answers.length === 1); assert.deepEqual(managers[0].calls, ['play']); assert.deepEqual(acknowledgements, ['once']);
    deliver('old'); await until(() => releaseAck); await runtime.stop(); await runtime.start(); releaseAck(); await tick();
    assert.deepEqual(managers[0].calls, ['play']); assert.deepEqual(managers[1].calls, []);
    deliver('fresh'); await until(() => managers[1].calls.length === 1);
  } finally { releaseAck?.(); await runtime.stop(); }
});

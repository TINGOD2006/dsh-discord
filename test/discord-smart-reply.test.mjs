import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSmartReply } from '../src/channels/discord/reply-policy.mjs';
import { MessageInputWindow } from '../src/channels/shared/conversation/input-window.mjs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';

const base = { messageId: 'one', senderId: 'user', kind: 'group', conversationId: 'room', content: '', plainText: true, images: [], files: [] };
const decide = (content, extra = {}, options = {}) => decideSmartReply({ ...base, content, ...extra }, { botId: 'bot', ...options });

/** Prompts reach the bridge as content blocks; these assertions care about text. */
const promptText = (prompt) => (
  typeof prompt === 'string'
    ? prompt
    : Array.isArray(prompt) ? prompt.map((block) => block?.text ?? '').join('\n') : String(prompt ?? '')
);

test('smart replies answer direct requests and bot replies while keeping member conversations quiet', () => {
  for (const text of ['幫我', '請分析這個程式', '2+2是多少？', '如何改善速度', 'What is this?', '幫我查聊天記錄']) assert.equal(decide(text).reply, true, text);
  for (const text of ['好', '謝謝', '收到！', '👍', '哈哈', '我剛下班', '今天吃了麵']) assert.equal(decide(text).reply, false, text);
  assert.equal(decide('可以幫我嗎', { replyTo: { authorId: 'other' } }).reply, false);
  assert.equal(decide('我剛下班', { mentionedUserIds: ['other'] }).reply, false);
  assert.equal(decide('如何修復', { mentionedUserIds: ['other'] }).reply, false);
  // The owner asked for this mode; their plain chatter is still meant for the bot.
  assert.equal(decide('我剛下班', {}, { fromOwner: true }).reply, true);
  assert.equal(decide('幫我報警抓他 @other', { mentionedUserIds: ['other'] }, { fromOwner: true }).reply, true);
  assert.equal(decide('好', {}, { fromOwner: true }).reply, false);
  assert.equal(decide('謝謝', { addressed: true }).reply, true);
  assert.equal(decide('好', { replyTo: { authorId: 'bot' } }).reply, true);
  assert.equal(decide('/stop', {}, { commandLike: true }).reply, true);
  assert.equal(decide('2', {}, { expectedAnswer: true }).reply, true);
});

test('short follow-ups require an active conversation or a compatible open input window', () => {
  assert.equal(decide('再短一點').reply, false);
  assert.equal(decide('再短一點', {}, { activeFollowup: true }).reply, true);
  assert.equal(decide('這段程式碼', {}, { continuation: true }).reply, true);
  assert.equal(decide('謝謝', {}, { continuation: true, activeFollowup: true }).reply, false);
  assert.equal(decide('再短一點', { replyTo: { authorId: 'other' } }, { activeFollowup: true }).reply, false);
});

test('traditional and Cantonese questions are not silently ignored', () => {
  for (const text of ['凍河諧音梗是甚麼', '點解咁慢', '邊個係主人', '係咪壞咗', '有冇人', '點樣改']) {
    assert.equal(decide(text).reply, true, text);
  }
  // Simplified forms keep working.
  assert.equal(decide('这是什么').reply, true);
});

test('a bare question mark asks to be answered while stickers stay silent', () => {
  assert.equal(decide('？？？').reply, true);
  assert.equal(decide('?').reply, true);
  assert.equal(decide('').reply, false);
  assert.equal(decide('👍').reply, false);
  assert.equal(decide('<:Osaka_cry:1>').reply, false);
});

test('casual imperatives count as requests', () => {
  for (const text of ['啟動一下原神', '装个原神', '安裝這個', '陪我聊兩句', '教我寫這個']) {
    assert.equal(decide(text).reply, true, text);
  }
  // Plain statements still stay quiet.
  for (const text of ['我剛下班', '今天吃了麵', '開會中']) assert.equal(decide(text).reply, false, text);
});

test('momentum answers a person the bot was just talking to', () => {
  assert.equal(decide('是Donk').reply, false);
  assert.equal(decide('是Donk', {}, { momentum: true }).reply, true);
  assert.equal(decide('你針對我', {}, { momentum: true }).reply, true);
  // Acknowledgements and messages aimed at another member stay quiet.
  assert.equal(decide('謝謝', {}, { momentum: true }).reply, false);
  assert.equal(decide('是Donk', { mentionedUserIds: ['other'] }, { momentum: true }).reply, false);
});

function clock() {
  let at = 0, seq = 0; const timers = new Map();
  return {
    now: () => at,
    setTimer(fn, delay) { const id = ++seq; timers.set(id, { fn, at: at + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const end = at + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        at = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      at = end;
    },
  };
}

test('input windows reset the quiet deadline, cap total delay and keep the latest reply target', async () => {
  const time = clock(), saves = [];
  const window = new MessageInputWindow({ ...base, content: '幫我', replyTarget: { replyToMessageId: 'one' } }, {
    quietMs: 1200, maxWaitMs: 4000, ...time, persist: async message => saves.push(message.content),
  });
  let ready = false; const finished = window.ready.then(value => { ready = true; return value; });
  time.advance(1000);
  assert.equal(window.append({ ...base, messageId: 'two', content: '分析這段', replyTarget: { replyToMessageId: 'two' } }), true);
  time.advance(1000); assert.equal(ready, false);
  window.append({ ...base, messageId: 'three', content: '再附上建議' });
  time.advance(1000); assert.equal(ready, false);
  window.append({ ...base, messageId: 'four', content: '用中文回答' });
  time.advance(1000); assert.equal(await finished, true);
  assert.match(window.message.content, /幫我\n\n分析這段/);
  assert.equal(window.message.messageId, 'one');
  assert.deepEqual(window.message.coalescedEventIds, ['two', 'three', 'four']);
  assert.equal(window.message.replyTarget.replyToMessageId, 'two');
  assert.equal(saves.length, 3);
});

test('input windows never combine another actor, another conversation or oversized input; cancellation releases the waiter', async () => {
  const time = clock();
  const window = new MessageInputWindow({ ...base, content: '幫我', replyTo: { messageId: 'quoted' } }, { ...time });
  assert.equal(window.canAppend({ ...base, senderId: 'another', content: '內容' }), false);
  assert.equal(window.canAppend({ ...base, conversationId: 'elsewhere', content: '內容' }), false);
  assert.equal(window.canAppend({ ...base, content: 'x'.repeat(20000) }), false);
  assert.equal(window.canAppend({ ...base, content: '', plainText: false }), false);
  window.finish({ cancel: true });
  assert.equal(await window.ready, false);
  time.advance(10000);
  assert.equal(window.closed, true);
});

test('a quote or an attachment no longer splits one person burst into two turns', async () => {
  const time = clock(), saves = [];
  const window = new MessageInputWindow({ ...base, content: '幫我', replyTo: { messageId: 'quoted' } }, {
    ...time, persist: async message => saves.push(message.content),
  });
  // Replying to a different message, then sending a picture, still belongs to the
  // same request: the first message keeps the reply target.
  assert.equal(window.append({ ...base, messageId: 'two', content: '看這個', replyTo: { messageId: 'other' } }), true);
  assert.equal(window.append({ ...base, messageId: 'three', content: '', images: [{ url: 'a.png' }] }), true);
  assert.equal(window.append({ ...base, messageId: 'four', content: '順便說一下', files: [{ name: 'a.txt' }] }), true);
  time.advance(1200);
  assert.equal(await window.ready, true);
  assert.equal(window.message.content, '幫我\n\n看這個\n\n順便說一下');
  assert.deepEqual(window.message.images, [{ url: 'a.png' }]);
  assert.deepEqual(window.message.files, [{ name: 'a.txt' }]);
  assert.deepEqual(window.message.coalescedEventIds, ['two', 'three', 'four']);
  assert.equal(window.message.replyTo.messageId, 'quoted');
  assert.equal(saves.length, 3);
});

test('stop can still cancel after the quiet timer fires while a durable save is finishing', async () => {
  const time = clock(); let release;
  const window = new MessageInputWindow({ ...base, content: '幫我' }, { ...time,
    persist: () => new Promise(resolve => { release = resolve; }) });
  window.append({ ...base, messageId: 'two', content: '分析這段' });
  await Promise.resolve();
  time.advance(1200);
  assert.equal(window.closed, true);
  window.finish({ cancel: true }); release();
  assert.equal(await window.ready, false);
});

test('a failed best-effort staging write does not create an unhandled rejection or strand the window', async () => {
  const time = clock();
  const window = new MessageInputWindow({ ...base, content: '幫我' }, { ...time,
    persist: () => Promise.reject(new Error('fixture disk failure')) });
  window.append({ ...base, messageId: 'two', content: '分析這段' });
  await new Promise(resolve => setImmediate(resolve));
  time.advance(1200);
  assert.equal(await window.ready, true);
});

test('a restart during an input window recovers the merged text once, with all message IDs and the newest reply target', async () => {
  const root = resolve('work/test-smart-durability'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'case-'));
  const lifetime = new AbortController(), recoveryLifetime = new AbortController();
  const prompts = [], targets = [];
  const harness = { createSession: async () => 'session', workspaceSession: () => ({ sessionExists: async () => true,
    ask: async prompt => { prompts.push(prompt); return 'answer'; } }) };
  const bot = { sendText: async target => { targets.push(target); } };
  try {
    const statePath = join(dir, 'original.json');
    const state = await new DiscordStateStore(statePath).load();
    const bridge = new DiscordHarnessBridge({ state, harness, bot, signal: lifetime.signal, chatOrder: 'fifo' });
    const first = bridge.accept({ ...base, content: '幫我', addressed: true, replyDelay: { quietMs: 3000, maxWaitMs: 4000 }, replyTarget: { replyToMessageId: 'one' } });
    const second = bridge.accept({ ...base, messageId: 'two', content: '分析這段', addressed: true, replyDelay: { quietMs: 3000, maxWaitMs: 4000 }, replyTarget: { replyToMessageId: 'two' } });
    await new Promise(resolve => setImmediate(resolve));
    await state.persist();
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(saved.pendingMessages.length, 1);
    assert.equal(saved.pendingMessages[0].text, '幫我\n\n分析這段');
    assert.deepEqual(saved.pendingMessages[0].coalescedMessageIds, ['two']);
    lifetime.abort(); await Promise.all([first, second]); await bridge.waitForIdle();
    assert.equal(prompts.length, 0);
    assert.equal(state.pendingMessages().length, 1, 'a lifecycle shutdown preserves the staged turn');
    const recovered = await new DiscordStateStore(statePath).load();
    const next = new DiscordHarnessBridge({ state: recovered, harness, bot, signal: recoveryLifetime.signal, chatOrder: 'fifo', logger: { warn() {}, error() {} } });
    await next.waitForIdle();
    assert.equal(prompts.length, 1, 'the staged turn is recovered exactly once');
    assert.match(promptText(prompts[0]), /幫我\n\n分析這段/);
    assert.equal(recovered.hasSeen('one'), true); assert.equal(recovered.hasSeen('two'), true);
    assert.equal(recovered.pendingMessages().length, 0);
    assert.equal(targets.at(-1).replyToMessageId, 'two');
  } finally {
    lifetime.abort(); recoveryLifetime.abort();
    assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

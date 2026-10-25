import test from 'node:test';
import assert from 'node:assert/strict';
import { musicIntentActions } from '../src/channels/shared/music-access.mjs';
import { historyContextNeeded, historyRecallRequested, filterHistoryRows, boundHistoryPage, cleanHistoryText } from '../src/channels/shared/history-context.mjs';

test('song titles are operands, not negations, explanations or additional player commands', () => {
  for (const text of ["播放 Don't Stop Me Now", '播放不要說話', '播放 How Do You Do', '請播放「暫停」', 'play Never Gonna Give You Up', 'please play Stop the Game']) {
    assert.deepEqual(musicIntentActions(text), ['play'], text);
  }
});

test('colloquial controls and separated clauses grant only the requested music actions', () => {
  for (const [text, expected] of [
    ['聲音小一點', ['volume']], ['小聲一點', ['volume']], ['幫我把音樂關掉', ['stop']],
    ['幫我放晴天', ['play']], ['please turn it down', ['volume']], ['make it louder', ['volume']], ['turn the music off', ['stop']],
    ['把音樂停掉', ['stop']], ['不要停，繼續播放', ['resume']], ["don't stop, keep playing", ['resume']],
    ["請播放 Don't Stop Me Now，然後把音量設成35", ['play', 'volume']],
    ['不要播放晴天，改成播放夜曲', ['play']], ['不要把音樂關掉，請暫停', ['pause']],
  ]) assert.deepEqual(musicIntentActions(text), expected, text);
});

test('negative requests, instruction examples and non-music controls still grant no music access', () => {
  for (const text of [
    '不要播放晴天', '請勿暫停音樂', '音樂不要暫停', "don't play a song", 'do not stop music',
    '請教我怎麼播放音樂', '解釋播放指令', '播放音樂這個指令是什麼意思', '播放音樂要怎麼操作', '如何把音量調低', '為什麼要暫停音樂',
    '「不要停，繼續播放」是什麼意思', '> 播放晴天\n這是引用', '```\nplay music\n```',
    '他說暫停音樂', '暫停下載任務', '停止AI任務', 'play chess', "'pause'", "'Bob's Pause Music'", '```\npause music',
  ]) assert.deepEqual(musicIntentActions(text), [], text);
});

test('time words in self-contained questions do not request an archive read', () => {
  for (const content of [
    '剛剛下了一場雨，解釋雨是怎麼形成的', '刚刚买了一杯咖啡，咖啡因有什么作用？', '剛剛發生地震，為什麼會地震？',
    '上面這段文字是「hello」，請翻譯成中文', '那個叫快速排序的演算法怎麼寫？',
    'I just bought a piano. What is middle C?',
  ]) assert.equal(historyContextNeeded({ content }), false, content);
});

test('explicit recall and unresolved references keep archive access available', () => {
  for (const content of ['總結之前聊的內容', '昨天聊了什麼', '找聊天記錄', '剛剛說的那個是什麼', '那張圖片在說什麼', '上面那份文件', '上面這段文字是什麼意思', '繼續剛才的討論', 'What did Alice say earlier?', 'what about that image?']) {
    assert.equal(historyContextNeeded({ content }), true, content);
  }
  assert(historyRecallRequested('剛剛說的那個'));
});

test('supplied reply text or current images satisfy implicit references without another archive read', () => {
  assert.equal(historyContextNeeded({ content: '那張圖片在說什麼', images: [{}] }), false);
  assert.equal(historyContextNeeded({ content: '那個是什麼意思', replyTo: { content: '已提供的引用內容' } }), false);
  assert.equal(historyContextNeeded({ content: '總結之前聊的內容', replyTo: { content: '這只是其中一條' } }), true);
});

const rows = texts => texts.map((text, index) => ({ id: String(index), messageId: String(index), senderId: 'u', text, sentAt: 20000 - index * 1000, fileCount: 0, attachments: [] }));
test('deduplication preserves technical symbols, number separators, filenames, case and question marks', () => {
  for (const texts of [
    ['C++', 'C#'], ['x=1', 'x!=1'], ['1.5', '15'], ['-5', '5'], ['x²', 'x2'],
    ['a-b.txt', 'ab.txt'], ['/tmp/a', '/tmpa'], ['UserID', 'userid'], ['好？', '好！'], ['re sign', 'resign'],
  ]) {
    assert.equal(filterHistoryRows(rows(texts)).length, 2, JSON.stringify(texts));
    assert.equal(boundHistoryPage({ items: rows(texts), nextCursor: null }, 'g', 'messages', 4000).items.length, 2, JSON.stringify(texts));
  }
  assert.equal(cleanHistoryText('x²'), 'x²');
});

test('short repeated chatter is still deduped while attachments and different replies survive', () => {
  assert.equal(filterHistoryRows(rows(['哈哈！！', '哈 哈'])).length, 1);
  assert.equal(filterHistoryRows(rows(['same message', 'same message'])).length, 1);
  assert.equal(filterHistoryRows(rows(['哈哈', '哈哈']).map((row, index) => ({ ...row, replyToMessageId: String(index) }))).length, 2);
  assert.equal(filterHistoryRows(rows(['same', 'same']).map(row => ({ ...row, fileCount: 1 }))).length, 2);
});

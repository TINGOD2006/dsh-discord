import assert from 'node:assert/strict';
import test from 'node:test';

import { stripInternalLeaks } from '../src/channels/shared/outbound-sanitize.mjs';
import { createTextDeliveryBlock } from '../src/channels/shared/semantic/delivery.mjs';

test('ordinary chat text is untouched', () => {
  const text = '嘿嘿，被主人看出来了。那我可以直说嘛，我想吃白饭。';
  assert.equal(stripInternalLeaks(text), text);
});

test('memory node ids and bookkeeping lines are dropped', () => {
  const text = '好的\nmem_20261027_ab12 已写入记忆\n下一句';
  assert.equal(stripInternalLeaks(text), '好的\n下一句');
});

test('a recited runtime-context snapshot is cut with everything after it', () => {
  const text = [
    '我想吃白饭。',
    '',
    '',
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    '',
    'Current working directory: "C:\\\\work"',
    'Approval policy: ask.',
  ].join('\n');
  assert.equal(stripInternalLeaks(text), '我想吃白饭。');
});

test('a recited host persona is cut from its heading', () => {
  const text = '我回来了\n\n## 人格设定（AGENT.md）\n以下是用户为本机写下的角色/性格设定…';
  assert.equal(stripInternalLeaks(text), '我回来了');
});

test('memory replay blocks are cut at either tag form', () => {
  const plain = '在的\n<untrusted-memory>\n【灵枢最近记忆】\n- [contextual] 早上好\n</untrusted-memory>';
  assert.equal(stripInternalLeaks(plain), '在的');
  const escaped = String.raw`在的
\u003cuntrusted-memory\u003e
【本会话近期对话】
[user] 早上好`;
  assert.equal(stripInternalLeaks(escaped), '在的');
});

test('an injected context tag mid-line only loses the tag and its tail', () => {
  const text = '收到 <dsh_im_source>{"channel":"discord"}</dsh_im_source> 后面的提示词';
  assert.equal(stripInternalLeaks(text), '收到');
});

test('a reply made only of internal text becomes empty', () => {
  const text = '<dsh_im_reply_to>{"content":"x"}</dsh_im_reply_to>';
  assert.equal(stripInternalLeaks(text), '');
});

test('delivery blocks are filtered before they leave the bridge', () => {
  const block = createTextDeliveryBlock('好\n\nCurrent runtime context.\nCurrent working directory: "C:\\\\work"');
  assert.deepEqual(block, { kind: 'text', text: '好', format: 'plain' });
  assert.throws(
    () => createTextDeliveryBlock('Current runtime context.'),
    /non-empty text/,
  );
  assert.throws(() => createTextDeliveryBlock('   '), /non-empty text/);
  assert.throws(() => createTextDeliveryBlock('ok', 'html'), /plain or markdown/);
});

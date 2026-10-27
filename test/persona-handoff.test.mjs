import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  HANDOFF_DIR_NAME,
  MAX_HANDOFF_CHARS,
  MIN_HANDOFF_TURNS,
  buildHandoffPrompt,
  handoffDirPath,
  handoffFilePath,
  readHandoff,
  sanitizeHandoff,
} from '../src/channels/discord/persona-handoff.mjs';

const USER = (text) => ({ role: 'user', text });
const ASSISTANT = (text) => ({ role: 'assistant', text });

/** Four visible messages, the minimum a prompt is built from. */
function minimalConversation() {
  return [
    USER('帮我把这个脚本改成 ESM'),
    ASSISTANT('好，先看 import 语句'),
    USER('顺便把测试也补上'),
    ASSISTANT('测试写在 test/ 下，用 node:test'),
  ];
}

test('buildHandoffPrompt refuses conversations below the minimum length', () => {
  assert.equal(buildHandoffPrompt([]), null);
  assert.equal(buildHandoffPrompt(null), null);
  assert.equal(buildHandoffPrompt('not a list'), null);
  assert.equal(buildHandoffPrompt(minimalConversation().slice(0, MIN_HANDOFF_TURNS - 1)), null);
});

test('buildHandoffPrompt ignores entries that carry no visible text', () => {
  const messages = [
    ...minimalConversation().slice(0, MIN_HANDOFF_TURNS - 1),
    USER('   '),
    ASSISTANT(''),
    { role: 'system', text: 'ignored' },
    { role: 'user' },
    null,
  ];
  assert.equal(buildHandoffPrompt(messages), null);
  // One more real turn crosses the floor again.
  assert.notEqual(buildHandoffPrompt([...messages, USER('继续')]), null);
});

test('buildHandoffPrompt states the 800-char budget and the three hard constraints', () => {
  const prompt = buildHandoffPrompt(minimalConversation());
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.includes('800'));
  assert.ok(prompt.includes('第三人称'));
  assert.ok(prompt.includes('不要自称'));
  assert.ok(prompt.includes('不要模仿语气'));
});

test('buildHandoffPrompt inlines the conversation oldest-to-newest', () => {
  const prompt = buildHandoffPrompt(minimalConversation());
  const first = prompt.indexOf('帮我把这个脚本改成 ESM');
  const last = prompt.indexOf('测试写在 test/ 下');
  assert.ok(first > 0);
  assert.ok(last > first);
  assert.ok(prompt.includes('[用户]'));
  assert.ok(prompt.includes('[助手]'));
});

test('buildHandoffPrompt keeps only the newest turns so the prompt stays bounded', () => {
  const messages = Array.from({ length: 100 }, (_, index) => USER(`第${index}条消息`));
  const prompt = buildHandoffPrompt(messages);
  assert.ok(prompt.includes('第99条消息'));
  assert.ok(!prompt.includes('第0条消息'));
  assert.ok(!prompt.includes('第59条消息'));
  assert.ok(prompt.includes('第60条消息'));
});

test('buildHandoffPrompt clips a single enormous turn', () => {
  const prompt = buildHandoffPrompt([USER('x'.repeat(5000)), ...minimalConversation().slice(1)]);
  assert.ok(prompt.length < 3000);
  assert.ok(!prompt.includes('x'.repeat(2000)));
});

test('sanitizeHandoff trims, normalises newlines and collapses blank runs', () => {
  assert.equal(sanitizeHandoff('  hello \r\n\r\n\r\n\r\nworld  '), 'hello\n\nworld');
  assert.equal(sanitizeHandoff(''), '');
  assert.equal(sanitizeHandoff('   \n\t '), '');
  assert.equal(sanitizeHandoff(null), '');
  assert.equal(sanitizeHandoff(undefined), '');
  assert.equal(sanitizeHandoff(42), '');
});

test('sanitizeHandoff drops a leading first-person opener', () => {
  assert.equal(sanitizeHandoff('我是这个群里的助手，用户想改脚本。'), '这个群里的助手，用户想改脚本。');
  assert.equal(sanitizeHandoff('我们的对话主要在改脚本。'), '对话主要在改脚本。');
  assert.equal(sanitizeHandoff('本助手记录了三点。'), '记录了三点。');
  assert.equal(sanitizeHandoff('  我觉得用户想要 ESM。'), '用户想要 ESM。');
  // Third-person text is left untouched.
  assert.equal(sanitizeHandoff('用户想改脚本，助手补了测试。'), '用户想改脚本，助手补了测试。');
});

test('sanitizeHandoff hard-truncates to the budget with an ellipsis', () => {
  const long = '用'.repeat(MAX_HANDOFF_CHARS + 200);
  const result = sanitizeHandoff(long);
  assert.equal(result.length, MAX_HANDOFF_CHARS);
  assert.ok(result.endsWith('…'));
  // Exactly at budget: untouched, no ellipsis added.
  const exact = 'a'.repeat(MAX_HANDOFF_CHARS);
  assert.equal(sanitizeHandoff(exact), exact);
});

test('sanitizeHandoff is idempotent', () => {
  const once = sanitizeHandoff('我是记录者。\n\n\n用户想要 ESM。');
  assert.equal(sanitizeHandoff(once), once);
});

test('handoffDirPath follows the persona-store DSH_HOME convention', () => {
  assert.equal(
    handoffDirPath({ dshHome: '/tmp/home' }),
    join('/tmp/home', 'integrations', 'dsh-discord', HANDOFF_DIR_NAME),
  );
  // No config and no env var: the same default root persona-store.mjs uses.
  const saved = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    assert.equal(handoffDirPath(), join(homedir(), '.dsh', 'integrations', 'dsh-discord', HANDOFF_DIR_NAME));
    process.env.DSH_HOME = '/tmp/from-env';
    assert.equal(handoffDirPath({}), join('/tmp/from-env', 'integrations', 'dsh-discord', HANDOFF_DIR_NAME));
    // An explicit config wins over the environment.
    assert.equal(handoffDirPath({ dshHome: '/tmp/explicit' }), join('/tmp/explicit', 'integrations', 'dsh-discord', HANDOFF_DIR_NAME));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});

test('handoffFilePath sanitises conversation keys into legal file names', () => {
  const config = { dshHome: '/tmp/home' };
  assert.equal(
    handoffFilePath(config, 'group:123'),
    join('/tmp/home', 'integrations', 'dsh-discord', HANDOFF_DIR_NAME, 'group-123.md'),
  );
  assert.equal(handoffFilePath(config, 'direct:456'), join(handoffDirPath(config), 'direct-456.md'));
  // Nothing may escape the directory or collide with it.
  assert.equal(handoffFilePath(config, '../../etc/passwd'), join(handoffDirPath(config), '..-..-etc-passwd.md'));
  assert.equal(handoffFilePath(config, '..'), join(handoffDirPath(config), '_.md'));
  assert.equal(handoffFilePath(config, ''), join(handoffDirPath(config), '_.md'));
  // One dash per illegal character: reproducible without any smart collapsing.
  assert.equal(handoffFilePath(config, 'group 123 中文'), join(handoffDirPath(config), 'group-123---.md'));
});

test('readHandoff returns the stored note, or empty when there is none', () => {
  const config = { dshHome: join(homedir(), '.dsh-does-not-exist-12345') };
  assert.equal(readHandoff(config, 'group:123'), '');
  assert.equal(readHandoff(config, null), '');
});

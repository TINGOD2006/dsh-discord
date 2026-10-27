import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_HANDOFF_CHARS,
  generateHandoff,
  handoffFilePath,
  sanitizeHandoff,
} from '../src/channels/discord/persona-handoff.mjs';

const CONVERSATION = [
  { role: 'user', text: '帮我把这个脚本改成 ESM' },
  { role: 'assistant', text: '好，先看 import 语句' },
  { role: 'user', text: '顺便把测试也补上' },
  { role: 'assistant', text: '测试写在 test/ 下，用 node:test' },
];

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'discord-handoff-'));
  return {
    config: { dshHome: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Collects every effect so a test can assert both sides of the contract. */
function harness({ history = CONVERSATION, answer = '用户想把脚本改成 ESM，助手已补测试。', ...overrides } = {}) {
  const calls = { history: [], prompts: [], writes: [] };
  const deps = {
    readHistory: (sessionId) => {
      calls.history.push(sessionId);
      return history;
    },
    runIsolated: (prompt) => {
      calls.prompts.push(prompt);
      return answer;
    },
    write: (path, text) => {
      calls.writes.push({ path, text });
    },
    ...overrides,
  };
  return { calls, deps };
}

test('generateHandoff writes the sanitized answer under handoffs/<key>.md', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { calls, deps } = harness({ answer: '我是记录者，用户想把脚本改成 ESM，助手已补测试。' });
    const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-1', key: 'group:123' });

    assert.deepEqual(result, { ok: true, path: handoffFilePath(config, 'group:123') });
    assert.match(result.path, /handoffs[\\/]group-123\.md$/u);
    assert.deepEqual(calls.history, ['sess-1']);
    assert.equal(calls.prompts.length, 1);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.writes[0].path, result.path);
    // The note is stored already neutral: no first-person opener.
    assert.equal(calls.writes[0].text, '记录者，用户想把脚本改成 ESM，助手已补测试。');
    assert.equal(calls.writes[0].text, sanitizeHandoff('我是记录者，用户想把脚本改成 ESM，助手已补测试。'));
  } finally {
    cleanup();
  }
});

test('generateHandoff stores what a real write would persist', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { deps } = harness({ answer: '用户想把脚本改成 ESM。\n\n\n助手已补测试。' });
    // Swap in a real filesystem writer to prove the path is usable as-is.
    const write = (path, text) => {
      mkdirSync(join(config.dshHome, 'integrations', 'dsh-discord', 'handoffs'), { recursive: true });
      writeFileSync(path, `${text}\n`, 'utf8');
    };
    const result = await generateHandoff({ ...deps, write, config }, { sessionId: 'sess-2', key: 'direct:456' });
    assert.equal(result.ok, true);
    const stored = readFileSync(result.path, 'utf8');
    assert.equal(stored, '用户想把脚本改成 ESM。\n\n助手已补测试。\n');
  } finally {
    cleanup();
  }
});

test('generateHandoff refuses a conversation below the minimum length', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { calls, deps } = harness({ history: CONVERSATION.slice(0, 2) });
    const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-3', key: 'group:1' });
    assert.deepEqual(result, { ok: false, reason: 'too-short' });
    // Short conversation never reaches the model, so nothing is written.
    assert.equal(calls.prompts.length, 0);
    assert.equal(calls.writes.length, 0);
  } finally {
    cleanup();
  }
});

test('a throwing readHistory degrades to history-failed without writing', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { calls, deps } = harness({
      readHistory: () => {
        throw new Error('session.history exploded');
      },
    });
    const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-4', key: 'group:2' });
    assert.deepEqual(result, { ok: false, reason: 'history-failed' });
    assert.equal(calls.writes.length, 0);
  } finally {
    cleanup();
  }
});

test('an empty or whitespace answer counts as a failure, not an empty note', async () => {
  const { config, cleanup } = tempHome();
  try {
    for (const answer of ['', '   \n\t ', null, undefined]) {
      // Override the runner directly: the default parameter would swallow
      // `undefined` before it ever reaches the module under test.
      const { calls, deps } = harness({ runIsolated: () => answer, answer: 'unused' });
      const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-5', key: 'group:3' });
      assert.deepEqual(result, { ok: false, reason: 'empty' }, `answer=${JSON.stringify(answer)}`);
      assert.equal(calls.writes.length, 0);
    }
  } finally {
    cleanup();
  }
});

test('a throwing runIsolated is contained rather than propagated', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { calls, deps } = harness({
      runIsolated: () => {
        throw new Error('model timeout');
      },
    });
    const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-6', key: 'group:3' });
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.equal(calls.writes.length, 0);
  } finally {
    cleanup();
  }
});

test('a throwing write does not escape into the caller', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { deps } = harness({
      write: () => {
        throw new Error('EACCES');
      },
    });
    const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-7', key: 'group:4' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-failed');
  } finally {
    cleanup();
  }
});

test('the stored note never exceeds the character budget', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { calls, deps } = harness({ answer: `我是助手。${'用'.repeat(MAX_HANDOFF_CHARS + 400)}` });
    const result = await generateHandoff({ ...deps, config }, { sessionId: 'sess-8', key: 'group:5' });
    assert.equal(result.ok, true);
    assert.ok(calls.writes[0].text.length <= MAX_HANDOFF_CHARS);
  } finally {
    cleanup();
  }
});

test('the prompt handed to runIsolated carries the hard constraints', async () => {
  const { config, cleanup } = tempHome();
  try {
    const { calls, deps } = harness();
    await generateHandoff({ ...deps, config }, { sessionId: 'sess-9', key: 'group:6' });
    const prompt = calls.prompts[0];
    assert.ok(prompt.includes('第三人称'));
    assert.ok(prompt.includes('不要自称'));
    assert.ok(prompt.includes('不要模仿语气'));
    assert.ok(prompt.includes('帮我把这个脚本改成 ESM'));
  } finally {
    cleanup();
  }
});

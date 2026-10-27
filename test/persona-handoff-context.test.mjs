import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DISCORD_HANDOFF_CONTEXT_NAME, DISCORD_HANDOFF_TITLE, installDiscordHandoff,
} from '../src/channels/discord/persona.mjs';
import { handoffFilePath } from '../src/channels/discord/persona-handoff.mjs';
import {
  rememberSessionChannel, rememberSessionConversation, resetSessionChannels,
} from '../src/channels/shared/session-channel-registry.mjs';

const CHANNEL = 'discord';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-handoff-ctx-'));
  try {
    return fn({ dshHome: root }, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function capture(config) {
  let context = null;
  const ctx = {
    systemPrompt: { context: (options) => { context = options; } },
    on: () => {},
  };
  installDiscordHandoff(ctx, { config });
  assert.ok(context, 'handoff context registered');
  assert.equal(context.name, DISCORD_HANDOFF_CONTEXT_NAME);
  assert.equal(context.order, 121);
  return context;
}

const assemble = (sessionId) => ({ agent: { session: { id: sessionId } } });

function writeHandoff(config, key, body) {
  const path = handoffFilePath(config, key);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return path;
}

test('injects the handoff summary for a discord session', () => withRoot((config) => {
  resetSessionChannels();
  const context = capture(config);
  rememberSessionChannel('s-switched', CHANNEL);
  rememberSessionConversation('s-switched', 'group:1');
  writeHandoff(config, 'group:1', '上一段裡主人問了 Phase 0 的結論。');
  const text = context.text(assemble('s-switched'));
  assert.ok(text.startsWith(DISCORD_HANDOFF_TITLE));
  assert.match(text, /Phase 0 的結論/u);
}));

test('leaves a session without a handoff file untouched', () => withRoot((config) => {
  resetSessionChannels();
  const context = capture(config);
  rememberSessionChannel('s-fresh', CHANNEL);
  rememberSessionConversation('s-fresh', 'group:2');
  assert.equal(context.text(assemble('s-fresh')), '');
}));

test('never injects into a non-discord session', () => withRoot((config) => {
  resetSessionChannels();
  const context = capture(config);
  rememberSessionChannel('s-web', 'web');
  rememberSessionConversation('s-web', 'web:1');
  writeHandoff(config, 'web:1', '不該被注入');
  assert.equal(context.text(assemble('s-web')), '');
}));

test('picks up a summary written after the session already started', () => withRoot((config) => {
  resetSessionChannels();
  const context = capture(config);
  rememberSessionChannel('s-late', CHANNEL);
  rememberSessionConversation('s-late', 'group:3');
  // First turn happens before the old session finishes summarizing.
  assert.equal(context.text(assemble('s-late')), '');
  writeHandoff(config, 'group:3', '後來才寫好的交接。');
  assert.match(context.text(assemble('s-late')), /後來才寫好的交接/u);
}));

test('re-reads when the file changes under a stable session', () => withRoot((config) => {
  resetSessionChannels();
  const context = capture(config);
  rememberSessionChannel('s-reread', CHANNEL);
  rememberSessionConversation('s-reread', 'group:4');
  const path = writeHandoff(config, 'group:4', '第一版摘要');
  assert.match(context.text(assemble('s-reread')), /第一版摘要/u);
  writeFileSync(path, '第二版摘要', 'utf8');
  const stamp = new Date(Date.now() + 5_000);
  utimesSync(path, stamp, stamp);
  assert.match(context.text(assemble('s-reread')), /第二版摘要/u);
}));

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCORD_PERSONA_CHANNEL, DISCORD_REPLY_HYGIENE_CONTEXT_NAME, DISCORD_REPLY_HYGIENE_PROMPT,
  installDiscordReplyHygiene,
} from '../src/channels/discord/persona.mjs';
import { rememberSessionChannel, resetSessionChannels } from '../src/channels/shared/session-channel-registry.mjs';

function captureContext() {
  const seen = [];
  const ctx = { systemPrompt: { context: (options) => seen.push(options) }, on: () => {} };
  return { ctx, seen };
}

function assemblyOf(sessionId) {
  return { agent: { session: { id: sessionId } } };
}

test('the hygiene rule is registered for Discord sessions only', (t) => {
  t.after(() => resetSessionChannels());
  rememberSessionChannel('s-discord', DISCORD_PERSONA_CHANNEL);
  rememberSessionChannel('s-web', 'web');
  const { ctx, seen } = captureContext();

  installDiscordReplyHygiene(ctx);

  assert.equal(seen[0].name, DISCORD_REPLY_HYGIENE_CONTEXT_NAME);
  assert.equal(seen[0].text(assemblyOf('s-discord')), DISCORD_REPLY_HYGIENE_PROMPT);
  assert.equal(seen[0].text(assemblyOf('s-web')), '');
  assert.equal(seen[0].text(assemblyOf('unknown')), '');
});

test('it lands after the persona and the handoff summary', () => {
  const { ctx, seen } = captureContext();
  installDiscordReplyHygiene(ctx);
  // persona=120, handoff=121: the rule has to be the last word on house style.
  assert.ok(seen[0].order > 121);
});

test('the rule names the narration it forbids, not just "be brief"', () => {
  for (const phrase of ['歸檔', '讀回', '工具', '路徑', '不寫進回覆']) {
    assert.ok(DISCORD_REPLY_HYGIENE_PROMPT.includes(phrase), `prompt should mention ${phrase}`);
  }
});

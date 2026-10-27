import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCORD_PERSONA_CONTEXT_NAME, DISCORD_PERSONA_CHANNEL, installDiscordPersona } from '../src/channels/discord/persona.mjs';
import { rememberSessionChannel, resetSessionChannels } from '../src/channels/shared/session-channel-registry.mjs';

function captureContext() {
  const seen = [];
  const ctx = {
    systemPrompt: { context: (options) => seen.push(options) },
    on: () => {},
  };
  return { ctx, seen };
}

function assemblyOf(sessionId) {
  return { agent: { session: { id: sessionId } } };
}

test('a function text is resolved on every Assemble, not frozen at install', (t) => {
  t.after(() => resetSessionChannels());
  rememberSessionChannel('s-live', DISCORD_PERSONA_CHANNEL);
  let current = 'v1';
  const { ctx, seen } = captureContext();

  installDiscordPersona(ctx, { text: () => current });

  assert.equal(seen[0].name, DISCORD_PERSONA_CONTEXT_NAME);
  assert.equal(seen[0].text(assemblyOf('s-live')), 'v1');
  current = 'v2';
  // Same registered context, new answer: this is what makes a persona switch
  // take effect without a host restart.
  assert.equal(seen[0].text(assemblyOf('s-live')), 'v2');
});

test('a function text is still empty for Sessions of other channels', (t) => {
  t.after(() => resetSessionChannels());
  rememberSessionChannel('s-web', 'web');
  const { ctx, seen } = captureContext();

  installDiscordPersona(ctx, { text: () => 'persona' });

  assert.equal(seen[0].text(assemblyOf('s-web')), '');
  assert.equal(seen[0].text(assemblyOf('unknown')), '');
});

test('a plain string text keeps working', (t) => {
  t.after(() => resetSessionChannels());
  rememberSessionChannel('s-str', DISCORD_PERSONA_CHANNEL);
  const { ctx, seen } = captureContext();

  installDiscordPersona(ctx, { text: 'fixed persona' });

  assert.equal(seen[0].text(assemblyOf('s-str')), 'fixed persona');
  assert.equal(seen[0].text(assemblyOf('s-other')), '');
});

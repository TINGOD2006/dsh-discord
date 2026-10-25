import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelOfPromptRpcId,
  forgetSessionChannel,
  rememberSessionChannel,
  resetSessionChannels,
  sessionChannelOf,
} from '../src/channels/shared/session-channel-registry.mjs';
import {
  DISCORD_PERSONA_CONTEXT_NAME,
  DISCORD_PERSONA_PROMPT,
  installDiscordPersona,
} from '../src/channels/discord/persona.mjs';

const UUID = '3f6f1f3c-9d5e-4a1b-8c2d-7e0a1b2c3d4e';

function fakeCtx() {
  const contexts = [];
  const listeners = [];
  return {
    contexts,
    listeners,
    systemPrompt: {
      context(spec) {
        contexts.push(spec);
        return () => {};
      },
    },
    on(type, listener, options) {
      listeners.push({ type, listener, options });
      return () => {};
    },
  };
}

function assemblyFor(sessionId) {
  if (sessionId === undefined) return { agent: { session: undefined } };
  return { agent: { session: { id: sessionId } } };
}

test('a prompt request id names the channel that built it', () => {
  assert.equal(channelOfPromptRpcId(`discord-${UUID}`), 'discord');
  assert.equal(channelOfPromptRpcId(`discord-steer-${UUID}`), 'discord');
  assert.equal(channelOfPromptRpcId(`weixin-${UUID}`), 'weixin');
  assert.equal(channelOfPromptRpcId(`wecomapp-${UUID}`), 'wecomapp');
  assert.equal(channelOfPromptRpcId('im'), null);
  assert.equal(channelOfPromptRpcId(`${UUID}`), null);
  assert.equal(channelOfPromptRpcId('discord-not-a-uuid'), null);
  assert.equal(channelOfPromptRpcId(undefined), null);
});

test('the registry remembers, replaces, forgets, and resets a pairing', () => {
  resetSessionChannels();
  assert.equal(sessionChannelOf('s1'), null);
  assert.equal(sessionChannelOf(undefined), null);

  assert.equal(rememberSessionChannel('s1', 'discord'), true);
  assert.equal(sessionChannelOf('s1'), 'discord');

  assert.equal(rememberSessionChannel('s1', 'weixin'), true);
  assert.equal(sessionChannelOf('s1'), 'weixin');

  assert.equal(rememberSessionChannel('', 'discord'), false);
  assert.equal(rememberSessionChannel('s2', ''), false);
  assert.equal(sessionChannelOf('s2'), null);

  assert.equal(forgetSessionChannel('s1'), true);
  assert.equal(sessionChannelOf('s1'), null);

  rememberSessionChannel('s3', 'discord');
  resetSessionChannels();
  assert.equal(sessionChannelOf('s3'), null);
});

test('the persona only renders for a Session the Discord channel prompted', () => {
  resetSessionChannels();
  const ctx = fakeCtx();
  installDiscordPersona(ctx);

  assert.equal(ctx.contexts.length, 1);
  const [spec] = ctx.contexts;
  assert.equal(spec.name, DISCORD_PERSONA_CONTEXT_NAME);
  assert.equal(spec.order, 120);
  assert.equal(typeof spec.text, 'function', 'the context must render per Assemble, not once');

  // A Web/CLI Session reads this plugin too; it must stay unpersonified.
  assert.equal(spec.text(assemblyFor('web-session')), '');
  assert.equal(spec.text(assemblyFor(undefined)), '');
  assert.equal(spec.text(undefined), '');

  rememberSessionChannel('web-session', 'discord');
  assert.equal(spec.text(assemblyFor('web-session')), DISCORD_PERSONA_PROMPT);

  // Another channel's Session is not the Discord persona either.
  rememberSessionChannel('weixin-session', 'weixin');
  assert.equal(spec.text(assemblyFor('weixin-session')), '');
});

test('a custom persona is what the Discord Session receives', () => {
  resetSessionChannels();
  const ctx = fakeCtx();
  installDiscordPersona(ctx, { text: 'custom persona' });
  rememberSessionChannel('s1', 'discord');
  assert.equal(ctx.contexts[0].text(assemblyFor('s1')), 'custom persona');
});

test('the Agent going away drops its pairing', () => {
  resetSessionChannels();
  const ctx = fakeCtx();
  installDiscordPersona(ctx);
  rememberSessionChannel('s1', 'discord');
  assert.equal(ctx.contexts[0].text(assemblyFor('s1')), DISCORD_PERSONA_PROMPT);

  const disposed = ctx.listeners.find((entry) => entry.type === 'agent/disposed');
  assert.ok(disposed, 'the persona installer must clean up its registry');
  assert.deepEqual(disposed.options, { global: true });
  disposed.listener({ agent: { session: { id: 's1' } } });
  assert.equal(sessionChannelOf('s1'), null);
  assert.equal(ctx.contexts[0].text(assemblyFor('s1')), '');
});

test('a Host that cannot listen still gets the scoped context', () => {
  resetSessionChannels();
  const contexts = [];
  installDiscordPersona({ systemPrompt: { context: (spec) => contexts.push(spec) } });
  assert.equal(contexts.length, 1);
  assert.equal(typeof contexts[0].text, 'function');
});

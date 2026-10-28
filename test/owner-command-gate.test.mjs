import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';

/*
 * Owner commands (`/mute`, `/block`, `/recall`, …) claim they answer to the
 * owner alone, but the access policy only has one "may run commands" bit, and a
 * fresh Discord install grants it to everyone. The sender check therefore lives
 * at dispatch; without it any guild member could mute or block anyone.
 */

function bridge({ ownerUserId = 'owner-1', senderId = null } = {}) {
  const lifetime = new AbortController();
  const replies = [];
  const instance = new DiscordHarnessBridge({
    signal: lifetime.signal,
    chatOrder: 'fifo',
    ownerUserId,
    harness: {},
    state: { sessionFor: () => null, markSeen: async () => {}, hasSeen: () => false },
    bot: { sendText: async (_target, text) => { replies.push(text); } },
    ownerTools: {},
  });
  return { instance, replies, senderId };
}

test('a stranger cannot run an owner command through a native command', async () => {
  const { instance } = bridge();
  const reply = await instance.runNativeCommand('/mute 5', { conversationId: 'room-1', senderId: 'stranger' });
  assert.equal(reply, '只有主人可以使用这条命令。');
});

test('the owner still runs the same command', async () => {
  const { instance } = bridge();
  const reply = await instance.runNativeCommand('/unmute', { conversationId: 'room-2', senderId: 'owner-1' });
  assert.equal(reply, '本频道当前没有暂停自动回复。');
});

test('an allowlisted non-owner does not inherit owner commands', async () => {
  const { instance } = bridge();
  instance.setTrustedIds(['guest-1']);
  const reply = await instance.runNativeCommand('/mute 5', { conversationId: 'room-3', senderId: 'guest-1' });
  assert.equal(reply, '只有主人可以使用这条命令。');
});

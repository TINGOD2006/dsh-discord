import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAccessPolicyFor, newBotAccessPolicyFor, privilegedSenderIdsFor } from '../plugin-src/host/channels/shared/access-policy-production.mjs';
import { resolveRpcAuthority } from '../plugin-src/host/rpc-authority.mjs';

const OWNER = '627504520112373761';

test('a fresh Discord seed keeps chat open but commands closed', () => {
  const policy = initialAccessPolicyFor('discord', { ownerUserId: OWNER });
  for (const scope of [policy.direct, policy.group]) {
    assert.equal(scope.mode, 'open');
    assert.equal(scope.open.defaultCanExecuteCommands, false, 'a new bot must not hand out commands');
  }
});

test('the owner stays privileged under the Discord seed', () => {
  assert.deepEqual(privilegedSenderIdsFor('discord', { ownerUserId: OWNER }), [OWNER]);
});

test('a newly connected Discord bot gets the same closed-command seed', () => {
  const policy = newBotAccessPolicyFor('discord', { ownerUserId: OWNER });
  assert.equal(policy.group.open.defaultCanExecuteCommands, false);
});

test('other channels keep their existing seeds', () => {
  // Telegram is chat-open and command-open by design; the Discord hardening must
  // not silently change channels that were already shipped this way.
  const telegram = initialAccessPolicyFor('telegram', {});
  assert.equal(telegram.group.open.defaultCanExecuteCommands, true);
});

test('management RPC defaults to loopback, not to a trusted host', () => {
  assert.equal(resolveRpcAuthority(undefined), 'loopback');
  assert.equal(resolveRpcAuthority('loopback'), 'loopback');
  assert.equal(resolveRpcAuthority('trusted-host'), 'trusted-host');
  assert.throws(() => resolveRpcAuthority('anyone'), TypeError);
});

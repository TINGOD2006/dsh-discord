import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractConnectionEvidence, gatewaySocketError } from '../src/channels/shared/connection-error.mjs';

test('a bare TypeError from the socket is tagged with a classifiable reason', () => {
  const error = gatewaySocketError({ error: new TypeError('terminated') });
  assert.equal(error.code, 'UND_ERR_SOCKET');
  assert.equal(extractConnectionEvidence(error).details.reason, 'UND_ERR_SOCKET');
});

test('an error that already carries a code keeps it', () => {
  const original = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
  assert.equal(gatewaySocketError({ error: original }).code, 'ECONNRESET');
});

test('a non-Error event value still becomes a tagged Error', () => {
  const error = gatewaySocketError({ error: 'socket died' });
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'socket died');
  assert.equal(error.code, 'discord-gateway-error');
});

test('a missing event falls back to a generic gateway error', () => {
  const error = gatewaySocketError(undefined);
  assert.equal(error.message, 'WebSocket error');
  assert.equal(error.code, 'discord-gateway-error');
});

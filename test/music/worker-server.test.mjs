import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveMusicWorker } from '../../src/channels/discord/music-worker-server.mjs';

test('the worker forwards the query-resolution mode and carries the failure code back', async () => {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = message => port.sent.push(message);
  let options;
  serveMusicWorker(port, {}, captured => { options = captured; return { destroy: async () => {} }; });
  const pending = options.resolveQuery({ query: 'yoasobi最新作', guildId: 'guild', mode: 'memory' });
  const sent = port.sent.find(message => message.type === 'request');
  assert.equal(sent.method, 'resolveQuery');
  assert.deepEqual(sent.params, { query: 'yoasobi最新作', guildId: 'guild', mode: 'memory' });
  // The failure code has to survive the RPC as data: an Error's `code` would not.
  port.emit('message', { type: 'result', id: sent.id, value: { query: null, failure: 'timeout' } });
  assert.deepEqual(await pending, { query: null, failure: 'timeout' });
});

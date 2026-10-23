import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordApi } from '../../src/channels/discord/discord-api.mjs';
import { handleApplicationCommand } from '../../src/channels/discord/discord-commands.mjs';
import { classifyMusicLog } from '../../scripts/monitor-music.mjs';

const fixtureToken = 'a'.repeat(24) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(24);
function client(fetchImpl) { return new DiscordApi({ token: fixtureToken, fetchImpl }); }

for (const status of [200, 204]) test(`an empty successful callback (${status}) continues the command and finishes the thinking response`, async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) });
    if (url.pathname.endsWith('/callback')) return new Response(null, { status });
    return new Response(JSON.stringify({ id: '55555', content: 'queued' }), { status: 200 });
  });
  let executed = 0;
  const handled = await handleApplicationCommand({ type: 2, id: '12345', token: 'interaction-fixture', channel_id: '23456', guild_id: '34567',
    member: { user: { id: '45678' } }, data: { name: 'play', options: [{ type: 3, name: 'query', value: 'song' }] } }, {
    applicationId: '56789', api, bridge: { runNativeCommand: async () => { executed++; return 'queued'; } },
  });
  assert.equal(handled, true); assert.equal(executed, 1);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'PATCH']);
  assert.equal(calls[1].body.content, 'queued');
});

test('callback permission failures remain failures rather than successful acknowledgements', async () => {
  const api = client(async () => new Response(JSON.stringify({ code: 50013, message: 'Missing Permissions' }), { status: 403 }));
  await assert.rejects(api.createInteractionResponse('12345', 'fixture', { type: 5 }), error => error.status === 403);
});

test('ordinary REST endpoints still reject empty JSON responses', async () => {
  const api = client(async () => new Response(null, { status: 200 }));
  await assert.rejects(api.getCurrentUser(), /invalid JSON/);
});

test('monitor reports acknowledgement failures without leaking interaction details', () => {
  const row = classifyMusicLog({ ts: new Date().toISOString(), level: 'error', event: 'log',
    message: '[dsh-im:discord] interaction acknowledgement failed: {"interactionId":"private-id","message":"Discord POST returned invalid JSON"}' });
  assert.equal(row.cause, 'interaction-response'); assert(!JSON.stringify(row).includes('private-id'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMusicControlServer, createMusicControlHandler, controlPage } from '../src/channels/discord/music-control-server.mjs';

const GUILD = 'guild-1';

function registry(overrides = {}) {
  const calls = [];
  return {
    calls,
    snapshot: () => ({ state: 'playing', title: '晴天', positionMs: 1000, durationMs: 2000, ...overrides }),
    control: async (guildId, action, params = {}) => {
      calls.push({ guildId, action, params });
      return { ok: true, message: `${action} ok` };
    },
  };
}

async function start(options = {}) {
  const store = options.registry ?? registry();
  const server = createMusicControlServer({ registry: store, token: 'secret-token', ...options });
  const url = await server.start();
  return { server, url, store };
}

test('the console page is dark-mode HTML with a slider', async () => {
  const { server, url } = await start();
  try {
    const response = await fetch(`${url}${GUILD}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const body = await response.text();
    assert.match(body, /type="range"/);
    assert.match(body, /music\/secret-token/);
    assert.match(body, /\/state/);
  } finally { await server.close(); }
});

test('state returns the registry snapshot', async () => {
  const { server, url } = await start();
  try {
    const response = await fetch(`${url}${GUILD}/state`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.snapshot.title, '晴天');
  } finally { await server.close(); }
});

test('a wrong token is indistinguishable from a missing route', async () => {
  const { server, url } = await start();
  try {
    const response = await fetch(`${url.replace('secret-token', 'nope')}${GUILD}/state`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not-found');
  } finally { await server.close(); }
});

test('pause posts through the registry', async () => {
  const { server, url, store } = await start();
  try {
    const response = await fetch(`${url}${GUILD}/pause`, { method: 'POST' });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(store.calls.at(-1), { guildId: GUILD, action: 'pause', params: { positionMs: 0 } });
  } finally { await server.close(); }
});

test('seek passes the dragged position and throttles repeats', async () => {
  const { server, url, store } = await start();
  try {
    const first = await fetch(`${url}${GUILD}/seek`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ positionMs: 61_000 }) });
    assert.equal((await first.json()).ok, true);
    assert.equal(store.calls.at(-1).params.positionMs, 61_000);
    const second = await fetch(`${url}${GUILD}/seek`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ positionMs: 62_000 }) });
    assert.equal(second.status, 429);
  } finally { await server.close(); }
});

test('unknown actions are rejected', async () => {
  const { server, url } = await start();
  try {
    const response = await fetch(`${url}${GUILD}/destroy`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally { await server.close(); }
});

test('the handler reports a registry failure instead of crashing', async () => {
  const failing = { snapshot: () => { throw new Error('boom'); }, control: async () => { throw new Error('boom'); } };
  const handler = createMusicControlHandler({ registry: failing, token: 't' });
  const response = {
    statusCode: 0, headers: null, body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  await handler({ method: 'GET', url: '/music/t/guild-1/state' }, response);
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /boom/);
});

test('controlPage escapes the injected scope', () => {
  const page = controlPage({ base: '/music/t/g</script>', guildId: 'g1' });
  assert.ok(!page.includes('</script>"/'));
  assert.match(page, /\\u003c/);
});

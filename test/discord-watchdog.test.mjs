import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DiscordRuntime } from '../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';

const BOT = '200000000000009999';
const OWNER = '200000000000001111';

async function until(check, label = 'condition') {
  const deadline = Date.now() + 8000;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.ok(check(), `${label} did not happen`);
}

async function scratch(run) {
  const root = resolve('work/test-discord-watchdog');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'case-'));
  try { await run(dir); }
  finally {
    assert.ok(resolve(dir).startsWith(root + sep));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * A Gateway fixture whose sockets never talk on their own: every frame the
 * runtime sees is emitted by the test, so silence is exactly what a wedged
 * connection produces.
 */
async function fixture(dir, { readyFor = () => true, heartbeatInterval = 30_000, ...timings } = {}) {
  const state = await new DiscordStateStore(join(dir, 'state.json')).load();
  const sockets = [];
  const events = [];
  const warns = [];
  const errors = [];
  const payloads = [];
  const runtime = new DiscordRuntime({
    // Isolate persona state: the runtime always reads it now, so without a
    // scrubbed home this fixture would inherit the developer's real library.
    config: { platformId: BOT, botId: 'fixture', ownerUserId: OWNER, dshHome: dir },
    token: 'fixture-only',
    state,
    harness: {
      ensureRunning: async () => {},
      createSession: async () => 'session-1',
      workspaceSession: () => ({ sessionExists: async () => true, ask: async () => 'fixture answer' }),
    },
    logger: {
      info() {}, warn: (...args) => warns.push(args.join(' ')), error: (...args) => errors.push(args),
      event: (name, data) => events.push({ name, data }),
    },
    createMusicManager: () => ({ execute: async () => ({ message: 'music' }), destroy: async () => {} }),
    random: () => 0,
    watchdogTickMs: 10,
    watchdogStaleMs: 200,
    watchdogAliveLogMs: 600_000,
    connectTimeoutMs: 400,
    ...timings,
    createApi: () => ({
      getCurrentUser: async () => ({ id: BOT, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://fixture.invalid' }),
      getCurrentApplication: async () => ({ id: 'app' }),
      putGlobalApplicationCommands: async () => [],
      putGuildApplicationCommands: async () => [],
      createMessage: async () => ({ id: '1' }),
    }),
    createWebSocket: () => {
      const index = sockets.length;
      const socket = new EventEmitter();
      socket.index = index;
      socket.readyState = 1;
      socket.sent = [];
      socket.send = (raw) => socket.sent.push(JSON.parse(raw));
      socket.close = (code = 1000) => {
        if (socket.readyState >= 2) return;
        socket.readyState = 3;
        socket.closeCode = code;
        setImmediate(() => socket.emit('close', { code }));
      };
      sockets.push(socket);
      if (readyFor(index)) {
        setImmediate(() => {
          if (socket.readyState !== 1) return;
          socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatInterval } }) });
          socket.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', d: { session_id: `session-${index}`, resume_gateway_url: 'wss://fixture.invalid/resume' } }) });
        });
      }
      return socket;
    },
  });
  const emit = (index, packet) => sockets[index]?.emit('message', { data: JSON.stringify(packet) });
  return { runtime, state, sockets, events, warns, errors, payloads, emit };
}

test('a gateway that goes silent is repaired instead of staying deaf', async () => {
  await scratch(async (dir) => {
    const f = await fixture(dir, { watchdogStaleMs: 200, connectTimeoutMs: 2_000 });
    try {
      await f.runtime.start();
      assert.equal(f.runtime.status.ready, true);
      assert.equal(f.sockets.length, 1, 'a healthy start must not reconnect');
      // The socket stays open and keeps answering nothing — the deaf-bot state:
      // no close, no error, no frames.
      await until(() => f.sockets.length >= 2, 'watchdog reconnect');
      await until(() => f.runtime.status.ready === true, 'recovered connection');
      const repair = f.events.find(e => e.name === 'connection.watchdog');
      assert.ok(repair, 'the repair must be recorded');
      assert.equal(repair.data.reason, 'silent-gateway');
      assert.ok(repair.data.silentForMs >= 200, 'the repair reports the silence it observed');
      assert.equal(f.sockets[0].closeCode, 4000, 'the wedged socket is dropped');
      assert.equal(f.runtime.status.connectionState, 'connected');
      assert.equal(f.errors.length, 0, 'a watchdog repair is not an error');
    } finally { await f.runtime.stop(); }
  });
});

test('an unacknowledged heartbeat reconnects instead of closing a dead socket', async () => {
  await scratch(async (dir) => {
    const f = await fixture(dir, { heartbeatInterval: 1_000, watchdogStaleMs: 60_000 });
    try {
      await f.runtime.start();
      assert.equal(f.sockets.length, 1);
      // op 1 goes out, but Discord never acknowledges it; the close handshake on
      // such a socket can hang forever, so the runtime must repair it itself.
      await until(() => f.sockets[0].sent.some(p => p.op === 1), 'first heartbeat');
      await until(() => f.events.some(e => e.name === 'connection.watchdog' && e.data.reason === 'heartbeat-timeout'),
        'heartbeat timeout repair');
    } finally { await f.runtime.stop(); }
  });
});

test('a stalled reconnect is retried instead of waiting forever', async () => {
  await scratch(async (dir) => {
    // Socket 0 answers, socket 1 (the watchdog reconnect) never becomes ready,
    // socket 2 recovers. Without a connect deadline the runtime would wait on
    // socket 1 for the rest of the process lifetime.
    const f = await fixture(dir, { readyFor: (index) => index !== 1, watchdogStaleMs: 120, connectTimeoutMs: 120 });
    try {
      await f.runtime.start();
      await until(() => f.sockets.length >= 3, 'retry after a stalled handshake');
      await until(() => f.runtime.status.ready === true, 'recovered connection');
      assert.equal(f.runtime.status.connectionState, 'connected');
      assert.ok(f.warns.some(line => /did not become ready|reconnecting/.test(line)),
        'the stalled attempt is reported');
    } finally { await f.runtime.stop(); }
  });
});

test('a healthy connection leaves a periodic liveness trace', async () => {
  await scratch(async (dir) => {
    const f = await fixture(dir, { watchdogStaleMs: 2_000, watchdogAliveLogMs: 40, watchdogTickMs: 5 });
    const acks = setInterval(() => f.emit(0, { op: 11 }), 10);
    try {
      await f.runtime.start();
      await until(() => f.events.some(e => e.name === 'connection.alive'), 'liveness trace');
      const alive = f.events.find(e => e.name === 'connection.alive');
      assert.ok(Number.isFinite(alive.data.silentForMs));
      assert.equal(f.sockets.length, 1, 'a live connection is left alone');
    } finally {
      clearInterval(acks);
      await f.runtime.stop();
    }
  });
});

test('a first connection that never becomes ready fails loudly, not silently', async () => {
  await scratch(async (dir) => {
    const f = await fixture(dir, { readyFor: () => false, connectTimeoutMs: 80 });
    try {
      await assert.rejects(f.runtime.start(), /did not become ready/);
      assert.equal(f.runtime.status.ready, false);
      assert.equal(f.sockets.length, 1, 'startup does not stack sockets');
      assert.ok(f.runtime.status.lastError, 'the failure is surfaced to the settings card');
    } finally { await f.runtime.stop(); }
  });
});

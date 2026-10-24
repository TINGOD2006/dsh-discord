import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, MessageChannel } from 'node:worker_threads';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MusicWorkerManager, musicWorkerEntry } from '../../src/channels/discord/music-worker.mjs';
import { MusicWorkerRpc } from '../../src/channels/discord/music-worker-rpc.mjs';
import { runMusicProcess } from '../../src/channels/discord/music-process.mjs';
import { musicTools } from '../../src/channels/discord/music-audio.mjs';

const request = { guildId: 'guild', channelId: 'text', senderId: 'user' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (await fn()) return; await sleep(10); }
  throw new Error('Worker condition did not settle');
}
async function fixture(options = {}) {
  const root = resolve('work/test-music'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'worker-')), input = join(dir, 'sample.wav');
  await runMusicProcess(musicTools().ffmpeg, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', input], { cwd: dir });
  const workers = [], events = [], logs = [], notices = [];
  const manager = new MusicWorkerManager({ token: 'fixture-only', logger: (...args) => logs.push(args), notify: (...args) => notices.push(args), ...options,
    workerFactory: (_entry, config) => {
      const worker = new Worker(new URL('./fixtures/music-worker.mjs', import.meta.url), { ...config, workerData: { ...config.workerData, input } });
      worker.on('message', message => events.push(message)); workers.push(worker); return worker;
    },
  });
  return { manager, workers, events, logs, notices,
    command: (command, args = {}) => manager.execute(command, { ...request, ...args }),
    async close() { await manager.destroy(); assert(resolve(dir).startsWith(root + sep)); await rm(dir, { recursive: true, force: true }); },
  };
}

test('production worker starts without logging in and shuts down cleanly; creation is lazy', async () => {
  const workers = [];
  const manager = new MusicWorkerManager({ token: 'fixture-only', workerFactory: (entry, options) => {
    assert.equal(entry, musicWorkerEntry); const worker = new Worker(entry, options); workers.push(worker); return worker;
  } });
  assert.equal(workers.length, 0);
  try { await assert.rejects(manager.execute('unknown'), /未知音樂指令/); assert.equal(workers.length, 1); }
  finally { await manager.destroy(); }
  assert.equal(workers[0].threadId, -1); assert.equal(manager.available, false);
  await assert.rejects(manager.execute('status'), /已關閉/);
});

test('real worker keeps FFmpeg/player/UDP running while parent event loop blocks for 500 ms', async t => {
  const f = await fixture();
  try {
    await f.command('play', { query: 'first' });
    await until(() => f.notices.length > 0);
    await sleep(150);
    const before = await f.command('fixture-stats');
    const started = performance.now();
    while (performance.now() - started < 500) {} // Intentional host stall, reproducing the reported failure.
    const blockedMs = performance.now() - started;
    const after = await f.command('fixture-stats');
    const progress = after.sent - before.sent;
    assert(progress >= 18, `only ${progress} packets during ${blockedMs} ms parent stall`);
    assert(after.maxGap < 150, `worker read gap ${after.maxGap} ms`);
    assert(after.received >= after.sent - 2);
    const status = await f.command('status');
    assert.match(status.message, /播放執行：獨立 worker/); assert.match(status.message, /音訊預讀/);
    assert(f.logs.some(([, event, value]) => event === 'music.transport.stats' && value.execution === 'worker'));
    t.diagnostic(JSON.stringify({ parentBlockedMs: Math.round(blockedMs), packetsDuringBlock: progress, maxWorkerGapMs: Math.round(after.maxGap), localReceived: after.received }));
    await f.command('pause');
    await sleep(130); const paused = await f.command('fixture-stats'); await sleep(100);
    assert.equal((await f.command('fixture-stats')).sent, paused.sent);
    await f.command('volume', { percent: 35 }); assert.match((await f.command('queue')).message, /已暫停/);
    assert.match((await f.command('bitrate', { kbps: 128 })).message, /目前輸出：128 kbps/);
    assert.match((await f.command('queue')).message, /已暫停/);
    assert.match((await f.command('status')).message, /音訊碼率：128 kbps；目標：128 kbps/);
    assert.match((await f.command('channels', { count: 2 })).message, /雙聲道立體聲/);
    assert.match((await f.command('bitrate', { kbps: 320 })).message, /目前輸出：320 kbps/);
    assert.match((await f.command('status')).message, /FFmpeg 子程序／雙聲道立體聲/);
    assert.match((await f.command('queue')).message, /已暫停/);
    await f.command('resume'); await until(async () => (await f.command('fixture-stats')).sent > paused.sent);
    await assert.rejects(f.command('stop', { senderId: 'other' }), /目前所在/);
    await f.command('play', { query: 'second' }); await f.command('next');
    await until(async () => (await f.command('nowplaying')).message.includes('second'));
    await f.command('stop'); assert.match((await f.command('queue')).message, /空/);
  } finally { await f.close(); }
  assert(f.workers.every(worker => worker.threadId === -1));
});

test('worker preserves reservations, cancels stale acknowledged commands, and cancels host selection', async () => {
  let selectionSignal;
  const f = await fixture({ selectCandidate: ({ signal }) => { selectionSignal = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  try {
    let acknowledge;
    const delayed = f.command('play', { query: 'stale', ready: new Promise(resolve => { acknowledge = resolve; }) });
    const cancelled = assert.rejects(delayed, { name: 'AbortError' });
    await f.command('stop'); acknowledge(); await cancelled;
    assert.match((await f.command('queue')).message, /空/);
    let failReady;
    const failed = f.command('play', { query: 'failed', ready: new Promise((_, reject) => { failReady = reject; }) });
    const rejected = assert.rejects(failed, { name: 'AbortError' }); failReady(new Error('ack failed')); await rejected;
    await f.command('play', { query: 'select:blocked' }); await until(() => selectionSignal);
    await f.command('stop'); await until(() => selectionSignal.aborted);
    assert.match((await f.command('queue')).message, /空/);
    const controller = new AbortController();
    const pending = f.command('play', { query: 'cancel', signal: controller.signal, ready: new Promise(() => {}) });
    const aborted = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); await aborted;
    await f.command('play', { query: 'fresh' }); await until(() => f.notices.length > 0);
    assert.match((await f.command('nowplaying')).message, /fresh/);
  } finally { await f.close(); }
});

test('worker exit rejects pending commands, restarts on next use, and shutdown cancels selection', async () => {
  let selectionSignal;
  const f = await fixture({ selectCandidate: ({ signal }) => { selectionSignal = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  try {
    const pending = f.command('play', { query: 'pending', ready: new Promise(() => {}) });
    const rejected = assert.rejects(pending, /worker 已中斷/);
    await f.command('status'); f.workers[0].postMessage({ fixture: 'crash' }); await rejected;
    assert.equal(f.logs.filter(([, event]) => event === 'music.worker.failed').length, 1);
    await f.command('play', { query: 'select:blocked' }); await until(() => selectionSignal);
    assert.equal(f.workers.length, 2);
    await f.manager.destroy(); await until(() => selectionSignal.aborted);
  } finally { await f.close(); }
});

test('RPC bounds outstanding commands and closes pending/active cancellation listeners', async () => {
  const { port1, port2 } = new MessageChannel();
  let remoteSignal;
  const left = new MusicWorkerRpc(port1, () => {});
  const right = new MusicWorkerRpc(port2, (_method, _params, { signal }) => {
    remoteSignal = signal; return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  });
  try {
    const pending = Array.from({ length: 256 }, () => left.request('wait').catch(error => error));
    await assert.rejects(left.request('overflow'), /忙碌/);
    await until(() => remoteSignal);
    left.close(); right.close();
    assert(remoteSignal.aborted);
    assert((await Promise.all(pending)).every(error => error.name === 'AbortError'));
  } finally { left.close(); right.close(); port1.close(); port2.close(); }
});

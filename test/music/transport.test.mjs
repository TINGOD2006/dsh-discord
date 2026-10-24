import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBufferedMusicResource, recoverMusicVoice, voiceBitrate } from '../../src/channels/discord/music-transport.mjs';
import { startMusicHealth } from '../../src/channels/discord/music-health.mjs';

test('voice bitrate respects the actual channel and never exceeds codec limits', () => {
  assert.equal(voiceBitrate(64000), 64000); assert.equal(voiceBitrate(256000), 128000); assert.equal(voiceBitrate(undefined), 64000);
  assert.equal(voiceBitrate(16000),16000);
  assert.equal(voiceBitrate(64000,128000),64000);assert.equal(voiceBitrate(384000,256000),256000);
  assert.equal(voiceBitrate(8000,128000),8000);assert.equal(voiceBitrate(undefined,384000),64000);
  assert.equal(voiceBitrate(384000,999000),384000);
  assert.equal(voiceBitrate(384000,320000,2),320000);assert.equal(voiceBitrate(128000,320000,2),128000);
  assert.equal(voiceBitrate(384000,320000,1),256000);assert.equal(voiceBitrate(undefined,320000,2),64000);
});

function resourceLib(producer) {
  const calls = [];
  return { calls, StreamType: { OggOpus: 'ogg', Opus: 'opus' }, createAudioResource(input, options) {
    calls.push(options);
    if (options.inputType === 'ogg') return { playStream: producer };
    return { playStream: input, get ended() { return input.readableEnded; }, read: () => input.read() };
  } };
}

test('Opus prebuffer is bounded and directly forwards externally encoded packets without inline processing', async () => {
  const packets = Array.from({ length: 100 }, (_, n) => Buffer.from([n]));
  const producer = Readable.from(packets), libs = resourceLib(producer);
  let encoderOptions;
  const audio = await createBufferedMusicResource(libs, 'normalized.ogg', { volume: 0.6, bitrate: 64000,
    encoderFactory:(input,options)=>{encoderOptions=options;return{stream:producer, destroy(){producer.destroy();}};} });
  try {
    assert(audio.snapshot().bufferedFrames >= 24); assert(audio.snapshot().bufferedFrames <= 48);
    assert.equal(encoderOptions.volume,0.6);assert.equal(encoderOptions.bitrate,64000);assert.equal(audio.snapshot().bitrate,64000);
    assert.equal(audio.resource.volume,undefined);assert.equal(audio.resource.encoder,undefined);
    assert.deepEqual(libs.calls.map(call => call.inlineVolume), [false, false]);
    const read = []; for await (const packet of audio.resource.playStream) read.push(packet[0]);
    assert.deepEqual(read, Array.from({ length: 100 }, (_, n) => n));
  } finally { audio.destroy(); }
});

test('stop cancels prebuffering and releases its producer', async () => {
  const producer = new Readable({ objectMode: true, read() {} });
  const controller = new AbortController();
  const pending = createBufferedMusicResource(resourceLib(producer), 'file.ogg', { signal: controller.signal,
    encoderFactory:()=>({stream:producer,destroy(){producer.destroy();}}) });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(producer.destroyed, true);
});

const statuses = { Ready: 'ready', Destroyed: 'destroyed', Signalling: 'signalling', Connecting: 'connecting' };
test('short transport failures retry a bounded number of times before recovering', async () => {
  let enters = 0, rejoins = 0;
  const connection = { state: { status: 'disconnected' }, rejoin() { rejoins++; return true; } };
  const result = await recoverMusicVoice(connection, { VoiceConnectionStatus: statuses, entersState: async () => {
    if (++enters < 3) throw new Error('temporarily unavailable'); return connection;
  } }, { delays: [0, 0, 0], wait: async () => {} });
  assert.equal(result.attempts, 2); assert.equal(rejoins, 2);
});

test('a Discord kick is not counteracted with forced rejoin attempts', async () => {
  let rejoins = 0;
  await assert.rejects(recoverMusicVoice({ state: { status: 'disconnected', closeCode: 4014 }, rejoin() { rejoins++; } }, {
    VoiceConnectionStatus: statuses, entersState: async () => { throw new Error('permission revoked'); },
  }), /permission revoked/);
  assert.equal(rejoins, 0);
});

test('retry exhaustion and caller cancellation remain bounded', async () => {
  let rejoins = 0;
  const connection = { state: { status: 'disconnected' }, rejoin() { rejoins++; return true; } };
  const libs = { VoiceConnectionStatus: statuses, entersState: async () => { throw new Error('network down'); } };
  await assert.rejects(recoverMusicVoice(connection, libs, { delays: [0, 0], wait: async () => {} }), /network down/);
  assert.equal(rejoins, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recoverMusicVoice(connection, libs, { signal: controller.signal }), { name: 'AbortError' });
});

test('health telemetry distinguishes ping from RTP loss and deduplicates degraded transitions', () => {
  const logs = [], room = { state: 'playing', current: {}, connection: { state: { status: 'ready' }, ping: { udp: 50, ws: 30 } },
    transport: { snapshot: () => ({ framesRead: 100, sourceStarved: 0, maxReadGapMs: 20, bufferedMs: 400, bitrate: 64000 }) } };
  const health = startMusicHealth(room, (...args) => logs.push(args), { intervalMs: 100000 });
  try {
    health.sample(); assert.equal(health.snapshot().rtpPacketLoss, null);
    room.connection.ping.udp = 600; health.sample(); health.sample();
    assert.equal(logs.filter(([, event]) => event === 'music.transport.degraded').length, 1);
    room.connection.ping.udp = 50; for (let n = 0; n < 4; n++) health.sample();
    assert.equal(logs.filter(([, event]) => event === 'music.transport.recovered').length, 1);
  } finally { health.destroy(); }
});

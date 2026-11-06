import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBufferedMusicResource, recoverMusicVoice, voiceBitrate } from '../../src/channels/discord/music-transport.mjs';
import { startMusicHealth } from '../../src/channels/discord/music-health.mjs';

test('the default bitrate follows the channel setting and the codec ceiling', () => {
  // A plain server reports 64 kbps. Sending three times that costs bandwidth on
  // every listener's uplink, so the default follows the channel; `/music bitrate`
  // is the explicit override.
  assert.equal(voiceBitrate(64000), 64000);
  assert.equal(voiceBitrate(64000, 192000), 64000);
  assert.equal(voiceBitrate(128000, 192000), 128000);
  assert.equal(voiceBitrate(undefined, 192000), 192000);
  assert.equal(voiceBitrate(384000, 999000), 384000);
  assert.equal(voiceBitrate(384000, 320000, 2), 320000);
  assert.equal(voiceBitrate(384000, 320000, 1), 256000);
  assert.equal(voiceBitrate(16000, 16000), 16000);
  assert.equal(voiceBitrate(8000, 8000), 8000);
});

test('an explicit bitrate ignores the channel setting but not the codec ceiling', () => {
  assert.equal(voiceBitrate(64000, 192000, 2, { respectChannel: false }), 192000);
  assert.equal(voiceBitrate(64000, 320000, 2, { respectChannel: false }), 320000);
  assert.equal(voiceBitrate(64000, 999000, 2, { respectChannel: false }), 384000);
  assert.equal(voiceBitrate(64000, 999000, 1, { respectChannel: false }), 256000);
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
    assert(audio.snapshot().bufferedFrames >= 24); assert(audio.snapshot().bufferedFrames <= 72);
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

test('health telemetry flags degraded playback from local frame delivery and deduplicates transitions', () => {
  const logs = [];
  let gap = 20, missed = 0;
  const room = { state: 'playing', current: {}, connection: { state: { status: 'ready' }, ping: { ws: 30 } },
    player: { state: { missedFrames: 0 } },
    transport: { snapshot: () => ({ framesRead: 100, sourceStarved: 0, maxReadGapMs: gap, readGapP95Ms: gap, peakReadGapMs: 120, bufferedMs: 400, bitrate: 64000 }) } };
  const health = startMusicHealth(room, (...args) => logs.push(args), { intervalMs: 100000 });
  try {
    health.sample();
    // 0.19.2 no longer tracks a UDP keep-alive round trip, so the bot must report
    // that it has no receiver-side loss figure rather than inventing one.
    assert.equal(health.snapshot().rtpPacketLoss, null);
    assert.equal(health.snapshot().missedFrames, 0);
    // The sliding window is what recovers: a one-off spike must not pin the room
    // to degraded forever (that was the bug).
    gap = 60; health.sample(); health.sample();
    assert.equal(logs.filter(([, event]) => event === 'music.transport.degraded').length, 1);
    gap = 20; for (let n = 0; n < 4; n++) health.sample();
    assert.equal(logs.filter(([, event]) => event === 'music.transport.recovered').length, 1);
    // Missed frames are the player's own dropout counter; surface them even when
    // local delivery looks clean.
    room.player.state.missedFrames = missed = 3; health.sample();
    assert.equal(health.snapshot().missedFrames, missed);
  } finally { health.destroy(); }
});

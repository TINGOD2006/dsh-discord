// Real worker, MusicManager, FFmpeg and voice player; fake Discord login only.
import { parentPort, workerData } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createSocket } from 'node:dgram';
import { performance } from 'node:perf_hooks';
import * as voice from '@discordjs/voice';
import { MusicManager } from '../../../src/channels/discord/music.mjs';
import { serveMusicWorker } from '../../../src/channels/discord/music-worker-server.mjs';
import { createBufferedMusicResource } from '../../../src/channels/discord/music-transport.mjs';

const guild = { id: 'guild', voiceStates: { cache: new Map([['user', { channelId: 'voice' }], ['other', { channelId: 'elsewhere' }]]) }, channels: { cache: new Map([['voice', { bitrate: 384000 }]]) } };
class Client extends EventEmitter {
  channels = { cache: new Map([['text', { guild }]]) }; user = { id: 'fixture' };
  async login() {} isReady() { return true; } destroy() {}
}
let sent = 0, received = 0, lastRead, maxGap = 0;
const socket = createSocket('udp4');
socket.on('message', () => received++);
await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
const runtime = { ...voice, Client, GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 128 },
  entersState: async connection => connection,
  joinVoiceChannel: () => Object.assign(new EventEmitter(), { state: { status: 'ready' }, ping: { ws: 1 },
    subscribe() {}, destroy() { this.state.status = 'destroyed'; }, rejoin() { return true; } }),
  createAudioPlayer: options => voice.createAudioPlayer({ ...options, behaviors: { ...options.behaviors, noSubscriber: voice.NoSubscriberBehavior.Play } }),
};
const server = serveMusicWorker(parentPort, workerData, options => {
  const pipeline = {
    prepare: async (query, { signal, guildId }) => {
      if (query.startsWith('select:')) await options.selectCandidate({ query, signal, guildId, candidates: [{ id: 'fixture' }] });
      signal.throwIfAborted();
      return { input: workerData.input, title: query, release() { parentPort.postMessage({ fixture: 'released', query }); } };
    }, destroy() {},
  };
  const bufferedFactory = async (...args) => {
    const audio = await createBufferedMusicResource(...args);
    const read = audio.resource.read.bind(audio.resource);
    audio.resource.read = () => {
      const packet = read();
      if (packet) {
        const now = performance.now(); if (lastRead !== undefined) maxGap = Math.max(maxGap, now - lastRead); lastRead = now;
        sent++; socket.send(packet, socket.address().port, '127.0.0.1');
      }
      return packet;
    };
    return audio;
  };
  const manager = new MusicManager({ ...options, runtime, pipeline, bufferedFactory, cooldownMs: 0, healthIntervalMs: 50 });
  const destroy = manager.destroy.bind(manager);
  manager.destroy = async () => { await destroy(); socket.close(); };
  const execute = manager.execute.bind(manager);
  manager.execute = (command, args) => {
    if (command === 'fixture-stats') return Promise.resolve({ sent, received, maxGap });
    return execute(command, args);
  };
  return manager;
});
parentPort.on('message', message => { if (message?.fixture === 'crash') process.exit(9); });

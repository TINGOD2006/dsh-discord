/** Real codec/player clock + localhost UDP echo. Never joins or sends to Discord. */
import { createSocket } from 'node:dgram';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import * as voice from '@discordjs/voice';
import { musicTools } from '../src/channels/discord/music-audio.mjs';
import { createBufferedMusicResource } from '../src/channels/discord/music-transport.mjs';
import { runMusicProcess } from '../src/channels/discord/music-process.mjs';

const dir = resolve(import.meta.dirname, '..', 'work', 'transport-loopback');
await mkdir(dir, { recursive: true });
const tools = musicTools(), sample = join(dir, 'sample.ogg');
const input = process.argv[2] ? ['-i', resolve(process.argv[2])] : ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8'];
await runMusicProcess(tools.ffmpeg, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', ...input,
  '-t', '8', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '128k', sample], { cwd: dir });
const receiver = createSocket('udp4'), sender = createSocket('udp4');
const received = new Set(), echoed = new Set(), rtts = [], sendTimes = [], socketErrors = [];
receiver.on('error', error => socketErrors.push(error.code ?? error.name));
sender.on('error', error => socketErrors.push(error.code ?? error.name));
receiver.on('message', (data, peer) => {
  if (data.length < 16 || data.readUInt32LE(0) !== 0x4d555343) return;
  received.add(data.readUInt32LE(4)); receiver.send(data, peer.port, '127.0.0.1');
});
sender.on('message', data => {
  if (data.length < 16 || data.readUInt32LE(0) !== 0x4d555343) return;
  echoed.add(data.readUInt32LE(4)); rtts.push(performance.now() - data.readDoubleLE(8));
});
await new Promise(resolveReady => receiver.bind(0, '127.0.0.1', resolveReady));
await new Promise(resolveReady => sender.bind(0, '127.0.0.1', resolveReady));
const audio = await createBufferedMusicResource(voice, sample, { volume: 0.6 });
const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play, maxMissedFrames: 10 } });
let sent = 0;
const read = audio.resource.read.bind(audio.resource);
audio.resource.read = () => {
  const packet = read();
  if (packet) {
    const at = performance.now(), data = Buffer.alloc(16 + packet.length);
    data.writeUInt32LE(0x4d555343, 0); data.writeUInt32LE(sent++, 4); data.writeDoubleLE(at, 8); packet.copy(data, 16);
    sendTimes.push(at); sender.send(data, receiver.address().port, '127.0.0.1');
  }
  return packet;
};
try {
  await new Promise((done, reject) => {
    const deadline = setTimeout(() => reject(new Error('Local UDP playback check timed out')), 20000);
    player.once('error', error => { clearTimeout(deadline); reject(error); });
    player.once(voice.AudioPlayerStatus.Idle, () => { clearTimeout(deadline); done(); });
    player.play(audio.resource);
  });
  await new Promise(resolveDrain => setTimeout(resolveDrain, 100));
  const gaps = sendTimes.slice(1).map((at, i) => at - sendTimes[i]).sort((a, b) => a - b);
  const percentile = (items, p) => items.length ? Math.round(items[Math.min(items.length - 1, Math.floor(items.length * p))] * 100) / 100 : null;
  const result = { scope: 'localhost UDP echo only; not Discord Internet packet loss', sentPackets: sent, receivedPackets: received.size,
    echoedPackets: echoed.size, localLostPackets: sent - received.size, localEchoLostPackets: sent - echoed.size,
    sendIntervalP95Ms: percentile(gaps, 0.95), maxSendIntervalMs: percentile(gaps, 1), udpEchoP95Ms: percentile(rtts.sort((a,b)=>a-b),0.95),
    ...audio.snapshot(), eventLoopP99Ms: Math.round(eventLoop.percentile(99) / 1e4) / 100,
    eventLoopMaxMs: Math.round(eventLoop.max / 1e4) / 100, socketErrors };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.localLostPackets || result.localEchoLostPackets || result.sourceStarved || socketErrors.length || !sent) throw new Error('Local transport check failed');
  console.log('LOCAL CODEC / CLOCK / UDP CHECK PASSED');
} finally { eventLoop.disable(); player.stop(true); audio.destroy(); receiver.close(); sender.close(); }

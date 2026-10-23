/** Manual audio check: network + real yt-dlp/FFmpeg. No Discord messages or login. */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAudioResource, StreamType, generateDependencyReport } from '@discordjs/voice';
import { MusicAudioPipeline, musicTools, loudnessStats, loudnessAnalysisFilter, MUSIC_LOUDNESS } from '../src/channels/discord/music-audio.mjs';
import { MUSIC_DEFAULT_VOLUME } from '../src/channels/discord/music.mjs';
import { runMusicProcess } from '../src/channels/discord/music-process.mjs';

const query = process.argv.slice(2).join(' ').trim() || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const root = resolve(import.meta.dirname, '..');
const dir = join(root, '.dsh-im', 'music-smoke');
await mkdir(dir, { recursive: true });
const tools = musicTools();
const pipeline = new MusicAudioPipeline({ cacheDir: join(dir, 'cache'), tools });
try {
  console.log('Manual audio/voice-codec check. Does not call DSH or join Discord.');
  console.log(generateDependencyReport());
  const start = Date.now();
  const source = await pipeline.prepare(query);
  try {
    const measured = await runMusicProcess(tools.ffmpeg, ['-hide_banner', '-i', source.input, '-af',
      loudnessAnalysisFilter(), '-f', 'null', '-'], { cwd: dir });
    const stats = loudnessStats(measured.stderr);
    const lufs = stats ? Number(stats.input_i) : null;
    if (lufs !== null && lufs > MUSIC_LOUDNESS.integrated + 0.6) throw new Error(`Loudness exceeds target: ${lufs} LUFS`);
    const resource = createAudioResource(source.input, { inputType: StreamType.OggOpus, inlineVolume: true });
    resource.encoder?.setBitrate?.(128000);
    resource.volume.setVolume(MUSIC_DEFAULT_VOLUME);
    let packets = 0;
    for await (const packet of resource.playStream) { if (packet.length) packets++; }
    if (!packets) throw new Error('No Discord-compatible Opus packets were produced');
    console.log(JSON.stringify({ title: source.title, url: source.url, duration: source.duration, lufs,
      truePeak: stats ? Number(stats.input_tp) : null, defaultVolumePercent: MUSIC_DEFAULT_VOLUME * 100,
      cacheHit: source.cacheHit, opusPackets: packets, elapsedMs: Date.now() - start }, null, 2));
    console.log('AUDIO / OPUS CHECK PASSED');
  } finally { source.release(); }
} finally { await pipeline.destroy(); }

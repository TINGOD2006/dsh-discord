import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { musicTools } from './music-audio.mjs';
import { abortError } from './music-process.mjs';

export const MUSIC_PLAYBACK_PROFILE = Object.freeze({ bitrate: 32000, channels: 1, sampleRate: 48000, frameMs: 20 });
const pluginRoot = dirname(createRequire(import.meta.url).resolve('dsh-discord/package.json'));

export function playbackEncoderArgs(input, { volume = 0.6, bitrate = MUSIC_PLAYBACK_PROFILE.bitrate, offsetSeconds = 0 } = {}) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('播放音量無效');
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) throw new Error('播放位置無效');
  const rate = Math.min(MUSIC_PLAYBACK_PROFILE.bitrate, Math.max(16000, Number(bitrate) || MUSIC_PLAYBACK_PROFILE.bitrate));
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    ...(offsetSeconds > 0 ? ['-ss', offsetSeconds.toFixed(3)] : []), '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', `volume=${volume.toFixed(6)}`, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-threads', '1',
    '-application', 'audio', '-compression_level', '0', '-b:a', String(rate), '-vbr', 'off', '-frame_duration', '20',
    '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1'];
}

/** Native decoding/gain/encoding runs outside the Discord event loop. No files are written. */
export function createMusicEncoder(input, { signal, ffmpeg = musicTools().ffmpeg, spawnProcess = spawn, ...options } = {}) {
  if (signal?.aborted) throw abortError();
  const child = spawnProcess(ffmpeg, playbackEncoderArgs(input, options), {
    cwd: pluginRoot, env: { ...process.env, FFREPORT: undefined },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let destroyed = false, closed = false, killTimer;
  const stream = child.stdout;
  // Drain diagnostics, but never expose source paths or raw FFmpeg output to logs.
  child.stderr?.resume();
  const destroy = () => {
    if (destroyed) return; destroyed = true;
    signal?.removeEventListener('abort', destroy);
    stream.destroy();
    if (!closed) {
      child.kill();
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000); killTimer.unref?.();
    }
  };
  child.once('error', () => { if (!destroyed) stream.destroy(new Error('無法啟動 FFmpeg 播放編碼程序')); });
  child.once('close', code => {
    closed = true; clearTimeout(killTimer); signal?.removeEventListener('abort', destroy);
    if (!destroyed && code !== 0) stream.destroy(new Error(`FFmpeg 播放編碼失敗 (${Number.isInteger(code) ? code : 'terminated'})`));
  });
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy();
  return { stream, destroy, offsetSeconds: options.offsetSeconds ?? 0 };
}

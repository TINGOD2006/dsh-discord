import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { musicTools } from './music-audio.mjs';
import { abortError } from './music-process.mjs';

// Default target for the encoder; the transport no longer clamps it to the
// voice channel's client-side setting (see voiceBitrate).
export const MUSIC_PLAYBACK_PROFILE = Object.freeze({ bitrate: 192000, channels: 2, sampleRate: 48000, frameMs: 20 });
export function playbackChannels(value = MUSIC_PLAYBACK_PROFILE.channels) {
  if (value !== 1 && value !== 2) throw new Error('聲道數須為 1（單聲道）或 2（雙聲道）');
  return value;
}
export function playbackBitrate(value = MUSIC_PLAYBACK_PROFILE.bitrate, channels = MUSIC_PLAYBACK_PROFILE.channels) {
  const rate = Number(value);
  const ceiling = playbackChannels(channels) === 1 ? 256000 : 384000;
  return Math.min(ceiling, Math.max(8000, Number.isFinite(rate) && rate > 0 ? rate : MUSIC_PLAYBACK_PROFILE.bitrate));
}
const pluginRoot = dirname(createRequire(import.meta.url).resolve('dsh-discord/package.json'));

/**
 * Opus search effort. Measured on a 20 s 48 kHz stereo slice, higher complexity
 * only pays off once the target rate leaves room for it: at 64 kbps the encoder
 * is bit-starved and cl 0/cl 10 differ by 0.02 dB, while at 128 kbps cl 10 gains
 * ~1.1 dB of SNR for 179 ms -> 235 ms per 30 s of audio (still 7.8x real time, and
 * the first packet arrives in ~65 ms). Keep 64 kbps cheap, spend the CPU above it.
 */
export function playbackComplexity(bitrate) {
  const rate = Number(bitrate);
  return Number.isFinite(rate) && rate >= 128000 ? 10 : 0;
}

/**
 * A remote source is read over HTTP while it plays, so the network is part of the
 * playback path. A dropped connection must resume instead of ending the track, a
 * stalled socket must fail instead of hanging the encoder, and a corrupt packet
 * on a flaky link is skipped rather than fatal.
 */
const STREAM_INPUT_FLAGS = Object.freeze([
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
  '-rw_timeout', '15000000', '-fflags', '+discardcorrupt', '-err_detect', 'ignore_err',
]);

export function playbackEncoderArgs(input, { volume = 0.6, bitrate = MUSIC_PLAYBACK_PROFILE.bitrate, channels = MUSIC_PLAYBACK_PROFILE.channels, offsetSeconds = 0, headers = null, stream = false } = {}) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('播放音量無效');
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) throw new Error('播放位置無效');
  const count = playbackChannels(channels), rate = playbackBitrate(bitrate, count);
  // The reconnect flags are HTTP protocol options; a local file ignores them.
  const remote = stream === true && /^https?:\/\//iu.test(input);
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    ...(offsetSeconds > 0 ? ['-ss', offsetSeconds.toFixed(3)] : []),
    // A streamed source may need the extractor's Referer/User-Agent to be served.
    ...(headers ? ['-headers', headers] : []),
    ...(remote ? STREAM_INPUT_FLAGS : []),
    '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', `volume=${volume.toFixed(6)}`, '-ar', '48000', '-ac', String(count), '-c:a', 'libopus', '-threads', '1',
    '-application', 'audio', '-vbr', 'off', '-compression_level', String(playbackComplexity(rate)), '-b:a', String(rate), '-frame_duration', '20',
    '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1'];
}

const STDERR_TAIL_CHARS = 1200;

/**
 * FFmpeg's last stderr line names the real failure ("Server returned 403
 * Forbidden"), but it also carries the source URL and local paths. Keep the
 * reason, drop the identifiers, so a failed track is diagnosable without
 * leaking what the host was reading.
 */
export function encoderFailureReason(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? '')
    .replace(/https?:\/\/[^\s'"]*[^\s'":]/giu, '<url>')
    .replace(/[A-Za-z]:\\[^\s'"]*[^\s'":]/gu, '<path>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
}

/** Native decoding/gain/encoding runs outside the Discord event loop. No files are written. */
export function createMusicEncoder(input, { signal, ffmpeg = musicTools().ffmpeg, spawnProcess = spawn, ...options } = {}) {
  if (signal?.aborted) throw abortError();
  const child = spawnProcess(ffmpeg, playbackEncoderArgs(input, options), {
    cwd: pluginRoot, env: { ...process.env, FFREPORT: undefined },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let destroyed = false, closed = false, killTimer, stderrTail = '';
  const stream = child.stdout;
  // A failed run ends stdout before it reports the exit code, and destroying an
  // already-ended stream drops the error. The failure promise carries it instead,
  // so the transport can report the reason rather than "no packets".
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const fail = error => { rejectFailure(error); stream.destroy(error); };
  // Keep only the tail: it is drained (so FFmpeg never blocks on a full pipe) and
  // the last line is what explains a failed run.
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS); });
  const destroy = () => {
    if (destroyed) return; destroyed = true;
    signal?.removeEventListener('abort', destroy);
    stream.destroy();
    if (!closed) {
      child.kill();
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000); killTimer.unref?.();
    }
  };
  child.once('error', () => { if (!destroyed) fail(new Error('無法啟動 FFmpeg 播放編碼程序')); });
  child.once('close', code => {
    closed = true; clearTimeout(killTimer); signal?.removeEventListener('abort', destroy);
    if (!destroyed && code !== 0) {
      const reason = encoderFailureReason(stderrTail);
      fail(new Error(`FFmpeg 播放編碼失敗 (${Number.isInteger(code) ? code | 0 : 'terminated'})${reason ? `：${reason}` : ''}`));
    }
  });
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy();
  return { stream, destroy, failure, offsetSeconds: options.offsetSeconds ?? 0 };
}

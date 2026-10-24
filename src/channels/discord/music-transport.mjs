import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { abortError } from './music-process.mjs';
import { createMusicEncoder, MUSIC_PLAYBACK_PROFILE, playbackBitrate, playbackChannels } from './music-encoder.mjs';

export function voiceBitrate(channelBitrate, requestedBitrate = MUSIC_PLAYBACK_PROFILE.bitrate, channels = MUSIC_PLAYBACK_PROFILE.channels) {
  // Unknown channel limits stay at the original conservative default.
  const limit = Number.isFinite(channelBitrate) && channelBitrate > 0 ? channelBitrate : 64000;
  return Math.min(playbackBitrate(requestedBitrate, channels), playbackBitrate(limit, channels));
}

/** A bounded packet queue decouples short encoder/I/O stalls from the 20ms player clock. */
export async function createBufferedMusicResource(libs, input, { volume, bitrate, channels = MUSIC_PLAYBACK_PROFILE.channels, metadata, signal,
  offsetSeconds = 0, encoderFactory = createMusicEncoder,
  bufferFrames = 48, prebufferFrames = 24, timeoutMs = 5000 } = {}) {
  if (signal?.aborted) throw abortError();
  const count = playbackChannels(channels);
  const encoder = encoderFactory(input, { volume, bitrate: playbackBitrate(bitrate, count), channels: count, offsetSeconds, signal });
  let producer;
  try { producer = libs.createAudioResource(encoder.stream, { inputType: libs.StreamType.OggOpus, inlineVolume: false, metadata }); }
  catch (error) { encoder.destroy(); throw error; }
  const buffer = new PassThrough({ objectMode: true, highWaterMark: bufferFrames });
  let resource, destroyed = false, streamError;
  const stats = { framesRead: 0, sourceStarved: 0, maxReadGapMs: 0 };
  let lastRead = null;
  const fail = error => { streamError = error; buffer.destroy(error); };
  producer.playStream.on('error', fail);
  encoder.stream.on('error', fail);
  // A player attaches its own listener later; prebuffering errors also need a listener.
  buffer.on('error', () => {});
  const destroy = () => {
    if (destroyed) return; destroyed = true;
    signal?.removeEventListener('abort', cancel);
    resource?.playStream?.destroy(); buffer.destroy(); producer.playStream.destroy(); encoder.destroy();
    // Late child/stream errors remain handled during cancellation.
  };
  const cancel = () => destroy();
  signal?.addEventListener('abort', cancel, { once: true });
  buffer.once('close', () => { producer.playStream.destroy(); encoder.destroy(); });
  producer.playStream.pipe(buffer);
  try {
    await new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (signal?.aborted || destroyed) return done(abortError());
        if (streamError) return done(streamError);
        if (buffer.readableLength >= prebufferFrames || (buffer.writableFinished && buffer.readableLength > 0)) return done();
        if (buffer.writableFinished && !buffer.readableLength) return done(new Error('音訊沒有可播放的 Opus 封包'));
        if (performance.now() - started > timeoutMs) return done(new Error('音訊封包預緩衝逾時'));
      };
      const timer = setInterval(check, 10);
      const done = error => { clearInterval(timer); error ? reject(error) : resolve(); };
      check();
    });
    resource = libs.createAudioResource(buffer, { inputType: libs.StreamType.Opus, inlineVolume: false, metadata });
    const read = resource.read.bind(resource);
    resource.read = () => {
      const now = performance.now();
      if (lastRead !== null) stats.maxReadGapMs = Math.max(stats.maxReadGapMs, now - lastRead);
      lastRead = now;
      const packet = read();
      if (packet) stats.framesRead++;
      else if (!buffer.writableFinished && !resource.ended && !destroyed) stats.sourceStarved++;
      return packet;
    };
    if (signal?.aborted) throw abortError();
    return { resource, destroy, offsetSeconds, resetTiming: () => { lastRead = null; },
      snapshot: () => ({ ...stats, maxReadGapMs: Math.round(stats.maxReadGapMs), bufferedFrames: buffer.readableLength,
        bufferedMs: buffer.readableLength * 20, bitrate: playbackBitrate(bitrate, count), channels: count, encoder: 'ffmpeg', inlineEncoding: false }) };
  } catch (error) { destroy(); throw error; }
}

export function waitMusic(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Use the library's handshake/keepalive, with bounded rejoin attempts instead of clearing on the first failure. */
export async function recoverMusicVoice(connection, libs, { signal, delays = [250, 1000, 2500], initialTimeoutMs = 2000,
  attemptTimeoutMs = 10000, wait = waitMusic, onAttempt = () => {} } = {}) {
  const enter = (status, ms) => libs.entersState(connection, status, signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
  const ensureActive = () => {
    if (signal?.aborted) throw abortError();
    if (connection.state.status === libs.VoiceConnectionStatus.Destroyed) throw new Error('語音連線已關閉');
  };
  ensureActive();
  // 4014 can mean a move or revocation. Wait for Discord; never force-rejoin a kick.
  if (connection.state.closeCode === 4014) {
    await Promise.race([enter(libs.VoiceConnectionStatus.Signalling, 5000), enter(libs.VoiceConnectionStatus.Connecting, 5000)]);
    await enter(libs.VoiceConnectionStatus.Ready, attemptTimeoutMs); ensureActive(); return { attempts: 0 };
  }
  try { await enter(libs.VoiceConnectionStatus.Ready, initialTimeoutMs); ensureActive(); return { attempts: 0 }; }
  catch (error) { ensureActive(); }
  for (let i = 0; i < delays.length; i++) {
    await wait(delays[i], signal); ensureActive(); onAttempt(i + 1);
    try {
      if (connection.rejoin() === false) throw new Error('Discord 拒絕語音重連');
      await enter(libs.VoiceConnectionStatus.Ready, attemptTimeoutMs); ensureActive(); return { attempts: i + 1 };
    } catch (error) { ensureActive(); if (i === delays.length - 1) throw error; }
  }
  throw new Error('語音重連次數已用完');
}

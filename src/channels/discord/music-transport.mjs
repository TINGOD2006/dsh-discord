import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { abortError } from './music-process.mjs';
import { createMusicEncoder, MUSIC_PLAYBACK_PROFILE, playbackBitrate, playbackChannels } from './music-encoder.mjs';

/**
 * Bitrate the encoder actually runs at.
 *
 * `channelBitrate` is the voice channel's *client* setting (64 kbps on a plain
 * server, up to 384 kbps with boosts). Discord does not police a bot's Opus
 * stream against it, but sending three times the channel's configured rate
 * costs bandwidth on every listener's uplink and makes an already degraded
 * network path worse. The default therefore follows the channel when it is
 * known; `/music bitrate` is an explicit override that ignores it.
 */
export function voiceBitrate(channelBitrate, requestedBitrate = MUSIC_PLAYBACK_PROFILE.bitrate, channels = MUSIC_PLAYBACK_PROFILE.channels,
  { respectChannel = true } = {}) {
  const requested = Number.isFinite(requestedBitrate) && requestedBitrate > 0
    ? requestedBitrate
    : MUSIC_PLAYBACK_PROFILE.bitrate;
  const ceiling = playbackBitrate(requested, channels);
  if (!respectChannel) return ceiling;
  const channel = Number.isFinite(channelBitrate) && channelBitrate > 0 ? channelBitrate : null;
  return channel === null ? ceiling : Math.min(ceiling, playbackBitrate(channel, channels));
}

/** A bounded packet queue decouples short encoder/I/O stalls from the 20ms player clock. */
export async function createBufferedMusicResource(libs, input, { volume, bitrate, channels = MUSIC_PLAYBACK_PROFILE.channels, metadata, signal,
  offsetSeconds = 0, encoderFactory = createMusicEncoder,
  bufferFrames = 72, prebufferFrames = 24, timeoutMs = 5000 } = {}) {
  if (signal?.aborted) throw abortError();
  const count = playbackChannels(channels);
  const encoder = encoderFactory(input, { volume, bitrate: playbackBitrate(bitrate, count), channels: count, offsetSeconds, signal });
  let producer;
  try { producer = libs.createAudioResource(encoder.stream, { inputType: libs.StreamType.OggOpus, inlineVolume: false, metadata }); }
  catch (error) { encoder.destroy(); throw error; }
  const buffer = new PassThrough({ objectMode: true, highWaterMark: bufferFrames });
  let resource, destroyed = false, streamError;
  const stats = { framesRead: 0, sourceStarved: 0, peakReadGapMs: 0 };
  // A ring of read intervals: the P95 separates the unavoidable Windows 15.6 ms
  // timer quantisation from a real stall in the encoder or the pipe. Both the P95
  // and the maximum are windowed — a lifetime maximum meant one spike latched the
  // health check into "degraded" for the rest of the song. 512 slots at one read
  // per 20 ms is ~10.2 s, matching the health sampler's interval.
  const GAP_WINDOW = 512;
  const gapRing = new Float64Array(GAP_WINDOW);
  let gapIndex = 0, gapCount = 0, lastRead = null;
  const gapWindow = () => {
    const size = Math.min(gapCount, GAP_WINDOW);
    if (!size) return null;
    const sorted = Array.from(gapRing.subarray(0, size)).sort((a, b) => a - b);
    return { p95: Math.round(sorted[Math.min(size - 1, Math.floor(size * 0.95))]), max: Math.round(sorted[size - 1]) };
  };
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
      if (lastRead !== null) {
        const gap = now - lastRead;
        stats.peakReadGapMs = Math.max(stats.peakReadGapMs, gap);
        gapRing[gapIndex++ % GAP_WINDOW] = gap; gapCount++;
      }
      lastRead = now;
      const packet = read();
      if (packet) stats.framesRead++;
      else if (!buffer.writableFinished && !resource.ended && !destroyed) stats.sourceStarved++;
      return packet;
    };
    if (signal?.aborted) throw abortError();
    return { resource, destroy, offsetSeconds, resetTiming: () => { lastRead = null; },
      // `maxReadGapMs` is the windowed maximum, so the health check can recover;
      // `peakReadGapMs` keeps the whole-song spike for post-mortem diagnostics.
      snapshot: () => { const window = gapWindow(); return { ...stats, maxReadGapMs: window?.max ?? 0, readGapP95Ms: window?.p95 ?? 0,
        peakReadGapMs: Math.round(stats.peakReadGapMs), bufferedFrames: buffer.readableLength,
        bufferedMs: buffer.readableLength * 20, bitrate: playbackBitrate(bitrate, count), channels: count, encoder: 'ffmpeg', inlineEncoding: false }; } };
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

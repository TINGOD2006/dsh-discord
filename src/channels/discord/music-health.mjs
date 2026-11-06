import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

const metric = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** Local scheduling/keepalive telemetry; it does not measure remote RTP packet loss. */
export function startMusicHealth(room, log, { intervalMs = 10000 } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let lastStarved = 0, degraded = false, healthy = 0, latest = null;
  const sample = () => {
    if (!room.transport || !room.current || !['playing', 'reconnecting'].includes(room.state)) { delay.reset(); return; }
    const audio = room.transport.snapshot();
    let ping; try { ping = room.connection?.ping; } catch {}
    const wsPingMs = metric(ping?.ws);
    // @discordjs/voice 0.19.2 never updates VoiceUDPSocket.ping (it is marked
    // deprecated and no keep-alive round trip is tracked), so `ping.udp` is always
    // undefined. Reporting a number here would be fiction; only the WS RTT is real.
    const sourceStarved = Math.max(0, audio.sourceStarved - lastStarved); lastStarved = audio.sourceStarved;
    // The player counts a frame it could not fill and stops at maxMissedFrames (10).
    // That is the closest local proxy for what a listener hears as a gap.
    const missedFrames = metric(room.player?.state?.missedFrames);
    latest = { wsPingMs, execution: isMainThread ? 'main' : 'worker', eventLoopMaxMs: metric(delay.max / 1e6),
      framesRead: audio.framesRead, sourceStarved, missedFrames, maxReadGapMs: audio.maxReadGapMs, readGapP95Ms: metric(audio.readGapP95Ms),
      peakReadGapMs: metric(audio.peakReadGapMs), bufferedMs: audio.bufferedMs,
      bitrate: audio.bitrate, channels: [1, 2].includes(audio.channels) ? audio.channels : null, encoder: audio.encoder === 'ffmpeg' ? 'ffmpeg' : null,
      inlineEncoding: audio.inlineEncoding === false ? false : null,
      connectionState: room.connection?.state?.status ?? 'unknown', rtpPacketLoss: null };
    delay.reset();
    log('info', 'music.transport.stats', latest);
    // A read gap above ~45 ms means the 20 ms clock missed a whole frame, which
    // is a local stall rather than the normal 15.6 ms Windows timer quantisation.
    // maxReadGapMs is windowed (~10 s), so a single spike no longer latches this.
    const problem = sourceStarved > 0 || latest.eventLoopMaxMs > 100 || latest.maxReadGapMs > 45;
    if (problem) {
      healthy = 0;
      if (!degraded) { degraded = true; log('warn', 'music.transport.degraded', latest); }
    } else if (degraded && ++healthy >= 3) { degraded = false; healthy = 0; log('info', 'music.transport.recovered', latest); }
  };
  const timer = setInterval(sample, intervalMs); timer.unref?.();
  return { snapshot: () => latest, sample, destroy: () => { clearInterval(timer); delay.disable(); } };
}

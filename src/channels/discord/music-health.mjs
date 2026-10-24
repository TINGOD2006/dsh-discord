import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

const metric = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** Local scheduling/keepalive telemetry; it does not measure remote RTP packet loss. */
export function startMusicHealth(room, log, { intervalMs = 10000 } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let lastUdp = null, lastStarved = 0, degraded = false, healthy = 0, latest = null;
  const sample = () => {
    if (!room.transport || !room.current || !['playing', 'reconnecting'].includes(room.state)) { delay.reset(); return; }
    const audio = room.transport.snapshot();
    let ping; try { ping = room.connection?.ping; } catch {}
    const udpPingMs = metric(ping?.udp), wsPingMs = metric(ping?.ws);
    const udpJitterMs = udpPingMs !== null && lastUdp !== null ? Math.abs(udpPingMs - lastUdp) : null;
    if (udpPingMs !== null) lastUdp = udpPingMs;
    const sourceStarved = Math.max(0, audio.sourceStarved - lastStarved); lastStarved = audio.sourceStarved;
    latest = { udpPingMs, wsPingMs, udpJitterMs, execution: isMainThread ? 'main' : 'worker', eventLoopMaxMs: metric(delay.max / 1e6),
      framesRead: audio.framesRead, sourceStarved, maxReadGapMs: audio.maxReadGapMs, bufferedMs: audio.bufferedMs,
      bitrate: audio.bitrate, channels: [1, 2].includes(audio.channels) ? audio.channels : null, encoder: audio.encoder === 'ffmpeg' ? 'ffmpeg' : null,
      inlineEncoding: audio.inlineEncoding === false ? false : null,
      connectionState: room.connection?.state?.status ?? 'unknown', rtpPacketLoss: null };
    delay.reset();
    log('info', 'music.transport.stats', latest);
    const problem = sourceStarved > 0 || latest.eventLoopMaxMs > 100 || udpPingMs > 500 || udpJitterMs > 100;
    if (problem) {
      healthy = 0;
      if (!degraded) { degraded = true; log('warn', 'music.transport.degraded', latest); }
    } else if (degraded && ++healthy >= 3) { degraded = false; healthy = 0; log('info', 'music.transport.recovered', latest); }
  };
  const timer = setInterval(sample, intervalMs); timer.unref?.();
  return { snapshot: () => latest, sample, destroy: () => { clearInterval(timer); delay.disable(); } };
}

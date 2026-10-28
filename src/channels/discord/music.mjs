import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { MusicAudioPipeline, musicTools, MUSIC_LOUDNESS } from './music-audio.mjs';
import { MUSIC_PLAYBACK_PROFILE } from './music-encoder.mjs';
import { createDshMusicSelector } from './music-dsh.mjs';
import { createBufferedMusicResource, recoverMusicVoice, voiceBitrate } from './music-transport.mjs';
import { startMusicHealth } from './music-health.mjs';
import { MusicCommandLane, musicTask } from './music-command-lane.mjs';
import { clampSeekTarget, formatClock, seekIsMeaningful } from './music-panel.mjs';

export const MUSIC_AUDIO_URL = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)(\?|#|$)/i;
export const MUSIC_MAX_QUEUE = 25;
export const MUSIC_DEFAULT_VOLUME = 0.6;
// How many queued tracks may be resolved, searched and decoded to the cache
// ahead of time. The pipeline already dedupes and rate-limits the renders, so a
// small depth buys an instant hand-off without stampeding ffmpeg. 0 turns the
// look-ahead off; the current track is still prepared before it starts.
export const MUSIC_PREFETCH_DEPTH = (() => {
  const parsed = Number.parseInt(process.env.DSK_DISCORD_PREFETCH_DEPTH ?? '3', 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(6, parsed)) : 3;
})();
export const DEFAULT_YTDLP_CANDIDATES = Object.freeze([process.env.DSK_DISCORD_YTDLP, musicTools().ytDlp]);
export function defaultYtDlpPath(candidates = DEFAULT_YTDLP_CANDIDATES) { return candidates.find(value => value && existsSync(value)) ?? 'yt-dlp'; }
export function isPlayableUrl(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
export function needsExtractor(value) { return isPlayableUrl(value) && /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|bilibili\.com|b23\.tv|nicovideo\.jp|vimeo\.com|twitch\.tv)$/.test(new URL(value).hostname); }
/** The queued tracks worth warming now: playback order, capped by the depth. */
export function prefetchTargets(tracks, depth = MUSIC_PREFETCH_DEPTH) {
  const limit = Math.max(0, Math.min(MUSIC_MAX_QUEUE, Number(depth) || 0));
  return Array.isArray(tracks) ? tracks.slice(0, limit) : [];
}

/** Per-guild playback. A cancelled preparation can never resurrect a stopped track. */
export class MusicManager {
  #token; #logger; #runtime; #pipeline; #notify; #client; #login; #library;
  #guilds = new Map(); #cooldowns = new Map(); #destroyed = false; #idleMs; #cooldownMs; #loginTimeoutMs;
  #bufferedFactory; #recoverVoice; #healthIntervalMs; #allowLocalFileFor; #onPlaybackChange;
  #commands = new MusicCommandLane();
  #lifetime = new AbortController();
  constructor({ token, logger = null, runtime = null, ytDlpPath = null, pipeline = null, harness = null, notify = null, idleMs = 180000, cooldownMs = 3000, loginTimeoutMs = 20000,
    bufferedFactory = createBufferedMusicResource, recoverVoice = recoverMusicVoice, healthIntervalMs = 10000, selectCandidate, allowLocalFileFor = null,
    privilegedIds = [], onPlaybackChange = null } = {}) {
    this.#token = token; this.#logger = logger; this.#runtime = runtime; this.#notify = notify;
    this.#idleMs = idleMs; this.#cooldownMs = cooldownMs;
    this.#loginTimeoutMs = loginTimeoutMs;
    this.#onPlaybackChange = typeof onPlaybackChange === 'function' ? onPlaybackChange : null;
    this.#bufferedFactory = bufferedFactory; this.#recoverVoice = recoverVoice; this.#healthIntervalMs = healthIntervalMs;
    // Owner-only reach for host-local files: `/play <path>` must not become a way
    // for any member to stream whatever the host can read. The worker receives the
    // privileged ids as data, because a predicate cannot cross that boundary.
    const privileged = new Set((Array.isArray(privilegedIds) ? privilegedIds : []).map(String));
    this.#allowLocalFileFor = typeof allowLocalFileFor === 'function'
      ? allowLocalFileFor
      : (senderId) => privileged.has(String(senderId ?? ''));
    const tools = musicTools(); if (ytDlpPath) tools.ytDlp = ytDlpPath;
    this.#pipeline = pipeline ?? new MusicAudioPipeline({ tools, logger, selectCandidate: selectCandidate ?? createDshMusicSelector(harness, { logger }) });
  }
  get available() { return !this.#destroyed && typeof this.#token === 'string' && this.#token.length > 0; }
  async execute(command, args = {}) {
    if (!['play', 'join', 'next', 'stop', 'pause', 'resume', 'seek', 'queue', 'nowplaying', 'status', 'volume', 'bitrate', 'channels', 'leave'].includes(command)) throw new Error('未知音樂指令');
    const signal = args.signal ? AbortSignal.any([args.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    signal.throwIfAborted();
    // Gateway guild IDs reserve a shared player lane before any asynchronous lookup.
    if (!args.guildId) await musicTask(args.ready, signal);
    const guildId = args.guildId ?? (await this.#context(args.channelId, args.senderId, { voice: false, signal })).guild.id;
    if (['queue', 'nowplaying', 'status'].includes(command) || (command === 'bitrate' && args.kbps === undefined) || (command === 'channels' && args.count === undefined)) {
      await musicTask(args.ready, signal); signal.throwIfAborted(); return this[command]({ ...args, signal });
    }
    // Permission checks must precede a barrier: another voice channel cannot cancel admissions.
    const authorize = async activeSignal => {
      await musicTask(args.ready, activeSignal); activeSignal.throwIfAborted();
      if (command === 'stop' || command === 'leave') {
        const context = await this.#context(args.channelId, args.senderId, { signal: activeSignal });
        if (context.guild.id !== guildId) throw new Error('音樂伺服器與頻道不符');
      }
    };
    return this.#commands.run(guildId, command, activeSignal => this[command]({ ...args, signal: activeSignal }), signal, authorize);
  }
  #log(level, event, detail) { try { this.#logger?.(level, event, detail instanceof Error ? detail.message : detail); } catch {} }
  async #say(channelId, message) { try { await this.#notify?.(channelId, message); } catch (error) { this.#log('warn', 'music.notice.failed', error); } }
  async #libs() {
    if (this.#library) return this.#library;
    if (this.#runtime) return this.#library = this.#runtime;
    const [discord, voice] = await Promise.all([import('discord.js'), import('@discordjs/voice')]);
    return this.#library = { ...voice, Client: discord.Client, GatewayIntentBits: discord.GatewayIntentBits };
  }
  async #ready() {
    if (!this.available) throw new Error('音樂功能未啟用');
    if (!this.#login) {
      this.#login = (async () => {
        const libs = await this.#libs();
        const client = new libs.Client({ intents: [libs.GatewayIntentBits.Guilds, libs.GatewayIntentBits.GuildVoiceStates] });
        this.#client = client; client.on('error', error => this.#log('warn', 'music.client.error', error));
        let timer, readyListener, expired = false;
        try {
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { expired = true; reject(new Error('Discord 語音用戶端連線逾時')); }, this.#loginTimeoutMs);
          });
          const connect = (async () => {
            await client.login(this.#token);
            if (expired || this.#destroyed) throw new Error('音樂語音連線已取消');
            if (typeof client.isReady === 'function' && !client.isReady()) await new Promise(resolve => {
              readyListener = resolve;
              client.once('clientReady', readyListener);
              if (client.isReady()) resolve();
            });
          })();
          await Promise.race([connect, deadline]);
          if (this.#destroyed) throw new Error('音樂服務已關閉');
          return client;
        } catch (error) {
          try { void Promise.resolve(client.destroy()).catch(() => {}); } catch {}
          if (this.#client === client) this.#client = null;
          throw error;
        } finally { clearTimeout(timer); if (readyListener) client.removeListener('clientReady', readyListener); }
      })();
      this.#login.catch(() => { this.#login = null; });
    }
    return this.#login;
  }
  #room(id) {
    if (!this.#guilds.has(id)) this.#guilds.set(id, { id, tracks: [], current: null, player: null, connection: null, channelId: null,
      textChannelId: null, resource: null, transport: null, health: null, bitrate: voiceBitrate(), requestedBitrate: MUSIC_PLAYBACK_PROFILE.bitrate, channelBitrate: null, channels: MUSIC_PLAYBACK_PROFILE.channels, recoveryController: null,
      state: 'idle', volume: MUSIC_DEFAULT_VOLUME, leaving: false, version: 0, startTask: null, idleTimer: null, recovering: false });
    return this.#guilds.get(id);
  }
  async #context(channelId, senderId, { voice = true, signal } = {}) {
    signal?.throwIfAborted();
    const client = await musicTask(this.#ready(), signal);
    const channel = client.channels.cache.get(String(channelId)) ?? await musicTask(client.channels.fetch(String(channelId)).catch(() => null), signal);
    signal?.throwIfAborted(); if (this.#destroyed) throw new Error('音樂服務已關閉');
    const guild = channel?.guild; if (!guild) throw new Error('請在伺服器頻道使用音樂指令');
    const voiceChannelId = guild.voiceStates?.cache.get(String(senderId))?.channelId;
    if (voice && !voiceChannelId) throw new Error('請先加入語音頻道');
    const room = this.#room(guild.id);
    if (voice && room.channelId && room.channelId !== voiceChannelId) throw new Error('請加入機器人目前所在的語音頻道再操作音樂');
    return { client, channel, guild, voiceChannelId, room, signal };
  }
  async #connect({ client, guild, voiceChannelId, room, signal }) {
    const libs = await this.#libs(); clearTimeout(room.idleTimer);
    signal?.throwIfAborted(); if (this.#destroyed || room.leaving) throw new Error('音樂服務已關閉');
    if (room.connection && room.channelId === voiceChannelId && room.connection.state.status !== libs.VoiceConnectionStatus.Destroyed) {
      await musicTask(libs.entersState(room.connection, libs.VoiceConnectionStatus.Ready, 15000), signal); return;
    }
    room.recoveryController?.abort();
    if (room.connection) { try { room.connection.destroy(); } catch {} }
    const voiceChannel = guild.channels?.cache.get(voiceChannelId) ?? await guild.channels?.fetch?.(voiceChannelId).catch(() => null);
    signal?.throwIfAborted(); if (this.#destroyed || room.leaving) throw new Error('音樂服務已關閉');
    const permissions = voiceChannel?.permissionsFor?.(guild.members?.me);
    if (permissions && (!permissions.has('Connect') || !permissions.has('Speak'))) throw new Error('機器人需要該語音頻道的 Connect 與 Speak 權限');
    room.channelBitrate = voiceChannel?.bitrate ?? null;
    room.bitrate = voiceBitrate(room.channelBitrate, room.requestedBitrate, room.channels);
    const connection = libs.joinVoiceChannel({ channelId: voiceChannelId, guildId: guild.id, group: `dsh-music-${client.user?.id ?? 'bot'}`,
      adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
    room.connection = connection; room.channelId = voiceChannelId;
    connection.on('error', error => this.#log('warn', 'music.connection.error', error));
    connection.on(libs.VoiceConnectionStatus.Disconnected, () => { void this.#recover(room, connection); });
    try { await musicTask(libs.entersState(connection, libs.VoiceConnectionStatus.Ready, 15000), signal); }
    catch (error) { if (room.connection === connection) { room.connection = null; room.channelId = null; } connection.destroy(); if (signal?.aborted) throw error; throw new Error('無法建立語音連線，請確認頻道權限與 UDP 網路'); }
  }
  async #recover(room, connection) {
    if (room.leaving || room.recovering || room.connection !== connection) return;
    const libs = await this.#libs();
    if (room.leaving || room.recovering || room.connection !== connection) return;
    room.recovering = true;
    const controller = new AbortController(); room.recoveryController = controller;
    const wasPlaying = room.state === 'playing', trackId = room.current?.id;
    if (wasPlaying) { room.player?.pause(); room.state = 'reconnecting'; room.transport?.resetTiming?.(); }
    try {
      const result = await this.#recoverVoice(connection, libs, { signal: controller.signal,
        onAttempt: attempt => this.#log('info', 'music.reconnect.attempt', { attempt }) });
      if (room.leaving || room.connection !== connection || controller.signal.aborted) return;
      if (room.player) connection.subscribe(room.player);
      if (wasPlaying && room.current?.id === trackId && room.state === 'reconnecting') {
        room.transport?.resetTiming?.(); room.state = 'playing'; room.player?.unpause();
      }
      this.#log('info', 'music.reconnect.recovered', result);
    } catch (error) {
      if (room.leaving || room.connection !== connection || controller.signal.aborted) return;
      this.#log('warn', 'music.reconnect.failed', error); this.#clear(room); try { connection.destroy(); } catch {}
      room.connection = null; room.channelId = null;
      await this.#say(room.textChannelId, '音樂語音連線中斷，已清除佇列；請使用 /play 重新連線。');
    } finally { if (room.recoveryController === controller) { room.recoveryController = null; room.recovering = false; } }
  }
  #cancel(track) { if (!track) return; track.controller.abort(); track.source?.release?.(); track.source = null; }
  #clear(room) {
    room.recoveryController?.abort(); room.recoveryController = null; room.recovering = false;
    room.transport?.destroy(); room.transport = null;
    room.health?.destroy(); room.health = null;
    room.version++; for (const track of room.tracks.splice(0)) this.#cancel(track);
    const old = room.current; room.current = null; room.resource = null; room.state = 'idle'; this.#cancel(old);
    try { room.player?.stop(true); } catch {}
  }
  #idle(room) {
    clearTimeout(room.idleTimer);
    if (room.leaving || room.current || room.tracks.length || !room.connection) return;
    room.idleTimer = setTimeout(() => { if (!room.current && !room.tracks.length) this.#dispose(room); }, this.#idleMs); room.idleTimer.unref?.();
  }
  #dispose(room) {
    room.leaving = true; clearTimeout(room.idleTimer); this.#clear(room); try { room.connection?.destroy(); } catch {}
    room.connection = null; room.channelId = null;
    if (this.#guilds.get(room.id) === room) this.#guilds.delete(room.id);
  }
  #prepare(room, track) {
    if (!track.preparation) {
      const preparation = this.#pipeline.prepare(track.query, {
        signal: track.controller.signal,
        guildId: room.id,
        allowLocalFile: this.#allowLocalFileFor(track.senderId) === true,
      }).then(source => {
        if (track.controller.signal.aborted || room.leaving) { source.release?.(); throw new Error('歌曲準備已取消'); }
        track.source = source; track.title = source.title; return source;
      });
      track.preparation = musicTask(preparation, track.controller.signal); track.preparation.catch(() => {});
    }
    return track.preparation;
  }
  #prefetch(room) {
    if (!room || room.leaving || this.#destroyed) return;
    // Queue order is playback order: warm the next few tracks while the current
    // one plays, so handing over needs no search and no transcode wait.
    for (const track of prefetchTargets(room.tracks)) {
      if (track.preparation) continue;
      this.#prepare(room, track).catch(() => {});
    }
  }
  #finished(room, id) {
    if (room.current?.id !== id) return;
    room.transport?.destroy(); room.transport = null; room.health?.destroy(); room.health = null;
    const track = room.current; room.current = null; room.resource = null; room.state = 'idle'; this.#cancel(track); this.#pump(room); this.#changed(room);
  }
  #pump(room) {
    if (room.startTask || room.current || room.leaving || this.#destroyed) return;
    if (!room.tracks.length) return this.#idle(room);
    clearTimeout(room.idleTimer);
    room.startTask = this.#start(room).catch(error => this.#log('warn', 'music.start.failed', error)).finally(() => { room.startTask = null; this.#pump(room); });
  }
  async #buildTransport(room, track, { offsetSeconds = 0, signal = track.controller.signal } = {}) {
    const libs = await this.#libs();
    while (true) {
      signal.throwIfAborted();
      const volume = room.volume, bitrate = room.bitrate, channels = room.channels, source = track.source;
      if (!source || room.current !== track || room.leaving) throw new Error('歌曲準備已取消');
      const operation = Promise.resolve(this.#bufferedFactory(libs, source.input, { volume, bitrate, channels, offsetSeconds,
        metadata: { title: source.title, trackId: track.id, url: source.url, lufs: MUSIC_LOUDNESS.integrated }, signal })).then(value => {
        if (signal.aborted || room.leaving || room.current !== track) {
          value.destroy(); signal.throwIfAborted(); throw new Error('歌曲準備已取消');
        }
        return value;
      });
      const transport = await musicTask(operation, signal);
      // A volume command during startup must not leave the old gain in the new encoder.
      if (room.volume !== volume || room.bitrate !== bitrate || room.channels !== channels) { transport.destroy(); continue; }
      return transport;
    }
  }
  async #start(room) {
    const libs = await this.#libs(); if (room.leaving || this.#destroyed) return;
    const track = room.tracks.shift(); if (!track) return;
    const version = room.version; room.current = track; room.state = 'preparing'; this.#prefetch(room);
    try {
      const source = await this.#prepare(room, track);
      if (track.controller.signal.aborted || room.current !== track || room.leaving || version !== room.version) return;
      if (!room.player) {
        const player = libs.createAudioPlayer({ behaviors: { noSubscriber: libs.NoSubscriberBehavior?.Pause, maxMissedFrames: 10 } }); room.player = player;
        player.on('stateChange', (old, state) => {
          if (state.status === libs.AudioPlayerStatus.Idle && old.resource === room.resource) this.#finished(room, old.resource?.metadata?.trackId);
          else if (state.status === libs.AudioPlayerStatus.Playing && state.resource === room.resource && ['paused', 'reconnecting'].includes(room.state)) player.pause();
        });
        player.on('error', error => {
          if (error.resource && error.resource !== room.resource) return;
          this.#log('warn', 'music.player.error', error);
          const id = error.resource?.metadata?.trackId ?? room.current?.id;
          if (id === room.current?.id) { void this.#say(room.textChannelId, `播放失敗：${room.current?.title ?? '歌曲'}，將繼續下一首。`); this.#finished(room, id); }
        });
      }
      await musicTask(libs.entersState(room.connection, libs.VoiceConnectionStatus.Ready, 15000), track.controller.signal);
      if (track.controller.signal.aborted || room.current !== track || room.leaving) return;
      const transport = await this.#buildTransport(room, track);
      if (track.controller.signal.aborted || room.current !== track || room.leaving) { transport.destroy(); return; }
      const resource = transport.resource;
      room.transport = transport; room.resource = resource; room.state = 'playing';
      room.health?.destroy();
      room.health = startMusicHealth(room, (...args) => this.#log(...args), { intervalMs: this.#healthIntervalMs });
      room.connection.subscribe(room.player); room.player.play(resource); this.#changed(room);
      this.#log('info', 'music.playing', { guildId: room.id, title: source.title, selection: source.selection, cacheHit: source.cacheHit });
      void this.#say(track.channelId, `正在播放：${source.title}\n${source.url || ''}${source.selection === 'search-fallback' ? '\nDSH 選歌暫不可用，使用搜尋首選。' : ''}`);
      this.#prefetch(room);
    } catch (error) {
      if (!track.controller.signal.aborted && !room.leaving) { this.#log('warn', 'music.track.failed', error); await this.#say(track.channelId, `無法播放「${track.title ?? track.query}」：${error.message}`); }
      if (room.current === track) this.#finished(room, track.id);
    }
  }
  async play({ channelId, senderId, query, signal }) {
    query = String(query ?? '').trim(); if (!query || query.length > 500) return { message: '請提供歌曲關鍵詞或網址（最多 500 字）' };
    const key = `${channelId}:${senderId}`, now = Date.now();
    if (now - (this.#cooldowns.get(key) ?? 0) < this.#cooldownMs) return { message: '點歌太快，請稍等 3 秒' };
    const context = await this.#context(channelId, senderId, { signal }), { room } = context;
    if (room.tracks.length >= MUSIC_MAX_QUEUE) return { message: `佇列已達 ${MUSIC_MAX_QUEUE} 首上限` };
    await this.#connect(context); signal?.throwIfAborted(); if (this.#destroyed || room.leaving) return { message: '音樂服務已關閉' };
    if (room.tracks.length >= MUSIC_MAX_QUEUE) return { message: `佇列已達 ${MUSIC_MAX_QUEUE} 首上限` };
    this.#cooldowns.set(key, now);
    if (this.#cooldowns.size > 1000) for (const [id, time] of this.#cooldowns) if (now - time > 60000) this.#cooldowns.delete(id);
    const occupied = Boolean(room.current || room.startTask || room.tracks.length); room.textChannelId = channelId;
    room.tracks.push({ id: randomUUID(), query, title: null, senderId, channelId, controller: new AbortController(), source: null });
    this.#pump(room); this.#prefetch(room);
    return { message: occupied ? `已加入音樂佇列：${query}` : `正在準備歌曲並統一音量：${query}` };
  }
  async join({ channelId, senderId, signal }) { const context = await this.#context(channelId, senderId, { signal }); await this.#connect(context); signal?.throwIfAborted(); this.#idle(context.room); return { message: `已加入 <#${context.voiceChannelId}>` }; }
  async next({ channelId, senderId, signal }) {
    const { room } = await this.#context(channelId, senderId, { signal });
    if (!room.current && !room.tracks.length && !room.startTask) return { message: '目前沒有播放中的歌曲' };
    const track = room.current ?? room.tracks.shift(); room.current = null; room.resource = null; room.state = 'idle'; room.version++;
    room.transport?.destroy(); room.transport = null; room.health?.destroy(); room.health = null;
    this.#cancel(track); room.player?.stop(true); this.#pump(room); this.#changed(room); return { message: '已跳過，正在準備下一首' };
  }
  async stop({ channelId, senderId, signal }) { const { room } = await this.#context(channelId, senderId, { signal }); this.#clear(room); this.#idle(room); this.#changed(room); return { message: '已停止音樂並清空佇列' }; }
  async pause({ channelId, senderId, signal }) { const { room } = await this.#context(channelId, senderId, { signal }); if (room.state !== 'playing') return { message: '目前沒有可暫停的歌曲' }; room.player?.pause(); room.transport?.resetTiming?.(); room.state = 'paused'; this.#changed(room); return { message: '音樂已暫停' }; }
  async resume({ channelId, senderId, signal }) { const { room } = await this.#context(channelId, senderId, { signal }); if (room.state !== 'paused') return { message: '目前沒有暫停中的歌曲' }; room.transport?.resetTiming?.(); room.state = 'playing'; room.player?.unpause(); this.#changed(room); return { message: '繼續播放音樂' }; }
  async queue({ channelId, senderId, signal }) {
    const { room } = await this.#context(channelId, senderId, { voice: false, signal });
    const lines = room.current ? [`${room.state === 'preparing' ? '準備中' : room.state === 'paused' ? '已暫停' : '正在播放'}：${room.current.title ?? room.current.query}`] : [];
    room.tracks.slice(0, 20).forEach((track, index) => lines.push(`${index + 1}. ${track.title ?? track.query}`));
    if (room.tracks.length > 20) lines.push(`另外還有 ${room.tracks.length - 20} 首`); return { message: lines.join('\n') || '音樂佇列目前是空的' };
  }
  async nowplaying({ channelId, senderId, signal }) { const { room } = await this.#context(channelId, senderId, { voice: false, signal }); return { message: room.current ? `${room.state === 'preparing' ? '準備中' : '目前歌曲'}：${room.current.title ?? room.current.query}\n${room.current.source?.url ?? ''}` : '目前沒有播放中的歌曲' }; }
  async status({ channelId, senderId, signal }) {
    const { room } = await this.#context(channelId, senderId, { voice: false, signal });
    let ping; try { ping = room.connection?.ping; } catch {}
    const frames = room.transport?.snapshot(); const health = room.health?.snapshot();
    const number = value => Number.isFinite(value) ? Math.round(value) : '尚無資料';
    const encoder = frames?.encoder === 'ffmpeg' ? `FFmpeg 子程序／${frames.channels === 2 ? '雙聲道立體聲' : '單聲道'}，主程序不重編碼` : '尚無播放資料';
    const execution = isMainThread ? '主程序' : '獨立 worker';
    const fallbackLimit = `${voiceBitrate() / 1000} kbps 為上限`;
    return { message: `語音狀態：${room.connection?.state?.status ?? '未連線'}\nUDP 往返：${number(ping?.udp)} ms；WebSocket：${number(ping?.ws)} ms\n音訊碼率：${(frames?.bitrate ?? room.bitrate) / 1000} kbps；目標：${room.requestedBitrate / 1000} kbps\n頻道上限：${room.channelBitrate ? `${room.channelBitrate / 1000} kbps` : `尚無資料（暫以 ${fallbackLimit}）`}\n音訊預讀：${frames?.bufferedMs ?? 0} ms（非端到端延遲）\n播放編碼：${encoder}\n播放執行：${execution}\n來源缺包：${frames?.sourceStarved ?? 0}；${execution}最大延遲：${number(health?.eventLoopMaxMs)} ms\n預讀：最多 ${MUSIC_PREFETCH_DEPTH} 首（先搜尋並解碼，輪到時直接播放）；待預讀 ${room.tracks.filter(track => !track.preparation).length} 首\nUDP 往返不是 RTP 丟包率；尚無接收端丟包統計。` };
  }
  async volume({ channelId, senderId, percent, deltaPercent, signal }) {
    const { room } = await this.#context(channelId, senderId, { signal });
    if (deltaPercent !== undefined) {
      if (percent !== undefined || !Number.isInteger(deltaPercent) || deltaPercent === 0 || Math.abs(deltaPercent) > 100) return { message: '音量調整須選擇百分比或相對增減，不能同時指定。' };
      percent = Math.min(100, Math.max(0, Math.round(room.volume * 100) + deltaPercent));
    }
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) return { message: '用法：/music volume 0–100' };
    const previousVolume = room.volume; room.volume = percent / 100;
    if (room.resource?.volume) room.resource.volume.setVolume(room.volume);
    else if (room.current && room.resource && room.volume !== previousVolume) {
      await this.#replacePlayback(room, signal, () => { room.volume = previousVolume; });
    }
    return { message: `音樂音量已設為 ${percent}%` };
  }
  async bitrate({ channelId, senderId, kbps, signal }) {
    if (kbps !== undefined && (!Number.isInteger(kbps) || kbps < 16 || kbps > 384)) return { message: '用法：/music bitrate [16–384]，單位 kbps；超過 256 請使用 /music channels 2；省略數值可查看目前設定' };
    const { room, guild, voiceChannelId } = await this.#context(channelId, senderId, { voice: kbps !== undefined, signal });
    if (kbps !== undefined) {
      const voiceChannel = guild.channels?.cache.get(voiceChannelId) ?? await guild.channels?.fetch?.(voiceChannelId).catch(() => null);
      signal?.throwIfAborted();
      const previous = { requestedBitrate: room.requestedBitrate, bitrate: room.bitrate };
      room.channelBitrate = voiceChannel?.bitrate ?? room.channelBitrate;
      room.requestedBitrate = kbps * 1000;
      room.bitrate = voiceBitrate(room.channelBitrate, room.requestedBitrate, room.channels);
      if (room.current && room.resource && room.bitrate !== previous.bitrate) {
        await this.#replacePlayback(room, signal, () => Object.assign(room, previous));
      }
    }
    return this.#encodingStatus(room);
  }
  async channels({ channelId, senderId, count, signal }) {
    if (count !== undefined && count !== 1 && count !== 2) return { message: '用法：/music channels [1|2]；1 為單聲道，2 為雙聲道立體聲；省略數值可查看設定' };
    const { room, guild, voiceChannelId } = await this.#context(channelId, senderId, { voice: count !== undefined, signal });
    if (count !== undefined) {
      const voiceChannel = guild.channels?.cache.get(voiceChannelId) ?? await guild.channels?.fetch?.(voiceChannelId).catch(() => null);
      signal?.throwIfAborted();
      const previous = { channels: room.channels, bitrate: room.bitrate };
      room.channelBitrate = voiceChannel?.bitrate ?? room.channelBitrate;
      room.channels = count;
      room.bitrate = voiceBitrate(room.channelBitrate, room.requestedBitrate, room.channels);
      if (room.current && room.resource && (room.channels !== previous.channels || room.bitrate !== previous.bitrate)) {
        await this.#replacePlayback(room, signal, () => Object.assign(room, previous));
      }
    }
    return this.#encodingStatus(room);
  }
  #encodingStatus(room) {
    const frames = room.transport?.snapshot();
    const actual = frames?.bitrate;
    const rate = actual ?? room.bitrate;
    const limit = room.channelBitrate ? `${room.channelBitrate / 1000} kbps` : `尚無資料（暫以 ${voiceBitrate() / 1000} kbps 為上限）`;
    const channels = frames?.channels ?? room.channels;
    const hint = room.requestedBitrate > rate ? (room.channels === 1 && room.requestedBitrate > 256000
      ? '\n單聲道上限為 256 kbps；請先 /music channels 2，並確認語音頻道碼率足夠。'
      : '\n目標高於目前可用碼率；請確認語音頻道的碼率設定。') : '';
    return { message: `音樂目標碼率：${room.requestedBitrate / 1000} kbps\n${actual ? '目前輸出' : '預計輸出'}：${rate / 1000} kbps；頻道上限：${limit}\n聲道：${channels === 2 ? '2（雙聲道立體聲）' : '1（單聲道）'}${hint}\n設定沿用至離開語音或外掛重載；/music channels ${MUSIC_PLAYBACK_PROFILE.channels} 及 /music bitrate ${MUSIC_PLAYBACK_PROFILE.bitrate / 1000} 可恢復預設。` };
  }
  async #replacePlayback(room, signal, rollback, { offsetSeconds: explicitOffset } = {}) {
    const track = room.current, previous = room.transport, oldResource = room.resource, previousState = room.state;
    const active = signal ? AbortSignal.any([signal, track.controller.signal]) : track.controller.signal;
    // A seek overrides the "carry on from where the old encoder stopped" offset.
    const offsetSeconds = explicitOffset ?? (previous?.offsetSeconds ?? 0) + (oldResource.playbackDuration ?? 0) / 1000;
    room.player?.pause(); if (room.state === 'playing') room.state = 'paused';
    let replacement;
    try {
      replacement = await this.#buildTransport(room, track, { offsetSeconds, signal: active });
      const libs = await this.#libs();
      if (previousState === 'playing') await musicTask(libs.entersState(room.connection, libs.VoiceConnectionStatus.Ready, 15000), active);
      active.throwIfAborted();
      if (room.current !== track || room.transport !== previous || room.leaving) throw new Error('歌曲已切換，音訊調整已取消');
      room.player.play(replacement.resource);
      room.transport = replacement; room.resource = replacement.resource;
      room.state = previousState;
      if (previousState !== 'playing') room.player.pause(); else room.player.unpause();
      room.health?.destroy(); room.health = startMusicHealth(room, (...args) => this.#log(...args), { intervalMs: this.#healthIntervalMs });
      previous?.destroy();
      this.#changed(room);
    } catch (error) {
      replacement?.destroy();
      if (room.current === track && room.transport === previous) {
        rollback(); room.state = previousState;
        if (previousState === 'playing') room.player?.unpause();
      }
      throw error;
    }
  }
  /** Playback state for the card and the web console; never throws. */
  snapshot(guildId) {
    const room = this.#guilds.get(String(guildId));
    if (!room || (!room.current && !room.tracks.length)) {
      return { state: 'idle', title: null, url: null, positionMs: 0, durationMs: 0, loop: 'off', volume: Math.round(MUSIC_DEFAULT_VOLUME * 100), queue: [], requester: null, channelId: null };
    }
    const track = room.current;
    return {
      state: track ? room.state : 'preparing',
      title: track?.title ?? track?.query ?? null,
      url: track?.source?.url ?? null,
      positionMs: this.#positionMs(room),
      durationMs: Math.max(0, Math.round((Number(track?.source?.duration) || 0) * 1000)),
      loop: 'off',
      volume: Math.round((Number(room.volume) || MUSIC_DEFAULT_VOLUME) * 100),
      queue: room.tracks.map((item) => item.title ?? item.query),
      requester: track?.senderId ? `<@${track.senderId}>` : null,
      channelId: room.textChannelId ?? track?.channelId ?? null,
    };
  }

  /** Seconds already played on the current track, straight from the live resource. */
  #positionMs(room) {
    if (!room?.current || !room.resource) return 0;
    const base = Number(room.transport?.offsetSeconds) || 0;
    const played = Number(room.resource.playbackDuration) || 0;
    return Math.max(0, Math.round((base + played) * 1000));
  }

  #changed(room) {
    if (!room || !this.#onPlaybackChange) return;
    try { this.#onPlaybackChange(room.id); } catch (error) { this.#log('warn', 'music.panel.notify', error); }
  }

  async seek({ channelId, senderId, positionMs, signal }) {
    const { room } = await this.#context(channelId, senderId, { signal });
    return this.#seekRoom(room, positionMs, signal, { announce: true });
  }

  async #seekRoom(room, positionMs, signal, { announce = false } = {}) {
    if (!room.current || !room.resource) return { ok: false, message: '目前沒有可跳轉的歌曲' };
    if (room.state === 'preparing') return { ok: false, message: '歌曲還在準備中，請稍後再跳轉' };
    const durationMs = Math.round((Number(room.current.source?.duration) || 0) * 1000);
    const target = clampSeekTarget(positionMs, durationMs);
    if (!seekIsMeaningful(target, this.#positionMs(room))) return { ok: true, message: `已經在 ${formatClock(target)}` };
    await this.#replacePlayback(room, signal, () => {}, { offsetSeconds: target / 1000 });
    const message = `已跳到 ${formatClock(target)}`;
    if (announce) void this.#say(room.textChannelId, message);
    return { ok: true, message };
  }

  /** Console path: a guild id, with no text channel or sender to resolve. */
  async control(guildId, action, { positionMs } = {}) {
    const room = this.#guilds.get(String(guildId));
    if (!room || room.leaving) return { ok: false, message: '目前沒有播放中的歌曲' };
    if (action === 'pause') {
      if (room.state !== 'playing') return { ok: false, message: '目前沒有可暫停的歌曲' };
      room.player?.pause(); room.transport?.resetTiming?.(); room.state = 'paused'; this.#changed(room);
      return { ok: true, message: '音樂已暫停' };
    }
    if (action === 'resume') {
      if (room.state !== 'paused') return { ok: false, message: '目前沒有暫停中的歌曲' };
      room.transport?.resetTiming?.(); room.state = 'playing'; room.player?.unpause(); this.#changed(room);
      return { ok: true, message: '繼續播放音樂' };
    }
    if (action === 'next') {
      if (!room.current && !room.tracks.length && !room.startTask) return { ok: false, message: '目前沒有播放中的歌曲' };
      const track = room.current ?? room.tracks.shift();
      room.current = null; room.resource = null; room.state = 'idle'; room.version++;
      room.transport?.destroy(); room.transport = null; room.health?.destroy(); room.health = null;
      this.#cancel(track); room.player?.stop(true); this.#pump(room); this.#changed(room);
      return { ok: true, message: '已跳過，正在準備下一首' };
    }
    if (action === 'seek') return this.#seekRoom(room, positionMs, this.#lifetime.signal);
    return { ok: false, message: '不支援的動作' };
  }

  async leave({ channelId, senderId, signal }) { const { room } = await this.#context(channelId, senderId, { signal }); this.#dispose(room); return { message: '已停止音樂並離開語音頻道' }; }
  async destroy() {
    this.#destroyed = true; this.#lifetime.abort(); this.#commands.destroy();
    const tasks = [...this.#guilds.values()].map(room => room.startTask).filter(Boolean);
    for (const room of [...this.#guilds.values()]) this.#dispose(room);
    await this.#pipeline.destroy?.(); await Promise.allSettled(tasks);
    try { this.#client?.destroy(); } catch {} this.#client = null; this.#login = null; this.#cooldowns.clear();
  }
}

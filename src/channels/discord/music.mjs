import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MusicAudioPipeline, musicTools } from './music-audio.mjs';
import { createDshMusicSelector } from './music-dsh.mjs';

export const MUSIC_AUDIO_URL = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)(\?|#|$)/i;
export const MUSIC_MAX_QUEUE = 25;
export const DEFAULT_YTDLP_CANDIDATES = Object.freeze([process.env.DSK_DISCORD_YTDLP, musicTools().ytDlp]);
export function defaultYtDlpPath(candidates = DEFAULT_YTDLP_CANDIDATES) { return candidates.find(value => value && existsSync(value)) ?? 'yt-dlp'; }
export function isPlayableUrl(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
export function needsExtractor(value) { return isPlayableUrl(value) && /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|bilibili\.com|b23\.tv|nicovideo\.jp|vimeo\.com|twitch\.tv)$/.test(new URL(value).hostname); }

/** Per-guild playback. A cancelled preparation can never resurrect a stopped track. */
export class MusicManager {
  #token; #logger; #runtime; #pipeline; #notify; #client; #login; #library;
  #guilds = new Map(); #cooldowns = new Map(); #destroyed = false; #idleMs; #cooldownMs;
  constructor({ token, logger = null, runtime = null, ytDlpPath = null, pipeline = null, harness = null, notify = null, idleMs = 180000, cooldownMs = 3000 } = {}) {
    this.#token = token; this.#logger = logger; this.#runtime = runtime; this.#notify = notify;
    this.#idleMs = idleMs; this.#cooldownMs = cooldownMs;
    const tools = musicTools(); if (ytDlpPath) tools.ytDlp = ytDlpPath;
    this.#pipeline = pipeline ?? new MusicAudioPipeline({ tools, logger, selectCandidate: createDshMusicSelector(harness, { logger }) });
  }
  get available() { return !this.#destroyed && typeof this.#token === 'string' && this.#token.length > 0; }
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
        try {
          await client.login(this.#token);
          if (typeof client.isReady === 'function' && !client.isReady()) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { client.removeListener('clientReady', ready); reject(new Error('Discord 語音用戶端連線逾時')); }, 20000);
            const ready = () => { clearTimeout(timer); resolve(); };
            client.once('clientReady', ready);
            if (client.isReady()) { client.removeListener('clientReady', ready); ready(); }
          });
          if (this.#destroyed) throw new Error('音樂服務已關閉');
          return client;
        } catch (error) { client.destroy(); this.#client = null; throw error; }
      })();
      this.#login.catch(() => { this.#login = null; });
    }
    return this.#login;
  }
  #room(id) {
    if (!this.#guilds.has(id)) this.#guilds.set(id, { id, tracks: [], current: null, player: null, connection: null, channelId: null,
      textChannelId: null, resource: null, state: 'idle', volume: 1, leaving: false, version: 0, startTask: null, idleTimer: null, recovering: false });
    return this.#guilds.get(id);
  }
  async #context(channelId, senderId, { voice = true } = {}) {
    const client = await this.#ready();
    const channel = client.channels.cache.get(String(channelId)) ?? await client.channels.fetch(String(channelId)).catch(() => null);
    const guild = channel?.guild; if (!guild) throw new Error('請在伺服器頻道使用音樂指令');
    const voiceChannelId = guild.voiceStates?.cache.get(String(senderId))?.channelId;
    if (voice && !voiceChannelId) throw new Error('請先加入語音頻道');
    const room = this.#room(guild.id);
    if (voice && room.channelId && room.channelId !== voiceChannelId && (room.current || room.tracks.length)) throw new Error('請加入機器人目前所在的語音頻道再操作音樂');
    return { client, channel, guild, voiceChannelId, room };
  }
  async #connect({ client, guild, voiceChannelId, room }) {
    const libs = await this.#libs(); clearTimeout(room.idleTimer);
    if (room.connection && room.channelId === voiceChannelId && room.connection.state.status !== libs.VoiceConnectionStatus.Destroyed) {
      await libs.entersState(room.connection, libs.VoiceConnectionStatus.Ready, 15000); return;
    }
    if (room.connection) { try { room.connection.destroy(); } catch {} }
    const voiceChannel = guild.channels?.cache.get(voiceChannelId) ?? await guild.channels?.fetch?.(voiceChannelId).catch(() => null);
    const permissions = voiceChannel?.permissionsFor?.(guild.members?.me);
    if (permissions && (!permissions.has('Connect') || !permissions.has('Speak'))) throw new Error('機器人需要該語音頻道的 Connect 與 Speak 權限');
    const connection = libs.joinVoiceChannel({ channelId: voiceChannelId, guildId: guild.id, group: `dsh-music-${client.user?.id ?? 'bot'}`,
      adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
    room.connection = connection; room.channelId = voiceChannelId;
    connection.on('error', error => this.#log('warn', 'music.connection.error', error));
    connection.on(libs.VoiceConnectionStatus.Disconnected, () => { void this.#recover(room, connection); });
    try { await libs.entersState(connection, libs.VoiceConnectionStatus.Ready, 15000); }
    catch { if (room.connection === connection) { room.connection = null; room.channelId = null; } connection.destroy(); throw new Error('無法建立語音連線，請確認頻道權限與 UDP 網路'); }
  }
  async #recover(room, connection) {
    if (room.leaving || room.recovering || room.connection !== connection) return;
    room.recovering = true; const libs = await this.#libs();
    try {
      try { await Promise.race([libs.entersState(connection, libs.VoiceConnectionStatus.Signalling, 5000), libs.entersState(connection, libs.VoiceConnectionStatus.Connecting, 5000)]); }
      catch { connection.rejoin?.(); }
      await libs.entersState(connection, libs.VoiceConnectionStatus.Ready, 15000);
      if (!room.leaving && room.connection === connection && room.player) connection.subscribe(room.player);
    } catch (error) {
      if (room.leaving || room.connection !== connection) return;
      this.#log('warn', 'music.reconnect.failed', error); this.#clear(room); try { connection.destroy(); } catch {}
      room.connection = null; room.channelId = null;
      await this.#say(room.textChannelId, '音樂語音連線中斷，已清除佇列；請使用 /play 重新連線。');
    } finally { room.recovering = false; }
  }
  #cancel(track) { if (!track) return; track.controller.abort(); track.source?.release?.(); track.source = null; }
  #clear(room) {
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
      track.preparation = this.#pipeline.prepare(track.query, { signal: track.controller.signal, guildId: room.id }).then(source => {
        if (track.controller.signal.aborted || room.leaving) { source.release?.(); throw new Error('歌曲準備已取消'); }
        track.source = source; track.title = source.title; return source;
      }); track.preparation.catch(() => {});
    }
    return track.preparation;
  }
  #prefetch(room) { const next = room.tracks[0]; if (next && !room.leaving) this.#prepare(room, next); }
  #finished(room, id) {
    if (room.current?.id !== id) return;
    const track = room.current; room.current = null; room.resource = null; room.state = 'idle'; this.#cancel(track); this.#pump(room);
  }
  #pump(room) {
    if (room.startTask || room.current || room.leaving || this.#destroyed) return;
    if (!room.tracks.length) return this.#idle(room);
    clearTimeout(room.idleTimer);
    room.startTask = this.#start(room).catch(error => this.#log('warn', 'music.start.failed', error)).finally(() => { room.startTask = null; this.#pump(room); });
  }
  async #start(room) {
    const libs = await this.#libs(); if (room.leaving || this.#destroyed) return;
    const track = room.tracks.shift(); if (!track) return;
    const version = room.version; room.current = track; room.state = 'preparing'; this.#prefetch(room);
    try {
      const source = await this.#prepare(room, track);
      if (track.controller.signal.aborted || room.current !== track || room.leaving || version !== room.version) return;
      if (!room.player) {
        const player = libs.createAudioPlayer({ behaviors: { noSubscriber: libs.NoSubscriberBehavior?.Pause } }); room.player = player;
        player.on('stateChange', (old, state) => { if (state.status === libs.AudioPlayerStatus.Idle) this.#finished(room, old.resource?.metadata?.trackId); });
        player.on('error', error => {
          this.#log('warn', 'music.player.error', error);
          const id = error.resource?.metadata?.trackId ?? room.current?.id;
          if (id === room.current?.id) { void this.#say(room.textChannelId, `播放失敗：${room.current?.title ?? '歌曲'}，將繼續下一首。`); this.#finished(room, id); }
        });
      }
      await libs.entersState(room.connection, libs.VoiceConnectionStatus.Ready, 15000);
      if (track.controller.signal.aborted || room.current !== track || room.leaving) return;
      const resource = libs.createAudioResource(source.input, { inputType: libs.StreamType?.OggOpus, inlineVolume: true,
        metadata: { title: source.title, trackId: track.id, url: source.url, lufs: -16 } });
      resource.volume?.setVolume(room.volume); room.resource = resource; room.state = 'playing';
      room.connection.subscribe(room.player); room.player.play(resource);
      this.#log('info', 'music.playing', { guildId: room.id, title: source.title, selection: source.selection, cacheHit: source.cacheHit });
      void this.#say(track.channelId, `正在播放：${source.title}\n${source.url || ''}${source.selection === 'search-fallback' ? '\nDSH 選歌暫不可用，使用搜尋首選。' : ''}`);
      this.#prefetch(room);
    } catch (error) {
      if (!track.controller.signal.aborted && !room.leaving) { this.#log('warn', 'music.track.failed', error); await this.#say(track.channelId, `無法播放「${track.title ?? track.query}」：${error.message}`); }
      if (room.current === track) { room.current = null; room.state = 'idle'; this.#cancel(track); }
    }
  }
  async play({ channelId, senderId, query }) {
    query = String(query ?? '').trim(); if (!query || query.length > 500) return { message: '請提供歌曲關鍵詞或網址（最多 500 字）' };
    const key = `${channelId}:${senderId}`, now = Date.now();
    if (now - (this.#cooldowns.get(key) ?? 0) < this.#cooldownMs) return { message: '點歌太快，請稍等 3 秒' };
    const context = await this.#context(channelId, senderId), { room } = context;
    if (room.tracks.length >= MUSIC_MAX_QUEUE) return { message: `佇列已達 ${MUSIC_MAX_QUEUE} 首上限` };
    await this.#connect(context); if (this.#destroyed || room.leaving) return { message: '音樂服務已關閉' };
    if (room.tracks.length >= MUSIC_MAX_QUEUE) return { message: `佇列已達 ${MUSIC_MAX_QUEUE} 首上限` };
    this.#cooldowns.set(key, now);
    if (this.#cooldowns.size > 1000) for (const [id, time] of this.#cooldowns) if (now - time > 60000) this.#cooldowns.delete(id);
    const occupied = Boolean(room.current || room.startTask || room.tracks.length); room.textChannelId = channelId;
    room.tracks.push({ id: randomUUID(), query, title: null, senderId, channelId, controller: new AbortController(), source: null });
    this.#pump(room); this.#prefetch(room);
    return { message: occupied ? `已加入音樂佇列：${query}` : `正在準備歌曲並統一音量：${query}` };
  }
  async join({ channelId, senderId }) { const context = await this.#context(channelId, senderId); await this.#connect(context); this.#idle(context.room); return { message: `已加入 <#${context.voiceChannelId}>` }; }
  async next({ channelId, senderId }) {
    const { room } = await this.#context(channelId, senderId);
    if (!room.current && !room.tracks.length && !room.startTask) return { message: '目前沒有播放中的歌曲' };
    const track = room.current ?? room.tracks.shift(); room.current = null; room.resource = null; room.state = 'idle'; room.version++;
    this.#cancel(track); room.player?.stop(true); this.#pump(room); return { message: '已跳過，正在準備下一首' };
  }
  async stop({ channelId, senderId }) { const { room } = await this.#context(channelId, senderId); this.#clear(room); this.#idle(room); return { message: '已停止音樂並清空佇列' }; }
  async pause({ channelId, senderId }) { const { room } = await this.#context(channelId, senderId); if (room.state !== 'playing') return { message: '目前沒有可暫停的歌曲' }; room.player?.pause(); room.state = 'paused'; return { message: '音樂已暫停' }; }
  async resume({ channelId, senderId }) { const { room } = await this.#context(channelId, senderId); if (room.state !== 'paused') return { message: '目前沒有暫停中的歌曲' }; room.player?.unpause(); room.state = 'playing'; return { message: '繼續播放音樂' }; }
  async queue({ channelId, senderId }) {
    const { room } = await this.#context(channelId, senderId, { voice: false });
    const lines = room.current ? [`${room.state === 'preparing' ? '準備中' : room.state === 'paused' ? '已暫停' : '正在播放'}：${room.current.title ?? room.current.query}`] : [];
    room.tracks.slice(0, 20).forEach((track, index) => lines.push(`${index + 1}. ${track.title ?? track.query}`));
    if (room.tracks.length > 20) lines.push(`另外還有 ${room.tracks.length - 20} 首`); return { message: lines.join('\n') || '音樂佇列目前是空的' };
  }
  async nowplaying({ channelId, senderId }) { const { room } = await this.#context(channelId, senderId, { voice: false }); return { message: room.current ? `${room.state === 'preparing' ? '準備中' : '目前歌曲'}：${room.current.title ?? room.current.query}\n${room.current.source?.url ?? ''}` : '目前沒有播放中的歌曲' }; }
  async volume({ channelId, senderId, percent }) {
    const { room } = await this.#context(channelId, senderId); if (!Number.isInteger(percent) || percent < 0 || percent > 100) return { message: '用法：/music volume 0–100' };
    room.volume = percent / 100; room.resource?.volume?.setVolume(room.volume); return { message: `音樂音量已設為 ${percent}%` };
  }
  async leave({ channelId, senderId }) { const { room } = await this.#context(channelId, senderId); this.#dispose(room); return { message: '已停止音樂並離開語音頻道' }; }
  async destroy() {
    this.#destroyed = true; const tasks = [...this.#guilds.values()].map(room => room.startTask).filter(Boolean);
    for (const room of [...this.#guilds.values()]) this.#dispose(room);
    await this.#pipeline.destroy?.(); await Promise.allSettled(tasks);
    try { this.#client?.destroy(); } catch {} this.#client = null; this.#login = null; this.#cooldowns.clear();
  }
}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Voice-channel music for one Discord application.
 *
 * The chat connection this fork owns is a raw gateway client, so it cannot feed
 * a voice channel. This manager keeps a separate, voice-only discord.js client
 * (same token) purely to join channels, and runs a per-guild queue on top of
 * `@discordjs/voice`. Both libraries are loaded lazily and resolve from the
 * plugin's own `node_modules`, which is why the bundler keeps them external.
 */

const AUDIO_URL = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)(\?|#|$)/i;
const PLATFORM_URL = /^https?:\/\/(?:[^/]+\.)?(?:youtube\.com|youtu\.be|soundcloud\.com|bilibili\.com|b23\.tv|nicovideo\.jp|vimeo\.com|twitch\.tv)\//i;
const MAX_QUEUE = 25;
const MAX_QUERY_LENGTH = 500;

export const MUSIC_AUDIO_URL = AUDIO_URL;
export const MUSIC_MAX_QUEUE = MAX_QUEUE;

/** yt-dlp is not installed globally; reuse the copy AudioUsbStudio ships. */
export const DEFAULT_YTDLP_CANDIDATES = Object.freeze([
  process.env.DSK_DISCORD_YTDLP,
  'C:\\Users\\TINGOD\\Desktop\\CodeHome\\AudioUsbStudio\\tools\\bin\\yt-dlp.exe',
]);

export function defaultYtDlpPath(candidates = DEFAULT_YTDLP_CANDIDATES) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return 'yt-dlp';
}

export function isPlayableUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
}

export function needsExtractor(value) {
  return isPlayableUrl(value) && PLATFORM_URL.test(value.trim());
}

function lastLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function runCollect(file, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms: ${file}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} exited with ${code}: ${lastLine(stderr)}`));
    });
  });
}

export class MusicManager {
  #token;
  #logger;
  #runtime;
  #ytDlpPath;
  #client = null;
  #login = null;
  #library = null;
  #guilds = new Map();
  #downloadDir = null;
  #cooldowns = new Map();

  constructor({ token, logger = null, runtime = null, ytDlpPath = null } = {}) {
    this.#token = token;
    this.#logger = logger;
    this.#runtime = runtime;
    this.#ytDlpPath = ytDlpPath ?? defaultYtDlpPath();
  }

  get available() {
    return typeof this.#token === 'string' && this.#token.length > 0;
  }

  async #libs() {
    if (this.#library) return this.#library;
    if (this.#runtime) {
      this.#library = this.#runtime;
      return this.#library;
    }
    const [discord, voice] = await Promise.all([import('discord.js'), import('@discordjs/voice')]);
    this.#library = {
      Client: discord.Client,
      GatewayIntentBits: discord.GatewayIntentBits,
      joinVoiceChannel: voice.joinVoiceChannel,
      createAudioPlayer: voice.createAudioPlayer,
      createAudioResource: voice.createAudioResource,
      AudioPlayerStatus: voice.AudioPlayerStatus,
      VoiceConnectionStatus: voice.VoiceConnectionStatus,
      entersState: voice.entersState,
      NoSubscriberBehavior: voice.NoSubscriberBehavior,
    };
    return this.#library;
  }

  async #ready() {
    if (!this.available) throw new Error('Discord token is not configured');
    const libs = await this.#libs();
    if (!this.#login) {
      this.#login = (async () => {
        const client = new libs.Client({
          intents: [libs.GatewayIntentBits.Guilds, libs.GatewayIntentBits.GuildVoiceStates],
        });
        client.on('error', (error) => this.#log('warn', 'music.client.error', error));
        await client.login(this.#token);
        this.#client = client;
        return client;
      })();
      this.#login.catch(() => { this.#login = null; });
    }
    return this.#login;
  }

  async #guild(channelId) {
    const client = await this.#ready();
    const channel = client.channels.cache.get(String(channelId))
      ?? await client.channels.fetch(String(channelId)).catch(() => null);
    const guild = channel?.guild ?? null;
    if (!guild) throw new Error('This command only works inside a server channel');
    const voiceStates = guild.voiceStates?.cache;
    return { client, channel, guild, voiceStates };
  }

  async #tempDir() {
    if (!this.#downloadDir) this.#downloadDir = await mkdtemp(join(tmpdir(), 'dsh-discord-music-'));
    return this.#downloadDir;
  }

  #log(level, event, error) {
    try {
      this.#logger?.(level, event, error instanceof Error ? error.message : error);
    } catch { /* logging must never break playback */ }
  }

  #room(guildId) {
    let room = this.#guilds.get(guildId);
    if (!room) {
      room = { connection: null, player: null, tracks: [], playing: null, channelId: null, leaving: false };
      this.#guilds.set(guildId, room);
    }
    return room;
  }

  async #connection({ guild, voiceChannelId, voiceStates }) {
    const libs = await this.#libs();
    const room = this.#room(guild.id);
    if (room.connection && room.channelId === voiceChannelId
      && room.connection.state.status !== libs.VoiceConnectionStatus.Destroyed) {
      return room.connection;
    }
    if (room.connection) {
      try { room.connection.destroy(); } catch { /* already gone */ }
      room.connection = null;
    }
    const connection = libs.joinVoiceChannel({
      channelId: voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    room.connection = connection;
    room.channelId = voiceChannelId;
    connection.on('error', (error) => this.#log('warn', 'music.connection.error', error));
    connection.on(libs.VoiceConnectionStatus.Disconnected, () => {
      this.#log('info', 'music.connection.disconnected', guild.id);
      room.connection = null;
    });
    return connection;
  }

  /** Resolve a chat query into something `createAudioResource` accepts. */
  async #resolveSource(query) {
    const value = String(query ?? '').trim();
    if (!value) throw new Error('Empty request');
    if (value.length > MAX_QUERY_LENGTH) throw new Error('Request is too long');
    if (existsSync(value)) return { input: value, title: value.split(/[\\/]/).pop(), temporary: false };
    if (AUDIO_URL.test(value) || (isPlayableUrl(value) && !needsExtractor(value))) {
      return { input: value, title: value.split('/').pop()?.split('?')[0] || value, temporary: false };
    }
    if (!this.#ytDlpPath) throw new Error('yt-dlp is not available');
    const dir = await this.#tempDir();
    const target = needsExtractor(value)
      ? value
      : `ytsearch1:${value}`;
    const template = join(dir, '%(id)s.%(ext)s');
    const { stdout } = await runCollect(this.#ytDlpPath, [
      '--no-playlist',
      '--no-warnings',
      '-f', 'bestaudio/best',
      '-o', template,
      '--print', '%(title)s',
      '--print', 'after_move:filepath',
      '--', target,
    ]);
    const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const file = lines[lines.length - 1];
    const title = lines.length > 1 ? lines[lines.length - 2] : null;
    if (!file) throw new Error('yt-dlp did not produce a file');
    return { input: file, title: title || file.split(/[\\/]/).pop(), temporary: true };
  }

  async #startNext(guildId) {
    const libs = await this.#libs();
    const room = this.#room(guildId);
    if (room.playing) return;
    const track = room.tracks.shift();
    if (!track) {
      this.#log('info', 'music.queue.empty', guildId);
      return;
    }
    const player = room.player ?? libs.createAudioPlayer({ behaviors: { noSubscriber: libs.NoSubscriberBehavior?.Pause } });
    if (!room.player) {
      room.player = player;
      player.on(libs.AudioPlayerStatus.Idle, () => {
        room.playing = null;
        room.connection?.subscribe?.(null);
        void this.#startNext(guildId).catch((error) => this.#log('warn', 'music.next.failed', error));
      });
      player.on('error', (error) => {
        this.#log('warn', 'music.player.error', error);
        room.playing = null;
        void this.#startNext(guildId).catch(() => {});
      });
    }
    room.playing = track;
    try {
      const source = await this.#resolveSource(track.query);
      const resource = libs.createAudioResource(source.input, { metadata: { title: source.title ?? track.query } });
      room.connection?.subscribe?.(player);
      player.play(resource);
      track.title = source.title ?? track.title;
    } catch (error) {
      this.#log('warn', 'music.track.failed', error);
      room.playing = null;
      return this.#startNext(guildId);
    }
  }

  #checkCooldown(senderId) {
    if (!senderId) return null;
    const now = Date.now();
    const last = this.#cooldowns.get(senderId) ?? 0;
    if (now - last < 3_000) return 3;
    this.#cooldowns.set(senderId, now);
    return null;
  }

  async play({ channelId, senderId, query }) {
    if (!this.available) return { message: '音乐功能没配 token，先跳过嘛' };
    const cooldown = this.#checkCooldown(senderId);
    if (cooldown) return { message: `别急嘛，${cooldown} 秒后再点` };
    const { guild, voiceStates } = await this.#guild(channelId);
    const voiceChannelId = voiceStates?.get(String(senderId))?.channelId;
    if (!voiceChannelId) return { message: '先进一个语音频道，我才能跟着进去嘛' };
    const room = this.#room(guild.id);
    if (room.tracks.length >= MAX_QUEUE) return { message: `队列太长了，最多 ${MAX_QUEUE} 首嘛` };
    const track = {
      query: String(query ?? '').trim(),
      title: null,
      requester: senderId ? `<@${senderId}>` : null,
      channelId,
    };
    if (!track.query) return { message: '要放什么嘛？给我一个链接或者附件' };
    await this.#connection({ guild, voiceChannelId, voiceStates });
    room.tracks.push(track);
    void this.#startNext(guild.id).catch((error) => this.#log('warn', 'music.play.failed', error));
    return {
      message: room.playing
        ? `排上了，前面还有 ${room.tracks.length} 首`
        : `进 <#${voiceChannelId}> 了，开始放：${track.title ?? track.query}`,
    };
  }

  async next({ channelId }) {
    if (!this.available) return { message: '音乐功能没配 token，先跳过嘛' };
    const { guild } = await this.#guild(channelId);
    const room = this.#room(guild.id);
    if (!room.playing && room.tracks.length === 0) return { message: '现在没在放东西嘛' };
    room.player?.stop();
    return { message: '下一首' };
  }

  async pause({ channelId }) {
    if (!this.available) return { message: '音乐功能没配 token，先跳过嘛' };
    const { guild } = await this.#guild(channelId);
    const room = this.#room(guild.id);
    if (!room.playing) return { message: '现在没在放东西嘛' };
    room.player?.pause();
    return { message: '暂停了嘛' };
  }

  async resume({ channelId }) {
    if (!this.available) return { message: '音乐功能没配 token，先跳过嘛' };
    const { guild } = await this.#guild(channelId);
    const room = this.#room(guild.id);
    if (!room.playing) return { message: '现在没在放东西嘛' };
    room.player?.unpause();
    return { message: '继续放' };
  }

  async queue({ channelId }) {
    if (!this.available) return { message: '音乐功能没配 token，先跳过嘛' };
    const { guild } = await this.#guild(channelId);
    const room = this.#room(guild.id);
    if (!room.playing && room.tracks.length === 0) return { message: '队列是空的嘛' };
    const lines = [];
    if (room.playing) lines.push(`正在放：${room.playing.title ?? room.playing.query}`);
    room.tracks.slice(0, 10).forEach((track, index) => {
      lines.push(`${index + 1}. ${track.title ?? track.query}`);
    });
    if (room.tracks.length > 10) lines.push(`……还有 ${room.tracks.length - 10} 首`);
    return { message: lines.join('\n') };
  }

  async leave({ channelId }) {
    if (!this.available) return { message: '音乐功能没配 token，先跳过嘛' };
    const { guild } = await this.#guild(channelId);
    const room = this.#guilds.get(guild.id);
    if (!room?.connection) return { message: '我还没进语音频道嘛' };
    room.tracks.length = 0;
    room.playing = null;
    try { room.player?.stop(); } catch { /* already idle */ }
    try { room.connection.destroy(); } catch { /* already gone */ }
    this.#guilds.delete(guild.id);
    return { message: '走了嘛，下次再叫我' };
  }

  async destroy() {
    for (const room of this.#guilds.values()) {
      try { room.player?.stop(); } catch { /* ignore */ }
      try { room.connection?.destroy(); } catch { /* ignore */ }
    }
    this.#guilds.clear();
    try { this.#client?.destroy(); } catch { /* ignore */ }
    this.#client = null;
    this.#login = null;
    if (this.#downloadDir) {
      await rm(this.#downloadDir, { recursive: true, force: true }).catch(() => {});
      this.#downloadDir = null;
    }
  }
}

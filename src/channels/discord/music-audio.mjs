import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runMusicProcess, abortError } from './music-process.mjs';
import { DEFAULT_MUSIC_SELECTION_METHOD, MUSIC_SELECTION_METHODS, selectTfidfCandidate, resolutionMatches } from '../shared/music-selection.mjs';

const pluginRoot = dirname(createRequire(import.meta.url).resolve('dsh-discord/package.json'));
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm', '.mp4']);
const MAX_REMOTE_AUDIO_BYTES = 64 * 1024 * 1024;
const MUSIC_RESOLUTION_TTL_MS = 10 * 60_000;
const MUSIC_MAX_RESOLUTIONS = 128;
const NATIVE_WEB_VIDEO_CHECKS = 5;
/** How many YouTube search results one keyword request may choose from. */
const MUSIC_CANDIDATE_LIMIT = 10;
/**
 * YouTube resolves an ambiguous Latin query differently per UI language:
 * "kaf 第一首歌" returns coffee songs under yt-dlp's default English UI and the
 * artist 花譜 under zh-TW. Match the bot's audience instead of the extractor
 * default. Override with DSK_DISCORD_YTDLP_LANG when the audience differs.
 */
const YOUTUBE_SEARCH_LANG = process.env.DSK_DISCORD_YTDLP_LANG ?? 'zh-TW';

/**
 * yt-dlp failures that mean "this video cannot be played" rather than "the
 * pipeline broke": age gates, region blocks, removals and private videos. Only
 * these justify trying the next eligible candidate.
 */
function isUnplayableVideo(error) {
  const text = String(error?.message ?? error ?? '');
  return /confirm your age|滿限制年齡|age[- ]restricted|video unavailable|影片已下架|private video|私人影片|not available in your country|區域限制/i.test(text);
}
const hash = value => createHash('sha256').update(value).digest('hex');
export const MUSIC_LOUDNESS = Object.freeze({ integrated: -20, truePeak: -3, lra: 11, sampleRate: 48000 });
export const MUSIC_CACHE_VERSION = 4;

/**
 * YouTube challenges its default clients with "Sign in to confirm you're not a
 * bot", and a challenged client still hands out a media URL that the CDN then
 * refuses with 403. `android` is currently served without that challenge, so it
 * is the fallback for both extraction and a stream the CDN already refused.
 */
export const YOUTUBE_CLIENT_FALLBACK = 'android';
const YOUTUBE_CLIENTS = `default,${YOUTUBE_CLIENT_FALLBACK}`;

/**
 * Bilibili's risk control answers a scripted request for /video/ with HTTP 412,
 * while the homepage still hands out the `buvid3` cookie its public API wants.
 * The extractor plugin rebuilds the page state from that API, so the cookie is
 * what makes a flagged IP playable again.
 */
const BILIBILI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const BILIBILI_COOKIE_TTL_MS = 6 * 3600_000;

export function loudnessAnalysisFilter() {
  return `loudnorm=I=${MUSIC_LOUDNESS.integrated}:TP=${MUSIC_LOUDNESS.truePeak}:LRA=${MUSIC_LOUDNESS.lra}:print_format=json`;
}

function firstFile(candidates, fallback) {
  return candidates.find(value => value && existsSync(value)) ?? fallback;
}

/** Only references executables; never imports or modifies the other project's code. */
export function musicTools({ audioUsbRoot = process.env.DSK_DISCORD_AUDIOUSB_ROOT ?? 'C:/Users/TINGOD/Desktop/CodeHome/AudioUsbStudio' } = {}) {
  const bins = [join(audioUsbRoot, 'release', 'bin'), join(audioUsbRoot, 'tools', 'bin')];
  return {
    ytDlp: firstFile([process.env.DSK_DISCORD_YTDLP, ...bins.map(dir => join(dir, 'yt-dlp.exe'))], 'yt-dlp'),
    ffmpeg: firstFile([process.env.DSK_DISCORD_FFMPEG, ...bins.map(dir => join(dir, 'ffmpeg.exe'))], 'ffmpeg'),
    ffprobe: firstFile([process.env.DSK_DISCORD_FFPROBE, ...bins.map(dir => join(dir, 'ffprobe.exe'))], 'ffprobe'),
    node: firstFile([process.env.DSK_DISCORD_NODE, ...bins.map(dir => join(dir, 'node.exe'))], process.execPath),
    plugins: join(audioUsbRoot, 'tools', 'ytdlp-plugins'),
  };
}

export function youtubeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  let id;
  if (url.hostname === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id = /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : /^\/(?:shorts|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  return /^[\w-]{11}$/.test(id ?? '') ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** Direct media only; discard tracking while keeping the explicitly selected part. */
export function bilibiliUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (url.hostname === 'b23.tv') {
    const id = /^\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
    return id ? `https://b23.tv/${id}` : null;
  }
  if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
  const video = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  if (video) {
    const part = url.searchParams.get('p') ?? '1';
    if (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part))) return null;
    // An explicit p=1 prevents a multi-part video from expanding to a playlist.
    return `https://www.bilibili.com/video/${video}?p=${part}`;
  }
  const audio = /^\/audio\/(au[1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  return audio ? `https://www.bilibili.com/audio/${audio}` : null;
}

// A link ends at whitespace, at a quote/bracket, or at CJK text glued to it
// ("https://b23.tv/abc好聽"): no supported media URL contains raw CJK.
const LINK_IN_TEXT = /https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/iu;

/**
 * Pull the first link out of pasted share text ("【title】https://…"). Discord
 * users paste the whole share line, and the surrounding text must not turn the
 * link into a YouTube search query.
 */
export function embeddedUrl(text) {
  const match = LINK_IN_TEXT.exec(text);
  return match ? match[0].replace(/[)\]}>，。、；：！？"'」』】）]+$/u, '') : null;
}

/**
 * Split pasted share text into the link it carries and the title around it, so
 * the queue, the "preparing" notice and the failure message show the song name
 * instead of the whole pasted line.
 */
export function splitShareText(text) {
  const raw = String(text ?? '').trim();
  const link = /^https?:/i.test(raw) ? raw : embeddedUrl(raw);
  if (!link) return { link: null, title: raw };
  const title = raw
    .replace(link, ' ')
    .replace(/[【】\[\]（）()<>《》「」『』]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s|｜·・,，、;；:：。！？…\-–—~～]+|[\s|｜·・,，、;；:：。！？…\-–—~～]+$/gu, '');
  return { link, title };
}

function publicWebUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.startsWith('[') ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)) throw new Error('請提供公開的網頁或音訊連結');
  return url;
}

function candidatesFrom(info) {
  return (Array.isArray(info.entries) ? info.entries : [info]).filter(item => item && /^[\w-]{11}$/.test(item.id ?? '') && !item.is_live)
    .map(item => ({ id: item.id, title: String(item.title ?? '').slice(0, 300), artist: String(item.uploader ?? item.channel ?? '').slice(0, 120),
      kind: 'youtube', verifiedChannel: item.channel_is_verified === true,
      duration: Number(item.duration) || 0, url: `https://www.youtube.com/watch?v=${item.id}` }));
}

function prioritizeOfficialAudio(candidates, searchTerm, request) {
  // Keep the normal order when the listener asks for a specific video or recording.
  if (/\b(?:mv|music video|lyrics? video|live|cover|remix|karaoke|acoustic|instrumental|sped up|slowed)\b|現場|现场|翻唱|伴奏|歌詞版|歌词版|混音/iu.test(request)) {
    return candidates;
  }
  const normalize = value => value.normalize('NFKC').toLowerCase()
    .replace(/[「」『』"'【】()[\]\-–—]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const requested = normalize(searchTerm);
  const official = new Set(candidates.filter(candidate => {
    const artist = normalize(candidate.artist).replace(/ topic$/u, '');
    const name = normalize(candidate.title).replace(/ (?:official )?audio$/u, '');
    if (!candidate.verifiedChannel || !artist || !name) return false;
    const title = name.startsWith(artist + ' ') ? name.slice(artist.length + 1) : name;
    return requested === artist + ' ' + title;
  }));
  return candidates.toSorted((a, b) => Number(official.has(b)) - Number(official.has(a)));
}

export function loudnessStats(stderr) {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks?.length) throw new Error('無法讀取音量分析結果');
  const data = JSON.parse(blocks.at(-1));
  if (data.input_i === '-inf') return null; // Digital silence remains silence.
  for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    if (!Number.isFinite(Number(data[key]))) throw new Error('音量分析回傳無效數據');
  }
  return data;
}

export function normalizationFilter(data) {
  if (!data) return 'anull';
  const integrated = Number(data.input_i), peak = Number(data.input_tp);
  if (!Number.isFinite(integrated) || !Number.isFinite(peak)) throw new Error('音量分析回傳無效數據');
  // Apply one constant gain to the whole song. Capping by measured true peak
  // avoids loudnorm's dynamic fallback and preserves the original dynamics.
  const gainDb = Math.min(MUSIC_LOUDNESS.integrated - integrated, MUSIC_LOUDNESS.truePeak - peak);
  return `volume=${gainDb.toFixed(6)}dB`;
}

export function completeDuration(expected, actual) {
  return Number.isFinite(actual) && actual > 0 && (!(expected > 0) || actual >= expected - Math.max(2, expected * 0.03));
}

/**
 * Only the headers a media CDN actually checks. ffmpeg wants them as one
 * CRLF-separated string, and a value carrying a line break would let the
 * extractor's metadata inject extra headers.
 */
export function streamHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const lines = ['Referer', 'User-Agent', 'Origin']
    .map(name => [name, headers[name] ?? headers[name.toLowerCase()]])
    .filter(([, value]) => typeof value === 'string' && value && !/[\r\n]/.test(value))
    .map(([name, value]) => `${name}: ${value}\r\n`);
  return lines.length ? lines.join('') : null;
}

function streamPlaybackUrl(info) {
  return info.url ?? info.requested_downloads?.[0]?.url
    ?? info.formats?.find(format => format.acodec && format.acodec !== 'none')?.url ?? null;
}

export class MusicAudioPipeline {
  #root; #tools; #run; #select; #searchNativeMusic; #resolveQuery; #log; #jobs = new Map(); #audioJobs = new Map(); #resolved = new Map(); #pins = new Map(); #cookieFile = null; #youtubeCookies = null;
  #candidateJobs = new Map(); #candidateLists = new Map();
  #busy = 0; #waiting = []; #limit; #maxSeconds; #maxBytes; #maxEntries;
  // `maxDurationSec` is the cache/normalize threshold, not a hard cap: a longer
  // track is streamed from the source instead of being downloaded and cached.
  constructor({ cacheDir = join(pluginRoot, '.dsh-im', 'music'), tools = musicTools(), run = runMusicProcess,
    selectCandidate = null, searchNativeMusic = null, resolveQuery = null, logger = null, concurrency = 2, maxDurationSec = 3600, maxCacheBytes = 512 * 1024 * 1024, maxCacheEntries = 64 } = {}) {
    this.#root = resolve(cacheDir); this.#tools = tools; this.#run = run; this.#select = selectCandidate; this.#log = logger;
    this.#searchNativeMusic = searchNativeMusic;
    this.#resolveQuery = resolveQuery;
    // Age-gated YouTube videos need a signed-in cookie jar. Point this at a
    // Netscape cookies.txt exported from a verified account to play them.
    const youtubeCookies = process.env.DSK_DISCORD_YTDLP_COOKIES;
    this.#youtubeCookies = youtubeCookies && existsSync(youtubeCookies) ? youtubeCookies : null;
    this.#limit = concurrency; this.#maxSeconds = maxDurationSec; this.#maxBytes = maxCacheBytes; this.#maxEntries = maxCacheEntries;
  }
  get cacheDir() { return this.#root; }
  /** Tracks longer than this are streamed instead of normalized and cached. */
  get maxDurationSec() { return this.#maxSeconds; }

  async #shared(map, key, signal, operation) {
    if (signal?.aborted) throw abortError();
    let job = map.get(key);
    if (!job) {
      const controller = new AbortController();
      job = { controller, users: 0 };
      job.promise = Promise.resolve().then(() => operation(controller.signal)).finally(() => { if (map.get(key) === job) map.delete(key); });
      // A cancelled final waiter is allowed to leave the job settling in the background.
      job.promise.catch(() => {});
      map.set(key, job);
    }
    job.users++;
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const done = (error, result) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', cancel);
        if (--job.users === 0) { if (map.get(key) === job) map.delete(key); job.controller.abort(); }
        error ? reject(error) : resolvePromise(result);
      };
      const cancel = () => done(abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      job.promise.then(value => done(null, value), error => done(error));
      if (signal?.aborted) cancel();
    });
  }

  async #slot(signal) {
    if (signal.aborted) throw abortError();
    if (this.#busy < this.#limit) { this.#busy++; return; }
    await new Promise((resolveSlot, reject) => {
      const waiter = { resolve: () => { signal.removeEventListener('abort', cancel); resolveSlot(); } };
      const cancel = () => { this.#waiting = this.#waiting.filter(item => item !== waiter); reject(abortError()); };
      signal.addEventListener('abort', cancel, { once: true });
      this.#waiting.push(waiter);
    });
  }
  #releaseSlot() {
    const next = this.#waiting.shift();
    if (next) next.resolve(); else this.#busy--;
  }

  #ytArgs({ client = YOUTUBE_CLIENTS, cookies = this.#cookieFile } = {}) {
    return ['--ignore-config', '--no-plugin-dirs', ...(existsSync(this.#tools.plugins ?? '') ? ['--plugin-dirs', this.#tools.plugins] : []),
      '--no-js-runtimes', '--js-runtimes', `node:${this.#tools.node}`, '--cache-dir', join(this.#root, 'extractor-cache'),
      '--extractor-args', `youtube:player_client=${client};lang=${YOUTUBE_SEARCH_LANG}`,
      ...(cookies ? ['--cookies', cookies] : []),
      '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '1', '--no-warnings'];
  }
  /**
   * A flagged IP gets HTTP 412 on Bilibili's /video/ pages, but the public API
   * still answers once the request carries the homepage's `buvid3` cookie. Keep
   * one cookie file for the whole pipeline and let yt-dlp send it.
   */
  async #bilibiliCookies(signal) {
    // The API fallback lives in the extractor plugin; without it the cookie buys
    // nothing, so a host that has no plugin directory keeps the plain request.
    if (!existsSync(this.#tools.plugins ?? '')) return null;
    if (this.#cookieFile) return this.#cookieFile;
    const file = join(this.#root, 'bilibili-cookies.txt');
    const fresh = await stat(file).then(info => Date.now() - info.mtimeMs < BILIBILI_COOKIE_TTL_MS).catch(() => false);
    if (fresh) return this.#cookieFile = file;
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch('https://www.bilibili.com/', {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'User-Agent': BILIBILI_USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    try { await response.body?.cancel(); } catch {}
    if (!response.ok) throw new Error('無法連線 Bilibili，請稍後重試');
    const pairs = (response.headers.getSetCookie?.() ?? [])
      .map(line => line.split(';')[0].trim())
      .filter(line => /^[^=]+=[^=]/.test(line));
    if (!pairs.length) throw new Error('無法取得 Bilibili 驗證 Cookie，請稍後重試');
    const expires = Math.floor(Date.now() / 1000) + BILIBILI_COOKIE_TTL_MS / 1000;
    const lines = ['# Netscape HTTP Cookie File', ...pairs.map(pair => {
      const at = pair.indexOf('=');
      return `.bilibili.com\tTRUE\t/\tFALSE\t${expires}\t${pair.slice(0, at)}\t${pair.slice(at + 1)}`;
    })];
    await mkdir(this.#root, { recursive: true });
    const pending = `${file}.${randomUUID()}.tmp`;
    await writeFile(pending, lines.join('\n') + '\n');
    await rename(pending, file);
    return this.#cookieFile = file;
  }
  #env(dir) { return { TEMP: dir, TMP: dir, TMPDIR: dir, PYTHONDONTWRITEBYTECODE: '1' }; }
  async #metadata(target, dir, signal) {
    const { stdout } = await this.#run(this.#tools.ytDlp, [...this.#ytArgs({ cookies: this.#youtubeCookies }), '--flat-playlist', '--skip-download', '--no-playlist', '--dump-single-json', '--', target],
      { cwd: dir, env: this.#env(dir), signal, timeoutMs: 45_000 });
    return JSON.parse(stdout);
  }

  async #youtubeCandidates(search, guildId, signal) {
    const key = JSON.stringify([guildId, search]);
    const cached = this.#candidateLists.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    return this.#shared(this.#candidateJobs, key, signal, async searchSignal => {
      // The search directory belongs to the shared fetch, even if its first
      // caller cancels while another selector is still waiting on the list.
      const dir = await mkdtemp(join(this.#root, 'work', 'candidates-'));
      try {
        const found = candidatesFrom(await this.#metadata(`ytsearch${MUSIC_CANDIDATE_LIMIT}:${search}`, dir, searchSignal));
        const shorter = found.filter(item => item.duration <= this.#maxSeconds);
        // Long mixes are eligible when there is no normal-length result.
        const candidates = shorter.length ? shorter : found;
        if (!candidates.length) throw new Error('找不到可播放的 YouTube 歌曲');
        searchSignal.throwIfAborted();
        const snapshot = { key, candidates, expires: Date.now() + MUSIC_RESOLUTION_TTL_MS };
        this.#candidateLists.set(key, snapshot);
        if (this.#candidateLists.size > MUSIC_MAX_RESOLUTIONS) this.#candidateLists.delete(this.#candidateLists.keys().next().value);
        return snapshot;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  async #selectYoutubeCandidate(method, { query, candidates, guildId, signal }) {
    if (method === 'youtube') return { candidate: candidates[0], selection: 'youtube' };
    if (method === 'tfidf') return { candidate: selectTfidfCandidate(query, candidates), selection: 'tfidf' };
    return this.#select
      ? this.#select({ query, candidates, guildId, signal })
      : { candidate: candidates[0], selection: 'search-fallback' };
  }

  async #resolveNativeMusic(query, dir, signal, guildId) {
    if (typeof this.#searchNativeMusic !== 'function') throw new Error('DSH 原生網搜未啟用');
    const sources = await this.#searchNativeMusic({ query, signal });
    signal.throwIfAborted();
    const urls = new Set();
    for (const source of Array.isArray(sources) ? sources : []) {
      const url = typeof source === 'string' ? youtubeUrl(source) : null;
      if (url) urls.add(url);
      if (urls.size === NATIVE_WEB_VIDEO_CHECKS) break;
    }
    const verifySignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    // Every verified video is playable, so the model can choose on relevance
    // alone instead of the search backend's source order deciding for it.
    const verified = [];
    for (const url of urls) {
      const id = new URL(url).searchParams.get('v');
      let info;
      try { info = await this.#streamInfo(url, dir, verifySignal); } catch {
        signal.throwIfAborted();
        if (verifySignal.aborted) break;
        continue;
      }
      if (verifySignal.aborted) break;
      if (info?.id !== id || info.is_live || info.live_status === 'is_upcoming') continue;
      const duration = Number(info.duration);
      const streamUrl = streamPlaybackUrl(info);
      if (!Number.isFinite(duration) || duration <= 0 || !streamUrl) continue;
      verified.push({ id, url, title: String(info.title ?? query).slice(0, 300),
        artist: String(info.uploader ?? info.channel ?? '').slice(0, 120),
        duration, streamUrl, headers: streamHeaders(info.http_headers) });
    }
    signal.throwIfAborted();
    if (!verified.length) {
      if (verifySignal.aborted) throw new Error('DSH 原生網搜的影片驗證逾時');
      throw new Error('DSH 原生網搜沒有找到可播放的 YouTube 單曲');
    }
    let chosen = verified[0];
    if (this.#select && verified.length > 1) {
      try {
        const selected = await this.#select({
          query,
          candidates: verified.map(({ id, title, artist, duration }) => ({ id, title, artist, duration })),
          guildId, signal,
        });
        const match = verified.find(item => item.id === selected?.candidate?.id);
        if (match) chosen = match;
      } catch (error) {
        // A selector failure must not lose a video that already passed playback
        // verification; the first verified one is still a valid answer.
        if (signal?.aborted) throw error;
      }
    }
    return { ...chosen, kind: 'youtube', selection: 'dsh-web' };
  }

  async #resolve(query, { dir, signal, guildId, selectionMethod, allowLocalFile = false }) {
    if (existsSync(query)) {
      // `/play <path>` reads a file from the bot host. The music lane is open to
      // every member by design, so without this check anyone could make the bot
      // stream (and expose) any audio file the host can read.
      if (!allowLocalFile) throw new Error('本機檔案只有主人可以播放');
      if (!AUDIO_EXTENSIONS.has(extname(query).toLowerCase())) throw new Error('這個檔案不是支援的音訊格式');
      const file = await stat(query);
      if (!file.isFile() || file.size > 256 * 1024 * 1024) throw new Error('音訊檔案過大或無法讀取');
      return { input: resolve(query), id: hash(`${resolve(query)}:${file.size}:${file.mtimeMs}`), title: query.split(/[\\/]/).at(-1), kind: 'file', duration: 0, selection: 'file' };
    }
    // A pasted share line ("【title】https://…") is common: resolve the link
    // inside it instead of searching YouTube for the whole sentence, and keep
    // the surrounding text as the display title.
    const share = splitShareText(query);
    const link = share.link;
    const direct = youtubeUrl(link ?? query);
    if (direct) return { id: new URL(direct).searchParams.get('v'), url: direct, title: share.title || query, kind: 'youtube', duration: 0, selection: 'direct' };
    let search = query;
    if (link) {
      const url = publicWebUrl(link);
      if (/(^|\.)(bilibili\.com|b23\.tv)$/.test(url.hostname)) {
        await this.#bilibiliCookies(signal);
        let direct = bilibiliUrl(url.href);
        if (!direct) throw new Error('請提供 Bilibili BV／av 影片、au 音訊或 b23 分享連結');
        if (new URL(direct).hostname === 'b23.tv') {
          let info;
          try { info = await this.#metadata(direct, dir, signal); }
          catch (error) { if (signal.aborted) throw error; throw new Error('無法解析 Bilibili 分享連結，請改貼原影片的 BV／av 連結'); }
          direct = bilibiliUrl(info.webpage_url);
          if (!direct || new URL(direct).hostname === 'b23.tv') throw new Error('Bilibili 分享連結未指向支援的影片或音訊');
        }
        return { id: hash(direct), url: direct, title: share.title || direct, kind: 'bilibili', duration: 0, selection: 'direct' };
      }
      if (AUDIO_EXTENSIONS.has(extname(url.pathname).toLowerCase())) return { input: url.href, id: hash(url.href), title: share.title || url.pathname.split('/').at(-1), kind: 'audio-url', duration: 0, selection: 'direct' };
      let title = '';
      if (/(^|\.)(spotify\.com|soundcloud\.com|vimeo\.com)$/.test(url.hostname)) {
        try { const info = await this.#metadata(url.href, dir, signal); title = info.track ?? info.title ?? ''; } catch (error) { if (signal.aborted) throw error; }
      }
      if (!title) {
        const response = await fetch(url.href, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('無法讀取網頁，請直接提供歌曲關鍵詞或 YouTube 連結');
        const reader = response.body.getReader();
        const decoder = new TextDecoder(); let html = '', bytes = 0;
        try {
          while (bytes < 256 * 1024) {
            const { value, done } = await reader.read(); if (done) break;
            bytes += value.byteLength; html += decoder.decode(value, { stream: true });
            if (/<\/head>/i.test(html)) break;
          }
        } finally { await reader.cancel().catch(() => {}); }
        title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      }
      if (!title) throw new Error('網頁沒有可辨識的歌曲名稱，請改用關鍵詞');
      search = title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').slice(0, 300);
    }
    if (selectionMethod === 'dsh-web') return this.#resolveNativeMusic(search, dir, signal, guildId);
    // `dsh-resolve` rewrites the request into searchable keywords before
    // retrieval, then selects with the same model. Every request is rewritten:
    // the model returns the query unchanged when it is already precise, and a
    // rewrite the search results do not corroborate is discarded, so a wrong
    // guess costs the original query instead of playing the wrong song.
    let searchTerm = search;
    let snapshot = null;
    if (selectionMethod === 'dsh-resolve' && typeof this.#resolveQuery === 'function') {
      const resolved = await this.#resolveQuery({ query: search, guildId, signal });
      signal.throwIfAborted();
      if (resolved && resolved !== search) {
        const probe = await this.#youtubeCandidates(resolved, guildId, signal);
        if (resolutionMatches(resolved, probe.candidates)) { searchTerm = resolved; snapshot = probe; }
      }
    }
    snapshot ??= await this.#youtubeCandidates(searchTerm, guildId, signal);
    const { candidates } = snapshot;
    const selector = selectionMethod === 'dsh-resolve' ? 'dsh' : selectionMethod;
    const selected = await this.#selectYoutubeCandidate(selector, { query, candidates, guildId, signal });
    const candidate = candidates.find(item => item.id === selected?.candidate?.id);
    if (!candidate) throw new Error('選歌結果不在已驗證的 YouTube 候選中');
    return { ...candidate, kind: 'youtube',
      selection: selectionMethod === 'dsh-resolve' ? 'dsh-resolve' : selected.selection,
      ...(searchTerm !== search ? { resolvedQuery: searchTerm } : {}), snapshot };
  }

  async #probe(input, dir, signal) {
    const result = await this.#run(this.#tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', input], { cwd: dir, signal, timeoutMs: 20_000 });
    const info = JSON.parse(result.stdout);
    if (!info.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('來源沒有可解碼的音軌');
    return Number(info.format?.duration ?? info.streams.find(stream => stream.codec_type === 'audio')?.duration) || 0;
  }

  /**
   * One extractor call for a direct link: duration decides the path, and the
   * media URL plus its headers are what the streaming path needs. `-j` keeps the
   * selected format's URL, so no second call is required.
   */
  async #streamInfo(target, dir, signal, { client, cookies = this.#youtubeCookies } = {}) {
    const { stdout } = await this.#run(this.#tools.ytDlp, [...this.#ytArgs({ client, cookies }), '--no-playlist', '--skip-download',
      '-f', 'bestaudio/best', '--dump-single-json', '--', target],
    { cwd: dir, env: this.#env(dir), signal, timeoutMs: 45_000 });
    return JSON.parse(stdout);
  }

  /**
   * Duration is resolved before any download, because it is what chooses between
   * the normalized cache and the streaming path. Search candidates already carry
   * it; a direct link needs one extractor call; a local file or audio URL is
   * probed. A cached render never reaches this, so replays pay nothing extra.
   */
  async #durationOf(source, { dir, signal }) {
    if (source.duration > 0 && source.duration <= this.#maxSeconds) return source.duration;
    if (source.kind === 'file' || source.kind === 'audio-url') {
      if (!(source.duration > 0)) source.duration = await this.#probe(source.input, dir, signal);
      return source.duration;
    }
    if (source.kind === 'bilibili') await this.#bilibiliCookies(signal);
    const info = await this.#streamInfo(source.url, dir, signal, { cookies: source.kind === 'bilibili' ? this.#cookieFile : this.#youtubeCookies });
    if (info.is_live) throw new Error('目前不支援直播音訊');
    source.duration = Number(info.duration) || 0;
    source.title = String(info.title ?? source.title).slice(0, 300);
    source.streamUrl = streamPlaybackUrl(info);
    source.headers = streamHeaders(info.http_headers);
    return source.duration;
  }

  /**
   * A track past the cache limit is played straight from the source: no download,
   * no loudness pass and no cache entry, so its length stops being a hard cap.
   * The trade-off is reported to the channel by the manager.
   */
  #streamSource(source, duration) {
    // A page URL is not playable: the extractor's media URL is the only input.
    const input = source.kind === 'youtube' || source.kind === 'bilibili'
      ? source.streamUrl
      : source.input ?? source.url;
    if (!input) throw new Error('無法取得串流位址');
    return { stream: true, kind: source.kind, input, headers: source.headers ?? null, duration, limitSec: this.#maxSeconds,
      title: source.title, url: source.url, selection: source.selection, cacheHit: false };
  }

  /**
   * A streamed media URL is signed and expires, so a long track that waited in
   * the queue can outlive it. Re-running the extractor is cheap next to failing
   * the track, and it also recovers from a CDN that refused the first URL.
   * `client` forces a specific YouTube client, which is what a 403 needs: the
   * challenged client would only hand out another URL the CDN refuses.
   */
  async refreshStream(source, { signal, client } = {}) {
    if (source.kind === 'bilibili') await this.#bilibiliCookies(signal);
    const info = await this.#streamInfo(source.url, this.#root, signal, { client, cookies: source.kind === 'bilibili' ? this.#cookieFile : this.#youtubeCookies });
    if (info.is_live) throw new Error('目前不支援直播音訊');
    const url = streamPlaybackUrl(info);
    if (!url) throw new Error('無法取得串流位址');
    source.streamUrl = url;
    source.input = url;
    source.headers = streamHeaders(info.http_headers);
    source.duration = Number(info.duration) || source.duration;
    return source;
  }

  async #cached(key) {
    const dir = join(this.#root, 'audio', key);
    try {
      const item = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      const input = join(dir, 'audio.flac');
      const file = await stat(input);
      if (item.version !== MUSIC_CACHE_VERSION || file.size < 1024 || Date.now() - file.mtimeMs > 24 * 3600_000 || !completeDuration(item.expectedDuration, item.duration)) return null;
      return { ...item, input, cacheHit: true };
    } catch { return null; }
  }

  async #render(source, { signal, dir, key }) {
    let input = source.input;
    let expected = source.duration;
    let title = source.title;
    if (source.kind === 'youtube' || source.kind === 'bilibili') {
      const infoPath = join(dir, 'download.json');
      if (source.kind === 'bilibili') await this.#bilibiliCookies(signal);
      // Bilibili's media CDN answers a plain GET with HTTP 567 (anti-bot) but
      // serves an open-ended range request, so ask for the whole file that way.
      const range = source.kind === 'bilibili' ? ['--add-header', 'Range: bytes=0-'] : [];
      try { await this.#run(this.#tools.ytDlp, [...this.#ytArgs({ cookies: source.kind === 'bilibili' ? this.#cookieFile : this.#youtubeCookies }), ...range, '--no-playlist', '--no-simulate', '--no-progress', '--max-filesize', '256M', '--match-filter', '!is_live',
        '-f', 'bestaudio/best', '-o', join(dir.replaceAll('%', '%%'), 'raw.%(ext)s'), '--print-to-file', 'after_move:%()j', infoPath, '--', source.url],
      { cwd: dir, env: this.#env(dir), signal, timeoutMs: 180_000 }); }
      catch (error) {
        if (signal.aborted || source.kind !== 'bilibili') throw error;
        throw new Error('無法下載 Bilibili 音訊，影片可能受限、已下架或擷取失敗；請稍後重試');
      }
      const info = JSON.parse(await readFile(infoPath, 'utf8'));
      if (info.is_live) throw new Error('目前不支援直播音訊');
      expected = Number(info.duration) || expected;
      title = String(info.title ?? title).slice(0, 300);
      input = (await readdir(dir)).filter(name => name.startsWith('raw.') && AUDIO_EXTENSIONS.has(extname(name))).map(name => join(dir, name))[0];
      if (!input) throw new Error('下載未產生音訊檔案');
    }
    if (source.kind === 'audio-url') {
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      const remote = await fetch(source.input, { signal: downloadSignal, redirect: 'error' });
      if (!remote.ok || !remote.body) {
        await remote.body?.cancel();
        throw new Error('音訊下載失敗');
      }
      input = join(dir, 'remote-audio' + extname(new URL(source.input).pathname));
      await pipeline(Readable.fromWeb(remote.body), async function* limitSize(chunks) {
        let bytes = 0;
        for await (const chunk of chunks) {
          bytes += chunk.byteLength;
          if (bytes > MAX_REMOTE_AUDIO_BYTES) throw new Error('遠端音訊超過 64 MB 上限');
          yield chunk;
        }
      }, createWriteStream(input), { signal: downloadSignal });
    }
    const duration = await this.#probe(input, dir, signal);
    if (!completeDuration(expected, duration)) throw new Error(`音訊不完整：預期 ${expected.toFixed(1)} 秒，實際 ${duration.toFixed(1)} 秒`);
    if (!(duration > 0)) throw new Error('無法讀取音訊長度');
    // The pre-download duration decides the path; a mismatch means the source
    // served something different from what it reported.
    if (duration > this.#maxSeconds) throw new Error(`音訊實際長度 ${Math.round(duration / 60)} 分鐘，超過 ${this.#maxSeconds / 60} 分鐘上限`);
    const { stderr } = await this.#run(this.#tools.ffmpeg, ['-nostdin', '-hide_banner', '-threads', '1', '-filter_threads', '1', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', loudnessAnalysisFilter(), '-f', 'null', '-'], { cwd: dir, signal, timeoutMs: 180_000 });
    const loudness = loudnessStats(stderr);
    const rendered = join(dir, 'normalized.flac');
    await this.#run(this.#tools.ffmpeg, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', normalizationFilter(loudness), '-ar', '48000', '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's16', '-threads', '1', rendered], { cwd: dir, signal, timeoutMs: 180_000 });
    const actual = await this.#probe(rendered, dir, signal);
    if (!completeDuration(duration, actual)) throw new Error('音量處理後的音訊不完整');
    if (signal.aborted) throw abortError();
    const out = join(this.#root, 'audio', key);
    await mkdir(out, { recursive: true });
    await rename(rendered, join(out, 'audio.flac'));
    const metadata = { version: MUSIC_CACHE_VERSION, id: source.id, title, url: source.url ?? '', duration: actual, expectedDuration: expected || duration,
      selection: source.selection, loudness: MUSIC_LOUDNESS, cacheHit: false };
    const pending = join(out, `${randomUUID()}.json`);
    await writeFile(pending, JSON.stringify(metadata)); await rename(pending, join(out, 'meta.json'));
    await this.#prune(key).catch(() => {});
    return { ...metadata, input: join(out, 'audio.flac') };
  }

  async #prune(except) {
    const base = join(this.#root, 'audio');
    const names = (await readdir(base)).filter(name => /^[a-f0-9]{64}$/.test(name));
    const entries = await Promise.all(names.map(async name => {
      const file = await stat(join(base, name, 'audio.flac')).catch(() => stat(join(base, name, 'audio.ogg')).catch(() => null));
      return { name, bytes: file?.size ?? 0, at: file?.mtimeMs ?? 0 };
    }));
    let size = entries.reduce((sum, entry) => sum + entry.bytes, 0), count = entries.length;
    for (const entry of entries.sort((a, b) => a.at - b.at)) {
      if (size <= this.#maxBytes && count <= this.#maxEntries && Date.now() - entry.at < 24 * 3600_000) break;
      if (entry.name === except || this.#pins.has(join(base, entry.name, 'audio.flac')) || this.#pins.has(join(base, entry.name, 'audio.ogg'))) continue;
      await rm(join(base, entry.name), { recursive: true, force: true });
      size -= entry.bytes; count--;
    }
  }

  async prepare(query, { signal, guildId = 'local', selectionMethod = DEFAULT_MUSIC_SELECTION_METHOD, allowLocalFile = false } = {}) {
    query = String(query ?? '').trim();
    if (!query || query.length > 500) throw new Error('請提供 500 字以內的歌曲關鍵詞或連結');
    if (!Object.hasOwn(MUSIC_SELECTION_METHODS, selectionMethod)) throw new Error('無效的選歌方法');
    // The winning video depends on the method. Local file access also depends
    // on the caller, so both are part of the resolved job's identity.
    const queryKey = JSON.stringify([guildId, query, selectionMethod, allowLocalFile]);
    const item = await this.#shared(this.#jobs, queryKey, signal, async jobSignal => {
      await mkdir(join(this.#root, 'work'), { recursive: true });
      const dir = await mkdtemp(join(this.#root, 'work', 'song-'));
      try {
        let source = this.#resolved.get(queryKey);
        if (!source || source.expires <= Date.now() || source.kind === 'file'
          || (source.snapshot && this.#candidateLists.get(source.snapshot.key) !== source.snapshot)) {
          source = await this.#resolve(query, { dir, signal: jobSignal, guildId, selectionMethod, allowLocalFile });
          source.expires = source.snapshot?.expires ?? Date.now() + MUSIC_RESOLUTION_TTL_MS;
          this.#resolved.set(queryKey, source);
          if (this.#resolved.size > MUSIC_MAX_RESOLUTIONS) this.#resolved.delete(this.#resolved.keys().next().value);
        }
        // A selected video can still be unplayable: age-gated, region-blocked or
        // removed after the search snapshot. Try the other eligible candidates
        // before failing the track, so one bad pick does not lose the request.
        const otherCandidates = (source.snapshot?.candidates ?? []).filter(candidate => candidate.id !== source.id);
        const fallbacks = selectionMethod === 'dsh-resolve'
          ? prioritizeOfficialAudio(otherCandidates, source.resolvedQuery ?? query, query)
          : otherCandidates;
        const alternatives = [source, ...fallbacks];
        let lastError = null;
        for (const candidate of alternatives) {
          const key = hash(JSON.stringify([MUSIC_CACHE_VERSION, candidate.kind, candidate.id, MUSIC_LOUDNESS]));
          const cached = await this.#cached(key);
          if (cached) return { ...cached, selection: source.selection, ...(source.resolvedQuery ? { resolvedQuery: source.resolvedQuery } : {}) };
          try {
            const duration = await this.#durationOf(candidate, { dir, signal: jobSignal });
            if (duration > this.#maxSeconds) {
              return {
                ...this.#streamSource(candidate, duration),
                selection: source.selection,
                ...(source.resolvedQuery ? { resolvedQuery: source.resolvedQuery } : {}),
              };
            }
            const rendered = await this.#shared(this.#audioJobs, key, jobSignal, async renderSignal => {
              await this.#slot(renderSignal);
              // The render owns its directory independently of a cancelled resolver's waiter.
              let renderDir;
              try {
                renderDir = await mkdtemp(join(this.#root, 'work', 'render-'));
                const existing = await this.#cached(key);
                return existing ?? await this.#render(candidate, { signal: renderSignal, dir: renderDir, key });
              } finally { this.#releaseSlot(); if (renderDir) await rm(renderDir, { recursive: true, force: true }).catch(() => {}); }
            });
            return { ...rendered, selection: source.selection, ...(source.resolvedQuery ? { resolvedQuery: source.resolvedQuery } : {}) };
          } catch (error) {
            if (jobSignal.aborted) throw error;
            if (!isUnplayableVideo(error)) throw error;
            lastError = error;
          }
        }
        throw lastError ?? new Error('沒有可播放的候選');
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
    });
    if (signal?.aborted) throw abortError();
    // A stream owns no cache file, so there is nothing to pin or release.
    if (item.stream) return { ...item, release: () => {} };
    this.#pins.set(item.input, (this.#pins.get(item.input) ?? 0) + 1);
    let released = false;
    return { ...item, release: () => {
      if (released) return; released = true;
      const count = (this.#pins.get(item.input) ?? 1) - 1;
      if (count > 0) this.#pins.set(item.input, count); else this.#pins.delete(item.input);
    } };
  }

  async destroy() {
    const jobs = [...this.#jobs.values(), ...this.#candidateJobs.values(), ...this.#audioJobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.promise));
    this.#resolved.clear(); this.#candidateLists.clear(); this.#pins.clear();
  }
}

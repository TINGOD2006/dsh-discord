import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { runMusicProcess, abortError } from './music-process.mjs';

const pluginRoot = dirname(createRequire(import.meta.url).resolve('dsh-discord/package.json'));
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm', '.mp4']);
const hash = value => createHash('sha256').update(value).digest('hex');
export const MUSIC_LOUDNESS = Object.freeze({ integrated: -20, truePeak: -3, lra: 11, sampleRate: 48000 });
export const MUSIC_CACHE_VERSION = 2;

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
      duration: Number(item.duration) || 0, url: `https://www.youtube.com/watch?v=${item.id}` }));
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

export class MusicAudioPipeline {
  #root; #tools; #run; #select; #log; #jobs = new Map(); #audioJobs = new Map(); #resolved = new Map(); #pins = new Map();
  #busy = 0; #waiting = []; #limit; #maxSeconds; #maxBytes; #maxEntries;
  constructor({ cacheDir = join(pluginRoot, '.dsh-im', 'music'), tools = musicTools(), run = runMusicProcess,
    selectCandidate = null, logger = null, concurrency = 2, maxDurationSec = 1800, maxCacheBytes = 512 * 1024 * 1024, maxCacheEntries = 64 } = {}) {
    this.#root = resolve(cacheDir); this.#tools = tools; this.#run = run; this.#select = selectCandidate; this.#log = logger;
    this.#limit = concurrency; this.#maxSeconds = maxDurationSec; this.#maxBytes = maxCacheBytes; this.#maxEntries = maxCacheEntries;
  }
  get cacheDir() { return this.#root; }

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

  #ytArgs() {
    return ['--ignore-config', '--no-plugin-dirs', ...(existsSync(this.#tools.plugins ?? '') ? ['--plugin-dirs', this.#tools.plugins] : []),
      '--no-js-runtimes', '--js-runtimes', `node:${this.#tools.node}`, '--cache-dir', join(this.#root, 'extractor-cache'),
      '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '1', '--no-warnings'];
  }
  #env(dir) { return { TEMP: dir, TMP: dir, TMPDIR: dir, PYTHONDONTWRITEBYTECODE: '1' }; }
  async #metadata(target, dir, signal) {
    const { stdout } = await this.#run(this.#tools.ytDlp, [...this.#ytArgs(), '--flat-playlist', '--skip-download', '--no-playlist', '--dump-single-json', '--', target],
      { cwd: dir, env: this.#env(dir), signal, timeoutMs: 45_000 });
    return JSON.parse(stdout);
  }

  async #resolve(query, { dir, signal, guildId }) {
    if (existsSync(query)) {
      if (!AUDIO_EXTENSIONS.has(extname(query).toLowerCase())) throw new Error('這個檔案不是支援的音訊格式');
      const file = await stat(query);
      if (!file.isFile() || file.size > 256 * 1024 * 1024) throw new Error('音訊檔案過大或無法讀取');
      return { input: resolve(query), id: hash(`${resolve(query)}:${file.size}:${file.mtimeMs}`), title: query.split(/[\\/]/).at(-1), kind: 'file', duration: 0, selection: 'file' };
    }
    const direct = youtubeUrl(query);
    if (direct) return { id: new URL(direct).searchParams.get('v'), url: direct, title: query, kind: 'youtube', duration: 0, selection: 'direct' };
    let search = query;
    if (/^https?:/i.test(query)) {
      const url = publicWebUrl(query);
      if (AUDIO_EXTENSIONS.has(extname(url.pathname).toLowerCase())) return { input: url.href, id: hash(url.href), title: url.pathname.split('/').at(-1), kind: 'audio-url', duration: 0, selection: 'direct' };
      let title = '';
      if (/(^|\.)(bilibili\.com|b23\.tv|spotify\.com|soundcloud\.com|vimeo\.com)$/.test(url.hostname)) {
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
    const candidates = candidatesFrom(await this.#metadata(`ytsearch5:${search}`, dir, signal))
      .filter(item => item.duration <= this.#maxSeconds);
    if (!candidates.length) throw new Error('找不到可播放的 YouTube 歌曲');
    const selected = this.#select ? await this.#select({ query, candidates, guildId, signal }) : { candidate: candidates[0], selection: 'search-fallback' };
    const candidate = candidates.find(item => item.id === selected?.candidate?.id);
    if (!candidate) throw new Error('選歌結果不在已驗證的 YouTube 候選中');
    return { ...candidate, kind: 'youtube', selection: selected.selection };
  }

  async #probe(input, dir, signal) {
    const result = await this.#run(this.#tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', input], { cwd: dir, signal, timeoutMs: 20_000 });
    const info = JSON.parse(result.stdout);
    if (!info.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('來源沒有可解碼的音軌');
    return Number(info.format?.duration ?? info.streams.find(stream => stream.codec_type === 'audio')?.duration) || 0;
  }

  async #cached(key) {
    const dir = join(this.#root, 'audio', key);
    try {
      const item = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      const input = join(dir, 'audio.ogg');
      const file = await stat(input);
      if (item.version !== MUSIC_CACHE_VERSION || file.size < 1024 || Date.now() - file.mtimeMs > 24 * 3600_000 || !completeDuration(item.expectedDuration, item.duration)) return null;
      return { ...item, input, cacheHit: true };
    } catch { return null; }
  }

  async #render(source, { signal, dir, key }) {
    let input = source.input;
    let expected = source.duration;
    let title = source.title;
    if (source.kind === 'youtube') {
      const infoPath = join(dir, 'download.json');
      await this.#run(this.#tools.ytDlp, [...this.#ytArgs(), '--no-playlist', '--no-simulate', '--no-progress', '--max-filesize', '256M', '--match-filter', '!is_live',
        '-f', 'bestaudio/best', '-o', join(dir.replaceAll('%', '%%'), 'raw.%(ext)s'), '--print-to-file', 'after_move:%()j', infoPath, '--', source.url],
      { cwd: dir, env: this.#env(dir), signal, timeoutMs: 180_000 });
      const info = JSON.parse(await readFile(infoPath, 'utf8'));
      if (info.is_live) throw new Error('目前不支援直播音訊');
      expected = Number(info.duration) || expected;
      title = String(info.title ?? title).slice(0, 300);
      input = (await readdir(dir)).filter(name => name.startsWith('raw.') && AUDIO_EXTENSIONS.has(extname(name))).map(name => join(dir, name))[0];
      if (!input) throw new Error('下載未產生音訊檔案');
    }
    if (source.kind === 'audio-url') {
      const remote = await fetch(source.input, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'error' });
      if (!remote.ok || !remote.body) throw new Error('音訊下載失敗');
      const chunks = []; let bytes = 0; const reader = remote.body.getReader();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 64 * 1024 * 1024) throw new Error('遠端音訊超過 64 MB 上限'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      input = join(dir, 'remote-audio' + extname(new URL(source.input).pathname));
      await writeFile(input, Buffer.concat(chunks));
    }
    const duration = await this.#probe(input, dir, signal);
    if (!completeDuration(expected, duration)) throw new Error(`音訊不完整：預期 ${expected.toFixed(1)} 秒，實際 ${duration.toFixed(1)} 秒`);
    if (duration > this.#maxSeconds || !(duration > 0)) throw new Error(`歌曲長度須在 ${this.#maxSeconds / 60} 分鐘以內`);
    const { stderr } = await this.#run(this.#tools.ffmpeg, ['-nostdin', '-hide_banner', '-threads', '1', '-filter_threads', '1', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', loudnessAnalysisFilter(), '-f', 'null', '-'], { cwd: dir, signal, timeoutMs: 180_000 });
    const loudness = loudnessStats(stderr);
    const rendered = join(dir, 'normalized.ogg');
    await this.#run(this.#tools.ffmpeg, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', normalizationFilter(loudness), '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-threads', '1', '-b:a', '128k', rendered], { cwd: dir, signal, timeoutMs: 180_000 });
    const actual = await this.#probe(rendered, dir, signal);
    if (!completeDuration(duration, actual)) throw new Error('音量處理後的音訊不完整');
    if (signal.aborted) throw abortError();
    const out = join(this.#root, 'audio', key);
    await mkdir(out, { recursive: true });
    await rename(rendered, join(out, 'audio.ogg'));
    const metadata = { version: MUSIC_CACHE_VERSION, id: source.id, title, url: source.url ?? '', duration: actual, expectedDuration: expected || duration,
      selection: source.selection, loudness: MUSIC_LOUDNESS, cacheHit: false };
    const pending = join(out, `${randomUUID()}.json`);
    await writeFile(pending, JSON.stringify(metadata)); await rename(pending, join(out, 'meta.json'));
    await this.#prune(key).catch(() => {});
    return { ...metadata, input: join(out, 'audio.ogg') };
  }

  async #prune(except) {
    const base = join(this.#root, 'audio');
    const names = (await readdir(base)).filter(name => /^[a-f0-9]{64}$/.test(name));
    const entries = await Promise.all(names.map(async name => {
      const file = await stat(join(base, name, 'audio.ogg')).catch(() => null);
      return { name, bytes: file?.size ?? 0, at: file?.mtimeMs ?? 0 };
    }));
    let size = entries.reduce((sum, entry) => sum + entry.bytes, 0), count = entries.length;
    for (const entry of entries.sort((a, b) => a.at - b.at)) {
      if (size <= this.#maxBytes && count <= this.#maxEntries && Date.now() - entry.at < 24 * 3600_000) break;
      if (entry.name === except || this.#pins.has(join(base, entry.name, 'audio.ogg'))) continue;
      await rm(join(base, entry.name), { recursive: true, force: true });
      size -= entry.bytes; count--;
    }
  }

  async prepare(query, { signal, guildId = 'local' } = {}) {
    query = String(query ?? '').trim();
    if (!query || query.length > 500) throw new Error('請提供 500 字以內的歌曲關鍵詞或連結');
    const queryKey = `${guildId}:${query}`;
    const item = await this.#shared(this.#jobs, queryKey, signal, async jobSignal => {
      await mkdir(join(this.#root, 'work'), { recursive: true });
      const dir = await mkdtemp(join(this.#root, 'work', 'song-'));
      try {
        let source = this.#resolved.get(queryKey);
        if (!source || source.expires < Date.now() || source.kind === 'file') {
          source = { ...await this.#resolve(query, { dir, signal: jobSignal, guildId }), expires: Date.now() + 10 * 60_000 };
          this.#resolved.set(queryKey, source);
          if (this.#resolved.size > 128) this.#resolved.delete(this.#resolved.keys().next().value);
        }
        const key = hash(JSON.stringify([MUSIC_CACHE_VERSION, source.kind, source.id, MUSIC_LOUDNESS]));
        const cached = await this.#cached(key);
        if (cached) return { ...cached, selection: source.selection };
        const rendered = await this.#shared(this.#audioJobs, key, jobSignal, async renderSignal => {
          await this.#slot(renderSignal);
          // The render owns its directory independently of a cancelled resolver's waiter.
          let renderDir;
          try {
            renderDir = await mkdtemp(join(this.#root, 'work', 'render-'));
            const existing = await this.#cached(key);
            return existing ?? await this.#render(source, { signal: renderSignal, dir: renderDir, key });
          } finally { this.#releaseSlot(); if (renderDir) await rm(renderDir, { recursive: true, force: true }).catch(() => {}); }
        });
        return { ...rendered, selection: source.selection };
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
    });
    if (signal?.aborted) throw abortError();
    this.#pins.set(item.input, (this.#pins.get(item.input) ?? 0) + 1);
    let released = false;
    return { ...item, release: () => {
      if (released) return; released = true;
      const count = (this.#pins.get(item.input) ?? 1) - 1;
      if (count > 0) this.#pins.set(item.input, count); else this.#pins.delete(item.input);
    } };
  }

  async destroy() {
    for (const job of [...this.#jobs.values(), ...this.#audioJobs.values()]) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values(), ...this.#audioJobs.values()].map(job => job.promise));
    this.#resolved.clear(); this.#pins.clear();
  }
}

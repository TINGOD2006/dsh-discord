import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MusicAudioPipeline, musicTools, loudnessStats, youtubeUrl, embeddedUrl, splitShareText, completeDuration, normalizationFilter, loudnessAnalysisFilter, streamHeaders, MUSIC_LOUDNESS, MUSIC_CACHE_VERSION, YOUTUBE_CLIENT_FALLBACK } from '../../src/channels/discord/music-audio.mjs';
import { runMusicProcess, decodeMusicOutput } from '../../src/channels/discord/music-process.mjs';
import { resolutionMatches } from '../../src/channels/shared/music-selection.mjs';
import { resolvedQuery } from '../../src/channels/discord/music-dsh.mjs';

const work=resolve('work/test-music');
async function scratch(fn){await mkdir(work,{recursive:true});const dir=await mkdtemp(join(work,'case-'));try{await fn(dir);}finally{assert(resolve(dir).startsWith(work+'\\')||resolve(dir).startsWith(work+'/'));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}}

test('keyword playback selects with the model from one filtered YouTube snapshot', async () => {
  await scratch(async dir => {
    const anthem = { id: 'pzt6SmvGpXk', title: 'Sacrifice ft. G.E.M. Worlds 2025 Anthem', duration: 252 };
    const commentary = { id: '1vRpKlZSkOI', title: 'S15 主題曲評論', duration: 1235 };
    const entries = [
      { id: 'liveonly123', title: 'S15 主題曲直播', is_live: true },
      anthem,
      { id: 'longonly123', title: 'LOL s15主題曲', duration: 7200 },
      commentary,
    ];
    let searches = 0;
    let modelCalls = 0;
    const run = async (file, args, { cwd }) => {
      if (file === 'extractor') {
        if (args.at(-1) === 'ytsearch10:LOL s15主題曲') {
          searches++;
          // An ambiguous Latin query resolves differently per YouTube UI language.
          assert(args.some(arg => arg.includes('lang=zh-TW')), 'search must pin the YouTube UI language');
          return { stdout: JSON.stringify({ entries }) };
        }
        const item = entries.find(entry => args.at(-1).endsWith(entry.id));
        assert(item, 'only a known video can be downloaded');
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(item));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') {
        const { duration } = JSON.parse(await readFile(join(cwd, 'download.json'), 'utf8'));
        return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration } }) };
      }
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run, selectCandidate: async ({ candidates }) => {
        modelCalls++;
        assert.deepEqual(candidates.map(candidate => candidate.id), [anthem.id, commentary.id]);
        return { candidate: candidates[0], selection: 'dsh' };
      },
    });
    try {
      const prepare = () => pipeline.prepare('LOL s15主題曲', { guildId: 'guild' });
      const source = await prepare();
      assert.deepEqual([source.id, source.selection], [anthem.id, 'dsh-resolve']);
      const repeated = await prepare();
      assert.equal(repeated.id, anthem.id);
      assert.equal(searches, 1);
      assert.equal(modelCalls, 1);
      for (const item of [source, repeated]) item.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('resolvedQuery reads only a usable search string', () => {
  assert.equal(resolvedQuery('{"query":"花譜 糸"}'), '花譜 糸');
  assert.equal(resolvedQuery('{"query":"花譜 糸","confident":true}'), '花譜 糸');
  assert.equal(resolvedQuery('```json\n{"query":"  花譜   糸  "}\n```'), '花譜 糸');
  assert.equal(resolvedQuery('{"query":"花譜 糸","confident":false}'), '花譜 糸', 'confidence is advisory, not a gate');
  assert.equal(resolvedQuery('{"query":""}'), null);
  assert.equal(resolvedQuery('{"query":123}'), null);
  assert.equal(resolvedQuery('no json here'), null);
  assert.equal(resolvedQuery('{"query":"' + 'x'.repeat(201) + '"}'), null);
});

test('dsh-resolve rewrites a relational request before retrieval and still selects with the model', async () => {
  await scratch(async dir => {
    const ito = { id: '3Wtx6k2vInU', title: '花譜 #06「糸」【原創MV】', duration: 227 };
    const popular = { id: 'aaaaaaaaaaa', title: '花譜 #154「ありふれてたい」', duration: 280 };
    const searches = [];
    const selections = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.at(-1).startsWith('ytsearch')) {
          searches.push(args.at(-1));
          return { stdout: JSON.stringify({ entries: [popular, ito] }) };
        }
        const item = [popular, ito].find(entry => args.at(-1).endsWith(entry.id));
        assert(item, 'only a known video can be downloaded');
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(item));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 227 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      resolveQuery: async ({ query }) => { assert.equal(query, 'kaf 第一首歌'); return '花譜 糸'; },
      selectCandidate: async ({ query, candidates }) => {
        selections.push({ query, ids: candidates.map(candidate => candidate.id) });
        return { candidate: candidates.find(candidate => candidate.id === ito.id), selection: 'dsh' };
      },
    });
    try {
      const source = await pipeline.prepare('kaf 第一首歌', { guildId: 'guild' });
      assert.equal(source.id, ito.id);
      assert.equal(source.selection, 'dsh-resolve');
      assert.equal(source.resolvedQuery, '花譜 糸');
      assert.deepEqual(searches, ['ytsearch10:花譜 糸']);
      assert.equal(selections.length, 1);
      assert.equal(selections[0].query, 'kaf 第一首歌', 'the selector still sees the original request');
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('a rewrite is used only when the search results corroborate it', () => {
  const titles = [{ title: '花譜 #06「糸」【原創MV】' }, { title: '花譜 #154「ありふれてたい」' }];
  assert.equal(resolutionMatches('花譜 糸', titles), true);
  assert.equal(resolutionMatches('花譜 不存在的歌', titles), false);
  assert.equal(resolutionMatches('', titles), false);
});

test('dsh-resolve keeps the original query when the results do not corroborate the rewrite', async () => {
  await scratch(async dir => {
    const song = { id: '3Wtx6k2vInU', title: '花譜 #06「糸」【原創MV】', duration: 227 };
    const searches = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.at(-1).startsWith('ytsearch')) {
          searches.push(args.at(-1));
          return { stdout: JSON.stringify({ entries: [song] }) };
        }
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(song));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 227 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      resolveQuery: async () => '花譜 不存在的歌',
      selectCandidate: async ({ candidates }) => ({ candidate: candidates[0], selection: 'dsh' }),
    });
    try {
      const source = await pipeline.prepare('kaf 第一首歌', { guildId: 'guild' });
      assert.equal(source.resolvedQuery, undefined, 'an uncorroborated rewrite must not be used');
      assert.deepEqual(searches, ['ytsearch10:花譜 不存在的歌', 'ytsearch10:kaf 第一首歌']);
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('dsh-resolve trusts a corroborated memory rewrite without a web search', async () => {
  await scratch(async dir => {
    const song = { id: '3Wtx6k2vInU', title: '花譜 #06「糸」【原創MV】', duration: 227 };
    const modes = [];
    const searches = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.at(-1).startsWith('ytsearch')) {
          searches.push(args.at(-1));
          return { stdout: JSON.stringify({ entries: [song] }) };
        }
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(song));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 227 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      resolveQuery: async ({ mode }) => { modes.push(mode); return '花譜 糸'; },
      selectCandidate: async ({ candidates }) => ({ candidate: candidates[0], selection: 'dsh' }),
    });
    try {
      const source = await pipeline.prepare('kaf 第一首歌', { guildId: 'guild' });
      assert.equal(source.resolvedQuery, '花譜 糸');
      assert.deepEqual(modes, ['memory'], 'a corroborated memory rewrite skips the web read');
      assert.deepEqual(searches, ['ytsearch10:花譜 糸']);
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('dsh-resolve keeps going when the verification probe fails', async () => {
  await scratch(async dir => {
    const song = { id: '3Wtx6k2vInU', title: '花譜 #06「糸」【原創MV】', duration: 227 };
    const modes = [];
    const searches = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.at(-1).startsWith('ytsearch')) {
          searches.push(args.at(-1));
          if (args.at(-1) === 'ytsearch10:花譜 糸') throw Object.assign(new Error('音樂處理逾時，請重試'), { code: 'MUSIC_TIMEOUT' });
          return { stdout: JSON.stringify({ entries: [song] }) };
        }
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(song));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 227 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      resolveQuery: async ({ mode }) => { modes.push(mode); return mode === 'memory' ? '花譜 糸' : null; },
      selectCandidate: async ({ candidates }) => ({ candidate: candidates[0], selection: 'dsh' }),
    });
    try {
      const source = await pipeline.prepare('kaf 第一首歌', { guildId: 'guild' });
      assert.equal(source.resolvedQuery, undefined, 'a failed probe must not fail the request');
      assert.deepEqual(modes, ['memory', 'web']);
      // The timed-out probe is retried once before the request falls through.
      assert.deepEqual(searches, ['ytsearch10:花譜 糸', 'ytsearch10:花譜 糸', 'ytsearch10:kaf 第一首歌']);
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('a timed-out candidate search is retried once', async () => {
  await scratch(async dir => {
    const song = { id: '3Wtx6k2vInU', title: '花譜 #06「糸」【原創MV】', duration: 227 };
    const searches = [];
    let attempts = 0;
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.at(-1).startsWith('ytsearch')) {
          searches.push(args.at(-1));
          attempts++;
          if (attempts === 1) throw Object.assign(new Error('音樂處理逾時，請重試'), { code: 'MUSIC_TIMEOUT' });
          return { stdout: JSON.stringify({ entries: [song] }) };
        }
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(song));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 227 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      selectCandidate: async ({ candidates }) => ({ candidate: candidates[0], selection: 'dsh' }),
    });
    try {
      const source = await pipeline.prepare('kaf 第一首歌', { guildId: 'guild' });
      assert.equal(source.id, song.id);
      assert.deepEqual(searches, ['ytsearch10:kaf 第一首歌', 'ytsearch10:kaf 第一首歌']);
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('dsh-resolve resolves every request, including an ordinary artist and song one', async () => {
  await scratch(async dir => {
    const song = { id: '3Wtx6k2vInU', title: 'Adele - Hello', duration: 295 };
    let resolved = 0;
    const searches = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.at(-1).startsWith('ytsearch')) {
          searches.push(args.at(-1));
          return { stdout: JSON.stringify({ entries: [song] }) };
        }
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(song));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 295 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      resolveQuery: async () => { resolved++; return 'Adele Hello'; },
      selectCandidate: async ({ candidates }) => ({ candidate: candidates[0], selection: 'dsh' }),
    });
    try {
      await pipeline.prepare('Adele Hello', { guildId: 'guild' }).then(source => source.release());
      assert.equal(resolved, 2, 'memory and web are both consulted when neither rewrites');
      assert.deepEqual(searches, ['ytsearch10:Adele Hello']);
    } finally {
      await pipeline.destroy();
    }
  });
});

test('an unplayable selected video falls back to the next eligible candidate', async () => {
  await scratch(async dir => {
    const blocked = { id: 'aaaaaaaaaaa', title: 'Age gated', duration: 200 };
    const playable = { id: 'bbbbbbbbbbb', title: 'Playable', duration: 200 };
    const downloads = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ entries: [blocked, playable] }) };
        const target = args.at(-1);
        downloads.push(target);
        if (target.endsWith(blocked.id)) throw new Error('ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm your age');
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(playable));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 200 } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      selectCandidate: async ({ candidates }) => ({ candidate: candidates[0], selection: 'dsh' }),
    });
    try {
      const source = await pipeline.prepare('some song', { guildId: 'guild' });
      assert.equal(source.id, playable.id, 'the next eligible candidate is used');
      assert.deepEqual(downloads, [blocked, playable].map(item => 'https://www.youtube.com/watch?v=' + item.id));
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('dsh-resolve prefers verified audio for the requested song after its selected MV is blocked', async () => {
  await scratch(async dir => {
    const query = 'yoasobi的第一首曲';
    const rewritten = 'YOASOBI 夜に駆ける';
    const mv = { id: 'x8VYWazR5mE', title: 'YOASOBI「夜に駆ける」 Official Music Video', duration: 276 };
    const otherSong = { id: 'evtoG-4dLM4', title: 'Watch me!', duration: 186, uploader: 'YOASOBI', channel_is_verified: true };
    const unverified = { id: 'mTdfEMAa72s', title: '夜に駆ける', duration: 281, uploader: 'YOASOBI' };
    const audio = { id: 'by4SYYWlhEs', title: '夜に駆ける', duration: 262, uploader: 'YOASOBI', channel_is_verified: true };
    const downloads = [];
    const run = async (file, args) => {
      if (file === 'extractor') {
        const target = args.at(-1);
        if (args.includes('--dump-single-json')) {
          assert.equal(target, 'ytsearch10:' + rewritten);
          return { stdout: JSON.stringify({ entries: [mv, otherSong, unverified, audio] }) };
        }
        downloads.push(new URL(target).searchParams.get('v'));
        if (target.endsWith(mv.id)) throw new Error('請登入帳戶以確認你已滿限制年齡');
        assert.equal(target, 'https://www.youtube.com/watch?v=' + audio.id);
        await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify(audio));
        return { stdout: '', stderr: '' };
      }
      if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: audio.duration } }) };
      if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({
      cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath },
      run,
      resolveQuery: async () => rewritten,
      selectCandidate: async ({ query: received, candidates }) => {
        assert.equal(received, query);
        return { candidate: candidates[0], selection: 'dsh' };
      },
    });
    try {
      const source = await pipeline.prepare(query, { guildId: 'guild' });
      assert.equal(source.id, audio.id);
      assert.equal(source.selection, 'dsh-resolve');
      assert.equal(source.resolvedQuery, rewritten);
      assert.deepEqual(downloads, [mv.id, audio.id]);
      source.release();
    } finally {
      await pipeline.destroy();
    }
  });
});

test('only real YouTube host and video shapes reach the direct route',()=>{
  assert.equal(youtubeUrl('https://youtu.be/jNQXAC9IVRw'),'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  for(const url of ['https://youtube.com.evil.invalid/watch?v=jNQXAC9IVRw','file://youtube.com/watch?v=jNQXAC9IVRw','https://u:p@youtube.com/watch?v=jNQXAC9IVRw','https://youtube.com/playlist?list=123'])assert.equal(youtubeUrl(url),null);
  assert.equal(completeDuration(696,10),false);assert.equal(completeDuration(19,19.01),true);
});

test('music uses constant gain, leaves peak headroom and invalidates the louder cache profile',()=>{
  assert.equal(MUSIC_LOUDNESS.integrated,-20);assert.equal(MUSIC_LOUDNESS.truePeak,-3);
  assert.equal(MUSIC_CACHE_VERSION,4);
  assert.equal(normalizationFilter({input_i:-10,input_tp:-1,input_lra:25}),'volume=-10.000000dB');
  assert.equal(normalizationFilter({input_i:-30,input_tp:-2,input_lra:25}),'volume=-1.000000dB');
  assert.equal(normalizationFilter(null),'anull');
});

test('quiet and loud recordings are normalized before use and repeated playback uses the cache',async()=>{
  await scratch(async dir=>{
    const tools=musicTools();const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools});
    const levels=[];
    try{for(const [name,gain] of [['quiet',0.04],['loud',4]]){
      const input=join(dir,name+'.wav');
      await runMusicProcess(tools.ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=5','-af','volume='+gain,'-ar','48000',input],{cwd:dir});
      const source=await pipeline.prepare(input,{allowLocalFile:true});assert.equal(source.loudness.integrated,-20);assert(source.input.startsWith(dir));
      const measured=await runMusicProcess(tools.ffmpeg,['-hide_banner','-i',source.input,'-af',loudnessAnalysisFilter(),'-f','null','-'],{cwd:dir});
      const stats=loudnessStats(measured.stderr);levels.push(Number(stats.input_i));assert(Math.abs(Number(stats.input_i)+20)<0.5);source.release();
      const cached=await pipeline.prepare(input,{allowLocalFile:true});assert.equal(cached.cacheHit,true);cached.release();
    }assert(Math.abs(levels[0]-levels[1])<0.3);}finally{await pipeline.destroy();}
  });
});

test('stream headers keep only the CDN-relevant names and reject line breaks',()=>{
  assert.equal(streamHeaders({Referer:'https://www.bilibili.com','User-Agent':'UA'}),'Referer: https://www.bilibili.com\r\nUser-Agent: UA\r\n');
  assert.equal(streamHeaders({referer:'https://www.bilibili.com'}),'Referer: https://www.bilibili.com\r\n');
  assert.equal(streamHeaders({Referer:'x\r\nX-Evil: 1'}),null,'a header value cannot inject another header');
  assert.equal(streamHeaders(null),null);
});

test('only Bilibili downloads ask for an open-ended range',async()=>{
  await scratch(async dir=>{
    const calls=[];
    const run=async(file,args)=>{
      calls.push({file,args});
      if(file==='extractor'){
        if(args.includes('--dump-single-json'))return{stdout:JSON.stringify({title:'YouTube original',duration:5,url:'https://media.example/a.m4a',http_headers:{}})};
        await writeFile(args[args.indexOf('-o')+1].replace('%(ext)s','m4a'),Buffer.alloc(4096));
        await writeFile(args[args.indexOf('--print-to-file')+2],JSON.stringify({title:'YouTube original',duration:5}));
        return{stdout:'',stderr:''};
      }
      if(file==='probe')return{stdout:JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:5}})};
      if(args.includes('null'))return{stderr:'{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}'};
      await writeFile(args.at(-1),Buffer.alloc(4096));return{stdout:'',stderr:''};
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ytDlp:'extractor',ffmpeg:'ffmpeg',ffprobe:'probe',node:process.execPath},run});
    try{
      const source=await pipeline.prepare('https://www.youtube.com/watch?v=jNQXAC9IVRw');source.release();
      const download=calls.find(call=>call.file==='extractor'&&!call.args.includes('--skip-download'));
      assert(download,'the YouTube track is downloaded');
      assert(!download.args.includes('--add-header'),'YouTube keeps its default request');
    }finally{await pipeline.destroy();}
  });
});

test('direct audio downloads write incrementally, enforce the byte limit, and discard partial files', async t => {
  await scratch(async dir => {
    const first = Buffer.alloc(96 * 1024, 17);
    const last = Buffer.from('last packet');
    const workDir = join(dir, 'work');
    const url = 'https://music.example/track.mp3';
    const run = async (file, args) => {
      if (file === 'probe') {
        if (args.at(-1).endsWith('remote-audio.mp3')) {
          assert.deepEqual(await readFile(args.at(-1)), Buffer.concat([first, last]));
        }
        return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 5 } }) };
      }
      if (args.includes('null')) {
        return { stderr: JSON.stringify({ input_i: '-20', input_tp: '-10', input_lra: '0', input_thresh: '-30', target_offset: '0' }) };
      }
      await writeFile(args.at(-1), Buffer.alloc(4096));
      return { stdout: '', stderr: '' };
    };
    const pipeline = new MusicAudioPipeline({ cacheDir: dir, tools: { ffprobe: 'probe', ffmpeg: 'ffmpeg' }, run });
    const remote = t.mock.method(globalThis, 'fetch', () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(first); },
      async pull(controller) {
        const renderDir = (await readdir(workDir)).find(name => name.startsWith('render-'));
        const target = join(workDir, renderDir, 'remote-audio.mp3');
        for (let i = 0; i < 100 && (await stat(target).catch(() => null))?.size !== first.length; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal((await stat(target)).size, first.length, 'the first chunk is on disk before EOF');
        controller.enqueue(last);
        controller.close();
      },
    })));
    try {
      const track = await pipeline.prepare(url);
      track.release();
      let cancelled = false;
      remote.mock.mockImplementation(() => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from([1]));
          controller.enqueue(new Uint8Array(64 * 1024 * 1024));
        },
        cancel() { cancelled = true; },
      })));
      await assert.rejects(pipeline.prepare('https://music.example/oversize.mp3'), /64 MB/);
      assert.equal(cancelled, true, 'the oversized response body was cancelled');
      assert.deepEqual(await readdir(workDir), [], 'no partial download remains');

      const started = Promise.withResolvers();
      const stop = new AbortController();
      let stopped = false;
      remote.mock.mockImplementation(() => new Response(new ReadableStream({
        pull() { started.resolve(); },
        cancel() { stopped = true; },
      })));
      const pending = pipeline.prepare('https://music.example/stalled.mp3', { signal: stop.signal });
      await started.promise;
      stop.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      for (let i = 0; i < 100 && (await readdir(workDir)).length; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(stopped, true, 'stop releases a response stalled between packets');
      assert.deepEqual(await readdir(workDir), [], 'the cancelled render releases its scratch file');
    } finally { await pipeline.destroy(); }
  });
});

test('a link inside pasted share text is extracted without the surrounding punctuation',()=>{
  assert.equal(embeddedUrl('【《驯龙少年谣》| BLG 2026全球总决赛应援曲】https://www.bilibili.com/video/BV1mRW46XEdS/?share_source=copy_web&vd_source=995567b3154f75a7331c17710570cb92'),
    'https://www.bilibili.com/video/BV1mRW46XEdS/?share_source=copy_web&vd_source=995567b3154f75a7331c17710570cb92');
  assert.equal(embeddedUrl('聽這個（https://youtu.be/jNQXAC9IVRw）。'),'https://youtu.be/jNQXAC9IVRw');
  assert.equal(embeddedUrl('no link here'),null);
});

test('pasted share text keeps its title apart from the link',()=>{
  const share=splitShareText('【《驯龙少年谣》| BLG 2026全球总决赛应援曲】https://www.bilibili.com/video/BV1mRW46XEdS/?share_source=copy_web&vd_source=995567b3154f75a7331c17710570cb92');
  assert.equal(share.link,'https://www.bilibili.com/video/BV1mRW46XEdS/?share_source=copy_web&vd_source=995567b3154f75a7331c17710570cb92');
  assert.equal(share.title,'驯龙少年谣 | BLG 2026全球总决赛应援曲');
  assert.deepEqual(splitShareText('https://youtu.be/jNQXAC9IVRw'),{link:'https://youtu.be/jNQXAC9IVRw',title:''});
  assert.deepEqual(splitShareText('聽這個（https://youtu.be/jNQXAC9IVRw）。'),{link:'https://youtu.be/jNQXAC9IVRw',title:'聽這個'});
  assert.deepEqual(splitShareText('周杰倫 晴天'),{link:null,title:'周杰倫 晴天'});
});

test('a pasted share line resolves the link inside it instead of searching YouTube',async()=>{
  await scratch(async dir=>{
    const calls=[];
    const run=async(file,args)=>{
      calls.push({file,args});
      if(file==='extractor'&&args.includes('--dump-single-json')){
        return{stdout:JSON.stringify({title:'驯龙少年谣',duration:7200,url:'https://media.example/a.m4a',http_headers:{}})};
      }
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ytDlp:'extractor',ffmpeg:'ffmpeg',ffprobe:'probe',node:process.execPath},run});
    try{
      const source=await pipeline.prepare('【《驯龙少年谣》| BLG 2026全球总决赛应援曲】https://www.bilibili.com/video/BV1mRW46XEdS/?share_source=copy_web&vd_source=995567b3154f75a7331c17710570cb92');
      assert.equal(source.kind,'bilibili');
      assert.equal(source.stream,true);
      const call=calls.find(item=>item.file==='extractor');
      assert(call.args.includes('https://www.bilibili.com/video/BV1mRW46XEdS?p=1'),'the link inside the text is used');
      assert(!call.args.some(arg=>arg.startsWith('ytsearch')),'the share text is not searched on YouTube');
    }finally{await pipeline.destroy();}
  });
});

test('a stale stream URL is refreshed from the extractor before a retry',async()=>{
  await scratch(async dir=>{
    let issued=0;
    const run=async(file,args)=>{
      if(file==='extractor'&&args.includes('--dump-single-json')){
        issued++;
        return{stdout:JSON.stringify({title:'Long mix',duration:7200,url:`https://media.example/signed-${issued}.m4a`,
          http_headers:{Referer:'https://www.bilibili.com','User-Agent':'UA'}})};
      }
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ytDlp:'extractor',ffmpeg:'ffmpeg',ffprobe:'probe',node:process.execPath},run});
    try{
      const source={kind:'bilibili',url:'https://www.bilibili.com/video/BV1z44y1N7UH',input:'https://media.example/signed-0.m4a',stream:true,duration:7200};
      await pipeline.refreshStream(source);
      assert.equal(source.input,'https://media.example/signed-1.m4a','the expired URL is replaced');
      assert.equal(source.streamUrl,'https://media.example/signed-1.m4a');
      assert.equal(source.duration,7200);
      assert.match(source.headers,/Referer: https:\/\/www\.bilibili\.com/);
    }finally{await pipeline.destroy();}
  });
});

test('the extractor falls back to a client YouTube has not challenged, and a refused stream can force it',async()=>{
  await scratch(async dir=>{
    const calls=[];
    const run=async(file,args)=>{
      calls.push({file,args});
      if(file==='extractor'&&args.includes('--dump-single-json')){
        return{stdout:JSON.stringify({title:'Long mix',duration:7200,url:'https://media.example/signed.m4a',http_headers:{}})};
      }
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ytDlp:'extractor',ffmpeg:'ffmpeg',ffprobe:'probe',node:process.execPath},run});
    const client=()=>{const args=calls.at(-1).args;return args[args.indexOf('--extractor-args')+1];};
    try{
      const source={kind:'youtube',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',input:'https://media.example/signed.m4a',stream:true,duration:7200};
      await pipeline.refreshStream(source);
      assert.equal(client(),'youtube:player_client=default,android;lang=zh-TW','a challenged default client falls back instead of failing the track');
      await pipeline.refreshStream(source,{client:YOUTUBE_CLIENT_FALLBACK});
      assert.equal(client(),'youtube:player_client=android;lang=zh-TW','a refused stream re-resolves with the fallback client alone');
    }finally{await pipeline.destroy();}
  });
});

test('a flagged Bilibili IP gets the homepage cookie so the API fallback can run',async t=>{
  await scratch(async dir=>{
    const plugins=join(dir,'plugins');await mkdir(plugins,{recursive:true});
    const calls=[];
    const run=async(file,args)=>{
      calls.push({file,args});
      if(file==='extractor'&&args.includes('--dump-single-json')){
        return{stdout:JSON.stringify({title:'Bili track',duration:200,url:'https://media.example/a.m4a',http_headers:{}})};
      }
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ytDlp:'extractor',ffmpeg:'ffmpeg',ffprobe:'probe',node:process.execPath,plugins},run});
    const homepage=t.mock.method(globalThis,'fetch',()=>new Response('',{status:200,headers:{'set-cookie':'buvid3=abc123infoc; Path=/; Domain=.bilibili.com'}}));
    try{
      const source={kind:'bilibili',url:'https://www.bilibili.com/video/BV1z3Y76eEsg?p=1',input:'https://media.example/a.m4a',stream:true,duration:200};
      await pipeline.refreshStream(source);
      const args=calls.at(-1).args;
      const cookieFile=args[args.indexOf('--cookies')+1];
      assert(cookieFile,'the extractor is given a cookie file');
      assert.match(await readFile(cookieFile,'utf8'),/buvid3\tabc123infoc/,'the homepage cookie is written in Netscape form');
      assert.equal(homepage.mock.callCount(),1,'the homepage is fetched once');
      await pipeline.refreshStream(source);
      assert.equal(homepage.mock.callCount(),1,'the cookie file is reused instead of refetched');
    }finally{await pipeline.destroy();}
  });
});

test('a track past the cache limit streams from the source instead of being normalized',async()=>{
  await scratch(async dir=>{
    const tools=musicTools();const input=join(dir,'long.wav');
    await runMusicProcess(tools.ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=5','-ar','48000',input],{cwd:dir});
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools,maxDurationSec:1});
    try{
      const source=await pipeline.prepare(input,{allowLocalFile:true});
      assert.equal(source.stream,true);
      assert.equal(source.input,input,'the source file is played directly');
      assert.equal(source.duration,5);
      assert.equal(source.limitSec,1);
      assert.equal(source.cacheHit,false);
      source.release();
      const cached=await readdir(join(dir,'cache','audio')).catch(()=>[]);
      assert.deepEqual(cached,[],'a streamed track never enters the cache');
    }finally{await pipeline.destroy();}
  });
});

test('cancelling one shared request does not cancel another guild consumer',async()=>{
  await scratch(async dir=>{
    const input=join(dir,'fixture.wav');await writeFile(input,Buffer.alloc(4096));let begin;const gate=new Promise(resolve=>{begin=resolve;});let probeCalls=0;
    const run=async(file,args,{signal})=>{
      if(file==='probe'){probeCalls++;await gate;assert.equal(signal.aborted,false);return {stdout:JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:5}}),stderr:''};}
      if(args.includes('null'))return {stdout:'',stderr:'{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}'};
      await writeFile(args.at(-1),Buffer.alloc(4096));return {stdout:'',stderr:''};
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ffmpeg:'ffmpeg',ffprobe:'probe'},run});
    try{
      const controller=new AbortController();const first=pipeline.prepare(input,{signal:controller.signal,guildId:'one',allowLocalFile:true});first.catch(()=>{});
      const second=pipeline.prepare(input,{guildId:'two',allowLocalFile:true});
      while(!probeCalls)await new Promise(resolve=>setTimeout(resolve,1));
      controller.abort();begin();await assert.rejects(first,{name:'AbortError'});const result=await second;assert(result.input.endsWith('audio.flac'));result.release();
    }finally{await pipeline.destroy();}
  });
});

test('subprocess deadline and cancellation settle promptly and preserve UTF-8 output',async()=>{
  await scratch(async dir=>{
    const result=await runMusicProcess(process.execPath,['-e',"process.stdout.write('初音ミク')"],{cwd:dir});assert.equal(result.stdout,'初音ミク');
    const started=Date.now();await assert.rejects(runMusicProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,timeoutMs:50}),/逾時/);assert(Date.now()-started<5000);
    const controller=new AbortController();const pending=runMusicProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,signal:controller.signal});
    const cancelledAt=Date.now();controller.abort();assert(Date.now()-cancelledAt<250,'cancellation must not block Discord heartbeats');
    await assert.rejects(pending,{name:'AbortError'});
  });
});

test('a cp950 stderr from yt-dlp is decoded instead of becoming replacement characters',async()=>{
  // yt-dlp is a PyInstaller build: on a zh-TW host it writes the Windows
  // console code page, so the age-gate message arrives as Big5 bytes. Decoding
  // those as UTF-8 used to erase "滿限制年齡", which is what music-audio.mjs
  // matches to skip an age-restricted upload and try the next candidate.
  const message='ERROR: [youtube] x8VYWazR5mE: 請登入帳戶以確認你已滿限制年齡. 這部影片可能不適合某些使用者觀看。';
  assert.equal(decodeMusicOutput([Buffer.from(message,'utf8')]),message);
  // The real bytes are cp950, not UTF-8: 請 is BD D0, 登 is B5 6E.
  assert.equal(decodeMusicOutput([Buffer.from([0xBD,0xD0,0xB5,0x6E])]),'請登');
  await scratch(async dir=>{
    const script="process.stderr.write(Buffer.from([0xBD,0xD0,0xB5,0x6E]))";
    const result=await runMusicProcess(process.execPath,['-e',script],{cwd:dir});
    assert.equal(result.stderr,'請登');
  });
});

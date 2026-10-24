import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { bilibiliUrl, MusicAudioPipeline } from '../../src/channels/discord/music-audio.mjs';

const video = 'https://www.bilibili.com/video/BV1z44y1N7UH';
test('Bilibili routes strip tracking, select one part and reject unsupported URL shapes', () => {
  assert.equal(bilibiliUrl(`${video}/?spm_id_from=tracking&vd_source=tracking`), `${video}?p=1`);
  assert.equal(bilibiliUrl(`${video}?p=2&trackid=tracking`), `${video}?p=2`);
  assert.equal(bilibiliUrl('http://m.bilibili.com/video/av123/'), 'https://www.bilibili.com/video/av123?p=1');
  assert.equal(bilibiliUrl('https://b23.tv/abc123?share_source=copy'), 'https://b23.tv/abc123');
  assert.equal(bilibiliUrl('https://www.bilibili.com/audio/au123'), 'https://www.bilibili.com/audio/au123');
  for (const url of [`${video}?p=0`, `${video}?p=-1`, `${video}?p=abc`, 'https://bilibili.com.evil.invalid/video/BV1z44y1N7UH',
    'https://u:p@www.bilibili.com/video/BV1z44y1N7UH', 'file://www.bilibili.com/video/BV1z44y1N7UH',
    'https://www.bilibili.com/playlist', 'https://live.bilibili.com/123']) assert.equal(bilibiliUrl(url), null);
});

async function fixture(work) {
  const root = resolve('work/test-music'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'bilibili-'));
  const calls = []; let failDownload = false;
  const run = async (file, args) => {
    calls.push({ file, args });
    assert(!args.some(arg => arg.startsWith('ytsearch')), 'Bilibili must never search YouTube');
    if (file === 'extractor') {
      if (args.includes('--skip-download')) return { stdout: JSON.stringify({ webpage_url: `${video}?p=2&tracking=1` }) };
      if (failDownload) throw new Error('fixture extractor failure');
      await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), Buffer.alloc(4096));
      await writeFile(args[args.indexOf('--print-to-file') + 2], JSON.stringify({ title: 'Bilibili original', duration: 5 }));
      return { stdout: '', stderr: '' };
    }
    if (file === 'probe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 5 } }) };
    if (args.includes('null')) return { stderr: '{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}' };
    await writeFile(args.at(-1), Buffer.alloc(4096)); return { stdout: '', stderr: '' };
  };
  const pipeline = new MusicAudioPipeline({ cacheDir: join(dir, 'cache'), tools: { ytDlp: 'extractor', ffmpeg: 'ffmpeg', ffprobe: 'probe', node: process.execPath }, run,
    selectCandidate: () => { throw new Error('Bilibili must not invoke DSH selection'); } });
  try { await work({ pipeline, calls, fail: () => { failDownload = true; } }); }
  finally { await pipeline.destroy(); assert(resolve(dir).startsWith(root + sep)); await rm(dir, { recursive: true, force: true }); }
}

test('Bilibili original audio is normalized, tracking variants share cache and separate parts do not', async () => fixture(async ({ pipeline, calls }) => {
  const first = await pipeline.prepare(`${video}?tracking=1`);
  assert.equal(first.url, `${video}?p=1`); assert.equal(first.title, 'Bilibili original'); assert.equal(first.selection, 'direct'); first.release();
  const cached = await pipeline.prepare(`${video}?tracking=2`); assert.equal(cached.cacheHit, true); cached.release();
  const second = await pipeline.prepare(`${video}?p=2`); assert.notEqual(second.input, first.input); second.release();
  const downloads = calls.filter(call => call.file === 'extractor');
  assert.deepEqual(downloads.map(call => call.args.at(-1)), [`${video}?p=1`, `${video}?p=2`]);
  assert(downloads.every(call => call.args.includes('--no-playlist')));
}));

test('b23 shares resolve to their original Bilibili part without searching YouTube', async () => fixture(async ({ pipeline, calls }) => {
  const source = await pipeline.prepare('https://b23.tv/abc123?tracking=1');
  assert.equal(source.url, `${video}?p=2`); source.release();
  assert.equal(calls.find(call => call.args.includes('--skip-download')).args.at(-1), 'https://b23.tv/abc123');
}));

test('Bilibili extraction failure stays a Bilibili error and unsupported pages do not trigger search', async () => fixture(async ({ pipeline, fail, calls }) => {
  fail(); await assert.rejects(pipeline.prepare(video), /無法下載 Bilibili 音訊/);
  await assert.rejects(pipeline.prepare('https://www.bilibili.com/playlist'), /請提供 Bilibili/);
  assert.equal(calls.length, 1);
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshMusicSelector, createDshQueryResolver } from '../../src/channels/discord/music-dsh.mjs';

function capture(answer = '{"query":"unknown","confident":false}') {
  const prompts = [];
  const harness = {
    async createSession() { return 'session-fixture'; },
    async ask(_sessionId, prompt) { prompts.push(prompt); return answer; },
  };
  return { prompts, harness };
}

test('the memory resolver prompt covers latest releases', async () => {
  const { prompts, harness } = capture();
  const resolve = createDshQueryResolver(harness, { webSearch: null });
  const result = await resolve({ query: 'yoasobi最新作', guildId: 'guild', mode: 'memory' });
  assert.equal(result, 'unknown');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /最新作/);
  assert.match(prompts[0], /latest release/);
  assert.match(prompts[0], /發行日期/);
});

test('the grounded resolver prompt prefers the newest dated release', async () => {
  const { prompts, harness } = capture();
  const webSearch = async () => [{ title: 'YOASOBI new single', snippet: 'released 2026-06-26', url: 'https://example.test/' }];
  const resolve = createDshQueryResolver(harness, { webSearch });
  await resolve({ query: 'yoasobi最新作', guildId: 'guild', mode: 'web' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /最新作/);
  assert.match(prompts[0], /發行日期最新/);
});

test('the selector prompt puts the official channel first', async () => {
  const { prompts, harness } = capture('{"videoId":"aaaaaaaaaaa"}');
  const select = createDshMusicSelector(harness, {});
  const candidates = [{ id: 'aaaaaaaaaaa', title: 'YOASOBI「KILLA」', artist: 'YOASOBI', duration: 210 }];
  const result = await select({ query: 'yoasobi最新作', guildId: 'guild', candidates });
  assert.equal(result.selection, 'dsh');
  assert.equal(result.candidate.id, 'aaaaaaaaaaa');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /官方頻道/);
  assert.match(prompts[0], /第三方歌詞/);
  assert.match(prompts[0], /演唱會或現場片段/);
});

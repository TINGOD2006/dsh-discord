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
  assert.deepEqual(result, { query: 'unknown', failure: null });
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

test('the resolver reports why it could not name a song', async () => {
  const missingHarness = createDshQueryResolver({}, { webSearch: null });
  assert.deepEqual(await missingHarness({ query: 'song', guildId: 'guild', mode: 'memory' }),
    { query: null, failure: 'unavailable' });

  const { harness: unparsed } = capture('沒有任何 JSON');
  assert.deepEqual(await createDshQueryResolver(unparsed, { webSearch: null })({ query: 'song', guildId: 'guild', mode: 'memory' }),
    { query: null, failure: 'unparsed' });

  // Web mode without a configured backend is a configuration problem, not a
  // model problem, and must stay distinguishable.
  const { harness: noWeb } = capture();
  assert.deepEqual(await createDshQueryResolver(noWeb, { webSearch: null })({ query: 'song', guildId: 'guild', mode: 'web' }),
    { query: null, failure: 'no-web' });
  const emptyWeb = createDshQueryResolver(noWeb, { webSearch: async () => [] });
  assert.deepEqual(await emptyWeb({ query: 'song', guildId: 'guild', mode: 'web' }),
    { query: null, failure: 'no-web' });
});

test('a resolver timeout is reported as a timeout, and cancellation stays an abort', async () => {
  const stalled = { createSession: async () => 'session', ask: () => new Promise(() => {}) };
  const resolve = createDshQueryResolver(stalled, { webSearch: null, timeoutMs: 10 });
  assert.deepEqual(await resolve({ query: 'song', guildId: 'guild', mode: 'memory' }),
    { query: null, failure: 'timeout' });

  const controller = new AbortController();
  const pending = createDshQueryResolver(stalled, { webSearch: null, timeoutMs: 60_000 })({
    query: 'song', guildId: 'guild', mode: 'memory', signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
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

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemberDirectory } from '../src/channels/discord/member-directory.mjs';
import { DiscordApi } from '../src/channels/discord/discord-api.mjs';

const TOKEN = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
const G1 = '111111111111111111';
const G2 = '222222222222222222';

function member(id, {
  username = `u${id}`, globalName = null, nick = null, bot = false, avatar = null,
} = {}) {
  return { user: { id, username, global_name: globalName, bot, avatar }, nick };
}

function guild(id, name, memberCount = 2) {
  return { id, name, approximate_member_count: memberCount };
}

/** Minimal fake DiscordApi. `rateLimitTimes` throws 429 the first N calls per guild. */
function fakeApi({
  guilds = [], membersByGuild = {}, failGuilds = {}, rateLimitTimes = 0,
} = {}) {
  const calls = [];
  const seen = new Map();
  return {
    calls,
    async listGuilds() {
      calls.push(['guilds']);
      return guilds;
    },
    async listGuildMembers(guildId, { after, limit } = {}) {
      const key = String(guildId);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      calls.push(['members', key, after ?? null, limit]);
      if (count <= rateLimitTimes) {
        const error = new Error('You are being rate limited.');
        error.status = 429;
        error.retry_after = 0.01;
        throw error;
      }
      const failure = failGuilds[key];
      if (failure) {
        const error = new Error(failure.message ?? 'fetch failed');
        error.status = failure.status ?? 500;
        if (failure.providerCode) error.providerCode = failure.providerCode;
        throw error;
      }
      const all = membersByGuild[key] ?? [];
      const start = after ? all.findIndex((entry) => entry.user.id === after) + 1 : 0;
      return all.slice(start, start + (limit ?? 1_000));
    },
  };
}

test('paginates guild members in 1000-row pages', async () => {
  const all = Array.from({ length: 1_020 }, (_, index) => member(String(1_000_000 + index)));
  const api = fakeApi({ guilds: [guild(G1, 'One')], membersByGuild: { [G1]: all } });
  const directory = createMemberDirectory({ api });
  const result = await directory.list();
  assert.equal(result.members.length, 1_020);
  const memberCalls = api.calls.filter((call) => call[0] === 'members');
  assert.equal(memberCalls.length, 2);
  assert.equal(memberCalls[1][2], all[999].user.id);
});

test('dedupes the same user across guilds and records every guild id', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One'), guild(G2, 'Two')],
    membersByGuild: {
      [G1]: [member('42', { username: 'alice', nick: '小艾' }), member('43')],
      [G2]: [member('42', { username: 'alice' })],
    },
  });
  const result = await createMemberDirectory({ api }).list();
  assert.equal(result.members.length, 2);
  const alice = result.members.find((entry) => entry.id === '42');
  assert.deepEqual(alice.guildIds, [G1, G2]);
  assert.equal(alice.nickname, '小艾');
  assert.equal(alice.displayName, '小艾');
});

test('excludes bot accounts', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One')],
    membersByGuild: { [G1]: [member('1'), member('2', { bot: true }), member('3')] },
  });
  const result = await createMemberDirectory({ api }).list();
  assert.deepEqual(result.members.map((entry) => entry.id), ['1', '3']);
});

test('builds CDN avatars with the right extension and defaults when hash is missing', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One')],
    membersByGuild: {
      [G1]: [
        member('100', { avatar: 'abc123' }),
        member('101', { avatar: 'a_gifhash' }),
        member('102'),
      ],
    },
  });
  const result = await createMemberDirectory({ api }).list();
  const byId = new Map(result.members.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('100').avatarUrl, 'https://cdn.discordapp.com/avatars/100/abc123.png');
  assert.equal(byId.get('101').avatarUrl, 'https://cdn.discordapp.com/avatars/101/a_gifhash.gif');
  const expectedIndex = Number((102n >> 22n) % 6n);
  assert.equal(byId.get('102').avatarUrl, `https://cdn.discordapp.com/embed/avatars/${expectedIndex}.png`);
});

test('displayName falls back from nickname to global name to username', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One')],
    membersByGuild: {
      [G1]: [
        member('1', { username: 'u1', globalName: 'G1' }),
        member('2', { username: 'u2', nick: 'N2' }),
        member('3', { username: 'u3' }),
      ],
    },
  });
  const result = await createMemberDirectory({ api }).list();
  const byId = new Map(result.members.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('1').displayName, 'G1');
  assert.equal(byId.get('2').displayName, 'N2');
  assert.equal(byId.get('3').displayName, 'u3');
});

test('retries a rate-limited page before reporting it', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One')],
    membersByGuild: { [G1]: [member('1')] },
    rateLimitTimes: 1,
  });
  const result = await createMemberDirectory({ api }).list();
  assert.equal(result.members.length, 1);
  assert.equal(result.partial, false);
});

test('reports members-rate-limited after exhausting retries', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One')],
    membersByGuild: { [G1]: [member('1')] },
    rateLimitTimes: 10,
  });
  const result = await createMemberDirectory({ api }).list();
  assert.equal(result.partial, true);
  assert.equal(result.errors[0].code, 'members-rate-limited');
});

test('keeps the other guilds when one guild fails', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One'), guild(G2, 'Two')],
    membersByGuild: { [G1]: [member('1')], [G2]: [member('2')] },
    failGuilds: { [G2]: { status: 500 } },
  });
  const result = await createMemberDirectory({ api }).list();
  assert.equal(result.members.length, 1);
  assert.equal(result.partial, true);
  assert.deepEqual(result.errors, [{ guildId: G2, code: 'members-fetch-failed' }]);
});

test('maps guild permission failures to members-intent-required', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One')],
    membersByGuild: { [G1]: [member('1')] },
    failGuilds: { [G1]: { status: 403, providerCode: 50001, message: 'Missing Access' } },
  });
  const result = await createMemberDirectory({ api }).list();
  assert.equal(result.members.length, 0);
  assert.equal(result.errors[0].code, 'members-intent-required');
});

test('caches the result for its ttl and force bypasses it', async () => {
  let clock = 1_000;
  const api = fakeApi({ guilds: [guild(G1, 'One')], membersByGuild: { [G1]: [member('1')] } });
  const directory = createMemberDirectory({ api, ttlMs: 5_000, now: () => clock });
  await directory.list();
  const afterFirst = api.calls.length;
  await directory.list();
  assert.equal(api.calls.length, afterFirst);
  clock += 6_000;
  await directory.list();
  assert.ok(api.calls.length > afterFirst);
  const beforeForce = api.calls.length;
  await directory.list({ force: true });
  assert.ok(api.calls.length > beforeForce);
});

test('reports guild metadata alongside members', async () => {
  const api = fakeApi({
    guilds: [guild(G1, 'One', 7)],
    membersByGuild: { [G1]: [member('1')] },
  });
  const result = await createMemberDirectory({ api }).list();
  assert.deepEqual(result.guilds, [{ id: G1, name: 'One', memberCount: 7 }]);
  assert.equal(typeof result.fetchedAt, 'number');
});

test('DiscordApi.listGuilds requests the guild list with bot auth', async () => {
  const requests = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, status: 200, json: async () => [{ id: '1', name: 'One' }] };
    },
  });
  const guilds = await api.listGuilds();
  assert.equal(guilds.length, 1);
  const [url, options] = requests[0];
  assert.equal(url.pathname, '/api/v10/users/@me/guilds');
  assert.equal(url.search, '?with_counts=true');
  assert.equal(options.headers.authorization, `Bot ${TOKEN}`);
});

test('DiscordApi.listGuildMembers pages with limit and after', async () => {
  const requests = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => [member('2')] };
    },
  });
  await api.listGuildMembers('123456', { after: '9', limit: 500 });
  assert.equal(requests[0].pathname, '/api/v10/guilds/123456/members');
  assert.equal(requests[0].searchParams.get('limit'), '500');
  assert.equal(requests[0].searchParams.get('after'), '9');
});

test('DiscordApi keeps provider metadata on permission errors', async () => {
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ code: 50001, message: 'Missing Access' }),
    }),
  });
  await assert.rejects(api.listGuildMembers('123456'), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.providerCode, 50001);
    return true;
  });
});

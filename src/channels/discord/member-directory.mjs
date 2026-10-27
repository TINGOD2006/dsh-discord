/**
 * Member directory for the Discord whitelist panel.
 *
 * Aggregates every guild the bot has joined into one merged member list, with a
 * short-lived in-memory cache. Discord requires the GUILD_MEMBERS privileged
 * intent for `GET /guilds/{id}/members`; when the intent is off the REST call
 * answers 403 and the directory reports `members-intent-required` so the UI can
 * explain what to enable.
 */
const CDN_BASE = 'https://cdn.discordapp.com';
const PAGE_SIZE = 1_000;
const DEFAULT_TTL_MS = 5 * 60_000;
const RETRY_LIMIT = 2;
const MIN_RETRY_MS = 50;
const MAX_RETRY_MS = 5_000;

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isRateLimit(error) {
  return Number(error?.status) === 429 || error?.code === 'discord-429';
}

function isPermissionDenied(error) {
  const status = Number(error?.status);
  const providerCode = Number(error?.providerCode);
  return status === 403 || status === 401 || providerCode === 50_001 || providerCode === 50_013;
}

function retryDelay(error) {
  const seconds = Number(error?.retry_after ?? error?.retryAfter);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.round(seconds * 1_000)));
}

function failureCode(error) {
  if (isPermissionDenied(error)) return 'members-intent-required';
  if (isRateLimit(error)) return 'members-rate-limited';
  return 'members-fetch-failed';
}

function withCode(error, code) {
  const wrapped = new Error(error?.message ?? 'Discord member fetch failed', { cause: error });
  wrapped.code = code;
  wrapped.status = Number(error?.status);
  wrapped.providerCode = error?.providerCode;
  return wrapped;
}

function defaultAvatarIndex(id) {
  try {
    return Number((BigInt(id) >> 22n) % 6n);
  } catch {
    return 0;
  }
}

function avatarUrlOf(user) {
  const id = String(user.id);
  const hash = typeof user.avatar === 'string' && user.avatar !== '' ? user.avatar : null;
  if (hash) return `${CDN_BASE}/avatars/${id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}`;
  return `${CDN_BASE}/embed/avatars/${defaultAvatarIndex(id)}.png`;
}

async function withRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential Discord pages avoid rate-limit storms
      return await operation();
    } catch (error) {
      if (!isRateLimit(error) || attempt >= RETRY_LIMIT) throw error;
      // eslint-disable-next-line no-await-in-loop
      await wait(retryDelay(error));
    }
  }
}

function memberCountOf(guild) {
  const count = Number(guild?.approximate_member_count);
  return Number.isFinite(count) ? count : null;
}

export function createMemberDirectory({ api, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  if (!api || typeof api.listGuilds !== 'function' || typeof api.listGuildMembers !== 'function') {
    throw new TypeError('createMemberDirectory requires a Discord api with listGuilds/listGuildMembers');
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs must be a non-negative number');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let cached = null;

  async function pageThroughGuild(guildId) {
    const members = [];
    let after = null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential
      const page = await withRetry(() => api.listGuildMembers(guildId, after === null ? { limit: PAGE_SIZE } : { after, limit: PAGE_SIZE }));
      if (!Array.isArray(page) || page.length === 0) break;
      members.push(...page);
      if (page.length < PAGE_SIZE) break;
      const last = page[page.length - 1]?.user?.id;
      if (!last || String(last) === after) break;
      after = String(last);
    }
    return members;
  }

  async function fetchAll() {
    const fetchedAt = now();
    let guildRecords;
    try {
      guildRecords = await withRetry(() => api.listGuilds());
    } catch (error) {
      throw withCode(error, failureCode(error));
    }
    const guilds = Array.isArray(guildRecords) ? guildRecords : [];
    const byId = new Map();
    const errors = [];
    for (const guild of guilds) {
      const guildId = String(guild?.id ?? '');
      if (!/^\d{5,30}$/.test(guildId)) continue;
      let members;
      try {
        // eslint-disable-next-line no-await-in-loop -- guilds are fetched one at a time
        members = await pageThroughGuild(guildId);
      } catch (error) {
        errors.push({ guildId, code: failureCode(error) });
        continue;
      }
      for (const entry of members) {
        const user = entry?.user;
        if (!user?.id || user.bot === true) continue;
        const id = String(user.id);
        const existing = byId.get(id);
        if (existing) {
          if (!existing.guildIds.includes(guildId)) existing.guildIds.push(guildId);
          if (!existing.nickname && typeof entry.nick === 'string' && entry.nick !== '') {
            existing.nickname = entry.nick;
            existing.displayName = entry.nick;
          }
          continue;
        }
        const nickname = typeof entry.nick === 'string' && entry.nick !== '' ? entry.nick : null;
        const globalName = typeof user.global_name === 'string' && user.global_name !== ''
          ? user.global_name
          : null;
        const username = String(user.username ?? '');
        byId.set(id, {
          id,
          username,
          globalName,
          nickname,
          displayName: nickname ?? globalName ?? username,
          avatarUrl: avatarUrlOf(user),
          guildIds: [guildId],
        });
      }
    }
    return {
      members: [...byId.values()],
      fetchedAt,
      guilds: guilds
        .filter((guild) => /^\d{5,30}$/.test(String(guild?.id ?? '')))
        .map((guild) => ({
          id: String(guild.id),
          name: typeof guild.name === 'string' ? guild.name : '',
          memberCount: memberCountOf(guild),
        })),
      partial: errors.length > 0,
      errors,
    };
  }

  return {
    async list({ force = false } = {}) {
      if (!force && cached !== null && now() < cached.expiresAt) return cached.value;
      const value = await fetchAll();
      cached = { value, expiresAt: now() + ttlMs };
      return value;
    },
  };
}

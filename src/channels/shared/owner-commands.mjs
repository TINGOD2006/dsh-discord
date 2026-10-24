import { t } from './i18n.mjs';

// Owner-only commands. They answer to the bot's owner alone: the channel
// adapter passes `ownerTools` plus the saved owner id, and every command here
// stays out of the ordinary prompt lane either way. `/skip` lives with the
// other control commands because it is just the short spelling of `/stop`.
const OWNER_COMMAND = /^\/(?:digest|thread|recall|mute|unmute|block|unblock|blocklist)(?=$|\s)/iu;
const MUTE_MAX_MINUTES = 7 * 24 * 60;
const BLOCK_DEFAULT_MINUTES = 60;
const BLOCK_MAX_MINUTES = 7 * 24 * 60;
const DIGEST_DEFAULT_HOURS = 24;
const RECALL_DEFAULT_HOURS = 24;
// Two tiers: a wide-but-routine look-back needs a plain command, anything
// beyond it is an explicit second confirmation, so a typo cannot pull a week of
// chat into one prompt.
const RECALL_AUTO_MAX_HOURS = 72;
const RECALL_APPROVED_MAX_HOURS = 720;
// A recall grant is one-shot: it widens the next addressed turn, then expires.
const RECALL_GRANT_TTL_MS = 10 * 60_000;
const RECALL_PENDING_TTL_MS = 3 * 60_000;

// Mute is a switch for the live bridge, not archived configuration: a restart
// brings replies back. Platform conversation ids are globally unique, so one
// process-wide map covers every bot this host runs.
const mutedUntil = new Map();

// Per-conversation block list for single users: conversation id -> user id ->
// expiry. Kept separate from mute because it silences one sender, not the room.
const blocked = new Map();
const recallGrants = new Map();
const pendingRecalls = new Map();

export function isOwnerCommand(text) {
  return typeof text === 'string' && OWNER_COMMAND.test(text.trim());
}

export function blockUser(conversationId, userId, minutes) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  const user = typeof userId === 'string' ? userId.trim() : '';
  if (!colloquy || !user) return null;
  const bounded = Math.min(BLOCK_MAX_MINUTES, Math.max(1, Math.trunc(minutes)));
  const map = blocked.get(colloquy) ?? new Map();
  map.set(user, Date.now() + bounded * 60_000);
  blocked.set(colloquy, map);
  return bounded;
}

export function unblockUser(conversationId, userId) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  const user = typeof userId === 'string' ? userId.trim() : '';
  if (!colloquy || !user) return false;
  const map = blocked.get(colloquy);
  if (!map) return false;
  const removed = map.delete(user);
  if (map.size === 0) blocked.delete(colloquy);
  return removed;
}

export function isUserBlocked(conversationId, userId, now = Date.now()) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  const user = typeof userId === 'string' ? userId.trim() : '';
  if (!colloquy || !user) return false;
  const map = blocked.get(colloquy);
  const until = map?.get(user);
  if (until === undefined) return false;
  if (now < until) return true;
  map.delete(user);
  if (map.size === 0) blocked.delete(colloquy);
  return false;
}

export function listBlockedUsers(conversationId, now = Date.now()) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  const map = blocked.get(colloquy);
  if (!map) return [];
  const rows = [];
  for (const [userId, until] of map) {
    if (now >= until) {
      map.delete(userId);
      continue;
    }
    rows.push({ userId, minutesLeft: Math.max(1, Math.ceil((until - now) / 60_000)) });
  }
  if (map.size === 0) blocked.delete(colloquy);
  return rows;
}

export function grantRecall(conversationId, hours, { approved = false } = {}) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!colloquy) return 0;
  const ceiling = approved ? RECALL_APPROVED_MAX_HOURS : RECALL_AUTO_MAX_HOURS;
  const bounded = Math.min(ceiling, Math.max(1, Math.trunc(hours)));
  recallGrants.set(colloquy, { hours: bounded, expiresAt: Date.now() + RECALL_GRANT_TTL_MS });
  return bounded;
}

/**
 * Remember an over-limit request until the owner confirms it, and report the
 * hours that confirmation would open (already clamped to the hard ceiling).
 */
export function requestRecallApproval(conversationId, hours) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!colloquy) return 0;
  const bounded = Math.min(RECALL_APPROVED_MAX_HOURS, Math.max(RECALL_AUTO_MAX_HOURS + 1, Math.trunc(hours)));
  pendingRecalls.set(colloquy, { hours: bounded, expiresAt: Date.now() + RECALL_PENDING_TTL_MS });
  return bounded;
}

/** Consume a pending confirmation request, if it has not expired. */
export function takePendingRecall(conversationId, now = Date.now()) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!colloquy) return null;
  const pending = pendingRecalls.get(colloquy);
  if (!pending) return null;
  pendingRecalls.delete(colloquy);
  return now <= pending.expiresAt ? pending : null;
}

/** Consume the pending recall grant for a conversation, if any. */
export function takeRecallGrant(conversationId, now = Date.now()) {
  const colloquy = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!colloquy) return 0;
  const grant = recallGrants.get(colloquy);
  if (!grant) return 0;
  recallGrants.delete(colloquy);
  return now <= grant.expiresAt ? grant.hours : 0;
}

export function muteConversation(conversationId, minutes) {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!id) return false;
  const bounded = Math.min(MUTE_MAX_MINUTES, Math.max(1, Math.trunc(minutes)));
  mutedUntil.set(id, Date.now() + bounded * 60_000);
  return bounded;
}

export function unmuteConversation(conversationId) {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!id) return false;
  return mutedUntil.delete(id);
}

export function isConversationMuted(conversationId, now = Date.now()) {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!id) return false;
  const until = mutedUntil.get(id);
  if (until === undefined) return false;
  if (now < until) return true;
  mutedUntil.delete(id);
  return false;
}

function commandResult(message) {
  return { message };
}

function conversationOf(enhancement) {
  const source = enhancement?.source?.() ?? {};
  return typeof source.chatId === 'string' && source.chatId ? source.chatId : '';
}

/** Accept `<@id>`, `<@!id>` or a bare snowflake as the first argument. */
function mentionUserId(raw) {
  const match = /^(?:<@!?(\d{5,30})>|(\d{5,30}))(?=$|\s)/u.exec(String(raw ?? '').trim());
  return match ? (match[1] ?? match[2]) : '';
}

export async function runOwnerCommand(text, harness, state, key, {
  signal, ownerTools, enhancement,
} = {}) {
  if (!isOwnerCommand(text)) return null;
  const command = text.trim();
  const [rawName, ...rest] = command.slice(1).split(/\s+/u);
  const name = String(rawName ?? '').toLowerCase();
  const args = rest.join(' ').trim();
  const conversationId = conversationOf(enhancement);

  if (name === 'mute') {
    if (!conversationId) return commandResult(t('无法识别当前对话，暂停自动回复失败。'));
    const requested = Number.parseInt(args, 10);
    const bounded = muteConversation(conversationId, Number.isFinite(requested) ? requested : 60);
    return commandResult(t('已暂停本频道自动回复 {minutes} 分钟；期间只有 /mute 和 /unmute 生效。', {
      minutes: String(bounded),
    }));
  }

  if (name === 'unmute') {
    if (!conversationId) return commandResult(t('无法识别当前对话，恢复自动回复失败。'));
    return commandResult(unmuteConversation(conversationId)
      ? t('已恢复本频道自动回复。')
      : t('本频道当前没有暂停自动回复。'));
  }

  if (name === 'recall') {
    if (!conversationId) return commandResult(t('无法识别当前对话，无法开放回溯。'));
    const argument = String(args ?? '').trim();
    // `#m3f2a` names one archived row: read that row and its neighbours now,
    // instead of widening the next turn's window and hoping it lands inside.
    if (/^#?m[0-9a-z]{2,12}$/iu.test(argument)) {
      const found = await ownerTools?.recallRef?.({ conversationId, ref: argument });
      return commandResult(found?.text || t('没有找到编号 {ref} 的记录。', { ref: argument.replace(/^#/u, '') }));
    }
    if (/^(?:批准|确认|確認|approve|yes|ok)$/iu.test(argument)) {
      const pending = takePendingRecall(conversationId);
      if (!pending) return commandResult(t('没有待确认的回溯请求。'));
      const granted = grantRecall(conversationId, pending.hours, { approved: true });
      return commandResult(t('已开放回溯 {hours} 小时（已确认），只放宽下一轮上下文，之后自动恢复。', {
        hours: String(granted),
      }));
    }
    const requested = Number.parseInt(argument, 10);
    const hours = Number.isFinite(requested) ? requested : RECALL_DEFAULT_HOURS;
    if (hours > RECALL_AUTO_MAX_HOURS) {
      const pending = requestRecallApproval(conversationId, hours);
      return commandResult(t('更早的记录需要主人确认：{minutes} 分钟内再发 /recall 批准，可开放 {hours} 小时窗口。', {
        minutes: String(Math.round(RECALL_PENDING_TTL_MS / 60_000)),
        hours: String(pending),
      }));
    }
    const granted = grantRecall(conversationId, hours);
    return commandResult(t('已开放回溯 {hours} 小时，只放宽下一轮上下文，之后自动恢复。', {
      hours: String(granted),
    }));
  }

  if (name === 'block') {
    if (!conversationId) return commandResult(t('无法识别当前对话，暂停用户回复失败。'));
    const user = mentionUserId(args);
    if (!user) return commandResult(t('用法：/block @某人 [分钟]，默认 60 分钟。'));
    const minutes = Number.parseInt(String(args).replace(/^<?@!?\d{5,30}>?/u, '').trim(), 10);
    const bounded = blockUser(conversationId, user, Number.isFinite(minutes) ? minutes : BLOCK_DEFAULT_MINUTES);
    return commandResult(t('已在本频道暂停该用户回复 {minutes} 分钟。', { minutes: String(bounded) }));
  }

  if (name === 'unblock') {
    if (!conversationId) return commandResult(t('无法识别当前对话，恢复用户回复失败。'));
    const user = mentionUserId(args);
    if (!user) return commandResult(t('用法：/unblock @某人'));
    return commandResult(unblockUser(conversationId, user)
      ? t('已恢复该用户在本频道的回复。')
      : t('该用户当前没有被暂停。'));
  }

  if (name === 'blocklist') {
    if (!conversationId) return commandResult(t('无法识别当前对话，读取暂停名单失败。'));
    const rows = listBlockedUsers(conversationId);
    if (rows.length === 0) return commandResult(t('本频道没有被暂停的用户。'));
    return commandResult(`${t('本频道暂停名单：')}\n${rows.map((row) => `· <@${row.userId}> — ${t('{minutes} 分钟后恢复', { minutes: String(row.minutesLeft) })}`).join('\n')}`);
  }

  if (name === 'digest') {
    if (typeof ownerTools?.digest !== 'function') return commandResult(t('当前通道不支持群聊摘要。'));
    const requested = Number.parseInt(args, 10);
    let digest;
    try {
      digest = await ownerTools.digest({
        conversationId,
        hours: Number.isFinite(requested) ? requested : DIGEST_DEFAULT_HOURS,
        signal,
      });
    } catch (error) {
      if (error?.code === 'turn-stopped') throw error;
      return commandResult(t('读取群聊记录失败，请稍后重试。'));
    }
    if (!digest?.text) return commandResult(t('这个频道还没有可用的群聊记录。'));
    return commandResult(digest.text);
  }

  if (typeof ownerTools?.thread !== 'function') return commandResult(t('当前通道不支持创建讨论串。'));
  let created;
  try {
    created = await ownerTools.thread({ conversationId, name: args || undefined, signal });
  } catch (error) {
    if (error?.code === 'turn-stopped') throw error;
    return commandResult(t('创建讨论串失败，请稍后重试。'));
  }
  if (!created?.id) return commandResult(t('创建讨论串失败，请稍后重试。'));
  return commandResult(t('讨论串已创建：<#{id}>', { id: created.id }));
}

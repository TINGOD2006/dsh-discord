/**
 * Rebuilding the conversation a bot missed while it was offline.
 *
 * Discord does not queue events for a disconnected bot: a long outage or a
 * stopped DSH leaves a hole that only REST can fill. These helpers stay pure so
 * the window, ordering and shape rules can be tested without a gateway.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SNOWFLAKE = /^\d{5,30}$/u;

/** `group:123` / `direct:456` → the Discord channel to read. */
export function parseConversationKey(key) {
  const match = /^(group|direct):(\d{5,30})$/u.exec(typeof key === 'string' ? key : '');
  if (!match) return null;
  return { kind: match[1], channelId: match[2] };
}

function snowflakeValue(id) {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

/**
 * Oldest-first slice of the messages worth archiving.
 *
 * Bots and empty messages are dropped (they are not conversation), anything
 * older than the window is dropped (a week of backlog would swamp the next
 * turn), and the result is capped so one outage cannot flood the archive.
 */
export function selectCatchUpMessages(messages, { now = Date.now(), windowMs = DAY_MS, limit = 200 } = {}) {
  if (!Array.isArray(messages)) return [];
  const floor = now - windowMs;
  const kept = [];
  for (const raw of messages) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!SNOWFLAKE.test(id)) continue;
    if (raw.author?.bot === true) continue;
    const text = typeof raw.content === 'string' ? raw.content : '';
    const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
    if (!text.trim() && !attachments.length) continue;
    const sentAt = Date.parse(raw.timestamp ?? '');
    if (Number.isFinite(sentAt) && sentAt < floor) continue;
    kept.push(raw);
  }
  kept.sort((left, right) => {
    const a = snowflakeValue(left.id), b = snowflakeValue(right.id);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return kept.length > limit ? kept.slice(kept.length - limit) : kept;
}

/** The archive row for one REST message, in the shape group-history stores. */
export function catchUpEntry(raw, { channelId, groupName = '' } = {}) {
  const attachments = Array.isArray(raw?.attachments) ? raw.attachments : [];
  const sentAt = Date.parse(raw?.timestamp ?? '');
  return {
    channel: 'discord',
    scope: typeof raw?.guild_id === 'string' ? raw.guild_id : '',
    groupId: String(channelId ?? ''),
    groupName,
    senderId: typeof raw?.author?.id === 'string' ? raw.author.id : '',
    senderName: typeof raw?.author?.username === 'string' ? raw.author.username : '',
    messageId: String(raw?.id ?? ''),
    sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
    text: typeof raw?.content === 'string' ? raw.content : '',
    type: attachments.length ? 'file' : 'text',
    replyToMessageId: raw?.message_reference?.message_id ?? undefined,
    attachments: [],
  };
}

import { captureGroupHistory, groupHistoryEntry } from '../shared/group-history.mjs';
import { extractConnectionEvidence, createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';
import { createEditableMessageStream, splitMessageText } from '../shared/editable-message-stream.mjs';
import { chunkMarkdownText } from '../shared/markdown-chunks.mjs';
import { createTextDeliveryBlock } from '../shared/semantic/delivery.mjs';
import { fetchFileStream } from '../shared/file-download.mjs';
import { fetchImageBuffer } from '../shared/image-prompt.mjs';
import { t } from '../shared/i18n.mjs';
import { captureContextEnhancement } from '../shared/context-enhancement.mjs';
import { evaluateInboundAccess } from '../shared/inbound-access.mjs';
import { stripInternalLeaks } from '../shared/outbound-sanitize.mjs';
import { digestForContext, normalizeDigestConfig } from '../shared/thread-digest.mjs';
import { takeRecallGrant, isOwnerCommand } from '../shared/owner-commands.mjs';
import { isControlCommand } from '../shared/control-command.mjs';
import { DiscordApi } from './discord-api.mjs';
import { handleApplicationCommand, syncApplicationCommands } from './discord-commands.mjs';
import { MusicManager } from './music.mjs';
import { isMusicCommand } from '../shared/music-commands.mjs';
import { createDiscordBridgeStatus, DiscordHarnessBridge } from './discord-bridge.mjs';

const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const THREAD_RECOVERY_TIMEOUT_MS = 5_000;
const RECONNECT_DELAYS_MS = Object.freeze([1_000, 3_000, 5_000, 10_000, 30_000]);
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;
const ANNOUNCEMENT_THREAD = 10;
const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
const THREAD_TYPES = new Set([ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD]);
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_FILE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const DISCORD_IMAGE_HOSTS = Object.freeze(['cdn.discordapp.com']);

function socketUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:') throw new Error('Discord returned an insecure Gateway URL');
  url.searchParams.set('v', '10');
  url.searchParams.set('encoding', 'json');
  return url.href;
}

function addSocketListener(socket, event, listener) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(event, listener);
  else if (typeof socket.on === 'function') socket.on(event, listener);
  else throw new TypeError('Discord WebSocket does not support events');
}

function eventData(event) {
  if (typeof event === 'string') return event;
  if (typeof event?.data === 'string') return event.data;
  if (Buffer.isBuffer(event)) return event.toString('utf8');
  if (Buffer.isBuffer(event?.data)) return event.data.toString('utf8');
  return null;
}

function gatewayCloseError(code) {
  if (code === 4004) {
    const error = new Error(t('Discord Bot Token 无效，请重新填写。'));
    error.code = 'discord-401';
    return error;
  }
  if (code === 4013 || code === 4014) {
    const error = new Error(t('Discord Gateway Intents 配置不正确，请检查 Developer Portal 的 Bot 设置。'));
    error.code = 'discord-intents';
    return error;
  }
  const error = new Error(`Discord Gateway closed (${code || 'unknown'})`);
  error.code = 'discord-gateway-closed';
  return error;
}

function stripBotMention(text, botId) {
  if (typeof text !== 'string') return '';
  return text
    .split(`<@${botId}>`).join('')
    .split(`<@!${botId}>`).join('')
    .trim();
}

function cleanThreadName(message, botId) {
  const name = stripBotMention(message?.content ?? '', botId).replace(/\s+/g, ' ').trim()
    || 'DeepSeek Harness';
  return [...name].slice(0, 100).join('');
}

// How much channel chatter one turn may carry as replay context. The default is
// deliberately tight: chatter rides along with every addressed turn, so a wide
// window would spend the model's attention on lines the user did not send.
const HISTORY_MAX_CHARS = 1_500;
// A look-back is opt-in and bounded: at most 6 hours of history and 4k chars
// (~2k tokens), which is the hard ceiling the archive can add to one turn.
const RECALL_DEFAULT_HOURS = 6;
const RECALL_MAX_CHARS = 4_000;
const RECALL_LIMIT = 60;
// Only an explicit request for older context widens the window; ordinary small
// talk about "earlier" must not silently inflate every turn.
const RECALL_TRIGGER = /(?:(?:上面|前文|前面|刚才|剛才|刚说|剛才说|之前)(?:说|讲|講|聊|提|问|問|发|發))|(?:(?:翻|找|查|看|回溯|往前).{0,4}(?:记录|紀錄|历史|歷史|聊天|日志|日誌|画|畫))|(?:更早|早一点|早一點|久一点|久一點)/iu;

function envInt(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function historyWindowMs() {
  return envInt('DSK_DISCORD_HISTORY_MINUTES', 15, 1, 120) * 60_000;
}

function historyLimit() {
  return envInt('DSK_DISCORD_HISTORY_LIMIT', 12, 1, 40);
}

/**
 * Whether a prompt explicitly asks for older chat. Kept as a pure predicate so
 * the widening rule can be tested without a gateway or an archive.
 */
export function historyRecallRequested(text) {
  return typeof text === 'string' && RECALL_TRIGGER.test(text);
}

/**
 * Raw Discord markup hides who is who: `<@1562...>` is an id, `<@&id>` a role,
 * `<:emoji_1:1447...>` an emote. Replayed as-is the model sees "有人在说一个数字"
 * and mis-attributes the line, so markup becomes readable text first.
 */
export function stripHistoryMarkup(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(/<a?:[A-Za-z0-9_]+:\d+>/g, (match) => {
      const name = match.replace(/^<a?:/, '').replace(/:\d+>$/, '');
      return name ? `:${name}:` : '';
    })
    .replace(/<@!?\d+>/g, '@某人')
    .replace(/<@&\d+>/g, '@身份组')
    .replace(/@everyone|@here/g, '@全体')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Turn archived rows into replayable chat entries. `items` is newest-first;
 * the model reads oldest-first, and messages already replayed once are never
 * repeated so a busy channel does not stack the same lines every turn.
 */
export function historyEntriesFrom(items, {
  currentMessageId = '',
  seen = new Set(),
  limit = 15,
  maxChars = HISTORY_MAX_CHARS,
} = {}) {
  const entries = [];
  let used = 0;
  for (const item of [...(items ?? [])].reverse()) {
    if (!item?.messageId || item.messageId === currentMessageId) continue;
    if (seen.has(item.messageId)) continue;
    const text = stripHistoryMarkup(typeof item.text === 'string' ? item.text : '');
    const attachments = Number(item.fileCount) || 0;
    if (!text && attachments === 0) continue;
    if (/^正在处理/.test(text)) continue;
    const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const cost = clipped.length + 40;
    if (used + cost > maxChars) break;
    used += cost;
    entries.push({
      collector: 'recent-chat',
      eventId: item.messageId,
      name: item.senderName || item.senderId || '?',
      ts: Number(item.sentAt) || 0,
      text: clipped,
      attachments,
      imagePaths: Array.isArray(item.imagePaths) ? item.imagePaths : [],
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

/** Render replay entries as the block the bridge prepends to the prompt. */
export function renderHistoryBlock(entries, { currentName = '' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const clock = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const lines = entries.map((entry) => {
    const when = Number.isFinite(entry.ts) && entry.ts > 0 ? clock.format(new Date(entry.ts)) : '--:--';
    const body = entry.text || '（只发了附件）';
    const suffix = entry.attachments > 0 && entry.text ? '（带附件）' : '';
    return `${when} ${entry.name}：${body}${suffix}`;
  });
  const speaker = stripHistoryMarkup(String(currentName ?? '')).trim();
  return [
    '【最近群聊，仅供你了解上下文；不必逐条回应，也不代表都是对你说的】',
    ...lines,
    speaker
      ? `【以上都是背景。下面这条才是现在要回的，是 ${speaker} 说的】`
      : '【以上都是背景。下面这条才是现在要回的】',
  ].join('\n');
}

/**
 * Text plus the pictures those replayed messages carried.
 *
 * A replay that says "（带附件）" without the picture is how a group member's
 * screenshot silently disappears from the model's view; the newest images are
 * therefore attached as prompt parts, bounded so one replay cannot balloon.
 */
export function renderHistoryPayload(entries, { maxImages = 2, currentName = '' } = {}) {
  const text = renderHistoryBlock(entries, { currentName });
  if (!text || !Array.isArray(entries)) return { text, images: [] };
  const images = [];
  for (const entry of [...entries].reverse()) {
    for (const path of entry.imagePaths ?? []) {
      if (images.length >= maxImages) break;
      if (!images.includes(path)) images.push(path);
    }
    if (images.length >= maxImages) break;
  }
  return { text, images };
}

function isThreadChannel(channel) {  return THREAD_TYPES.has(Number(channel?.type));
}

function isThreadFromMessage(channel, message) {
  return isThreadChannel(channel)
    && String(channel?.id ?? '') === String(message?.id ?? '')
    && String(channel?.parent_id ?? '') === String(message?.channel_id ?? '');
}

function rememberChannel(channel, callback) {
  if (channel?.id) callback?.(channel);
  return channel;
}

function withConversationRoute(normalized, channel, botId, {
  fromSourceMessage = false,
  fallback = null,
  notice = null,
} = {}) {
  const channelId = String(channel?.id ?? normalized.conversationId);
  const thread = isThreadChannel(channel);
  const managed = thread && String(channel?.owner_id ?? '') === String(botId);
  const parentId = thread && channel?.parent_id ? String(channel.parent_id) : channelId;
  return {
    ...normalized,
    conversationId: channelId,
    addressed: normalized.addressed || managed,
    requiresMention: thread ? !managed : normalized.kind === 'group',
    replyTarget: {
      channelId,
      ...(!fromSourceMessage && normalized.replyTarget?.replyToMessageId
        ? { replyToMessageId: normalized.replyTarget.replyToMessageId }
        : {}),
      ...(notice ? { notice } : {}),
    },
    connectionTestTarget: { channelId },
    conversationRoute: {
      peerId: parentId,
      ...(thread ? { threadId: channelId, managed } : {}),
      ...(fallback ? { fallback } : {}),
    },
  };
}

function uncertainThreadCreate(error) {
  const status = Number(error?.status);
  return !Number.isInteger(status) || status >= 500;
}

function threadCreateUncertain(cause) {
  const error = new Error('Discord Thread creation result is uncertain', { cause });
  error.code = 'discord-thread-create-uncertain';
  return error;
}

async function findCreatedThread(api, message, { signal, onChannel } = {}) {
  try {
    const channel = rememberChannel(await api.getChannel({
      channelId: String(message.id),
      signal,
    }), onChannel);
    return isThreadFromMessage(channel, message) ? channel : null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function sendThreadUncertainNotice(api, normalized, signal) {
  try {
    await api.createMessage({
      channelId: normalized.replyTarget.channelId,
      replyToMessageId: normalized.replyTarget.replyToMessageId,
      content: t('Thread 创建结果暂时无法确认。若已创建，请在对应 Thread 中重试；若未创建，请稍后重新 @机器人。'),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
  }
}

function attachmentMediaType(attachment) {
  const value = typeof attachment?.content_type === 'string'
    ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : '';
  if (IMAGE_MEDIA_TYPES.has(value)) return value;
  const filename = typeof attachment?.filename === 'string' ? attachment.filename.toLowerCase() : '';
  for (const [extension, mediaType] of IMAGE_FILE_TYPES) {
    if (filename.endsWith(extension)) return mediaType;
  }
  return null;
}

function attachmentSize(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function discordImageSource(attachment, fetchImpl) {
  const mediaType = attachmentMediaType(attachment);
  if (!mediaType || typeof attachment?.url !== 'string') return null;
  return {
    name: typeof attachment.filename === 'string' ? attachment.filename : undefined,
    mediaType,
    size: attachmentSize(attachment.size),
    load: (options) => fetchImageBuffer(attachment.url, {
      ...options,
      fetchImpl,
      allowedHosts: DISCORD_IMAGE_HOSTS,
    }),
  };
}

function discordFileSource(attachment, fetchImpl) {
  if (attachmentMediaType(attachment) || typeof attachment?.url !== 'string' || !attachment.url) {
    return null;
  }
  const mediaType = typeof attachment.content_type === 'string' && attachment.content_type
    ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : undefined;
  return {
    name: typeof attachment.filename === 'string' && attachment.filename
      ? attachment.filename : String(attachment.id ?? 'discord-file'),
    ...(mediaType ? { mediaType } : {}),
    size: attachmentSize(attachment.size),
    load: ({ signal } = {}) => fetchFileStream(attachment.url, {
      fetchImpl,
      signal,
      allowedHosts: DISCORD_IMAGE_HOSTS,
    }),
  };
}

function discordReplyAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const mediaType = typeof attachment.content_type === 'string'
    ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : '';
  const kind = mediaType.startsWith('image/') ? 'image'
    : mediaType.startsWith('audio/') ? 'audio'
      : mediaType.startsWith('video/') ? 'video' : 'file';
  const name = typeof attachment.filename === 'string' && attachment.filename
    ? attachment.filename : undefined;
  return { kind, ...(name ? { name } : {}) };
}

function discordReplySnapshot(message, fallbackMessageId) {
  if (!message || typeof message !== 'object') return null;
  const messageId = typeof message.id === 'string' && message.id
    ? message.id : fallbackMessageId;
  const authorId = typeof message.author?.id === 'string' && message.author.id
    ? message.author.id : undefined;
  const authorName = [message.member?.nick, message.author?.global_name, message.author?.username]
    .find((value) => typeof value === 'string' && value.trim());
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(discordReplyAttachment).filter(Boolean)
    : [];
  if (Array.isArray(message.sticker_items)) {
    attachments.push(...message.sticker_items.map((sticker) => ({
      kind: 'image',
      ...(typeof sticker?.name === 'string' && sticker.name ? { name: sticker.name } : {}),
    })));
  }
  return {
    ...(messageId ? { messageId: String(messageId) } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    content: typeof message.content === 'string' ? message.content : '',
    attachments,
  };
}

function discordReplyReference(message, loadReply) {
  const channelId = String(message?.channel_id ?? '');
  const referenceId = typeof message?.message_reference?.message_id === 'string'
    && message.message_reference.message_id
    ? message.message_reference.message_id : undefined;
  const referenceChannelId = message?.message_reference?.channel_id;
  if (referenceChannelId !== undefined && String(referenceChannelId) !== channelId) {
    return {
      ...(referenceId ? { messageId: referenceId } : {}),
      unavailableReason: 'not-found',
    };
  }
  if (Object.hasOwn(message ?? {}, 'referenced_message')) {
    if (message.referenced_message === null) {
      return {
        ...(referenceId ? { messageId: referenceId } : {}),
        unavailableReason: 'deleted',
      };
    }
    if (message.referenced_message && typeof message.referenced_message === 'object') {
      const snapshotId = typeof message.referenced_message.id === 'string'
        && message.referenced_message.id ? message.referenced_message.id : undefined;
      if (String(message.referenced_message.channel_id ?? '') !== channelId
        || !snapshotId || (referenceId && snapshotId !== referenceId)) {
        return {
          ...(referenceId ? { messageId: referenceId } : {}),
          unavailableReason: 'not-found',
        };
      }
      return discordReplySnapshot(message.referenced_message, referenceId) ?? undefined;
    }
  }
  if (!referenceId) return undefined;
  if (typeof loadReply !== 'function') {
    return { messageId: referenceId, unavailableReason: 'not-delivered' };
  }
  return {
    messageId: referenceId,
    load: async ({ signal } = {}) => {
      const referenced = await loadReply({ channelId, messageId: referenceId, signal });
      if (!referenced || String(referenced.id ?? '') !== referenceId
        || String(referenced.channel_id ?? '') !== channelId) return null;
      return discordReplySnapshot(referenced, referenceId);
    },
  };
}

export function normalizeDiscordMessage(message, botId, {
  fetchImpl = fetch,
  loadReply,
} = {}) {
  if (!message?.id || !message?.channel_id || !message?.author?.id
    || Number(message.type) === 21) return null;
  const direct = !message.guild_id;
  const addressed = direct
    || message.mentions?.some((mention) => String(mention?.id) === String(botId));
  const replyTo = discordReplyReference(message, loadReply);
  return {
    messageId: String(message.id),
    senderId: String(message.author.id),
    contextSource: () => ({
      senderName: [message.member?.nick, message.author.global_name, message.author.username]
        .find((value) => typeof value === 'string' && value.trim()),
    }),
    senderIsBot: message.author.bot === true,
    kind: direct ? 'direct' : 'group',
    conversationId: String(message.channel_id),
    ...(message.guild_id ? { guildId: String(message.guild_id) } : {}),
    content: stripBotMention(message.content ?? '', botId),
    plainText: (!Array.isArray(message.attachments) || message.attachments.length === 0)
      && (!Array.isArray(message.sticker_items) || message.sticker_items.length === 0)
      && !message.poll,
    images: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => discordImageSource(attachment, fetchImpl)).filter(Boolean)
      : [],
    files: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => discordFileSource(attachment, fetchImpl)).filter(Boolean)
      : [],
    ...(replyTo ? { replyTo } : {}),
    addressed,
    replyTarget: {
      channelId: String(message.channel_id),
      replyToMessageId: String(message.id),
    },
    reactionTarget: {
      channelId: String(message.channel_id),
      messageId: String(message.id),
    },
    connectionTestTarget: { channelId: String(message.channel_id) },
  };
}

/**
 * 讨论串复用策略（从 dsh-im-discord-threads 整合进来）：
 * 上游每被 @ 一次就新开一个 Thread；这里改成先找同频道里仍然活跃的旧 Thread，
 * 优先按「先作者自己的、再机器人的」顺序复用，找不到才新开。
 *
 * DSK_DISCORD_THREAD_STRATEGY: author-then-bot | bot-then-author | newest | off
 * DSK_DISCORD_THREAD_MAX_AGE_HOURS: 复用窗口，默认 168（7 天），1–720
 */
const THREAD_STRATEGIES = new Set(['author-then-bot', 'bot-then-author', 'newest', 'off']);

function threadReuseStrategy() {
  if (process.env.DSK_DISCORD_THREAD_REUSE === '0') return 'off';
  const raw = String(process.env.DSK_DISCORD_THREAD_STRATEGY ?? '').trim().toLowerCase();
  return THREAD_STRATEGIES.has(raw) ? raw : 'author-then-bot';
}

function threadReuseMaxAgeMs() {
  const hours = Number(process.env.DSK_DISCORD_THREAD_MAX_AGE_HOURS);
  const bounded = Number.isFinite(hours) ? Math.min(720, Math.max(1, hours)) : 168;
  return bounded * 3_600_000;
}

function snowflakeTimeMs(id) {
  try {
    return Number((BigInt(String(id)) >> 22n) + 1_420_070_400_000n);
  } catch {
    return 0;
  }
}

function isReusableThread(thread, { channelId, strategy, owners, now, maxAgeMs }) {
  if (String(thread?.parent_id ?? '') !== String(channelId)) return false;
  if (!THREAD_TYPES.has(Number(thread?.type))) return false;
  if (thread?.thread_metadata?.archived || thread?.thread_metadata?.locked) return false;
  if (strategy !== 'newest' && !owners.includes(String(thread?.owner_id ?? ''))) return false;
  const lastActivity = snowflakeTimeMs(thread?.last_message_id ?? thread?.id);
  return lastActivity === 0 || now - lastActivity <= maxAgeMs;
}

export function pickReusableThread(threads, {
  channelId,
  authorId,
  botId,
  strategy,
  now = Date.now(),
  maxAgeMs = threadReuseMaxAgeMs(),
} = {}) {
  if (!Array.isArray(threads) || threads.length === 0 || strategy === 'off') return null;
  const author = String(authorId ?? '');
  const bot = String(botId ?? '');
  const owners = strategy === 'bot-then-author'
    ? [bot, author].filter(Boolean)
    : strategy === 'newest' ? [] : [author, bot].filter(Boolean);
  const candidates = threads.filter((thread) => isReusableThread(thread, {
    channelId, strategy, owners, now, maxAgeMs,
  }));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const leftRank = owners.indexOf(String(left?.owner_id ?? ''));
    const rightRank = owners.indexOf(String(right?.owner_id ?? ''));
    if (strategy !== 'newest' && leftRank !== rightRank) return leftRank - rightRank;
    return snowflakeTimeMs(right?.last_message_id ?? right?.id)
      - snowflakeTimeMs(left?.last_message_id ?? left?.id);
  });
  return candidates[0];
}

export async function resolveDiscordMessageRoute(message, botId, {
  api,
  channel,
  fetchImpl = fetch,
  signal,
  onChannel,
} = {}) {
  const normalized = normalizeDiscordMessage(message, botId, {
    fetchImpl,
    loadReply: typeof api?.getMessage === 'function'
      ? (options) => api.getMessage(options)
      : undefined,
  });
  if (!normalized || normalized.senderIsBot) return normalized;
  signal?.throwIfAborted();
  if (normalized.kind === 'direct') {
    return withConversationRoute(normalized, { id: normalized.conversationId, type: 1 }, botId);
  }
  if (!api || typeof api.getChannel !== 'function') {
    throw new TypeError('Discord route resolution requires the Discord API');
  }

  const sourceChannel = rememberChannel(channel ?? await api.getChannel({
    channelId: normalized.conversationId,
    signal,
  }), onChannel);
  if (isThreadChannel(sourceChannel)) {
    return withConversationRoute(normalized, sourceChannel, botId);
  }
  if (!normalized.addressed) return withConversationRoute(normalized, sourceChannel, botId);

  // dsh-discord 修正：默认**不再**新开子讨论串，就在被 @ 的地方回答
  //（频道里 @ 就回频道；讨论串里 @ 就回该讨论串）。
  // 想恢复原厂行为（频道 @ → 新开 Thread）时设 DSK_DISCORD_THREAD_ON_MENTION=1。
  if (isMusicCommand(normalized.content) || process.env.DSK_DISCORD_THREAD_ON_MENTION !== '1') {
    return withConversationRoute(normalized, sourceChannel, botId);
  }

  const sourceType = Number(sourceChannel?.type);
  if (sourceType !== GUILD_TEXT && sourceType !== GUILD_ANNOUNCEMENT) {
    return withConversationRoute(normalized, sourceChannel, botId, {
      fallback: 'unsupported-channel',
      notice: '当前频道不支持自动创建 Thread，已直接在当前频道回复。',
    });
  }

  const strategy = threadReuseStrategy();
  if (strategy !== 'off' && typeof api.listActiveThreads === 'function') {
    try {
      const active = await api.listActiveThreads({
        channelId: normalized.conversationId,
        signal,
      });
      const reused = pickReusableThread(active?.threads, {
        channelId: normalized.conversationId,
        authorId: message?.author?.id,
        botId,
        strategy,
      });
      if (reused) {
        return withConversationRoute(normalized, rememberChannel(reused, onChannel), botId);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // 列表拿不到就退回新开 Thread，不让复用逻辑挡住正常提问。
    }
  }

  signal?.throwIfAborted();
  let created;
  try {
    created = rememberChannel(await api.startThreadFromMessage({
      channelId: normalized.conversationId,
      messageId: normalized.messageId,
      name: cleanThreadName(message, botId),
      signal,
    }), onChannel);
    if (!isThreadFromMessage(created, message)) {
      throw new Error('Discord returned an invalid thread for the source message');
    }
  } catch (error) {
    let recovered;
    try {
      recovered = await findCreatedThread(api, message, {
        signal: AbortSignal.timeout(THREAD_RECOVERY_TIMEOUT_MS),
        onChannel,
      });
    } catch (recoveryError) {
      if (signal?.aborted) throw signal.reason ?? error;
      await sendThreadUncertainNotice(api, normalized, signal);
      throw threadCreateUncertain(recoveryError);
    }
    if (recovered) {
      return withConversationRoute(normalized, recovered, botId, { fromSourceMessage: true });
    }
    if (signal?.aborted) throw signal.reason ?? error;
    if (uncertainThreadCreate(error)) {
      await sendThreadUncertainNotice(api, normalized, signal);
      throw threadCreateUncertain(error);
    }
    return withConversationRoute(normalized, sourceChannel, botId, {
      fallback: 'thread-create-failed',
      notice: '无法创建 Thread，已直接在当前频道回复。',
    });
  }
  return withConversationRoute(normalized, created, botId, { fromSourceMessage: true });
}

export class DiscordBotClient {
  #api;
  #signal;
  #deliveredNotices = new WeakSet();

  constructor({ api, signal }) {
    this.#api = api;
    this.#signal = signal;
  }

  sendText(target, text) {
    return this.#sendText(target, text, false);
  }

  sendDelivery(target, value) {
    const block = createTextDeliveryBlock(value);
    return this.#sendText(target, block.text, block.format === 'markdown');
  }

  async #sendText(target, text, markdown) {
    // Archive bookkeeping must never be visible in the chat; see the helper.
    const clean = stripInternalLeaks(text);
    if (!clean) return { providerMessageIds: [] };
    const notice = !this.#deliveredNotices.has(target) && target?.notice
      ? String(target.notice) : null;
    const chunks = (markdown ? chunkMarkdownText : splitMessageText)(notice ? `${notice}\n\n${clean}` : clean, 1_900);
    const providerMessageIds = [];
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.#api.createMessage({
        channelId: target.channelId,
        content: chunk,
        replyToMessageId: index === 0 ? target.replyToMessageId : undefined,
        signal: this.#signal,
      });
      if (notice && index === 0) this.#deliveredNotices.add(target);
      if (typeof result?.id === 'string' && result.id) providerMessageIds.push(result.id);
    }
    return { providerMessageIds };
  }

  sendTyping(target) {
    return this.#api.sendTyping({ channelId: target.channelId, signal: this.#signal });
  }

  sendFile(target, file) {
    return this.#api.createFileMessage({
      channelId: target.channelId,
      file,
      replyToMessageId: target.replyToMessageId,
      signal: this.#signal,
    });
  }

  addReaction(target, emoji, { signal } = {}) {
    return this.#api.addOwnReaction({
      channelId: target.channelId,
      messageId: target.messageId,
      emoji,
      signal: this.#operationSignal(signal),
    });
  }

  removeReaction(target, reactionKey, { signal } = {}) {
    return this.#api.removeOwnReaction({
      channelId: target.channelId,
      messageId: target.messageId,
      emoji: reactionKey,
      signal: this.#operationSignal(signal),
    });
  }

  async openStream(target) {
    const notice = !this.#deliveredNotices.has(target) && target?.notice
      ? String(target.notice) : null;
    const decorate = (content) => notice ? `${notice}\n\n${content}` : content;
    const stream = createEditableMessageStream({
      limit: notice ? 1_800 : 1_900,
      create: async (content) => {
        const message = await this.#api.createMessage({
          channelId: target.channelId,
          content: decorate(content),
          replyToMessageId: target.replyToMessageId,
          signal: this.#signal,
        });
        if (notice) this.#deliveredNotices.add(target);
        return message.id;
      },
      edit: (messageId, content) => this.#api.editMessage({
        channelId: target.channelId,
        messageId,
        content: decorate(content),
        signal: this.#signal,
      }),
      sendRemainder: (content) => this.#api.createMessage({
        channelId: target.channelId,
        content,
        signal: this.#signal,
      }),
      messageIdForResult: (message) => message?.id,
    });
    return stream.start();
  }

  #operationSignal(signal) {
    return signal ?? this.#signal;
  }
}

export function createDiscordRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    connectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createDiscordBridgeStatus(),
  };
}

export class DiscordRuntime {
  #config;
  #token;
  #harness;
  #state;
  #contextEnhancement;
  #groupHistory;
  // Group messages that were never addressed to the bot are invisible to the
  // harness; this window replays them as context on the next addressed turn.
  #historySeen = new Map();
  // Replay blocks are arrays; the requester's name rides alongside them so the
  // rendered block can say whose message is the one being answered instead of
  // leaving the last background line looking like the current speaker.
  #historyMeta = new WeakMap();
  #accessPolicy;
  #logger;
  #diagnostics;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #createApi;
  #createWebSocket;
  #createMusicManager;
  #random;
  #status = createDiscordRuntimeStatus();
  #api = null;
  #bridge = null;
  #music = null;
  // Music commands answer on their own lane; the turn scheduler never sees
  // them, so without a note they are invisible in the session and a burst of
  // @chat buries what the player was told. Notes replay like chat lines.
  #musicNotes = new Map();
  #interactions = new Set();
  #abortController = null;
  #socket = null;
  #gatewayUrl = null;
  #applicationId = null;
  #globalCommandsSynced = false;
  #guildCommandsSynced = new Set();
  #resumeUrl = null;
  #sessionId = null;
  #sequence = null;
  #heartbeatTimer = null;
  #heartbeatAcked = true;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #generation = 0;
  #stopped = true;
  #starting = null;
  #channels = new Map();
  #routing = new Map();
  #messageAdmissions = new Map();

  constructor({
    config,
    token,
    harness,
    state,
    contextEnhancement,
    groupHistory,
    accessPolicy,
    logger = console,
    replyTimeoutMs = 600_000,
    connectTimeoutMs = 20_000,
    createApi = (options) => new DiscordApi(options),
    createWebSocket = (url) => new WebSocket(url),
    createMusicManager = (options) => new MusicManager(options),
    random = Math.random,
  }) {
    if (!config || !token || !harness || !state) {
      throw new TypeError('DiscordRuntime requires config, token, Harness, and state');
    }
    if (typeof createWebSocket !== 'function') throw new TypeError('DiscordRuntime requires WebSocket');
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#groupHistory = groupHistory;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger; this.#diagnostics = createConnectionDiagnostics({ channel: 'discord', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#createApi = createApi;
    this.#createWebSocket = createWebSocket;
    this.#createMusicManager = createMusicManager;
    this.#random = random;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#bridge) {
      const error = new Error('Discord bot is not connected');
      error.code = 'test-target-unavailable';
      throw error;
    }
    return this.#bridge.sendConnectionTest(text);
  }

  async presentSessionSyncApproval(target, interaction, options = {}) {
    if (!this.#status.ready || !this.#bridge) return false;
    const channelId = target?.route?.channelId;
    const channel = await this.#api.getChannel({ channelId, signal: options.signal });
    const actor = channel?.type === 1 && channel.recipients?.length === 1
      ? channel.recipients[0]?.id : '';
    if (!actor) return false;
    return this.#bridge.presentSessionSyncApproval(interaction, {
      key: options.key, actor, validate: options.validate,
      send: (text) => this.sendProactiveText(target, text),
    }, options);
  }

  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#bridge) {
      const error = new Error('Discord bot is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    const channelId = typeof target?.route?.channelId === 'string'
      ? target.route.channelId.trim() : '';
    if (target?.kind !== 'channel' || !channelId) {
      const error = new TypeError('Invalid Discord proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    return this.#bridge.sendProactiveText({ channelId }, text, options);
  }

  // `/digest [小时]`: read this channel's own archive, with no session binding.
  async #ownerDigest({ conversationId, hours } = {}) {
    const store = this.#groupHistory;
    if (!store || typeof store.recentMessages !== 'function' || !conversationId) return null;
    const groupId = await store.findGroupId(conversationId, { channel: 'discord' });
    if (!groupId) return null;
    const digest = normalizeDigestConfig({ defaultHours: 24 });
    return digestForContext({ store, groupId }, {
      hours: Number.isFinite(hours) ? hours : digest.defaultHours,
    }, digest);
  }

  // `/thread [标题]`: a standalone public thread under the current channel.
  async #ownerThread({ conversationId, name } = {}) {
    if (!this.#api || !conversationId) return null;
    const title = String(name ?? '').trim() || '新讨论串';
    const created = await this.#api.createThread({
      channelId: conversationId,
      name: [...title].slice(0, 100).join(''),
    });
    return created?.id ? { id: String(created.id) } : null;
  }

  // Recent-history context for group turns. A channel conversation is shared
  // by everyone, but only addressed messages reach the harness, so replays the
  // chat between bot turns stand in for what the model cannot see. Off with
  // DSK_DISCORD_HISTORY_CONTEXT=0; window/limit are tunable per host.
  #createContextHooks() {
    if (process.env.DSK_DISCORD_HISTORY_CONTEXT === '0') return null;
    return {
      enabled: () => true,
      collect: ({ message, conversationKey }) => this.#collectHistory(message, conversationKey),
      render: (entries) => this.#renderHistory(entries),
      onConsumed: ({ conversationKey, entries }) => this.#rememberHistory(conversationKey, entries),
    };
  }

  #noteMusic(args, verb, result) {
    const channelId = String(args?.channelId ?? args?.conversationId ?? '');
    if (!channelId) return;
    const message = String(result?.message ?? '').trim();
    const text = stripHistoryMarkup(message || `${verb} 已执行`);
    const notes = this.#musicNotes.get(channelId) ?? [];
    notes.push({
      id: `music:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
    });
    while (notes.length > 20) notes.shift();
    this.#musicNotes.set(channelId, notes);
  }

  #musicTools(music, signal) {
    return { execute: async (verb, args) => {
      signal.throwIfAborted();
      // Capture this generation's manager; an old callback cannot use a new one.
      const result = await music.execute(verb, { ...args, signal });
      if (!signal.aborted) this.#noteMusic(args, `/music ${verb === 'next' ? 'skip' : verb}`, result);
      return result;
    } };
  }

  async #collectHistory(message, conversationKey) {
    const store = this.#groupHistory;
    if (!store || message?.kind !== 'group') return [];
    const channelId = String(message.conversationId ?? '');
    if (!channelId) return [];
    const groupId = await store.findGroupId(channelId);
    if (!groupId) return [];
    const grantHours = takeRecallGrant(channelId);
    const recalled = grantHours > 0 || historyRecallRequested(message.content);
    const limit = recalled ? RECALL_LIMIT : historyLimit();
    const windowMs = recalled
      ? Math.max(grantHours, grantHours > 0 ? 0 : RECALL_DEFAULT_HOURS) * 3_600_000
      : historyWindowMs();
    const seen = this.#historySeen.get(conversationKey) ?? new Set();
    const { items } = await store.recentMessages(groupId, {
      since: Date.now() - windowMs,
      limit: limit + 8,
    });
    const entries = historyEntriesFrom(items, {
      currentMessageId: message.messageId,
      seen,
      limit,
      maxChars: recalled ? RECALL_MAX_CHARS : HISTORY_MAX_CHARS,
    });
    // Music replies never pass through the turn scheduler, so a burst of @chat
    // used to bury them: replay them from the note lane as their own lines.
    const notes = (this.#musicNotes.get(channelId) ?? [])
      .filter((note) => !seen.has(note.id))
      .map((note) => ({
        collector: 'music',
        eventId: note.id,
        name: '音乐',
        ts: note.ts,
        text: note.text,
        attachments: 0,
        imagePaths: [],
      }));
    const merged = notes.length > 0
      ? [...entries, ...notes].sort((left, right) => left.ts - right.ts)
      : entries;
    // The widening is the risky part, so every recall leaves a trace and a
    // hard-cap note when the archive had more to give than the budget allowed.
    this.#logger?.info?.('[dsh-im:discord] recent chat recalled', {
      recalled,
      hours: Math.round(windowMs / 3_600_000),
      limit,
      entries: merged.length,
      music: notes.length,
      chars: merged.reduce((sum, entry) => sum + String(entry.text ?? '').length + 40, 0),
      capped: merged.length >= limit,
    });
    if (merged.length > 0) {
      this.#historyMeta.set(merged, { currentName: String(message?.senderName ?? '') });
    }
    return merged;
  }

  #renderHistory(entries) {
    if (Array.isArray(entries) && entries.length === 0) {
      // Nothing landed inside the window. Say so, and point at the one-step
      // wider look-back, instead of letting the model answer from an empty
      // context as if the chat had been silent.
      const minutes = envInt('DSK_DISCORD_HISTORY_MINUTES', 15, 1, 120);
      return {
        text: t('（最近 {minutes} 分钟群里没有新消息；要翻更早的记录，请主人发送 /recall 批准）', {
          minutes: String(minutes),
        }),
        images: [],
      };
    }
    return renderHistoryPayload(entries, {
      currentName: this.#historyMeta.get(entries)?.currentName ?? '',
    });
  }

  #rememberHistory(conversationKey, entries) {
    const seen = this.#historySeen.get(conversationKey) ?? new Set();
    for (const entry of entries ?? []) {
      if (typeof entry?.eventId === 'string' && entry.eventId) seen.add(entry.eventId);
    }
    while (seen.size > 400) seen.delete(seen.values().next().value);
    this.#historySeen.set(conversationKey, seen);
  }

  async start() {
    if (this.#status.ready && this.#socket) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    this.#stopped = false;
    this.#sessionId = null;
    this.#resumeUrl = null;
    this.#sequence = null;
    this.#reconnectAttempt = 0;
    this.#channels.clear();
    this.#routing.clear();
    this.#globalCommandsSynced = false;
    this.#guildCommandsSynced.clear();
    this.#status.startedAt = new Date().toISOString();
    this.#status.connectionState = 'connecting';
    this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
    await atConnectionStage('harness.check', () => this.#harness.ensureRunning());
    this.#status.harnessReachable = true;
    const controller = new AbortController();
    this.#abortController = controller;
    const api = this.#createApi({ token: this.#token });
    this.#api = api;
    try {
      const [bot, gateway, application] = await Promise.all([
        api.getCurrentUser({ signal: controller.signal }),
        api.getGatewayBot({ signal: controller.signal }),
        api.getCurrentApplication({ signal: controller.signal }),
      ]);
      if (String(bot?.id ?? '') !== this.#config.platformId || bot?.bot !== true) {
        throw new Error('Discord token identity does not match the saved bot');
      }
      this.#applicationId = String(application?.id ?? '').trim() || null;
      this.#gatewayUrl = gateway?.url;
      if (process.env.DSK_DISCORD_MUSIC !== '0') {
        this.#music = this.#createMusicManager({
          token: this.#token,
          harness: this.#harness,
          notify: (channelId, content) => api.createMessage({ channelId, content }),
          logger: (level, event, detail) => {
            const write = level === 'warn' ? this.#logger.warn
              : level === 'debug' ? this.#logger.debug
                : this.#logger.info;
            write?.(`[dsh-im:discord] music ${event}`, detail);
          },
        });
      }
      const client = new DiscordBotClient({ api, signal: controller.signal });
      this.#bridge = new DiscordHarnessBridge({
        bot: client,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        // Owner-only slash commands: the bridge never builds channel API calls
        // itself, so the adapter hands it the two read/create helpers it owns.
        ownerTools: {
          digest: (args) => this.#ownerDigest(args),
          thread: (args) => this.#ownerThread(args),
        },
        // Music commands work on the voice connection, which lives in the
        // runtime's own voice client rather than in the bridge.
        musicTools: this.#music ? this.#musicTools(this.#music, controller.signal) : null,
        ownerUserId: this.#config.ownerUserId,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        // Ordinary Discord turns retain receipt order, without merging or steering.
        chatOrder: 'fifo',
        // Recent-history context: a channel conversation is not the bot's own
        // turn log, so messages the bot never saw arrive here as a rendered
        // <dsh_im_recent_chat> block ahead of the prompt.
        contextHooks: this.#createContextHooks(),
        signal: controller.signal,
      });
      let timer;
      try {
        await Promise.race([
          this.#openSocket(false),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Discord Gateway did not become ready in time'), { code: 'ETIMEDOUT', timeoutMs: this.#connectTimeoutMs })), this.#connectTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.connectionState = 'failed';
      this.#status.error = this.#diagnostics.report(error, { operation: 'connection.restore', reuse: true, botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;
      await this.stop();
      throw error;
    }
  }

  #openSocket(resume) {
    if (this.#stopped) return Promise.reject(new Error('Discord runtime is stopped'));
    const generation = ++this.#generation;
    const url = socketUrl(resume && this.#resumeUrl ? this.#resumeUrl : this.#gatewayUrl);
    const socket = this.#createWebSocket(url);
    this.#socket = socket;
    let settled = false;
    return new Promise((resolve, reject) => {
      const markReady = () => {
        if (settled || generation !== this.#generation) return;
        settled = true;
        this.#reconnectAttempt = 0;
        const now = Date.now();
        this.#status.ready = true;
        this.#status.connectionState = 'connected';
        this.#status.lastCheckedAt = now;
        this.#status.lastConnectedAt = now;
        this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
        resolve();
        // Fire-and-forget: the picker list is cosmetic for this session's
        // connection and must never delay or fail it.
        void this.#syncApplicationCommands();
      };
      addSocketListener(socket, 'message', (event) => {
        if (generation !== this.#generation || this.#stopped) return;
        const raw = eventData(event);
        if (!raw) return;
        let packet;
        try {
          packet = JSON.parse(raw);
        } catch {
          this.#logger.warn?.('[dsh-im:discord] ignored malformed Gateway JSON');
          return;
        }
        if (Number.isSafeInteger(packet.s)) this.#sequence = packet.s;
        if (packet.op === 10) {
          this.#startHeartbeat(packet.d?.heartbeat_interval, socket, generation);
          if (resume && this.#sessionId) {
            this.#sendGateway(socket, {
              op: 6,
              d: { token: this.#token, session_id: this.#sessionId, seq: this.#sequence },
            });
          } else {
            this.#sendGateway(socket, {
              op: 2,
              d: {
                token: this.#token,
                intents: DISCORD_GATEWAY_INTENTS,
                properties: {
                  os: process.platform,
                  browser: 'dsh-im',
                  device: 'dsh-im',
                },
              },
            });
          }
          return;
        }
        if (packet.op === 11) {
          this.#heartbeatAcked = true;
          this.#status.lastCheckedAt = Date.now();
          return;
        }
        if (packet.op === 1) {
          this.#heartbeat(socket);
          return;
        }
        if (packet.op === 7) {
          socket.close(4000, 'Reconnect requested');
          return;
        }
        if (packet.op === 9) {
          if (packet.d !== true) {
            this.#sessionId = null;
            this.#resumeUrl = null;
            this.#sequence = null;
          }
          socket.close(4000, 'Invalid session');
          return;
        }
        if (packet.op !== 0) return;
        if (packet.t === 'READY') {
          this.#sessionId = packet.d?.session_id ?? null;
          this.#resumeUrl = packet.d?.resume_gateway_url ?? null;
          markReady();
        } else if (packet.t === 'RESUMED') {
          markReady();
        } else if (packet.t === 'GUILD_CREATE') {
          for (const channel of [...(packet.d?.channels ?? []), ...(packet.d?.threads ?? [])]) {
            this.#rememberChannel(channel);
          }
          if (packet.d?.id) void this.#syncGuildApplicationCommands(packet.d.id);
        } else if (packet.t === 'INTERACTION_CREATE') {
          void this.#acceptInteraction(packet.d).catch((error) => {
            if (generation !== this.#generation || this.#stopped) return;
            this.#logger.error?.(
              `[dsh-im:discord] bot ${this.#config.botId} interaction handling failed:`,
              extractConnectionEvidence(error).details,
            );
          });
        } else if (packet.t === 'CHANNEL_CREATE' || packet.t === 'CHANNEL_UPDATE'
          || packet.t === 'THREAD_CREATE' || packet.t === 'THREAD_UPDATE') {
          this.#rememberChannel(packet.d);
        } else if (packet.t === 'CHANNEL_DELETE' || packet.t === 'THREAD_DELETE') {
          if (packet.d?.id) this.#channels.delete(String(packet.d.id));
        } else if (packet.t === 'THREAD_LIST_SYNC') {
          for (const channel of packet.d?.threads ?? []) this.#rememberChannel(channel);
        } else if (packet.t === 'MESSAGE_CREATE') {
          const bridge = this.#bridge;
          if (packet.d && bridge) {
            void this.#acceptMessage(packet.d, bridge).catch((error) => {
              if (generation !== this.#generation || this.#stopped) return;
              this.#logger.error?.(
                `[dsh-im:discord] bot ${this.#config.botId} message handling failed:`,
                extractConnectionEvidence(error).details,
              );
            });
          }
        }
      });
      addSocketListener(socket, 'close', (event = {}) => {
        if (generation !== this.#generation) return;
        this.#clearHeartbeat();
        if (this.#socket === socket) this.#socket = null;
        if (this.#stopped) {
          if (!settled) reject(new DOMException('Stopped', 'AbortError'));
          return;
        }
        const error = gatewayCloseError(Number(event.code) || 0);
        this.#status.ready = false;
        this.#status.connectionState = 'connecting';
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
        this.#status.lastError = this.#status.error.message;
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (error.code === 'discord-401' || error.code === 'discord-intents') {
          this.#status.connectionState = 'failed';
          return;
        }
        this.#scheduleReconnect();
      });
      addSocketListener(socket, 'error', (event) => {
        const error = event?.error ?? new Error('WebSocket error');
        if (generation !== this.#generation || this.#stopped) return;
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
        this.#status.lastError = this.#status.error.message;
      });
    });
  }

  async #acceptInteraction(interaction) {
    const api = this.#api;
    const bridge = this.#bridge;
    if (!api || !bridge || this.#stopped) return;
    const interactionId = String(interaction?.id ?? '');
    if (!interactionId || this.#interactions.has(interactionId)) return;
    this.#interactions.add(interactionId);
    while (this.#interactions.size > 2048) this.#interactions.delete(this.#interactions.values().next().value);
    if (!this.#applicationId) {
      this.#logger.error?.('[dsh-im:discord] ignoring an interaction: application id unknown');
      return;
    }
    const handled = await handleApplicationCommand(interaction, {
      api,
      bridge,
      accessPolicy: this.#accessPolicy,
      applicationId: this.#applicationId,
      logger: this.#logger,
    });
    if (handled) {
      this.#logger.event?.('interaction.handled', {
        interactionId: String(interaction?.id ?? ''),
        command: String(interaction?.data?.name ?? ''),
      });
    }
  }

  /**
   * Duplicate guard. An earlier build registered the same command set both
   * globally and per guild, and Discord then shows every command twice in the
   * picker. Guild registration is the one kept (instant, no cache), so the
   * global scope is cleared instead of filled.
   */
  async #syncApplicationCommands() {
    if (this.#globalCommandsSynced || !this.#api || !this.#applicationId || this.#stopped) return;
    this.#globalCommandsSynced = true;
    try {
      await syncApplicationCommands(this.#api, {
        applicationId: this.#applicationId,
        commands: [],
      });
      this.#logger.event?.('commands.global-cleared', {
        applicationId: this.#applicationId,
      });
    } catch (error) {
      // Retry on the next READY instead of leaving the duplicates in place.
      this.#globalCommandsSynced = false;
      this.#logger.error?.('[dsh-im:discord] global slash command cleanup failed:', {
        message: error?.message ?? String(error),
        status: error?.status ?? null,
      });
    }
  }

  /** Guild registration: appears in the picker immediately, unlike global. */
  async #syncGuildApplicationCommands(guildId) {
    const id = String(guildId ?? '').trim();
    if (!id || this.#guildCommandsSynced.has(id) || !this.#api || !this.#applicationId
      || this.#stopped) return;
    this.#guildCommandsSynced.add(id);
    try {
      await syncApplicationCommands(this.#api, {
        applicationId: this.#applicationId,
        guildId: id,
      });
      this.#logger.event?.('commands.synced', { scope: 'guild', guildId: id });
    } catch (error) {
      this.#guildCommandsSynced.delete(id);
      this.#logger.error?.('[dsh-im:discord] guild slash command registration failed:', {
        guildId: id,
        message: error?.message ?? String(error),
        status: error?.status ?? null,
      });
    }
  }

  #rememberChannel(channel) {
    if (!channel?.id) return;
    this.#channels.set(String(channel.id), channel);
  }

  #acceptMessage(message, bridge) {
    if (this.#stopped || this.#bridge !== bridge) return Promise.resolve();
    const normalized = normalizeDiscordMessage(message, this.#config.platformId);
    // Music owns its own per-guild lane and cannot wait behind chat history/routing.
    if (isMusicCommand(normalized?.content) || isControlCommand(normalized?.content) || isOwnerCommand(normalized?.content)) {
      return this.#routeMessage(message, bridge).then(result => result?.completion);
    }
    const key = String(message?.channel_id ?? '');
    const previous = this.#messageAdmissions.get(key) ?? Promise.resolve();
    // Hold only admission, never the model's completion, so other commands and
    // other conversations stay responsive during a long reply.
    const admission = previous.catch(() => {}).then(() => this.#routeMessage(message, bridge));
    const tail = admission.then(() => {}, () => {});
    this.#messageAdmissions.set(key, tail);
    void tail.then(() => { if (this.#messageAdmissions.get(key) === tail) this.#messageAdmissions.delete(key); });
    return admission.then(result => result?.completion);
  }

  async #routeMessage(message, bridge) {
    if (this.#stopped || this.#bridge !== bridge) return;
    const signal = this.#abortController?.signal;
    const messageId = String(message?.id ?? '');
    if (!messageId || this.#state.hasSeen(messageId)) {
      if (messageId) this.#logger.event?.('message.ignored', { messageId, reason: 'already-seen' });
      return;
    }
    const preflight = normalizeDiscordMessage(message, this.#config.platformId);
    this.#logger.event?.('message.received', {
      messageId,
      channelId: String(message.channel_id ?? ''),
      guildId: message.guild_id ? String(message.guild_id) : null,
      authorId: String(message.author?.id ?? ''),
      authorIsBot: message.author?.bot === true,
      kind: preflight?.kind ?? null,
      addressed: preflight?.addressed === true,
      textLength: typeof message.content === 'string' ? message.content.length : 0,
      images: preflight?.images?.length ?? 0,
      files: preflight?.files?.length ?? 0,
    });
    if (preflight?.addressed === true && preflight.senderIsBot !== true && isMusicCommand(preflight.content)) {
      // Explicit music needs no chat history or thread routing. Reserve it now;
      // archival I/O is independent and cannot revive a play after a later stop.
      const completion = bridge.accept(preflight, { busyMessageMode: 'queue' });
      void captureGroupHistory(this.#groupHistory, preflight, groupHistoryEntry('discord', message, preflight, {
        groupName: this.#channels.get(String(message.channel_id))?.name,
      }), { logger: this.#logger }).catch(() => {});
      return { completion };
    }
    if (preflight) await captureGroupHistory(this.#groupHistory, preflight, groupHistoryEntry('discord', message, preflight, {
      groupName: this.#channels.get(String(message.channel_id))?.name,
    }), { logger: this.#logger });
    signal?.throwIfAborted();
    let accessDecision;
    if (preflight?.kind === 'group' && preflight.addressed === true
      && preflight.senderIsBot !== true) {
      accessDecision = evaluateInboundAccess(this.#accessPolicy, {
        conversationType: 'group',
        senderIds: [preflight.senderId],
        text: preflight.content,
        hasImages: preflight.images.length > 0,
        hasFiles: preflight.files.length > 0,
      });
      this.#logger.event?.('access.decided', {
        messageId,
        allowed: accessDecision.allowed === true,
        reason: accessDecision.reason ?? null,
        canExecuteCommands: accessDecision.canExecuteCommands === true,
      });
      if (!accessDecision.allowed && !isMusicCommand(preflight.content)) {
        // Let the shared bridge apply its normal silent/command-denial behavior,
        // but do so against the source channel before creating a Thread.
        return { completion: bridge.accept(preflight, { accessDecision }) };
      }
    }
    let route = this.#routing.get(messageId);
    if (!route) {
      const contextSnapshot = captureContextEnhancement(
        this.#contextEnhancement,
        message.guild_id ? 'group' : 'direct',
      );
      const busyMessageMode = 'queue';
      const pendingRoute = resolveDiscordMessageRoute(message, this.#config.platformId, {
        api: this.#api,
        channel: this.#channels.get(String(message.channel_id)),
        signal,
        onChannel: (resolved) => this.#rememberChannel(resolved),
      });
      route = { pendingRoute, contextSnapshot, busyMessageMode };
      this.#routing.set(messageId, route);
      void pendingRoute.finally(() => {
        if (this.#routing.get(messageId) === route) this.#routing.delete(messageId);
      }).catch(() => undefined);
    }
    try {
      const normalized = await route.pendingRoute;
      signal?.throwIfAborted();
      this.#logger.event?.('route.resolved', {
        messageId,
        dropped: normalized == null,
        replyChannelId: normalized?.conversationId ? String(normalized.conversationId) : null,
        addressed: normalized?.addressed === true,
      });
      if (normalized) {
        normalized.groupHistory = preflight?.groupHistory;
        const completion = bridge.accept(normalized, {
          contextSnapshot: route.contextSnapshot,
          busyMessageMode: route.busyMessageMode,
          ...(accessDecision ? { accessDecision } : {}),
        });
        const observed = completion.then(() => this.#logger.event?.('message.accepted', {
          messageId,
          replyChannelId: normalized?.conversationId ? String(normalized.conversationId) : null,
          busyMessageMode: route.busyMessageMode,
        }));
        return { completion: observed };
      }
    } catch (error) {
      this.#logger.event?.('message.failed', {
        messageId,
        channelId: String(message.channel_id ?? ''),
        code: error?.code ?? null,
        message: String(error?.message ?? error),
      });
      if (error?.code === 'discord-thread-create-uncertain') {
        await this.#state.markSeen(messageId);
      }
      throw error;
    }
  }

  #sendGateway(socket, payload) {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  }

  #startHeartbeat(interval, socket, generation) {
    this.#clearHeartbeat();
    if (!Number.isFinite(interval) || interval < 1_000) {
      socket.close(4000, 'Invalid heartbeat interval');
      return;
    }
    this.#heartbeatAcked = true;
    const schedule = (delay) => {
      this.#heartbeatTimer = setTimeout(() => {
        if (this.#stopped || generation !== this.#generation || this.#socket !== socket) return;
        if (!this.#heartbeatAcked) {
          socket.close(4000, 'Heartbeat was not acknowledged');
          return;
        }
        this.#heartbeat(socket);
        schedule(interval);
      }, delay);
      this.#heartbeatTimer?.unref?.();
    };
    schedule(Math.floor(interval * this.#random()));
  }

  #heartbeat(socket) {
    this.#heartbeatAcked = false;
    this.#sendGateway(socket, { op: 1, d: this.#sequence });
  }

  #clearHeartbeat() {
    if (this.#heartbeatTimer !== null) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#heartbeatAcked = true;
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#openSocket(Boolean(this.#sessionId)).catch((error) => {
        if (this.#stopped) return;
        this.#logger.warn?.('[dsh-im:discord] Gateway reconnect failed:', extractConnectionEvidence(error).details);
        this.#scheduleReconnect();
      });
    }, delay);
    this.#reconnectTimer?.unref?.();
  }

  async stop() {
    this.#stopped = true;
    this.#generation += 1;
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#clearHeartbeat();
    const socket = this.#socket;
    const bridge = this.#bridge;
    const music = this.#music;
    this.#socket = null;
    this.#bridge = null;
    this.#music = null;
    this.#api = null;
    void music?.destroy().catch(error => this.#logger.warn?.('[dsh-im:discord] music shutdown failed:', error?.name ?? 'Error'));
    this.#interactions.clear(); this.#musicNotes.clear();
    this.#routing.clear();
    this.#messageAdmissions.clear();
    try {
      if (socket && socket.readyState < 2) socket.close(1000, 'Plugin stopped');
    } catch (error) {
      this.#logger.warn?.(`[dsh-im:discord] bot ${this.#config.botId} failed to close Gateway:`, extractConnectionEvidence(error).details);
    }
    await Promise.race([
      bridge?.waitForIdle() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.#status.ready = false;
    this.#status.connectionState = 'idle';
    return this.status;
  }
}

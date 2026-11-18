/**
 * Recent messages the bot itself posted into one conversation.
 *
 * A share delivered through the channel's own send path reaches the platform
 * and is archived by the group-history store, but it never enters the Session
 * transcript: the catch-up reader drops bot-authored messages, so the model
 * cannot answer "what did you post earlier" from its own conversation. This
 * provider reads the archive for the bot's own recent messages and renders one
 * bounded block, which `installInjectedContext` prepends to the turn that asks.
 *
 * The block is a notice, never user speech: it is stamped with a plugin source
 * kind and a dedicated form, so the IM input path ignores it and a later step
 * can tell it was already injected.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConversationKey } from '../../src/channels/discord/catchup.mjs';
import { sessionConversationOf } from '../../src/channels/shared/session-channel-registry.mjs';

/** How far back a message still counts as "recent". */
const WINDOW_MS = 24 * 3600 * 1000;

/** Most rows one block lists. */
const MAX_ITEMS = 6;

/** Character budget for the rendered list. */
const MAX_CHARS = 1200;

/** Per-row text budget. */
const MAX_ITEM_CHARS = 140;

/** Rows the channel posts while a turn is still running. */
const PLACEHOLDER = /^(?:正在处理|正在處理|正在处理…|正在處理…|正在处理\.\.\.|正在處理\.\.\.)$/u;

/** Rows that report a failed action rather than something worth recalling. */
const NOISE = /^(?:無法播放|无法播放|播放失敗|播放失败|無法載入|无法载入)/u;

/** Render one epoch instant as `HH:mm` in local time. */
function clock(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Read the bot platform ids once; a missing config simply disables the block.
 *
 * The archive stores the platform sender id, so the bot's own rows are the ones
 * whose sender is one of the configured bots. Reading the channel config keeps
 * this independent of which bot the Session happens to belong to.
 */
async function readBotPlatformIds(root) {
  try {
    const raw = await readFile(join(root, 'config.json'), 'utf8');
    const data = JSON.parse(raw.replace(/^\uFEFF/u, ''));
    const ids = (Array.isArray(data?.bots) ? data.bots : [])
      .map((bot) => String(bot?.platformId ?? '').trim())
      .filter(Boolean);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

/**
 * Build the provider `installInjectedContext` calls once per turn.
 *
 * @param options.store - the group-history store, or nothing.
 * @param options.root - the channel integration root holding `config.json`.
 * @param options.logger - Host logger for a read that could not complete.
 * @returns an async `(sessionId) => string | null`; null means "nothing to add".
 */
export function createRecentSharesProvider({ store, root, logger } = {}) {
  let botIds;
  return async function recentShares(sessionId) {
    if (!store || typeof store.findGroupId !== 'function') return null;
    try {
      const key = sessionConversationOf(sessionId);
      if (!key) return null;
      const parsed = parseConversationKey(key);
      if (!parsed || parsed.kind !== 'group') return null;
      botIds ??= await readBotPlatformIds(root);
      if (botIds.size === 0) return null;
      const groupId = await store.findGroupId(parsed.channelId, { channel: 'discord' });
      if (!groupId) return null;
      const page = await store.recentMessages(groupId, { since: Date.now() - WINDOW_MS, limit: 40 });
      const items = (page?.items ?? [])
        .filter((item) => botIds.has(String(item.senderId ?? '')))
        .filter((item) => typeof item.text === 'string' && item.text.trim()
          && !PLACEHOLDER.test(item.text.trim())
          && !NOISE.test(item.text.trim()))
        .slice(0, MAX_ITEMS);
      if (items.length === 0) return null;
      const lines = items.map((item) => {
        const text = item.text.replace(/\s+/gu, ' ').trim().slice(0, MAX_ITEM_CHARS);
        return `- ${clock(item.sentAt)} ${text}`;
      });
      const body = lines.join('\n');
      return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}…` : body;
    } catch (error) {
      logger?.warn?.('[dsh-im] unable to read recent shares:', error?.message ?? error);
      return null;
    }
  };
}

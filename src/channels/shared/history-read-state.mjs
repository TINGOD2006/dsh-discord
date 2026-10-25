import { randomUUID } from 'node:crypto';
import { cleanHistoryText, HISTORY_EXPOSURES } from './history-context.mjs';

export { HISTORY_EXPOSURES } from './history-context.mjs';
const MAX_CACHE_CHARS = 128 * 1024;

/** One incoming request owns its cache. It never grants archive permissions. */
export class HistoryReadState {
  #store; #groupId; #logger; #cache = []; #pending = new Map(); #seen = new Map(); #closed = false;
  constructor({ store, groupId, logger } = {}) {
    this.#store = store; this.#groupId = groupId; this.#logger = logger;
    this.traceId = randomUUID();
  }
  matches(context) { return !this.#closed && this.#store === context.store && this.#groupId === context.groupId; }
  trace(event, data = {}) {
    try { this.#logger?.event?.(`context.${event}`, { traceId: this.traceId, ...data }); } catch {}
  }
  async recent(options) {
    if (this.#closed) throw new Error('The originating group request has ended.');
    const query = { since: options.since ?? 0, before: options.before, keyword: options.keyword ?? '', limit: options.limit };
    for (const cached of this.#cache) {
      if (query.since < cached.query.since || query.before > cached.query.before
        || (cached.query.keyword && cached.query.keyword !== query.keyword)) continue;
      const items = cached.record.items.filter(row => row.sentAt >= query.since && row.sentAt <= query.before
        && (!query.keyword || cleanHistoryText(row.text).toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase())));
      if (cached.record.truncated && items.length < query.limit) continue;
      return { record: { ...cached.record, since: query.since, items: items.slice(0, query.limit),
        truncated: Boolean(cached.record.truncated || items.length > query.limit) }, cacheHit: true };
    }
    const key = JSON.stringify(query);
    if (this.#pending.has(key)) return { ...(await this.#pending.get(key)), cacheHit: true };
    const task = Promise.resolve().then(() => this.#store.recentMessages(this.#groupId, query)).then(record => {
      if (this.#closed) throw new Error('The originating group request has ended.');
      const bytes = JSON.stringify(record).length;
      if (bytes <= MAX_CACHE_CHARS) {
        this.#cache.push({ query, record: structuredClone(record), bytes });
        while (this.#cache.length > 3 || this.#cache.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_CACHE_CHARS) this.#cache.shift();
      }
      return { record, cacheHit: false };
    });
    this.#pending.set(key, task);
    try { return await task; } finally { this.#pending.delete(key); }
  }
  missing(id, text) {
    const full = cleanHistoryText(text), previous = this.#seen.get(String(id));
    if (previous && full.startsWith(previous)) return { text: full.slice(previous.length), prefix: previous, full, duplicate: full === previous };
    return { text: full, prefix: '', full, duplicate: false };
  }
  remember(entries) {
    if (this.#closed) return;
    for (const entry of entries ?? []) {
      if (!entry.id) continue;
      const text = cleanHistoryText(entry.text);
      const previous = this.#seen.get(String(entry.id)) ?? '';
      if (!previous || (text.startsWith(previous) && text.length > previous.length)) this.#seen.set(String(entry.id), text);
    }
  }
  close() { this.#closed = true; this.#cache.length = 0; this.#pending.clear(); this.#seen.clear(); }
}

export function ensureHistoryReadState(context, logger = context?.logger) {
  if (!context) return null;
  if (!context.readState?.matches?.(context)) context.readState = new HistoryReadState({ ...context, logger });
  return context.readState;
}

export function exposeHistory(value, entries) {
  Object.defineProperty(value, HISTORY_EXPOSURES, { value: entries });
  return value;
}

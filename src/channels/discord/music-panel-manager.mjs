import { renderPanel } from './music-panel.mjs';

/**
 * Owns the lifecycle of one card message per guild: create, throttle the 2.5s
 * refresh, survive a deleted message, and clear the timer on stop.
 *
 * The registry (see `MusicManager`) is the only source of truth for playback;
 * this class never reads the player directly.
 */
export class MusicPanelManager {
  #api; #registry; #intervalMs; #logger; #now; #controlUrlFor;
  #panels = new Map(); #timers = new Map(); #destroyed = false;

  constructor({ api, registry, intervalMs = 2500, logger = null, now = () => Date.now(), controlUrlFor = null } = {}) {
    if (!api) throw new TypeError('音樂卡片需要 Discord 訊息 API');
    if (!registry) throw new TypeError('音樂卡片需要播放狀態來源');
    this.#api = api; this.#registry = registry;
    this.#intervalMs = Math.max(1000, Number(intervalMs) || 2500);
    this.#logger = logger; this.#now = now;
    this.#controlUrlFor = typeof controlUrlFor === 'function' ? controlUrlFor : () => null;
  }

  get size() { return this.#panels.size; }

  messageIdFor(guildId) { return this.#panels.get(String(guildId))?.messageId ?? null; }

  #log(level, event, detail) {
    try { this.#logger?.(level, event, detail instanceof Error ? detail.message : detail); } catch {}
  }

  #body(guildId, snapshot) {
    let controlUrl = null;
    try { controlUrl = this.#controlUrlFor(String(guildId)) ?? null; } catch { controlUrl = null; }
    return renderPanel(snapshot, { guildId, controlUrl });
  }

  #startTimer(guildId) {
    if (this.#timers.has(guildId) || this.#destroyed) return;
    const timer = setInterval(() => { void this.refresh(guildId).catch(() => {}); }, this.#intervalMs);
    timer.unref?.();
    this.#timers.set(guildId, timer);
  }

  #stopTimer(guildId) {
    const timer = this.#timers.get(guildId);
    if (timer) clearInterval(timer);
    this.#timers.delete(guildId);
  }

  /** Called whenever playback may have changed. Cheap when nothing moved. */
  async sync(guildId) {
    const key = String(guildId);
    if (this.#destroyed) return null;
    let snapshot;
    try { snapshot = await this.#registry.snapshot(key); } catch (error) { this.#log('warn', 'music.panel.snapshot', error); return null; }
    if (!snapshot || snapshot.state === 'idle' || !snapshot.channelId) {
      const idlePanel = this.#panels.get(key);
      if (idlePanel) {
        // Leave the last card behind as "stopped" instead of a stale transport row.
        await this.#render(key, idlePanel, snapshot ?? { state: 'idle' }, { force: true });
        this.#stopTimer(key);
      } else {
        await this.stop(key);
      }
      return null;
    }
    let panel = this.#panels.get(key);
    if (panel && panel.channelId !== snapshot.channelId) {
      await this.stop(key);
      panel = null;
    }
    if (!panel) {
      panel = { channelId: snapshot.channelId, messageId: null, lastEditAt: 0 };
      this.#panels.set(key, panel);
    }
    await this.#render(key, panel, snapshot, { force: true });
    this.#startTimer(key);
    return panel.messageId;
  }

  async refresh(guildId, { force = false } = {}) {
    const key = String(guildId);
    if (this.#destroyed) return null;
    const panel = this.#panels.get(key);
    if (!panel) { await this.sync(key); return null; }
    if (!force && this.#now() - panel.lastEditAt < Math.max(1500, this.#intervalMs - 200)) return panel.messageId;
    let snapshot;
    try { snapshot = await this.#registry.snapshot(key); } catch (error) { this.#log('warn', 'music.panel.snapshot', error); return panel.messageId; }
    if (!snapshot || snapshot.state === 'idle') {
      await this.#render(key, panel, snapshot ?? { state: 'idle' }, { force: true });
      this.#stopTimer(key);
      return panel.messageId;
    }
    await this.#render(key, panel, snapshot, { force });
    return panel.messageId;
  }

  async #render(guildId, panel, snapshot, { force = false } = {}) {
    const body = this.#body(guildId, snapshot);
    try {
      if (!panel.messageId) {
        const message = await this.#api.createMessage({ channelId: panel.channelId, ...body });
        panel.messageId = String(message?.id ?? '') || null;
        panel.lastEditAt = this.#now();
        return panel.messageId;
      }
      if (!force && this.#now() - panel.lastEditAt < 1500) return panel.messageId;
      await this.#api.editMessage({ channelId: panel.channelId, messageId: panel.messageId, ...body });
      panel.lastEditAt = this.#now();
    } catch (error) {
      // A manually deleted card answers 404: forget the id so the next change posts
      // a fresh card instead of failing on every tick.
      if (isMissingMessage(error)) { panel.messageId = null; panel.lastEditAt = 0; this.#log('info', 'music.panel.repost', error); return null; }
      this.#log('warn', 'music.panel.render', error);
    }
    return panel.messageId;
  }

  /** Stop refreshing; with `remove`, leave a tombstone instead of deleting history. */
  async stop(guildId, { remove = false } = {}) {
    const key = String(guildId);
    this.#stopTimer(key);
    const panel = this.#panels.get(key);
    this.#panels.delete(key);
    if (panel?.messageId && remove) {
      try {
        await this.#api.editMessage({ channelId: panel.channelId, messageId: panel.messageId, content: '', embeds: [{ color: 0x4b5563, description: '播放卡片已移除。' }], components: [] });
      } catch (error) { if (!isMissingMessage(error)) this.#log('warn', 'music.panel.remove', error); }
    }
    return null;
  }

  async destroy() {
    this.#destroyed = true;
    for (const key of [...this.#timers.keys()]) this.#stopTimer(key);
    this.#panels.clear();
  }
}

function isMissingMessage(error) {
  const status = Number(error?.status ?? error?.httpStatus ?? 0);
  const code = String(error?.code ?? '');
  return status === 404 || code.includes('404') || code === 'unknown-message' || /unknown message/i.test(String(error?.message ?? ''));
}

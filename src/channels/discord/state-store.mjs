import { ConversationStateStore } from '../shared/conversation-state-store.mjs';

export class DiscordStateStore extends ConversationStateStore {
  // Keep the original key and methods so saved thread switches remain valid.
  // Discord uses channel IDs for both text channels and threads.
  async load() {
    await super.load();
    const state = this.extensionState();
    if (state.discordThreadAutoReplies !== undefined) {
      const entries = state.discordThreadAutoReplies;
      state.discordThreadAutoReplies = Object.fromEntries(Object.entries(
        entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {},
      ).filter(([id, enabled]) => /^\d{5,30}$/.test(id) && (typeof enabled === 'boolean' || enabled === 'smart')));
    }
    return this;
  }

  threadAutoReply(threadId) {
    const entries = this.extensionState().discordThreadAutoReplies;
    const value = entries?.[threadId];
    return typeof value === 'boolean' || value === 'smart' ? value : undefined;
  }

  async setThreadAutoReply(threadId, enabled, { resetContext = false } = {}) {
    if (typeof threadId !== 'string' || !/^\d{5,30}$/.test(threadId) || (typeof enabled !== 'boolean' && enabled !== 'smart')) {
      throw new TypeError('Invalid Discord auto-reply setting');
    }
    const state = this.extensionState();
    const previous = state.discordThreadAutoReplies;
    const previousAnchors = state.rootAnchors;
    const next = { ...previous, [threadId]: enabled };
    state.discordThreadAutoReplies = next;
    const nextAnchors = resetContext && previousAnchors ? { ...previousAnchors } : undefined;
    if (nextAnchors) {
      delete nextAnchors[`group:${threadId}`];
      state.rootAnchors = nextAnchors;
    }
    try {
      await this.persist();
    } catch (error) {
      if (state.discordThreadAutoReplies === next) {
        if (previous === undefined) delete state.discordThreadAutoReplies;
        else state.discordThreadAutoReplies = previous;
      }
      if (nextAnchors && state.rootAnchors === nextAnchors) state.rootAnchors = previousAnchors;
      throw error;
    }
  }
}

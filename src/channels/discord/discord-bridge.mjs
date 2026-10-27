import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { createProviderRecovery } from './provider-recovery.mjs';

export const DISCORD_DESCRIPTOR = Object.freeze({
  key: 'discord',
  label: 'Discord',
  connectionLabel: ' Gateway 长连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class DiscordHarnessBridge extends TextHarnessBridge {
  #recovery;

  constructor(options) {
    super({ descriptor: DISCORD_DESCRIPTOR, ...options });
    const state = options?.state ?? null;
    // Discord is event driven: after a model-provider outage nobody may type
    // again for hours, so a failed turn would sit in the staging list until the
    // process restarted. This keeps retrying that backlog on a backoff, and
    // stops as soon as it drains. Other channels never construct it.
    this.#recovery = createProviderRecovery({
      logger: options?.logger,
      signal: options?.signal,
      // Mid-process retry: only rows whose turn already failed (attempts > 0).
      // A row without attempts is a message merely queued behind another turn;
      // replaying it here would run it twice.
      retry: (args) => this.retryStagedMessages({ ...args, onlyAttempted: true }),
      pendingCount: () => {
        if (typeof state?.pendingMessages !== 'function') return 0;
        const entries = state.pendingMessages();
        if (!Array.isArray(entries)) return 0;
        return entries.filter((entry) => Number.isSafeInteger(entry?.attempts) && entry.attempts > 0).length;
      },
    });
  }

  /** Shared failure hook: only Discord arms the provider-recovery schedule. */
  onTurnFailed(context) {
    this.#recovery.note(context);
  }
}

export { createTextBridgeStatus as createDiscordBridgeStatus };

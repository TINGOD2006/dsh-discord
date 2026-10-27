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
      retry: (args) => this.retryStagedMessages(args),
      pendingCount: () => (typeof state?.pendingMessages === 'function'
        ? state.pendingMessages()?.length ?? 0
        : 0),
    });
  }

  /** Shared failure hook: only Discord arms the provider-recovery schedule. */
  onTurnFailed(context) {
    this.#recovery.note(context);
  }
}

export { createTextBridgeStatus as createDiscordBridgeStatus };

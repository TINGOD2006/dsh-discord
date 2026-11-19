import { DiscordConfigStore } from '../../../../src/channels/discord/config-store.mjs';
import { DiscordController } from '../../../../src/channels/discord/discord-controller.mjs';
import { DiscordHarnessClient } from '../../../../src/channels/discord/harness-client.mjs';
import { DiscordRuntime } from '../../../../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../../../../src/channels/discord/state-store.mjs';
import { createDshWebMusicSearch, createDshWebSourceSearch } from '../../../../src/channels/discord/music-dsh.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'discord',
    ConfigStore: DiscordConfigStore,
    StateStore: DiscordStateStore,
    HarnessClient: DiscordHarnessClient,
    Controller: DiscordController,
    Runtime: DiscordRuntime,
    runtimeOptions: () => ({
      searchNativeMusic: createDshWebMusicSearch(ctx),
      webSearch: createDshWebSourceSearch(ctx),
    }),
  });
}

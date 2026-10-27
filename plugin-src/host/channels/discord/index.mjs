import { createProductionController } from './production.mjs';
import { createDiscordRpcHandler, installDiscordRpc, DISCORD_RPC_CHANNEL } from './rpc.mjs';
import { installProductionChannel } from '../shared/startup.mjs';
import { getDiscordPersonaStore } from '../../../../src/channels/discord/persona-store.mjs';
import { getDiscordAllowlistStore } from '../../../../src/channels/discord/allowlist.mjs';

export const name = 'dsh-im-discord-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export async function apply(ctx, config = {}) {
  const persona = getDiscordPersonaStore(config);
  const allowlist = getDiscordAllowlistStore(config);
  if (config?.controller) {
    return installDiscordRpc(ctx, config.controller, config.rpcAuthority, { persona, allowlist });
  }
  return installProductionChannel(ctx, config, {
    channel: 'discord',
    rpcChannel: DISCORD_RPC_CHANNEL,
    createProduction: () => createProductionController(ctx, config, config.internals ?? {}),
    createHandler: controller => createDiscordRpcHandler(controller, { persona, allowlist }),
  });
}

export function createDiscordHostPlugin(config) {
  return Object.freeze({ name, inject, apply: (ctx) => apply(ctx, config) });
}

export { createProductionController } from './production.mjs';
export {
  DISCORD_ENDPOINTS,
  DISCORD_RPC_CHANNEL,
  DISCORD_RPC_ENDPOINTS,
  createDiscordRpcHandler,
  installDiscordRpc,
} from './rpc.mjs';
export { DiscordController } from '../../../../src/channels/discord/discord-controller.mjs';
export { DiscordRuntime } from '../../../../src/channels/discord/discord-runtime.mjs';

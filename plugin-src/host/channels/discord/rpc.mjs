import {
  TOKEN_BOT_ENDPOINTS,
  createTokenBotRpcHandler,
  installTokenBotRpc,
} from '../shared/rpc.mjs';

export const DISCORD_RPC_CHANNEL = '/discord';
export const DISCORD_ENDPOINTS = TOKEN_BOT_ENDPOINTS;
export const DISCORD_RPC_ENDPOINTS = Object.freeze(Object.values(DISCORD_ENDPOINTS));

export function createDiscordRpcHandler(controller, { persona = null, allowlist = null, members = null } = {}) {
  return createTokenBotRpcHandler(controller, { channel: 'Discord', persona, allowlist, members });
}

export function installDiscordRpc(ctx, controller, authority, { persona = null, allowlist = null, members = null } = {}) {
  return installTokenBotRpc(ctx, controller, {
    channel: 'Discord',
    rpcChannel: DISCORD_RPC_CHANNEL,
    authority,
    persona,
    allowlist,
    members,
  });
}

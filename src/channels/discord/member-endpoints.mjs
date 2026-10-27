/**
 * Browser-safe endpoint names for the Discord member directory. The client
 * imports this file, so it must stay free of node-only dependencies.
 */
export const MEMBER_ENDPOINTS = Object.freeze({
  list: 'bot.members.list',
});

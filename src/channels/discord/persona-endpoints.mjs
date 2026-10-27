/**
 * Endpoint names for the editable Discord persona.
 *
 * Kept in a dependency-free module so the web client can import them without
 * pulling in the server-side store (node:fs).
 */
export const PERSONA_ENDPOINTS = Object.freeze({
  list: 'settings.discord-persona.list',
  get: 'settings.discord-persona.get',
  create: 'settings.discord-persona.create',
  save: 'settings.discord-persona.save',
  delete: 'settings.discord-persona.delete',
  activate: 'settings.discord-persona.activate',
  // Legacy single-persona endpoints: no `id` means "the active persona". Kept
  // for one release so an older card build keeps working.
  set: 'settings.discord-persona.set',
});

export const MAX_PERSONA_CHARS = 8_000;

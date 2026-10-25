/**
 * Endpoint names for the editable Discord persona.
 *
 * Kept in a dependency-free module so the web client can import them without
 * pulling in the server-side store (node:fs).
 */
export const PERSONA_ENDPOINTS = Object.freeze({
  get: 'settings.discord-persona.get',
  set: 'settings.discord-persona.set',
});

export const MAX_PERSONA_CHARS = 8_000;

/**
 * Persisted Discord persona: the built-in prompt is the default, and a custom
 * override saved from the DSH settings card lives in
 * `<DSH_HOME>/integrations/dsh-discord/persona.md`.
 *
 * The file is small (<= 8k chars) and read once per plugin start, so a plain
 * synchronous read is cheaper than wiring another async store.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_PERSONA_CHARS } from './persona-endpoints.mjs';
import { DISCORD_PERSONA_PROMPT } from './persona.mjs';

export const PERSONA_FILE_NAME = 'persona.md';

/**
 * Trim, normalise newlines and reject oversized/control-character text.
 *
 * `allowEmpty` is for a saved file, where an empty result is a decision (the
 * operator cleared the persona) rather than a missing value. Without it an
 * empty string stays invalid, so a caller keeps the strict meaning.
 */
export function normalizePersonaText(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return allowEmpty ? '' : null;
  if (text.length > MAX_PERSONA_CHARS) return null;
  // Allow \n and \t only; everything else in the C0 range is rejected.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return null;
  return text;
}

export function personaFilePath(config = {}) {
  const root = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(root, 'integrations', 'dsh-discord', PERSONA_FILE_NAME);
}

export class DiscordPersonaStore {
  #path;

  constructor(options = {}) {
    this.#path = options.path ?? personaFilePath(options);
  }

  /**
   * { text, defaultText, customized, empty } — `text` is what gets injected, so
   * a deliberately emptied persona yields '' and Discord turns run without one.
   */
  snapshot() {
    const custom = this.#read();
    if (custom !== null) {
      return {
        text: custom,
        defaultText: DISCORD_PERSONA_PROMPT,
        customized: true,
        empty: custom === '',
      };
    }
    return {
      text: DISCORD_PERSONA_PROMPT,
      defaultText: DISCORD_PERSONA_PROMPT,
      customized: false,
      empty: false,
    };
  }

  text() {
    return this.snapshot().text;
  }

  /** Save an override; an empty text is stored as "no persona at all". */
  write(value) {
    const text = normalizePersonaText(value, { allowEmpty: true });
    if (text === null) {
      const error = new Error(`人格文本最多 ${MAX_PERSONA_CHARS} 字，且不能包含控制字符。`);
      error.code = 'persona-invalid';
      throw error;
    }
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, text === '' ? '' : `${text}\n`, 'utf8');
    return this.snapshot();
  }

  reset() {
    rmSync(this.#path, { force: true });
    return this.snapshot();
  }

  /** null when the file is absent; '' when it is present and deliberately empty. */
  #read() {
    try {
      if (!existsSync(this.#path)) return null;
      return normalizePersonaText(readFileSync(this.#path, 'utf8'), { allowEmpty: true });
    } catch {
      return null;
    }
  }
}

export function getDiscordPersonaStore(config) {
  return new DiscordPersonaStore(config ?? {});
}

/**
 * Which Session each persona already owns in each conversation.
 *
 * Switching persona used to mean "drop the binding, start a fresh Session", so
 * switching away and back left a trail of one Session per switch even though
 * the earlier Session for that persona was still on disk. This store makes the
 * trip reversible: the persona that a conversation was last answering as is
 * remembered, and going back re-binds that Session instead of creating a third.
 *
 * Shape of `personas/links.json`:
 *   bindings: { "<conversationKey>": { activeId, sessionId } }   what is bound now
 *   index:    { "<personaId>": { "<conversationKey>": "<sessionId>" } }  history
 *
 * The index keeps the session a persona *used*, even after the binding moved
 * elsewhere, so a later switch back has something to return to.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const LINKS_FILE_NAME = 'links.json';

export function linksFilePath(config = {}) {
  const root = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(root, 'integrations', 'dsh-discord', 'personas', LINKS_FILE_NAME);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanId(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

export class DiscordPersonaLinks {
  #path;

  constructor(options = {}) {
    this.#path = options.path ?? linksFilePath(options);
  }

  /** `{ bindings, index }`, corrupt or missing files read as empty. */
  snapshot() {
    const data = this.#read();
    return { bindings: { ...data.bindings }, index: structuredCloneLike(data.index) };
  }

  /** The binding recorded for one conversation, or null. */
  bindingFor(key) {
    const entry = this.#read().bindings[key];
    if (!entry) return null;
    const activeId = cleanId(entry.activeId);
    const sessionId = cleanId(entry.sessionId);
    return activeId ? { activeId, sessionId } : null;
  }

  /** The Session this persona last used in this conversation, or null. */
  candidateFor(activeId, key) {
    if (!activeId) return null;
    return cleanId(this.#read().index?.[activeId]?.[key]);
  }

  /**
   * Record that `key` is bound to `sessionId` while answering as `activeId`.
   * A null `sessionId` means "bound to nothing yet" and clears the pointer
   * without forgetting the persona's earlier Session.
   */
  bind({ key, activeId, sessionId } = {}) {
    if (typeof key !== 'string' || key === '' || !activeId) return;
    const data = this.#read();
    const id = cleanId(sessionId);
    if (id) {
      const perPersona = plainObject(data.index[activeId]);
      perPersona[key] = id;
      data.index[activeId] = perPersona;
      data.bindings[key] = { activeId, sessionId: id };
    } else {
      delete data.bindings[key];
    }
    this.#write(data);
  }

  /** Drop the current pointer for a conversation but keep the history index. */
  unbind(key) {
    const data = this.#read();
    if (!(key in data.bindings)) return;
    delete data.bindings[key];
    this.#write(data);
  }

  #read() {
    try {
      // Notepad on Windows writes a UTF-8 BOM; JSON.parse rejects it.
      const raw = readFileSync(this.#path, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      const bindings = plainObject(parsed?.bindings);
      const index = plainObject(parsed?.index);
      return { bindings, index };
    } catch {
      return { bindings: {}, index: {} };
    }
  }

  #write(data) {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.#path);
  }
}

function structuredCloneLike(value) {
  return JSON.parse(JSON.stringify(plainObject(value)));
}

export function getDiscordPersonaLinks(config) {
  return new DiscordPersonaLinks(config);
}

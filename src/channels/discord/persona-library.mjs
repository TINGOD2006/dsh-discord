/**
 * A named persona library for Discord, stored under
 * `<DSH_HOME>/integrations/dsh-discord/personas/`.
 *
 * `active.json` holds the activation pointer and the epoch that tells a bound
 * Session its persona changed; keeping both next to the bodies (instead of in
 * the bot `config.json`) means the settings card can switch personas without
 * reaching into the controller's config writer.
 *
 * The legacy single-file persona is migrated here on first read and renamed, so
 * an operator never loses text they had already saved.
 *
 * Synchronous and small on purpose: the injected system prompt renders on every
 * turn and cannot await.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_PERSONA_CHARS } from './persona-endpoints.mjs';
import { PERSONA_FILE_NAME, normalizePersonaText } from './persona-store.mjs';

export const PERSONAS_DIR_NAME = 'personas';
export const PERSONA_INDEX_FILE = 'index.json';
export const PERSONA_ACTIVE_FILE = 'active.json';
// Lowercase alphanumerics only: the id is a file name, so no separators and no
// dots may ever appear. Generated ids are 6 chars; `p_default` is longer.
export const PERSONA_ID_PATTERN = /^p_[a-z0-9]{6,12}$/u;
export const MAX_PERSONAS = 50;
export const DEFAULT_PERSONA_ID = 'p_default';
export const DEFAULT_PERSONA_NAME = '预设';
const MAX_NAME_CHARS = 40;

function libraryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeName(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const name = value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_NAME_CHARS);
  return name || fallback;
}

function readJson(path) {
  try {
    // A hand-edited file on Windows often carries a UTF-8 BOM, which JSON.parse
    // rejects outright; without this strip the whole library reads as empty.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

function writeAtomic(path, contents) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, path);
}

export class DiscordPersonaLibrary {
  #root;
  #logger;
  #cache = null;

  constructor({ dshHome, root: explicitRoot, logger } = {}) {
    const root = explicitRoot
      ?? join(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-discord');
    this.#root = root;
    this.#logger = logger ?? null;
  }

  get directory() {
    return join(this.#root, PERSONAS_DIR_NAME);
  }

  get #indexPath() {
    return join(this.directory, PERSONA_INDEX_FILE);
  }

  get #activePath() {
    return join(this.directory, PERSONA_ACTIVE_FILE);
  }

  /** { activeId, epoch, items: [{ id, name, chars, updatedAt }] } — what the card lists. */
  snapshot() {
    const { activeId, epoch } = this.#active();
    return {
      activeId,
      epoch,
      items: this.#items().map((item) => ({
        id: item.id,
        name: item.name,
        chars: this.#bodyText(item.id).length,
        updatedAt: item.updatedAt,
      })),
    };
  }

  /** The body to inject for the active persona; '' means "no persona at all". */
  activeText() {
    const { activeId } = this.#active();
    if (!activeId) return '';
    return this.#bodyText(activeId);
  }

  read(id) {
    this.#assertId(id);
    const item = this.#items().find((entry) => entry.id === id);
    if (!item) throw libraryError('persona-not-found', '人格不存在。');
    return { id, name: item.name, text: this.#bodyText(id) };
  }

  create({ name, text } = {}) {
    const items = this.#itemsForWrite();
    if (items.length >= MAX_PERSONAS) {
      throw libraryError('persona-limit', `最多 ${MAX_PERSONAS} 个人格。`);
    }
    const body = this.#normalizeBody(text);
    const id = this.#newId(items);
    mkdirSync(this.directory, { recursive: true });
    writeAtomic(this.#bodyPath(id), body === '' ? '' : `${body}\n`);
    const now = new Date().toISOString();
    this.#writeIndex({
      version: 1,
      items: [...items, { id, name: normalizeName(name, '未命名'), createdAt: now, updatedAt: now }],
    });
    return { id };
  }

  save({ id, name, text } = {}) {
    this.#assertId(id);
    const items = this.#itemsForWrite();
    const item = items.find((entry) => entry.id === id);
    if (!item) throw libraryError('persona-not-found', '人格不存在。');
    const body = this.#normalizeBody(text);
    mkdirSync(this.directory, { recursive: true });
    writeAtomic(this.#bodyPath(id), body === '' ? '' : `${body}\n`);
    const nextName = normalizeName(name, item.name);
    this.#writeIndex({
      version: 1,
      items: items.map((entry) => (entry.id === id
        ? { ...entry, name: nextName, updatedAt: new Date().toISOString() }
        : entry)),
    });
    this.#cache = null;
    return { id, name: nextName };
  }

  remove(id) {
    this.#assertId(id);
    const items = this.#itemsForWrite();
    if (!items.some((entry) => entry.id === id)) throw libraryError('persona-not-found', '人格不存在。');
    if (this.#active().activeId === id) {
      throw libraryError('persona-active-undeletable', '正在使用的人格不能删除，请先切换到别的人格。');
    }
    try {
      unlinkSync(this.#bodyPath(id));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#writeIndex({ version: 1, items: items.filter((entry) => entry.id !== id) });
    this.#cache = null;
    return { ok: true };
  }

  /**
   * Point the bot at `id` and bump the epoch so bound Sessions reset.
   *
   * A blank persona is a legitimate choice: it means "no persona段", which is
   * how an operator turns the voice off on purpose. The card labels that option
   * instead of hiding it, so the state is always visible before it is entered.
   */
  activate(id) {
    this.#assertId(id);
    if (!this.#itemsForWrite().some((entry) => entry.id === id)) {
      throw libraryError('persona-not-found', '人格不存在。');
    }
    const { epoch } = this.#active();
    const next = { activeId: id, epoch: epoch + 1 };
    mkdirSync(this.directory, { recursive: true });
    writeAtomic(this.#activePath, `${JSON.stringify(next)}\n`);
    this.#cache = null;
    return next;
  }

  #assertId(id) {
    if (typeof id !== 'string' || !PERSONA_ID_PATTERN.test(id)) {
      throw libraryError('persona-invalid', '人格编号不合法。');
    }
  }

  #newId(items) {
    const taken = new Set(items.map((entry) => entry.id));
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = `p_${randomBytes(3).toString('hex')}`;
      if (!taken.has(id)) return id;
    }
    throw libraryError('persona-invalid', '无法生成新的人格编号。');
  }

  #normalizeBody(text) {
    const body = normalizePersonaText(text, { allowEmpty: true });
    if (body === null) {
      throw libraryError('persona-invalid', `人格文本最多 ${MAX_PERSONA_CHARS} 字，且不能包含控制字符。`);
    }
    return body;
  }

  #bodyPath(id) {
    return join(this.directory, `${id}.md`);
  }

  #bodyText(id) {
    const path = this.#bodyPath(id);
    try {
      const { mtimeMs } = statSync(path);
      if (this.#cache && this.#cache.id === id && this.#cache.mtimeMs === mtimeMs) return this.#cache.text;
      const text = normalizePersonaText(readFileSync(path, 'utf8'), { allowEmpty: true }) ?? '';
      this.#cache = { id, mtimeMs, text };
      return text;
    } catch {
      return '';
    }
  }

  #items() {
    this.#migrateLegacyPersona();
    const index = readJson(this.#indexPath);
    if (index === null) {
      if (existsSync(this.#indexPath)) {
        this.#logger?.warn?.('[dsh-discord] personas/index.json is unreadable; treating the library as empty');
      }
      return [];
    }
    if (!Array.isArray(index.items)) return [];
    return index.items.filter((item) => item && typeof item.id === 'string' && PERSONA_ID_PATTERN.test(item.id));
  }

  /**
   * The list a mutating call may write back. Reading tolerantly is right for the
   * settings card, but writing from an unreadable index would replace every other
   * persona with the single item being saved and leave the rest orphaned, so
   * mutations refuse until the file is repaired.
   */
  #itemsForWrite() {
    const items = this.#items();
    if (existsSync(this.#indexPath) && readJson(this.#indexPath) === null) {
      throw libraryError('persona-index-unreadable', '人格索引无法读取，先修好 personas/index.json 再修改人格。');
    }
    return items;
  }

  #active() {
    // Read order matters: a legacy persona.md makes the library exist, so the
    // migration has to run before the pointer is read as "none".
    this.#migrateLegacyPersona();
    const active = readJson(this.#activePath);
    const activeId = typeof active?.activeId === 'string' && PERSONA_ID_PATTERN.test(active.activeId)
      ? active.activeId
      : null;
    const epoch = Number.isSafeInteger(active?.epoch) && active.epoch >= 0 ? active.epoch : 0;
    return { activeId, epoch };
  }

  #writeIndex(index) {
    mkdirSync(this.directory, { recursive: true });
    writeAtomic(this.#indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  /**
   * Move `persona.md` into the library as `p_default`, then rename it so a second
   * start neither migrates twice nor resurrects a file nobody reads any more.
   */
  #migrateLegacyPersona() {
    const legacy = join(this.#root, PERSONA_FILE_NAME);
    const migrated = `${legacy}.migrated`;
    if (existsSync(this.#indexPath) || !existsSync(legacy) || existsSync(migrated)) return;
    const text = normalizePersonaText(readFileSync(legacy, 'utf8'), { allowEmpty: true }) ?? '';
    const now = new Date().toISOString();
    mkdirSync(this.directory, { recursive: true });
    writeAtomic(this.#bodyPath(DEFAULT_PERSONA_ID), text === '' ? '' : `${text}\n`);
    this.#writeIndex({
      version: 1,
      items: [{ id: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_NAME, createdAt: now, updatedAt: now }],
    });
    writeAtomic(this.#activePath, `${JSON.stringify({ activeId: DEFAULT_PERSONA_ID, epoch: 0 })}\n`);
    renameSync(legacy, migrated);
  }
}

export function getDiscordPersonaLibrary(config) {
  return new DiscordPersonaLibrary(config ?? {});
}

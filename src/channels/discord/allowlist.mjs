import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// The cap lives in the browser-safe endpoints module so the client bundle can
// import it without pulling node:fs into the renderer.
import { MAX_ALLOWLIST_SIZE } from './allowlist-endpoints.mjs';

/**
 * Whitelist of Discord account ids that get the owner's command set and the
 * full runtime environment. Owner-only commands (`/digest`, `/recall`, …) and
 * the per-conversation access decision both treat an allowlisted sender exactly
 * like the owner, so a single file controls the whole privileged set.
 *
 * Shape on disk: `{ "ids": ["123…", …] }`, newest save wins, cap 50 entries.
 */
export const ALLOWLIST_FILE_NAME = 'allowlist.json';
// Re-exported for host-side callers; the client imports the endpoints module directly.
export { MAX_ALLOWLIST_SIZE };

const SNOWFLAKE = /^\d{5,30}$/;

export function normalizeAllowlistId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  return SNOWFLAKE.test(text) ? text : '';
}

/** Accepts a bare array or `{ ids: [...] }`; throws `allowlist-invalid` on junk. */
export function normalizeAllowlist(value) {
  const raw = Array.isArray(value) ? value : (value && Array.isArray(value.ids) ? value.ids : null);
  if (!raw) {
    const error = new Error('白名单需要是数组或 { "ids": [...] }。');
    error.code = 'allowlist-invalid';
    throw error;
  }
  const ids = [];
  for (const item of raw) {
    const id = normalizeAllowlistId(item);
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_ALLOWLIST_SIZE) {
    const error = new Error(`白名单最多 ${MAX_ALLOWLIST_SIZE} 个 ID。`);
    error.code = 'allowlist-invalid';
    throw error;
  }
  return ids;
}

export function allowlistFilePath(config = {}) {
  const root = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(root, 'integrations', 'dsh-discord', ALLOWLIST_FILE_NAME);
}

export class DiscordAllowlistStore {
  #path;

  constructor(options = {}) {
    this.#path = options.path ?? allowlistFilePath(options);
  }

  /** `{ ids, path, customized }` — corrupt or missing files read as empty. */
  snapshot() {
    const ids = this.#read();
    return { ids, path: this.#path, customized: ids.length > 0 };
  }

  list() {
    return this.#read();
  }

  has(senderId) {
    const id = normalizeAllowlistId(senderId);
    return id !== '' && this.#read().includes(id);
  }

  write(value) {
    const ids = normalizeAllowlist(value);
    mkdirSync(dirname(this.#path), { recursive: true });
    // Write beside the live file and rename: a crash mid-save must not leave a
    // truncated allowlist that reads back as "nobody is trusted".
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ids }, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.#path);
    return this.snapshot();
  }

  #read() {
    try {
      if (!existsSync(this.#path)) return [];
      // A hand-edited file on Windows often carries a UTF-8 BOM; JSON.parse
      // rejects it outright, which used to make a "saved" allowlist look empty.
      const raw = readFileSync(this.#path, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      return normalizeAllowlist(parsed).slice();
    } catch {
      return [];
    }
  }
}

export function getDiscordAllowlistStore(config) {
  return new DiscordAllowlistStore(config);
}

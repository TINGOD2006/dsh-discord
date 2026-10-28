import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stageInboundFiles } from './inbound-file.mjs';

export const GROUP_HISTORY_CHANNELS = Object.freeze(['whatsapp', 'feishu', 'telegram', 'discord', 'slack', 'qq']);
export const DEFAULT_GROUP_HISTORY_DAYS = 14;
const DAY = 86_400_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Extensions a vision model can read directly; other archives stay file-only.
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

function untilAbort(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function normalizeGroupHistoryDays(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days > 0 && Number.isSafeInteger(days * DAY) ? days : null;
}

function invalid(message) { return Object.assign(new Error(message), { code: 'group-history-invalid' }); }
function text(value, max = 512) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function timestamp(value, fallback) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function attachmentView(row) {
  return { id: row.id, messageId: row.message_id, name: row.name, mimeType: row.mime_type,
    sizeBytes: row.size_bytes, status: row.status, error: row.last_error || null };
}

/** A single group-owned archive. Bot credentials and AI session ownership never enter this database. */
export class GroupHistoryStore {
  #root;
  #db;
  #ready;
  #days = DEFAULT_GROUP_HISTORY_DAYS;
  #settingsError = null;
  #maintenance = Promise.resolve();
  #now;
  #logger;
  #timer;
  #closing = false;
  #jobs = new Map();
  #active = new Map();
  #idle = [];
  #sweep;
  #maxFileBytes;
  #downloadTimeoutMs;
  #copyService;
  #close;

  constructor(root, { now = Date.now, logger = console, maxFileBytes = MAX_FILE_BYTES, downloadTimeoutMs = 60_000, copyService } = {}) {
    this.#root = resolve(root);
    this.#now = now;
    this.#logger = logger;
    this.#maxFileBytes = maxFileBytes;
    this.#downloadTimeoutMs = downloadTimeoutMs;
    this.#copyService = copyService;
  }

  get root() { return this.#root; }
  ready() { return this.#ready ??= this.#load(); }
  cutoff() { return this.#now() - this.#days * DAY; }

  async #load() {
    await mkdir(join(this.#root, 'group-files'), { recursive: true, mode: 0o700 });
    try {
      const raw = (await readFile(join(this.#root, 'general-settings.json'), 'utf8')).replace(/^\uFEFF/u, '');
      const data = JSON.parse(raw);
      const days = normalizeGroupHistoryDays(data.groupHistoryRetentionDays);
      if (data.version !== 1 || days === null) throw invalid('群记录设置损坏，请重新保存保留天数。');
      this.#days = days;
    } catch (error) {
      if (error.code !== 'ENOENT') this.#settingsError = '群记录设置无法读取，已暂停自动清理，请重新保存保留天数。';
    }
    const path = join(this.#root, 'group-history.sqlite');
    this.#db = new DatabaseSync(path);
    await chmod(path, 0o600);
    this.#db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, platform_scope TEXT NOT NULL DEFAULT '',
        platform_group_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        recording_started_at INTEGER, last_received_at INTEGER, capability TEXT NOT NULL DEFAULT '',
        UNIQUE(channel, platform_scope, platform_group_id));
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), platform_message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', sent_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL,
        thread_id TEXT, reply_to_message_id TEXT, UNIQUE(group_id, platform_message_id));
      CREATE INDEX IF NOT EXISTS messages_group_time ON messages(group_id, sent_at, id);
      CREATE INDEX IF NOT EXISTS messages_expiry ON messages(sent_at);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        source_attachment_key TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
        size_bytes INTEGER, relative_path TEXT, status TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '',
        UNIQUE(message_id, source_attachment_key));`);
    // Stable per-group message numbers (#mXXXX): the tail of the platform id,
    // extended only when a shorter tail is already taken. They give the model a
    // handle for one archived row that a later turn can ask about directly,
    // and the unique index makes that lookup a single index seek.
    const messageColumns = this.#db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name);
    if (!messageColumns.includes('ref')) this.#db.exec('ALTER TABLE messages ADD COLUMN ref TEXT');
    this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_ref ON messages(group_id, ref)');
    this.#ensureMessageRefs();
    this.#db.prepare("UPDATE attachments SET status = 'unavailable', last_error = ? WHERE status = 'pending'")
      .run('下载被重启中断，原文件尚未保存。');
    // Only our fixed-depth partial files are removed; ready files remain untouched.
    for (const group of await readdir(join(this.#root, 'group-files'), { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupPath = join(this.#root, 'group-files', group.name);
      for (const message of await readdir(groupPath, { withFileTypes: true })) {
        if (!message.isDirectory()) continue;
        const messagePath = join(groupPath, message.name);
        for (const file of await readdir(messagePath, { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith('.part')) await rm(join(messagePath, file.name), { force: true });
        }
      }
    }
    return this;
  }

  async start() {
    await this.ready();
    if (this.#timer || this.#closing) return;
    await this.sweep();
    if (this.#closing) return;
    this.#timer = setInterval(() => void this.sweep().catch((error) => this.#warn(error)), 3_600_000);
    this.#timer.unref?.();
  }

  #warn(error) { this.#logger.warn?.('[dsh-im] group history:', error?.message ?? 'operation failed'); }

  async settings() {
    await this.ready();
    return { groupHistoryRetentionDays: this.#days, ...(this.#settingsError ? { error: this.#settingsError } : {}) };
  }

  setRetentionDays(value) {
    const days = normalizeGroupHistoryDays(value);
    if (days === null) return Promise.reject(invalid('保留天数必须为正整数。'));
    const write = this.#maintenance.catch(() => {}).then(async () => {
      await this.ready();
      const path = join(this.#root, 'general-settings.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, groupHistoryRetentionDays: days }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      this.#days = days;
      this.#settingsError = null;
      void this.sweep().catch((error) => this.#warn(error));
      return this.settings();
    });
    this.#maintenance = write;
    return write;
  }

  async capture(entry) {
    await this.ready();
    if (this.#closing || !entry || !GROUP_HISTORY_CHANNELS.includes(entry.channel)) return null;
    const platformGroupId = text(entry.groupId);
    if (!platformGroupId) return null;
    const scope = text(entry.scope);
    let group = this.#db.prepare('SELECT * FROM groups WHERE channel = ? AND platform_scope = ? AND platform_group_id = ?')
      .get(entry.channel, scope, platformGroupId);
    if (!group) {
      const id = randomUUID();
      this.#db.prepare('INSERT INTO groups(id, channel, platform_scope, platform_group_id, name, capability) VALUES(?,?,?,?,?,?)')
        .run(id, entry.channel, scope, platformGroupId, text(entry.groupName), text(entry.capability, 1000));
      group = this.#db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    } else if (entry.groupName || entry.capability) {
      this.#db.prepare('UPDATE groups SET name = ?, capability = ? WHERE id = ?')
        .run(text(entry.groupName) || group.name, text(entry.capability, 1000) || group.capability, group.id);
    }
    const context = Object.freeze({ store: this, groupId: group.id });
    // Older databases may retain an enabled column. It no longer gates
    // recording: every group delivered by the platform is recorded by default.
    if (this.#settingsError) return context;
    const messageId = text(entry.messageId, 2048);
    if (!messageId || !entry.senderId) return context;
    const now = this.#now();
    const sentAt = timestamp(entry.sentAt, now);
    if (sentAt < this.cutoff()) return context;
    this.#db.exec('BEGIN');
    const queued = [];
    try {
      this.#db.prepare(`INSERT INTO messages(id,group_id,platform_message_id,sender_id,sender_name,sent_at,received_at,type,text,thread_id,reply_to_message_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,platform_message_id) DO NOTHING`)
        .run(randomUUID(), group.id, messageId, text(entry.senderId), text(entry.senderName), sentAt, now,
          text(entry.type) || 'text', typeof entry.text === 'string' ? entry.text : '', text(entry.threadId) || null, text(entry.replyToMessageId, 2048) || null);
      const message = this.#db.prepare('SELECT id FROM messages WHERE group_id = ? AND platform_message_id = ?').get(group.id, messageId);
      this.#assignRef(group.id, messageId);
      // Repeated delivery may carry metadata missing from the first event.
      for (const [index, source] of (entry.attachments ?? []).entries()) {
        const key = text(source.key) || String(index);
        const size = Number.isSafeInteger(source.size) && source.size >= 0 ? source.size : null;
        this.#db.prepare(`INSERT INTO attachments(id,message_id,source_attachment_key,name,mime_type,size_bytes,status)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id,source_attachment_key) DO NOTHING`)
          .run(randomUUID(), message.id, key, text(source.name) || `file-${index + 1}`, text(source.mediaType) || 'application/octet-stream', size, 'pending');
        const attachment = this.#db.prepare('SELECT * FROM attachments WHERE message_id = ? AND source_attachment_key = ?').get(message.id, key);
        if (attachment.status !== 'ready' && !this.#jobs.has(attachment.id) && !this.#active.has(attachment.id)) {
          queued.push({ attachment, source, groupId: group.id, messageId: message.id });
        }
      }
      this.#db.prepare('UPDATE groups SET last_received_at = ?, recording_started_at = coalesce(recording_started_at, ?) WHERE id = ?')
        .run(now, now, group.id);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    for (const job of queued) this.#jobs.set(job.attachment.id, job);
    this.#pump();
    return context;
  }

  /**
   * The number a replayed line is labelled with. Four trailing characters by
   * default; a collision inside one group widens the tail instead of refusing
   * the row, so a busy channel never ends up with two `#m3f2a`s.
   */
  #assignRef(groupId, platformMessageId) {
    const row = this.#db.prepare('SELECT id, ref FROM messages WHERE group_id = ? AND platform_message_id = ?')
      .get(groupId, platformMessageId);
    if (!row || row.ref) return row?.ref ?? null;
    const taken = this.#db.prepare('SELECT 1 AS hit FROM messages WHERE group_id = ? AND ref = ?');
    const source = String(platformMessageId);
    const limit = Math.min(source.length, 12);
    for (let length = Math.min(4, source.length); length <= limit; length += 1) {
      const candidate = source.slice(-length).toLowerCase();
      if (!taken.get(groupId, candidate)) {
        this.#db.prepare('UPDATE messages SET ref = ? WHERE id = ?').run(candidate, row.id);
        return candidate;
      }
    }
    return null;
  }

  /** One-time pass that numbers rows written before the column existed. */
  #ensureMessageRefs() {
    const pending = this.#db.prepare('SELECT group_id, platform_message_id FROM messages WHERE ref IS NULL')
      .all();
    for (const row of pending) this.#assignRef(String(row.group_id), String(row.platform_message_id));
  }

  #pump() {
    while (this.#active.size < 2 && this.#jobs.size) {
      const [id, job] = this.#jobs.entries().next().value;
      this.#jobs.delete(id);
      const task = this.#download(job).catch((error) => this.#warn(error)).finally(() => {
        this.#active.delete(id);
        this.#pump();
      });
      this.#active.set(id, task);
    }
    if (!this.#active.size && !this.#jobs.size) for (const done of this.#idle.splice(0)) done();
  }

  async #download({ attachment, source, groupId, messageId }) {
    const relativePath = join('group-files', groupId, messageId, attachment.id);
    const path = join(this.#root, relativePath);
    const temporary = `${path}.part`;
    let handle;
    let iterator;
    try {
      if (typeof source.load !== 'function') throw invalid('平台没有提供可下载的文件。');
      if (attachment.size_bytes > this.#maxFileBytes) throw invalid('文件超过群文件保存大小上限。');
      this.#db.prepare("UPDATE attachments SET status = 'pending', last_error = '' WHERE id = ?").run(attachment.id);
      const signal = AbortSignal.timeout(this.#downloadTimeoutMs);
      const loaded = await untilAbort(source.load({ signal, maxBytes: this.#maxFileBytes }), signal);
      const value = Buffer.isBuffer(loaded) || loaded instanceof Uint8Array
        ? loaded : loaded?.stream ?? loaded?.data ?? loaded?.buffer ?? loaded;
      const stream = Buffer.isBuffer(value) || value instanceof Uint8Array ? [value] : value;
      if (!stream || !(Symbol.asyncIterator in Object(stream) || Symbol.iterator in Object(stream))) throw invalid('文件下载未返回内容。');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'w', 0o600);
      let size = 0;
      iterator = stream[Symbol.asyncIterator]?.() ?? stream[Symbol.iterator]();
      while (true) {
        const { value: chunk, done } = await untilAbort(iterator.next(), signal);
        if (done) break;
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > this.#maxFileBytes) throw invalid('文件超过群文件保存大小上限。');
        await handle.writeFile(bytes);
      }
      await handle.close(); handle = null;
      const message = this.#db.prepare('SELECT sent_at FROM messages WHERE id = ?').get(messageId);
      if (!message || message.sent_at < this.cutoff()) throw invalid('消息已过期，未保存文件。');
      await rename(temporary, path);
      this.#db.prepare("UPDATE attachments SET status = 'ready', relative_path = ?, size_bytes = ?, last_error = '' WHERE id = ?")
        .run(relativePath, size, attachment.id);
    } catch (error) {
      // A provider that ignores abort must not hold a download slot forever.
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      this.#db.prepare("UPDATE attachments SET status = ?, last_error = ? WHERE id = ?")
        .run(error.code === 'group-history-invalid' ? 'unavailable' : 'failed',
          error.code === 'group-history-invalid' ? error.message : '文件下载失败或链接已过期。', attachment.id);
    }
  }

  idle() { return this.#active.size || this.#jobs.size ? new Promise((done) => this.#idle.push(done)) : Promise.resolve(); }

  async query(groupId, { kind = 'messages', from, to, keyword = '', cursor, limit = 100 } = {}) {
    await this.ready();
    if (this.#settingsError) throw invalid(this.#settingsError);
    const group = this.#db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    if (!group) throw invalid('当前群没有已保存记录。');
    if (!['messages', 'files'].includes(kind)) throw invalid('查询类型无效。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('每页条数必须为 1–100。');
    const lower = Math.max(this.cutoff(), from === undefined ? this.cutoff() : timestamp(from, NaN));
    const upper = to === undefined ? this.#now() : timestamp(to, NaN);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw invalid('时间范围无效。');
    let after = [lower, ''];
    if (cursor) {
      try {
        const data = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (data.groupId !== groupId || data.kind !== kind || !Number.isSafeInteger(data.time) || typeof data.id !== 'string') throw new Error();
        after = [data.time, data.id];
      } catch { throw invalid('分页游标无效。'); }
    }
    const table = kind === 'files' ? 'attachments a JOIN messages m ON m.id = a.message_id' : 'messages m';
    const id = kind === 'files' ? 'a.id' : 'm.id';
    const content = kind === 'files' ? 'a.name' : 'm.text';
    const fields = kind === 'files' ? 'a.*, m.sent_at' : 'm.*';
    const rows = this.#db.prepare(`SELECT ${fields} FROM ${table} WHERE m.group_id = ? AND m.sent_at >= ? AND m.sent_at <= ?
      AND (m.sent_at > ? OR (m.sent_at = ? AND ${id} > ?)) AND instr(lower(${content}), lower(?)) > 0
      ORDER BY m.sent_at, ${id} LIMIT ?`).all(groupId, lower, upper, after[0], after[0], after[1], text(keyword), limit + 1);
    const items = []; let bytes = 0; let last;
    for (const row of rows.slice(0, limit)) {
      let item;
      if (kind === 'files') item = { ...attachmentView(row), sentAt: row.sent_at };
      else item = { id: row.id, messageId: row.platform_message_id, senderId: row.sender_id, senderName: row.sender_name,
        sentAt: row.sent_at, type: row.type, text: row.text.slice(0, 8000), textTruncated: row.text.length > 8000,
        threadId: row.thread_id, replyToMessageId: row.reply_to_message_id,
        attachments: this.#db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY source_attachment_key LIMIT 11').all(row.id).map(attachmentView) };
      if (item.attachments?.length > 10) { item.attachments.pop(); item.attachmentsTruncated = true; }
      // Bound even the first item, including UTF-8 text and many attachment names.
      while (Buffer.byteLength(JSON.stringify(item)) > 20_000) {
        if (item.attachments?.length) { item.attachments.pop(); item.attachmentsTruncated = true; }
        else { item.text = item.text.slice(0, Math.floor(item.text.length / 2)); item.textTruncated = true; }
      }
      const length = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + length > 20_000) break;
      items.push(item); bytes += length; last = row;
    }
    return { groupName: group.name || group.platform_group_id, retentionDays: this.#days,
      recordingStartedAt: group.recording_started_at, from: lower, to: upper, items,
      nextCursor: last && rows.length > items.length ? Buffer.from(JSON.stringify({ groupId, kind, time: last.sent_at, id: last.id })).toString('base64url') : null,
      coverage: 'Only messages actually received by this plugin; not complete platform history.' };
  }

  /**
   * Newest-first slice of an archived group, joined with attachment counts and
   * the quoted message's sender/text so the outline digest can annotate replies
   * without a second round trip.
   *
   * Read-only and never paged: callers bound the window by both time and rows,
   * and the digest layer trims further by a character budget.
   */
  async recentMessages(groupId, { since, before = this.#now(), keyword = '', limit = 100 } = {}) {
    await this.ready();
    if (this.#settingsError) throw invalid(this.#settingsError);
    const group = this.#db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    if (!group) throw invalid('当前群没有已保存记录。');
    const rows = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 100));
    const lower = Math.max(this.cutoff(), Number.isFinite(since) ? since : this.cutoff());
    const items = this.#db.prepare(`SELECT m.platform_message_id AS message_id, m.sender_id, m.sender_name,
        m.sent_at, m.type, m.text, m.reply_to_message_id, m.ref,
        (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) AS file_count,
        (SELECT group_concat(a.relative_path, '|') FROM attachments a
          WHERE a.message_id = m.id AND a.relative_path IS NOT NULL) AS file_paths,
        r.sender_name AS reply_sender_name, r.text AS reply_text
      FROM messages m
      LEFT JOIN messages r ON r.group_id = m.group_id AND r.platform_message_id = m.reply_to_message_id
      WHERE m.group_id = ? AND m.sent_at >= ? AND m.sent_at <= ? AND instr(lower(m.text), lower(?)) > 0
      ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`).all(groupId, lower, before, text(keyword, 160), rows + 1);
    const keep = rows < items.length ? items.slice(0, rows) : items;
    return {
      groupName: group.name || group.platform_group_id,
      retentionDays: this.#days,
      since: lower,
      truncated: rows < items.length,
      items: keep.map((row) => ({
        messageId: String(row.message_id),
        ref: row.ref == null ? '' : String(row.ref),
        senderId: String(row.sender_id ?? ''),
        senderName: typeof row.sender_name === 'string' ? row.sender_name : '',
        sentAt: Number(row.sent_at),
        type: row.type,
        text: typeof row.text === 'string' ? row.text : '',
        replyToMessageId: row.reply_to_message_id == null ? null : String(row.reply_to_message_id),
        fileCount: Number(row.file_count ?? 0),
        // Absolute paths of the archived files, so a context replay can show an
        // image instead of just claiming that an attachment existed.
        imagePaths: String(row.file_paths ?? '')
          .split('|')
          .filter(Boolean)
          .map((relative) => join(this.#root, relative))
          .filter((absolute) => IMAGE_FILE.test(absolute)),
        replySenderName: typeof row.reply_sender_name === 'string' ? row.reply_sender_name : '',
        replyText: typeof row.reply_text === 'string' ? row.reply_text : '',
      })),
    };
  }

  /**
   * Groups this channel has archived, newest activity first.
   *
   * Used by channel settings that are scoped per chat (Telegram's per-group
   * reply rules) so the panel can offer real chat IDs with their titles.
   */
  /**
   * Resolve the archive row id for a platform chat id.
   *
   * Commands arrive with the platform's chat id (the Discord channel id), while
   * the digest API is keyed by the internal group row; this is the one mapping
   * an adapter needs to read a chat's own history without a session binding.
   */
  async findGroupId(platformGroupId, { channel = 'discord' } = {}) {
    await this.ready();
    const id = String(platformGroupId ?? '').trim();
    if (!id || !GROUP_HISTORY_CHANNELS.includes(channel)) return null;
    const row = this.#db.prepare('SELECT id FROM groups WHERE channel = ? AND platform_group_id = ?')
      .get(channel, id);
    return row ? row.id : null;
  }

  /**
   * Resolve a `#mXXXX` number to the row it belongs to inside one group.
   *
   * The number column is uniquely indexed, so this is a single index seek even
   * when the archive holds months of traffic.
   */
  async findByRef(groupId, ref) {
    await this.ready();
    const wanted = String(ref ?? '').trim().replace(/^#/u, '').replace(/^m/u, '').toLowerCase();
    if (!wanted) return null;
    const row = this.#db.prepare(`SELECT id, group_id, platform_message_id, ref, sender_id, sender_name,
        sent_at, type, text, reply_to_message_id FROM messages WHERE group_id = ? AND ref = ?`).get(groupId, wanted);
    if (!row) return null;
    return { ...this.#rowView(row), rowId: String(row.id) };
  }

  /**
   * The rows surrounding a numbered message, oldest first.
   *
   * Anchoring on a number is how "what was #m3f2a replying to?" becomes an
   * indexed range read instead of a full scan, and the neighbours make the
   * quoted line readable even when it fell outside the normal window.
   */
  async windowAroundRef(groupId, ref, { before = 6, after = 6 } = {}) {
    const anchor = await this.findByRef(groupId, ref);
    if (!anchor) return null;
    const head = Math.min(Math.max(Number(before) || 0, 0), 40);
    const tail = Math.min(Math.max(Number(after) || 0, 0), 40);
    const select = `SELECT m.id, m.group_id, m.platform_message_id, m.ref, m.sender_id, m.sender_name,
        m.sent_at, m.type, m.text, m.reply_to_message_id,
        (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) AS file_count,
        (SELECT group_concat(a.relative_path, '|') FROM attachments a
          WHERE a.message_id = m.id AND a.relative_path IS NOT NULL) AS file_paths,
        r.sender_name AS reply_sender_name, r.text AS reply_text
      FROM messages m
      LEFT JOIN messages r ON r.group_id = m.group_id AND r.platform_message_id = m.reply_to_message_id`;
    const older = head
      ? this.#db.prepare(`${select} WHERE m.group_id = ? AND (m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))
          ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`).all(groupId, anchor.sentAt, anchor.sentAt, anchor.rowId, head)
      : [];
    const newer = tail
      ? this.#db.prepare(`${select} WHERE m.group_id = ? AND (m.sent_at > ? OR (m.sent_at = ? AND m.id > ?))
          ORDER BY m.sent_at, m.id LIMIT ?`).all(groupId, anchor.sentAt, anchor.sentAt, anchor.rowId, tail)
      : [];
    const anchorRow = this.#db.prepare(`${select} WHERE m.id = ?`).get(anchor.rowId);
    const rows = [...older.reverse(), ...(anchorRow ? [anchorRow] : []), ...newer];
    return {
      anchor,
      items: rows.map((row) => ({ ...this.#rowView(row), fileCount: Number(row.file_count ?? 0),
        imagePaths: this.#imagePaths(row.file_paths), replySenderName: typeof row.reply_sender_name === 'string' ? row.reply_sender_name : '',
        replyText: typeof row.reply_text === 'string' ? row.reply_text : '' })),
    };
  }

  #imagePaths(value) {
    return String(value ?? '').split('|').filter(Boolean)
      .map((relative) => join(this.#root, relative)).filter((absolute) => IMAGE_FILE.test(absolute));
  }

  #rowView(row) {
    return {
      messageId: String(row.platform_message_id),
      ref: row.ref == null ? '' : String(row.ref),
      senderId: String(row.sender_id ?? ''),
      senderName: typeof row.sender_name === 'string' ? row.sender_name : '',
      sentAt: Number(row.sent_at),
      type: row.type,
      text: typeof row.text === 'string' ? row.text : '',
      replyToMessageId: row.reply_to_message_id == null ? null : String(row.reply_to_message_id),
    };
  }

  async listGroups({ channel } = {}) {
    await this.ready();
    if (!GROUP_HISTORY_CHANNELS.includes(channel)) return [];
    const rows = this.#db.prepare(`SELECT g.platform_group_id AS chat_id, g.name AS title,
        g.last_received_at AS last_received_at, g.capability AS capability,
        (SELECT m.sender_name FROM messages m WHERE m.group_id = g.id
          ORDER BY m.sent_at DESC, m.received_at DESC LIMIT 1) AS last_sender_name
      FROM groups g WHERE g.channel = ? ORDER BY coalesce(g.last_received_at, 0) DESC`).all(channel);
    return rows.map((row) => ({
      chatId: String(row.chat_id),
      title: typeof row.title === 'string' && row.title ? row.title : null,
      // The archive stores no chat type; the platform reported a group.
      type: null,
      lastSeenAt: Number.isSafeInteger(row.last_received_at) && row.last_received_at > 0
        ? new Date(row.last_received_at).toISOString() : null,
      lastSenderName: typeof row.last_sender_name === 'string' && row.last_sender_name
        ? row.last_sender_name : null,
    }));
  }

  async materialize(groupId, attachmentId, workspace) {
    await this.ready();
    if (this.#settingsError) throw invalid(this.#settingsError);
    const row = this.#db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE a.id = ? AND m.group_id = ? AND m.sent_at >= ?`).get(attachmentId, groupId, this.cutoff());
    if (!row || row.status !== 'ready' || !row.relative_path) throw invalid('该文件不属于当前群、已过期或尚未下载成功。');
    if (typeof workspace !== 'string' || !workspace) throw invalid('当前会话没有可用的文件目录。');
    const staged = await stageInboundFiles({ files: [{ name: row.name, mediaType: row.mime_type,
      load: () => ({ stream: createReadStream(join(this.#root, row.relative_path)) }),
    }] }, { workspace, retention: this.#copyService?.stagingRetention() ?? 'turn',
      onStagedDirectory: this.#copyService ? (directory) => this.#copyService.trackDirectory(directory) : null });
    const tracked = this.#copyService?.trackStaged(staged) ?? staged;
    return { ...attachmentView(row), path: resolve(workspace, staged.files[0].path), cleanup: () => tracked.cleanup(),
      note: 'Session copy. Read this file to inspect its contents; the shared original is unchanged.' };
  }

  sweep() {
    if (this.#sweep) return this.#sweep;
    this.#sweep = this.#maintenance.catch(() => {}).then(() => this.#sweepExpired()).finally(() => { this.#sweep = null; });
    this.#maintenance = this.#sweep;
    return this.#sweep;
  }

  async #sweepExpired() {
    await this.ready();
    if (this.#settingsError) return { deletedMessages: 0, error: this.#settingsError };
    let deletedMessages = 0;
    const cutoff = this.cutoff();
    let after = [0, ''];
    while (true) {
      const rows = this.#db.prepare(`SELECT id,group_id,sent_at FROM messages WHERE sent_at < ?
        AND (sent_at > ? OR (sent_at = ? AND id > ?)) ORDER BY sent_at,id LIMIT 500`).all(cutoff, after[0], after[0], after[1]);
      if (!rows.length) break;
      for (const message of rows) {
        after = [message.sent_at, message.id];
        const attachments = this.#db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(message.id);
        if (attachments.some((item) => this.#active.has(item.id))) continue;
        for (const item of attachments) this.#jobs.delete(item.id);
        try {
          await rm(join(this.#root, 'group-files', message.group_id, message.id), { recursive: true, force: true });
          this.#db.prepare('DELETE FROM messages WHERE id = ? AND sent_at < ?').run(message.id, cutoff);
          deletedMessages += 1;
        } catch (error) { this.#warn(error); }
      }
    }
    return { deletedMessages };
  }

  close() { return this.#close ??= this.#shutdown(); }

  async #shutdown() {
    this.#closing = true;
    clearInterval(this.#timer);
    if (!this.#ready) return;
    await this.ready();
    await this.#maintenance.catch(() => {});
    await this.idle();
    await this.#sweep;
    this.#db.close();
  }
}

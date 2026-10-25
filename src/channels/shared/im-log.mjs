import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const writers = new Map();
const RANK = { debug: 0, info: 1, event: 1, warn: 2, error: 3 };
const SECRET_KEY = /token|secret|password|authorization|cookie|credential|api[-_]?key/iu;
const CONTENT_KEY = /^(?:content|prompt|body|query|reason|text|transcript|senderName|title)$/iu;
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;

export function resolveImLogFile(channel = 'discord', env = process.env) {
  return join(env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'logs', `dsh-${channel}.log`);
}

function safeString(value) {
  return value.replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|authorization|cookie|api[-_]?key)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;}]+)/giu, '$1"[redacted]"')
    .replace(/\b[A-Za-z\d_-]{23,}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{20,}\b/gu, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[redacted]@').slice(0, 2048);
}

export function sanitizeLogValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return safeString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: safeString(value.name), message: safeString(value.message), code: typeof value.code === 'string' ? safeString(value.code) : undefined };
  if (typeof value !== 'object') return String(value);
  if (depth >= 4 || seen.has(value)) return '[bounded]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeLogValue(item, depth + 1, seen));
  const result = {};
  for (const key of Object.keys(value).slice(0, 24)) {
    if (SECRET_KEY.test(key) || CONTENT_KEY.test(key)) result[key] = '[redacted]';
    else { try { result[key] = sanitizeLogValue(value[key], depth + 1, seen); } catch { result[key] = '[unavailable]'; } }
  }
  return result;
}

function makeRecord(channel, level, event, args, maxLineBytes) {
  const safe = args.slice(0, 16).map(value => sanitizeLogValue(value));
  const record = { ts: new Date().toISOString(), level, channel, event: safeString(event).slice(0, 100),
    message: safe.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ') };
  if (level === 'event' && safe[0] && typeof safe[0] === 'object') record.data = safe[0];
  let line = JSON.stringify(record) + '\n';
  while (Buffer.byteLength(line) > maxLineBytes) {
    delete record.data; record.truncated = true;
    if (record.message.length) record.message = record.message.slice(0, Math.floor(record.message.length / 2));
    else if (record.event.length > 16) record.event = record.event.slice(0, Math.floor(record.event.length / 2));
    else if (record.channel.length > 8) record.channel = record.channel.slice(0, Math.floor(record.channel.length / 2));
    else throw new Error('Log record exceeds its bound');
    line = JSON.stringify(record) + '\n';
  }
  return { line, bytes: Buffer.byteLength(line), rank: RANK[level] };
}

function createWriter(target, { channel, maxBytes, backups, maxQueueBytes, maxLineBytes, flushMs, io }) {
  let queue = [], queuedBytes = 0, timer, active, initialized = false, size = 0, droppedPending = 0;
  const stats = { written: 0, dropped: 0, writeFailures: 0, rotations: 0 };
  const recordDrop = count => { stats.dropped += count; droppedPending += count; };
  const rotate = async () => {
    await io.unlink(`${target}.${backups}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (let index = backups - 1; index >= 1; index--) {
      await io.rename(`${target}.${index}`, `${target}.${index + 1}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await io.rename(target, `${target}.1`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    size = 0; stats.rotations++;
  };
  const append = async batch => {
    const bytes = batch.reduce((sum, item) => sum + item.bytes, 0);
    if (size + bytes > maxBytes) await rotate();
    await io.appendFile(target, batch.map(item => item.line).join(''), { encoding: 'utf8', mode: 0o600 });
    size += bytes; stats.written += batch.length;
  };
  const drain = async () => {
    if (!initialized) {
      try {
        await io.mkdir(dirname(target), { recursive: true });
        size = await io.stat(target).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
        initialized = true;
      } catch { stats.writeFailures++; recordDrop(queue.length); queue = []; queuedBytes = 0; return; }
    }
    if (droppedPending) {
      const count = droppedPending; droppedPending = 0;
      try { await append([makeRecord(channel, 'warn', 'logger.dropped', [{ count }], maxLineBytes)]); }
      catch { droppedPending += count; stats.writeFailures++; recordDrop(queue.length); queue = []; queuedBytes = 0; return; }
    }
    while (queue.length) {
      const batch = []; let bytes = 0;
      while (queue.length && bytes + queue[0].bytes <= Math.min(64 * 1024, maxBytes)) {
        const item = queue.shift(); batch.push(item); bytes += item.bytes; queuedBytes -= item.bytes;
      }
      try { await append(batch); }
      catch { stats.writeFailures++; initialized = false; recordDrop(batch.length + queue.length); queue = []; queuedBytes = 0; return; }
    }
  };
  const start = () => {
    clearTimeout(timer); timer = null;
    if (!active) active = drain().catch(() => { stats.writeFailures++; }).finally(() => { active = null; if (queue.length) schedule(); });
    return active;
  };
  const schedule = () => { if (!timer && !active) { timer = setTimeout(start, flushMs); timer.unref?.(); } };
  return {
    refs: 0,
    enqueue(level, event, args) {
      let item;
      try { item = makeRecord(channel, level, event, args, maxLineBytes); } catch { recordDrop(1); return; }
      while (queuedBytes + item.bytes > maxQueueBytes) {
        const index = queue.findIndex(entry => entry.rank < item.rank);
        if (index < 0) { recordDrop(1); schedule(); return; }
        queuedBytes -= queue[index].bytes; queue.splice(index, 1); recordDrop(1);
      }
      queue.push(item); queuedBytes += item.bytes; schedule();
    },
    async flush() { do { await start(); } while (queue.length); return { ...stats, queuedBytes }; },
    snapshot: () => ({ ...stats, queuedBytes, queuedRecords: queue.length }),
  };
}

const flushBeforeExit = () => { for (const writer of writers.values()) if (writer.snapshot().queuedRecords) void writer.flush(); };

/** A shared, bounded asynchronous writer; logging failures never stop delivery. */
export function createImFileLogger({ file, channel = 'discord', maxBytes, backups, maxQueueBytes, maxLineBytes, flushMs = 25,
  env = process.env, io = fs } = {}) {
  if (env.DSH_DISCORD_LOG === '0') return null;
  const target = resolve(file ?? resolveImLogFile(channel, env));
  const limit = bounded(maxBytes, 8 * 1024 * 1024, 512, 128 * 1024 * 1024);
  const lineLimit = bounded(maxLineBytes, Math.min(8192, limit), 256, limit);
  let writer = writers.get(target);
  if (!writer) {
    writer = createWriter(target, { channel: safeString(channel).slice(0, 40), maxBytes: limit,
      backups: bounded(backups, 5, 1, 20), maxLineBytes: lineLimit,
      maxQueueBytes: bounded(maxQueueBytes, 256 * 1024, lineLimit, 16 * 1024 * 1024), flushMs: bounded(flushMs, 25, 0, 1000), io });
    if (!writers.size) process.on('beforeExit', flushBeforeExit);
    writers.set(target, writer);
  }
  writer.refs++;
  let closed = false, closing;
  const level = RANK[env.DSH_DISCORD_LOG_LEVEL] ?? RANK.info;
  const write = (severity, event, args) => { if (!closed && RANK[severity] >= level) writer.enqueue(severity, event, args); };
  return {
    file: target, event: (name, data) => write('event', name, data === undefined ? [] : [data]),
    info: (...args) => write('info', 'log', args), warn: (...args) => write('warn', 'log', args),
    error: (...args) => write('error', 'log', args), debug: (...args) => write('debug', 'log', args),
    flush: () => writer.flush(), snapshot: () => writer.snapshot(),
    close() {
      if (closing) return closing;
      closed = true;
      closing = writer.flush().finally(() => {
        if (--writer.refs === 0 && writers.get(target) === writer) writers.delete(target);
        if (!writers.size) process.removeListener('beforeExit', flushBeforeExit);
      });
      return closing;
    },
  };
}

export function withFileLogger(logger, options = {}) {
  const file = createImFileLogger(options), env = options.env ?? process.env;
  const level = RANK[env.DSH_DISCORD_LOG_LEVEL] ?? RANK.info;
  const call = severity => (...args) => {
    if (RANK[severity] < level) return;
    let safe;
    try { safe = args.slice(0, 16).map(value => sanitizeLogValue(value)); } catch { safe = ['[unavailable]']; }
    file?.[severity](...safe);
    try { logger?.[severity]?.(...safe); } catch {}
  };
  return { ...(logger ?? {}), file: file?.file,
    event(name, data) {
      if (RANK.event < level) return;
      let safe;
      try { safe = sanitizeLogValue(data); } catch { safe = '[unavailable]'; }
      file?.event(name, safe);
      try { logger?.event?.(name, safe); } catch {}
    },
    info: call('info'), warn: call('warn'), error: call('error'), debug: call('debug'),
    flush: () => file?.flush() ?? Promise.resolve(), close: () => file?.close() ?? Promise.resolve(),
  };
}

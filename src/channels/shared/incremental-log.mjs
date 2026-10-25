import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

/** Bounded complete JSONL reads. An unfinished line is never persisted as text. */
export async function readLogDelta(file, previous, { maxBytes = 256 * 1024, backups = 5 } = {}) {
  const files = [];
  try {
    for (let index = backups; index >= 0; index--) {
      try {
        const handle = await open(index ? `${file}.${index}` : file, 'r');
        const stat = await handle.stat(); files.push({ handle, stat, id: identity(stat), current: index === 0 });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!files.some(entry => entry.current)) throw Object.assign(new Error('Log unavailable'), { code: 'ENOENT' });
    let position = previous ? files.findIndex(entry => entry.id === previous.id) : files.length - 1;
    const gap = Boolean(previous && position < 0);
    if (position < 0) position = 0;
    let cursor = previous && !gap ? { ...previous } : { id: files[position].id, offset: 0 };
    let bytesRead = 0, oversized = 0, text = '';
    for (; position < files.length && bytesRead < maxBytes; position++) {
      const entry = files[position];
      if (entry.id !== cursor.id) cursor = { id: entry.id, offset: 0 };
      if (cursor.offset > entry.stat.size) cursor = { id: entry.id, offset: 0 };
      if (cursor.anchor && cursor.offset && entry.stat.mtimeMs !== cursor.mtimeMs) {
        const length = Math.min(128, cursor.offset), bytes = Buffer.alloc(length);
        await entry.handle.read(bytes, 0, length, cursor.offset - length);
        if (hash(bytes) !== cursor.anchor) cursor = { id: entry.id, offset: 0 };
      }
      const length = Math.min(entry.stat.size - cursor.offset, maxBytes - bytesRead);
      if (length > 0) {
        const bytes = Buffer.alloc(length);
        const { bytesRead: count } = await entry.handle.read(bytes, 0, length, cursor.offset);
        bytesRead += count;
        const chunk = bytes.subarray(0, count), end = chunk.lastIndexOf(10);
        if (end >= 0) {
          let complete = chunk.subarray(0, end + 1);
          if (cursor.discarding) { complete = complete.subarray(complete.indexOf(10) + 1); cursor.discarding = false; }
          text += complete.toString('utf8').replace(/^\uFEFF/u, ''); cursor.offset += end + 1;
        } else if (count === maxBytes || cursor.discarding) {
          if (!cursor.discarding) oversized++;
          cursor.offset += count; cursor.discarding = true;
        }
      }
      const anchorLength = Math.min(128, cursor.offset), anchor = Buffer.alloc(anchorLength);
      if (anchorLength) await entry.handle.read(anchor, 0, anchorLength, cursor.offset - anchorLength);
      cursor.anchor = hash(anchor); cursor.mtimeMs = entry.stat.mtimeMs;
      if (cursor.offset < entry.stat.size && entry.current) break;
      if (cursor.offset < entry.stat.size && bytesRead >= maxBytes) break;
    }
    return { text, cursor, bytesRead, gap, oversized };
  } finally { await Promise.allSettled(files.map(entry => entry.handle.close())); }
}

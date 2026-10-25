import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createImFileLogger, withFileLogger } from '../src/channels/shared/im-log.mjs';
import { readLogDelta } from '../src/channels/shared/incremental-log.mjs';
import { monitorMusic } from '../scripts/monitor-music.mjs';
import { ensureHistoryReadState } from '../src/channels/shared/history-read-state.mjs';
import { GroupHistoryAccessRegistry, createGroupHistoryTools } from '../src/channels/shared/group-history-access.mjs';
import { createThreadDigestTool } from '../src/channels/shared/thread-digest.mjs';

async function scratch(run) {
  const root = resolve('work/test-context-log'); await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(join(root, 'case-'));
  try { await run(dir); } finally { assert(resolve(dir).startsWith(root + sep)); await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}
const parse = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const item = (id, text, sentAt = 9000) => ({ id, messageId: id, senderId: 'u', senderName: 'User', sentAt, text, fileCount: 0, attachments: [] });
function scope(context) {
  const registry = new GroupHistoryAccessRegistry(), session = { id: crypto.randomUUID(), events: [{ type: 'turn/start', data: { turn: 1 } }] };
  const close = registry.open(session.id, 'rpc', context); registry.observe(session, session.events[0]); registry.claim(session, { source: { rpcId: 'rpc' } }, 1);
  return { registry, session, exec: { agent: { session } }, close };
}

test('recent snapshots are shared inside one request, narrowed safely and not reused across groups', async () => {
  let reads = 0;
  const store = { query() {}, recentMessages: async () => { reads++; return { items: [item('b', 'topic newest', 9000), item('a', 'older', 8000)], truncated: false }; } };
  const context = { store, groupId: 'g' }, state = ensureHistoryReadState(context);
  await state.recent({ since: 0, before: 10000, limit: 10 });
  const smaller = await state.recent({ since: 8500, before: 10000, limit: 1, keyword: 'topic' });
  assert(smaller.cacheHit); assert.equal(smaller.record.items[0].messageId, 'b'); assert.equal(reads, 1);
  const other = ensureHistoryReadState({ store, groupId: 'other', readState: state });
  assert.notEqual(other, state); await other.recent({ since: 0, before: 10000, limit: 10 }); assert.equal(reads, 2);
  state.close(); await assert.rejects(state.recent({ since: 0, before: 10000, limit: 10 }), /ended/);
});

test('a truncated cache cannot claim to cover an older or sparse keyword query', async () => {
  let reads = 0;
  const state = ensureHistoryReadState({ groupId: 'g', store: { recentMessages: async () => { reads++; return { items: [item('1', 'newest')], truncated: true }; } } });
  await state.recent({ since: 0, before: 10000, limit: 1 });
  assert(!(await state.recent({ since: 0, before: 10000, limit: 10, keyword: 'older' })).cacheHit); assert.equal(reads, 2);
});

test('automatic context, digest and raw pages share exposures and only add missing details', async () => {
  let reads = 0; const events = [];
  const store = { query: async () => ({ groupName: 'g', items: [item('a', 'already supplied'), item('b', 'prefix and remaining details')], nextCursor: null }),
    recentMessages: async () => { reads++; return { groupName: 'g', items: [item('b', 'prefix and remaining details'), item('a', 'already supplied')], truncated: false }; } };
  const context = { store, groupId: 'g', requestedAt: 10000, logger: { event: (name, data) => events.push({ name, data }) } };
  const state = ensureHistoryReadState(context); state.remember([{ id: 'a', text: 'already supplied' }, { id: 'b', text: 'prefix' }]);
  await state.recent({ since: -3600000, before: 10000, limit: 20 });
  const f = scope(context);
  try {
    const value = await createThreadDigestTool(f.registry).execute({ reason: 'Read the remaining detail' }, f.exec);
    assert(!value.text.includes('already supplied')); assert(value.text.includes('remaining details')); assert.equal(reads, 1);
    const page = await createGroupHistoryTools(f.registry)[0].execute({ reason: 'Check exact archived wording' }, f.exec);
    assert.equal(page.items.length, 0);
    assert(events.some(event => event.name === 'context.cache' && event.data.cacheHit));
    assert(events.some(event => event.name === 'context.read' && event.data.calls === 2));
    assert(!JSON.stringify(events).includes('remaining detail')); assert.equal(new Set(events.map(event => event.data.traceId)).size, 1);
  } finally { f.close(); }
});

test('raw page truncation records only the delivered prefix and the next read fills the suffix', async () => {
  const full = 'a'.repeat(800) + 'missing suffix';
  const f = scope({ groupId: 'g', store: { query: async () => ({ items: [item('a', full)], nextCursor: null }) } });
  try {
    const tool = createGroupHistoryTools(f.registry)[0];
    const first = await tool.execute({ reason: 'Find the document text' }, f.exec); assert(first.items[0].textTruncated);
    const second = await tool.execute({ reason: 'Get missing document text', limit: 20 }, f.exec);
    assert.equal(second.items[0].text, 'missing suffix'); assert.equal(second.items[0].continuation, true);
  } finally { f.close(); }
});

test('logger batches asynchronously, redacts both sinks, disables debug by default and closes idempotently', async () => scratch(async dir => {
  const messages = [], file = join(dir, 'channel.log');
  const logger = withFileLogger({ info: (...args) => messages.push(args) }, { file, flushMs: 1000, env: {} });
  logger.info('operation token=FAKE_PRIVATE_VALUE', { authorization: 'FAKE_AUTH', content: 'FAKE_CHAT', nested: { apiKey: 'FAKE_KEY' } });
  logger.debug('debug should be off'); logger.event('context.read', { traceId: 'trace', shown: 3 });
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
  await logger.close(); await logger.close();
  const text = await fs.readFile(file, 'utf8'); assert.equal(parse(text).length, 2);
  for (const hidden of ['FAKE_PRIVATE_VALUE', 'FAKE_AUTH', 'FAKE_CHAT', 'FAKE_KEY', 'debug should be off']) {
    assert(!text.includes(hidden)); assert(!JSON.stringify(messages).includes(hidden));
  }
}));

test('queue overflow stays bounded, prioritizes errors and records a drop summary', async () => scratch(async dir => {
  const file = join(dir, 'burst.log'), logger = createImFileLogger({ file, maxQueueBytes: 1024, maxLineBytes: 512, flushMs: 1000, env: {} });
  try {
    for (let index = 0; index < 1000; index++) logger.info('ordinary-' + index + 'x'.repeat(100));
    logger.error('critical failure'); assert(logger.snapshot().queuedBytes <= 1024); assert(logger.snapshot().dropped > 0);
    await logger.flush(); const rows = parse(await fs.readFile(file, 'utf8'));
    assert(rows.some(row => row.event === 'logger.dropped')); assert(rows.some(row => row.message === 'critical failure'));
  } finally { await logger.close(); }
}));

test('rotation obeys byte and backup limits and multiple loggers serialize one target', async () => scratch(async dir => {
  const file = join(dir, 'rotate.log'), first = createImFileLogger({ file, maxBytes: 512, maxLineBytes: 256, backups: 5, env: {} });
  const second = createImFileLogger({ file, env: {} });
  try {
    for (let index = 0; index < 30; index++) { (index % 2 ? first : second).info('row-' + index + 'x'.repeat(100)); await first.flush(); }
    const paths = (await fs.readdir(dir)).filter(name => name.startsWith('rotate.log'));
    assert.equal(paths.length, 6);
    for (const name of paths) { assert((await fs.stat(join(dir, name))).size <= 512); parse(await fs.readFile(join(dir, name), 'utf8')); }
    await first.close(); second.error('after first close'); await second.close();
    assert((await fs.readFile(file, 'utf8')).includes('after first close'));
  } finally { await first.close(); await second.close(); }
}));

test('failed writes do not reject flush or spin, and a subsequent write recovers', async () => scratch(async dir => {
  let fails = true, appends = 0;
  const file = join(dir, 'recovery.log'), logger = createImFileLogger({ file, env: {}, io: { ...fs, appendFile: async (...args) => { appends++; if (fails) throw new Error('disk unavailable'); return fs.appendFile(...args); } } });
  try {
    logger.error('first'); const stats = await logger.flush(); assert.equal(stats.writeFailures, 1); assert.equal(appends, 1);
    fails = false; logger.info('recovered'); await logger.flush();
    assert((await fs.readFile(file, 'utf8')).includes('recovered'));
  } finally { await logger.close(); }
}));

test('incremental reads preserve split UTF-8 rows and read zero new bytes on unchanged files', async () => scratch(async dir => {
  const file = join(dir, 'partial.log'), bytes = Buffer.from(JSON.stringify({ message: '初音ミク' }) + '\n');
  const split = bytes.indexOf(Buffer.from('初')) + 1; await fs.writeFile(file, bytes.subarray(0, split));
  const first = await readLogDelta(file); assert.equal(first.text, ''); assert.equal(first.cursor.offset, 0);
  await fs.appendFile(file, bytes.subarray(split)); const second = await readLogDelta(file, first.cursor);
  assert.equal(JSON.parse(second.text).message, '初音ミク'); assert.equal((await readLogDelta(file, second.cursor)).bytesRead, 0);
}));

test('incremental reader drains the old inode after rotation before following the new file', async () => scratch(async dir => {
  const file = join(dir, 'rotation.log'); await fs.writeFile(file, '{"n":1}\n'); const first = await readLogDelta(file);
  await fs.appendFile(file, '{"n":2}\n'); await fs.rename(file, file + '.1'); await fs.writeFile(file, '{"n":3}\n');
  const second = await readLogDelta(file, first.cursor); assert.deepEqual(parse(second.text).map(row => row.n), [2, 3]); assert.equal(second.gap, false);
  await fs.writeFile(file, '{"n":4}\n'); const third = await readLogDelta(file, second.cursor); assert.deepEqual(parse(third.text).map(row => row.n), [4]);
}));

test('monitor consumes appended records once, does not persist raw partial content and reports a rotation gap', async () => scratch(async dir => {
  const logFile = join(dir, 'music.log'), stateFile = join(dir, 'state.json');
  const line = command => JSON.stringify({ ts: new Date().toISOString(), event: 'interaction.handled', message: JSON.stringify({ command }) }) + '\n';
  await fs.writeFile(logFile, line('play')); const first = await monitorMusic({ logFile, stateFile }); assert.equal(first.observedMusicInteractions, 1);
  const unchanged = await monitorMusic({ logFile, stateFile }); assert.equal(unchanged.logRead.bytes, 0);
  await fs.appendFile(logFile, '{"private":"FAKE_PRIVATE_TAIL'); await monitorMusic({ logFile, stateFile });
  assert(!(await fs.readFile(stateFile, 'utf8')).includes('FAKE_PRIVATE_TAIL'));
  await fs.rename(logFile, logFile + '.removed'); await fs.writeFile(logFile, line('music'));
  const rotated = await monitorMusic({ logFile, stateFile }); assert(rotated.logRead.gap); assert(rotated.notifications.some(entry => entry.code === 'log-coverage-gap'));
}));

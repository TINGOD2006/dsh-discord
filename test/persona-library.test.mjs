import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_PERSONA_CHARS } from '../src/channels/discord/persona-endpoints.mjs';
import {
  DiscordPersonaLibrary,
  MAX_PERSONAS,
  PERSONA_ID_PATTERN,
} from '../src/channels/discord/persona-library.mjs';

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'dsh-persona-'));
}

function root(home) {
  return join(home, 'integrations', 'dsh-discord');
}

async function withLibrary(fn) {
  const home = await tempHome();
  try {
    return await fn(new DiscordPersonaLibrary({ dshHome: home }), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('create writes an id-shaped body file and one index entry', () => withLibrary(async (library) => {
  const { id } = library.create({ name: 'A', text: '温柔' });
  assert.match(id, PERSONA_ID_PATTERN);
  assert.equal(await readFile(join(library.directory, `${id}.md`), 'utf8'), '温柔\n');
  assert.deepEqual(library.snapshot().items.map((item) => [item.id, item.name, item.chars]), [
    [id, 'A', 2],
  ]);
}));

test('two personas keep distinct files and insertion order', () => withLibrary(async (library) => {
  const first = library.create({ name: '一', text: 'a' }).id;
  const second = library.create({ name: '二', text: 'b' }).id;
  assert.notEqual(first, second);
  assert.deepEqual(library.snapshot().items.map((item) => item.id), [first, second]);
}));

test('save replaces the body and the name and moves updatedAt', () => withLibrary(async (library) => {
  const { id } = library.create({ name: '旧', text: 'x' });
  const before = library.snapshot().items[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  library.save({ id, name: '新', text: 'y' });
  assert.deepEqual(library.read(id).name, '新');
  assert.equal(library.read(id).text, 'y');
  assert.notEqual(library.snapshot().items[0].updatedAt, before);
}));

test('a crafted id cannot escape the personas directory', () => withLibrary(async (library) => {
  for (const id of ['../x', 'p_ZZZZZZ', 'p_abc', '', 'p_abcdef/../x', 'p_abcdef.md']) {
    assert.throws(() => library.read(id), (error) => error.code === 'persona-invalid', id);
    assert.throws(() => library.save({ id, text: 'y' }), (error) => error.code === 'persona-invalid', id);
  }
  // A well-formed but unknown id is a miss, not an invalid name.
  assert.throws(() => library.read('p_abcdef'), (error) => error.code === 'persona-not-found');
}));

test('the active persona cannot be deleted', () => withLibrary(async (library) => {
  const { id } = library.create({ name: 'A', text: 'x' });
  library.activate(id);
  assert.throws(() => library.remove(id), (error) => error.code === 'persona-active-undeletable');
  assert.equal(library.read(id).text, 'x');
}));

test('delete removes the body and the index entry', () => withLibrary(async (library) => {
  const keep = library.create({ name: 'A', text: 'x' }).id;
  library.activate(keep);
  const drop = library.create({ name: 'B', text: 'y' }).id;
  library.remove(drop);
  assert.deepEqual(library.snapshot().items.map((item) => item.id), [keep]);
  assert.deepEqual(await readdir(library.directory).then((names) => names.filter((name) => name.endsWith('.md'))),
    [`${keep}.md`]);
}));

test('the library refuses to grow past its cap', () => withLibrary(async (library) => {
  for (let index = 0; index < MAX_PERSONAS; index += 1) library.create({ name: `p${index}`, text: 'x' });
  assert.throws(() => library.create({ name: 'over', text: 'x' }), (error) => error.code === 'persona-limit');
}));

test('text over the size cap or with control characters is rejected before it is stored', () => withLibrary(async (library) => {
  const { id } = library.create({ name: 'A', text: 'x' });
  assert.throws(() => library.save({ id, text: 'x'.repeat(MAX_PERSONA_CHARS + 1) }),
    (error) => error.code === 'persona-invalid');
  assert.throws(() => library.save({ id, text: 'a\u0000b' }), (error) => error.code === 'persona-invalid');
  assert.equal(library.read(id).text, 'x');
}));

test('no active persona, a missing file and an empty file all mean "inject nothing"', () => withLibrary(async (library) => {
  assert.equal(library.activeText(), '');
  const { id } = library.create({ name: '空', text: '' });
  library.activate(id);
  assert.equal(library.activeText(), '');
  library.save({ id, name: '空', text: '' });
  assert.equal(library.activeText(), '');
}));

test('the active body is injected verbatim, without a wrapper', () => withLibrary(async (library) => {
  // DISCORD_PERSONA_PROMPT is the default body, not a wrapper around it; the
  // card starts from it and the operator may replace it entirely.
  const { id } = library.create({ name: 'A', text: '温柔地说话' });
  library.activate(id);
  assert.equal(library.activeText(), '温柔地说话');
}));

test('activate bumps the epoch and rejects an unknown persona', () => withLibrary(async (library) => {
  const { id } = library.create({ name: 'A', text: 'x' });
  assert.deepEqual(library.activate(id), { activeId: id, epoch: 1 });
  assert.deepEqual(library.activate(id), { activeId: id, epoch: 2 });
  assert.throws(() => library.activate('p_ffffff'), (error) => error.code === 'persona-not-found');
  assert.equal(library.snapshot().epoch, 2);
}));

test('a legacy persona.md becomes the first persona exactly once', () => withLibrary(async (library, home) => {
  await mkdir(root(home), { recursive: true });
  await writeFile(join(root(home), 'persona.md'), '旧人格\n', 'utf8');
  const migrated = library.read(library.snapshot().activeId);
  assert.equal(migrated.text, '旧人格');
  assert.equal(migrated.name, '预设');
  assert.equal(library.activeText().includes('旧人格'), true);
  const names = await readdir(root(home));
  assert.equal(names.includes('persona.md'), false);
  assert.equal(names.includes('persona.md.migrated'), true);
  // Second load must not migrate again or resurrect the file.
  const again = new DiscordPersonaLibrary({ dshHome: home });
  assert.deepEqual(again.snapshot().items.map((item) => item.id), [migrated.id]);
}));

test('a corrupted index is reported and treated as an empty library', () => withLibrary(async (library, home) => {
  await mkdir(join(root(home), 'personas'), { recursive: true });
  await writeFile(join(root(home), 'personas', 'index.json'), '{ not json', 'utf8');
  const warnings = [];
  const broken = new DiscordPersonaLibrary({ dshHome: home, logger: { warn: (message) => warnings.push(String(message)) } });
  assert.deepEqual(broken.snapshot().items, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /index\.json/u);
}));

test('the prompt side reads a persona activated elsewhere', () => withLibrary(async (library, home) => {
  const created = library.create({ name: 'B', text: '冷一点' });
  // The RPC handler and the prompt context are separate instances; the disk is
  // the channel between them, which is what makes a runtime switch visible.
  const promptSide = new DiscordPersonaLibrary({ dshHome: home });
  assert.equal(promptSide.activeText(), '');
  promptSide.activate(created.id);
  assert.equal(library.activeText(), '冷一点');
}));

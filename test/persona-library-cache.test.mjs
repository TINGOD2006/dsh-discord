import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DiscordPersonaLibrary } from '../src/channels/discord/persona-library.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-persona-cache-'));
  const library = new DiscordPersonaLibrary({ root });
  return { root, library, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function touch(path, contents) {
  writeFileSync(path, contents, 'utf8');
  // Force a distinct mtime so the stamp cache cannot mistake the edit for a hit.
  const next = new Date(Date.now() + 1000);
  utimesSync(path, next, next);
}

test('pointer() reports the active persona without reading every body', () => {
  const { library, cleanup } = fixture();
  try {
    const created = library.create({ name: '甲', text: '第一個人格' });
    library.activate(created.id);
    const pointer = library.pointer();
    assert.equal(pointer.activeId, created.id);
    assert.equal(pointer.epoch, 1);
    assert.deepEqual(Object.keys(pointer).sort(), ['activeId', 'epoch']);
  } finally {
    cleanup();
  }
});

test('an external edit to active.json is visible on the next pointer() call', () => {
  const { root, library, cleanup } = fixture();
  try {
    const created = library.create({ name: '甲', text: '第一個人格' });
    library.activate(created.id);
    assert.equal(library.pointer().epoch, 1);
    touch(join(root, 'personas', 'active.json'), `${JSON.stringify({ activeId: created.id, epoch: 7 })}\n`);
    assert.equal(library.pointer().epoch, 7);
  } finally {
    cleanup();
  }
});

test('an external edit to the persona body is visible on the next activeText() call', () => {
  const { root, library, cleanup } = fixture();
  try {
    const created = library.create({ name: '甲', text: '第一個人格' });
    library.activate(created.id);
    assert.equal(library.activeText(), '第一個人格');
    touch(join(root, 'personas', `${created.id}.md`), '改過的人格');
    assert.equal(library.activeText(), '改過的人格');
  } finally {
    cleanup();
  }
});

test('a mutation invalidates the cached index so snapshot() sees the new persona', () => {
  const { library, cleanup } = fixture();
  try {
    const first = library.create({ name: '甲', text: '一' });
    assert.equal(library.snapshot().items.length, 1);
    library.create({ name: '乙', text: '二二' });
    const items = library.snapshot().items;
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.id === first.id).chars, 1);
    assert.equal(items.find((item) => item.name === '乙').chars, 2);
  } finally {
    cleanup();
  }
});

test('the cached index still reflects a hand-edited index.json', () => {
  const { root, library, cleanup } = fixture();
  try {
    const created = library.create({ name: '甲', text: '一' });
    assert.equal(library.snapshot().items.length, 1);
    const indexPath = join(root, 'personas', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.items.push({ id: 'p_abcdef', name: '手動', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    touch(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const items = library.snapshot().items;
    assert.equal(items.length, 2);
    assert.ok(items.some((item) => item.id === 'p_abcdef'));
    assert.ok(items.some((item) => item.id === created.id));
  } finally {
    cleanup();
  }
});

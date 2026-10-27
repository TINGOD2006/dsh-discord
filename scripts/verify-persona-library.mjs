/**
 * Manual acceptance for the Discord persona library: drive the real module
 * against a throwaway DSH_HOME and let the filesystem answer.
 *
 * Run: node scripts/verify-persona-library.mjs
 *
 * Build and push are deliberately out of scope: this proves the store on disk,
 * not the bundled plugin (see the "交付方式" section of
 * docs/superpowers/plans/2026-10-27-discord-persona-library.md).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PERSONA_ID,
  DEFAULT_PERSONA_NAME,
  MAX_PERSONAS,
  PERSONA_ID_PATTERN,
  getDiscordPersonaLibrary,
} from '../src/channels/discord/persona-library.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'dsh-persona-verify-'));
const home = join(temporary, 'library');
const legacyHome = join(temporary, 'legacy');
const limitHome = join(temporary, 'limit');

const passed = [];
const failed = [];

function discordRoot(dshHome) {
  return join(dshHome, 'integrations', 'dsh-discord');
}

function check(label, body) {
  try {
    body();
    passed.push(label);
    console.log(`PASS ${label}`);
  } catch (error) {
    failed.push(label);
    const code = error?.code && !/^ERR_/u.test(error.code) ? ` (${error.code})` : '';
    console.log(`FAIL ${label}: ${error?.message ?? error}${code}`);
  }
}

/** The `error.code` of a throw, or null when the call unexpectedly succeeded. */
function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error?.code ?? null;
  }
  return null;
}

/** Later checks build on earlier state; say so instead of exploding on undefined. */
function needed(value, what) {
  if (value === undefined || value === null) {
    throw new Error(`missing ${what}; an earlier check failed`);
  }
  return value;
}

const state = {};
console.log(`Temporary DSH_HOME root: ${temporary}`);
const library = getDiscordPersonaLibrary({ dshHome: home });

// Design §12: neither persona.md nor personas/index.json means no active
// persona at all ("只建空索引…不注入"), so a fresh library lists nothing.
// p_default exists only after the legacy migration exercised below.
check('fresh library: no persona, epoch 0, injects nothing', () => {
  const snapshot = library.snapshot();
  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.activeId, null);
  assert.equal(snapshot.epoch, 0);
  assert.equal(library.activeText(), '');
  assert.equal(existsSync(join(discordRoot(home), 'persona.md')), false);
});

check('create: pattern-shaped id, body on disk, one list entry', () => {
  const { id } = library.create({ name: '测试人格', text: '第一版正文' });
  state.created = id;
  assert.match(id, PERSONA_ID_PATTERN);
  assert.notEqual(id, DEFAULT_PERSONA_ID);
  assert.deepEqual(library.snapshot().items.map((item) => [item.id, item.name, item.chars]), [
    [id, '测试人格', '第一版正文'.length],
  ]);
  assert.equal(readFileSync(join(library.directory, `${id}.md`), 'utf8'), '第一版正文\n');
});

check('save: body replaced, name kept, chars follow the body', () => {
  const id = needed(state.created, 'created persona');
  library.save({ id, text: '第二版正文' });
  assert.deepEqual(library.read(id), { id, name: '测试人格', text: '第二版正文' });
  assert.equal(library.snapshot().items[0].chars, '第二版正文'.length);
  const longer = '第二版正文，这一版长了不少。';
  library.save({ id, text: longer });
  assert.equal(library.read(id).text, longer);
  assert.equal(library.snapshot().items[0].chars, longer.length);
  assert.match(library.snapshot().items[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
});

check('activate: { activeId, epoch: 1 } and the snapshot follows', () => {
  const id = needed(state.created, 'created persona');
  const text = library.read(id).text;
  assert.deepEqual(library.activate(id), { activeId: id, epoch: 1 });
  const snapshot = library.snapshot();
  assert.equal(snapshot.activeId, id);
  assert.equal(snapshot.epoch, 1);
  assert.equal(library.activeText(), text);
});

check('remove: active persona is protected, a switched-away one goes away', () => {
  const id = needed(state.created, 'created persona');
  assert.equal(codeOf(() => library.remove(id)), 'persona-active-undeletable');
  // A fresh library has no p_default (design §12), so the replacement is a
  // second real persona rather than the migrated default.
  const spare = library.create({ name: '备用人格', text: '备用正文' }).id;
  state.spare = spare;
  assert.equal(library.activate(spare).epoch, 2);
  assert.deepEqual(library.remove(id), { ok: true });
  assert.equal(codeOf(() => library.read(id)), 'persona-not-found');
  assert.equal(codeOf(() => library.remove(id)), 'persona-not-found');
  assert.deepEqual(library.snapshot().items.map((item) => item.id), [spare]);
  assert.equal(library.activeText(), '备用正文');
  assert.equal(existsSync(join(library.directory, `${id}.md`)), false);
});

check('migration: legacy persona.md becomes p_default exactly once', () => {
  const legacyText = '你说话温柔、简短，先给结论。\n\n不要用清单。';
  const legacyPath = join(discordRoot(legacyHome), 'persona.md');
  mkdirSync(discordRoot(legacyHome), { recursive: true });
  writeFileSync(legacyPath, legacyText, 'utf8');

  const migrated = getDiscordPersonaLibrary({ dshHome: legacyHome });
  const snapshot = migrated.snapshot();
  assert.deepEqual(snapshot.items.map((item) => item.id), [DEFAULT_PERSONA_ID]);
  assert.equal(snapshot.activeId, DEFAULT_PERSONA_ID);
  assert.equal(snapshot.epoch, 0);
  assert.deepEqual(migrated.read(DEFAULT_PERSONA_ID), {
    id: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_NAME, text: legacyText,
  });
  assert.equal(migrated.activeText(), legacyText);
  assert.equal(existsSync(legacyPath), false);
  const archived = `${legacyPath}.migrated`;
  assert.equal(existsSync(archived), true);
  assert.equal(readFileSync(archived, 'utf8'), legacyText);
  assert.equal(existsSync(join(migrated.directory, 'index.json')), true);
  // A second load neither migrates again nor resurrects the old file.
  const again = getDiscordPersonaLibrary({ dshHome: legacyHome });
  assert.deepEqual(again.snapshot().items.map((item) => item.id), [DEFAULT_PERSONA_ID]);
  assert.equal(existsSync(legacyPath), false);
  // The migrated pointer starts at epoch 0, so the first real switch is 1.
  assert.deepEqual(again.activate(DEFAULT_PERSONA_ID), { activeId: DEFAULT_PERSONA_ID, epoch: 1 });
});

check(`limit: create stops at MAX_PERSONAS (${MAX_PERSONAS}) without partial writes`, () => {
  const limited = getDiscordPersonaLibrary({ dshHome: limitHome });
  for (let index = 0; index < MAX_PERSONAS; index += 1) {
    limited.create({ name: `人格 ${index}`, text: `第 ${index} 版` });
  }
  assert.equal(limited.snapshot().items.length, MAX_PERSONAS);
  assert.equal(codeOf(() => limited.create({ name: '溢出', text: '不该写入' })), 'persona-limit');
  assert.equal(limited.snapshot().items.length, MAX_PERSONAS);
  const bodies = readdirSync(limited.directory).filter((name) => name.endsWith('.md'));
  assert.equal(bodies.length, MAX_PERSONAS);
});

if (failed.length === 0) {
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    console.log(`Warning: could not remove ${temporary}: ${error?.message ?? error}`);
  }
} else {
  console.log(`Temp DSH_HOME kept for inspection: ${temporary}`);
}
console.log(`${passed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length === 0 ? 0 : 1;

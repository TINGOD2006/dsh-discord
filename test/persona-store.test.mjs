import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DISCORD_PERSONA_PROMPT, installDiscordPersona } from '../src/channels/discord/persona.mjs';
import { DiscordPersonaStore, normalizePersonaText } from '../src/channels/discord/persona-store.mjs';
import { MAX_PERSONA_CHARS } from '../src/channels/discord/persona-endpoints.mjs';
import { rememberSessionChannel, resetSessionChannels } from '../src/channels/shared/session-channel-registry.mjs';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'discord-persona-'));
  return {
    dir,
    path: join(dir, 'persona.md'),
    store: new DiscordPersonaStore({ path: join(dir, 'persona.md') }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Register the persona the way the host does and render it for one session. */
function renderFor(text, sessionId, channel) {
  resetSessionChannels();
  if (channel) rememberSessionChannel(sessionId, channel);
  let entry = null;
  installDiscordPersona({ systemPrompt: { context: (value) => { entry = value; } } }, { text });
  return entry.text({ agent: { session: { id: sessionId } } });
}

test('normalizePersonaText rejects empty unless the caller allows it', () => {
  assert.equal(normalizePersonaText(''), null);
  assert.equal(normalizePersonaText('   \n\t '), null);
  assert.equal(normalizePersonaText('', { allowEmpty: true }), '');
  assert.equal(normalizePersonaText('  \r\n ', { allowEmpty: true }), '');
  assert.equal(normalizePersonaText('  hi  ', { allowEmpty: true }), 'hi');
});

test('normalizePersonaText still rejects control characters and oversized text', () => {
  assert.equal(normalizePersonaText('a\u0007b', { allowEmpty: true }), null);
  assert.equal(normalizePersonaText('x'.repeat(MAX_PERSONA_CHARS + 1), { allowEmpty: true }), null);
  assert.equal(normalizePersonaText('x'.repeat(MAX_PERSONA_CHARS)), 'x'.repeat(MAX_PERSONA_CHARS));
  assert.equal(normalizePersonaText(null, { allowEmpty: true }), null);
});

test('an absent file means no persona, not the built-in default', () => {
  const { store, cleanup } = tempStore();
  try {
    const snapshot = store.snapshot();
    assert.equal(snapshot.text, '');
    assert.equal(snapshot.customized, false);
    assert.equal(snapshot.empty, true);
    assert.equal(snapshot.defaultText, DISCORD_PERSONA_PROMPT);
    assert.equal(store.text(), '');
  } finally {
    cleanup();
  }
});

test('saving an empty persona persists "no persona" instead of the default', () => {
  const { store, path, cleanup } = tempStore();
  try {
    const saved = store.write('');
    assert.equal(saved.text, '');
    assert.equal(saved.customized, true);
    assert.equal(saved.empty, true);
    assert.equal(saved.defaultText, DISCORD_PERSONA_PROMPT);
    assert.ok(existsSync(path));
    assert.equal(store.text(), '');
    // A second read from a fresh store must agree: the file is the source of truth.
    assert.equal(new DiscordPersonaStore({ path }).text(), '');
  } finally {
    cleanup();
  }
});

test('whitespace-only text saves as empty, and text with only newlines counts as empty', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(store.write('  \r\n\r\n ').empty, true);
    assert.equal(store.text(), '');
  } finally {
    cleanup();
  }
});

test('a hand-edited empty persona file also means "no persona"', () => {
  const { path, cleanup } = tempStore();
  try {
    writeFileSync(path, '\n', 'utf8');
    const store = new DiscordPersonaStore({ path });
    assert.equal(store.snapshot().empty, true);
    assert.equal(store.text(), '');
  } finally {
    cleanup();
  }
});

test('saving text keeps the trimmed body, and reset clears it to an empty file', () => {
  const { store, path, cleanup } = tempStore();
  try {
    const saved = store.write('  第一行\r\n第二行  ');
    assert.equal(saved.text, '第一行\n第二行');
    assert.equal(saved.customized, true);
    assert.equal(saved.empty, false);
    assert.equal(readFileSync(path, 'utf8'), '第一行\n第二行\n');
    const reset = store.reset();
    assert.equal(reset.text, '');
    assert.equal(reset.customized, true);
    assert.equal(reset.empty, true);
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(path, 'utf8'), '');
  } finally {
    cleanup();
  }
});

test('write rejects non-strings instead of clearing the persona', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.throws(() => store.write(undefined), { code: 'persona-invalid' });
    assert.throws(() => store.write(null), { code: 'persona-invalid' });
    assert.equal(store.snapshot().customized, false);
  } finally {
    cleanup();
  }
});

test('an empty persona renders nothing for Discord sessions and for everyone else', () => {
  assert.equal(renderFor('', 'sess-a', 'discord'), '');
  assert.equal(renderFor('', 'sess-b', null), '');
});

test('a non-empty custom persona still renders only for Discord sessions', () => {
  assert.equal(renderFor('自定义人格', 'sess-c', 'discord'), '自定义人格');
  assert.equal(renderFor('自定义人格', 'sess-d', 'weixin'), '');
});

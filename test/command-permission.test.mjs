import assert from 'node:assert/strict';
import test from 'node:test';

import { isSharedLocalCommand } from '../src/channels/shared/command-permission.mjs';

/*
 * `isSharedLocalCommand` decides whether an inbound message counts as a command,
 * which in turn feeds the access policy (a non-privileged sender may send plain
 * text but not commands). It had no test coverage, so this file pins the current
 * matrix — including the files-only carve-out, which is behaviour to review
 * rather than behaviour anyone designed on purpose:
 * a caption carrying a FILE never counts as a command, while one carrying an
 * IMAGE still does.
 */

test('plain text and blank input are not commands', () => {
  assert.equal(isSharedLocalCommand('hello'), false);
  assert.equal(isSharedLocalCommand(''), false);
  assert.equal(isSharedLocalCommand('   '), false);
  assert.equal(isSharedLocalCommand(null), false);
  assert.equal(isSharedLocalCommand(42), false);
});

test('text-only commands are recognised regardless of case or trailing space', () => {
  for (const text of ['/help', '/HELP', '/status', '/new', '/new ']) {
    assert.equal(isSharedLocalCommand(text), true, text);
  }
});

test('syntax commands and their arguments are recognised', () => {
  for (const text of ['/clear', '/history', '/history 3', '/mute 123', '/model gpt', '/workspace', '/compact', '/preset x']) {
    assert.equal(isSharedLocalCommand(text), true, text);
  }
});

test('an unknown slash command stays an ordinary prompt', () => {
  assert.equal(isSharedLocalCommand('/unknowncmd'), false);
  // `/help me` is not the bare command, so it is a prompt the model can answer.
  assert.equal(isSharedLocalCommand('/help me'), false);
});

test('messages that already carry queued input or a transcript request stay commands', () => {
  assert.equal(isSharedLocalCommand('/history', { hasFiles: true }), true);
  assert.equal(isSharedLocalCommand('/clear', { hasFiles: true }), true);
});

test('current carve-out: a file caption drops owner/model/preset commands to prompts', () => {
  assert.equal(isSharedLocalCommand('/mute 123', { hasFiles: true }), false);
});

test('current asymmetry: an image caption still counts as a command', () => {
  assert.equal(isSharedLocalCommand('/unmute', { hasImages: true }), true);
  assert.equal(isSharedLocalCommand('/model gpt', { hasImages: true }), true);
});

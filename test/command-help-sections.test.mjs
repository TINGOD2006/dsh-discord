import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_HELP_SECTIONS,
  commandHelpLines,
  commandHelpSections,
  commandsForChannel,
} from '../src/channels/shared/command-catalog.mjs';

const sectionOf = (sections, id) => sections.find((section) => section.id === id);

test('/help splits commands into titled sections', () => {
  const sections = commandHelpSections('discord');
  assert.ok(sections.length > 1, 'more than one section');
  assert.deepEqual(
    sections.map((section) => section.id),
    COMMAND_HELP_SECTIONS.map((section) => section.id).filter((id) => sectionOf(sections, id)),
    'sections keep the declared order',
  );
  for (const section of sections) {
    assert.equal(typeof section.title, 'string');
    assert.ok(section.title.length > 0, `section ${section.id} has a title`);
    assert.ok(section.lines.length > 0, `section ${section.id} is not empty`);
  }
});

test('commands land in the section a reader expects', () => {
  const sections = commandHelpSections('discord');
  const lines = (id) => sectionOf(sections, id).lines.join('\n');
  assert.match(lines('music'), /\/play/);
  assert.match(lines('music'), /\/music skip/);
  assert.match(lines('owner'), /\/mute/);
  assert.match(lines('owner'), /\/digest/);
  assert.match(lines('session'), /\/new/);
  assert.match(lines('workspace'), /\/sessionlist/);
  assert.match(lines('model'), /\/models/);
  assert.match(lines('misc'), /\/status/);
});

test('private-only session commands stay under 会话 rather than 群聊管理', () => {
  const owner = sectionOf(commandHelpSections('discord'), 'owner').lines.join('\n');
  const session = sectionOf(commandHelpSections('discord'), 'session').lines.join('\n');
  assert.doesNotMatch(owner, /\/batch/, 'batch is a session command');
  assert.match(session, /\/batch/);
});

test('sections cover exactly the same commands as the flat list', () => {
  const flat = commandHelpLines('discord').slice().sort();
  const grouped = commandHelpSections('discord')
    .flatMap((section) => section.lines)
    .sort();
  assert.deepEqual(grouped, flat);
  assert.equal(new Set(flat).size, flat.length, 'no help line is printed twice');
});

test('/skip says it is not the music skip', () => {
  const skip = commandsForChannel('discord').find((item) => item.name === 'skip');
  assert.match(skip.help.join('\n'), /\/music skip/);
});

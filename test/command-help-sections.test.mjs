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
  assert.match(lines('model'), /\/model \[/);
  assert.match(lines('model'), /不带参数时列出全部可用模型/);
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

test('折叠掉的命令不再出现在帮助里', () => {
  const names = new Set(commandsForChannel('discord').map((item) => item.name));
  for (const retired of ['skip', 'models', 'reasoninglist', 'presetlist', 'version', 'join', 'next', 'pause', 'resume', 'queue', 'leave']) {
    assert.equal(names.has(retired), false, `${retired} was folded into another command`);
  }
  const help = commandHelpLines('discord').join('\n');
  assert.doesNotMatch(help, /\/models/);
  assert.doesNotMatch(help, /\/skip/);
});

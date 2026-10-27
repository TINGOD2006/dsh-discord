import assert from 'node:assert/strict';
import test from 'node:test';

import { deferPersonaHandoff } from '../src/channels/discord/persona-epoch.mjs';

test('creating the deferred job does not run it', async () => {
  let ran = 0;
  deferPersonaHandoff(() => { ran += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, 0);
});

test('invoking the deferred job runs it exactly once', async () => {
  let ran = 0;
  const run = deferPersonaHandoff(() => { ran += 1; return { ok: true }; });
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, 1);
});

test('a skipped job is logged with its reason', async () => {
  const warnings = [];
  const run = deferPersonaHandoff(() => ({ ok: false, reason: 'too-short' }), {
    logger: { warn: (...parts) => warnings.push(parts.join(' ')) },
  });
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(warnings.join('\n'), /too-short/);
});

test('a failing job is logged instead of thrown', async () => {
  const warnings = [];
  const run = deferPersonaHandoff(async () => { throw new Error('rpc down'); }, {
    logger: { warn: (...parts) => warnings.push(parts.join(' ')) },
  });
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(warnings.join('\n'), /rpc down/);
});

test('a missing job becomes a no-op', async () => {
  const run = deferPersonaHandoff(null);
  assert.doesNotThrow(() => run());
  await new Promise((resolve) => setImmediate(resolve));
});

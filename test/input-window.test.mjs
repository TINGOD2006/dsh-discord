import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageInputWindow } from '../src/channels/shared/conversation/input-window.mjs';

/** Deterministic clock so the window's timers can be advanced by hand. */
function clock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const timer = { at: now + ms, fn }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = target;
    },
  };
}

function message(overrides = {}) {
  return {
    messageId: 'm1', senderId: 'u1', conversationId: 'c1', kind: 'group', content: '你', ...overrides,
  };
}

function windowWith(overrides = {}) {
  const time = clock();
  const window = new MessageInputWindow(message(), {
    quietMs: 100, maxWaitMs: 4000, graceMs: 0,
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    ...overrides,
  });
  return { window, time };
}

test('the window closes after the quiet period when nothing else arrives', () => {
  const { window, time } = windowWith();
  time.advance(99);
  assert.equal(window.closed, false);
  time.advance(1);
  assert.equal(window.closed, true);
});

test('a message inside the grace period still joins the turn', () => {
  const { window, time } = windowWith({ graceMs: 300 });
  time.advance(100);
  assert.equal(window.closed, false, 'the quiet timer must not close while the grace period is open');
  time.advance(200);
  assert.equal(window.closed, true);
});

test('maxWaitMs still wins over the grace period', () => {
  const { window, time } = windowWith({ graceMs: 300, maxWaitMs: 200 });
  time.advance(199);
  assert.equal(window.closed, false);
  time.advance(1);
  assert.equal(window.closed, true);
});

test('an append restarts the quiet timer and the grace period', () => {
  const { window, time } = windowWith({ graceMs: 300 });
  time.advance(50);
  assert.equal(window.append(message({ messageId: 'm2', content: '是' })), true);
  time.advance(299);
  assert.equal(window.closed, false, 'the grace period restarts from the last append');
  time.advance(1);
  assert.equal(window.closed, true);
  assert.equal(window.message.content, '你\n\n是');
});

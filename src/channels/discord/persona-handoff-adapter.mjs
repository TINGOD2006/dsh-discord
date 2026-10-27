import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { generateHandoff } from './persona-handoff.mjs';

/** Enough history for a summary, not a whole transcript. */
const MAX_HISTORY_MESSAGES = 80;

/** The summary is one extra model turn; keep it well under the Discord idle timeout. */
const HANDOFF_TIMEOUT_MS = 120_000;

const ISOLATED_TITLE = '[人格交接] 临时';

function previewText(content) {
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
    if (block?.type === 'image') return ['[图片]'];
    if (block?.type === 'file') return ['[文件]'];
    return [];
  }).join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
}

/**
 * Visible user/assistant turns of a session, in order.
 *
 * Mirrors `src/channels/shared/history-command.mjs`'s rule: only user appends
 * count as user turns, and an assistant turn only counts once its `turn/end`
 * reports a completed, non-interrupted turn — a tool-step aside is not an answer.
 */
export function visibleTurns(events) {
  const turns = [];
  const assistants = new Map();
  for (const event of events ?? []) {
    const data = event?.data;
    if (event?.type === 'user/message' && event.surfaceOp === 'append'
      && data?.source?.kind === 'user') {
      turns.push({ seq: event.seq, role: 'user', text: previewText(data.content) });
    } else if (event?.type === 'assistant/message' && event.surfaceOp === 'append'
      && Number.isSafeInteger(data?.turn) && data.turn >= 0) {
      assistants.set(data.turn, event);
    } else if (event?.type === 'turn/end') {
      const assistant = assistants.get(data?.turn);
      assistants.delete(data?.turn);
      if ((data?.reason?.kind ?? data?.reason) !== 'completed'
        || !assistant || assistant.data?.interrupted === true) continue;
      turns.push({
        seq: assistant.seq, role: 'assistant', text: previewText(assistant.data?.message?.content),
      });
    }
  }
  return turns
    .filter((turn) => turn.text)
    .sort((left, right) => left.seq - right.seq)
    .map(({ role, text }) => ({ role, text }));
}

/**
 * The real side effects behind `generateHandoff`.
 *
 * Reading history is a `session.history` RPC; the summary itself runs in a
 * throwaway session that is never bound to a conversation (so nothing appears in
 * Discord and the retired session's transcript is not rewritten). Failing to
 * rename it is cosmetic and is swallowed.
 */
export function createHandoffAdapter({ harness, config = {}, logger = null } = {}) {
  const warn = (message, detail) => logger?.warn?.(message, detail);

  const readHistory = async (sessionId) => {
    const { events } = await harness.readSessionHistory(sessionId, { maxMessages: MAX_HISTORY_MESSAGES });
    return visibleTurns(events);
  };

  const runIsolated = async (prompt) => {
    const sessionId = await harness.createSession({});
    try {
      await harness.renameSession(sessionId, ISOLATED_TITLE);
    } catch (error) {
      warn('[dsh-im:discord] handoff session rename failed:', error?.message ?? error);
    }
    const answer = await harness.ask(sessionId, prompt, { timeoutMs: HANDOFF_TIMEOUT_MS });
    return typeof answer === 'string' ? answer : '';
  };

  const write = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  };

  return {
    async generate({ key, sessionId }) {
      if (typeof key !== 'string' || !key || typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, reason: 'missing-input' };
      }
      const result = await generateHandoff(
        { readHistory, runIsolated, write, config },
        { sessionId, key },
      );
      if (!result.ok) {
        warn(`[dsh-im:discord] handoff for ${key} not written: ${result.reason}`);
      }
      return result;
    },
  };
}

/**
 * Recording plugin-authored notices into a Session transcript.
 *
 * A proactive delivery (another plugin pushing a share) reaches the chat
 * platform but never enters the conversation Session, so the model cannot
 * refer to it later. This appender writes the same text into the bound
 * Session as a plugin-sourced user message: visible in the GUI, visible to
 * the next model request, and ignored by the IM input path because its
 * `source.kind` is not `user`.
 *
 * A conversation Session is only live while its Agent is attached, and an
 * idle channel usually has none. The appender therefore resumes the Session
 * through the Session controller before writing, which is the same activation
 * a user message would perform — it starts no turn and sends nothing.
 */

import { randomUUID } from 'node:crypto';

/** Source kind of every message this plugin writes into a transcript. */
export const PLUGIN_SOURCE_KIND = 'plugin:dsh-im';

function serviceOf(ctx, name) {
  if (typeof ctx?.get !== 'function') return null;
  try {
    return ctx.get(name) ?? null;
  } catch {
    return null;
  }
}

/** Resolve the live Session for a session id, or null when it is not live. */
function liveSession(ctx, sessionId) {
  const agent = serviceOf(ctx, 'agents')?.get?.(sessionId);
  if (agent?.session) return agent.session;
  return serviceOf(ctx, 'sessions')?.get?.(sessionId) ?? null;
}

/**
 * Resolve the Session, resuming its Agent when the conversation is idle.
 *
 * `sessionController.resolveAgent` is the Host's own resolve-or-resume entry
 * point: it returns the live Agent, or resumes the persisted Session and
 * returns the new Agent. It throws a stable Session-domain error when the
 * Session is missing or owned elsewhere, which we report as "not live".
 */
async function resolveSession(ctx, sessionId) {
  const live = liveSession(ctx, sessionId);
  if (live) return live;
  const controller = serviceOf(ctx, 'sessionController');
  if (typeof controller?.resolveAgent !== 'function') return null;
  try {
    const agent = await controller.resolveAgent(sessionId);
    return agent?.session ?? liveSession(ctx, sessionId);
  } catch {
    return null;
  }
}

/**
 * Build the appender the delivery adapter uses.
 *
 * Returns null when the Session cannot be resolved so the caller can report a
 * clear error instead of silently dropping the record.
 */
export function createSessionAppender(ctx) {
  return async (sessionId, { text, source = {} } = {}) => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (typeof text !== 'string' || !text.trim()) return null;
    const session = await resolveSession(ctx, sessionId);
    if (!session || typeof session.append !== 'function') return null;
    return session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: PLUGIN_SOURCE_KIND, form: 'notice', ...source },
      },
      { surfaceOp: 'append' },
    );
  };
}

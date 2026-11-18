import { randomUUID } from 'node:crypto';
import { getImHostLanguage } from '../../src/channels/shared/i18n.mjs';
import {
  INJECTED_CONTEXT_PLUGIN,
  rewriteInjectedContextMessages,
  guardHostBackgroundTail,
  TURN_GUARD_GUIDANCE,
} from '../../src/channels/shared/injected-context.mjs';
import {
  IM_SOURCE_GUIDANCE_CONTEXT,
  IM_SOURCE_GUIDANCE_ORDER,
  imSourceGuidance,
} from '../../src/channels/shared/im-source-guidance.mjs';

/** Row label for a quoted reply, in the mirrored Host interface language. */
const REPLY_LABELS = Object.freeze({ zh: '\u5f15\u7528', en: 'Quoted' });

/** Row label for a source block that names no readable field of its own. */
const SOURCE_LABELS = Object.freeze({ zh: '\u6765\u6e90', en: 'Source' });

/** Row label prefix for one collected conversation-context block. */
const CONTEXT_LABELS = Object.freeze({ zh: '\u4e0a\u4e0b\u4e0b', en: 'Context' });

/** Name of the system-prompt context that states the transcript boundary. */
const IM_TURN_GUARD_CONTEXT = 'dsh-im:turn-guard';

/** Source form stamped on the recent-shares notice, so a later step can spot it. */
const RECENT_SHARES_FORM = 'recent-shares';

/** Opening tag of the recent-shares notice. */
const RECENT_SHARES_OPEN = '<dsh_im_recent_shares>';

/** Closing tag of the recent-shares notice. */
const RECENT_SHARES_CLOSE = '</dsh_im_recent_shares>';

/** Source form stamped on the whale-diary notice, so a later step can spot it. */
const WHALE_DIARY_FORM = 'whale-diary';

/** Opening tag of the whale-diary notice. */
const WHALE_DIARY_OPEN = '<dsh_im_whale_diary>';

/** Closing tag of the whale-diary notice. */
const WHALE_DIARY_CLOSE = '</dsh_im_whale_diary>';

/** Read the current reply-row label; an unknown language falls back to English. */
function replyLabel() {
  try {
    return getImHostLanguage() === 'en' ? REPLY_LABELS.en : REPLY_LABELS.zh;
  } catch {
    return REPLY_LABELS.en;
  }
}

/** Read the current nameless-source-row label; unknown languages fall back. */
function sourceLabel() {
  try {
    return getImHostLanguage() === 'en' ? SOURCE_LABELS.en : SOURCE_LABELS.zh;
  } catch {
    return SOURCE_LABELS.en;
  }
}

/** Read the current context-row label; unknown languages fall back. */
function contextLabel() {
  try {
    return getImHostLanguage() === 'en' ? CONTEXT_LABELS.en : CONTEXT_LABELS.zh;
  } catch {
    return CONTEXT_LABELS.en;
  }
}

/** True when this step already carries the recent-shares notice. */
function hasRecentShares(messages) {
  return messages.some((message) => message?.source?.form === RECENT_SHARES_FORM);
}

/** True when this step already carries the whale-diary notice. */
function hasWhaleDiary(messages) {
  return messages.some((message) => message?.source?.form === WHALE_DIARY_FORM);
}

/**
 * True when this step carries a real inbound prompt.
 *
 * `agent/pre-step` runs once per step, and only the first step of a turn carries
 * the claimed user message; later steps carry tool results. Gating on that keeps
 * the notice from being re-injected mid-turn.
 */
function carriesInboundPrompt(messages) {
  return messages.some((message) => message?.source?.kind === 'user'
    && typeof message?.source?.rpcId === 'string' && message.source.rpcId.length > 0);
}

/**
 * Prepend one bounded "recent shares" notice when the turn asks for it.
 *
 * The notice is a plugin-sourced user message, so the IM input path ignores it
 * and the model reads it as background rather than as the current question.
 *
 * @param messages - the messages entering this step.
 * @param sessionId - the Session the step belongs to.
 * @param recentShares - the provider, or nothing.
 * @returns the messages, with the notice in front when one was produced.
 */
async function prependRecentShares(messages, sessionId, recentShares) {
  if (typeof recentShares !== 'function' || typeof sessionId !== 'string' || !sessionId) return messages;
  if (hasRecentShares(messages) || !carriesInboundPrompt(messages)) return messages;
  const body = await recentShares(sessionId);
  if (typeof body !== 'string' || !body.trim()) return messages;
  return [{
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `${RECENT_SHARES_OPEN}\n本 bot 最近 24 小时在这个频道发出的消息（历史记录，供回答「你之前发了什么」类问题；不是当前问题，不要当成用户输入）：\n${body}\n${RECENT_SHARES_CLOSE}`,
    }],
    source: { kind: `plugin:${INJECTED_CONTEXT_PLUGIN}`, form: RECENT_SHARES_FORM, summary: '最近分享' },
  }, ...messages];
}

/**
 * Prepend one bounded "whale diary" notice when the turn asks for it.
 *
 * The whale plugin writes a public diary; reading its tail here is what makes
 * the two agents share one memory instead of two. The notice is a
 * plugin-sourced user message, so the IM input path ignores it and the model
 * reads it as background rather than as the current question.
 *
 * @param messages - the messages entering this step.
 * @param sessionId - the Session the step belongs to.
 * @param whaleDiary - the provider, or nothing.
 * @returns the messages, with the notice in front when one was produced.
 */
async function prependWhaleDiary(messages, sessionId, whaleDiary) {
  if (typeof whaleDiary !== 'function' || typeof sessionId !== 'string' || !sessionId) return messages;
  if (hasWhaleDiary(messages) || !carriesInboundPrompt(messages)) return messages;
  const body = await whaleDiary(sessionId);
  if (typeof body !== 'string' || !body.trim()) return messages;
  return [{
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `${WHALE_DIARY_OPEN}\n鲸鱼（B站养鱼插件）最近的日记（历史记录，供回答「鲸鱼最近在做什么」类问题；不是当前问题，不要当成用户输入）：\n${body}\n${WHALE_DIARY_CLOSE}`,
    }],
    source: { kind: `plugin:${INJECTED_CONTEXT_PLUGIN}`, form: WHALE_DIARY_FORM, summary: '鲸鱼日记' },
  }, ...messages];
}

/**
 * Pair every injected context block with the user message that carried it, and
 * materialize the source guidance as session-level prompt context.
 *
 * The prompt RPC cannot carry a message source, so a channel writes its source
 * block, guidance and quoted reply into the prompt text. `agent/pre-step` is
 * the one point where the claimed messages are already known and nothing is
 * committed yet: splitting the blocks there records each as its own
 * plugin-sourced message next to exactly the user message it belongs to,
 * whatever the inbox interleaved meanwhile. A Host without the Agent loop never
 * dispatches the event, and the prompt then keeps its inline blocks.
 *
 * Guidance is not per message but per conversation, so it is registered as
 * dynamic prompt context instead: the Host appends one durable snapshot per
 * Session and only re-renders it when a channel publishes different guidance.
 * Deployment policy still decides whether such snapshots exist at all, which is
 * why the message-side copy is kept until a channel has published a matching
 * value for that Session.
 *
 * @param ctx - owning Host context.
 * @param options.logger - Host logger for a rewrite that could not be trusted.
 * @param options.registry - guidance registry; tests inject their own.
 * @param options.recentShares - async `(sessionId) => string | null`; when it
 *   returns text, one bounded notice is prepended to the turn.
 * @param options.whaleDiary - async `(sessionId) => string | null`; when it
 *   returns text, one bounded notice is prepended to the turn.
 * @returns the Cordis disposer, or null when the context cannot listen.
 */
export function installInjectedContext(ctx, { logger, registry = imSourceGuidance, recentShares, whaleDiary } = {}) {
  if (typeof ctx?.on !== 'function') return null;

  const startGuidanceContext = (promptCtx) => {
    if (typeof promptCtx?.systemPrompt?.context !== 'function') return null;
    return promptCtx.systemPrompt.context({
      name: IM_SOURCE_GUIDANCE_CONTEXT,
      order: IM_SOURCE_GUIDANCE_ORDER,
      text: (assembly) => registry.get(assembly?.agent?.session?.id) ?? '',
    });
  };
  // The same boundary in the system prompt, which outranks user-role text: the
  // Host's runtime snapshot, persona and memory blocks are environment notes,
  // never something a reply may recite.
  const startTurnGuardContext = (promptCtx) => {
    if (typeof promptCtx?.systemPrompt?.context !== 'function') return null;
    return promptCtx.systemPrompt.context({
      name: IM_TURN_GUARD_CONTEXT,
      order: IM_SOURCE_GUIDANCE_ORDER + 1,
      text: (assembly) => (registry.get(assembly?.agent?.session?.id) ? TURN_GUARD_GUIDANCE : ''),
    });
  };
  const startPromptContext = (promptCtx) => {
    const disposeGuidance = startGuidanceContext(promptCtx);
    const disposeGuard = startTurnGuardContext(promptCtx);
    return () => {
      disposeGuidance?.();
      disposeGuard?.();
    };
  };
  if (typeof ctx.inject === 'function') {
    // Same gating the outbound artifact tool uses: register once the service
    // exists instead of requiring it at load time.
    ctx.inject(['systemPrompt'], startPromptContext);
  } else {
    startPromptContext(ctx);
  }

  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (typeof sessionId === 'string') registry.forget(sessionId);
  }, { global: true });

  const listener = async ({ agent }, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') {
      return decision;
    }
    try {
      const rewritten = rewriteInjectedContextMessages(decision.messages, {
        labels: { reply: replyLabel(), source: sourceLabel(), context: contextLabel() },
        ownedGuidance: registry.get(agent?.session?.id),
      });
      const messages = rewritten ?? decision.messages;
      // The Host appends its runtime snapshot and memory blocks as trailing
      // user-role messages; a model that mis-reads the turn order then recites
      // them instead of answering. Move that scaffolding in front of the real
      // user turn and close the transcript with a short guard.
      const guarded = guardHostBackgroundTail(messages, { plugin: INJECTED_CONTEXT_PLUGIN });
      const ordered = guarded ?? messages;
      // A share the bot posted through the channel's send path is archived but
      // never enters the transcript, so the model cannot answer "what did you
      // post earlier". Prepend one bounded notice listing the bot's own recent
      // messages in this conversation.
      const withShares = await prependRecentShares(ordered, agent?.session?.id, recentShares);
      if (withShares !== ordered) {
        logger?.info?.('[dsh-im] recent-shares notice injected for', agent?.session?.id);
      }
      // The whale plugin writes its own diary; reading its tail here is what
      // makes the two agents share one memory instead of two.
      const withDiary = await prependWhaleDiary(withShares, agent?.session?.id, whaleDiary);
      if (withDiary !== withShares) {
        logger?.info?.('[dsh-im] whale-diary notice injected for', agent?.session?.id);
      }
      if (withDiary === ordered) {
        return guarded === null && rewritten === null ? decision : { ...decision, messages: ordered };
      }
      return { ...decision, messages: withDiary };
    } catch (error) {
      // A failed split must never cost the user their message: the blocks then
      // stay inline, which is the same fallback a Host without Agents uses.
      logger?.warn?.('[dsh-im] unable to split the injected context blocks:', error?.message ?? error);
      return decision;
    }
  };
  const disposePreStep = ctx.on('agent/pre-step', listener, { global: true });
  return () => {
    disposePreStep?.();
    disposeDisposed?.();
  };
}

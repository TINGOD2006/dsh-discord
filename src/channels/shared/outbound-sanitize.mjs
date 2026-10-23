/**
 * Last line of defence for chat-visible text.
 *
 * The memory/archive layer is an internal bookkeeping concern: node ids,
 * read-back reports and "archived" tails belong in the host logs, never in a
 * Discord message. The persona forbids writing them, but a prompt is not a
 * guarantee — a model can still echo an id it saw in context, so every
 * outbound text is filtered here as well.
 */

const NODE_ID = /\b(?:mem|node|memory)_[0-9]{8,}_[0-9a-z]{4,}\b/gi;

// Lines that only carry archive bookkeeping. They are dropped whole, because
// the useful part of a reply is never inside them.
const BOOKKEEPING_LINE = /(归档节点|归档好了|已写入记忆|记忆归档|读回\s*(?:bm25|校验)|bm25\s*命中|节点\s*id|记忆节点|cg\s+op=|CCG\s*六要素|灵枢)/i;

const TRAILING_SEPARATORS = /[，,、:：;；\-—\s]+$/;

export function stripInternalLeaks(text) {
  if (typeof text !== 'string' || !text) return text;
  const kept = text.split(/\r?\n/).filter((line) => {
    const plain = line.replace(NODE_ID, '').trim();
    if (!plain) return false;
    return !BOOKKEEPING_LINE.test(plain);
  });
  const joined = kept
    .map((line) => line.replace(NODE_ID, '').replace(TRAILING_SEPARATORS, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return joined;
}

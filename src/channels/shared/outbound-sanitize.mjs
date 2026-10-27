/**
 * Last line of defence for chat-visible text.
 *
 * Two families of internal text can reach a chat message by accident:
 *
 *  - memory/archive bookkeeping (node ids, read-back reports, "archived"
 *    tails) — the persona forbids writing them, but a prompt is not a
 *    guarantee, so lines carrying them are dropped here as well;
 *  - the prompt scaffolding around the conversation: the runtime-context
 *    snapshot, the host persona ("人格设定（AGENT.md）"), replay/memory blocks
 *    wrapped in <untrusted-memory>, and the injected <dsh_im_*> context tags.
 *    A model that mis-reads whose turn it is can continue the transcript and
 *    recite that tail verbatim after its answer, so everything from the first
 *    recognised marker onward is cut: the reply is the text *before* it, and
 *    nothing a user needs is ever inside the prompt.
 */

const NODE_ID = /\b(?:mem|node|memory)_[0-9]{8,}_[0-9a-z]{4,}\b/gi;

// Lines that only carry archive bookkeeping. They are dropped whole, because
// the useful part of a reply is never inside them.
const BOOKKEEPING_LINE = /(归档节点|归档好了|已写入记忆|记忆归档|读回\s*(?:bm25|校验)|bm25\s*命中|节点\s*id|记忆节点|cg\s+op=|CCG\s*六要素|灵枢)/i;

// '<' / '>' as well as the JSON-escaped \u003c / \u003e a carrier sometimes
// writes literally into the text.
const LT = String.raw`(?:<|\\u003c)`;
const GT = String.raw`(?:>|\\u003e)`;

// A line that opens the leaked prompt tail. Anchored (with the list/bold
// punctuation a model may add in front) so ordinary prose mentioning a
// directory or a persona keeps working.
const PROMPT_LINE = new RegExp([
  String.raw`^[\s>\-_*#]{0,8}人格[设設]定（AGENT\.md）`,
  String.raw`^[\s>\-_*#]{0,8}当前项目人格`,
  String.raw`^[\s>\-_*#]{0,8}#\s+dsh-discord 开发工作区`,
  String.raw`^[\s>\-_*#]{0,8}Current runtime context\.`,
  String.raw`^[\s>\-_*#]{0,8}This snapshot supersedes earlier runtime-context snapshots\.`,
  String.raw`^[\s>\-_*#]{0,8}Current working directory:`,
  String.raw`^[\s>\-_*#]{0,8}Current DSH file policy:`,
  String.raw`^[\s>\-_*#]{0,8}Approval policy:`,
  String.raw`^[\s>\-_*#]{0,8}Current DeepSeek Harness (?:implementation checkout|Web GUI URL):`,
  String.raw`^[\s>\-_*#]{0,8}适用(?:项目|文件)：`,
  String.raw`^[\s>\-_*#]{0,8}以下由\s*untrusted-memory`,
  String.raw`^[\s>\-_*#]{0,8}【(?:灵枢最近记忆|本会话近期对话)】`,
  String.raw`^[\s>\-_*#]{0,8}A skill is a reusable set of task-specific instructions`,
  String.raw`^[\s>\-_*#]{0,8}This catalog contains summaries only`,
].join('|'), 'i');

// The injected context tags can also open a line on their own after a blank
// line, which the line-anchored marker above already covers; this one catches
// the case where they are the very first thing on a line without punctuation.
const INLINE_PROMPT_TAG = new RegExp(
  String.raw`${LT}\s*\/?\s*(?:dsh_im_source|dsh_im_reply_to|untrusted-memory|system-reminder|available_skills)${GT}`,
  'gi',
);

// Everything after the first marker is reproduced prompt, never answer.
function cutPromptTail(text) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (PROMPT_LINE.test(line)) return lines.slice(0, index).join('\n');
    const tagAt = line.search(INLINE_PROMPT_TAG);
    if (tagAt !== -1) {
      return [...lines.slice(0, index), line.slice(0, tagAt)].join('\n');
    }
  }
  return text;
}

const TRAILING_SEPARATORS = /[，,、:：;；\-—\s]+$/;

export function stripInternalLeaks(text) {
  if (typeof text !== 'string' || !text) return text;
  const body = cutPromptTail(text);
  const kept = body.split(/\r?\n/).filter((line) => {
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

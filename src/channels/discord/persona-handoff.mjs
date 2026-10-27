/**
 * The handoff note a retired Discord Session leaves behind.
 *
 * A persona switch clears the bound Session, which throws away every bit of
 * context the old conversation had accumulated. Before that happens we ask the
 * model for one neutral, third-person summary and park it under
 * `<DSH_HOME>/integrations/dsh-discord/handoffs/<key>.md`, keyed by conversation
 * (`group:123`, `direct:456`). Whoever reads it next gets the gist without the
 * old persona bleeding through.
 *
 * Two shapes only: a pure prompt/text layer (`buildHandoffPrompt`,
 * `sanitizeHandoff`, path helpers — safe to import in tests and in the prompt
 * renderer) and a side-effect-free orchestrator (`generateHandoff`) that takes
 * every effect as a parameter, so nothing here can reach out on its own.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HANDOFF_DIR_NAME = 'handoffs';
export const MAX_HANDOFF_CHARS = 800;
// Four visible messages is the floor worth summarising: below that the "note"
// would be longer than the conversation it describes.
export const MIN_HANDOFF_TURNS = 4;
// Bound the prompt itself, not just the answer: a long thread must not turn the
// handoff request into the biggest thing the model sees all day.
export const MAX_TRANSCRIPT_TURNS = 40;
const MAX_TURN_CHARS = 400;
const ELLIPSIS = '…';

/**
 * A conversation key is a file name here, and colons (`group:123`) are illegal
 * on Windows. Replace every character outside a conservative safe set.
 */
function safeKey(key) {
  const flat = String(key ?? '').replace(/[^A-Za-z0-9._-]/gu, '-');
  // `..`/`.` survive the replacement and would escape the directory.
  if (flat === '' || flat === '.' || flat === '..') return '_';
  return flat;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.text === 'string')
    .map((message) => ({
      role: message.role,
      text: message.text.replace(/\r\n?/gu, '\n').trim(),
    }))
    .filter((message) => message.text !== '');
}

function clipTurn(text) {
  if (text.length <= MAX_TURN_CHARS) return text;
  return `${text.slice(0, MAX_TURN_CHARS - 1)}${ELLIPSIS}`;
}

export function handoffDirPath(config = {}) {
  // Same root as persona-store.mjs: one <DSH_HOME> switch moves both.
  const root = config?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(root, 'integrations', 'dsh-discord', HANDOFF_DIR_NAME);
}

export function handoffFilePath(config = {}, key) {
  return join(handoffDirPath(config), `${safeKey(key)}.md`);
}

/** The note for `key`, or '' when it was never written (or is unreadable). */
export function readHandoff(config = {}, key) {
  try {
    return sanitizeHandoff(readFileSync(handoffFilePath(config, key), 'utf8'));
  } catch {
    return '';
  }
}

/**
 * Ask for the note, or `null` when there is too little conversation to be worth
 * one. The three hard constraints are quoted so an operator reading the prompt
 * (and the model reading it) sees the same words.
 */
export function buildHandoffPrompt(messages) {
  const turns = normalizeMessages(messages);
  if (turns.length < MIN_HANDOFF_TURNS) return null;
  const transcript = turns
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((turn) => `[${turn.role === 'user' ? '用户' : '助手'}] ${clipTurn(turn.text)}`)
    .join('\n');
  return [
    '你是一名中立的记录者。下面是刚结束的一段 Discord 对话，请为接手的新助手写一份交接摘要。',
    '',
    '硬性要求：',
    '1. 全程使用「第三人称」：用「用户」「助手」指代，不要出现「我」。',
    '2. 「不要自称」：不要写「我是谁」「我会怎样」，你不是这段对话的参与者。',
    '3. 「不要模仿语气」：只陈述事实、决定与偏好，不要复刻原对话的口吻或情绪。',
    '4. 全文不超过 800 字，纯文本，不要标题、不要开场白，直接开始写。',
    '5. 只写对话里确实出现过的内容；不确定的宁可不写。',
    '',
    '摘要请覆盖（有就写，没有就跳过）：',
    '- 用户在做什么、关心什么；',
    '- 已经确认的决定、结论与数字；',
    '- 还没做完的事（待办、未解决的问题）；',
    '- 对称呼、语言、格式的偏好，以及明确的禁忌。',
    '',
    '对话记录（旧 → 新）：',
    transcript,
  ].join('\n');
}

/**
 * Force the model's answer into something injectable: no first-person opening,
 * no walls of blank lines, never longer than the budget. Idempotent, so reading
 * a stored note back through this is safe.
 */
export function sanitizeHandoff(text) {
  if (typeof text !== 'string') return '';
  let clean = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  if (clean === '') return '';
  // The model likes to open with "我是本次对话的助手……". Drop that opener, and
  // any leftover particle so "我们的对话" does not become "的对话".
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stripped = clean.replace(/^我(?:们)?(?:是|叫|会|想|要|觉得|认为|来|先)?[\s，,。.、:：;；!！?？—\-]*/u, '')
      .replace(/^本(?:人|助手|机|段|次|对话)[\s，,。.、:：;；!！?？—\-]*/u, '');
    if (stripped === clean) break;
    clean = stripped.trim();
  }
  clean = clean.replace(/^[的着了]\s*/u, '');
  clean = clean
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (clean.length > MAX_HANDOFF_CHARS) {
    clean = `${clean.slice(0, MAX_HANDOFF_CHARS - 1).trimEnd()}${ELLIPSIS}`;
  }
  return clean;
}

/**
 * Produce and store one handoff note.
 *
 * Every effect is injected — `readHistory(sessionId)` → `[{ role, text }]`,
 * `runIsolated(prompt)` → the model's answer, `write(path, text)` — so this
 * module owns no I/O and a failure on any leg degrades to `{ ok: false }`
 * instead of throwing into the message path.
 *
 * `config` is optional and only used to resolve the target path.
 */
/**
 * Turn one retired conversation into a note for the next Session.
 *
 * Every dependency is async because the real ones are RPC calls: reading the
 * transcript is `session.history`, the summary is one isolated model turn, and
 * the write is a file. Nothing here throws; every failure is a reason string, so
 * a switch can never fail because its summary did.
 */
export async function generateHandoff(deps = {}, { sessionId, key } = {}) {
  const { readHistory, runIsolated, write, config } = deps;
  let history;
  try {
    history = await readHistory?.(sessionId);
  } catch {
    return { ok: false, reason: 'history-failed' };
  }
  const prompt = buildHandoffPrompt(history);
  if (prompt === null) return { ok: false, reason: 'too-short' };
  let answer;
  try {
    answer = await runIsolated?.(prompt);
  } catch {
    return { ok: false, reason: 'model-failed' };
  }
  const summary = sanitizeHandoff(answer);
  // Whitespace-only means the model had nothing to say; storing '' would make
  // the injector think a note exists when it does not.
  if (summary === '') return { ok: false, reason: 'empty' };
  const path = handoffFilePath(config, key);
  try {
    await write?.(path, summary);
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, path };
}

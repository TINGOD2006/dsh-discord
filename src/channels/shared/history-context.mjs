// Shared filtering for automatic replay, digest and archive tools. The archive
// stays intact; only the model-facing view is filtered.
export const HISTORY_EXPOSURES = Symbol('history-exposures');
const STATUS = /^(?:(?:正在(?:处理|處理|思考|回覆|回覆中)|处理中|處理中|thinking|typing|已取消|已停止)(?:中)?[\s.…!！。]*|正在使用.{1,40}(?:…|\.{3,}))$/iu;
const CONTROL = /^\/(?:help|status|new|stop|skip|steer|digest|recall|thread|autoreply|mute|unmute|play|join|next|pause|resume|queue|leave|music|model|workspace|clear|reset|cancel|think)(?=$|\s)/iu;
const RECALL = /(?:(?:上面|前文|前面|刚才|剛才|剛剛|刚刚|刚说|剛才說|之前|先前|昨天|昨日|上次)[^，,。！？!?；;\n]{0,6}(?:说|說|讲|講|聊|提(?:到|過|过|起|及|的|了|問|问)|问|問|(?:发|發)(?:的|了|過|过|送|言|訊息|消息|文件|圖片|图片|檔案)|内容|內容|圖片|图片|檔案|文件))|(?:(?:翻|讀取|读取|讀|读|找|查|看|回溯|回顧|回顾|往前|總結|总结).{0,6}(?:记录|紀錄|历史|歷史|聊天|日志|日誌|對話|对话))|(?:更早的.{0,4}(?:消息|訊息|记录|紀錄|聊天))|\b(?:earlier|previous|past)\s+(?:messages?|chat|conversation|discussion|files?)\b|\b(?:what|who).{0,30}\b(?:say|said|discussed|mentioned)\b.{0,30}\b(?:earlier|previously)\b/iu;
const NEGATED_HISTORY = /(?:不要|不用|不必|不需要|無須|无需|別|别|do not|don't|no need to)\s*(?:再|先|去|額外|额外)?\s*(?:讀取|读取|讀|读|查(?:詢|询|找)?|翻(?:閱|阅)?|看|搜尋|搜索|回顧|回顾|read|search|look up|review).{0,16}(?:歷史|历史|記錄|记录|紀錄|messages?|history|archive|之前|先前|聊天)/iu;
// An unresolved object or discussion is a reference. A bare time/place word
// ("剛剛下雨", "上面印著 hello") does not justify reading the archive.
const REFERENCE = /(?:那(?:張|张|份)(?:圖片|图片|圖像|图像|照片|截圖|截图|檔案|文件|資料|资料|報告|报告)?)|(?:那(?:個|个)(?:問題|问题|方案|方法|檔案|文件|結論|结论|連結|链接|公式))|(?:那(?:個|个)(?=\s*(?:$|是|呢|怎|在|要|能|可以|代表|指)))|(?:(?:上面|前面)(?:這|这|那)(?:段|句|條|条)(?:文字|話|话|訊息|消息|內容|内容))|(?:(?:上面|前面|剛剛|刚刚|剛才|刚才)(?:的)?(?:訊息|消息|發言|发言|內容|内容|討論|讨论|圖片|图片|檔案|文件|結論|结论|問題|问题))|(?:(?:繼續|继续)(?:剛才|刚才|剛剛|刚刚|上次|之前|前面))|\b(?:that (?:image|file|message)|what about (?:that|it)|as (?:mentioned|discussed))\b/iu;
const PROVIDED_TEXT = /(?:這|这)(?:段|句)(?:文字|話|话|內容|内容)(?:是|為|为|[:：])\s*(?:「[^」]+」|“[^”]+”|"[^"\n]+"|`[^`]+`)/u;

function historyRequestText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/```[\s\S]*?```|`[^`]*`|「[^」]*」|“[^”]*”|"[^"\n]*"/gu, ' ')
    .split(/[，,。！？!?；;\n]|但是|但|而是|\bbut\b/iu).filter(part => !NEGATED_HISTORY.test(part)).join('，');
}

export function historyRecallRequested(text) {
  return RECALL.test(historyRequestText(text));
}

export function historyContextNeeded(message) {
  if (historyRecallRequested(message?.content)) return true;
  // The quoted reply or attached object is already delivered with this turn.
  // Explicit requests to review earlier discussion still take precedence above.
  if (message?.images?.length || message?.files?.length
    || (typeof message?.replyTo?.content === 'string' && message.replyTo.content.trim())
    || PROVIDED_TEXT.test(message?.content ?? '')) return false;
  return REFERENCE.test(historyRequestText(message?.content));
}

export function cleanHistoryText(value) {
  return typeof value === 'string' ? value.normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ').trim() : '';
}

export function historyNoise(text, fileCount = 0) {
  const value = cleanHistoryText(text).replace(/^<@!?\d+>\s*/u, '');
  return (!value && !fileCount) || STATUS.test(value) || CONTROL.test(value);
}

/**
 * Collapse decoration only on simple Han chatter. Symbols, word boundaries,
 * letter case, numbers and question marks may carry meaning and must survive.
 */
function repeatKey(senderId, replyToMessageId, text) {
  const chatter = text.replace(/[!！。…]+$/u, '').replace(/\s+/gu, '');
  const key = chatter.length <= 24 && /^\p{Script=Han}+$/u.test(chatter) ? chatter : text;
  return `${senderId}\0${replyToMessageId ?? ''}\0${key}`;
}

/** Input/output are newest first; repeated human statements far apart survive. */
export function filterHistoryRows(rows, { currentMessageId = '', seen = new Set(), keyword = '', senderId = '' } = {}) {
  const duplicate = new Map();
  const needle = cleanHistoryText(keyword).toLocaleLowerCase();
  return (rows ?? []).filter((row) => {
    const id = String(row?.messageId ?? row?.id ?? '');
    if (!id || id === currentMessageId || seen.has(id)) return false;
    const text = cleanHistoryText(row.text);
    const files = Number(row.fileCount ?? row.attachments?.length ?? 0);
    if (historyNoise(text, files)) return false;
    if (senderId && String(row.senderId) !== senderId) return false;
    if (needle && !text.toLocaleLowerCase().includes(needle)) return false;
    const key = repeatKey(row.senderId, row.replyToMessageId, text);
    const ts = Number(row.sentAt) || 0;
    const previous = duplicate.get(key);
    if (!files && previous !== undefined && Math.abs(previous - ts) <= 90_000) return false;
    duplicate.set(key, ts);
    return true;
  });
}

export function historyQueryKey(kind, args) {
  return `${kind}:${JSON.stringify(Object.fromEntries(Object.entries(args ?? {})
    .filter(([key, value]) => key !== 'reason' && value !== undefined).sort(([a], [b]) => a.localeCompare(b))))}`;
}

/** Keep pagination anchored to the last scanned record, never skip budgeted-out rows. */
export function boundHistoryPage(page, groupId, kind, maxChars, currentMessageId = '', readState) {
  const result = { ...page, groupName: cleanHistoryText(page.groupName).slice(0, 100), items: [], filtered: 0, budgetLimited: false };
  const exposures = [];
  let last;
  const duplicates = new Map();
  for (const item of page.items ?? []) {
    const text = cleanHistoryText(item.text);
    const duplicateKey = repeatKey(item.senderId, item.replyToMessageId, text);
    const previous = duplicates.get(duplicateKey);
    if (kind !== 'files' && ((currentMessageId && String(item.messageId ?? '') === currentMessageId)
      || historyNoise(text, item.attachments?.length ?? 0)
      || (!item.attachments?.length && previous !== undefined && Math.abs(previous - item.sentAt) <= 90_000))) {
      result.filtered++; last = item; continue;
    }
    duplicates.set(duplicateKey, item.sentAt);
    const missing = kind === 'files' ? null : readState?.missing(item.messageId ?? item.id, text);
    // Attachments may carry new evidence even when the text is already supplied.
    if (missing?.duplicate && !item.attachments?.length) { result.filtered++; last = item; continue; }
    const view = kind === 'files'
      ? { ...item, name: cleanHistoryText(item.name).slice(0, 160) }
      : { ...item, senderName: cleanHistoryText(item.senderName).slice(0, 60), text: (missing?.text ?? text).slice(0, 800),
        ...(missing?.prefix ? { continuation: true } : {}),
        textTruncated: item.textTruncated || (missing?.text ?? text).length > 800,
        attachments: (item.attachments ?? []).map(file => ({ ...file, name: cleanHistoryText(file.name).slice(0, 120) })) };
    result.items.push(view);
    if (result.items.length === 1) {
      while (JSON.stringify(result).length > maxChars - 350 && view.attachments?.length) { view.attachments.pop(); view.attachmentsTruncated = true; }
      while (JSON.stringify(result).length > maxChars - 350 && view.text?.length > 20) { view.text = view.text.slice(0, Math.floor(view.text.length / 2)); view.textTruncated = true; }
    }
    if (JSON.stringify(result).length > maxChars - 350) { result.items.pop(); result.budgetLimited = true; break; }
    if (kind !== 'files') exposures.push({ id: item.messageId ?? item.id, text: (missing?.prefix ?? '') + view.text });
    last = item;
  }
  if (result.budgetLimited && !last) throw new Error('Not enough history output budget for this record. Narrow the query or answer from the supplied evidence.');
  if (result.budgetLimited && last) result.nextCursor = Buffer.from(JSON.stringify({ groupId, kind, time: last.sentAt, id: last.id })).toString('base64url');
  Object.defineProperty(result, HISTORY_EXPOSURES, { value: exposures });
  return result;
}

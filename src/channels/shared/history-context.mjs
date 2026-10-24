// Shared filtering for automatic replay, digest and archive tools. The archive
// stays intact; only the model-facing view is filtered.
const STATUS = /^(?:(?:正在(?:处理|處理|思考|回覆|回覆中)|处理中|處理中|thinking|typing|已取消|已停止)(?:中)?[\s.…!！。]*|正在使用.{1,40}(?:…|\.{3,}))$/iu;
const CONTROL = /^\/(?:help|status|new|stop|skip|steer|digest|recall|thread|mute|unmute|play|join|next|pause|resume|queue|leave|music|model|workspace|clear|reset|cancel|think)(?=$|\s)/iu;
const RECALL = /(?:(?:上面|前文|前面|刚才|剛才|刚说|剛才說|之前|先前|昨天|昨日|上次).{0,6}(?:说|說|讲|講|聊|提|问|問|发|發|内容|內容|圖片|图片|檔案|文件))|(?:(?:翻|找|查|看|回溯|回顧|回顾|往前|總結|总结).{0,6}(?:记录|紀錄|历史|歷史|聊天|日志|日誌|對話|对话))|(?:更早的.{0,4}(?:消息|訊息|记录|紀錄|聊天))|\b(?:earlier|previous|past)\s+(?:messages?|chat|conversation|discussion|files?)\b|\b(?:what|who).{0,30}\b(?:say|said|discussed|mentioned)\b/iu;
const REFERENCE = /(?:那(?:張|张|個|个|份)|剛剛|刚刚|上面|前面|繼續剛|继续刚)|\b(?:that (?:image|file|message)|what about (?:that|it)|as (?:mentioned|discussed))\b/iu;

export function historyRecallRequested(text) {
  return typeof text === 'string' && RECALL.test(text);
}

export function historyContextNeeded(message) {
  return historyRecallRequested(message?.content)
    || (typeof message?.content === 'string' && REFERENCE.test(message.content));
}

export function cleanHistoryText(value) {
  return typeof value === 'string' ? value.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ').trim() : '';
}

export function historyNoise(text, fileCount = 0) {
  const value = cleanHistoryText(text).replace(/^<@!?\d+>\s*/u, '');
  return (!value && !fileCount) || STATUS.test(value) || CONTROL.test(value);
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
    const key = `${row.senderId}\0${row.replyToMessageId ?? ''}\0${text}`;
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
export function boundHistoryPage(page, groupId, kind, maxChars, currentMessageId = '') {
  const result = { ...page, groupName: cleanHistoryText(page.groupName).slice(0, 100), items: [], filtered: 0, budgetLimited: false };
  let last;
  const duplicates = new Map();
  for (const item of page.items ?? []) {
    const text = cleanHistoryText(item.text);
    const duplicateKey = `${item.senderId}\0${item.replyToMessageId ?? ''}\0${text}`;
    const previous = duplicates.get(duplicateKey);
    if (kind !== 'files' && ((currentMessageId && String(item.messageId ?? '') === currentMessageId)
      || historyNoise(text, item.attachments?.length ?? 0)
      || (!item.attachments?.length && previous !== undefined && Math.abs(previous - item.sentAt) <= 90_000))) {
      result.filtered++; last = item; continue;
    }
    duplicates.set(duplicateKey, item.sentAt);
    const view = kind === 'files'
      ? { ...item, name: cleanHistoryText(item.name).slice(0, 160) }
      : { ...item, senderName: cleanHistoryText(item.senderName).slice(0, 60), text: text.slice(0, 800),
        textTruncated: item.textTruncated || text.length > 800,
        attachments: (item.attachments ?? []).map(file => ({ ...file, name: cleanHistoryText(file.name).slice(0, 120) })) };
    result.items.push(view);
    if (result.items.length === 1) {
      while (JSON.stringify(result).length > maxChars - 350 && view.attachments?.length) { view.attachments.pop(); view.attachmentsTruncated = true; }
      while (JSON.stringify(result).length > maxChars - 350 && view.text?.length > 20) { view.text = view.text.slice(0, Math.floor(view.text.length / 2)); view.textTruncated = true; }
    }
    if (JSON.stringify(result).length > maxChars - 350) { result.items.pop(); result.budgetLimited = true; break; }
    last = item;
  }
  if (result.budgetLimited && !last) throw new Error('Not enough history output budget for this record. Narrow the query or answer from the supplied evidence.');
  if (result.budgetLimited && last) result.nextCursor = Buffer.from(JSON.stringify({ groupId, kind, time: last.sentAt, id: last.id })).toString('base64url');
  return result;
}

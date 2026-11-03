/** A short input window owns one already reserved FIFO slot. */
const MAX_INPUTS = 10;
const MAX_CHARS = 16000;
// The image pipeline refuses more than 20 sources per turn; folding stops well
// before that so an over-long burst splits into two answers instead of an error.
const MAX_MEDIA = 10;

export class MessageInputWindow {
  #quietMs; #quietTimer; #maxTimer; #clear; #set; #persist; #pending = Promise.resolve(); #resolve;
  #signal; #onAbort;
  #canceled = false;
  closed = false;
  aborted = false;
  completion = null;

  constructor(message, {
    quietMs = 1200, maxWaitMs = 4000, persist, signal,
    setTimer = setTimeout, clearTimer = clearTimeout,
  } = {}) {
    this.message = message;
    this.message.coalescedInputs = [{ messageId: message.messageId, text: message.archiveText ?? message.content }];
    this.#quietMs = Math.max(0, Math.min(3000, quietMs));
    this.#set = setTimer; this.#clear = clearTimer; this.#persist = persist;
    this.ready = new Promise(resolve => { this.#resolve = resolve; });
    this.#signal = signal;
    this.#onAbort = () => {
      if (!this.#canceled) this.aborted = true;
      this.finish({ cancel: true });
    };
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    this.#quietTimer = this.#set(() => this.finish(), this.#quietMs);
    this.#maxTimer = this.#set(() => this.finish(), Math.max(this.#quietMs, Math.min(8000, maxWaitMs)));
    if (signal?.aborted) this.#onAbort();
  }

  canAppend(message) {
    if (this.closed) return false;
    if (message.senderId !== this.message.senderId) return false;
    if (message.conversationId !== this.message.conversationId) return false;
    if (message.kind !== this.message.kind) return false;
    // Stickers and embed-only messages carry no text to merge and no attachment
    // to hand over, so they keep their own turn.
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    const images = message.images?.length ?? 0;
    const files = message.files?.length ?? 0;
    if (!text && !images && !files) return false;
    if ((this.message.images?.length ?? 0) + images > MAX_MEDIA) return false;
    if ((this.message.files?.length ?? 0) + files > MAX_MEDIA) return false;
    if (this.message.coalescedInputs.length >= MAX_INPUTS) return false;
    if (this.message.coalescedInputs.some(input => input.messageId === message.messageId)) return false;
    // A quote no longer splits the burst: the first message keeps the reply target
    // and the rest ride along, so "回覆 + 補充" is one turn instead of two.
    return this.message.content.length + (text ? text.length + 2 : 0) <= MAX_CHARS;
  }

  append(message) {
    if (!this.canAppend(message)) return false;
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (text) {
      this.message.content = this.message.content ? `${this.message.content}\n\n${text}` : text;
      if (this.message.controlText !== undefined) this.message.controlText = this.message.content;
    }
    // Attachments join the same turn instead of starting a second one: "文字 + 圖"
    // is one request, and answering it twice is the bug this window exists to stop.
    if (message.images?.length) this.message.images = [...(this.message.images ?? []), ...message.images];
    if (message.files?.length) this.message.files = [...(this.message.files ?? []), ...message.files];
    this.message.coalescedInputs.push({ messageId: message.messageId, text: message.archiveText ?? message.content });
    this.message.coalescedEventIds = this.message.coalescedInputs.slice(1).map(input => input.messageId);
    if (message.replyTarget !== undefined) this.message.replyTarget = message.replyTarget;
    if (message.groupHistory) this.message.groupHistory = { ...message.groupHistory, currentMessageId: this.message.messageId };
    const snapshot = { ...this.message, coalescedEventIds: [...this.message.coalescedEventIds] };
    const saved = Promise.resolve().then(() => this.#persist?.(snapshot));
    this.#pending = Promise.all([this.#pending, saved]).then(() => {}, () => {});
    this.#clear(this.#quietTimer);
    this.#quietTimer = this.#set(() => this.finish(), this.#quietMs);
    if (this.message.coalescedInputs.length === MAX_INPUTS) this.finish();
    return true;
  }

  finish({ cancel = false } = {}) {
    if (cancel) this.#canceled = true;
    if (this.closed) return;
    this.closed = true;
    this.#clear(this.#quietTimer); this.#clear(this.#maxTimer);
    // Durable staging is best effort, matching the bridge's normal queue. A
    // persistence error must not leave the FIFO slot waiting indefinitely.
    void this.#pending.then(() => {
      this.#signal?.removeEventListener('abort', this.#onAbort);
      this.#resolve(!this.#canceled);
    });
  }
}

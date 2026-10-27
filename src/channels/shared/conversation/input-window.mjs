/** A short input window owns one already reserved FIFO slot. */
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
    this.#maxTimer = this.#set(() => this.finish(), Math.max(this.#quietMs, Math.min(4000, maxWaitMs)));
    if (signal?.aborted) this.#onAbort();
  }

  canAppend(message) {
    return !this.closed && message.senderId === this.message.senderId
      && message.conversationId === this.message.conversationId && message.kind === this.message.kind
      && message.plainText !== false && !message.images?.length && !message.files?.length
      && typeof message.content === 'string' && Boolean(message.content.trim())
      && (!message.replyTo || Boolean(message.replyTo.messageId))
      && (!this.message.replyTo || Boolean(this.message.replyTo.messageId))
      && (message.replyTo?.messageId ?? '') === (this.message.replyTo?.messageId ?? '')
      && this.message.coalescedInputs.length < 10
      && !this.message.coalescedInputs.some(input => input.messageId === message.messageId)
      && this.message.content.length + message.content.length + 2 <= 16000;
  }

  append(message) {
    if (!this.canAppend(message)) return false;
    this.message.content += `\n\n${message.content}`;
    if (this.message.controlText !== undefined) this.message.controlText = this.message.content;
    this.message.coalescedInputs.push({ messageId: message.messageId, text: message.archiveText ?? message.content });
    this.message.coalescedEventIds = this.message.coalescedInputs.slice(1).map(input => input.messageId);
    if (message.replyTarget !== undefined) this.message.replyTarget = message.replyTarget;
    if (message.groupHistory) this.message.groupHistory = { ...message.groupHistory, currentMessageId: this.message.messageId };
    const snapshot = { ...this.message, coalescedEventIds: [...this.message.coalescedEventIds] };
    const saved = Promise.resolve().then(() => this.#persist?.(snapshot));
    this.#pending = Promise.all([this.#pending, saved]).then(() => {}, () => {});
    this.#clear(this.#quietTimer);
    this.#quietTimer = this.#set(() => this.finish(), this.#quietMs);
    if (this.message.coalescedInputs.length === 10) this.finish();
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

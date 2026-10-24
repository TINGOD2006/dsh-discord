import { abortError } from './music-process.mjs';

/** Control messages only. Audio packets and voice credentials never cross this RPC. */
export class MusicWorkerRpc {
  #port; #handler; #next = 0; #pending = new Map(); #active = new Map(); #closed = false;
  constructor(port, handler) {
    this.#port = port; this.#handler = handler;
    port.on('message', this.#message);
  }
  request(method, params, { signal, ready } = {}) {
    if (this.#closed || signal?.aborted) return Promise.reject(abortError());
    if (this.#pending.size >= 256) return Promise.reject(new Error('音樂指令忙碌，請稍後重試'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener('abort', cancel); this.#pending.delete(id); };
      const cancel = () => { this.#send({ type: 'cancel', id }); cleanup(); reject(abortError()); };
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.#port.postMessage({ type: 'request', id, method, params, waiting: ready !== undefined }); }
      catch (error) { cleanup(); reject(error); return; }
      // Reserve the command lane before the interaction acknowledgement completes.
      if (ready !== undefined) Promise.resolve(ready).then(
        () => { if (this.#pending.has(id)) this.#send({ type: 'ready', id }); },
        () => { if (this.#pending.has(id)) cancel(); },
      );
      if (signal?.aborted) cancel();
    });
  }
  #send(message) { if (!this.#closed) { try { this.#port.postMessage(message); } catch {} } }
  #message = message => {
    if (this.#closed || !message || !Number.isSafeInteger(message.id)) return;
    const { type, id } = message;
    if (type === 'result') {
      const pending = this.#pending.get(id); if (!pending) return;
      pending.cleanup();
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
      else pending.resolve(message.value);
      return;
    }
    if (type === 'cancel') { this.#active.get(id)?.controller.abort(); return; }
    if (type === 'ready') { this.#active.get(id)?.ready(); return; }
    if (type !== 'request' || this.#active.has(id)) return;
    if (this.#active.size >= 256) {
      this.#send({ type: 'result', id, error: { name: 'Error', message: '音樂指令忙碌，請稍後重試' } }); return;
    }
    const controller = new AbortController();
    let resolveReady;
    const ready = message.waiting ? new Promise(resolve => { resolveReady = resolve; }) : Promise.resolve();
    this.#active.set(id, { controller, ready: () => resolveReady?.() });
    // All waiters must settle on cancellation, even when their ready event never arrives.
    controller.signal.addEventListener('abort', () => resolveReady?.(), { once: true });
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.#handler(message.method, message.params, { signal: controller.signal, ready });
    }).then(value => this.#send({ type: 'result', id, value }), error => this.#send({ type: 'result', id,
      error: { name: error?.name === 'AbortError' ? 'AbortError' : 'Error', message: String(error?.message ?? '音樂操作失敗') } }),
    ).finally(() => this.#active.delete(id));
  };
  close(error = abortError()) {
    if (this.#closed) return; this.#closed = true;
    this.#port.off('message', this.#message);
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
  }
}

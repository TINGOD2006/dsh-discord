import { abortError } from './music-process.mjs';

/** Bound asynchronous admission without letting a late result mutate the player. */
export function musicTask(task, signal) {
  if (!signal) return Promise.resolve(task);
  if (signal.aborted) { Promise.resolve(task).catch(() => {}); return Promise.reject(abortError()); }
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(task).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** FIFO mutations per player. Stop/leave form a barrier against older admissions. */
export class MusicCommandLane {
  #lanes = new Map();
  #closed = false;

  run(key, command, work, signal, authorize) {
    if (this.#closed || signal?.aborted) return Promise.reject(abortError());
    let lane = this.#lanes.get(key);
    if (!lane) { lane = { tail: Promise.resolve(), entries: new Set() }; this.#lanes.set(key, lane); }
    const earlier = [...lane.entries];
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    lane.entries.add(controller);
    // Reserve the position before permission lookups, but never let an
    // unauthorized (or superseded) barrier cancel someone else's work.
    const authorization = Promise.resolve().then(() => {
      combined.throwIfAborted(); return authorize?.(combined);
    }).then(() => {
      combined.throwIfAborted();
      if (command === 'stop' || command === 'leave') for (const entry of earlier) entry.abort();
    });
    authorization.catch(() => {});
    const task = lane.tail.then(() => {
      combined.throwIfAborted();
      return musicTask(authorization.then(() => { combined.throwIfAborted(); return work(combined); }), combined);
    });
    lane.tail = task.catch(() => {}).finally(() => {
      lane.entries.delete(controller);
      if (!lane.entries.size && this.#lanes.get(key) === lane) this.#lanes.delete(key);
    });
    return Promise.all([authorization, task]).then(([, value]) => value);
  }

  destroy() {
    this.#closed = true;
    for (const lane of this.#lanes.values()) for (const entry of lane.entries) entry.abort();
    this.#lanes.clear();
  }
}

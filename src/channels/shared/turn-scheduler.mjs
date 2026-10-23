/**
 * Per-conversation turn scheduler: priority/fairness by default; Discord opts
 * into strict FIFO without burst folding. Each conversation runs one turn at a time.
 *
 * The old queue was a promise chain: whoever arrived first ran first, and past
 * a handful of pending messages the rest were rejected with a "queue is full"
 * receipt. Both behaviours are wrong for a busy channel — one fast typist can
 * bury the owner's `/stop`-adjacent follow-up, and a burst from ten people
 * loses the later speakers outright.
 *
 * This scheduler keeps an explicit pending table per conversation:
 *  - ordered by priority (owner > the person the in-flight turn belongs to >
 *    everyone else), then by fairness (least recently served sender first),
 *    then by arrival;
 *  - never rejects: past the soft limit a message from a sender who already
 *    has one waiting is folded into it (same text, one answer);
 *  - only one entry runs at a time, so the conversation still has one voice.
 */

export const TURN_PRIORITY = Object.freeze({
  owner: 3,
  followup: 2,
  ordinary: 1,
});

/**
 * Aging scale: waiting time counts as priority credit. One full window of
 * waiting is worth one priority level, up to `AGING_MAX_MS`, so an ordinary
 * member who has waited two minutes outranks a brand-new owner message and no
 * sender can be starved by a busier, higher-priority one.
 */
const AGING_WINDOW_MS = 60_000;
const AGING_MAX_MS = AGING_WINDOW_MS * 3;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  // A scheduler entry nobody awaits (a folded message) must not surface as an
  // unhandled rejection when the turn it joined fails.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export class TurnScheduler {
  #softLimit;

  #hardLimit;

  #states = new Map();

  #seq = 0;
  #order;

  constructor({ softLimit = 5, hardLimit = 12, order = 'priority' } = {}) {
    this.#softLimit = Math.max(1, softLimit);
    this.#hardLimit = Math.max(this.#softLimit, hardLimit);
    this.#order = order === 'fifo' ? 'fifo' : 'priority';
  }

  /** True while a turn is running or something is waiting behind it. */
  isBusy(key) {
    const state = this.#states.get(key);
    return Boolean(state && (state.running !== null || state.pending.length > 0));
  }

  /** Pending plus running depth, for status/diagnostics. */
  depth(key) {
    const state = this.#states.get(key);
    return state ? state.pending.length + (state.running === null ? 0 : 1) : 0;
  }

  /** Idle promises for every conversation with backlog, for shutdown waits. */
  idlePromises() {
    return [...this.#states.values()].map((state) => state.idle.promise);
  }

  /**
   * Queue one turn. The returned promise settles with the turn's result, or
   * with the result of the earlier message this one was folded into.
   *
   * Entry contract: { senderId, priority, messageId, text, absorb, record,
   * run, cleanup }. `absorb(earlier)` folds this entry's content into the
   * queued entry it merges with; `cleanup()` releases its bookkeeping either
   * way.
   */
  submit(key, entry) {
    const state = this.#state(key);
    const item = {
      ...entry,
      seq: this.#seq++,
      arrivedAt: Date.now(),
      cleanups: typeof entry.cleanup === 'function' ? [entry.cleanup] : [],
      deferred: createDeferred(),
    };
    const target = this.#foldTarget(state, item);
    if (target) {
      try {
        target.absorb(item);
      } catch {
        // A failed fold must not lose the message: fall through to a real slot.
      }
      if (target.absorbed(item)) {
        target.cleanups.push(...item.cleanups);
        try {
          item.onFolded?.(target);
        } catch {
          // Observability must never change routing.
        }
        void this.#drain(key, state);
        return target.deferred.promise;
      }
    }
    state.pending.push(item);
    void this.#drain(key, state);
    return item.deferred.promise;
  }

  #state(key) {
    let state = this.#states.get(key);
    if (!state) {
      state = {
        pending: [],
        running: null,
        served: new Map(),
        idle: createDeferred(),
      };
      this.#states.set(key, state);
    }
    return state;
  }

  #foldTarget(state, item) {
    if (this.#order === 'fifo') return null;
    if (state.pending.length < this.#softLimit) return null;
    if (typeof item.absorb !== 'function' || !item.text) return null;
    // Fold into the newest queued message of the same sender, so their burst
    // reads as one turn instead of disappearing.
    for (let index = state.pending.length - 1; index >= 0; index -= 1) {
      const queued = state.pending[index];
      if (queued.senderId !== item.senderId) continue;
      if (!item.canAbsorb(queued)) continue;
      if (state.pending.length >= this.#hardLimit) return queued;
      return queued;
    }
    return null;
  }

  /**
   * Table order: aging-adjusted priority, then the sender served least
   * recently, then arrival. The fairness term is what stops one person from
   * monopolising the backlog; the aging term stops priority from being absolute.
   */
  #pick(state) {
    if (this.#order === 'fifo') return state.pending[0] ?? null;
    const now = Date.now();
    const score = (item) => item.priority * AGING_WINDOW_MS
      + Math.min(AGING_MAX_MS, now - item.arrivedAt);
    let best = null;
    for (const item of state.pending) {
      if (!best) {
        best = item;
        continue;
      }
      const itemScore = score(item);
      const bestScore = score(best);
      if (itemScore !== bestScore) {
        if (itemScore > bestScore) best = item;
        continue;
      }
      const bestServed = state.served.get(best.senderId) ?? -1;
      const itemServed = state.served.get(item.senderId) ?? -1;
      if (itemServed !== bestServed) {
        if (itemServed < bestServed) best = item;
        continue;
      }
      if (item.seq < best.seq) best = item;
    }
    return best;
  }

  async #drain(key, state) {
    if (state.running !== null) return;
    const item = this.#pick(state);
    if (!item) {
      state.pending.length = 0;
      this.#settleIdle(key, state);
      return;
    }
    state.pending.splice(state.pending.indexOf(item), 1);
    state.running = item;
    try {
      await item.record?.();
      item.deferred.resolve(await item.run());
    } catch (error) {
      item.deferred.reject(error);
    }
    state.running = null;
    state.served.set(item.senderId, item.seq);
    for (const cleanup of item.cleanups) {
      try {
        await cleanup();
      } catch {
        // Cleanup is best effort: a failed receipt removal must not stall the queue.
      }
    }
    await this.#drain(key, state);
  }

  #settleIdle(key, state) {
    if (state.running !== null || state.pending.length > 0) return;
    this.#states.delete(key);
    state.idle.resolve();
  }
}

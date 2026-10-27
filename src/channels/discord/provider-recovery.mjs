/**
 * Discord-only recovery for a model-provider outage.
 *
 * A failed turn leaves its message in the staging list and releases its
 * mark-seen so "the next poll" retries it. Discord's transport is event driven:
 * when nobody is typing, there is no next poll, so the backlog sits there until
 * a human restarts the process — which is what "API 失效后再接入不会重新启动"
 * describes.
 *
 * This scheduler re-runs the staging sweep on a backoff while the failure looks
 * like a provider problem (5xx, expired key, transport error, timeout), and
 * stops the moment the backlog drains. It is wired only into
 * `DiscordHarnessBridge`; every other channel keeps the one-shot startup
 * recovery it had before.
 */

/**
 * Failure codes that mean "the provider had a bad day", not "this message is
 * bad". These are the classified codes from `message-failure.mjs` (its
 * `PROVIDER_FAILURES` maps the raw ones: AUTH -> MODEL_AUTH, SERVER ->
 * MODEL_SERVICE, TIMEOUT -> MODEL_TIMEOUT, ...).
 *
 * A bad message (context limit, rejected content, broken config) is never
 * retried on a timer: it would fail again and eat the attempt budget.
 */
const PROVIDER_FAILURE_CODES = new Set([
  'MODEL_SERVICE',
  'MODEL_AUTH',
  'MODEL_QUOTA',
  'MODEL_TRANSPORT',
  'MODEL_RATE_LIMIT',
  'MODEL_TIMEOUT',
  'MODEL_REPLY_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'MODEL_STREAM',
  'MODEL_EMPTY_REPLY',
]);

/**
 * Delay before each retry sweep, in milliseconds.
 *
 * The first retries are quick because a 503 or an expired key fails in seconds
 * and often clears in seconds; the tail stretches out so an outage of an hour or
 * two (which is what we actually saw) still gets served without hammering the
 * provider. Total patience here is about 100 minutes.
 */
export const RECOVERY_BACKOFF_MS = Object.freeze([
  30_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  1_800_000,
  1_800_000,
]);

/** One replay budget for the whole window: every sweep may spend one attempt. */
export const RECOVERY_REPLAY_ATTEMPTS = RECOVERY_BACKOFF_MS.length + 2;

/**
 * @param {object} options
 * @param {(args: { maxAttempts: number }) => Promise<unknown>} options.retry
 *   Runs one staging sweep (the bridge's `retryStagedMessages`).
 * @param {() => number} options.pendingCount
 *   Staged messages still waiting for an answer; 0 means the backlog drained.
 * @param {AbortSignal} [options.signal]
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {(fn: Function, delayMs: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 */
export function createProviderRecovery({
  retry,
  pendingCount,
  signal,
  logger,
  schedule = (fn, delayMs) => setTimeout(fn, delayMs),
  cancel = (handle) => clearTimeout(handle),
  maxAttempts = RECOVERY_REPLAY_ATTEMPTS,
} = {}) {
  if (typeof retry !== 'function') throw new TypeError('createProviderRecovery requires retry()');
  if (typeof pendingCount !== 'function') throw new TypeError('createProviderRecovery requires pendingCount()');

  let timer = null;
  let armed = false;
  let aborted = signal?.aborted === true;
  let sweep = 0;

  function disarm(reason) {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (armed) {
      logger?.info?.(`[dsh-im:discord] provider recovery finished: ${reason}`);
    }
    armed = false;
    sweep = 0;
  }

  function onAbort() {
    aborted = true;
    disarm('bridge stopped');
  }

  signal?.addEventListener?.('abort', onAbort, { once: true });

  function remainingStaged() {
    try {
      const count = pendingCount();
      return Number.isSafeInteger(count) && count > 0 ? count : 0;
    } catch {
      return 0;
    }
  }

  function scheduleNext() {
    if (!armed || aborted) return;
    const delayMs = RECOVERY_BACKOFF_MS[Math.min(sweep, RECOVERY_BACKOFF_MS.length - 1)];
    timer = schedule(() => {
      timer = null;
      void fire();
    }, delayMs);
    // A pending retry must not hold the process open on shutdown.
    if (typeof timer?.unref === 'function') timer.unref();
  }

  async function fire() {
    if (!armed || aborted) return;
    sweep += 1;
    const before = remainingStaged();
    if (before === 0) {
      disarm('backlog is empty');
      return;
    }
    logger?.info?.(
      `[dsh-im:discord] provider recovery retry ${sweep}/${RECOVERY_BACKOFF_MS.length}:`
      + ` ${before} staged message(s)`,
    );
    try {
      await retry({ maxAttempts });
    } catch (error) {
      logger?.warn?.(
        '[dsh-im:discord] provider recovery retry failed:',
        error?.message ?? error,
      );
    }
    // `disarm()` may have run while the sweep was awaited (abort, or the sweep
    // itself found nothing left to do).
    if (!armed || aborted) return;
    if (remainingStaged() === 0) {
      disarm('backlog drained');
      return;
    }
    if (sweep >= RECOVERY_BACKOFF_MS.length) {
      disarm(`gave up after ${sweep} retries; the asker was told the turn failed`);
      return;
    }
    scheduleNext();
  }

  return {
    /**
     * Called from the bridge's `onTurnFailed` hook. Arms the schedule only for
     * provider-side failures; a bad message is never retried on a timer.
     */
    note(context) {
      const code = String(context?.code ?? '');
      if (!PROVIDER_FAILURE_CODES.has(code)) return false;
      if (aborted) return false;
      if (armed) return true;
      armed = true;
      sweep = 0;
      logger?.warn?.(
        `[dsh-im:discord] model provider looks down (${code});`
        + ' will keep retrying the staged backlog without a restart',
      );
      scheduleNext();
      return true;
    },
    /** Stop retrying once the backlog drains; safe to call twice. */
    stop(reason = 'stopped') {
      disarm(reason);
    },
    get armed() {
      return armed;
    },
    get sweep() {
      return sweep;
    },
  };
}

/** Whether a failure code is one this scheduler reacts to. */
export function isProviderFailureCode(code) {
  return PROVIDER_FAILURE_CODES.has(String(code ?? ''));
}

/**
 * Automatic Session rotation for long-lived chat conversations.
 *
 * A chat conversation keeps one Session for as long as the binding survives, so
 * its durable log grows without bound. Context compaction cannot rescue a
 * Session that has already grown past the model window: the summarization
 * request replays the history it is trying to summarize, so it overflows on the
 * same limit and every retry fails the same way. Bounding the log before that
 * point is the only reliable protection, and the bound has to be expressed in
 * turns and idle time rather than tokens, because the bridge never sees the
 * model's window.
 *
 * Rotation is deliberately conservative: it only ever *replaces* the binding
 * with a fresh Session. The old Session stays on disk and stays reachable
 * through `/session`, so nothing is destroyed.
 */

/** Turns one Session may answer before the binding is replaced. */
export const DEFAULT_SESSION_MAX_TURNS = 300;
/** Hours of silence after which the next message starts a fresh Session. */
export const DEFAULT_SESSION_MAX_IDLE_HOURS = 24;

const HOUR_MS = 3_600_000;

function nonNegativeInteger(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/**
 * One environment bound: unset or blank keeps the default, `0` disables, and
 * anything unparseable keeps the default too.
 */
function envBound(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number.parseInt(String(raw), 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

/**
 * Normalize a rotation policy. Returns null when rotation is disabled, so
 * callers can pass the result straight through and skip the bookkeeping.
 *
 * `maxTurns` and `maxIdleMs` are independent; either one firing rotates.
 */
export function normalizeSessionRotation(value) {
  if (value === false || value == null) return null;
  if (typeof value !== 'object') return null;
  const maxTurns = nonNegativeInteger(value.maxTurns);
  const maxIdleMs = nonNegativeInteger(value.maxIdleMs);
  if (maxTurns === 0 && maxIdleMs === 0) return null;
  return Object.freeze({ maxTurns, maxIdleMs });
}

/**
 * Whether the recorded usage of the currently bound Session has crossed the
 * policy. A record for a different Session id never fires: the binding already
 * moved on, and the counter belongs to the Session it was written for.
 */
export function rotationDue(record, policy, now = Date.now()) {
  if (!policy || !record) return false;
  if (policy.maxTurns > 0 && (record.turns ?? 0) >= policy.maxTurns) return true;
  if (policy.maxIdleMs > 0 && (record.lastAt ?? 0) > 0 && now - record.lastAt >= policy.maxIdleMs) {
    return true;
  }
  return false;
}

/**
 * Whether a failed turn failed because the Session's own history no longer fits
 * the model window.
 *
 * This is the one failure a Session can never recover from on its own: context
 * compaction summarizes by replaying the history it is about to shadow, so a
 * history that is already over the limit makes the summary request overflow the
 * same limit. Every retry fails identically. The only way out is a different
 * Session, which is why the caller replaces the binding instead of retrying.
 */
export function isContextOverflowFailure(error) {
  const providerCode = error?.providerCode ?? error?.details?.providerCode;
  if (typeof providerCode === 'string'
    && providerCode.trim().toUpperCase() === 'CONTEXT_WINDOW_EXCEEDED') {
    return true;
  }
  return error?.code === 'CONTEXT_WINDOW_EXCEEDED';
}

/**
 * Read the policy from the environment. `0` disables either bound, and a
 * non-numeric value falls back to the default rather than silently turning
 * rotation off: a typo must not quietly restore the unbounded Session that this
 * policy exists to prevent.
 */
export function sessionRotationFromEnv(env = process.env) {
  const maxTurns = envBound(env.DSK_DISCORD_SESSION_MAX_TURNS, DEFAULT_SESSION_MAX_TURNS);
  const maxIdleHours = envBound(env.DSK_DISCORD_SESSION_MAX_IDLE_HOURS, DEFAULT_SESSION_MAX_IDLE_HOURS);
  return normalizeSessionRotation({ maxTurns, maxIdleMs: maxIdleHours * HOUR_MS });
}

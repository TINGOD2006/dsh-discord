/**
 * Whether a bound Discord conversation must move to a fresh Session because the
 * active persona changed.
 *
 * `personaEpoch` lives in `<DSH_HOME>/integrations/dsh-discord/config.json` and
 * is bumped by every activation; `personaEpochSeen` lives in the bot's
 * `state.json` and records which persona the bound Session was answering as.
 * The comparison runs on the message path, not in the RPC handler, because
 * `TokenBotController` exposes no state accessor for the handler to reach.
 *
 * Pure on purpose: the bridge owns the side effects, this owns the decision.
 */
export function planPersonaEpoch({ epoch, seenEpoch = 0, sessionId = null } = {}) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new TypeError('epoch must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(seenEpoch) || seenEpoch < 0) {
    throw new TypeError('seenEpoch must be a non-negative safe integer');
  }
  const bound = typeof sessionId === 'string' && sessionId !== '';
  if (epoch === seenEpoch) {
    return { changed: false, clearSession: false, enqueueHandoff: false, seenEpoch };
  }
  // A rollback (hand edit of config.json) still means the persona changed, so the
  // Session bound under the newer persona must not keep answering as it.
  return { changed: true, clearSession: bound, enqueueHandoff: bound, seenEpoch: epoch };
}

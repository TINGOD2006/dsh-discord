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

/**
 * Apply an epoch change to the binding of one conversation.
 *
 * The binding is dropped before the record is advanced on purpose: a crash
 * between the two leaves `seen` stale, so the next message repeats the (now
 * harmless) clear instead of resurrecting the retired persona.
 *
 * `handoff` is Phase 2's summary job. It runs detached, so a slow or failing
 * summary can never delay or fail the user's turn.
 */
export async function applyPersonaEpoch({ epoch, state, key, handoff = null } = {}) {
  const oldSessionId = state.sessionFor(key) ?? null;
  const plan = planPersonaEpoch({ epoch, seenEpoch: state.personaEpochSeen(), sessionId: oldSessionId });
  if (!plan.changed) return { ...plan, oldSessionId };
  if (plan.clearSession) await state.clearSession(key);
  await state.setPersonaEpochSeen(plan.seenEpoch);
  if (plan.enqueueHandoff && typeof handoff === 'function') {
    Promise.resolve()
      .then(() => handoff({ key, oldSessionId }))
      .catch(() => undefined);
  }
  return { ...plan, oldSessionId };
}

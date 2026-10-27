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

/**
 * Wrap a handoff job so it runs **after** the turn that discovered the switch
 * has settled, never beside it.
 *
 * Generating the summary costs a full model turn in the same workspace. Running
 * that turn at the moment the switch is detected would put it in front of the
 * user's own request: the bot sits on "正在處理…" and the reply the user is
 * waiting for arrives late or not at all. The summary is only ever read on a
 * later turn (see `installDiscordHandoff`'s mtime cache), so finishing it after
 * the reply costs nothing.
 *
 * Failures are logged, never thrown: a summary is a nicety, the conversation is
 * the product.
 */
export function deferPersonaHandoff(run, { logger = null } = {}) {
  if (typeof run !== 'function') return () => {};
  return () => {
    Promise.resolve()
      .then(run)
      .then(
        (result) => {
          if (result && result.ok === false) {
            logger?.warn?.('[dsh-im:discord] persona handoff skipped:', result.reason ?? 'unknown');
          }
        },
        (error) => {
          logger?.warn?.('[dsh-im:discord] persona handoff failed:', error?.message ?? error);
        },
      );
  };
}

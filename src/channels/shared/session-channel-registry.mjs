/**
 * Which channel drove a Session, learned from the prompt RPC that carried the
 * channel's own request id.
 *
 * A prompt context is registered once per plugin start, so a context that must
 * only reach one channel's conversations cannot filter itself at registration
 * time. Every channel stamps its prompt ids with its own name
 * (`discord-<uuid>`, `discord-steer-<uuid>`, ...); the Host records the pairing
 * when that prompt arrives — before the agent assembles a single System prompt —
 * and the context looks the Session up again while rendering.
 */

const CHANNEL_RPC_ID = /^([a-z][a-z0-9]*)-(?:steer-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Upper bound on remembered sessions; the least recently prompted is evicted first. */
const MAX_ENTRIES = 4096;

const channels = new Map();

/**
 * Read the channel a prompt or steer request id belongs to.
 *
 * @param rpcId - request id as the channel built it.
 * @returns the channel name, or null when the id carries no channel.
 */
export function channelOfPromptRpcId(rpcId) {
  if (typeof rpcId !== 'string') return null;
  const match = CHANNEL_RPC_ID.exec(rpcId.trim());
  return match ? match[1] : null;
}

/**
 * Remember the channel that just prompted this Session.
 *
 * @returns whether the pairing was stored.
 */
export function rememberSessionChannel(sessionId, channel) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  if (typeof channel !== 'string' || !channel) return false;
  // Reinsert so Map order keeps meaning "least recently prompted".
  channels.delete(sessionId);
  channels.set(sessionId, channel);
  while (channels.size > MAX_ENTRIES) {
    const oldest = channels.keys().next();
    if (oldest.done) break;
    channels.delete(oldest.value);
  }
  return true;
}

/**
 * The channel last seen prompting this Session.
 *
 * @returns the channel name, or null when the Session has never been prompted
 * through a channel (a Web, CLI, or subagent Session).
 */
export function sessionChannelOf(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return channels.get(sessionId) ?? null;
}

/** Drop one Session's pairing; the Agent that carried it is gone. */
export function forgetSessionChannel(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  return channels.delete(sessionId);
}

/** Drop every pairing; tests start from an empty map. */
export function resetSessionChannels() {
  channels.clear();
}

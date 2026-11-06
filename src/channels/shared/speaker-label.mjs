/**
 * Speaker labels for room-shared Sessions.
 *
 * A Matrix room routes every addressed message of the room into one shared
 * conversation (see `conversation/route.mjs`: group keys carry no sender), so
 * when several members question the same bot the persisted turn text alone
 * cannot say whose question each turn carries. The bridge therefore labels the
 * model-facing prompt of a group message with the sender's display name; the
 * parsed control text, commands, and ledger keys never pass through here and
 * stay unlabelled.
 */

import { injectedBlockGroupEnd } from './context-enhancement.mjs';

/**
 * Prefix the message body of one model-facing prompt with `speakerName: `.
 * A string prompt is labelled inline; a structured content array is labelled
 * on its first non-block text part so injected reply, source, and context
 * blocks keep their own provenance. With no body text to carry the label — an
 * image-only or reply-only turn — one label part is placed ahead of the media.
 * @param {string|Array<Object>|undefined} content - the assembled prompt content.
 * @param {?string} speakerName - the sender's display name; empty labels are dropped.
 * @returns {string|Array<Object>|undefined} the labelled content, or the input unchanged when no label applies.
 */
export function prependSpeakerLabel(content, speakerName) {
  const name = typeof speakerName === 'string' ? speakerName.trim() : '';
  if (!name) return content;
  if (typeof content === 'string') return content ? `${name}: ${content}` : content;
  if (!Array.isArray(content)) return content;
  // The label never lands inside the leading block group: a picture quoted by a
  // block travels right after it, and a label inserted there would attach that
  // picture to the sender's own message instead of to the quote. It also never
  // lands on a media part, which carries no text to prefix.
  const index = injectedBlockGroupEnd(content);
  const target = content.findIndex((part, at) => at >= index && part?.type === 'text');
  if (target === -1) return [{ type: 'text', text: `${name}:` }, ...content];
  return content.with(target, { ...content[target], text: `${name}: ${content[target].text ?? ''}` });
}

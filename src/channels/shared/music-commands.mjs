import { t } from './i18n.mjs';

/**
 * Voice-channel music commands, shared by every text bridge.
 *
 * The chat bridges own no voice transport, so this stays a thin dispatcher: the
 * adapter supplies a `music` manager (see `src/channels/discord/music.mjs`) whose
 * methods take the channel id and answer with `{ message }`.
 */

export const MUSIC_COMMAND_NAMES = Object.freeze(['play', 'next', 'pause', 'resume', 'queue', 'leave']);

const MUSIC_COMMAND = /^\/(play|next|pause|resume|queue|leave)(?=$|\s)/iu;

export const MUSIC_COMMAND_USAGE = '/play <链接|关键词>';

export function isMusicCommand(text) {
  return typeof text === 'string' && MUSIC_COMMAND.test(text.trim());
}

export function parseMusicCommand(text) {
  const match = MUSIC_COMMAND.exec(String(text ?? '').trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const argument = String(text).trim().slice(match[0].length).trim();
  return { name, argument };
}

export async function runMusicCommand(
  text,
  harness,
  state,
  key,
  {
    signal,
    music = null,
    conversationId = null,
    enhancement = null,
    senderId = null,
  } = {},
) {
  const parsed = parseMusicCommand(text);
  if (!parsed) return null;
  if (signal?.aborted) return null;
  if (!music) return { message: t('音乐功能没开嘛。') };
  const source = typeof enhancement?.source === 'function' ? enhancement.source() : null;
  const channelId = conversationId ?? source?.chatId ?? null;
  if (!channelId) return { message: t('要在一个服务器频道里用嘛。') };
  const actorId = senderId ?? source?.senderId ?? null;
  try {
    switch (parsed.name) {
      case 'play':
        return await music.play({ channelId, senderId: actorId, query: parsed.argument });
      case 'next':
        return await music.next({ channelId });
      case 'pause':
        return await music.pause({ channelId });
      case 'resume':
        return await music.resume({ channelId });
      case 'queue':
        return await music.queue({ channelId });
      case 'leave':
        return await music.leave({ channelId });
      default:
        return null;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { message: t('放歌失败了：{reason}', { reason }) };
  }
}
